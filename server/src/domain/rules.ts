import type {
  GamePhase,
  Note,
  NoteId,
  Player,
  PlayerFacingNote,
  PlayerId,
  Room,
  Round,
} from "./types.js";

export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const success = <T>(value: T): DomainResult<T> => ({ ok: true, value });
const failure = <T = never>(...errors: string[]): DomainResult<T> => ({ ok: false, errors });

export const ROOM_CODE_PATTERN = /^[A-Z]{6}$/;
export const MAX_NICKNAME_LENGTH = 40;
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_NOTE_LENGTH = 1000;
export const MIN_ACTUAL_PLAYERS = 4;

export function validateRoomCode(code: string): DomainResult<string> {
  return ROOM_CODE_PATTERN.test(code)
    ? success(code)
    : failure("Room code must contain exactly six uppercase letters A-Z.");
}

export function validateNickname(nickname: string): DomainResult<string> {
  if (nickname.trim().length === 0) return failure("Nickname must not be empty.");
  if (nickname.length > MAX_NICKNAME_LENGTH) {
    return failure(`Nickname must be at most ${MAX_NICKNAME_LENGTH} characters.`);
  }
  return success(nickname);
}

/** Validates room invariants without mutating the supplied room. */
export function validateRoom(room: Room): DomainResult<Room> {
  const errors: string[] = [];
  if (!ROOM_CODE_PATTERN.test(room.code)) errors.push("Room code must contain exactly six uppercase letters A-Z.");
  if (room.players.length < MIN_ACTUAL_PLAYERS) errors.push(`At least ${MIN_ACTUAL_PLAYERS} actual players are required.`);

  const nicknameKeys = new Set<string>();
  const playerIds = new Set<string>();
  for (const player of room.players) {
    if (player.nickname.trim().length === 0) errors.push(`Player ${player.id} has an empty nickname.`);
    if (player.nickname.length > MAX_NICKNAME_LENGTH) errors.push(`Nickname for player ${player.id} exceeds ${MAX_NICKNAME_LENGTH} characters.`);
    const key = player.nickname.trim().toLocaleLowerCase("en");
    if (nicknameKeys.has(key)) errors.push(`Nickname "${player.nickname}" is not unique (case-insensitive).`);
    nicknameKeys.add(key);
    if (playerIds.has(player.id)) errors.push(`Duplicate player id "${player.id}".`);
    playerIds.add(player.id);
  }

  if (room.revealMode === "SINGLE_DEVICE") {
    if (playerIds.has(room.host.id)) errors.push("A SINGLE_DEVICE host must not be an actual player.");
    if (room.host.nickname.trim().length === 0 || room.host.nickname.length > MAX_NICKNAME_LENGTH) {
      errors.push("Host nickname must be nonempty and at most 40 characters.");
    }
    if (nicknameKeys.has(room.host.nickname.trim().toLocaleLowerCase("en"))) {
      errors.push("Host nickname must be unique (case-insensitive).");
    }
  } else {
    const hostPlayer = room.players.find((player) => player.id === room.host.id);
    if (!hostPlayer) errors.push("An INDIVIDUAL_DEVICES host must be an actual player.");
    else if (hostPlayer.nickname !== room.host.nickname) errors.push("Host identity must match the host's player entry.");
  }

  const roundIds = new Set<string>();
  for (const round of room.rounds) {
    if (roundIds.has(round.id)) errors.push(`Duplicate round id "${round.id}".`);
    roundIds.add(round.id);
  }
  if (room.currentRoundId !== null && !roundIds.has(room.currentRoundId)) {
    errors.push("Current round id does not identify a round in the room.");
  }
  if (room.currentSubjectSetterPlayerId !== null && !playerIds.has(room.currentSubjectSetterPlayerId)) {
    errors.push("Current subject setter must be an actual player.");
  }

  return errors.length ? { ok: false, errors } : success(room);
}

export function validateSubject(subject: string): DomainResult<string> {
  if (subject.trim().length === 0) return failure("Subject must not be empty.");
  if (subject.length > MAX_SUBJECT_LENGTH) return failure(`Subject must be at most ${MAX_SUBJECT_LENGTH} characters.`);
  return success(subject);
}

function getCurrentRound(room: Room): Round | undefined {
  return room.currentRoundId === null ? undefined : room.rounds.find((r) => r.id === room.currentRoundId);
}

/** Sets the current subject only when the actor is the room's designated subject setter. */
export function setCurrentSubject(room: Room, actorPlayerId: PlayerId, subject: string): DomainResult<Room> {
  if (room.phase !== "CHOOSING_SUBJECT") return failure("Subject can only be set during CHOOSING_SUBJECT.");
  if (room.currentSubjectSetterPlayerId === null || actorPlayerId !== room.currentSubjectSetterPlayerId) {
    return failure("Only the current subject setter may submit the subject.");
  }
  const valid = validateSubject(subject);
  if (!valid.ok) return valid;
  const round = getCurrentRound(room);
  if (!round) return failure("There is no current round.");
  return success({
    ...room,
    rounds: room.rounds.map((item) => item.id === round.id ? { ...item, subject: valid.value } : item),
  } as Room);
}

