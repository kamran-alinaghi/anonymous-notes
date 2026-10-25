import { randomUUID } from "node:crypto";

import { setCurrentSubject, transitionRoom, validateRoom, validateSubject } from "../domain/rules.js";
import type { Room, Round } from "../domain/types.js";
import type { RoomStore } from "../rooms/room-store.js";

export type GameManagementErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_ROOM_STATE"
  | "INVALID_SUBJECT"
  | "NOT_SUBJECT_SETTER"
  | "GAME_START_FAILED"
  | "SUBJECT_SUBMISSION_FAILED";

export interface GameManagementError {
  code: GameManagementErrorCode;
  message: string;
}

export type GameManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GameManagementError };

export interface GameManagementOptions {
  /** Server-side source for round IDs; clients never provide these. */
  generateRoundId?: () => string;
}

function failure<T = never>(code: GameManagementErrorCode, message: string): GameManagementResult<T> {
  return { ok: false, error: { code, message } };
}

/** Game start and subject selection application logic; independent of WebSocket transport. */
export class GameManagementService {
  private readonly generateRoundId: () => string;

  constructor(private readonly store: RoomStore, options: GameManagementOptions = {}) {
    this.generateRoundId = options.generateRoundId ?? randomUUID;
  }

  startGame(roomCode: string, authenticatedHostId: string): GameManagementResult<Room> {
    const current = this.store.getByCode(roomCode);
    if (!current) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    if (current.host.id !== authenticatedHostId) {
      return failure("UNAUTHORIZED", "Only the authenticated room host may start the game.");
    }
    if (current.phase !== "LOBBY") {
      return failure("ROOM_UNAVAILABLE", "The game can only be started from LOBBY.");
    }
    if (current.players.length < 4) {
      return failure("NOT_ENOUGH_PLAYERS", "At least four actual players are required to start the game.");
    }

    const validRoom = validateRoom(current);
    const orderedIds = current.players.map((player) => player.id);
    if (!validRoom.ok || orderedIds.some((id) => !id) || new Set(orderedIds).size !== orderedIds.length) {
      return failure("INVALID_ROOM_STATE", "The room's player order or membership is invalid.");
    }
    if (current.currentRoundId !== null || current.rounds.length !== 0 || current.currentSubjectSetterPlayerId !== null) {
      return failure("INVALID_ROOM_STATE", "A lobby must not contain initialized game state.");
    }

    let operationError: GameManagementResult<Room> | undefined;
    try {
      const roundId = this.generateRoundId();
      if (!roundId || current.rounds.some((round) => round.id === roundId)) {
        return failure("GAME_START_FAILED", "Could not allocate a unique first-round ID.");
      }
      const firstPlayer = current.players[0];
      if (!firstPlayer) return failure("INVALID_ROOM_STATE", "The player order is empty.");

      const initialRound: Round = {
        id: roundId,
        number: 1,
        subject: null,
        notes: [],
        revealSequence: null,
        readerAssignments: [],
      };
      const proposed: Room = {
        ...current,
        rounds: [initialRound],
        currentRoundId: roundId,
        currentSubjectSetterPlayerId: firstPlayer.id,
        pausedPhase: (current.disconnectedPlayerIds?.length ?? 0) > 0 ? "CHOOSING_SUBJECT" : null,
      };
      const transitioned = transitionRoom(proposed, "CHOOSING_SUBJECT");
      if (!transitioned.ok) {
        return failure("GAME_START_FAILED", transitioned.errors.join(" "));
      }

      const updated = this.store.updateIfPresent(roomCode, (room) => {
        if (room.phase !== "LOBBY" || room.host.id !== authenticatedHostId ||
            room.players.length < 4 || room.currentRoundId !== null ||
            room.rounds.length !== 0 || room.currentSubjectSetterPlayerId !== null) {
          operationError = failure(
            room.phase !== "LOBBY" ? "ROOM_UNAVAILABLE" : "INVALID_ROOM_STATE",
            "The room changed before the game could be started.",
          );
          return undefined;
        }
        const ids = room.players.map((player) => player.id);
        if (ids.length < 4 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
          operationError = failure("INVALID_ROOM_STATE", "The room's player order or membership is invalid.");
          return undefined;
        }
        const first = room.players[0];
        if (!first) {
          operationError = failure("INVALID_ROOM_STATE", "The player order is empty.");
          return undefined;
        }
        const round: Round = { ...initialRound };
        const next: Room = {
          ...room,
          rounds: [round],
          currentRoundId: round.id,
          currentSubjectSetterPlayerId: first.id,
          pausedPhase: (room.disconnectedPlayerIds?.length ?? 0) > 0 ? "CHOOSING_SUBJECT" : null,
        };
        const result = transitionRoom(next, "CHOOSING_SUBJECT");
        if (!result.ok) {
          operationError = failure("GAME_START_FAILED", result.errors.join(" "));
          return undefined;
        }
        return result.value;
      });
      if (!updated) {
        if (operationError) return operationError;
        const latest = this.store.getByCode(roomCode);
        if (!latest) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
        if (latest.host.id !== authenticatedHostId) return failure("UNAUTHORIZED", "Only the authenticated room host may start the game.");
        if (latest.phase !== "LOBBY") return failure("ROOM_UNAVAILABLE", "The game can only be started from LOBBY.");
        return failure("GAME_START_FAILED", "The game could not be started; existing state was preserved.");
      }
      return { ok: true, value: updated };
    } catch {
      return failure("GAME_START_FAILED", "The game could not be started; existing state was preserved.");
    }
  }

