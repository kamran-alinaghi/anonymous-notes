import type { Room } from "../domain/types.js";
import type { RoomManagementService } from "../rooms/room-management.js";
import {
  parseIncomingMessage,
  type OutgoingMessage,
  type PublicRoomView,
} from "./contracts.js";
import { ConnectionSessions, type ConnectionSession, type SessionConnection } from "./sessions.js";

function publicRoomView(room: Room): PublicRoomView {
  return {
    roomCode: room.code,
    revealMode: room.revealMode,
    phase: room.phase,
    hostNickname: room.host.nickname,
    players: room.players.map((player) => ({ nickname: player.nickname })),
  };
}

function safeError(code: string, message: string, requestId?: string): OutgoingMessage {
  return {
    type: "ERROR",
    ...(requestId ? { requestId } : {}),
    error: { code, message },
  };
}

/** Transport coordinator; business rules remain in RoomManagementService. */
export class WebSocketTransport {
  readonly sessions: ConnectionSessions;

  constructor(
    private readonly roomManagement: RoomManagementService,
    generateConnectionId: () => string,
  ) {
    this.sessions = new ConnectionSessions(generateConnectionId);
  }

  attach(socket: SessionConnection): void {
    const session = this.sessions.register(socket);
    try {
      this.send(socket, { type: "CONNECTED", connectionId: session.connectionId });
    } catch {
      this.sessions.unregister(socket);
      return;
    }

    socket.on("message", (data) => {
      void this.handleMessage(socket, data);
    });
    socket.on("close", () => this.sessions.unregister(socket));
    socket.on("error", () => this.sessions.unregister(socket));
  }

  private send(socket: SessionConnection, message: OutgoingMessage): void {
    socket.send(JSON.stringify(message));
  }

  private async handleMessage(socket: SessionConnection, data: unknown): Promise<void> {
    const session = this.sessions.getForSocket(socket);
    if (!session) {
      this.trySend(socket, safeError("SESSION_NOT_FOUND", "Connection session is unavailable."));
      return;
    }

    try {
      const parsed = parseIncomingMessage(data);
      if (!parsed.ok) {
        this.trySend(socket, safeError(parsed.code, parsed.message, parsed.requestId));
        return;
      }

      if (session.role !== "UNASSIGNED") {
        this.trySend(socket, safeError(
          "SESSION_ALREADY_BOUND",
          "This connection already has an identity. Open a new connection for another room.",
          parsed.message.requestId,
        ));
        return;
      }

      if (parsed.message.type === "CREATE_ROOM") {
        const result = this.roomManagement.createRoom({
          revealMode: parsed.message.revealMode,
          hostNickname: parsed.message.hostNickname,
        });
        if (!result.ok) {
          this.trySend(socket, safeError(result.error.code, result.error.message, parsed.message.requestId));
          return;
        }

        const room = result.value;
        const playerId = room.revealMode === "INDIVIDUAL_DEVICES" ? room.host.id : null;
        const bound = this.sessions.bind(session, {
          role: "HOST",
          roomCode: room.code,
          roomId: room.id,
          playerId,
          nickname: room.host.nickname,
        });
        if (!bound) {
          // This is an invariant failure; do not leak internals to the client.
          this.trySend(socket, safeError("SESSION_BIND_FAILED", "Could not establish this connection's identity.", parsed.message.requestId));
          return;
        }

        this.trySend(socket, {
          type: "ROOM_CREATED",
          requestId: parsed.message.requestId,
          room: publicRoomView(room),
          sessionRole: "HOST",
          nickname: room.host.nickname,
        });
        return;
      }

      const result = this.roomManagement.joinRoom({
        roomCode: parsed.message.roomCode,
        nickname: parsed.message.nickname,
      });
      if (!result.ok) {
        this.trySend(socket, safeError(result.error.code, result.error.message, parsed.message.requestId));
        return;
      }

      const { room, player } = result.value;
      const bound = this.sessions.bind(session, {
        role: "PLAYER",
        roomCode: room.code,
        roomId: room.id,
        playerId: player.id,
        nickname: player.nickname,
      });
      if (!bound) {
        this.trySend(socket, safeError("SESSION_BIND_FAILED", "Could not establish this connection's identity.", parsed.message.requestId));
        return;
      }

      this.trySend(socket, {
        type: "ROOM_JOINED",
        requestId: parsed.message.requestId,
        room: publicRoomView(room),
        sessionRole: "PLAYER",
        nickname: player.nickname,
      });
    } catch {
      this.trySend(socket, safeError("INTERNAL_ERROR", "The request could not be processed."));
    }
  }

  private trySend(socket: SessionConnection, message: OutgoingMessage): void {
    try {
      this.send(socket, message);
    } catch {
      this.sessions.unregister(socket);
    }
  }
}
