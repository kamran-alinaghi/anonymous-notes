import {
  isServerMessage,
  type ErrorMessage,
  type RequestPayload,
  type ServerMessage,
  type SessionRestoredMessage,
} from "./protocol";
import {
  createBrowserSessionTokenStorage,
  type SessionTokenStorage,
} from "./session-token-storage";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "session-expired"
  | "closed";

export type SessionStatus = "none" | "restoring" | "restored" | "expired";

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  sessionStatus: SessionStatus;
  reconnectAttempt: number;
  lastError: string | null;
}

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

interface PendingRequest {
  type: string;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface WebSocketClientOptions {
  url: string;
  createSocket?: (url: string) => WebSocketLike;
  tokenStorage?: SessionTokenStorage;
  createRequestId?: () => string;
  requestTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxReconnectAttempts?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onMessage?: (message: ServerMessage) => void;
  onStateChange?: (snapshot: ConnectionSnapshot) => void;
}

const OPEN = 1;
const CONNECTING = 0;
export class WebSocketClient {
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly tokenStorage: SessionTokenStorage;
  private readonly createRequestId: () => string;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly requestTimeoutMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private socket: WebSocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionRestoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionRestoreConflictRetries = 0;
  private intentionalClose = false;
  private ready = false;
  private reconnectAttempt = 0;
  private awaitingReconnectRequestId: string | null = null;
  private snapshot: ConnectionSnapshot = {
    status: "idle",
    sessionStatus: "none",
    reconnectAttempt: 0,
    lastError: null,
  };

  constructor(private readonly options: WebSocketClientOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.tokenStorage = options.tokenStorage ?? createBrowserSessionTokenStorage();
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
    this.setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 500;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 10_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 8;
    if (!options.url) throw new Error("A WebSocket URL is required.");
  }

  get state(): ConnectionSnapshot {
    return { ...this.snapshot };
  }

