import { randomUUID } from "node:crypto";

import {
  assignReaders,
  beginReveal,
  submitNoteBatch,
  transitionRoom,
  validateNoteBatch,
  type NoteDraft,
} from "../domain/rules.js";
import type { Room } from "../domain/types.js";
import type { RoomStore } from "../rooms/room-store.js";

export interface NoteSubmissionDraft {
  targetPlayerId: string;
  content: string;
}

export type NoteSubmissionErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_UNAVAILABLE"
  | "UNAUTHORIZED"
  | "INVALID_NOTE_BATCH"
  | "ALREADY_SUBMITTED"
  | "NOTE_SUBMISSION_FAILED";

export interface NoteSubmissionError {
  code: NoteSubmissionErrorCode;
  message: string;
}

export type NoteSubmissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NoteSubmissionError };

export interface PlayerSubmissionStatus {
  playerId: string;
  nickname: string;
  submitted: boolean;
}

export interface NoteSubmissionProgress {
  roomCode: string;
  phase: Room["phase"];
  roundNumber: number;
  submittedCount: number;
  totalPlayerCount: number;
  players: PlayerSubmissionStatus[];
}

export interface NoteSubmissionOptions {
  generateNoteId?: () => string;
}

function failure<T = never>(code: NoteSubmissionErrorCode, message: string): NoteSubmissionResult<T> {
  return { ok: false, error: { code, message } };
}

function currentRound(room: Room) {
  return room.currentRoundId === null
    ? undefined
    : room.rounds.find((round) => round.id === room.currentRoundId);
}

function progressFor(room: Room): NoteSubmissionProgress | undefined {
  const round = currentRound(room);
  if (!round) return undefined;
  const submittedIds = new Set<string>();
  const disconnectedIds = new Set(room.disconnectedPlayerIds ?? []);
  const actualIds = new Set(room.players.map((player) => player.id));
  for (const player of room.players) {
    const authored = round.notes.filter((note) => note.authorPlayerId === player.id);
    const targets = new Set(authored.map((note) => note.targetPlayerId));
    if (!disconnectedIds.has(player.id) &&
        authored.length === room.players.length - 1 &&
        targets.size === room.players.length - 1 &&
        authored.every((note) => actualIds.has(note.targetPlayerId) && note.targetPlayerId !== player.id)) {
      submittedIds.add(player.id);
    }
  }
  const players = room.players.map((player) => ({
    playerId: player.id,
    nickname: player.nickname,
    submitted: submittedIds.has(player.id),
  }));
  return {
    roomCode: room.code,
    phase: room.phase,
    roundNumber: round.number,
    submittedCount: players.filter((player) => player.submitted).length,
    totalPlayerCount: players.length,
    players,
  };
}

/** Atomically accepts one complete note batch per actual player and initializes reveal state when complete. */
export class NoteSubmissionService {
  private readonly generateNoteId: () => string;

  constructor(private readonly store: RoomStore, options: NoteSubmissionOptions = {}) {
    this.generateNoteId = options.generateNoteId ?? randomUUID;
  }

