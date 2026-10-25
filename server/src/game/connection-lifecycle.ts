import type { GamePhase, PlayerId, Room } from "../domain/types.js";
import type { RoomStore } from "../rooms/room-store.js";

export type ConnectionLifecycleErrorCode =
  | "ROOM_NOT_FOUND"
  | "STALE_SESSION"
  | "PLAYER_NOT_FOUND"
  | "UNAUTHORIZED"
  | "NO_DISCONNECTED_PLAYERS"
  | "ROOM_UNAVAILABLE"
  | "CONNECTION_LIFECYCLE_FAILED";

export interface ConnectionLifecycleError {
  code: ConnectionLifecycleErrorCode;
  message: string;
}

export type ConnectionLifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConnectionLifecycleError };

export interface ConnectionState {
  room: Room;
  disconnectedPlayers: Array<{ id: PlayerId; nickname: string }>;
  paused: boolean;
}

const PAUSABLE_PHASES: readonly GamePhase[] = ["CHOOSING_SUBJECT", "REVEALING", "ROUND_COMPLETE"];

function failure<T = never>(code: ConnectionLifecycleErrorCode, message: string): ConnectionLifecycleResult<T> {
  return { ok: false, error: { code, message } };
}

function disconnectedIds(room: Room): PlayerId[] {
  return room.disconnectedPlayerIds ?? [];
}

function isPaused(room: Room): boolean {
  return room.pausedPhase != null && disconnectedIds(room).length > 0;
}

/** Application-level connection lifecycle; it never owns WebSocket objects or credentials. */
export class ConnectionLifecycleService {
  constructor(private readonly store: RoomStore) {}

  markDisconnected(roomCode: string, roomId: string, playerId: PlayerId): ConnectionLifecycleResult<Room> {
    let operationError: ConnectionLifecycleResult<never> | undefined;
    const updated = this.store.updateIfPresent(roomCode, (room) => {
      if (room.id !== roomId) {
        operationError = failure("STALE_SESSION", "The connection belongs to an outdated room session.");
        return undefined;
      }
      if (!room.players.some((player) => player.id === playerId)) {
        operationError = failure("PLAYER_NOT_FOUND", "The disconnected identity is not a player in this room.");
        return undefined;
      }
      const ids = disconnectedIds(room);
      if (ids.includes(playerId)) return room;
      const nextIds = [...ids, playerId];
      const pausedPhase = PAUSABLE_PHASES.includes(room.phase)
        ? room.pausedPhase ?? room.phase
        : room.phase === "WRITING" ? null : room.pausedPhase ?? null;
      return { ...room, disconnectedPlayerIds: nextIds, pausedPhase };
    });
    if (!updated) {
      if (operationError) return operationError;
      return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    }
    return { ok: true, value: updated };
  }

  markReconnected(roomCode: string, roomId: string, playerId: PlayerId): ConnectionLifecycleResult<Room> {
    let operationError: ConnectionLifecycleResult<never> | undefined;
    const updated = this.store.updateIfPresent(roomCode, (room) => {
      if (room.id !== roomId) {
        operationError = failure("STALE_SESSION", "The connection belongs to an outdated room session.");
        return undefined;
      }
      if (!room.players.some((player) => player.id === playerId)) {
        operationError = failure("PLAYER_NOT_FOUND", "The reconnecting identity is not a player in this room.");
        return undefined;
      }
      const nextIds = disconnectedIds(room).filter((id) => id !== playerId);
      return {
        ...room,
        disconnectedPlayerIds: nextIds,
        pausedPhase: nextIds.length === 0 ? null : room.pausedPhase ?? null,
      };
    });
    if (!updated) {
      if (operationError) return operationError;
      return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    }
    return { ok: true, value: updated };
  }

  getState(roomCode: string): ConnectionLifecycleResult<ConnectionState> {
    const room = this.store.getByCode(roomCode);
    if (!room) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    const ids = new Set(disconnectedIds(room));
    return {
      ok: true,
      value: {
        room,
        disconnectedPlayers: room.players
          .filter((player) => ids.has(player.id))
          .map((player) => ({ id: player.id, nickname: player.nickname })),
        paused: isPaused(room),
      },
    };
  }

  terminateGame(roomCode: string, authenticatedHostId: string): ConnectionLifecycleResult<Room> {
    let operationError: ConnectionLifecycleResult<never> | undefined;
    const updated = this.store.updateIfPresent(roomCode, (room) => {
      if (room.host.id !== authenticatedHostId) {
        operationError = failure("UNAUTHORIZED", "Only the authenticated room host may terminate the game.");
        return undefined;
      }
      if (room.phase === "FINISHED") {
        operationError = failure("ROOM_UNAVAILABLE", "The game has already finished.");
        return undefined;
      }
      if (disconnectedIds(room).length === 0) {
        operationError = failure("NO_DISCONNECTED_PLAYERS", "The game can only be terminated while a player is disconnected.");
        return undefined;
      }
      return { ...room, phase: "FINISHED", pausedPhase: null };
    });
    if (!updated) {
      if (operationError) return operationError;
      return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    }
    return { ok: true, value: updated };
  }
}