  submitSubject(
    roomCode: string,
    authenticatedPlayerId: string,
    subject: string,
  ): GameManagementResult<Room> {
    const current = this.store.getByCode(roomCode);
    if (!current) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    if (current.phase !== "CHOOSING_SUBJECT") {
      return failure("ROOM_UNAVAILABLE", "A subject can only be submitted during CHOOSING_SUBJECT.");
    }
    if ((current.disconnectedPlayerIds?.length ?? 0) > 0) {
      return failure("ROOM_UNAVAILABLE", "The game is paused until every disconnected player reconnects.");
    }
    if (current.currentSubjectSetterPlayerId !== authenticatedPlayerId) {
      return failure("NOT_SUBJECT_SETTER", "Only the current subject setter may submit the subject.");
    }
    if (typeof subject !== "string") return failure("INVALID_SUBJECT", "Subject must be text.");
    const validSubject = validateSubject(subject);
    if (!validSubject.ok) return failure("INVALID_SUBJECT", validSubject.errors.join(" "));

    let operationError: GameManagementResult<Room> | undefined;
    try {
      const updated = this.store.updateIfPresent(roomCode, (room) => {
        if (room.phase !== "CHOOSING_SUBJECT") {
          operationError = failure("ROOM_UNAVAILABLE", "A subject can only be submitted during CHOOSING_SUBJECT.");
          return undefined;
        }
        if ((room.disconnectedPlayerIds?.length ?? 0) > 0) {
          operationError = failure("ROOM_UNAVAILABLE", "The game is paused until every disconnected player reconnects.");
          return undefined;
        }
        if (room.currentSubjectSetterPlayerId !== authenticatedPlayerId) {
          operationError = failure("NOT_SUBJECT_SETTER", "Only the current subject setter may submit the subject.");
          return undefined;
        }
        const setResult = setCurrentSubject(room, authenticatedPlayerId, validSubject.value);
        if (!setResult.ok) {
          operationError = failure("INVALID_SUBJECT", setResult.errors.join(" "));
          return undefined;
        }
        const transitioned = transitionRoom(setResult.value, "WRITING");
        if (!transitioned.ok) {
          operationError = failure("SUBJECT_SUBMISSION_FAILED", transitioned.errors.join(" "));
          return undefined;
        }
        return { ...transitioned.value, pausedPhase: null } as Room;
      });
      if (!updated) {
        if (operationError) return operationError;
        const latest = this.store.getByCode(roomCode);
        if (!latest) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
        if (latest.phase !== "CHOOSING_SUBJECT") return failure("ROOM_UNAVAILABLE", "A subject can only be submitted during CHOOSING_SUBJECT.");
        return failure("SUBJECT_SUBMISSION_FAILED", "The subject could not be submitted; existing state was preserved.");
      }
      return { ok: true, value: updated };
    } catch {
      return failure("SUBJECT_SUBMISSION_FAILED", "The subject could not be submitted; existing state was preserved.");
    }
  }
}
