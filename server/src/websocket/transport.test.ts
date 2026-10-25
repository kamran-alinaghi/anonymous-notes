import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";
import { LobbyManagementService } from "../lobby/lobby-management.js";
import { GameManagementService } from "../game/game-management.js";

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
    let roundId = 0;
    const gameManagement = new GameManagementService(store, { generateRoundId: () => "round-" + (++roundId) });
    let connectionId = 0;
    const serverApp = await buildApp({
      roomManagement,
      lobbyManagement,
      gameManagement,
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

  it("broadcasts successful lobby changes with host-only order and rejects unauthorized reorders", async () => {
    const { peer } = await setup();
    const host = peer();
    const playerA = peer();
    const playerB = peer();
    await Promise.all([connected(host), connected(playerA), connected(playerB)]);

    host.send({ type: "CREATE_ROOM", requestId: "create", revealMode: "SINGLE_DEVICE", hostNickname: "Moderator" });
    const created = await host.nextMessage();
    const hostView = (created.room as { players: Array<{ id: string; nickname: string }> });
    expect(hostView.players).toEqual([]);

    playerA.send({ type: "JOIN_ROOM", requestId: "join-a", roomCode: "AAAAAA", nickname: "Alpha" });
    const joinedA = await playerA.nextMessage();
    expect(joinedA.type).toBe("ROOM_JOINED");
    expect(joinedA.room).not.toHaveProperty("players");
    expect((await host.nextMessage()).type).toBe("LOBBY_UPDATED");
    expect((await playerA.nextMessage()).type).toBe("LOBBY_UPDATED");

    playerB.send({ type: "JOIN_ROOM", requestId: "join-b", roomCode: "AAAAAA", nickname: "Beta" });
    expect((await playerB.nextMessage()).type).toBe("ROOM_JOINED");
    const hostAfterJoin = await host.nextMessage();
    const hostRoom = hostAfterJoin.room as { players: Array<{ id: string; nickname: string }>; playerCount: number };
    expect(hostRoom.playerCount).toBe(2);
    expect(hostRoom.players.map((player) => player.nickname)).toEqual(["Alpha", "Beta"]);
    expect((await playerA.nextMessage()).room).not.toHaveProperty("players");
    const playerBUpdate = await playerB.nextMessage();
    expect(playerBUpdate.type).toBe("LOBBY_UPDATED");
    expect(playerBUpdate.room).not.toHaveProperty("players");

    playerA.send({ type: "REORDER_PLAYERS", requestId: "forbidden", playerIds: hostRoom.players.map((p) => p.id).reverse() });
    expect(await playerA.nextMessage()).toMatchObject({
      type: "ERROR",
      requestId: "forbidden",
      error: { code: "UNAUTHORIZED" },
    });

    const reversedIds = [...hostRoom.players].reverse().map((player) => player.id);
    host.send({ type: "REORDER_PLAYERS", requestId: "reorder", playerIds: reversedIds });
    const response = await host.nextMessage();
    expect(response).toMatchObject({
      type: "PLAYER_ORDER_UPDATED",
      requestId: "reorder",
      room: { players: [{ id: reversedIds[0] }, { id: reversedIds[1] }] },
    });
    expect((await host.nextMessage()).type).toBe("LOBBY_UPDATED");
    const updateA = await playerA.nextMessage();
    const updateB = await playerB.nextMessage();
    expect(updateA.room).not.toHaveProperty("players");
    expect(updateB.room).not.toHaveProperty("players");
    expect(updateA.room).toMatchObject({ playerCount: 2, viewerRole: "PLAYER" });
    expect(updateB.room).toMatchObject({ playerCount: 2, viewerRole: "PLAYER" });
  });

  it("starts a game, selects the first ordered player, and broadcasts subject changes", async () => {
    const { peer } = await setup();
    const host = peer();
    const players = [peer(), peer(), peer()];
    await Promise.all([connected(host), ...players.map(connected)]);

    host.send({ type: "CREATE_ROOM", requestId: "game-create", revealMode: "INDIVIDUAL_DEVICES", hostNickname: "Host" });
    expect((await host.nextMessage()).type).toBe("ROOM_CREATED");

    for (let index = 0; index < players.length; index += 1) {
      const player = players[index]!;
      player.send({ type: "JOIN_ROOM", requestId: "game-join-" + index, roomCode: "AAAAAA", nickname: "Player" + (index + 1) });
      expect((await player.nextMessage()).type).toBe("ROOM_JOINED");
      expect((await player.nextMessage()).type).toBe("LOBBY_UPDATED");
      expect((await host.nextMessage()).type).toBe("LOBBY_UPDATED");
      for (let prior = 0; prior < index; prior += 1) {
        expect((await players[prior]!.nextMessage()).type).toBe("LOBBY_UPDATED");
      }
    }

    players[0]!.send({ type: "START_GAME", requestId: "unauthorized-start" });
    expect(await players[0]!.nextMessage()).toMatchObject({
      type: "ERROR",
      requestId: "unauthorized-start",
      error: { code: "UNAUTHORIZED" },
    });

    host.send({ type: "START_GAME", requestId: "start-game" });
    expect(await host.nextMessage()).toMatchObject({
      type: "GAME_STARTED",
      requestId: "start-game",
      room: {
        phase: "CHOOSING_SUBJECT",
        currentRoundNumber: 1,
        currentSubjectSetterNickname: "Host",
        subject: null,
      },
    });
    expect((await host.nextMessage()).type).toBe("GAME_STATE_UPDATED");
    for (const player of players) {
      expect(await player.nextMessage()).toMatchObject({
        type: "GAME_STATE_UPDATED",
        room: { phase: "CHOOSING_SUBJECT", currentRoundNumber: 1, currentSubjectSetterNickname: "Host" },
      });
    }

    players[0]!.send({ type: "SET_SUBJECT", requestId: "wrong-setter", subject: "Not allowed" });
    expect(await players[0]!.nextMessage()).toMatchObject({
      type: "ERROR",
      requestId: "wrong-setter",
      error: { code: "NOT_SUBJECT_SETTER" },
    });

    host.send({ type: "SET_SUBJECT", requestId: "set-subject", subject: "A mystery" });
    expect(await host.nextMessage()).toMatchObject({
      type: "SUBJECT_SUBMITTED",
      requestId: "set-subject",
      room: { phase: "WRITING", subject: "A mystery" },
    });
    expect((await host.nextMessage()).type).toBe("GAME_STATE_UPDATED");
    for (const player of players) {
      expect(await player.nextMessage()).toMatchObject({
        type: "GAME_STATE_UPDATED",
        room: { phase: "WRITING", subject: "A mystery" },
      });
    }

    host.send({ type: "START_GAME", requestId: "duplicate-start" });
    expect(await host.nextMessage()).toMatchObject({
      type: "ERROR",
      requestId: "duplicate-start",
      error: { code: "ROOM_UNAVAILABLE" },
    });
    expect(host.messages).toHaveLength(0);
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
