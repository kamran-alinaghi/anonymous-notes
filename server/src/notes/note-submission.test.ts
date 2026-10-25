import { describe, expect, it } from "vitest";

import { GameManagementService } from "../game/game-management.js";
import { NoteSubmissionService } from "./note-submission.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";

function setup(
  revealMode: "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES" = "SINGLE_DEVICE",
) {
  const store = new InMemoryRoomStore();
  let id = 0;
  const rooms = new RoomManagementService(store, {
    generateRoomCode: () => "ABCDEF",
    generateId: () => "player-" + (++id),
  });
  let roundId = 0;
  let noteId = 0;
  const game = new GameManagementService(store, { generateRoundId: () => "round-" + (++roundId) });
  const notes = new NoteSubmissionService(store, { generateNoteId: () => "note-" + (++noteId) });
  const created = rooms.createRoom({ revealMode, hostNickname: "Host" });
  if (!created.ok) throw new Error("Fixture room creation failed.");
  const joinCount = revealMode === "SINGLE_DEVICE" ? 4 : 3;
  for (let index = 0; index < joinCount; index += 1) {
    const joined = rooms.joinRoom({ roomCode: "ABCDEF", nickname: "Player " + (index + 1) });
    if (!joined.ok) throw new Error("Fixture player join failed.");
  }
  const room = store.getByCode("ABCDEF")!;
  const started = game.startGame(room.code, created.value.host.id);
  if (!started.ok) throw new Error("Fixture game start failed.");
  const setterId = started.value.currentSubjectSetterPlayerId!;
  const subject = game.submitSubject(room.code, setterId, "A mystery");
  if (!subject.ok) throw new Error("Fixture subject submission failed.");
  return { store, rooms, game, notes, room: store.getByCode("ABCDEF")!, hostId: created.value.host.id };
}

function batchFor(room: ReturnType<typeof setup>["room"], authorId: string) {
  return room.players
    .filter((player) => player.id !== authorId)
    .map((player) => ({ targetPlayerId: player.id, content: "A note for " + player.nickname }));
}

