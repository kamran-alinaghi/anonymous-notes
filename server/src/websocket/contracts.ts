import type { RevealMode } from "../domain/types.js";

export const INCOMING_MESSAGE_TYPES = ["CREATE_ROOM", "JOIN_ROOM"] as const;
export type IncomingMessageType = (typeof INCOMING_MESSAGE_TYPES)[number];

export interface CreateRoomRequest {
  type: "CREATE_ROOM";
  requestId: string;
  revealMode: RevealMode;
  hostNickname: string;
}

export interface JoinRoomRequest {
  type: "JOIN_ROOM";
  requestId: string;
  roomCode: string;
  nickname: string;
}

export type IncomingMessage = CreateRoomRequest | JoinRoomRequest;

export interface PublicRoomView {
  roomCode: string;
  revealMode: RevealMode;
  phase: string;
  hostNickname: string;
  players: Array<{ nickname: string }>;
}

export type OutgoingMessage =
  | { type: "CONNECTED"; connectionId: string }
  | { type: "ROOM_CREATED"; requestId: string; room: PublicRoomView; sessionRole: "HOST" | "PLAYER"; nickname: string }
  | { type: "ROOM_JOINED"; requestId: string; room: PublicRoomView; sessionRole: "PLAYER"; nickname: string }
  | { type: "ERROR"; requestId?: string; error: { code: string; message: string } };

export type MessageParseResult =
  | { ok: true; message: IncomingMessage }
  | { ok: false; requestId?: string; code: "MALFORMED_MESSAGE" | "UNSUPPORTED_MESSAGE_TYPE"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, maxLength = 10_000): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** Runtime validation for the public WebSocket message contract. */
export function parseIncomingMessage(raw: unknown): MessageParseResult {
  let value: unknown = raw;
  if (typeof raw === "string" || raw instanceof Uint8Array) {
    try {
      value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return { ok: false, code: "MALFORMED_MESSAGE", message: "Message must contain valid JSON." };
    }
  }

  if (!isRecord(value)) {
    return { ok: false, code: "MALFORMED_MESSAGE", message: "Message must be a JSON object." };
  }

  const requestId = isString(value.requestId, 128) ? value.requestId : undefined;
  if (!isString(value.type, 64)) {
    return { ok: false, ...(requestId ? { requestId } : {}), code: "MALFORMED_MESSAGE", message: "Message type is required." };
  }
  if (!INCOMING_MESSAGE_TYPES.includes(value.type as IncomingMessageType)) {
    return { ok: false, ...(requestId ? { requestId } : {}), code: "UNSUPPORTED_MESSAGE_TYPE", message: "Unsupported message type." };
  }
  if (!requestId) {
    return { ok: false, code: "MALFORMED_MESSAGE", message: "A valid requestId is required." };
  }

  if (value.type === "CREATE_ROOM") {
    if ((value.revealMode !== "SINGLE_DEVICE" && value.revealMode !== "INDIVIDUAL_DEVICES") ||
        !isString(value.hostNickname, 256)) {
      return { ok: false, requestId, code: "MALFORMED_MESSAGE", message: "CREATE_ROOM requires a valid revealMode and hostNickname." };
    }
    return { ok: true, message: {
      type: "CREATE_ROOM",
      requestId,
      revealMode: value.revealMode,
      hostNickname: value.hostNickname,
    } };
  }

  if (!isString(value.roomCode, 64) || !isString(value.nickname, 256)) {
    return { ok: false, requestId, code: "MALFORMED_MESSAGE", message: "JOIN_ROOM requires roomCode and nickname." };
  }
  return { ok: true, message: {
    type: "JOIN_ROOM",
    requestId,
    roomCode: value.roomCode,
    nickname: value.nickname,
  } };
}
