import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionTokenStorage } from "./session-token-storage";
import { WebSocketClient, type WebSocketLike } from "./websocket-client";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private readonly handlers = new Map<string, Set<(event: any) => void>>();

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("Socket is not open");
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void {
    const listeners = this.handlers.get(type) ?? new Set();
    listeners.add(listener);
    this.handlers.set(type, listeners);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void {
    this.handlers.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.handlers.get(type) ?? []) listener(event);
  }
}

function createTokenStorage(initialToken: string | null = null): SessionTokenStorage & { token: string | null } {
  return {
    token: initialToken,
    read() {
      return this.token;
    },
    write(token) {
      this.token = token;
    },
    clear() {
      this.token = null;
    },
  };
}

function setup(initialToken: string | null = null) {
  const sockets: FakeWebSocket[] = [];
  const tokenStorage = createTokenStorage(initialToken);
  let nextRequestId = 0;
  const client = new WebSocketClient({
    url: "ws://localhost:3000/ws",
    createSocket: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    tokenStorage,
    createRequestId: () => "request-" + ++nextRequestId,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 400,
    maxReconnectAttempts: 2,
  });
  return { client, sockets, tokenStorage };
}

function handshake(socket: FakeWebSocket): void {
  socket.open();
  socket.receive({ type: "CONNECTED", connectionId: "connection-1" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WebSocketClient", () => {
  it("waits for the server handshake before becoming ready", () => {
    const { client, sockets } = setup();

    client.connect();

    expect(client.state.status).toBe("connecting");
    expect(client.isReady).toBe(false);

    handshake(sockets[0]!);

    expect(client.state.status).toBe("connected");
    expect(client.state.sessionStatus).toBe("none");
    expect(client.isReady).toBe(true);
  });

  it("correlates requests by requestId and stores server-issued session tokens", async () => {
    const { client, sockets, tokenStorage } = setup();
    client.connect();
    handshake(sockets[0]!);

    const responsePromise = client.request({
      type: "CREATE_ROOM",
      revealMode: "SINGLE_DEVICE",
      hostNickname: "Host",
    });
    const sent = JSON.parse(sockets[0]!.sent[0]!) as { requestId: string };
    sockets[0]!.receive({
      type: "ROOM_CREATED",
      requestId: sent.requestId,
      sessionToken: "server-issued-token",
      sessionRole: "HOST",
      nickname: "Host",
      room: {
        roomCode: "ABCDEF",
        revealMode: "SINGLE_DEVICE",
        phase: "LOBBY",
        hostNickname: "Host",
        playerCount: 0,
        viewerRole: "HOST",
        players: [],
      },
    });

    await expect(responsePromise).resolves.toMatchObject({ type: "ROOM_CREATED" });
    expect(tokenStorage.read()).toBe("server-issued-token");
    expect(client.state.sessionStatus).toBe("restored");
  });

  it("attempts session restoration before allowing room actions and rotates the token", () => {
    const { client, sockets, tokenStorage } = setup("old-token");
    client.connect();
    const socket = sockets[0]!;
    handshake(socket);

    expect(client.isReady).toBe(false);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "RECONNECT",
      sessionToken: "old-token",
    });
    const reconnectRequestId = (JSON.parse(socket.sent[0]!) as { requestId: string }).requestId;

    socket.receive({
      type: "SESSION_RESTORED",
      requestId: reconnectRequestId,
      sessionRole: "PLAYER",
      nickname: "Player",
      sessionToken: "rotated-token",
      room: {
        roomCode: "ABCDEF",
        revealMode: "INDIVIDUAL_DEVICES",
        phase: "WRITING",
        hostNickname: "Host",
        playerCount: 2,
        players: [{ id: "p1", nickname: "Player" }],
        currentRoundNumber: 1,
        currentSubjectSetterNickname: "Host",
        subject: "A mystery",
      },
    });

    expect(client.isReady).toBe(true);
    expect(client.state.sessionStatus).toBe("restored");
    expect(tokenStorage.read()).toBe("rotated-token");
  });

  it("clears an invalid reconnect token without creating a new identity", () => {
    const { client, sockets, tokenStorage } = setup("expired-token");
    client.connect();
    const socket = sockets[0]!;
    handshake(socket);
    const reconnect = JSON.parse(socket.sent[0]!) as { requestId: string };

    socket.receive({
      type: "ERROR",
      requestId: reconnect.requestId,
      error: { code: "INVALID_SESSION_CREDENTIAL", message: "Invalid session" },
    });

    expect(tokenStorage.read()).toBeNull();
    expect(client.state.status).toBe("session-expired");
    expect(client.state.sessionStatus).toBe("expired");
    expect(client.isReady).toBe(true);
    expect(socket.sent).toHaveLength(1);
  });

  it("requests personalized reveal state after restoring into the revealing phase", () => {
    const { client, sockets } = setup("old-token");
    client.connect();
    const socket = sockets[0]!;
    handshake(socket);
    const reconnect = JSON.parse(socket.sent[0]!) as { requestId: string };

    socket.receive({
      type: "SESSION_RESTORED",
      requestId: reconnect.requestId,
      sessionRole: "PLAYER",
      nickname: "Player",
      sessionToken: "new-token",
      room: {
        roomCode: "ABCDEF",
        revealMode: "INDIVIDUAL_DEVICES",
        phase: "REVEALING",
        hostNickname: "Host",
        playerCount: 2,
        players: [{ id: "p1", nickname: "Player" }],
        currentRoundNumber: 1,
        currentSubjectSetterNickname: "Host",
        subject: "A mystery",
      },
    });

    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ type: "GET_REVEAL_STATE" });
  });

  it("uses bounded reconnect attempts after a dropped connection", () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.connect();
    handshake(sockets[0]!);

    sockets[0]!.close();
    expect(client.state.status).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1]!.close();
    vi.advanceTimersByTime(200);
    expect(sockets).toHaveLength(3);

    sockets[2]!.close();
    expect(client.state.status).toBe("disconnected");
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);
  });

  it("does not request reveal content for a SINGLE_DEVICE player after reconnect", () => {
    const { client, sockets } = setup("old-token");
    client.connect();
    const socket = sockets[0]!;
    handshake(socket);
    const reconnect = JSON.parse(socket.sent[0]!) as { requestId: string };

    socket.receive({
      type: "SESSION_RESTORED",
      requestId: reconnect.requestId,
      sessionRole: "PLAYER",
      nickname: "Player",
      sessionToken: "new-token",
      room: {
        roomCode: "ABCDEF",
        revealMode: "SINGLE_DEVICE",
        phase: "REVEALING",
        hostNickname: "Host",
        playerCount: 2,
        players: [{ id: "p1", nickname: "Player" }],
        currentRoundNumber: 1,
        currentSubjectSetterNickname: "Host",
        subject: "A mystery",
      },
    });

    expect(socket.sent).toHaveLength(1);
  });
});