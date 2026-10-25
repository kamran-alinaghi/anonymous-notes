import type { Room } from "../domain/types.js";
import type { GameManagementService } from "../game/game-management.js";
import type { LobbyManagementService } from "../lobby/lobby-management.js";
import type { NoteSubmissionService, NoteSubmissionProgress } from "../notes/note-submission.js";
import type { RoomManagementService } from "../rooms/room-management.js";
import {
  parseIncomingMessage,
  type GameRoomView,
  type OutgoingMessage,
  type PublicRoomView,
  type SubmissionProgressView,
} from "./contracts.js";
import { ConnectionSessions, type ConnectionSession, type SessionConnection } from "./sessions.js";

function publicRoomView(room: Room, isHost: boolean): PublicRoomView {
  const common = {
    roomCode: room.code,
    revealMode: room.revealMode,
    phase: room.phase,
    hostNickname: room.host.nickname,
    playerCount: room.players.length,
  };
  return isHost
    ? {
        ...common,
        viewerRole: "HOST",
        players: room.players.map((player) => ({ id: player.id, nickname: player.nickname })),
      }
    : { ...common, viewerRole: "PLAYER" };
}

function gameRoomView(room: Room): GameRoomView {
  const currentRound = room.currentRoundId === null
    ? undefined
    : room.rounds.find((round) => round.id === room.currentRoundId);
  const setter = room.currentSubjectSetterPlayerId === null
    ? undefined
    : room.players.find((player) => player.id === room.currentSubjectSetterPlayerId);
  return {
    roomCode: room.code,
    revealMode: room.revealMode,
    phase: room.phase,
    hostNickname: room.host.nickname,
    playerCount: room.players.length,
    currentRoundNumber: currentRound?.number ?? 0,
    currentSubjectSetterNickname: setter?.nickname ?? null,
    subject: currentRound?.subject ?? null,
  };
}

function submissionProgressView(progress: NoteSubmissionProgress, isHost: boolean): SubmissionProgressView {
  const common = {
    roomCode: progress.roomCode,
    phase: progress.phase,
    roundNumber: progress.roundNumber,
    submittedCount: progress.submittedCount,
    totalPlayerCount: progress.totalPlayerCount,
  };
  return isHost
    ? {
        ...common,
        viewerRole: "HOST",
        players: progress.players.map((player) => ({ ...player })),
      }
    : { ...common, viewerRole: "PLAYER" };
}

function safeError(code: string, message: string, requestId?: string): OutgoingMessage {
  return {
    type: "ERROR",
    ...(requestId ? { requestId } : {}),
    error: { code, message },
  };
}

/** Transport coordinator; business rules remain in application services. */
export class WebSocketTransport {
  readonly sessions: ConnectionSessions;

  constructor(
    private readonly roomManagement: RoomManagementService,
    generateConnectionId: () => string,
    private readonly lobbyManagement?: LobbyManagementService,
    private readonly gameManagement?: GameManagementService,
    private readonly noteSubmission?: NoteSubmissionService,
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

      if (parsed.message.type === "REORDER_PLAYERS") {
        this.handleReorder(socket, session, parsed.message.requestId, parsed.message.playerIds);
        return;
      }
      if (parsed.message.type === "START_GAME") {
        this.handleStartGame(socket, session, parsed.message.requestId);
        return;
      }
      if (parsed.message.type === "SET_SUBJECT") {
        this.handleSetSubject(socket, session, parsed.message.requestId, parsed.message.subject);
        return;
      }
      if (parsed.message.type === "SUBMIT_NOTE_BATCH") {
        this.handleSubmitNoteBatch(socket, session, parsed.message.requestId, parsed.message.notes);
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
          hostId: room.host.id,
          nickname: room.host.nickname,
        });
        if (!bound) {
          this.trySend(socket, safeError("SESSION_BIND_FAILED", "Could not establish this connection's identity.", parsed.message.requestId));
          return;
        }

        this.trySend(socket, {
          type: "ROOM_CREATED",
          requestId: parsed.message.requestId,
          room: publicRoomView(room, true),
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
        hostId: null,
        nickname: player.nickname,
      });
      if (!bound) {
        this.trySend(socket, safeError("SESSION_BIND_FAILED", "Could not establish this connection's identity.", parsed.message.requestId));
        return;
      }

