import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { GameManagementService } from "../game/game-management.js";
import { RoundLifecycleService } from "../game/round-lifecycle.js";
import { LobbyManagementService } from "../lobby/lobby-management.js";
import { NoteSubmissionService } from "../notes/note-submission.js";
import { RevealSessionService } from "../reveal/reveal-session.js";
import { InMemoryRoomStore } from "../rooms/room-store.js";
import { RoomManagementService } from "../rooms/room-management.js";

type WireMessage = Record<string, unknown>;
type RevealMode = "SINGLE_DEVICE" | "INDIVIDUAL_DEVICES";
type HostDecision = "FINISH_GAME" | "START_NEXT_ROUND";

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

describe("Anonymous Note end-to-end WebSocket flow", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const peers: WebSocketPeer[] = [];

  afterEach(async () => {
    const closingPeers = peers.splice(0);
    await Promise.all(closingPeers.map((peer) => peer.closeAndWait()));
    expect(closingPeers.every((peer) => peer.socket.readyState === WebSocket.CLOSED)).toBe(true);
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  async function setup() {
    let id = 0;
    let roomCodeIndex = 0;
    let roundId = 0;
    let noteId = 0;
    let connectionId = 0;
    const roomCodes = ["EAEAAA", "EAEBBB"];
    const store = new InMemoryRoomStore();
    const roomManagement = new RoomManagementService(store, {
      generateRoomCode: () => roomCodes[roomCodeIndex++] ?? "EAECCC",
      generateId: () => `e2e-player-${++id}`,
    });
    const lobbyManagement = new LobbyManagementService(store);
    const gameManagement = new GameManagementService(store, {
      generateRoundId: () => `e2e-round-${++roundId}`,
    });
    const noteSubmission = new NoteSubmissionService(store, {
      generateNoteId: () => `e2e-note-${++noteId}`,
    });
    const revealSession = new RevealSessionService(store);
    const roundLifecycle = new RoundLifecycleService(store, {
      generateRoundId: () => `e2e-next-round-${++roundId}`,
    });
    const serverApp = await buildApp({
      roomManagement,
      lobbyManagement,
      gameManagement,
      noteSubmission,
      revealSession,
      roundLifecycle,
      generateConnectionId: () => `e2e-connection-${++connectionId}`,
    });
    app = serverApp;
    const address = await serverApp.listen({ host: "127.0.0.1", port: 0 });
    const peer = () => {
      const created = new WebSocketPeer(address.replace("http", "ws") + "/ws");
      peers.push(created);
      return created;
    };
    return { peer, store };
  }

  async function connected(peer: WebSocketPeer): Promise<void> {
    await peer.open();
    expect(await peer.nextMessage()).toMatchObject({
      type: "CONNECTED",
      connectionId: expect.any(String),
    });
  }

  async function expectMessage(
    peer: WebSocketPeer,
    expected: Record<string, unknown>,
  ): Promise<WireMessage> {
    const message = await peer.nextMessage();
    expect(message).toMatchObject(expected);
    return message;
  }

  async function expectRoomBroadcast(
    clients: WebSocketPeer[],
    expectedType: string,
    predicate?: (message: WireMessage) => void,
  ): Promise<WireMessage[]> {
    const messages = await Promise.all(clients.map((client) => client.nextMessage()));
    for (const message of messages) {
      expect(message.type).toBe(expectedType);
      predicate?.(message);
    }
    return messages;
  }

  it.each([
    ["SINGLE_DEVICE", "FINISH_GAME"],
    ["SINGLE_DEVICE", "START_NEXT_ROUND"],
    ["INDIVIDUAL_DEVICES", "FINISH_GAME"],
    ["INDIVIDUAL_DEVICES", "START_NEXT_ROUND"],
  ] as const)(
    "runs the complete %s flow and handles the host's %s decision",
    async (mode: RevealMode, hostDecision: HostDecision) => {
      const { peer, store } = await setup();
      const host = peer();
      const joinedPlayers = Array.from(
        { length: mode === "SINGLE_DEVICE" ? 4 : 3 },
        () => peer(),
      );
      const clients = [host, ...joinedPlayers];
      await Promise.all(clients.map(connected));

      host.send({
        type: "CREATE_ROOM",
        requestId: "create-room",
        revealMode: mode,
        hostNickname: "Host",
      });
      const created = await expectMessage(host, {
        type: "ROOM_CREATED",
        requestId: "create-room",
        room: { roomCode: "EAEAAA", revealMode: mode, phase: "LOBBY" },
      });

      const playerClientsByNickname = new Map<string, WebSocketPeer>();
      if (mode === "INDIVIDUAL_DEVICES") playerClientsByNickname.set("Host", host);

      let members: WebSocketPeer[] = [host];
      for (let index = 0; index < joinedPlayers.length; index += 1) {
        const joiningPeer = joinedPlayers[index]!;
        const nickname = `Player${index + 1}`;
        joiningPeer.send({
          type: "JOIN_ROOM",
          requestId: `join-${index + 1}`,
          roomCode: "EAEAAA",
          nickname,
        });
        await expectMessage(joiningPeer, {
          type: "ROOM_JOINED",
          requestId: `join-${index + 1}`,
          sessionRole: "PLAYER",
          room: { roomCode: "EAEAAA", viewerRole: "PLAYER" },
        });
        playerClientsByNickname.set(nickname, joiningPeer);
        members = [...members, joiningPeer];
        const lobbyMessages = await expectRoomBroadcast(members, "LOBBY_UPDATED");
        const hostLobby = lobbyMessages[0]!;
        expect(hostLobby.room).toMatchObject({
          viewerRole: "HOST",
          playerCount: mode === "INDIVIDUAL_DEVICES" ? index + 2 : index + 1,
        });
        expect((hostLobby.room as { players: unknown[] }).players).toHaveLength(
          mode === "INDIVIDUAL_DEVICES" ? index + 2 : index + 1,
        );
        expect(lobbyMessages.slice(1).every((message) =>
          !(message.room as Record<string, unknown>).hasOwnProperty("players"),
        )).toBe(true);
      }

      const lobby = store.getByCode("EAEAAA")!;
      const initialPlayers = lobby.players;
      expect(initialPlayers).toHaveLength(4);
      expect(initialPlayers.some((player) => player.id === lobby.host.id))
        .toBe(mode === "INDIVIDUAL_DEVICES");
      const initialPlayerIds = initialPlayers.map((player) => player.id);

      // Invalid reordering must not mutate the actual order.
      host.send({
        type: "REORDER_PLAYERS",
        requestId: "invalid-reorder",
        playerIds: initialPlayerIds.slice(1),
      });
      await expectMessage(host, {
        type: "ERROR",
        requestId: "invalid-reorder",
        error: { code: "INVALID_PLAYER_ORDER" },
      });
      expect(store.getByCode("EAEAAA")?.players.map((player) => player.id)).toEqual(initialPlayerIds);
      expect(host.messages).toHaveLength(0);

      const reorderedIds = [...initialPlayerIds].reverse();
      host.send({ type: "REORDER_PLAYERS", requestId: "reorder", playerIds: reorderedIds });
      const orderResponse = await expectMessage(host, {
        type: "PLAYER_ORDER_UPDATED",
        requestId: "reorder",
        room: { players: reorderedIds.map((id) => ({ id })) },
      });
      expect((orderResponse.room as { players: Array<{ id: string }> }).players.map((player) => player.id))
        .toEqual(reorderedIds);
      await expectRoomBroadcast(members, "LOBBY_UPDATED");
      expect(store.getByCode("EAEAAA")?.players.map((player) => player.id)).toEqual(reorderedIds);

      const orderedPlayers = store.getByCode("EAEAAA")!.players;
      const playerIdByClient = new Map<WebSocketPeer, string>();
      for (const player of orderedPlayers) {
        const playerClient = playerClientsByNickname.get(player.nickname);
        expect(playerClient).toBeDefined();
        playerIdByClient.set(playerClient!, player.id);
      }
      const setter = orderedPlayers[0]!;
      const setterClient = playerClientsByNickname.get(setter.nickname)!;
      const nonSetter = orderedPlayers.find((player) => player.id !== setter.id)!;
      const nonSetterClient = playerClientsByNickname.get(nonSetter.nickname)!;

      joinedPlayers[0]!.send({ type: "START_GAME", requestId: "unauthorized-start" });
      await expectMessage(joinedPlayers[0]!, {
        type: "ERROR",
        requestId: "unauthorized-start",
        error: { code: "UNAUTHORIZED" },
      });
      expect(store.getByCode("EAEAAA")?.phase).toBe("LOBBY");

      host.send({ type: "START_GAME", requestId: "start-game" });
      await expectMessage(host, {
        type: "GAME_STARTED",
        requestId: "start-game",
        room: {
          phase: "CHOOSING_SUBJECT",
          currentRoundNumber: 1,
          currentSubjectSetterNickname: setter.nickname,
          subject: null,
        },
      });
      await expectRoomBroadcast(members, "GAME_STATE_UPDATED", (message) => {
        expect(message.room).toMatchObject({
          phase: "CHOOSING_SUBJECT",
          currentSubjectSetterNickname: setter.nickname,
        });
      });

      nonSetterClient.send({ type: "SET_SUBJECT", requestId: "wrong-subject-setter", subject: "Not permitted" });
      await expectMessage(nonSetterClient, {
        type: "ERROR",
        requestId: "wrong-subject-setter",
        error: { code: "NOT_SUBJECT_SETTER" },
      });
      expect(store.getByCode("EAEAAA")?.phase).toBe("CHOOSING_SUBJECT");

      setterClient.send({ type: "SET_SUBJECT", requestId: "set-subject", subject: "A mystery" });
      await expectMessage(setterClient, {
        type: "SUBJECT_SUBMITTED",
        requestId: "set-subject",
        room: { phase: "WRITING", subject: "A mystery" },
      });
      await expectRoomBroadcast(members, "GAME_STATE_UPDATED", (message) => {
        expect(message.room).toMatchObject({ phase: "WRITING", subject: "A mystery" });
      });

      const currentRoom = store.getByCode("EAEAAA")!;
      const actualPlayers = currentRoom.players;
      let contentIndex = 0;
      const batchFor = (authorId: string) => actualPlayers
        .filter((target) => target.id !== authorId)
        .map((target) => {
          const content = `private-note-${++contentIndex}`;
          return { targetPlayerId: target.id, content };
        });

      const firstAuthor = actualPlayers[0]!;
      const firstAuthorClient = playerClientsByNickname.get(firstAuthor.nickname)!;
      firstAuthorClient.send({ type: "SUBMIT_NOTE_BATCH", requestId: "invalid-batch", notes: [] });
      await expectMessage(firstAuthorClient, {
        type: "ERROR",
        requestId: "invalid-batch",
        error: { code: "INVALID_NOTE_BATCH" },
      });
      expect(store.getByCode("EAEAAA")?.phase).toBe("WRITING");
      expect(store.getByCode("EAEAAA")?.rounds[0]?.notes).toHaveLength(0);

      for (let index = 0; index < actualPlayers.length; index += 1) {
        const author = actualPlayers[index]!;
        const authorClient = playerClientsByNickname.get(author.nickname)!;
        const notes = batchFor(author.id);
        authorClient.send({
          type: "SUBMIT_NOTE_BATCH",
          requestId: `submit-${author.id}`,
          notes,
        });
        const accepted = await expectMessage(authorClient, {
          type: "NOTE_BATCH_ACCEPTED",
          requestId: `submit-${author.id}`,
          submittedNotes: actualPlayers.length - 1,
        });
        expect(JSON.stringify(accepted)).not.toContain("private-note-");
        const progress = accepted.progress as Record<string, unknown>;
        expect(progress).toMatchObject({
          submittedCount: index + 1,
          totalPlayerCount: actualPlayers.length,
        });
        if (authorClient === host) expect(progress).toHaveProperty("players");
        else expect(progress).not.toHaveProperty("players");

        await expectRoomBroadcast(clients, "SUBMISSION_PROGRESS_UPDATED", (message) => {
          const view = message.progress as Record<string, unknown>;
          expect(view).toMatchObject({
            submittedCount: index + 1,
            totalPlayerCount: actualPlayers.length,
          });
          expect(JSON.stringify(message)).not.toContain("private-note-");
          if (message === undefined) return;
          if (clients[0] === host && view.viewerRole === "HOST") expect(view).toHaveProperty("players");
          else expect(view).not.toHaveProperty("players");
        });

        if (index === 0) {
          authorClient.send({
            type: "SUBMIT_NOTE_BATCH",
            requestId: "duplicate-batch",
            notes,
          });
          await expectMessage(authorClient, {
            type: "ERROR",
            requestId: "duplicate-batch",
            error: { code: "ALREADY_SUBMITTED" },
          });
          expect(store.getByCode("EAEAAA")?.rounds[0]?.notes).toHaveLength(actualPlayers.length - 1);
        }

        if (index === actualPlayers.length - 1) {
          expect(progress.phase).toBe("REVEALING");
          const initialRevealMessages = mode === "SINGLE_DEVICE"
            ? [await host.nextMessage()]
            : await expectRoomBroadcast(clients, "REVEAL_STATE_UPDATED");
          if (mode === "SINGLE_DEVICE") {
            expect(initialRevealMessages[0]?.type).toBe("REVEAL_STATE_UPDATED");
          }
          verifyRevealStates(initialRevealMessages, mode, 0, store, playerIdByClient, clients, host);
        }
      }

      // In shared-display mode, players cannot request the host-only reveal state.
      if (mode === "SINGLE_DEVICE") {
        const nonHost = joinedPlayers[0]!;
        nonHost.send({ type: "GET_REVEAL_STATE", requestId: "private-reveal-request" });
        await expectMessage(nonHost, {
          type: "ERROR",
          requestId: "private-reveal-request",
          error: { code: "UNAUTHORIZED" },
        });
      }

      // Invalid lifecycle choices during reveal leave the round untouched.
      host.send({ type: "FINISH_GAME", requestId: "premature-finish" });
      await expectMessage(host, {
        type: "ERROR",
        requestId: "premature-finish",
        error: { code: "ROOM_UNAVAILABLE" },
      });
      expect(store.getByCode("EAEAAA")?.phase).toBe("REVEALING");

      const totalNotes = actualPlayers.length * (actualPlayers.length - 1);
      host.send({ type: "NAVIGATE_REVEAL", requestId: "at-start-boundary", action: "PREVIOUS" });
      await expectMessage(host, {
        type: "ERROR",
        requestId: "at-start-boundary",
        error: { code: "REVEAL_BOUNDARY" },
      });
      expect(store.getByCode("EAEAAA")?.rounds[0]?.revealIndex).toBe(0);

      for (let position = 1; position < totalNotes; position += 1) {
        host.send({ type: "NAVIGATE_REVEAL", requestId: `next-${position}`, action: "NEXT" });
        await expectMessage(host, {
          type: "REVEAL_NAVIGATED",
          requestId: `next-${position}`,
          position,
          total: totalNotes,
        });
        const revealMessages = mode === "SINGLE_DEVICE"
          ? [await host.nextMessage()]
          : await expectRoomBroadcast(clients, "REVEAL_STATE_UPDATED");
        if (mode === "SINGLE_DEVICE") expect(revealMessages[0]?.type).toBe("REVEAL_STATE_UPDATED");
        verifyRevealStates(revealMessages, mode, position, store, playerIdByClient, clients, host);
        if (position === 1) {
          host.send({ type: "NAVIGATE_REVEAL", requestId: "previous-to-start", action: "PREVIOUS" });
          await expectMessage(host, {
            type: "REVEAL_NAVIGATED",
            requestId: "previous-to-start",
            position: 0,
            total: totalNotes,
          });
          const previousMessages = mode === "SINGLE_DEVICE"
            ? [await host.nextMessage()]
            : await expectRoomBroadcast(clients, "REVEAL_STATE_UPDATED");
          verifyRevealStates(previousMessages, mode, 0, store, playerIdByClient, clients, host);

          host.send({ type: "NAVIGATE_REVEAL", requestId: "return-to-position-one", action: "NEXT" });
          await expectMessage(host, {
            type: "REVEAL_NAVIGATED",
            requestId: "return-to-position-one",
            position: 1,
            total: totalNotes,
          });
          const returnedMessages = mode === "SINGLE_DEVICE"
            ? [await host.nextMessage()]
            : await expectRoomBroadcast(clients, "REVEAL_STATE_UPDATED");
          verifyRevealStates(returnedMessages, mode, 1, store, playerIdByClient, clients, host);
        }
      }

      host.send({ type: "NAVIGATE_REVEAL", requestId: "at-end-boundary", action: "NEXT" });
      await expectMessage(host, {
        type: "ERROR",
        requestId: "at-end-boundary",
        error: { code: "REVEAL_BOUNDARY" },
      });
      expect(store.getByCode("EAEAAA")?.rounds[0]?.revealIndex).toBe(totalNotes - 1);

      const unauthorizedLifecyclePeer = joinedPlayers[0]!;
      unauthorizedLifecyclePeer.send({ type: "COMPLETE_ROUND", requestId: "unauthorized-complete" });
      await expectMessage(unauthorizedLifecyclePeer, {
        type: "ERROR",
        requestId: "unauthorized-complete",
        error: { code: "UNAUTHORIZED" },
      });

      host.send({ type: "COMPLETE_ROUND", requestId: "complete-round" });
      await expectMessage(host, {
        type: "ROUND_COMPLETED",
        requestId: "complete-round",
        room: { phase: "ROUND_COMPLETE", currentRoundNumber: 1 },
      });
      await expectRoomBroadcast(clients, "GAME_STATE_UPDATED", (message) => {
        expect(message.room).toMatchObject({ phase: "ROUND_COMPLETE", currentRoundNumber: 1 });
      });
      expect(store.getByCode("EAEAAA")?.phase).toBe("ROUND_COMPLETE");

      host.send({ type: "COMPLETE_ROUND", requestId: "duplicate-complete" });
      await expectMessage(host, {
        type: "ERROR",
        requestId: "duplicate-complete",
        error: { code: "ROOM_UNAVAILABLE" },
      });
      expect(store.getByCode("EAEAAA")?.phase).toBe("ROUND_COMPLETE");

      if (hostDecision === "FINISH_GAME") {
        host.send({ type: "FINISH_GAME", requestId: "finish-game" });
        await expectMessage(host, {
          type: "GAME_FINISHED",
          requestId: "finish-game",
          room: { phase: "FINISHED", currentRoundNumber: 1 },
        });
        await expectRoomBroadcast(clients, "GAME_STATE_UPDATED", (message) => {
          expect(message.room).toMatchObject({ phase: "FINISHED", currentRoundNumber: 1 });
        });
        expect(store.getByCode("EAEAAA")?.phase).toBe("FINISHED");

        host.send({ type: "FINISH_GAME", requestId: "duplicate-finish" });
        await expectMessage(host, {
          type: "ERROR",
          requestId: "duplicate-finish",
          error: { code: "ROOM_UNAVAILABLE" },
        });
        host.send({ type: "START_NEXT_ROUND", requestId: "next-after-finish" });
        await expectMessage(host, {
          type: "ERROR",
          requestId: "next-after-finish",
          error: { code: "ROOM_UNAVAILABLE" },
        });
        expect(store.getByCode("EAEAAA")?.rounds).toHaveLength(1);
      } else {
        host.send({ type: "START_NEXT_ROUND", requestId: "start-next-round" });
        await expectMessage(host, {
          type: "NEXT_ROUND_STARTED",
          requestId: "start-next-round",
          room: {
            phase: "CHOOSING_SUBJECT",
            currentRoundNumber: 2,
            currentSubjectSetterNickname: orderedPlayers[1]!.nickname,
            subject: null,
          },
        });
        await expectRoomBroadcast(clients, "GAME_STATE_UPDATED", (message) => {
          expect(message.room).toMatchObject({
            phase: "CHOOSING_SUBJECT",
            currentRoundNumber: 2,
            currentSubjectSetterNickname: orderedPlayers[1]!.nickname,
            subject: null,
          });
        });
        const nextRoom = store.getByCode("EAEAAA")!;
        expect(nextRoom.rounds).toHaveLength(2);
        expect(nextRoom.rounds[1]).toMatchObject({
          number: 2,
          subject: null,
          notes: [],
          revealSequence: null,
          readerAssignments: [],
        });
        expect(nextRoom.phase).toBe("CHOOSING_SUBJECT");

        host.send({ type: "START_NEXT_ROUND", requestId: "duplicate-next-round" });
        await expectMessage(host, {
          type: "ERROR",
          requestId: "duplicate-next-round",
          error: { code: "ROOM_UNAVAILABLE" },
        });
        expect(store.getByCode("EAEAAA")?.rounds).toHaveLength(2);
      }

      // Closing real peers and the Fastify app in afterEach must complete cleanly.
      expect(created.type).toBe("ROOM_CREATED");
      expect(clients.every((client) => client.socket.readyState === WebSocket.OPEN)).toBe(true);
    },
  );
});

function verifyRevealStates(
  messages: WireMessage[],
  mode: RevealMode,
  position: number,
  store: InMemoryRoomStore,
  playerIdByClient: Map<WebSocketPeer, string>,
  clients: WebSocketPeer[],
  host: WebSocketPeer,
): void {
  const room = store.getByCode("EAEAAA");
  expect(room).toBeDefined();
  const currentRoom = room!;
  const round = currentRoom.rounds.find((item) => item.id === currentRoom.currentRoundId)!;
  const noteId = round.revealSequence?.[position];
  const note = round.notes.find((item) => item.id === noteId);
  expect(note).toBeDefined();
  const target = currentRoom.players.find((player) => player.id === note!.targetPlayerId)!;
  const assignment = round.readerAssignments.find((item) => item.noteId === note!.id);

  expect(messages.length).toBe(mode === "SINGLE_DEVICE" ? 1 : currentRoom.players.length);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const client = mode === "SINGLE_DEVICE" ? host : clients[index]!;
    expect(message.type).toBe("REVEAL_STATE_UPDATED");
    const state = message.state as Record<string, unknown>;
    expect(state).toMatchObject({
      roomCode: "EAEAAA",
      revealMode: mode,
      phase: "REVEALING",
      position,
      total: round.notes.length,
    });
    const hasDisplayNote = Object.hasOwn(state, "displayNote");
    if (mode === "SINGLE_DEVICE") {
      // Only the shared host display receives reveal state; it may show the recipient, never the author.
      expect(message).toBeDefined();
      expect(hasDisplayNote).toBe(true);
      expect(state.displayNote).toEqual({ content: note!.content, targetNickname: target.nickname });
    } else {
      const viewerPlayerId = playerIdByClient.get(client);
      const isAssignedReader = assignment?.readerPlayerId === viewerPlayerId;
      expect(hasDisplayNote).toBe(isAssignedReader);
      if (isAssignedReader) expect(state.displayNote).toEqual({ content: note!.content });
    }
    const serialized = JSON.stringify(message);
    const author = currentRoom.players.find((player) => player.id === note!.authorPlayerId)!;
    expect(Object.keys(state).sort()).toEqual(
      (hasDisplayNote
        ? ["roomCode", "revealMode", "phase", "position", "total", "displayNote"]
        : ["roomCode", "revealMode", "phase", "position", "total"]).sort(),
    );
    expect(serialized).not.toContain("authorPlayerId");
    expect(serialized).not.toContain("targetPlayerId");
    expect(serialized).not.toContain(note!.authorPlayerId);
    expect(serialized).not.toContain(author.nickname);
    expect(serialized).not.toContain("authorNickname");
  }
}
