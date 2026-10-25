import { describe, expect, it, vi } from "vitest";

import { InMemoryRoomStore } from "./room-store.js";
import {
  RoomManagementService,
  type RoomManagementOptions,
} from "./room-management.js";
import type { Room } from "../domain/types.js";

function sequence<T>(values: T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("Sequence exhausted.");
    return value;
  };
}

function makeService(
  store = new InMemoryRoomStore(),
  options: RoomManagementOptions = {},
): { service: RoomManagementService; store: InMemoryRoomStore } {
  return {
    store,
    service: new RoomManagementService(store, {
      generateRoomCode: () => "ABCDEF",
      generateId: sequence(["id-1", "id-2", "id-3", "id-4", "id-5", "id-6"]),
      ...options,
    }),
  };
}

describe("InMemoryRoomStore", () => {
  it("enforces active room-code uniqueness and returns defensive copies", () => {
    const store = new InMemoryRoomStore();
    const { service } = makeService(store);
    const created = service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Host" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(store.createIfAbsent(created.value)).toBe(false);
    const read = store.getByCode("ABCDEF")!;
    read.players.push({ id: "outside", nickname: "Outside" });
    expect(store.getByCode("ABCDEF")?.players).toEqual([]);
  });

  it("does not store an update when the update callback rejects or throws", () => {
    const { service, store } = makeService();
    const created = service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Host" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = store.getByCode("ABCDEF");
    expect(store.updateIfPresent("ABCDEF", () => undefined)).toBeUndefined();
    expect(() => store.updateIfPresent("ABCDEF", () => { throw new Error("failure"); })).toThrow();
    expect(store.getByCode("ABCDEF")).toEqual(before);
  });
});

describe("room creation", () => {
  it("creates SINGLE_DEVICE rooms with a separate host and empty actual-player order", () => {
    const { service, store } = makeService();
    const result = service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "  Moderator  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatchObject({
      code: "ABCDEF",
      revealMode: "SINGLE_DEVICE",
      host: { id: "id-1", nickname: "Moderator" },
      players: [],
      phase: "LOBBY",
      rounds: [],
      currentRoundId: null,
      currentSubjectSetterPlayerId: null,
    });
    expect(result.value.host.id).not.toBe(result.value.id);
    expect(store.getByCode("ABCDEF")).toEqual(result.value);
  });

  it("creates INDIVIDUAL_DEVICES rooms with the host in the actual-player order", () => {
    const { service } = makeService();
    const result = service.createRoom({ revealMode: "INDIVIDUAL_DEVICES", hostNickname: "Host" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.revealMode).toBe("INDIVIDUAL_DEVICES");
    expect(result.value.players).toEqual([result.value.host]);
    expect(result.value.phase).toBe("LOBBY");
  });

  it("retries room-code collisions and commits only the successful room", () => {
    const store = new InMemoryRoomStore();
    const codes = sequence(["ABCDEF", "ABCDEF", "GHIJKL"]);
    let id = 0;
    const service = new RoomManagementService(store, {
      generateRoomCode: codes,
      generateId: () => `id-${++id}`,
      maxCodeAttempts: 3,
    });

    const first = service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "One" });
    const second = service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Two" });
    expect(first.ok && first.value.code).toBe("ABCDEF");
    expect(second.ok && second.value.code).toBe("GHIJKL");
    expect(store.hasCode("ABCDEF")).toBe(true);
    expect(store.hasCode("GHIJKL")).toBe(true);
  });

  it("returns a consistent error after exhausted code collisions without partial creation", () => {
    const store = new InMemoryRoomStore();
    const service = new RoomManagementService(store, {
      generateRoomCode: () => "ABCDEF",
      generateId: () => "unused",
      maxCodeAttempts: 2,
    });
    expect(service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "One" }).ok).toBe(true);

    const second = service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Two" });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "ROOM_CODE_EXHAUSTED" },
    });
    expect(store.getByCode("ABCDEF")?.host.nickname).toBe("One");
    expect([...["ABCDEF", "GHIJKL"]].filter((code) => store.hasCode(code))).toEqual(["ABCDEF"]);
  });

  it("does not persist a room when identity generation fails", () => {
    const store = new InMemoryRoomStore();
    const generateId = vi.fn()
      .mockReturnValueOnce("host-id")
      .mockImplementationOnce(() => { throw new Error("id generation failed"); });
    const service = new RoomManagementService(store, {
      generateRoomCode: () => "ABCDEF",
      generateId,
    });

    expect(service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Host" })).toMatchObject({
      ok: false,
      error: { code: "ROOM_CREATION_FAILED" },
    });
    expect(store.hasCode("ABCDEF")).toBe(false);
  });

  it("rejects invalid reveal modes and nicknames", () => {
    const { service, store } = makeService();
    expect(service.createRoom({ revealMode: "NOPE" as "SINGLE_DEVICE", hostNickname: "Host" }).ok).toBe(false);
    expect(service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "   " }).ok).toBe(false);
    expect(store.hasCode("ABCDEF")).toBe(false);
  });
});