const ALLOWED_TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = {
  LOBBY: ["CHOOSING_SUBJECT", "FINISHED"],
  CHOOSING_SUBJECT: ["WRITING"],
  WRITING: ["REVEALING"],
  REVEALING: ["ROUND_COMPLETE"],
  ROUND_COMPLETE: ["CHOOSING_SUBJECT", "FINISHED"],
  FINISHED: [],
};

/** Returns a new room for valid transitions and leaves the input untouched on failure. */
export function transitionRoom(room: Room, nextPhase: GamePhase): DomainResult<Room> {
  if (!ALLOWED_TRANSITIONS[room.phase].includes(nextPhase)) {
    return failure(`Invalid game phase transition: ${room.phase} -> ${nextPhase}.`);
  }
  if (nextPhase === "CHOOSING_SUBJECT" && room.players.length < MIN_ACTUAL_PLAYERS) {
    return failure(`At least ${MIN_ACTUAL_PLAYERS} actual players are required to start a round.`);
  }
  if (nextPhase === "WRITING") {
    const round = getCurrentRound(room);
    if (!round || !round.subject || round.subject.trim().length === 0) {
      return failure("A valid current-round subject is required before writing.");
    }
  }
  if (nextPhase === "REVEALING") {
    const round = getCurrentRound(room);
    if (!round) return failure("There is no current round to reveal.");
    const expectedPerPlayer = room.players.length - 1;
    const expectedTotal = room.players.length * expectedPerPlayer;
    if (round.notes.length !== expectedTotal) return failure("All players must submit a complete note batch before reveal.");
    const knownPlayerIds = new Set(room.players.map((player) => player.id));
    const noteIds = new Set<string>();
    for (const player of room.players) {
      const authored = round.notes.filter((note) => note.authorPlayerId === player.id);
      if (authored.length !== expectedPerPlayer) {
        return failure(`Player "${player.id}" must submit exactly one note for every other player.`);
      }
      const targets = new Set<string>();
      for (const note of authored) {
        if (!knownPlayerIds.has(note.targetPlayerId) || note.targetPlayerId === player.id || targets.has(note.targetPlayerId)) {
          return failure(`Player "${player.id}" has an invalid or duplicate note recipient.`);
        }
        if (noteIds.has(note.id)) return failure(`Duplicate note id "${note.id}".`);
        noteIds.add(note.id);
        targets.add(note.targetPlayerId);
      }
      if (targets.size !== expectedPerPlayer) {
        return failure(`Player "${player.id}" must submit exactly one note for every other player.`);
      }
    }
  }
  return success({ ...room, phase: nextPhase });
}

export interface NoteDraft {
  targetPlayerId: PlayerId;
  content: string;
  id: NoteId;
}

/** Validates the complete batch before constructing any accepted notes. */
export function validateNoteBatch(
  room: Room,
  authorPlayerId: PlayerId,
  drafts: readonly NoteDraft[],
): DomainResult<Note[]> {
  if (room.phase !== "WRITING") return failure("Notes can only be submitted during WRITING.");
  const round = getCurrentRound(room);
  if (!round) return failure("There is no current round.");
  if (!room.players.some((p) => p.id === authorPlayerId)) return failure("Author must be an actual player.");
  if (round.notes.some((note) => note.authorPlayerId === authorPlayerId)) {
    return failure("This player has already submitted a note batch for the current round.");
  }

  const expectedTargets = new Set(room.players.filter((p) => p.id !== authorPlayerId).map((p) => p.id));
  const seenTargets = new Set<string>();
  const seenNoteIds = new Set<string>();
  const errors: string[] = [];

  if (drafts.length !== expectedTargets.size) {
    errors.push(`Exactly ${expectedTargets.size} notes are required, one for each other actual player.`);
  }
  for (const draft of drafts) {
    if (!expectedTargets.has(draft.targetPlayerId)) {
      errors.push(draft.targetPlayerId === authorPlayerId
        ? "A note cannot target its own author."
        : `Unknown or invalid note recipient "${draft.targetPlayerId}".`);
    }
    if (seenTargets.has(draft.targetPlayerId)) errors.push(`Duplicate recipient "${draft.targetPlayerId}".`);
    seenTargets.add(draft.targetPlayerId);
    if (draft.content.trim().length === 0) errors.push("Note content must not be empty.");
    if (draft.content.length > MAX_NOTE_LENGTH) errors.push(`Note content must be at most ${MAX_NOTE_LENGTH} characters.`);
    if (!draft.id.trim()) errors.push("Note id must not be empty.");
    if (seenNoteIds.has(draft.id) || round.notes.some((note) => note.id === draft.id)) {
      errors.push(`Duplicate note id "${draft.id}".`);
    }
    seenNoteIds.add(draft.id);
  }
  for (const targetId of expectedTargets) {
    if (!seenTargets.has(targetId)) errors.push(`Missing note for recipient "${targetId}".`);
  }
  if (errors.length) return { ok: false, errors };

  return success(drafts.map((draft) => ({
    kind: "INTERNAL_NOTE",
    id: draft.id,
    authorPlayerId,
    targetPlayerId: draft.targetPlayerId,
    content: draft.content,
  })));
}

