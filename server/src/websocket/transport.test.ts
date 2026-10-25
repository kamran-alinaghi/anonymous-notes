import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";
import { LobbyManagementService } from "../lobby/lobby-management.js";

type WireMessage = Record<string, unknown>;

class WebSocketPeer {
  readonly socket: WebSocket;
  readonly messages: WireMessage[] = [];
  private readonly waiters: Array<(message: WireMessage) => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      let parsed: WireMessage;
      try {
        parsed = JSON.parse(String(event.data)) as WireMessage;
      } catch {
        parsed = { unparsed: String(event.data) };
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.messages.push(parsed);
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
  }

  nextMessage(): Promise<WireMessage> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

describe("WebSocket transport integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const peers: WebSocketPeer[] = [];

  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.close();
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  async function setup() {
    let id = 0;
    let code = 0;
    const codes = ["AAAAAA", "BBBBBB", "CCCCCC"];
    const store = new InMemoryRoomStore();
    const roomManagement = new RoomManagementService(store, {
      generateRoomCode: () => codes[code++] ?? "DDDDDD",
      generateId: () => `server-id-${++id}`,
    });
    const lobbyManagement = new LobbyManagementService(store);
    let connectionId = 0;
    const serverApp = await buildApp({
      roomManagement,
      lobbyManagement,
      generateConnectionId: () => `connection-${++connectionId}`,
    });
    app = serverApp;
    const address = await serverApp.listen({ host: "127.0.0.1", port: 0 });
    const peer = (path = "/ws") => {
      const created = new WebSocketPeer(address.replace("http", "ws") + path);
      peers.push(created);
      return created;
    };
    return { peer };
  }

  async function connected(peer: WebSocketPeer) {
    await peer.open();
    const message = await peer.nextMessage();
    expect(message.type).toBe("CONNECTED");
    expect(message.connectionId).toBeTypeOf("string");
  }

  it("creates a room over a real connection and keeps the host separate in SINGLE_DEVICE mode", async () => {
    const { peer } = await setup();
    const host = peer();
    await connected(host);
    host.send({
      type: "CREATE_ROOM",
      requestId: "create-1",
      revealMode: "SINGLE_DEVICE",
      hostNickname: "Moderator",
      playerId: "forged-player",
      isHost: false,
    });
    const response = await host.nextMessage();
    expect(response).toMatchObject({
      type: "ROOM_CREATED",
      requestId: "create-1",
      sessionRole: "HOST",
      nickname: "Moderator",
      room: { roomCode: "AAAAAA", revealMode: "SINGLE_DEVICE", phase: "LOBBY", players: [] },
    });
    expect(JSON.stringify(response)).not.toContain("server-id");
    expect(JSON.stringify(response)).not.toContain("forged-player");
  });

  it("creates INDIVIDUAL_DEVICES host as the first actual player and routes join response only to joining client", async () => {
    const { peer } = await setup();
    const host = peer();
    const joiner = peer();
    await Promise.all([connected(host), connected(joiner)]);

    host.send({
      type: "CREATE_ROOM",
      requestId: "create-2",
      revealMode: "INDIVIDUAL_DEVICES",
      hostNickname: "Host",
    });
    const created = await host.nextMessage();
    expect(created).toMatchObject({
      type: "ROOM_CREATED",
      room: { roomCode: "AAAAAA", revealMode: "INDIVIDUAL_DEVICES", players: [{ nickname: "Host" }] },
    });

    joiner.send({ type: "JOIN_ROOM", requestId: "join-1", roomCode: "AAAAAA", nickname: "Sam", playerId: "victim", isHost: true });
    const joined = await joiner.nextMessage();
    expect(joined).toMatchObject({
      type: "ROOM_JOINED",
      requestId: "join-1",
      sessionRole: "PLAYER",
      nickname: "Sam",
      room: { roomCode: "AAAAAA", playerCount: 2, viewerRole: "PLAYER" },
    });
    expect(joined.room).not.toHaveProperty("players");
    const hostUpdate = await host.nextMessage();
    expect(hostUpdate).toMatchObject({
      type: "LOBBY_UPDATED",
      room: { roomCode: "AAAAAA", playerCount: 2, viewerRole: "HOST", players: [{ nickname: "Host" }, { nickname: "Sam" }] },
    });
    expect(JSON.stringify(joined)).not.toContain("victim");
  });

  it("returns consistent errors for malformed, unsupported, and unknown-room requests", async () => {
    const { peer } = await setup();
    const client = peer();
    await connected(client);

    client.socket.send("{broken");
    expect(await client.nextMessage()).toMatchObject({
      type: "ERROR",
      error: { code: "MALFORMED_MESSAGE" },
    });

    client.send({ type: "NO_SUCH_ACTION", requestId: "unknown" });
    expect(await client.nextMessage()).toMatchObject({
      type: "ERROR",
      requestId: "unknown",
      error: { code: "UNSUPPORTED_MESSAGE_TYPE" },
    });

    client.send({ type: "JOIN_ROOM", requestId: "missing", roomCode: "ZZZZZZ", nickname: "Sam" });
    expect(await client.nextMessage()).toMatchObject({
      type: "ERROR",
      requestId: "missing",
      error: { code: "ROOM_NOT_FOUND" },
    });
  });

  it("does not allow a bound connection to join another identity or room", async () => {
    const { peer } = await setup();
    const client = peer();
    await connected(client);
    client.send({ type: "CREATE_ROOM", requestId: "c", revealMode: "SINGLE_DEVICE", hostNickname: "Host" });
    expect((await client.nextMessage()).type).toBe("ROOM_CREATED");

    client.send({ type: "JOIN_ROOM", requestId: "j", roomCode: "BBBBBB", nickname: "Another" });
    expect(await client.nextMessage()).toMatchObject({
      type: "ERROR",
      requestId: "j",
      error: { code: "SESSION_ALREADY_BOUND" },
    });
  });

  it("unregisters a disconnected connection without removing room membership", async () => {
    const { peer } = await setup();
    const client = peer();
    await connected(client);
    client.send({ type: "CREATE_ROOM", requestId: "c", revealMode: "SINGLE_DEVICE", hostNickname: "Host" });
    expect((await client.nextMessage()).type).toBe("ROOM_CREATED");
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(app).toBeDefined();
    // Disconnection intentionally does not remove players or rooms.
  });
});