describe("room joining", () => {
  it("trims nicknames and rejects case-insensitive duplicates without mutation", () => {
    const { service, store } = makeService();
    const created = service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Moderator" });
    expect(created.ok).toBe(true);
    const joined = service.joinRoom({ roomCode: "ABCDEF", nickname: "  Sam  " });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.value.player.nickname).toBe("Sam");
    const before = store.getByCode("ABCDEF");

    expect(service.joinRoom({ roomCode: "ABCDEF", nickname: "sAM" })).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_NICKNAME" },
    });
    expect(store.getByCode("ABCDEF")).toEqual(before);
  });

  it("prevents a join using the SINGLE_DEVICE host nickname", () => {
    const { service, store } = makeService();
    service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Moderator" });
    expect(service.joinRoom({ roomCode: "ABCDEF", nickname: " moderator " })).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_NICKNAME" },
    });
    expect(store.getByCode("ABCDEF")?.players).toEqual([]);
  });

  it("returns consistent errors for malformed codes, missing rooms, and unavailable rooms", () => {
    const { service, store } = makeService();
    expect(service.joinRoom({ roomCode: "abc123", nickname: "Sam" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ROOM_CODE" },
    });
    expect(service.joinRoom({ roomCode: "ZZZZZZ", nickname: "Sam" })).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });

    service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Moderator" });
    store.updateIfPresent("ABCDEF", (room) => ({ ...room, phase: "CHOOSING_SUBJECT" }));
    expect(service.joinRoom({ roomCode: "ABCDEF", nickname: "Sam" })).toMatchObject({
      ok: false,
      error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(store.getByCode("ABCDEF")?.players).toEqual([]);
  });

  it("appends players in join order and ignores client-supplied identity fields", () => {
    const { service, store } = makeService();
    const created = service.createRoom({ revealMode: "INDIVIDUAL_DEVICES", hostNickname: "Host" });
    expect(created.ok).toBe(true);
    const maliciousInput = { roomCode: "ABCDEF", nickname: "Sam", playerId: "chosen-id", isHost: true };
    const joined = service.joinRoom(maliciousInput);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.value.player.id).not.toBe("chosen-id");
    expect(joined.value.room.players.map((player) => player.nickname)).toEqual(["Host", "Sam"]);
    expect(store.getByCode("ABCDEF")?.players).toEqual(joined.value.room.players);
  });

  it("repeated joins with the same nickname do not create duplicate players", () => {
    const { service, store } = makeService();
    service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Moderator" });
    expect(service.joinRoom({ roomCode: "ABCDEF", nickname: "Taylor" }).ok).toBe(true);
    expect(service.joinRoom({ roomCode: "ABCDEF", nickname: "TAYLOR" }).ok).toBe(false);
    expect(store.getByCode("ABCDEF")?.players).toHaveLength(1);
  });

  it("does not mutate state if player ID generation fails", () => {
    const store = new InMemoryRoomStore();
    let idCalls = 0;
    const service = new RoomManagementService(store, {
      generateRoomCode: () => "ABCDEF",
      generateId: () => {
        idCalls += 1;
        if (idCalls === 2) throw new Error("fail on join id");
        return `id-${idCalls}`;
      },
    });
    service.createRoom({ revealMode: "SINGLE_DEVICE", hostNickname: "Moderator" });
    const before = store.getByCode("ABCDEF");
    expect(service.joinRoom({ roomCode: "ABCDEF", nickname: "Taylor" }).ok).toBe(false);
    expect(store.getByCode("ABCDEF")).toEqual(before);
  });
});
