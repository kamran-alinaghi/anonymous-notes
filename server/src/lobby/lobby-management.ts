import type { Room } from "../domain/types.js";
import { validateNickname } from "../domain/rules.js";
import type { RoomStore } from "../rooms/room-store.js";

export type LobbyErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "INVALID_PLAYER_ORDER"
  | "INVALID_NICKNAME"
  | "DUPLICATE_NICKNAME"
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

  renameMember(roomCode: string, memberId: string, requestedNickname: string): LobbyResult<Room> {
    if (typeof requestedNickname !== "string") {
      return failure("INVALID_NICKNAME", "Nickname must be text.");
    }
    const nickname = requestedNickname.trim();
    const validation = validateNickname(nickname);
    if (!validation.ok) return failure("INVALID_NICKNAME", validation.errors.join(" "));
    const nicknameKey = nickname.toLocaleLowerCase("en");
    const current = this.store.getByCode(roomCode);
    if (!current) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    if (current.phase !== "LOBBY") return failure("ROOM_UNAVAILABLE", "Nicknames can only be changed while the room is in LOBBY.");
    const isHost = current.host.id === memberId;
    const isPlayer = current.players.some((player) => player.id === memberId);
    if (!isHost && !isPlayer) return failure("UNAUTHORIZED", "The authenticated room member was not found.");
    const duplicate = current.players.some((player) =>
      player.id !== memberId && player.nickname.trim().toLocaleLowerCase("en") === nicknameKey) ||
      (!isHost && current.revealMode === "SINGLE_DEVICE" &&
        current.host.nickname.trim().toLocaleLowerCase("en") === nicknameKey);
    if (duplicate) return failure("DUPLICATE_NICKNAME", "That nickname is already used in this room.");

    try {
      const updated = this.store.updateIfPresent(roomCode, (room) => {
        if (room.phase !== "LOBBY") return undefined;
        const stillMember = room.host.id === memberId || room.players.some((player) => player.id === memberId);
        if (!stillMember) return undefined;
        const duplicateNow = room.players.some((player) =>
          player.id !== memberId && player.nickname.trim().toLocaleLowerCase("en") === nicknameKey) ||
          (room.revealMode === "SINGLE_DEVICE" && room.host.id !== memberId &&
            room.host.nickname.trim().toLocaleLowerCase("en") === nicknameKey);
        if (duplicateNow) return undefined;
        return {
          ...room,
          host: room.host.id === memberId ? { ...room.host, nickname } : room.host,
          players: room.players.map((player) => player.id === memberId ? { ...player, nickname } : player),
        } as Room;
      });
      if (updated) return { ok: true, value: updated };
      const latest = this.store.getByCode(roomCode);
      if (!latest) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
      if (latest.phase !== "LOBBY") return failure("ROOM_UNAVAILABLE", "Nicknames can only be changed while the room is in LOBBY.");
      return failure("DUPLICATE_NICKNAME", "That nickname is already used in this room.");
    } catch {
      return failure("LOBBY_UPDATE_FAILED", "Nickname could not be changed. The existing nickname was preserved.");
    }
  }

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
