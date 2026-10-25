import { randomInt, randomUUID } from "node:crypto";

import {
  validateNickname,
  validateRoomCode,
} from "../domain/rules.js";
import type {
  HostIdentity,
  Player,
  RevealMode,
  Room,
} from "../domain/types.js";
import type { RoomStore } from "./room-store.js";

export type RoomManagementErrorCode =
  | "INVALID_REVEAL_MODE"
  | "INVALID_ROOM_CODE"
  | "INVALID_NICKNAME"
  | "DUPLICATE_NICKNAME"
  | "ROOM_NOT_FOUND"
  | "ROOM_UNAVAILABLE"
  | "ROOM_CODE_EXHAUSTED"
  | "ROOM_CREATION_FAILED";

export interface ApplicationError {
  code: RoomManagementErrorCode;
  message: string;
}

export type ApplicationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApplicationError };

export interface CreateRoomInput {
  revealMode: RevealMode;
  hostNickname: string;
}

export interface JoinRoomInput {
  roomCode: string;
  nickname: string;
}

export interface JoinedRoom {
  room: Room;
  player: Player;
}

export interface RoomManagementOptions {
  /** Injectable for deterministic collision and failure tests. */
  generateRoomCode?: () => string;
  /** Server-side ID source; IDs are never accepted from callers. */
  generateId?: () => string;
  maxCodeAttempts?: number;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function defaultRoomCode(): string {
  return Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join("");
}

function failure<T = never>(code: RoomManagementErrorCode, message: string): ApplicationResult<T> {
  return { ok: false, error: { code, message } };
}

function success<T>(value: T): ApplicationResult<T> {
  return { ok: true, value };
}

function normalizeNickname(nickname: string): string {
  return nickname.trim();
}

function nicknameKey(nickname: string): string {
  return normalizeNickname(nickname).toLocaleLowerCase("en");
}

function isRevealMode(value: unknown): value is RevealMode {
  return value === "SINGLE_DEVICE" || value === "INDIVIDUAL_DEVICES";
}

/**
 * Application-level room operations. The module is independent of HTTP,
 * Fastify, WebSockets, and persistent databases.
 */
export class RoomManagementService {
  private readonly generateRoomCode: () => string;
  private readonly generateId: () => string;
  private readonly maxCodeAttempts: number;

  constructor(
    private readonly store: RoomStore,
    options: RoomManagementOptions = {},
  ) {
    this.generateRoomCode = options.generateRoomCode ?? defaultRoomCode;
    this.generateId = options.generateId ?? randomUUID;
    this.maxCodeAttempts = options.maxCodeAttempts ?? 10;
  }

  createRoom(input: CreateRoomInput): ApplicationResult<Room> {
    if (!isRevealMode(input?.revealMode)) {
      return failure("INVALID_REVEAL_MODE", "Reveal mode must be SINGLE_DEVICE or INDIVIDUAL_DEVICES.");
    }

    const hostNickname = normalizeNickname(input.hostNickname);
    const nicknameValidation = validateNickname(hostNickname);
    if (!nicknameValidation.ok) {
      return failure("INVALID_NICKNAME", nicknameValidation.errors.join(" "));
    }

    if (!Number.isInteger(this.maxCodeAttempts) || this.maxCodeAttempts < 1) {
      return failure("ROOM_CREATION_FAILED", "Room code retry limit is not configured correctly.");
    }

    try {
      for (let attempt = 0; attempt < this.maxCodeAttempts; attempt += 1) {
        const code = this.generateRoomCode();
        if (!validateRoomCode(code).ok) {
          return failure("ROOM_CREATION_FAILED", "Room code generator produced an invalid code.");
        }
        if (this.store.hasCode(code)) continue;

        const hostId = this.generateId();
        if (!hostId.trim()) {
          return failure("ROOM_CREATION_FAILED", "Could not generate a valid host identity.");
        }

        let room: Room;
        if (input.revealMode === "SINGLE_DEVICE") {
          const host: HostIdentity = { id: hostId, nickname: hostNickname };
          room = {
            id: this.generateId(),
            code,
            revealMode: "SINGLE_DEVICE",
            host,
            players: [],
            phase: "LOBBY",
            rounds: [],
            currentRoundId: null,
            currentSubjectSetterPlayerId: null,
          };
        } else {
          const host: Player = { id: hostId, nickname: hostNickname };
          room = {
            id: this.generateId(),
            code,
            revealMode: "INDIVIDUAL_DEVICES",
            host,
            players: [host],
            phase: "LOBBY",
            rounds: [],
            currentRoundId: null,
            currentSubjectSetterPlayerId: null,
          };
        }

        // The storage insert is atomic and rechecks the unique active-room code.
        if (this.store.createIfAbsent(room)) return success(room);
      }
      return failure("ROOM_CODE_EXHAUSTED", "Could not allocate a unique room code after several attempts.");
    } catch {
      return failure("ROOM_CREATION_FAILED", "Room could not be created. No room was stored.");
    }
  }

