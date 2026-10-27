import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";
import { LobbyManagementService } from "../lobby/lobby-management.js";
import { GameManagementService } from "../game/game-management.js";
import { RoundLifecycleService } from "../game/round-lifecycle.js";
import { ConnectionLifecycleService } from "../game/connection-lifecycle.js";
import { NoteSubmissionService } from "../notes/note-submission.js";
import { RevealSessionService } from "../reveal/reveal-session.js";

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

  async closeAndWait(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.addEventListener("close", () => resolve(), { once: true });
      this.socket.close();
      if (this.socket.readyState === WebSocket.CLOSED) resolve();
    });
  }
}

describe("WebSocket transport integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const peers: WebSocketPeer[] = [];

  afterEach(async () => {
    await Promise.all(peers.splice(0).map((peer) => peer.closeAndWait()));
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
    let noteId = 0;
    const noteSubmission = new NoteSubmissionService(store, { generateNoteId: () => "note-" + (++noteId) });
    const revealSession = new RevealSessionService(store);
    const connectionLifecycle = new ConnectionLifecycleService(store);
    const roundLifecycle = new RoundLifecycleService(store, { generateRoundId: () => "lifecycle-round-" + (++roundId) });
    let connectionId = 0;
    const serverApp = await buildApp({
      roomManagement,
      lobbyManagement,
      gameManagement,
      noteSubmission,
      revealSession,
      roundLifecycle,
      connectionLifecycle,
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

  it("accepts private note batches, exposes host-only submission status, and transitions after the final batch", async () => {
    const { peer } = await setup();
    const host = peer();
    const players = [peer(), peer(), peer()];
    const clients = [host, ...players];
    await Promise.all(clients.map(connected));

    host.send({ type: "CREATE_ROOM", requestId: "notes-create", revealMode: "INDIVIDUAL_DEVICES", hostNickname: "Host" });
    expect((await host.nextMessage()).type).toBe("ROOM_CREATED");

    let hostRoom = { players: [] as Array<{ id: string; nickname: string }> };
    for (let index = 0; index < players.length; index += 1) {
      const joining = players[index]!;
      joining.send({ type: "JOIN_ROOM", requestId: "notes-join-" + index, roomCode: "AAAAAA", nickname: "Player" + (index + 1) });
      expect((await joining.nextMessage()).type).toBe("ROOM_JOINED");
      const hostUpdate = await host.nextMessage();
      expect(hostUpdate.type).toBe("LOBBY_UPDATED");
      hostRoom = hostUpdate.room as typeof hostRoom;
      expect((await joining.nextMessage()).type).toBe("LOBBY_UPDATED");
      for (let prior = 0; prior < index; prior += 1) {
        expect((await players[prior]!.nextMessage()).type).toBe("LOBBY_UPDATED");
      }
    }

    host.send({ type: "START_GAME", requestId: "notes-start" });
    expect((await host.nextMessage()).type).toBe("GAME_STARTED");
    expect((await host.nextMessage()).type).toBe("GAME_STATE_UPDATED");
    for (const player of players) expect((await player.nextMessage()).type).toBe("GAME_STATE_UPDATED");

    host.send({ type: "SET_SUBJECT", requestId: "notes-subject", subject: "A mystery" });
    expect((await host.nextMessage()).type).toBe("SUBJECT_SUBMITTED");
    expect((await host.nextMessage()).type).toBe("GAME_STATE_UPDATED");
    for (const player of players) expect((await player.nextMessage()).type).toBe("GAME_STATE_UPDATED");

    const ids = hostRoom.players.map((player) => player.id);
    expect(ids).toHaveLength(4);
    for (const author of hostRoom.players) {
      const authorClient = author.id === hostRoom.players[0]?.id ? host : players.find((_, index) => hostRoom.players[index + 1]?.id === author.id)!;
      const notes = hostRoom.players
        .filter((target) => target.id !== author.id)
        .map((target) => ({ targetPlayerId: target.id, content: "private note from " + author.nickname }));
      authorClient.send({ type: "SUBMIT_NOTE_BATCH", requestId: "batch-" + author.id, notes });
      const accepted = await authorClient.nextMessage();
      expect(accepted).toMatchObject({
        type: "NOTE_BATCH_ACCEPTED",
        requestId: "batch-" + author.id,
        submittedNotes: 3,
      });
      expect(JSON.stringify(accepted)).not.toContain("private note");
      if (author.id === hostRoom.players[0]?.id) {
        expect(accepted.progress).toHaveProperty("players");
      } else {
        expect(accepted.progress).not.toHaveProperty("players");
      }

      for (const client of clients) {
        const update = await client.nextMessage();
        expect(update.type).toBe("SUBMISSION_PROGRESS_UPDATED");
        expect(JSON.stringify(update)).not.toContain("private note");
        if (client === host) {
          expect(update.progress).toHaveProperty("players");
        } else {
          expect(update.progress).not.toHaveProperty("players");
        }
      }
      if (author.id === hostRoom.players[hostRoom.players.length - 1]?.id) {
        expect(accepted.progress).toMatchObject({ phase: "REVEALING", submittedCount: 4, totalPlayerCount: 4 });

        const initialStates = await Promise.all(clients.map((client) => client.nextMessage()));
        expect(initialStates.every((message) => message.type === "REVEAL_STATE_UPDATED")).toBe(true);
        expect(initialStates.filter((message) => Object.hasOwn(message.state as object, "displayNote"))).toHaveLength(1);
        for (const message of initialStates) {
          expect(JSON.stringify(message)).not.toContain("authorPlayerId");
          expect(JSON.stringify(message)).not.toContain("targetPlayerId");
        }

        players[0]!.send({ type: "NAVIGATE_REVEAL", requestId: "player-navigation", action: "NEXT" });
        expect(await players[0]!.nextMessage()).toMatchObject({
          type: "ERROR",
          requestId: "player-navigation",
          error: { code: "UNAUTHORIZED" },
        });

        host.send({ type: "NAVIGATE_REVEAL", requestId: "host-next", action: "NEXT", position: 99 });
        expect(await host.nextMessage()).toMatchObject({
          type: "REVEAL_NAVIGATED",
          requestId: "host-next",
          position: 1,
          total: 12,
        });
        const nextStates = await Promise.all(clients.map((client) => client.nextMessage()));
        expect(nextStates.every((message) => message.type === "REVEAL_STATE_UPDATED")).toBe(true);
        expect(nextStates.every((message) => (message.state as { position: number }).position === 1)).toBe(true);
        expect(nextStates.filter((message) => Object.hasOwn(message.state as object, "displayNote"))).toHaveLength(1);

        host.send({ type: "COMPLETE_ROUND", requestId: "premature-complete" });
        expect(await host.nextMessage()).toMatchObject({
          type: "ERROR",
          requestId: "premature-complete",
          error: { code: "ROUND_NOT_COMPLETE" },
        });

        for (let position = 2; position < 12; position += 1) {
          host.send({ type: "NAVIGATE_REVEAL", requestId: "advance-" + position, action: "NEXT" });
          expect(await host.nextMessage()).toMatchObject({
            type: "REVEAL_NAVIGATED",
            requestId: "advance-" + position,
            position,
            total: 12,
          });
          const states = await Promise.all(clients.map((client) => client.nextMessage()));
          expect(states.every((message) => message.type === "REVEAL_STATE_UPDATED")).toBe(true);
          expect(states.every((message) => (message.state as { position: number }).position === position)).toBe(true);
        }

        players[0]!.send({ type: "COMPLETE_ROUND", requestId: "unauthorized-complete" });
        expect(await players[0]!.nextMessage()).toMatchObject({
          type: "ERROR",
          requestId: "unauthorized-complete",
          error: { code: "UNAUTHORIZED" },
        });

        host.send({ type: "COMPLETE_ROUND", requestId: "complete-round" });
        expect(await host.nextMessage()).toMatchObject({
          type: "ROUND_COMPLETED",
          requestId: "complete-round",
          room: { phase: "ROUND_COMPLETE", currentRoundNumber: 1 },
        });
        const completedUpdates = await Promise.all(clients.map((client) => client.nextMessage()));
        expect(completedUpdates.every((message) => message.type === "GAME_STATE_UPDATED")).toBe(true);
        expect(completedUpdates.every((message) => (message.room as { phase: string }).phase === "ROUND_COMPLETE")).toBe(true);

        host.send({ type: "COMPLETE_ROUND", requestId: "duplicate-complete" });
        expect(await host.nextMessage()).toMatchObject({
          type: "ERROR",
          requestId: "duplicate-complete",
          error: { code: "ROOM_UNAVAILABLE" },
        });

        host.send({ type: "START_NEXT_ROUND", requestId: "next-round" });
        expect(await host.nextMessage()).toMatchObject({
          type: "NEXT_ROUND_STARTED",
          requestId: "next-round",
          room: {
            phase: "CHOOSING_SUBJECT",
            currentRoundNumber: 2,
            currentSubjectSetterNickname: "Player1",
            subject: null,
          },
        });
        const nextRoundUpdates = await Promise.all(clients.map((client) => client.nextMessage()));
        expect(nextRoundUpdates.every((message) => message.type === "GAME_STATE_UPDATED")).toBe(true);
        expect(nextRoundUpdates.every((message) => (message.room as { phase: string }).phase === "CHOOSING_SUBJECT")).toBe(true);
      }
    }
  });

  it("includes the safe player list in game views for both reveal modes and all room members", async () => {
    const { peer } = await setup();
    const singleHost = peer();
    const singlePlayers = [peer(), peer(), peer(), peer()];
    const individualHost = peer();
    const individualPlayers = [peer(), peer(), peer()];
    const allPeers = [singleHost, ...singlePlayers, individualHost, ...individualPlayers];
    await Promise.all(allPeers.map(connected));

    async function createAndFillRoom(
      host: WebSocketPeer,
      players: WebSocketPeer[],
      revealMode: "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES",
      roomCode: string,
      hostNickname: string,
      playerNicknames: string[],
    ) {
      host.send({ type: "CREATE_ROOM", requestId: roomCode + "-create", revealMode, hostNickname });
      expect((await host.nextMessage()).type).toBe("ROOM_CREATED");
      const members = [host];
      for (let index = 0; index < players.length; index += 1) {
        const player = players[index]!;
        player.send({
          type: "JOIN_ROOM",
          requestId: roomCode + "-join-" + index,
          roomCode,
          nickname: playerNicknames[index]!,
        });
        expect((await player.nextMessage()).type).toBe("ROOM_JOINED");
        expect((await player.nextMessage()).type).toBe("LOBBY_UPDATED");
        await Promise.all(members.map((member) => member.nextMessage()));
        members.push(player);
      }
      return members;
    }

    const singleMembers = await createAndFillRoom(
      singleHost, singlePlayers, "SINGLE_DEVICE", "AAAAAA", "Moderator",
      ["Alpha", "Bravo", "Charlie", "Delta"],
    );
    const individualMembers = await createAndFillRoom(
      individualHost, individualPlayers, "INDIVIDUAL_DEVICES", "BBBBBB", "HostPlayer",
      ["Echo", "Foxtrot", "Golf"],
    );

    singleHost.send({ type: "START_GAME", requestId: "single-start" });
    const singleStarted = await singleHost.nextMessage();
    expect(singleStarted).toMatchObject({
      type: "GAME_STARTED",
      requestId: "single-start",
      room: {
        revealMode: "SINGLE_DEVICE",
        playerCount: 4,
        players: [
          { nickname: "Alpha" },
          { nickname: "Bravo" },
          { nickname: "Charlie" },
          { nickname: "Delta" },
        ],
      },
    });
    expect((singleStarted.room as { players: Array<Record<string, unknown>> }).players.every(
      (player) => Object.keys(player).sort().join(",") === "id,nickname",
    )).toBe(true);
    await Promise.all(singleMembers.map(async (member) => {
      const update = await member.nextMessage();
      expect(update.type).toBe("GAME_STATE_UPDATED");
      expect((update.room as { players: Array<{ id: string; nickname: string }> }).players).toHaveLength(4);
    }));

    individualHost.send({ type: "START_GAME", requestId: "individual-start" });
    const individualStarted = await individualHost.nextMessage();
    expect(individualStarted).toMatchObject({
      type: "GAME_STARTED",
      requestId: "individual-start",
      room: {
        revealMode: "INDIVIDUAL_DEVICES",
        playerCount: 4,
        players: [
          { nickname: "HostPlayer" },
          { nickname: "Echo" },
          { nickname: "Foxtrot" },
          { nickname: "Golf" },
        ],
      },
    });
    expect((individualStarted.room as { players: Array<Record<string, unknown>> }).players.every(
      (player) => Object.keys(player).sort().join(",") === "id,nickname",
    )).toBe(true);
    await Promise.all(individualMembers.map(async (member) => {
      const update = await member.nextMessage();
      expect(update.type).toBe("GAME_STATE_UPDATED");
      expect((update.room as { players: Array<{ id: string; nickname: string }> }).players).toHaveLength(4);
    }));
  });

  it("restores a session when the replacement socket arrives before the old socket closes", async () => {
    const { peer } = await setup();
    const original = peer();
    await connected(original);
    original.send({
      type: "CREATE_ROOM",
      requestId: "create-before-refresh",
      revealMode: "SINGLE_DEVICE",
      hostNickname: "Host",
    });
    const created = await original.nextMessage();
    expect(created).toMatchObject({ type: "ROOM_CREATED", room: { roomCode: "AAAAAA" } });
    const token = created.sessionToken;
    expect(token).toBeTypeOf("string");

    const replacement = peer();
    await connected(replacement);
    replacement.send({
      type: "RECONNECT",
      requestId: "restore-after-refresh",
      sessionToken: token,
    });

    expect(await replacement.nextMessage()).toMatchObject({
      type: "SESSION_RESTORED",
      requestId: "restore-after-refresh",
      sessionRole: "HOST",
      nickname: "Host",
      room: { roomCode: "AAAAAA", phase: "LOBBY" },
    });
    expect(await replacement.nextMessage()).toMatchObject({
      type: "LOBBY_UPDATED",
      room: { roomCode: "AAAAAA", viewerRole: "HOST" },
    });
  });

  it("restores a returning player after the game has started", async () => {
    const { peer } = await setup();
    const host = peer();
    const players = [peer(), peer(), peer()];
    await Promise.all([host, ...players].map(connected));

    host.send({
      type: "CREATE_ROOM",
      requestId: "create-started-room",
      revealMode: "INDIVIDUAL_DEVICES",
      hostNickname: "Host",
    });
    expect((await host.nextMessage()).type).toBe("ROOM_CREATED");

    const members = [host];
    let returningPlayerToken: unknown;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index]!;
      player.send({
        type: "JOIN_ROOM",
        requestId: "join-started-" + index,
        roomCode: "AAAAAA",
        nickname: "Player" + index,
      });
      const joined = await player.nextMessage();
      expect(joined.type).toBe("ROOM_JOINED");
      if (index === 0) returningPlayerToken = joined.sessionToken;
      expect((await player.nextMessage()).type).toBe("LOBBY_UPDATED");
      await Promise.all(members.map(async (member) => {
        expect((await member.nextMessage()).type).toBe("LOBBY_UPDATED");
      }));
      members.push(player);
    }

    host.send({ type: "START_GAME", requestId: "start-before-refresh" });
    expect((await host.nextMessage()).type).toBe("GAME_STARTED");
    await Promise.all(members.map(async (member) => {
      expect((await member.nextMessage()).type).toBe("GAME_STATE_UPDATED");
    }));

    const replacement = peer();
    await connected(replacement);
    replacement.send({
      type: "RECONNECT",
      requestId: "restore-started-player",
      sessionToken: returningPlayerToken,
    });

    expect(await replacement.nextMessage()).toMatchObject({
      type: "SESSION_RESTORED",
      requestId: "restore-started-player",
      sessionRole: "PLAYER",
      nickname: "Player0",
      room: { roomCode: "AAAAAA", phase: "CHOOSING_SUBJECT" },
    });
    expect(await replacement.nextMessage()).toMatchObject({
      type: "GAME_STATE_UPDATED",
      room: { roomCode: "AAAAAA", phase: "CHOOSING_SUBJECT" },
    });
  });

  it("unregisters a disconnected connection without removing room membership", async () => {
    const { peer } = await setup();
    const client = peer();
    await connected(client);
    client.send({ type: "CREATE_ROOM", requestId: "c", revealMode: "SINGLE_DEVICE", hostNickname: "Host" });
    expect((await client.nextMessage()).type).toBe("ROOM_CREATED");
    await client.closeAndWait();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(app).toBeDefined();
    // Disconnection intentionally does not remove players or rooms.
  });
});
