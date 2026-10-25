import { randomUUID } from "node:crypto";

import { transitionRoom } from "../domain/rules.js";
import type { Room, Round } from "../domain/types.js";
import type { RoomStore } from "../rooms/room-store.js";

export type RoundLifecycleErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "ROUND_NOT_READY"
  | "ROUND_NOT_COMPLETE"
  | "INVALID_ROOM_STATE"
  | "ROUND_LIFECYCLE_FAILED";

export interface RoundLifecycleError {
  code: RoundLifecycleErrorCode;
  message: string;
}

export type RoundLifecycleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RoundLifecycleError };

export interface RoundLifecycleOptions {
  generateRoundId?: () => string;
}

function failure<T = never>(code: RoundLifecycleErrorCode, message: string): RoundLifecycleResult<T> {
  return { ok: false, error: { code, message } };
}

function currentRound(room: Room): Round | undefined {
  return room.currentRoundId === null
    ? undefined
    : room.rounds.find((round) => round.id === room.currentRoundId);
}

function closeRevealSession(room: Room, roundId: string): Room {
  return {
    ...room,
    rounds: room.rounds.map((round) => {
      if (round.id !== roundId) return round;
      const { revealIndex: _revealIndex, ...roundWithoutRevealIndex } = round;
      return { ...roundWithoutRevealIndex, revealSequence: null, readerAssignments: [] };
    }),
  } as Room;
}

/** Host-authorized round and game lifecycle transitions; no WebSocket dependencies. */
export class RoundLifecycleService {
  private readonly generateRoundId: () => string;

  constructor(private readonly store: RoomStore, options: RoundLifecycleOptions = {}) {
    this.generateRoundId = options.generateRoundId ?? randomUUID;
  }

  /** Completes only when the final item in the persisted reveal sequence is on display. */
  completeRound(roomCode: string, authenticatedHostId: string): RoundLifecycleResult<Room> {
    let operationError: RoundLifecycleResult<never> | undefined;
    const updated = this.store.updateIfPresent(roomCode, (room) => {
      if (room.host.id !== authenticatedHostId) {
        operationError = failure("UNAUTHORIZED", "Only the authenticated room host may complete the round.");
        return undefined;
      }
      if (room.phase !== "REVEALING") {
        operationError = failure("ROOM_UNAVAILABLE", "A round can only be completed during REVEALING.");
        return undefined;
      }
      const round = currentRound(room);
      if (!round || !round.revealSequence || round.revealSequence.length !== round.notes.length ||
          new Set(round.revealSequence).size !== round.notes.length ||
          round.revealSequence.some((id) => !round.notes.some((note) => note.id === id))) {
        operationError = failure("ROUND_NOT_READY", "The active reveal sequence is unavailable or invalid.");
        return undefined;
      }
      const index = round.revealIndex ?? 0;
      if (!Number.isInteger(index) || index !== round.revealSequence.length - 1) {
        operationError = failure("ROUND_NOT_COMPLETE", "The final note must be revealed before completing the round.");
        return undefined;
      }
      const transitioned = transitionRoom(room, "ROUND_COMPLETE");
      if (!transitioned.ok) {
        operationError = failure("ROUND_LIFECYCLE_FAILED", transitioned.errors.join(" "));
        return undefined;
      }
      return closeRevealSession(transitioned.value, round.id);
    });
    if (!updated) {
      if (operationError) return operationError;
      return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    }
    return { ok: true, value: updated };
  }

  finishGame(roomCode: string, authenticatedHostId: string): RoundLifecycleResult<Room> {
    let operationError: RoundLifecycleResult<never> | undefined;
    const updated = this.store.updateIfPresent(roomCode, (room) => {
      if (room.host.id !== authenticatedHostId) {
        operationError = failure("UNAUTHORIZED", "Only the authenticated room host may finish the game.");
        return undefined;
      }
      if (room.phase !== "ROUND_COMPLETE") {
        operationError = failure("ROOM_UNAVAILABLE", "The game can only be finished from ROUND_COMPLETE.");
        return undefined;
      }
      const transitioned = transitionRoom(room, "FINISHED");
      if (!transitioned.ok) {
        operationError = failure("ROUND_LIFECYCLE_FAILED", transitioned.errors.join(" "));
        return undefined;
      }
      const round = currentRound(transitioned.value);
      return round ? closeRevealSession(transitioned.value, round.id) : transitioned.value;
    });
    if (!updated) {
      if (operationError) return operationError;
      return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    }
    return { ok: true, value: updated };
  }

  startNextRound(roomCode: string, authenticatedHostId: string): RoundLifecycleResult<Room> {
    let operationError: RoundLifecycleResult<never> | undefined;
    const updated = this.store.updateIfPresent(roomCode, (room) => {
      if (room.host.id !== authenticatedHostId) {
        operationError = failure("UNAUTHORIZED", "Only the authenticated room host may start another round.");
        return undefined;
      }
      if (room.phase !== "ROUND_COMPLETE") {
        operationError = failure("ROOM_UNAVAILABLE", "Another round can only start from ROUND_COMPLETE.");
        return undefined;
      }
      const previousRound = currentRound(room);
      if (!previousRound || room.currentSubjectSetterPlayerId === null) {
        operationError = failure("INVALID_ROOM_STATE", "The previous round or subject setter is unavailable.");
        return undefined;
      }
      const setterIndex = room.players.findIndex((player) => player.id === room.currentSubjectSetterPlayerId);
      if (setterIndex < 0 || room.players.length < 4) {
        operationError = failure("INVALID_ROOM_STATE", "The fixed player order or previous subject setter is invalid.");
        return undefined;
      }
      const roundId = this.generateRoundId();
      if (!roundId || room.rounds.some((round) => round.id === roundId)) {
        operationError = failure("ROUND_LIFECYCLE_FAILED", "Could not allocate a unique next-round ID.");
        return undefined;
      }
      const nextRound: Round = {
        id: roundId,
        number: previousRound.number + 1,
        subject: null,
        notes: [],
        revealSequence: null,
        readerAssignments: [],
      };
      const nextSetter = room.players[(setterIndex + 1) % room.players.length];
      if (!nextSetter) {
        operationError = failure("INVALID_ROOM_STATE", "The next subject setter could not be selected.");
        return undefined;
      }
      const closedPreviousRound = closeRevealSession(room, previousRound.id);
      const proposed: Room = {
        ...closedPreviousRound,
        rounds: [...closedPreviousRound.rounds, nextRound],
        currentRoundId: nextRound.id,
        currentSubjectSetterPlayerId: nextSetter.id,
      };
      const transitioned = transitionRoom(proposed, "CHOOSING_SUBJECT");
      if (!transitioned.ok) {
        operationError = failure("ROUND_LIFECYCLE_FAILED", transitioned.errors.join(" "));
        return undefined;
      }
      return transitioned.value;
    });
    if (!updated) {
      if (operationError) return operationError;
      return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    }
    return { ok: true, value: updated };
  }
}