describe("NoteSubmissionService", () => {
  it.each(["SINGLE_DEVICE", "INDIVIDUAL_DEVICES"] as const)(
    "accepts complete batches and includes the correct actual players in %s",
    (mode) => {
      const { notes, store, room, hostId } = setup(mode);
      expect(room.players.some((player) => player.id === hostId)).toBe(mode === "INDIVIDUAL_DEVICES");
      const actualIds = room.players.map((player) => player.id);

      for (const authorId of actualIds) {
        const result = notes.submitBatch(room.code, authorId, batchFor(room, authorId));
        expect(result.ok).toBe(true);
      }

      const finalRoom = store.getByCode(room.code)!;
      const round = finalRoom.rounds.find((item) => item.id === finalRoom.currentRoundId)!;
      expect(finalRoom.phase).toBe("REVEALING");
      expect(round.notes).toHaveLength(actualIds.length * (actualIds.length - 1));
      expect(round.notes.every((note) => note.kind === "INTERNAL_NOTE")).toBe(true);
      expect(round.notes.every((note) => actualIds.includes(note.authorPlayerId))).toBe(true);
      expect(round.notes.every((note) => actualIds.includes(note.targetPlayerId) && note.authorPlayerId !== note.targetPlayerId)).toBe(true);
      expect(round.revealSequence).toHaveLength(round.notes.length);
      expect(round.readerAssignments).toHaveLength(round.notes.length);
      expect(new Set(round.readerAssignments.map((item) => item.noteId)).size).toBe(round.notes.length);
    },
  );

  it("rejects incomplete, missing, duplicate, unknown, self-targeted, empty, and overlong notes atomically", () => {
    const { notes, store, room } = setup();
    const author = room.players[0]!;
    const valid = batchFor(room, author.id);
    const cases = [
      valid.slice(1),
      [...valid.slice(0, -1), { targetPlayerId: "unknown", content: "Unknown target" }],
      [valid[0]!, valid[0]!, ...valid.slice(2)],
      [...valid.slice(0, -1), { targetPlayerId: author.id, content: "Self target" }],
      [...valid.slice(0, -1), { targetPlayerId: valid[0]!.targetPlayerId, content: "Duplicate target" }],
      [...valid.slice(0, -1), { targetPlayerId: valid[valid.length - 1]!.targetPlayerId, content: "   " }],
      [...valid.slice(0, -1), { targetPlayerId: valid[valid.length - 1]!.targetPlayerId, content: "x".repeat(1001) }],
    ];
    for (const drafts of cases) {
      const before = store.getByCode(room.code);
      expect(notes.submitBatch(room.code, author.id, drafts)).toMatchObject({
        ok: false,
        error: { code: "INVALID_NOTE_BATCH" },
      });
      expect(store.getByCode(room.code)).toEqual(before);
    }
  });

  it("accepts note text at the 1,000-character limit", () => {
    const { notes, store, room } = setup();
    const author = room.players[0]!;
    const batch = batchFor(room, author.id);
    batch[0] = { ...batch[0]!, content: "x".repeat(1000) };
    const result = notes.submitBatch(room.code, author.id, batch);
    expect(result.ok).toBe(true);
    const stored = store.getByCode(room.code)!;
    const round = stored.rounds.find((item) => item.id === stored.currentRoundId)!;
    expect(round.notes.find((note) => note.authorPlayerId === author.id)?.content).toHaveLength(1000);
  });

  it("rejects non-players and submissions outside WRITING", () => {
    const { notes, store, room, hostId } = setup("SINGLE_DEVICE");
    const before = store.getByCode(room.code);
    expect(notes.submitBatch(room.code, hostId, [])).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    store.updateIfPresent(room.code, (current) => ({ ...current, phase: "CHOOSING_SUBJECT" }));
    const afterPhaseChange = store.getByCode(room.code);
    expect(notes.submitBatch(room.code, room.players[0]!.id, batchFor(room, room.players[0]!.id))).toMatchObject({
      ok: false,
      error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(store.getByCode(room.code)).toEqual(afterPhaseChange);
    expect(before).not.toEqual(afterPhaseChange);
  });

  it("accepts a player's batch once and never permits edits after acceptance", () => {
    const { notes, store, room } = setup();
    const author = room.players[0]!;
    const batch = batchFor(room, author.id);
    const first = notes.submitBatch(room.code, author.id, batch);
    expect(first.ok).toBe(true);
    const afterFirst = store.getByCode(room.code);
    expect(notes.submitBatch(room.code, author.id, batchFor(room, author.id).map((note) => ({
      ...note,
      content: "Edited",
    })))).toMatchObject({
      ok: false,
      error: { code: "ALREADY_SUBMITTED" },
    });
    expect(store.getByCode(room.code)).toEqual(afterFirst);
  });

  it("tracks progress without exposing notes and only transitions after every actual player submits", () => {
    const { notes, store, room, hostId } = setup("SINGLE_DEVICE");
    for (const player of room.players.slice(0, -1)) {
      expect(notes.submitBatch(room.code, player.id, batchFor(room, player.id)).ok).toBe(true);
    }
    const partialRoom = store.getByCode(room.code)!;
    expect(partialRoom.phase).toBe("WRITING");
    const progress = notes.getProgress(room.code);
    expect(progress.ok).toBe(true);
    if (progress.ok) {
      expect(progress.value.submittedCount).toBe(room.players.length - 1);
      expect(progress.value.players.filter((player) => player.submitted)).toHaveLength(room.players.length - 1);
      expect(JSON.stringify(progress.value)).not.toContain("A note for");
      expect(progress.value.players.some((player) => player.playerId === hostId)).toBe(false);
    }
    const last = room.players[room.players.length - 1]!;
    const final = notes.submitBatch(room.code, last.id, batchFor(room, last.id));
    expect(final.ok).toBe(true);
    expect(store.getByCode(room.code)?.phase).toBe("REVEALING");
    expect(notes.submitBatch(room.code, last.id, batchFor(room, last.id))).toMatchObject({
      ok: false,
      error: { code: "ROOM_UNAVAILABLE" },
    });
  });

  it("serializes duplicate submissions from the same player", async () => {
    const { notes, store, room } = setup();
    const author = room.players[0]!;
    const batch = batchFor(room, author.id);
    const results = await Promise.all([
      Promise.resolve(notes.submitBatch(room.code, author.id, batch)),
      Promise.resolve(notes.submitBatch(room.code, author.id, batch)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const stored = store.getByCode(room.code)!;
    const round = stored.rounds.find((item) => item.id === stored.currentRoundId)!;
    expect(round.notes.filter((note) => note.authorPlayerId === author.id)).toHaveLength(room.players.length - 1);
  });

  it("handles concurrent final submissions without losing a batch or initializing reveal twice", async () => {
    const { notes, store, room } = setup("SINGLE_DEVICE");
    const lastTwo = room.players.slice(-2);
    for (const player of room.players.slice(0, -2)) {
      expect(notes.submitBatch(room.code, player.id, batchFor(room, player.id)).ok).toBe(true);
    }
    const results = await Promise.all(lastTwo.map((player) =>
      Promise.resolve(notes.submitBatch(room.code, player.id, batchFor(room, player.id))),
    ));
    expect(results.every((result) => result.ok)).toBe(true);
    const finalRoom = store.getByCode(room.code)!;
    const round = finalRoom.rounds.find((item) => item.id === finalRoom.currentRoundId)!;
    expect(finalRoom.phase).toBe("REVEALING");
    expect(round.notes).toHaveLength(room.players.length * (room.players.length - 1));
    expect(round.revealSequence).toHaveLength(round.notes.length);
    expect(round.readerAssignments).toHaveLength(round.notes.length);
  });
});
