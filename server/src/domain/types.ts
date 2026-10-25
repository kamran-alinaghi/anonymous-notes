
export const GAME_PHASES = [
  "LOBBY",
  "CHOOSING_SUBJECT",
  "WRITING",
  "REVEALING",
  "ROUND_COMPLETE",
  "FINISHED",
] as const;

export type GamePhase = (typeof GAME_PHASES)[number];

export const REVEAL_MODES = [
  "SINGLE_DEVICE",
  "INDIVIDUAL_DEVICES",
] as const;

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

/**
 * Represents the host when the host is not an actual player.
 * Used with SINGLE_DEVICE rooms.
 */
export interface HostIdentity {
  id: HostId;
  nickname: string;
}

export interface Round {
  id: RoundId;
  number: number;
  subject: string | null;
  notes: Note[];
}

export interface Note {
  /**
   * Internal representation. Never send directly to clients.
   */
  readonly kind: "INTERNAL_NOTE";
  id: NoteId;
  authorPlayerId: PlayerId;
  content: string;
}

/**
 * Safe, player-facing representation of a note.
 * Deliberately excludes author identity and internal metadata.
 */
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
}

/**
 * The host is separate from the actual players.
 *
 * Invariant: host.id must not identify an actual player in this room.
 * This membership invariant requires runtime validation later.
 */
export interface SingleDeviceRoom extends RoomBase {
  revealMode: "SINGLE_DEVICE";
  host: HostIdentity;
  players: Player[];
}

/**
 * The host is also an actual player.
 *
 * Invariant: host.id must match a player in players.
 * The matching player entry must represent the same host identity.
 */
export interface IndividualDevicesRoom extends RoomBase {
  revealMode: "INDIVIDUAL_DEVICES";
  host: Player;
  players: Player[];
}

export type Room = SingleDeviceRoom | IndividualDevicesRoom;
