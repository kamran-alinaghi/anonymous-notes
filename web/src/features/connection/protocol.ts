export type RevealMode = "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES";

export type GamePhase =
  | "LOBBY"
  | "CHOOSING_SUBJECT"
  | "WRITING"
  | "REVEALING"
  | "ROUND_COMPLETE"
  | "FINISHED";

export interface CreateRoomPayload {
  type: "CREATE_ROOM";
  revealMode: RevealMode;
  hostNickname: string;
}

export interface JoinRoomPayload {
  type: "JOIN_ROOM";
  roomCode: string;
  nickname: string;
}

export interface GetRevealStatePayload {
  type: "GET_REVEAL_STATE";
}

export interface StartGamePayload {
  type: "START_GAME";
}

export interface ReorderPlayersPayload {
  type: "REORDER_PLAYERS";
  playerIds: string[];
}

export type RequestPayload =
  | CreateRoomPayload
  | JoinRoomPayload
  | GetRevealStatePayload
  | StartGamePayload
  | ReorderPlayersPayload;

export interface RoomPlayer {
  id: string;
  nickname: string;
}

export interface GameRoomView {
  roomCode: string;
  revealMode: RevealMode;
  phase: GamePhase;
  hostNickname: string;
  playerCount: number;
  players: RoomPlayer[];
  currentRoundNumber: number;
  currentSubjectSetterNickname: string | null;
  subject: string | null;
}

export interface PublicRoomView {
  roomCode: string;
  revealMode: RevealMode;
  phase: GamePhase;
  hostNickname: string;
  playerCount: number;
  viewerRole: "HOST" | "PLAYER";
  players?: RoomPlayer[];
}

export interface RevealStateView {
  roomCode: string;
  revealMode: RevealMode;
  phase: "REVEALING";
  position: number;
  total: number;
  displayNote?: { content: string; targetNickname?: string };
}

export interface ServerMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface ConnectedMessage extends ServerMessage {
  type: "CONNECTED";
  connectionId: string;
}

export interface SessionRestoredMessage extends ServerMessage {
  type: "SESSION_RESTORED";
  requestId: string;
  sessionRole: "HOST" | "PLAYER";
  nickname: string;
  sessionToken: string;
  room: GameRoomView;
}

export interface RoomCreatedMessage extends ServerMessage {
  type: "ROOM_CREATED";
  requestId: string;
  room: PublicRoomView;
  sessionRole: "HOST" | "PLAYER";
  nickname: string;
  sessionToken: string;
}

export interface RoomJoinedMessage extends ServerMessage {
  type: "ROOM_JOINED";
  requestId: string;
  room: PublicRoomView;
  sessionRole: "PLAYER";
  nickname: string;
  sessionToken: string;
}

export interface ErrorMessage extends ServerMessage {
  type: "ERROR";
  requestId?: string;
  error: { code: string; message: string };
}

export function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string";
}
