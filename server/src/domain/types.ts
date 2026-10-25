export const GAME_PHASES = [
  "LOBBY",
  "CHOOSING_SUBJECT",
  "WRITING",
  "REVEALING",
  "ROUND_COMPLETE",
  "FINISHED",
] as const;

export type GamePhase = (typeof GAME_PHASES)[number];

export const REVEAL_MODES = ["SINGLE_DEVICE", "INDIVIDUAL_DEVICES"] as const;
export type RevealMode = (typeof REVEAL_MODES)[number];

export type RoomId = string;
export type PlayerId = string;
export type HostId = string;
export type RoundId = string;
export type NoteId = string;

export interface Player {
  id: PlayerId;
  nickname: string;
}

/** Used with SINGLE_DEVICE rooms, where the host is not an actual player. */
export interface HostIdentity {
  id: HostId;
  nickname: string;
}

export interface ReaderAssignment {
  noteId: NoteId;
  readerPlayerId: PlayerId;
}

export interface Round {
  id: RoundId;
  number: number;
  subject: string | null;
  notes: Note[];
  /** Frozen order used throughout the active reveal phase. */
  revealSequence: NoteId[] | null;
  /** Current zero-based reveal position, persisted across reconnects. */
  revealIndex?: number;
  readerAssignments: ReaderAssignment[];
}

export interface Note {
  /** Internal representation. Never send directly to clients. */
  readonly kind: "INTERNAL_NOTE";
  id: NoteId;
  authorPlayerId: PlayerId;
  targetPlayerId: PlayerId;
  content: string;
}

/** Safe player-facing representation; intentionally excludes authorship and targeting metadata. */
export interface PlayerFacingNote {
  readonly kind: "PLAYER_FACING_NOTE";
  id: NoteId;
  content: string;
}

interface RoomBase {
  id: RoomId;
  code: string;
  phase: GamePhase;
  rounds: Round[];
  currentRoundId: RoundId | null;
  /** Player allowed to set the current round's subject. */
  currentSubjectSetterPlayerId: PlayerId | null;
}

export interface SingleDeviceRoom extends RoomBase {
  revealMode: "SINGLE_DEVICE";
  host: HostIdentity;
  players: Player[];
}

export interface IndividualDevicesRoom extends RoomBase {
  revealMode: "INDIVIDUAL_DEVICES";
  /** The host must also appear in players. */
  host: Player;
  players: Player[];
}

export type Room = SingleDeviceRoom | IndividualDevicesRoom;
