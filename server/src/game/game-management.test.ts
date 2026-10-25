import { describe, expect, it } from "vitest";

import { GameManagementService } from "./game-management.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";

function setup(
  revealMode: "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES" = "SINGLE_DEVICE",
  joinCount = revealMode === "SINGLE_DEVICE" ? 4 : 3,
) {
  const store = new InMemoryRoomStore();
  let id = 0;
  const rooms = new RoomManagementService(store, {
    generateRoomCode: () => "ABCDEF",
    generateId: () => `id-${++id}`,
  });
  let roundId = 0;
  const game = new GameManagementService(store, {
    generateRoundId: () => `round-${++roundId}`,
  });
  const created = rooms.createRoom({ revealMode, hostNickname: "Host" });
  if (!created.ok) throw new Error("Fixture room creation failed.");
  for (let index = 0; index < joinCount; index += 1) {
    const joined = rooms.joinRoom({ roomCode: "ABCDEF", nickname: `Player ${index + 1}` });
    if (!joined.ok) throw new Error("Fixture player join failed.");
  }
  return {
    store,
    rooms,
    game,
    room: store.getByCode("ABCDEF")!,
    hostId: created.value.host.id,
  };
}

describe("GameManagementService", () => {
  it.each(["SINGLE_DEVICE", "INDIVIDUAL_DEVICES"] as const)(
    "starts %s with the first actual player in fixed order as subject setter",
    (mode) => {
      const { game, store, room: initialRoom, hostId } = setup(mode);
      store.updateIfPresent(initialRoom.code, (current) => ({ ...current, players: [...current.players].reverse() }));
      const room = store.getByCode(initialRoom.code)!;
      const orderedIds = room.players.map((player) => player.id);
      expect(room.players.some((player) => player.id === hostId)).toBe(mode === "INDIVIDUAL_DEVICES");

      const result = game.startGame(room.code, hostId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.phase).toBe("CHOOSING_SUBJECT");
      expect(result.value.currentSubjectSetterPlayerId).toBe(orderedIds[0]);
      expect(result.value.currentRoundId).toBe("round-1");
      expect(result.value.rounds).toEqual([{
        id: "round-1",
        number: 1,
        subject: null,
        notes: [],
        revealSequence: null,
        readerAssignments: [],
      }]);
      expect(store.getByCode(room.code)).toEqual(result.value);
    },
  );

  it("requires at least four actual players and preserves lobby state on failure", () => {
    const { game, store, room, hostId } = setup("SINGLE_DEVICE", 3);
    const before = store.getByCode(room.code);
    expect(game.startGame(room.code, hostId)).toMatchObject({
      ok: false,
      error: { code: "NOT_ENOUGH_PLAYERS" },
    });
    expect(store.getByCode(room.code)).toEqual(before);
  });

  it("rejects non-host starts and repeated starts without reinitializing the round", () => {
    const { game, store, room, hostId } = setup();
    const before = store.getByCode(room.code);
    expect(game.startGame(room.code, "forged-host")).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    expect(store.getByCode(room.code)).toEqual(before);

    const started = game.startGame(room.code, hostId);
    expect(started.ok).toBe(true);
    const afterStart = store.getByCode(room.code);
    expect(game.startGame(room.code, hostId)).toMatchObject({
      ok: false,
      error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(store.getByCode(room.code)).toEqual(afterStart);
  });

  it("accepts a subject only from the current setter and transitions to WRITING once", () => {
    const { game, store, room, hostId } = setup();
    const started = game.startGame(room.code, hostId);
    if (!started.ok) throw new Error("Fixture game start failed.");
    const setterId = started.value.currentSubjectSetterPlayerId!;
    const otherId = started.value.players.find((player) => player.id !== setterId)!.id;

    expect(game.submitSubject(room.code, otherId, "A good subject")).toMatchObject({
      ok: false,
      error: { code: "NOT_SUBJECT_SETTER" },
    });
    expect(game.submitSubject(room.code, hostId, "Host is not an actual player in SINGLE_DEVICE")).toMatchObject({
      ok: false,
      error: { code: "NOT_SUBJECT_SETTER" },
    });
    expect(store.getByCode(room.code)).toEqual(started.value);

    const submitted = game.submitSubject(room.code, setterId, "A good subject");
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.phase).toBe("WRITING");
    expect(submitted.value.rounds[0]?.subject).toBe("A good subject");
    expect(game.submitSubject(room.code, setterId, "Second subject")).toMatchObject({
      ok: false,
      error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(store.getByCode(room.code)).toEqual(submitted.value);
  });

  it("rejects empty, whitespace-only, and overlong subjects atomically", () => {
    const { game, store, room, hostId } = setup();
    const started = game.startGame(room.code, hostId);
    if (!started.ok) throw new Error("Fixture game start failed.");
    const setterId = started.value.currentSubjectSetterPlayerId!;

    for (const subject of ["", "   ", "x".repeat(301)]) {
      expect(game.submitSubject(room.code, setterId, subject)).toMatchObject({
        ok: false,
        error: { code: "INVALID_SUBJECT" },
      });
      expect(store.getByCode(room.code)).toEqual(started.value);
    }
  });

  it("rejects subject submissions in the wrong phase without modifying the room", () => {
    const { game, store, room, hostId } = setup();
    const started = game.startGame(room.code, hostId);
    if (!started.ok) throw new Error("Fixture game start failed.");
    const writing = store.updateIfPresent(room.code, (current) => ({ ...current, phase: "WRITING" }));
    const before = store.getByCode(room.code);
    expect(writing).toBeDefined();
    expect(game.submitSubject(room.code, started.value.currentSubjectSetterPlayerId!, "Late subject")).toMatchObject({
      ok: false,
      error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(store.getByCode(room.code)).toEqual(before);
  });
});
