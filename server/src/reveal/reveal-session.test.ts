import { describe, expect, it } from "vitest";

import type { Note, Room, Round } from "../domain/types.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RevealSessionService } from "./reveal-session.js";

const players = [
  { id: "p1", nickname: "Alex" },
  { id: "p2", nickname: "Blair" },
  { id: "p3", nickname: "Casey" },
  { id: "p4", nickname: "Drew" },
];

function makeRoom(revealMode: Room["revealMode"] = "SINGLE_DEVICE"): Room {
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
  const sequence = notes.map((note) => note.id);
  const readerAssignments = notes.map((note) => ({
    noteId: note.id,
    readerPlayerId: players.find((player) =>
      player.id !== note.authorPlayerId && player.id !== note.targetPlayerId)!.id,
  }));
  const round: Round = {
    id: "round-1",
    number: 1,
    subject: "A mystery",
    notes,
    revealSequence: sequence,
    readerAssignments,
    revealIndex: 0,
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
    currentSubjectSetterPlayerId: null,
  } as Room;
}

function setup(mode: Room["revealMode"] = "SINGLE_DEVICE") {
  const store = new InMemoryRoomStore();
  const room = makeRoom(mode);
  store.createIfAbsent(room);
  return { store, room, service: new RevealSessionService(store) };
}

describe("RevealSessionService", () => {
  it("navigates forward and backward without changing the stored sequence", () => {
    const { store, room, service } = setup();
    const originalSequence = room.rounds[0]!.revealSequence;
    expect(service.navigate(room.code, room.host.id, "PREVIOUS")).toMatchObject({
      ok: false,
      error: { code: "REVEAL_BOUNDARY" },
    });
    expect(service.navigate(room.code, room.host.id, "NEXT")).toMatchObject({
      ok: true,
      value: { position: 1, total: 12 },
    });
    expect(service.navigate(room.code, room.host.id, "PREVIOUS")).toMatchObject({
      ok: true,
      value: { position: 0, total: 12 },
    });
    const after = store.getByCode(room.code)!;
    expect(after.rounds[0]!.revealSequence).toEqual(originalSequence);
    expect(after.rounds[0]!.revealIndex).toBe(0);
  });

  it("rejects unauthorized navigation without changing state", () => {
    const { store, room, service } = setup();
    const before = store.getByCode(room.code);
    expect(service.navigate(room.code, "not-the-host", "NEXT")).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    expect(store.getByCode(room.code)).toEqual(before);
  });

  it("shows target nickname and content only to the SINGLE_DEVICE host", () => {
    const { room, service } = setup("SINGLE_DEVICE");
    const hostView = service.getViewerState(room.code, {
      role: "HOST", hostId: room.host.id, playerId: null,
    });
    expect(hostView.ok).toBe(true);
    if (hostView.ok) {
      expect(hostView.value.displayNote).toEqual({
        content: "private p1 to p2",
        targetNickname: "Blair",
      });
      expect(JSON.stringify(hostView.value)).not.toContain("authorPlayerId");
      expect(JSON.stringify(hostView.value)).not.toContain("p1");
    }
    expect(service.getViewerState(room.code, {
      role: "PLAYER", hostId: null, playerId: "p2",
    })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  it("delivers INDIVIDUAL_DEVICES note content only to the assigned reader", () => {
    const { room, service } = setup("INDIVIDUAL_DEVICES");
    const round = room.rounds[0]!;
    const currentNoteId = round.revealSequence![0]!;
    const note = round.notes.find((item) => item.id === currentNoteId)!;
    const readerId = round.readerAssignments.find((item) => item.noteId === currentNoteId)!.readerPlayerId;
    const reader = service.getViewerState(room.code, {
      role: "PLAYER", hostId: null, playerId: readerId,
    });
    expect(reader.ok).toBe(true);
    if (reader.ok) expect(reader.value.displayNote).toEqual({ content: note.content });

    const otherId = players.find((player) => player.id !== readerId)!.id;
    const other = service.getViewerState(room.code, {
      role: "PLAYER", hostId: null, playerId: otherId,
    });
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.value).not.toHaveProperty("displayNote");

    const host = service.getViewerState(room.code, {
      role: "HOST", hostId: room.host.id, playerId: room.host.id,
    });
    expect(host.ok).toBe(true);
    if (host.ok && readerId !== room.host.id) expect(host.value).not.toHaveProperty("displayNote");
  });

  it("keeps position and sequence stable across repeated reads", () => {
    const { room, store, service } = setup();
    const first = service.getViewerState(room.code, { role: "HOST", hostId: room.host.id, playerId: null });
    const second = service.getViewerState(room.code, { role: "HOST", hostId: room.host.id, playerId: null });
    expect(second).toEqual(first);
    expect(store.getByCode(room.code)!.rounds[0]!.revealSequence).toEqual(room.rounds[0]!.revealSequence);
  });

  it("rejects navigation after the final note without modifying the position", () => {
    const { store, room, service } = setup();
    store.updateIfPresent(room.code, (current) => ({
      ...current,
      rounds: current.rounds.map((round) => ({ ...round, revealIndex: round.revealSequence!.length - 1 })),
    }) as Room);
    const before = store.getByCode(room.code);
    expect(service.navigate(room.code, room.host.id, "NEXT")).toMatchObject({
      ok: false,
      error: { code: "REVEAL_BOUNDARY" },
    });
    expect(store.getByCode(room.code)).toEqual(before);
  });
});