  submitBatch(
    roomCode: string,
    authenticatedPlayerId: string,
    drafts: readonly NoteSubmissionDraft[],
  ): NoteSubmissionResult<{ room: Room; progress: NoteSubmissionProgress; submittedNotes: number }> {
    const current = this.store.getByCode(roomCode);
    if (!current) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    if (current.phase !== "WRITING") return failure("ROOM_UNAVAILABLE", "Note batches can only be submitted during WRITING.");
    if (!current.players.some((player) => player.id === authenticatedPlayerId)) {
      return failure("UNAUTHORIZED", "Only an authenticated actual player may submit notes.");
    }
    const round = currentRound(current);
    if (!round) return failure("NOTE_SUBMISSION_FAILED", "There is no current round.");
    if (round.notes.some((note) => note.authorPlayerId === authenticatedPlayerId)) {
      return failure("ALREADY_SUBMITTED", "This player has already submitted a batch for this round.");
    }
    if (!Array.isArray(drafts) || drafts.some((draft) =>
      typeof draft?.targetPlayerId !== "string" || draft.targetPlayerId.length === 0 ||
      typeof draft.content !== "string")) {
      return failure("INVALID_NOTE_BATCH", "A note batch must contain recipient IDs and text content.");
    }

    let operationError: NoteSubmissionResult<never> | undefined;
    let submittedNotes = 0;
    try {
      const updated = this.store.updateIfPresent(roomCode, (room) => {
        if (room.phase !== "WRITING") {
          operationError = failure("ROOM_UNAVAILABLE", "Note batches can only be submitted during WRITING.");
          return undefined;
        }
        if (!room.players.some((player) => player.id === authenticatedPlayerId)) {
          operationError = failure("UNAUTHORIZED", "Only an authenticated actual player may submit notes.");
          return undefined;
        }
        const activeRound = currentRound(room);
        if (!activeRound) {
          operationError = failure("NOTE_SUBMISSION_FAILED", "There is no current round.");
          return undefined;
        }
        if (activeRound.notes.some((note) => note.authorPlayerId === authenticatedPlayerId)) {
          operationError = failure("ALREADY_SUBMITTED", "This player has already submitted a batch for this round.");
          return undefined;
        }

        const noteDrafts: NoteDraft[] = drafts.map((draft) => ({
          id: this.generateNoteId(),
          targetPlayerId: draft.targetPlayerId,
          content: draft.content,
        }));
        const validated = validateNoteBatch(room, authenticatedPlayerId, noteDrafts);
        if (!validated.ok) {
          operationError = failure("INVALID_NOTE_BATCH", validated.errors.join(" "));
          return undefined;
        }

        const accepted = submitNoteBatch(room, authenticatedPlayerId, noteDrafts);
        if (!accepted.ok) {
          operationError = failure("INVALID_NOTE_BATCH", accepted.errors.join(" "));
          return undefined;
        }
        submittedNotes = validated.value.length;
        const allSubmitted = accepted.value.players.every((player) =>
          (currentRound(accepted.value)?.notes.filter((note) => note.authorPlayerId === player.id).length ?? 0)
            === accepted.value.players.length - 1);
        if (!allSubmitted) return accepted.value;

        const transitioned = transitionRoom(accepted.value, "REVEALING");
        if (!transitioned.ok) {
          operationError = failure("NOTE_SUBMISSION_FAILED", transitioned.errors.join(" "));
          return undefined;
        }
        const revealStarted = beginReveal(transitioned.value);
        if (!revealStarted.ok) {
          operationError = failure("NOTE_SUBMISSION_FAILED", revealStarted.errors.join(" "));
          return undefined;
        }
        const revealRound = currentRound(revealStarted.value);
        if (!revealRound) {
          operationError = failure("NOTE_SUBMISSION_FAILED", "The reveal round could not be initialized.");
          return undefined;
        }
        const assignments = assignReaders(revealRound.notes, revealStarted.value.players);
        if (!assignments.ok) {
          operationError = failure("NOTE_SUBMISSION_FAILED", assignments.errors.join(" "));
          return undefined;
        }
        return {
          ...revealStarted.value,
          pausedPhase: (revealStarted.value.disconnectedPlayerIds?.length ?? 0) > 0 ? "REVEALING" : null,
          rounds: revealStarted.value.rounds.map((item) => item.id === revealRound.id
            ? { ...item, readerAssignments: assignments.value, revealIndex: 0 }
            : item),
        } as Room;
      });

      if (!updated) {
        if (operationError) return operationError;
        const latest = this.store.getByCode(roomCode);
        if (!latest) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
        if (latest.phase !== "WRITING") return failure("ROOM_UNAVAILABLE", "Note batches can only be submitted during WRITING.");
        const latestRound = currentRound(latest);
        if (latestRound?.notes.some((note) => note.authorPlayerId === authenticatedPlayerId)) {
          return failure("ALREADY_SUBMITTED", "This player has already submitted a batch for this round.");
        }
        return failure("NOTE_SUBMISSION_FAILED", "The note batch was rejected; existing state was preserved.");
      }

      const progress = progressFor(updated);
      if (!progress) return failure("NOTE_SUBMISSION_FAILED", "Submission status could not be calculated.");
      return { ok: true, value: { room: updated, progress, submittedNotes } };
    } catch {
      return failure("NOTE_SUBMISSION_FAILED", "The note batch was rejected; existing state was preserved.");
    }
  }

  getProgress(roomCode: string): NoteSubmissionResult<NoteSubmissionProgress> {
    const room = this.store.getByCode(roomCode);
    if (!room) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    const progress = progressFor(room);
    if (!progress) return failure("NOTE_SUBMISSION_FAILED", "There is no current round.");
    return { ok: true, value: progress };
  }
}