      this.trySend(socket, {
        type: "ROOM_JOINED",
        requestId: parsed.message.requestId,
        room: publicRoomView(room, false),
        sessionRole: "PLAYER",
        nickname: player.nickname,
      });
      this.broadcastLobby(room);
    } catch {
      this.trySend(socket, safeError("INTERNAL_ERROR", "The request could not be processed."));
    }
  }

  private handleReorder(
    socket: SessionConnection,
    session: ConnectionSession,
    requestId: string,
    playerIds: string[],
  ): void {
    if (session.role !== "HOST" || !session.hostId || !session.roomCode) {
      this.trySend(socket, safeError("UNAUTHORIZED", "Only the authenticated room host may reorder players.", requestId));
      return;
    }
    if (!this.lobbyManagement) {
      this.trySend(socket, safeError("LOBBY_UNAVAILABLE", "Lobby management is unavailable.", requestId));
      return;
    }

    const result = this.lobbyManagement.reorderPlayers(session.roomCode, session.hostId, playerIds);
    if (!result.ok) {
      this.trySend(socket, safeError(result.error.code, result.error.message, requestId));
      return;
    }

    const room = result.value;
    this.trySend(socket, {
      type: "PLAYER_ORDER_UPDATED",
      requestId,
      room: publicRoomView(room, true) as Extract<OutgoingMessage, { type: "PLAYER_ORDER_UPDATED" }>["room"],
    });
    this.broadcastLobby(room);
  }

  private handleStartGame(socket: SessionConnection, session: ConnectionSession, requestId: string): void {
    if (session.role !== "HOST" || !session.hostId || !session.roomCode) {
      this.trySend(socket, safeError("UNAUTHORIZED", "Only the authenticated room host may start the game.", requestId));
      return;
    }
    if (!this.gameManagement) {
      this.trySend(socket, safeError("GAME_UNAVAILABLE", "Game management is unavailable.", requestId));
      return;
    }
    const result = this.gameManagement.startGame(session.roomCode, session.hostId);
    if (!result.ok) {
      this.trySend(socket, safeError(result.error.code, result.error.message, requestId));
      return;
    }
    this.trySend(socket, { type: "GAME_STARTED", requestId, room: gameRoomView(result.value) });
    this.broadcastGameState(result.value);
  }

  private handleSetSubject(
    socket: SessionConnection,
    session: ConnectionSession,
    requestId: string,
    subject: string,
  ): void {
    if ((session.role !== "HOST" && session.role !== "PLAYER") || !session.playerId || !session.roomCode) {
      this.trySend(socket, safeError("UNAUTHORIZED", "Only an authenticated actual player may submit a subject.", requestId));
      return;
    }
    if (!this.gameManagement) {
      this.trySend(socket, safeError("GAME_UNAVAILABLE", "Game management is unavailable.", requestId));
      return;
    }
    const result = this.gameManagement.submitSubject(session.roomCode, session.playerId, subject);
    if (!result.ok) {
      this.trySend(socket, safeError(result.error.code, result.error.message, requestId));
      return;
    }
    this.trySend(socket, { type: "SUBJECT_SUBMITTED", requestId, room: gameRoomView(result.value) });
    this.broadcastGameState(result.value);
  }

  private broadcastGameState(room: Room): void {
    const view = gameRoomView(room);
    for (const [session, socket] of this.sessions.getConnectionsSnapshot()) {
      if (session.roomCode !== room.code) continue;
      this.trySend(socket, { type: "GAME_STATE_UPDATED", room: view });
    }
  }

  private handleSubmitNoteBatch(
    socket: SessionConnection,
    session: ConnectionSession,
    requestId: string,
    notes: Array<{ targetPlayerId: string; content: string }>,
  ): void {
    if ((session.role !== "HOST" && session.role !== "PLAYER") || !session.playerId || !session.roomCode) {
      this.trySend(socket, safeError("UNAUTHORIZED", "Only an authenticated actual player may submit a note batch.", requestId));
      return;
    }
    if (!this.noteSubmission) {
      this.trySend(socket, safeError("NOTE_SUBMISSION_UNAVAILABLE", "Note submission is unavailable.", requestId));
      return;
    }
    const result = this.noteSubmission.submitBatch(session.roomCode, session.playerId, notes);
    if (!result.ok) {
      this.trySend(socket, safeError(result.error.code, result.error.message, requestId));
      return;
    }
    this.trySend(socket, {
      type: "NOTE_BATCH_ACCEPTED",
      requestId,
      submittedNotes: result.value.submittedNotes,
      progress: submissionProgressView(result.value.progress, session.role === "HOST"),
    });
    this.broadcastSubmissionProgress(result.value.progress);
  }

  private broadcastSubmissionProgress(progress: NoteSubmissionProgress): void {
    for (const [session, socket] of this.sessions.getConnectionsSnapshot()) {
      if (session.roomCode !== progress.roomCode) continue;
      this.trySend(socket, {
        type: "SUBMISSION_PROGRESS_UPDATED",
        progress: submissionProgressView(progress, session.role === "HOST" && session.hostId !== null),
      });
    }
  }

  private broadcastLobby(room: Room): void {
    for (const [session, socket] of this.sessions.getConnectionsSnapshot()) {
      if (session.roomCode !== room.code) continue;
      this.trySend(socket, {
        type: "LOBBY_UPDATED",
        room: publicRoomView(room, session.role === "HOST" && session.hostId === room.host.id),
      });
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
