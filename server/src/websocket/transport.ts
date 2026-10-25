import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";

import type { Room } from "../domain/types.js";
import type { ConnectionLifecycleService } from "../game/connection-lifecycle.js";
import type { GameManagementService } from "../game/game-management.js";
import type { RoundLifecycleService } from "../game/round-lifecycle.js";
import type { LobbyManagementService } from "../lobby/lobby-management.js";
import type { NoteSubmissionService, NoteSubmissionProgress } from "../notes/note-submission.js";
import type { RevealSessionService, RevealViewer } from "../reveal/reveal-session.js";
import type { RoomManagementService } from "../rooms/room-management.js";
import {
  parseIncomingMessage,
  type GameRoomView,
  type OutgoingMessage,
  type PublicRoomView,
  type SubmissionProgressView,
} from "./contracts.js";
import { ConnectionSessions, type ConnectionSession, type SessionConnection } from "./sessions.js";

type ReconnectIdentity = Omit<ConnectionSession, "connectionId">;
type ActiveIdentityConnection = { socket: SessionConnection; session: ConnectionSession };

interface TransportRuntimeOptions {
  maxConnections?: number;
  maxMessagesPerMinute?: number;
  logger?: FastifyBaseLogger;
}

interface MessageWindow {
  startedAt: number;
  count: number;
}

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
  private readonly reconnectCredentials = new Map<string, ReconnectIdentity>();
  private readonly credentialByIdentity = new Map<string, string>();
  private readonly activeByIdentity = new Map<string, ActiveIdentityConnection>();
  private readonly generateSessionToken: () => string;
  private acceptingConnections = true;
  private readonly messageWindows = new Map<string, MessageWindow>();

  constructor(
    private readonly roomManagement: RoomManagementService,
    generateConnectionId: () => string,
    private readonly lobbyManagement?: LobbyManagementService,
    private readonly gameManagement?: GameManagementService,
    private readonly noteSubmission?: NoteSubmissionService,
    private readonly revealSession?: RevealSessionService,
    private readonly roundLifecycle?: RoundLifecycleService,
    private readonly connectionLifecycle?: ConnectionLifecycleService,
    generateSessionToken: () => string = () => randomBytes(32).toString("hex"),
    private readonly runtimeOptions: TransportRuntimeOptions = {},
  ) {
    this.sessions = new ConnectionSessions(generateConnectionId);
    this.generateSessionToken = generateSessionToken;
  }

  get canAcceptConnection(): boolean {
    return this.acceptingConnections && this.sessions.size < (this.runtimeOptions.maxConnections ?? 1000);
  }

  shutdown(): void {
    if (!this.acceptingConnections) return;
    this.acceptingConnections = false;
    const connections = this.sessions.getConnectionsSnapshot();
    for (const [session, socket] of connections) {
      const key = this.identityKey(session);
      if (key && this.activeByIdentity.get(key)?.socket === socket) this.activeByIdentity.delete(key);
      try {
        socket.close?.(1001, "Server shutting down");
      } catch {
        // Continue closing other sockets if one transport has already failed.
      }
      this.sessions.unregister(socket);
    }
    this.reconnectCredentials.clear();
    this.credentialByIdentity.clear();
    this.activeByIdentity.clear();
    this.messageWindows.clear();
    this.runtimeOptions.logger?.info(
      { event: "websocket_shutdown", closedConnections: connections.length },
      "WebSocket connections closed for shutdown",
    );
  }

  attach(socket: SessionConnection): void {
    if (!this.acceptingConnections) {
      socket.close?.(1012, "Server is shutting down");
      return;
    }
    if (this.sessions.size >= (this.runtimeOptions.maxConnections ?? 1000)) {
      this.runtimeOptions.logger?.warn(
        { event: "websocket_connection_limit_reached", maxConnections: this.runtimeOptions.maxConnections ?? 1000 },
        "WebSocket connection limit reached",
      );
      socket.close?.(1013, "Server is busy");
      return;
    }
    const session = this.sessions.register(socket);
    try {
      this.send(socket, { type: "CONNECTED", connectionId: session.connectionId });
    } catch {
      this.sessions.unregister(socket);
      return;
    }

    this.runtimeOptions.logger?.info(
      { event: "websocket_connected", connectionId: session.connectionId },
      "WebSocket connection established",
    );
    socket.on("message", (data) => {
      void this.handleMessage(socket, data);
    });
    socket.on("close", () => this.handleDisconnect(socket));
    socket.on("error", () => this.handleDisconnect(socket));
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
      if (!this.consumeMessageBudget(session)) {
        this.runtimeOptions.logger?.warn(
          { event: "websocket_message_rate_limited", connectionId: session.connectionId },
          "WebSocket message rate limit exceeded",
        );
        this.trySend(socket, safeError("MESSAGE_RATE_LIMITED", "Too many messages. This connection will be closed."));
        socket.close?.(1008, "Message rate limit exceeded");
        this.handleDisconnect(socket);
        return;
      }

      const parsed = parseIncomingMessage(data);
      if (!parsed.ok) {
        this.runtimeOptions.logger?.warn(
          { event: "websocket_message_rejected", connectionId: session.connectionId, code: parsed.code },
          "WebSocket message rejected",
        );
        this.trySend(socket, safeError(parsed.code, parsed.message, parsed.requestId));
        return;
      }

      if (parsed.message.type === "RECONNECT") {
        this.handleReconnect(socket, session, parsed.message.requestId, parsed.message.sessionToken);
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
      if (parsed.message.type === "GET_REVEAL_STATE") {
        this.handleGetRevealState(socket, session, parsed.message.requestId);
        return;
      }
      if (parsed.message.type === "NAVIGATE_REVEAL") {
        this.handleNavigateReveal(socket, session, parsed.message.requestId, parsed.message.action);
        return;
      }
      if (parsed.message.type === "COMPLETE_ROUND" || parsed.message.type === "FINISH_GAME" || parsed.message.type === "START_NEXT_ROUND" || parsed.message.type === "TERMINATE_GAME") {
        this.handleRoundLifecycle(socket, session, parsed.message.requestId, parsed.message.type);
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
        const sessionToken = this.bindIdentity(socket, session, {
          role: "HOST",
          roomCode: room.code,
          roomId: room.id,
          playerId,
          hostId: room.host.id,
          nickname: room.host.nickname,
        });
        if (!sessionToken) {
          this.trySend(socket, safeError("SESSION_BIND_FAILED", "Could not establish this connection's identity.", parsed.message.requestId));
          return;
        }

        this.trySend(socket, {
          type: "ROOM_CREATED",
          requestId: parsed.message.requestId,
          room: publicRoomView(room, true),
          sessionRole: "HOST",
          nickname: room.host.nickname,
          sessionToken,
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
      const sessionToken = this.bindIdentity(socket, session, {
        role: "PLAYER",
        roomCode: room.code,
        roomId: room.id,
        playerId: player.id,
        hostId: null,
        nickname: player.nickname,
      });
      if (!sessionToken) {
        this.trySend(socket, safeError("SESSION_BIND_FAILED", "Could not establish this connection's identity.", parsed.message.requestId));
        return;
      }

      this.trySend(socket, {
        type: "ROOM_JOINED",
        requestId: parsed.message.requestId,
        room: publicRoomView(room, false),
        sessionRole: "PLAYER",
        nickname: player.nickname,
        sessionToken,
      });
      this.broadcastLobby(room);
    } catch {
      this.runtimeOptions.logger?.error(
        { event: "websocket_request_failed", connectionId: session.connectionId },
        "WebSocket request failed",
      );
      this.trySend(socket, safeError("INTERNAL_ERROR", "The request could not be processed."));
    }
  }

  private consumeMessageBudget(session: ConnectionSession): boolean {
    const now = Date.now();
    const window = this.messageWindows.get(session.connectionId);
    const limit = this.runtimeOptions.maxMessagesPerMinute ?? 120;
    if (!window || now - window.startedAt >= 60_000) {
      this.messageWindows.set(session.connectionId, { startedAt: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  }

  private identityKey(identity: ReconnectIdentity): string | null {
    if (!identity.roomId || identity.role === "UNASSIGNED") return null;
    const memberId = identity.playerId ?? identity.hostId;
    return memberId ? `${identity.roomId}:${identity.role}:${memberId}` : null;
  }

  private issueSessionToken(identity: ReconnectIdentity): string | null {
    const key = this.identityKey(identity);
    if (!key) return null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = this.generateSessionToken();
      if (typeof token !== "string" || token.length < 32 || token.length > 256 || this.reconnectCredentials.has(token)) continue;
      const oldToken = this.credentialByIdentity.get(key);
      if (oldToken) this.reconnectCredentials.delete(oldToken);
      this.reconnectCredentials.set(token, { ...identity });
      this.credentialByIdentity.set(key, token);
      return token;
    }
    return null;
  }

  private bindIdentity(
    socket: SessionConnection,
    session: ConnectionSession,
    identity: ReconnectIdentity,
  ): string | null {
    const key = this.identityKey(identity);
    if (!key || this.activeByIdentity.has(key) || !this.sessions.bind(session, identity)) return null;
    this.activeByIdentity.set(key, { socket, session });
    const token = this.issueSessionToken(identity);
    if (!token) {
      this.activeByIdentity.delete(key);
      this.sessions.unregister(socket);
      return null;
    }
    return token;
  }

  private handleReconnect(
    socket: SessionConnection,
    session: ConnectionSession,
    requestId: string,
    presentedToken: string,
  ): void {
    if (session.role !== "UNASSIGNED") {
      this.trySend(socket, safeError("SESSION_ALREADY_BOUND", "This connection already has an identity.", requestId));
      return;
    }
    const identity = this.reconnectCredentials.get(presentedToken);
    if (!identity) {
      this.trySend(socket, safeError("INVALID_SESSION_CREDENTIAL", "The session credential is invalid or has already been used.", requestId));
      return;
    }
    const key = this.identityKey(identity);
    if (!key || this.activeByIdentity.has(key)) {
      this.trySend(socket, safeError("SESSION_ALREADY_CONNECTED", "This identity already has an active connection.", requestId));
      return;
    }
    const lifecycleState = identity.roomCode ? this.connectionLifecycle?.getState(identity.roomCode) : undefined;
    const staleIdentity = !lifecycleState || !lifecycleState.ok ||
      lifecycleState.value.room.id !== identity.roomId ||
      (identity.playerId !== null && !lifecycleState.value.room.players.some((player) => player.id === identity.playerId));
    if (staleIdentity) {
      this.reconnectCredentials.delete(presentedToken);
      if (this.credentialByIdentity.get(key) === presentedToken) this.credentialByIdentity.delete(key);
      this.trySend(socket, safeError("STALE_SESSION", "The room or player identity no longer exists.", requestId));
      return;
    }
    if (!lifecycleState || !lifecycleState.ok) return;

    this.reconnectCredentials.delete(presentedToken);
    if (this.credentialByIdentity.get(key) === presentedToken) this.credentialByIdentity.delete(key);
    const nextToken = this.bindIdentity(socket, session, identity);
    if (!nextToken) {
      this.trySend(socket, safeError("SESSION_BIND_FAILED", "Could not restore this session.", requestId));
      return;
    }

    let room = lifecycleState.value.room;
    const wasPaused = lifecycleState.value.paused;
    let deferredProgress: NoteSubmissionProgress | undefined;
    let deferredRevealStarted = false;
    if (identity.playerId !== null && this.connectionLifecycle) {
      const reconnected = this.connectionLifecycle.markReconnected(identity.roomCode!, identity.roomId!, identity.playerId);
      if (!reconnected.ok) {
        this.handleDisconnect(socket);
        this.trySend(socket, safeError(reconnected.error.code, reconnected.error.message, requestId));
        return;
      }
      room = reconnected.value;
    }
    if (room.phase === "WRITING" && this.noteSubmission) {
      const finalized = this.noteSubmission.finalizeIfReady(room.code);
      if (finalized.ok) {
        room = finalized.value.room;
        deferredProgress = finalized.value.progress;
        deferredRevealStarted = finalized.value.transitioned;
      }
    }

    this.runtimeOptions.logger?.info(
      { event: "session_restored", connectionId: session.connectionId, roomCode: room.code, role: identity.role },
      "WebSocket session restored",
    );
    this.trySend(socket, {
      type: "SESSION_RESTORED",
      requestId,
      sessionRole: identity.role as "HOST" | "PLAYER",
      nickname: identity.nickname ?? "",
      sessionToken: nextToken,
      room: gameRoomView(room),
    });
    if (room.phase === "LOBBY") {
      this.trySend(socket, {
        type: "LOBBY_UPDATED",
        room: publicRoomView(room, identity.role === "HOST" && identity.hostId === room.host.id),
      });
    } else {
      this.trySend(socket, { type: "GAME_STATE_UPDATED", room: gameRoomView(room) });
    }
    this.broadcastConnectionState(room);
    if (deferredRevealStarted && deferredProgress) {
      this.broadcastSubmissionProgress(deferredProgress);
      this.broadcastGameState(room);
    }

    const currentState = this.connectionLifecycle?.getState(room.code);
    if (wasPaused && currentState?.ok && !currentState.value.paused) {
      this.broadcastToRoom(room.code, { type: "GAME_RESUMED", room: gameRoomView(room) });
      this.broadcastGameState(room);
      if (room.phase === "REVEALING") this.broadcastRevealState(room.code);
    }
    if (room.phase === "WRITING" && this.noteSubmission) {
      const progress = this.noteSubmission.getProgress(room.code);
      if (progress.ok) {
        this.trySend(socket, {
          type: "SUBMISSION_PROGRESS_UPDATED",
          progress: submissionProgressView(progress.value, identity.role === "HOST" && identity.hostId !== null),
        });
      }
    }
    if (room.phase === "REVEALING" && currentState?.ok && !currentState.value.paused) this.broadcastRevealState(room.code);
  }

  private handleDisconnect(socket: SessionConnection): void {
    const session = this.sessions.getForSocket(socket);
    if (!session) return;
    const key = this.identityKey(session);
    const active = key ? this.activeByIdentity.get(key) : undefined;
    const isCurrent = active?.socket === socket && active.session === session;
    if (isCurrent && key) this.activeByIdentity.delete(key);
    this.sessions.unregister(socket);
    this.messageWindows.delete(session.connectionId);
    this.runtimeOptions.logger?.info(
      { event: "websocket_disconnected", connectionId: session.connectionId, role: session.role, roomCode: session.roomCode },
      "WebSocket connection closed",
    );

    if (!isCurrent || !session.playerId || !session.roomCode || !session.roomId || !this.connectionLifecycle) return;
    const result = this.connectionLifecycle.markDisconnected(session.roomCode, session.roomId, session.playerId);
    if (result.ok) this.broadcastConnectionState(result.value);
  }

  private broadcastToRoom(roomCode: string, message: OutgoingMessage): void {
    for (const [session, socket] of this.sessions.getConnectionsSnapshot()) {
      if (session.roomCode === roomCode) this.trySend(socket, message);
    }
  }

  private broadcastConnectionState(room: Room): void {
    const result = this.connectionLifecycle?.getState(room.code);
    if (!result?.ok) return;
    const state = result.value;
    const disconnectedPlayers = state.disconnectedPlayers.map((player) => ({
      playerId: player.id,
      nickname: player.nickname,
    }));
    for (const [session, socket] of this.sessions.getConnectionsSnapshot()) {
      if (session.roomCode !== room.code) continue;
      this.trySend(socket, {
        type: "PLAYER_CONNECTIONS_UPDATED",
        roomCode: room.code,
        phase: state.room.phase,
        disconnectedPlayers,
        paused: state.paused,
      });
      if (state.paused) {
        this.trySend(socket, {
          type: "WAITING_FOR_PLAYERS",
          roomCode: room.code,
          phase: state.room.phase,
          disconnectedPlayers,
        });
      }
    }
  }

  private rejectIfPaused(socket: SessionConnection, session: ConnectionSession, requestId: string): boolean {
    if (!session.roomCode || !this.connectionLifecycle) return false;
    const state = this.connectionLifecycle.getState(session.roomCode);
    if (!state.ok || !state.value.paused) return false;
    this.trySend(socket, safeError("GAME_PAUSED", "Game progression is paused until every disconnected player reconnects.", requestId));
    return true;
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
    this.runtimeOptions.logger?.info(
      { event: "game_started", connectionId: session.connectionId, roomCode: result.value.code },
      "Game started",
    );
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
    if (this.rejectIfPaused(socket, session, requestId)) return;
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
    if (result.value.room.phase === "REVEALING") {
      const state = this.connectionLifecycle?.getState(result.value.room.code);
      if (state?.ok && state.value.paused) this.broadcastConnectionState(result.value.room);
      else this.broadcastRevealState(result.value.room.code);
    }
  }

  private handleGetRevealState(
    socket: SessionConnection,
    session: ConnectionSession,
    requestId: string,
  ): void {
    if ((session.role !== "HOST" && session.role !== "PLAYER") || !session.roomCode) {
      this.trySend(socket, safeError("UNAUTHORIZED", "An authenticated room member is required.", requestId));
      return;
    }
    if (this.rejectIfPaused(socket, session, requestId)) return;
    if (!this.revealSession) {
      this.trySend(socket, safeError("REVEAL_UNAVAILABLE", "Reveal session is unavailable.", requestId));
      return;
    }
    const viewer: RevealViewer = {
      role: session.role,
      hostId: session.hostId,
      playerId: session.playerId,
    };
    const result = this.revealSession.getViewerState(session.roomCode, viewer);
    if (!result.ok) {
      this.trySend(socket, safeError(result.error.code, result.error.message, requestId));
      return;
    }
    this.trySend(socket, { type: "REVEAL_STATE", requestId, state: result.value });
  }

  private handleNavigateReveal(
    socket: SessionConnection,
    session: ConnectionSession,
    requestId: string,
    action: "NEXT" | "PREVIOUS",
  ): void {
    if (session.role !== "HOST" || !session.hostId || !session.roomCode) {
      this.trySend(socket, safeError("UNAUTHORIZED", "Only the authenticated room host may navigate the reveal.", requestId));
      return;
    }
    if (this.rejectIfPaused(socket, session, requestId)) return;
    if (!this.revealSession) {
      this.trySend(socket, safeError("REVEAL_UNAVAILABLE", "Reveal session is unavailable.", requestId));
      return;
    }
    const result = this.revealSession.navigate(session.roomCode, session.hostId, action);
    if (!result.ok) {
      this.trySend(socket, safeError(result.error.code, result.error.message, requestId));
      return;
    }
    this.trySend(socket, {
      type: "REVEAL_NAVIGATED",
      requestId,
      position: result.value.position,
      total: result.value.total,
    });
    this.broadcastRevealState(session.roomCode);
  }

  private handleRoundLifecycle(
    socket: SessionConnection,
    session: ConnectionSession,
    requestId: string,
    action: "COMPLETE_ROUND" | "FINISH_GAME" | "START_NEXT_ROUND" | "TERMINATE_GAME",
  ): void {
    if (session.role !== "HOST" || !session.hostId || !session.roomCode) {
      this.trySend(socket, safeError("UNAUTHORIZED", "Only the authenticated room host may change the game lifecycle.", requestId));
      return;
    }
    if (action === "TERMINATE_GAME") {
      if (!this.connectionLifecycle) {
        this.trySend(socket, safeError("CONNECTION_LIFECYCLE_UNAVAILABLE", "Connection lifecycle management is unavailable.", requestId));
        return;
      }
      const terminated = this.connectionLifecycle.terminateGame(session.roomCode, session.hostId);
      if (!terminated.ok) {
        this.trySend(socket, safeError(terminated.error.code, terminated.error.message, requestId));
        return;
      }
      this.runtimeOptions.logger?.info(
        { event: "game_terminated", connectionId: session.connectionId, roomCode: terminated.value.code },
        "Game terminated by host",
      );
      this.trySend(socket, { type: "GAME_TERMINATED", requestId, room: gameRoomView(terminated.value) });
      this.broadcastGameState(terminated.value);
      this.broadcastConnectionState(terminated.value);
      return;
    }
    if (this.rejectIfPaused(socket, session, requestId)) return;
    if (!this.roundLifecycle) {
      this.trySend(socket, safeError("ROUND_LIFECYCLE_UNAVAILABLE", "Round lifecycle management is unavailable.", requestId));
      return;
    }

    const result = action === "COMPLETE_ROUND"
      ? this.roundLifecycle.completeRound(session.roomCode, session.hostId)
      : action === "FINISH_GAME"
        ? this.roundLifecycle.finishGame(session.roomCode, session.hostId)
        : this.roundLifecycle.startNextRound(session.roomCode, session.hostId);
    if (!result.ok) {
      this.trySend(socket, safeError(result.error.code, result.error.message, requestId));
      return;
    }

    const room = gameRoomView(result.value);
    const response = action === "COMPLETE_ROUND"
      ? { type: "ROUND_COMPLETED" as const, requestId, room }
      : action === "FINISH_GAME"
        ? { type: "GAME_FINISHED" as const, requestId, room }
        : { type: "NEXT_ROUND_STARTED" as const, requestId, room };
    this.trySend(socket, response);
    this.broadcastGameState(result.value);
  }

  /** Every connection gets a viewer-specific projection; private contents are never room-broadcast. */
  private broadcastRevealState(roomCode: string): void {
    if (!this.revealSession) return;
    for (const [session, socket] of this.sessions.getConnectionsSnapshot()) {
      if (session.roomCode !== roomCode || (session.role !== "HOST" && session.role !== "PLAYER")) continue;
      const viewer: RevealViewer = {
        role: session.role,
        hostId: session.hostId,
        playerId: session.playerId,
      };
      const result = this.revealSession.getViewerState(roomCode, viewer);
      if (!result.ok) continue;
      this.trySend(socket, { type: "REVEAL_STATE_UPDATED", state: result.value });
    }
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
      this.handleDisconnect(socket);
    }
  }
}
