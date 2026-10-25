import { describe, expect, it } from "vitest";

import type { Note, Room, Round } from "../domain/types.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoundLifecycleService } from "./round-lifecycle.js";

const players = [
  { id: "p1", nickname: "Alex" },
  { id: "p2", nickname: "Blair" },
  { id: "p3", nickname: "Casey" },
  { id: "p4", nickname: "Drew" },
];

function makeRoom(revealMode: Room["revealMode"] = "SINGLE_DEVICE", revealIndex = 11): Room {
  const notes: Note[] = [];
  for (const author of players) {
    for (const target of players) {
      if (author.id === target.id) continue;
      notes.push({
        kind: "INTERNAL_NOTE",
        id: `n-${author.id}-${target.id}`,
        authorPlayerId: author.id,
        targetPlayerId: target.id,
        content: `private note ${notes.length + 1}`,
      });
    }
  }
  const round: Round = {
    id: "round-1",
    number: 1,
    subject: "A mystery",
    notes,
    revealSequence: notes.map((note) => note.id),
    revealIndex,
    readerAssignments: notes.map((note) => ({
      noteId: note.id,
      readerPlayerId: players.find((player) =>
        player.id !== note.authorPlayerId && player.id !== note.targetPlayerId)!.id,
    })),
  };
  const host = revealMode === "SINGLE_DEVICE"
    ? { id: "host", nickname: "Moderator" }
    : players[0]!;
  return {
    id: "room-1",
    code: "ABCDEF",
    phase: "REVEALING",
    revealMode,
    host,
    players: players.map((player) => ({ ...player })),
    rounds: [round],
    currentRoundId: round.id,
    currentSubjectSetterPlayerId: players[0]!.id,
  } as Room;
}

function setup(mode: Room["revealMode"] = "SINGLE_DEVICE", revealIndex = 11) {
  const store = new InMemoryRoomStore();
  const room = makeRoom(mode, revealIndex);
  store.createIfAbsent(room);
  let nextRoundId = 2;
  const service = new RoundLifecycleService(store, { generateRoundId: () => `round-${nextRoundId++}` });
  return { store, room, service };
}

describe("RoundLifecycleService", () => {
  it("rejects premature round completion without changing state", () => {
    const { store, room, service } = setup("SINGLE_DEVICE", 10);
    const before = store.getByCode(room.code);
    expect(service.completeRound(room.code, room.host.id)).toMatchObject({
      ok: false, error: { code: "ROUND_NOT_COMPLETE" },
    });
    expect(store.getByCode(room.code)).toEqual(before);
  });

  it("completes only after the final note is revealed and clears active reveal state", () => {
    const { store, room, service } = setup();
    const result = service.completeRound(room.code, room.host.id);
    expect(result).toMatchObject({ ok: true, value: { phase: "ROUND_COMPLETE" } });
    if (!result.ok) return;
    const round = result.value.rounds[0]!;
    expect(round.revealSequence).toBeNull();
    expect(round.revealIndex).toBeUndefined();
    expect(round.readerAssignments).toEqual([]);
    expect(round.notes).toHaveLength(12);
    expect(store.getByCode(room.code)).toEqual(result.value);
  });

  it("rejects unauthorized, duplicate, and wrong-phase lifecycle requests atomically", () => {
    const { store, room, service } = setup();
    const before = store.getByCode(room.code);
    expect(service.completeRound(room.code, "forged-host")).toMatchObject({
      ok: false, error: { code: "UNAUTHORIZED" },
    });
    expect(store.getByCode(room.code)).toEqual(before);

    const completed = service.completeRound(room.code, room.host.id);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const after = store.getByCode(room.code);
    expect(service.completeRound(room.code, room.host.id)).toMatchObject({
      ok: false, error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(service.finishGame(room.code, "forged-host")).toMatchObject({
      ok: false, error: { code: "UNAUTHORIZED" },
    });
    expect(store.getByCode(room.code)).toEqual(after);
  });

  it("finishes the game only from ROUND_COMPLETE and rejects further lifecycle actions", () => {
    const { store, room, service } = setup();
    expect(service.finishGame(room.code, room.host.id)).toMatchObject({
      ok: false, error: { code: "ROOM_UNAVAILABLE" },
    });
    service.completeRound(room.code, room.host.id);
    const result = service.finishGame(room.code, room.host.id);
    expect(result).toMatchObject({ ok: true, value: { phase: "FINISHED" } });
    if (!result.ok) return;
    expect(result.value.rounds[0]).toMatchObject({
      revealSequence: null,
      readerAssignments: [],
      notes: expect.any(Array),
    });
    const before = store.getByCode(room.code);
    expect(service.startNextRound(room.code, room.host.id)).toMatchObject({
      ok: false, error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(service.finishGame(room.code, room.host.id)).toMatchObject({
      ok: false, error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(store.getByCode(room.code)).toEqual(before);
  });

  it.each(["SINGLE_DEVICE", "INDIVIDUAL_DEVICES"] as const)(
    "starts a clean next round with fair fixed-order rotation in %s mode",
    (mode) => {
      const { store, room, service } = setup(mode);
      const before = store.getByCode(room.code)!;
      const completed = service.completeRound(room.code, room.host.id);
      expect(completed.ok).toBe(true);
      const result = service.startNextRound(room.code, room.host.id);
      expect(result).toMatchObject({
        ok: true,
        value: {
          phase: "CHOOSING_SUBJECT",
          currentRoundId: "round-2",
          currentSubjectSetterPlayerId: "p2",
          revealMode: mode,
          players: before.players,
        },
      });
      if (!result.ok) return;
      expect(result.value.rounds).toHaveLength(2);
      expect(result.value.rounds[1]).toEqual({
        id: "round-2",
        number: 2,
        subject: null,
        notes: [],
        revealSequence: null,
        readerAssignments: [],
      });
      expect(result.value.players.some((player) => player.id === room.host.id))
        .toBe(mode === "INDIVIDUAL_DEVICES");
    },
  );

  it("rotates the subject setter through the fixed player order and wraps around", () => {
    const { store, room, service } = setup("SINGLE_DEVICE");
    service.completeRound(room.code, room.host.id);
    const second = service.startNextRound(room.code, room.host.id);
    expect(second.ok && second.value.currentSubjectSetterPlayerId).toBe("p2");

    store.updateIfPresent(room.code, (current) => ({
      ...current,
      phase: "ROUND_COMPLETE",
      currentSubjectSetterPlayerId: "p4",
    }));
    const third = service.startNextRound(room.code, room.host.id);
    expect(third.ok && third.value.currentSubjectSetterPlayerId).toBe("p1");
  });
});
