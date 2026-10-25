import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ConnectionLifecycleService } from "../game/connection-lifecycle.js";
import { GameManagementService } from "../game/game-management.js";
import { RoundLifecycleService } from "../game/round-lifecycle.js";
import { LobbyManagementService } from "../lobby/lobby-management.js";
import { NoteSubmissionService } from "../notes/note-submission.js";
import { RevealSessionService } from "../reveal/reveal-session.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";

type Message = Record<string, any>;
type RevealMode = "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES";

class Peer {
  readonly socket: WebSocket;
  private readonly queue: Message[] = [];
  private readonly waiters: Array<(message: Message) => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async nextMatching(predicate: (message: Message) => boolean): Promise<Message> {
    for (;;) {
      const index = this.queue.findIndex(predicate);
      if (index >= 0) return this.queue.splice(index, 1)[0]!;
      const message = await new Promise<Message>((resolve) => this.waiters.push(resolve));
      if (predicate(message)) return message;
      this.queue.push(message);
    }
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

describe("Anonymous Note disconnection and reconnection lifecycle", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const peers: Peer[] = [];

  afterEach(async () => {
    await Promise.all(peers.splice(0).map((peer) => peer.closeAndWait()));
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  async function setup() {
    let id = 0;
    let connectionId = 0;
    let tokenId = 0;
    const store = new InMemoryRoomStore();
    const roomManagement = new RoomManagementService(store, {
      generateRoomCode: () => "EAEAAA",
      generateId: () => `lifecycle-id-${++id}`,
    });
    const connectionLifecycle = new ConnectionLifecycleService(store);
    const serverApp = await buildApp({
      roomManagement,
      lobbyManagement: new LobbyManagementService(store),
      gameManagement: new GameManagementService(store, { generateRoundId: () => `round-${++id}` }),
      noteSubmission: new NoteSubmissionService(store, { generateNoteId: () => `note-${++id}` }),
      revealSession: new RevealSessionService(store),
      roundLifecycle: new RoundLifecycleService(store, { generateRoundId: () => `next-round-${++id}` }),
      connectionLifecycle,
      generateConnectionId: () => `connection-${++connectionId}`,
      generateSessionToken: () => `session-token-${String(++tokenId).padStart(40, "0")}`,
    });
    app = serverApp;
    const address = await serverApp.listen({ host: "127.0.0.1", port: 0 });
    const peer = () => {
      const created = new Peer(address.replace("http", "ws") + "/ws");
      peers.push(created);
      return created;
    };
    return { peer, store };
  }

  async function connect(peer: Peer): Promise<void> {
    await peer.open();
    await peer.nextMatching((message) => message.type === "CONNECTED");
  }

  async function message(peer: Peer, type: string, requestId?: string): Promise<Message> {
    return peer.nextMatching((item) =>
      item.type === type && (requestId === undefined || item.requestId === requestId));
  }

  it.each(["SINGLE_DEVICE", "INDIVIDUAL_DEVICES"] as const)(
    "recovers safely across writing and reveal in %s mode and supports host termination",
    async (mode: RevealMode) => {
      const { peer, store } = await setup();
      const host = peer();
      const joiningPeers = Array.from({ length: mode === "SINGLE_DEVICE" ? 4 : 3 }, () => peer());
      await Promise.all([host, ...joiningPeers].map(connect));

      host.send({ type: "CREATE_ROOM", requestId: "create", revealMode: mode, hostNickname: "Host" });
      const created = await message(host, "ROOM_CREATED", "create");
      const tokens = new Map<string, string>([["Host", created.sessionToken]]);
      const clients = new Map<string, Peer>([["Host", host]]);

      for (let index = 0; index < joiningPeers.length; index += 1) {
        const joining = joiningPeers[index]!;
        const nickname = `Player${index + 1}`;
        joining.send({ type: "JOIN_ROOM", requestId: `join-${index}`, roomCode: "EAEAAA", nickname });
        const joined = await message(joining, "ROOM_JOINED", `join-${index}`);
        tokens.set(nickname, joined.sessionToken);
        clients.set(nickname, joining);
      }

      let room = store.getByCode("EAEAAA")!;
      const actualPlayers = room.players;
      const setter = actualPlayers[0]!;
      const setterClient = clients.get(setter.nickname)!;
      host.send({ type: "START_GAME", requestId: "start" });
      await message(host, "GAME_STARTED", "start");
      expect(store.getByCode("EAEAAA")?.phase).toBe("CHOOSING_SUBJECT");

      // Two simultaneous disconnects pause subject selection and identify both players.
      const choosingDisconnects = actualPlayers.slice(1, 3);
      for (const player of choosingDisconnects) await clients.get(player.nickname)!.closeAndWait();
      const waiting = await host.nextMatching((item) =>
        item.type === "WAITING_FOR_PLAYERS" &&
        Array.isArray(item.disconnectedPlayers) && item.disconnectedPlayers.length === 2);
      expect(waiting.disconnectedPlayers.map((item: { nickname: string }) => item.nickname).sort())
        .toEqual(choosingDisconnects.map((player) => player.nickname).sort());
      setterClient.send({ type: "SET_SUBJECT", requestId: "blocked-subject", subject: "A subject" });
      await expect(message(setterClient, "ERROR", "blocked-subject")).resolves.toMatchObject({
        error: { code: "GAME_PAUSED" },
      });

      // Reconnect one at a time; the game must remain paused until the second player returns.
      for (let index = 0; index < choosingDisconnects.length; index += 1) {
        const player = choosingDisconnects[index]!;
        const restoredPeer = peer();
        await connect(restoredPeer);
        restoredPeer.send({ type: "RECONNECT", requestId: `reconnect-choosing-${index}`, sessionToken: tokens.get(player.nickname) });
        const restored = await message(restoredPeer, "SESSION_RESTORED", `reconnect-choosing-${index}`);
        expect(restored.nickname).toBe(player.nickname);
        clients.set(player.nickname, restoredPeer);
        tokens.set(player.nickname, restored.sessionToken);
        if (index === 0) {
          await host.nextMatching((item) =>
            item.type === "WAITING_FOR_PLAYERS" &&
            Array.isArray(item.disconnectedPlayers) && item.disconnectedPlayers.length === 1);
          expect(store.getByCode("EAEAAA")?.pausedPhase).toBe("CHOOSING_SUBJECT");

          const replay = peer();
          await connect(replay);
          replay.send({ type: "RECONNECT", requestId: "replay-old-token", sessionToken: created.sessionToken });
          await expect(message(replay, "ERROR", "replay-old-token")).resolves.toMatchObject({
            error: { code: "INVALID_SESSION_CREDENTIAL" },
          });
        }
      }
      await host.nextMatching((item) => item.type === "GAME_RESUMED");
      expect(store.getByCode("EAEAAA")?.pausedPhase).toBeNull();
      expect(store.getByCode("EAEAAA")?.phase).toBe("CHOOSING_SUBJECT");

      setterClient.send({ type: "SET_SUBJECT", requestId: "subject", subject: "A subject" });
      await message(setterClient, "SUBJECT_SUBMITTED", "subject");
      expect(store.getByCode("EAEAAA")?.phase).toBe("WRITING");

      // WRITING remains active, but the disconnected player is not counted as submitted.
      room = store.getByCode("EAEAAA")!;
      const writingDisconnect = room.players[room.players.length - 1]!;
      await clients.get(writingDisconnect.nickname)!.closeAndWait();
      await host.nextMatching((item) =>
        item.type === "PLAYER_CONNECTIONS_UPDATED" && item.paused === false &&
        item.disconnectedPlayers.some((player: { playerId: string }) => player.playerId === writingDisconnect.id));

      const firstAuthor = room.players.find((player) => player.id !== writingDisconnect.id)!;
      const firstAuthorClient = clients.get(firstAuthor.nickname)!;
      const draftsFor = (authorId: string) => room.players
        .filter((player) => player.id !== authorId)
        .map((player) => ({ targetPlayerId: player.id, content: `note-from-${authorId}-to-${player.id}` }));
      firstAuthorClient.send({
        type: "SUBMIT_NOTE_BATCH",
        requestId: "writing-first-batch",
        notes: draftsFor(firstAuthor.id),
      });
      await message(firstAuthorClient, "NOTE_BATCH_ACCEPTED", "writing-first-batch");
      const progressMessage = await host.nextMatching((item) =>
        item.type === "SUBMISSION_PROGRESS_UPDATED" &&
        (item.progress as { submittedCount?: number })?.submittedCount === 1);
      const progressPlayers = (progressMessage.progress as { players?: Array<{ playerId: string; submitted: boolean }> }).players;
      expect(progressPlayers?.find((player) => player.playerId === writingDisconnect.id)?.submitted).toBe(false);
      expect(store.getByCode("EAEAAA")?.phase).toBe("WRITING");

      const writingReconnect = peer();
      await connect(writingReconnect);
      writingReconnect.send({
        type: "RECONNECT",
        requestId: "reconnect-writing",
        sessionToken: tokens.get(writingDisconnect.nickname),
      });
      const writingRestored = await message(writingReconnect, "SESSION_RESTORED", "reconnect-writing");
      clients.set(writingDisconnect.nickname, writingReconnect);
      tokens.set(writingDisconnect.nickname, writingRestored.sessionToken);
      expect(store.getByCode("EAEAAA")?.disconnectedPlayerIds).toEqual([]);

      // Finish all remaining batches. The server's original round data is retained.
      for (const player of store.getByCode("EAEAAA")!.players) {
        const current = store.getByCode("EAEAAA")!;
        const round = current.rounds.find((item) => item.id === current.currentRoundId)!;
        if (round.notes.some((note) => note.authorPlayerId === player.id)) continue;
        const authorClient = clients.get(player.nickname)!;
        authorClient.send({
          type: "SUBMIT_NOTE_BATCH",
          requestId: `submit-${player.id}`,
          notes: current.players.filter((target) => target.id !== player.id)
            .map((target) => ({ targetPlayerId: target.id, content: `final-${player.id}-${target.id}` })),
        });
        await message(authorClient, "NOTE_BATCH_ACCEPTED", `submit-${player.id}`);
      }
      room = store.getByCode("EAEAAA")!;
      expect(room.phase).toBe("REVEALING");
      expect(room.pausedPhase).toBeNull();
      const beforeRevealDisconnect = room.rounds.find((item) => item.id === room.currentRoundId)!;
      expect(beforeRevealDisconnect.revealSequence).toHaveLength(beforeRevealDisconnect.notes.length);
      expect(beforeRevealDisconnect.readerAssignments).toHaveLength(beforeRevealDisconnect.notes.length);

      host.send({ type: "NAVIGATE_REVEAL", requestId: "navigate-before-pause", action: "NEXT" });
      await message(host, "REVEAL_NAVIGATED", "navigate-before-pause");
      const savedSequence = [...store.getByCode("EAEAAA")!.rounds[0]!.revealSequence!];
      const savedAssignments = [...store.getByCode("EAEAAA")!.rounds[0]!.readerAssignments];
      const savedIndex = store.getByCode("EAEAAA")!.rounds[0]!.revealIndex;

      // A second pause in REVEALING preserves the shuffle, readers, and exact navigation position.
      room = store.getByCode("EAEAAA")!;
      const revealDisconnects = room.players.filter((player) => player.id !== room.host.id).slice(0, 2);
      for (const player of revealDisconnects) await clients.get(player.nickname)!.closeAndWait();
      await host.nextMatching((item) =>
        item.type === "WAITING_FOR_PLAYERS" &&
        Array.isArray(item.disconnectedPlayers) && item.disconnectedPlayers.length === 2);
      host.send({ type: "NAVIGATE_REVEAL", requestId: "blocked-navigation", action: "NEXT" });
      await expect(message(host, "ERROR", "blocked-navigation")).resolves.toMatchObject({
        error: { code: "GAME_PAUSED" },
      });
      const pausedRoom = store.getByCode("EAEAAA")!;
      expect(pausedRoom.rounds[0]?.revealSequence).toEqual(savedSequence);
      expect(pausedRoom.rounds[0]?.readerAssignments).toEqual(savedAssignments);
      expect(pausedRoom.rounds[0]?.revealIndex).toBe(savedIndex);

      const stillConnectedPlayer = room.players.find((player) =>
        player.id !== room.host.id && !revealDisconnects.some((disconnected) => disconnected.id === player.id))!;
      clients.get(stillConnectedPlayer.nickname)!.send({ type: "TERMINATE_GAME", requestId: "unauthorized-terminate" });
      await expect(message(clients.get(stillConnectedPlayer.nickname)!, "ERROR", "unauthorized-terminate"))
        .resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });

      for (let index = 0; index < revealDisconnects.length; index += 1) {
        const player = revealDisconnects[index]!;
        const restoredPeer = peer();
        await connect(restoredPeer);
        restoredPeer.send({ type: "RECONNECT", requestId: `reconnect-reveal-${index}`, sessionToken: tokens.get(player.nickname) });
        const restored = await message(restoredPeer, "SESSION_RESTORED", `reconnect-reveal-${index}`);
        clients.set(player.nickname, restoredPeer);
        tokens.set(player.nickname, restored.sessionToken);
        if (index === 0) {
          await host.nextMatching((item) =>
            item.type === "WAITING_FOR_PLAYERS" &&
            Array.isArray(item.disconnectedPlayers) && item.disconnectedPlayers.length === 1);
        }
      }
      await host.nextMatching((item) => item.type === "GAME_RESUMED");
      room = store.getByCode("EAEAAA")!;
      expect(room.pausedPhase).toBeNull();
      expect(room.phase).toBe("REVEALING");
      expect(room.rounds[0]?.revealSequence).toEqual(savedSequence);
      expect(room.rounds[0]?.readerAssignments).toEqual(savedAssignments);
      expect(room.rounds[0]?.revealIndex).toBe(savedIndex);

      // A host can terminate while a player is disconnected; subsequent actions are rejected.
      const finalDisconnect = room.players.find((player) => player.id !== room.host.id)!;
      await clients.get(finalDisconnect.nickname)!.closeAndWait();
      await host.nextMatching((item) =>
        item.type === "WAITING_FOR_PLAYERS" &&
        Array.isArray(item.disconnectedPlayers) && item.disconnectedPlayers.length === 1);
      host.send({ type: "TERMINATE_GAME", requestId: "terminate" });
      await message(host, "GAME_TERMINATED", "terminate");
      expect(store.getByCode("EAEAAA")?.phase).toBe("FINISHED");
      host.send({ type: "NAVIGATE_REVEAL", requestId: "after-termination", action: "NEXT" });
      await expect(message(host, "ERROR", "after-termination")).resolves.toMatchObject({
        error: { code: "ROOM_UNAVAILABLE" },
      });
      expect(store.getByCode("EAEAAA")?.rounds[0]?.revealSequence).toEqual(savedSequence);
    },
    20_000,
  );
});
