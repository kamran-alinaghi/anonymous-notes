import type { Note, Room } from "../domain/types.js";
import type { RoomStore } from "../rooms/room-store.js";

export type RevealNavigationAction = "NEXT" | "PREVIOUS";
export type RevealViewerRole = "HOST" | "PLAYER";

export interface RevealViewer {
  role: RevealViewerRole;
  hostId: string | null;
  playerId: string | null;
}

export interface RevealDisplayNote {
  content: string;
  /** Present only for the SINGLE_DEVICE host display. */
  targetNickname?: string;
}

export interface RevealViewerState {
  roomCode: string;
  revealMode: Room["revealMode"];
  phase: "REVEALING";
  position: number;
  total: number;
  displayNote?: RevealDisplayNote;
}

export type RevealSessionErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "REVEAL_NOT_READY"
  | "REVEAL_BOUNDARY"
  | "INVALID_ACTION";

export interface RevealSessionError {
  code: RevealSessionErrorCode;
  message: string;
}

export type RevealSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RevealSessionError };

function failure<T = never>(code: RevealSessionErrorCode, message: string): RevealSessionResult<T> {
  return { ok: false, error: { code, message } };
}

function currentRound(room: Room) {
  return room.currentRoundId === null
    ? undefined
    : room.rounds.find((round) => round.id === room.currentRoundId);
}

function validateRevealState(room: Room): { notes: Note[]; sequence: string[]; index: number } | undefined {
  if (room.phase !== "REVEALING") return undefined;
  const round = currentRound(room);
  if (!round || !round.revealSequence) return undefined;
  const noteIds = round.notes.map((note) => note.id);
  const sequence = round.revealSequence;
  if (sequence.length !== noteIds.length ||
      new Set(sequence).size !== sequence.length ||
      sequence.some((id) => !noteIds.includes(id))) return undefined;
  if (room.revealMode === "INDIVIDUAL_DEVICES") {
    if (round.readerAssignments.length !== round.notes.length) return undefined;
    const assignedIds = round.readerAssignments.map((assignment) => assignment.noteId);
    if (new Set(assignedIds).size !== assignedIds.length ||
        assignedIds.some((id) => !noteIds.includes(id)) ||
        round.readerAssignments.some((assignment) => {
          const note = round.notes.find((item) => item.id === assignment.noteId);
          return !note || !room.players.some((player) =>
            player.id === assignment.readerPlayerId &&
            player.id !== note.authorPlayerId &&
            player.id !== note.targetPlayerId);
        })) return undefined;
  }
  const index = round.revealIndex ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= sequence.length) return undefined;
  return { notes: round.notes, sequence, index };
}

/** Application logic for a stable, server-authoritative reveal session. */
export class RevealSessionService {
  constructor(private readonly store: RoomStore) {}

  navigate(
    roomCode: string,
    authenticatedHostId: string,
    action: RevealNavigationAction,
  ): RevealSessionResult<{ position: number; total: number }> {
    if (action !== "NEXT" && action !== "PREVIOUS") {
      return failure("INVALID_ACTION", "Reveal navigation action must be NEXT or PREVIOUS.");
    }
    let operationError: RevealSessionResult<never> | undefined;
    const updated = this.store.updateIfPresent(roomCode, (room) => {
      if (room.phase !== "REVEALING") {
        operationError = failure("ROOM_UNAVAILABLE", "Reveal navigation is only available during REVEALING.");
        return undefined;
      }
      if (room.host.id !== authenticatedHostId) {
        operationError = failure("UNAUTHORIZED", "Only the authenticated room host may navigate the reveal.");
        return undefined;
      }
      const state = validateRevealState(room);
      if (!state) {
        operationError = failure("REVEAL_NOT_READY", "The reveal sequence or reader assignments are not ready.");
        return undefined;
      }
      const nextIndex = state.index + (action === "NEXT" ? 1 : -1);
      if (nextIndex < 0 || nextIndex >= state.sequence.length) {
        operationError = failure("REVEAL_BOUNDARY", "There is no note in that direction.");
        return undefined;
      }
      const round = currentRound(room)!;
      return {
        ...room,
        rounds: room.rounds.map((item) => item.id === round.id
          ? { ...item, revealIndex: nextIndex }
          : item),
      } as Room;
    });
    if (!updated) {
      if (operationError) return operationError;
      return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    }
    const state = validateRevealState(updated);
    if (!state) return failure("REVEAL_NOT_READY", "The reveal state could not be read.");
    return { ok: true, value: { position: state.index, total: state.sequence.length } };
  }

  /** Returns only the reveal information this authenticated viewer is allowed to read. */
  getViewerState(roomCode: string, viewer: RevealViewer): RevealSessionResult<RevealViewerState> {
    const room = this.store.getByCode(roomCode);
    if (!room) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    if (room.phase !== "REVEALING") {
      return failure("ROOM_UNAVAILABLE", "Reveal state is only available during REVEALING.");
    }

    if (viewer.role === "HOST") {
      if (!viewer.hostId || viewer.hostId !== room.host.id) {
        return failure("UNAUTHORIZED", "The authenticated room host is required.");
      }
      if (room.revealMode === "SINGLE_DEVICE" && viewer.playerId !== null) {
        return failure("UNAUTHORIZED", "The SINGLE_DEVICE host is not an actual player.");
      }
      if (room.revealMode === "INDIVIDUAL_DEVICES" && viewer.playerId !== room.host.id) {
        return failure("UNAUTHORIZED", "The INDIVIDUAL_DEVICES host identity must match its player identity.");
      }
    } else {
      if (viewer.hostId !== null || !viewer.playerId || !room.players.some((player) => player.id === viewer.playerId)) {
        return failure("UNAUTHORIZED", "An authenticated room player is required.");
      }
      if (room.revealMode === "SINGLE_DEVICE") {
        return failure("UNAUTHORIZED", "The shared reveal display is available only to the host.");
      }
    }

    const state = validateRevealState(room);
    if (!state) return failure("REVEAL_NOT_READY", "The reveal sequence or reader assignments are not ready.");
    const noteId = state.sequence[state.index];
    const note = state.notes.find((item) => item.id === noteId);
    if (!note) return failure("REVEAL_NOT_READY", "The current reveal note is unavailable.");

    const result: RevealViewerState = {
      roomCode: room.code,
      revealMode: room.revealMode,
      phase: "REVEALING",
      position: state.index,
      total: state.sequence.length,
    };

    if (room.revealMode === "SINGLE_DEVICE" && viewer.role === "HOST") {
      const target = room.players.find((player) => player.id === note.targetPlayerId);
      if (!target) return failure("REVEAL_NOT_READY", "The note recipient is unavailable.");
      result.displayNote = { content: note.content, targetNickname: target.nickname };
    } else if (room.revealMode === "INDIVIDUAL_DEVICES" && viewer.playerId) {
      const assignment = currentRound(room)?.readerAssignments.find((item) => item.noteId === note.id);
      if (assignment?.readerPlayerId === viewer.playerId) {
        result.displayNote = { content: note.content };
      }
    }

    return { ok: true, value: result };
  }
}