  get isReady(): boolean {
    return this.ready && this.socket?.readyState === OPEN;
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === CONNECTING || this.socket.readyState === OPEN)) return;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.clearRetryTimer();
    this.openSocket(false);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.ready = false;
    this.clearRetryTimer();
    this.clearSessionRestoreRetryTimer();
    this.rejectPending(new Error("WebSocket connection closed by the client."));
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, "Client disconnected");
    this.updateState({ status: "closed", sessionStatus: this.snapshot.sessionStatus, reconnectAttempt: 0 });
  }

  async request(payload: RequestPayload): Promise<ServerMessage> {
    if (!this.isReady || !this.socket) {
      throw new Error("The WebSocket connection is not ready.");
    }
    const requestId = this.createRequestId();
    const message = { ...payload, requestId };
    return new Promise<ServerMessage>((resolve, reject) => {
      const timeoutId = this.setTimer(() => {
        this.pending.delete(requestId);
        reject(new Error("The server did not respond in time."));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        type: payload.type,
        resolve,
        reject,
        timeoutId,
      });
      try {
        this.socket!.send(JSON.stringify(message));
      } catch {
        this.clearTimer(timeoutId);
        this.pending.delete(requestId);
        reject(new Error("The request could not be sent."));
      }
    });
  }

  private openSocket(isRetry: boolean): void {
    this.ready = false;
    this.updateState({
      status: isRetry ? "reconnecting" : "connecting",
      reconnectAttempt: this.reconnectAttempt,
      lastError: null,
    });

    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect("Could not open the WebSocket connection.");
      return;
    }
    this.socket = socket;

    const onOpen = () => {
      // The server's CONNECTED message is the application-level handshake.
    };
    const onMessage = (event: { data?: unknown }) => this.handleRawMessage(event.data);
    const onClose = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.clearSessionRestoreRetryTimer();
      this.rejectPending(new Error("WebSocket connection was interrupted."));
      if (!this.intentionalClose) this.scheduleReconnect("Connection lost.");
    };
    const onError = () => {
      // Browsers provide no useful error detail; the close event drives recovery.
      this.updateState({ lastError: "WebSocket connection error." });
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  }

  private handleRawMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      this.updateState({ lastError: "Received an unsupported WebSocket message." });
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.updateState({ lastError: "Received invalid JSON from the server." });
      return;
    }
    if (!isServerMessage(value)) {
      this.updateState({ lastError: "Received an invalid message from the server." });
      return;
    }

    const message = value;
    if (message.type === "CONNECTED") {
      const token = this.tokenStorage.read();
      if (token) {
        this.updateState({ sessionStatus: "restoring" });
        const requestId = this.createRequestId();
        this.awaitingReconnectRequestId = requestId;
        try {
          this.socket?.send(JSON.stringify({ type: "RECONNECT", requestId, sessionToken: token }));
        } catch {
          this.tokenStorage.clear();
          this.awaitingReconnectRequestId = null;
          this.updateState({ sessionStatus: "expired", status: "session-expired", lastError: "Could not restore the previous session." });
          this.ready = true;
        }
      } else {
        this.ready = true;
        this.reconnectAttempt = 0;
        this.updateState({ status: "connected", sessionStatus: "none", reconnectAttempt: 0 });
      }
    }

    if (message.type === "SESSION_RESTORED") {
      const restored = message as SessionRestoredMessage;
      this.tokenStorage.write(restored.sessionToken);
      this.awaitingReconnectRequestId = null;
      this.sessionRestoreConflictRetries = 0;
      this.clearSessionRestoreRetryTimer();
      this.ready = true;
      this.reconnectAttempt = 0;
      this.updateState({ status: "connected", sessionStatus: "restored", reconnectAttempt: 0, lastError: null });
      if (
        restored.room.phase === "REVEALING" &&
        (restored.room.revealMode === "INDIVIDUAL_DEVICES" || restored.sessionRole === "HOST")
      ) {
        void this.request({ type: "GET_REVEAL_STATE" }).catch(() => {
          this.updateState({ lastError: "Could not refresh the current reveal state." });
        });
      }
    }

    if (message.type === "ROOM_CREATED" || message.type === "ROOM_JOINED") {
      const token = message.sessionToken;
      if (typeof token === "string" && token.length > 0) {
        this.tokenStorage.write(token);
        this.updateState({ status: "connected", sessionStatus: "restored", lastError: null });
      }
    }

    if (message.type === "ERROR") {
      const errorMessage = message as ErrorMessage;
      const pending = typeof errorMessage.requestId === "string"
        ? this.pending.get(errorMessage.requestId)
        : undefined;
      if (pending?.type === "RECONNECT" || errorMessage.requestId === this.awaitingReconnectRequestId) {
        if (errorMessage.error.code === "SESSION_ALREADY_CONNECTED") {
          // A page refresh can race the close event for the old WebSocket.
          // Keep the credential and retry instead of incorrectly expiring it.
          const token = this.tokenStorage.read();
          this.awaitingReconnectRequestId = null;
          if (token) {
            this.scheduleSessionRestoreRetry(token);
            return;
          }
        }
        this.tokenStorage.clear();
        this.awaitingReconnectRequestId = null;
        this.clearSessionRestoreRetryTimer();
        this.ready = true;
        this.updateState({
          status: "session-expired",
          sessionStatus: "expired",
          lastError: "Your previous session could not be restored. Create or join a room to continue.",
        });
      }
    }

    if (typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        this.clearTimer(pending.timeoutId);
        if (message.type === "ERROR") {
          const errorMessage = message as ErrorMessage;
          pending.reject(new Error(errorMessage.error.message));
        } else {
          pending.resolve(message);
        }
      }
    }

    this.options.onMessage?.(message);
    for (const listener of this.listeners) listener(message);
  }

  private scheduleSessionRestoreRetry(token: string): void {
    this.clearSessionRestoreRetryTimer();
    if (this.sessionRestoreConflictRetries >= 5) {
      // Keep the credential so a manual refresh can retry restoration.
      this.ready = true;
      this.updateState({
        status: "session-expired",
        sessionStatus: "restoring",
        lastError: "Your previous connection is still closing. Refresh the page to try restoring again.",
      });
      return;
    }

    const delay = Math.min(250 * 2 ** this.sessionRestoreConflictRetries, 2_000);
    this.sessionRestoreConflictRetries += 1;
    this.ready = false;
    this.updateState({
      status: "reconnecting",
      sessionStatus: "restoring",
      lastError: "Restoring your previous session…",
    });
    this.sessionRestoreRetryTimer = this.setTimer(() => {
      this.sessionRestoreRetryTimer = null;
      if (!this.socket || this.socket.readyState !== OPEN) return;
      const requestId = this.createRequestId();
      this.awaitingReconnectRequestId = requestId;
      try {
        this.socket.send(JSON.stringify({ type: "RECONNECT", requestId, sessionToken: token }));
      } catch {
        this.scheduleSessionRestoreRetry(token);
      }
    }, delay);
  }

  private clearSessionRestoreRetryTimer(): void {
    if (this.sessionRestoreRetryTimer !== null) {
      this.clearTimer(this.sessionRestoreRetryTimer);
      this.sessionRestoreRetryTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.intentionalClose) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.updateState({ status: "disconnected", lastError: reason });
      return;
    }
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    this.updateState({ status: "reconnecting", reconnectAttempt: this.reconnectAttempt, lastError: reason });
    this.clearRetryTimer();
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (!this.intentionalClose) this.openSocket(true);
    }, delay);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.clearTimer(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private updateState(patch: Partial<ConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onStateChange?.(this.state);
  }
}