/** Atomically adds a validated batch to the current round. */
export function submitNoteBatch(
  room: Room,
  authorPlayerId: PlayerId,
  drafts: readonly NoteDraft[],
): DomainResult<Room> {
  const validated = validateNoteBatch(room, authorPlayerId, drafts);
  if (!validated.ok) return validated;
  const round = getCurrentRound(room);
  if (!round) return failure("There is no current round.");
  return success({
    ...room,
    rounds: room.rounds.map((item) => item.id === round.id
      ? { ...item, notes: [...item.notes, ...validated.value] }
      : item),
  } as Room);
}

/** Creates a stable note sequence without randomizing authorship/reader order. */
export function createRevealSequence(notes: readonly Note[]): NoteId[] {
  return notes.map((note) => note.id);
}

/** Stores an initial stable sequence once; the application layer groups it by assigned reader. */
export function beginReveal(room: Room): DomainResult<Room> {
  if (room.phase !== "REVEALING") return failure("Reveal sequence can only be initialized during REVEALING.");
  const round = getCurrentRound(room);
  if (!round) return failure("There is no current round.");
  if (round.revealSequence !== null) return success(room);
  const sequence = createRevealSequence(round.notes);
  return success({
    ...room,
    rounds: room.rounds.map((item) => item.id === round.id ? { ...item, revealSequence: sequence } : item),
  } as Room);
}

/** Assigns each note to an eligible reader deterministically, preferring the least-loaded reader in the supplied order. */
export function assignReaders(
  notes: readonly Note[],
  orderedPlayers: readonly Player[],
): DomainResult<Round["readerAssignments"]> {
  const assignments: Round["readerAssignments"] = [];
  const remainingNotes = [...notes];
  let noteCount = 0;
  const counts = new Map<PlayerId, number>(
    orderedPlayers.map((player) => [player.id, 0]),
  );

  const totalRounds = orderedPlayers.length - 1;

  for (let round = 0; round < totalRounds; round++) {
    while (
      remainingNotes.length > noteCount &&
      !orderedPlayers.every(
        (player) => (counts.get(player.id) ?? 0) >= round + 1,
      )
    ) {
      let assigned = false;


      const note = remainingNotes[noteCount];

      if (!note) continue;

      for (const player of orderedPlayers) {
        if (
          player.id === note.authorPlayerId ||
          player.id === note.targetPlayerId
        ) {
          continue;
        }

        const count = counts.get(player.id) ?? 0;

        if (count > round) continue;

        assignments.push({
          noteId: note.id,
          readerPlayerId: player.id,
        });

        counts.set(player.id, count + 1);
        noteCount = noteCount + 1;
        assigned = true;
        break;
      }

      if (!assigned) {
        const note = remainingNotes[noteCount];

        if (!note) break;

        const reader = orderedPlayers.find(
          (player) =>
            (counts.get(player.id) ?? 0) <= round,
        ) ?? orderedPlayers[0];

        if (!reader) {
          return failure("Cannot assign remaining notes: no players available.");
        }

        assignments.push({
          noteId: note.id,
          readerPlayerId: reader.id,
        });

        counts.set(
          reader.id,
          (counts.get(reader.id) ?? 0) + 1,
        );

        remainingNotes.splice(0, 1);
      }
    }
  }

  // Assign any notes remaining after the planned rounds.
  while (remainingNotes.length > 0) {
    const note = remainingNotes.shift();

    if (!note) continue;

    const reader = orderedPlayers.find(
      (player) =>
        player.id !== note.authorPlayerId &&
        player.id !== note.targetPlayerId,
    ) ?? orderedPlayers[0];

    if (!reader) {
      return failure("Cannot assign remaining notes: no players available.");
    }

    assignments.push({
      noteId: note.id,
      readerPlayerId: reader.id,
    });

    counts.set(
      reader.id,
      (counts.get(reader.id) ?? 0) + 1,
    );
  }

  return success(assignments);
}

/** Orders notes by the host-defined player order, rotated so the current subject setter reads first. */
export function orderRevealSequence(
  notes: readonly Note[],
  assignments: readonly Round["readerAssignments"][number][],
  readerOrder: readonly Player[],
): NoteId[] {
  const readerByNoteId = new Map(assignments.map((assignment) => [assignment.noteId, assignment.readerPlayerId]));
  return readerOrder.flatMap((reader) =>
    notes.filter((note) => readerByNoteId.get(note.id) === reader.id).map((note) => note.id));
}

/** Explicit allow-list projection: internal authorship and target identity never leave the domain layer. */
export function projectNoteForPlayer(note: Note): PlayerFacingNote {
  return { kind: "PLAYER_FACING_NOTE", id: note.id, content: note.content };
}
