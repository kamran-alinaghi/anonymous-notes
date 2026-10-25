import { describe, expect, it } from "vitest";

import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";
import { LobbyManagementService } from "./lobby-management.js";
import type { Room } from "../domain/types.js";

function setup(revealMode: "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES" = "SINGLE_DEVICE") {
  const store = new InMemoryRoomStore();
  let id = 0;
  const rooms = new RoomManagementService(store, {
    generateRoomCode: () => "ABCDEF",
    generateId: () => `id-${++id}`,
  });
  const lobby = new LobbyManagementService(store);
  const created = rooms.createRoom({ revealMode, hostNickname: "Host" });
  if (!created.ok) throw new Error("Fixture room creation failed.");
  const first = rooms.joinRoom({ roomCode: "ABCDEF", nickname: "Alpha" });
  const second = rooms.joinRoom({ roomCode: "ABCDEF", nickname: "Beta" });
  if (!first.ok || !second.ok) throw new Error("Fixture player join failed.");
  return { store, rooms, lobby, room: store.getByCode("ABCDEF")!, hostId: created.value.host.id };
}

describe("LobbyManagementService", () => {
  it("reorders every actual player in SINGLE_DEVICE mode without inserting the host", () => {
    const { lobby, store, hostId, room } = setup("SINGLE_DEVICE");
    const ids = room.players.map((player) => player.id).reverse();
    const result = lobby.reorderPlayers(room.code, hostId, ids);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players.map((player) => player.id)).toEqual(ids);
    expect(result.value.players.some((player) => player.id === hostId)).toBe(false);
    expect(store.getByCode(room.code)?.players.map((player) => player.id)).toEqual(ids);
  });

  it("includes and permits reordering the host player in INDIVIDUAL_DEVICES mode", () => {
    const { lobby, hostId, room } = setup("INDIVIDUAL_DEVICES");
    const ids = room.players.map((player) => player.id).reverse();
    expect(ids).toContain(hostId);
    const result = lobby.reorderPlayers(room.code, hostId, ids);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.players.map((player) => player.id)).toEqual(ids);
  });

  const invalidOrders: Array<[string, string[]]> = [
    ["missing", ["id-3"]],
    ["duplicate", ["id-2", "id-2", "id-3"]],
    ["unknown", ["id-2", "id-3", "ghost"]],
  ];

  it.each(invalidOrders)("rejects %s player order atomically", (_label, order) => {
    const { lobby, store, hostId, room } = setup();
    const before = store.getByCode(room.code);
    const result = lobby.reorderPlayers(room.code, hostId, order);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PLAYER_ORDER" } });
    expect(store.getByCode(room.code)).toEqual(before);
  });

  it("rejects unauthorized hosts and wrong-phase changes without modifying order", () => {
    const { lobby, store, room } = setup();
    const before = store.getByCode(room.code)!;
    expect(lobby.reorderPlayers(room.code, "not-the-host", before.players.map((p) => p.id))).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    store.updateIfPresent(room.code, (current) => ({ ...current, phase: "WRITING" }));
    const writing = store.getByCode(room.code)!;
    expect(lobby.reorderPlayers(room.code, writing.host.id, writing.players.map((p) => p.id))).toMatchObject({
      ok: false,
      error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(store.getByCode(room.code)?.players).toEqual(writing.players);
  });

  it("rejects nonexistent rooms", () => {
    const { lobby, hostId } = setup();
    expect(lobby.reorderPlayers("ZZZZZZ", hostId, [])).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_FOUND" },
    });
  });
});
