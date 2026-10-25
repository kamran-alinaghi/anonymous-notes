import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";

import { LobbyManagementService } from "./lobby/lobby-management.js";
import { GameManagementService } from "./game/game-management.js";
import { NoteSubmissionService } from "./notes/note-submission.js";
import { RevealSessionService } from "./reveal/reveal-session.js";
import { InMemoryRoomStore } from "./rooms/room-store.js";
import { RoomManagementService } from "./rooms/room-management.js";
import { healthRoutes } from "./routes/health.js";
import { websocketRoutes } from "./websocket/index.js";
import { WebSocketTransport } from "./websocket/transport.js";

export interface AppOptions {
  roomManagement?: RoomManagementService;
  lobbyManagement?: LobbyManagementService;
  gameManagement?: GameManagementService;
  noteSubmission?: NoteSubmissionService;
  revealSession?: RevealSessionService;
  generateConnectionId?: () => string;
}

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true });
  const store = new InMemoryRoomStore();
  const roomManagement = options.roomManagement ?? new RoomManagementService(store);
  const lobbyManagement = options.lobbyManagement ?? new LobbyManagementService(store);
  const gameManagement = options.gameManagement ?? new GameManagementService(store);
  const noteSubmission = options.noteSubmission ?? new NoteSubmissionService(store);
  const revealSession = options.revealSession ?? new RevealSessionService(store);
  const transport = new WebSocketTransport(
    roomManagement,
    options.generateConnectionId ?? randomUUID,
    lobbyManagement,
    gameManagement,
    noteSubmission,
    revealSession,
  );

  await app.register(websocket);

  await app.register(healthRoutes);
  await app.register(websocketRoutes, { transport });

  return app;
}
