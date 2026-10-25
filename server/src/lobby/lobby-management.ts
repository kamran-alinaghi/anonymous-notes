import type { Room } from "../domain/types.js";
import type { RoomStore } from "../rooms/room-store.js";

export type LobbyErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "INVALID_PLAYER_ORDER"
  | "LOBBY_UPDATE_FAILED";

export interface LobbyError {
  code: LobbyErrorCode;
  message: string;
}

export type LobbyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LobbyError };

function failure<T = never>(code: LobbyErrorCode, message: string): LobbyResult<T> {
  return { ok: false, error: { code, message } };
}

/** Lobby-specific application operations. Does not depend on transport or connection sessions. */
export class LobbyManagementService {
  constructor(private readonly store: RoomStore) {}

  reorderPlayers(
    roomCode: string,
    authenticatedHostId: string,
    requestedPlayerIds: readonly string[],
  ): LobbyResult<Room> {
    const current = this.store.getByCode(roomCode);
    if (!current) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    if (current.phase !== "LOBBY") return failure("ROOM_UNAVAILABLE", "Lobby changes are only allowed while the room is in LOBBY.");
    if (current.host.id !== authenticatedHostId) return failure("UNAUTHORIZED", "Only the authenticated host may reorder players.");
    if (!Array.isArray(requestedPlayerIds) || requestedPlayerIds.some((id) => typeof id !== "string" || id.length === 0)) {
      return failure("INVALID_PLAYER_ORDER", "Player order must contain valid player IDs.");
    }

    const actualIds = current.players.map((player) => player.id);
    if (requestedPlayerIds.length !== actualIds.length) {
      return failure("INVALID_PLAYER_ORDER", "Player order must include every actual player exactly once.");
    }
    const actualSet = new Set(actualIds);
    const requestedSet = new Set(requestedPlayerIds);
    if (requestedSet.size !== requestedPlayerIds.length ||
        requestedSet.size !== actualSet.size ||
        requestedPlayerIds.some((id) => !actualSet.has(id))) {
      return failure("INVALID_PLAYER_ORDER", "Player order contains missing, duplicate, or unknown player IDs.");
    }

    try {
      const updated = this.store.updateIfPresent(roomCode, (room) => {
        if (room.phase !== "LOBBY" || room.host.id !== authenticatedHostId) return undefined;
        const currentIds = room.players.map((player) => player.id);
        const currentSet = new Set(currentIds);
        if (requestedPlayerIds.length !== currentIds.length ||
            new Set(requestedPlayerIds).size !== currentIds.length ||
            requestedPlayerIds.some((id) => !currentSet.has(id))) return undefined;

        const playersById = new Map(room.players.map((player) => [player.id, player]));
        const players = requestedPlayerIds.map((id) => playersById.get(id)!);
        return { ...room, players } as Room;
      });
      if (!updated) {
        const latest = this.store.getByCode(roomCode);
        if (!latest) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
        if (latest.phase !== "LOBBY") return failure("ROOM_UNAVAILABLE", "Lobby changes are only allowed while the room is in LOBBY.");
        if (latest.host.id !== authenticatedHostId) return failure("UNAUTHORIZED", "Only the authenticated host may reorder players.");
        return failure("INVALID_PLAYER_ORDER", "Player order is no longer valid for this room.");
      }
      return { ok: true, value: updated };
    } catch {
      return failure("LOBBY_UPDATE_FAILED", "Lobby order could not be updated. The existing order was preserved.");
    }
  }
}