  joinRoom(input: JoinRoomInput): ApplicationResult<JoinedRoom> {
    const codeValidation = validateRoomCode(input?.roomCode);
    if (!codeValidation.ok) {
      return failure("INVALID_ROOM_CODE", codeValidation.errors.join(" "));
    }

    const nickname = normalizeNickname(input.nickname);
    const nicknameValidation = validateNickname(nickname);
    if (!nicknameValidation.ok) {
      return failure("INVALID_NICKNAME", nicknameValidation.errors.join(" "));
    }

    const current = this.store.getByCode(input.roomCode);
    if (!current) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
    if (current.phase !== "LOBBY") {
      return failure("ROOM_UNAVAILABLE", "This room is not accepting new players.");
    }

    if (current.players.some((player) => nicknameKey(player.nickname) === nicknameKey(nickname))) {
      return failure("DUPLICATE_NICKNAME", "That nickname is already used in this room.");
    }

    let playerId: string;
    try {
      playerId = this.generateId();
      if (!playerId.trim() || current.players.some((player) => player.id === playerId) ||
          (current.revealMode === "SINGLE_DEVICE" && current.host.id === playerId)) {
        return failure("ROOM_CREATION_FAILED", "Could not generate a unique player identity.");
      }
    } catch {
      return failure("ROOM_CREATION_FAILED", "Could not generate a player identity. Room was not changed.");
    }

    const player: Player = { id: playerId, nickname };
    let joined: Room | undefined;
    try {
      joined = this.store.updateIfPresent(input.roomCode, (room) => {
        // Recheck every condition inside the atomic update operation.
        if (room.phase !== "LOBBY") return undefined;
        if (room.players.some((existing) => nicknameKey(existing.nickname) === nicknameKey(nickname))) {
          return undefined;
        }
        if (room.players.some((existing) => existing.id === playerId) ||
            (room.revealMode === "SINGLE_DEVICE" && room.host.id === playerId)) {
          return undefined;
        }
        return { ...room, players: [...room.players, player] };
      });
    } catch {
      return failure("ROOM_UNAVAILABLE", "Room could not be updated. No player was added.");
    }

    if (!joined) {
      const latest = this.store.getByCode(input.roomCode);
      if (!latest) return failure("ROOM_NOT_FOUND", "No active room exists with that code.");
      if (latest.phase !== "LOBBY") return failure("ROOM_UNAVAILABLE", "This room is not accepting new players.");
      if (latest.players.some((existing) => nicknameKey(existing.nickname) === nicknameKey(nickname))) {
        return failure("DUPLICATE_NICKNAME", "That nickname is already used in this room.");
      }
      return failure("ROOM_UNAVAILABLE", "Room could not be updated. Please try again.");
    }

    return success({ room: joined, player });
  }
}
