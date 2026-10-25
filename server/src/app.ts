import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";

import { env, type AppConfig } from "./config/env.js";
import { LobbyManagementService } from "./lobby/lobby-management.js";
import { GameManagementService } from "./game/game-management.js";
import { RoundLifecycleService } from "./game/round-lifecycle.js";
import { ConnectionLifecycleService } from "./game/connection-lifecycle.js";
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
  roundLifecycle?: RoundLifecycleService;
  noteSubmission?: NoteSubmissionService;
  revealSession?: RevealSessionService;
  connectionLifecycle?: ConnectionLifecycleService;
  generateConnectionId?: () => string;
  generateSessionToken?: () => string;
  config?: AppConfig;
}

export async function buildApp(options: AppOptions = {}) {
  const config = options.config ?? env;
  const app = Fastify({ logger: { level: config.logLevel } });
  const store = new InMemoryRoomStore();
  const roomManagement = options.roomManagement ?? new RoomManagementService(store);
  const lobbyManagement = options.lobbyManagement ?? new LobbyManagementService(store);
  const gameManagement = options.gameManagement ?? new GameManagementService(store);
  const roundLifecycle = options.roundLifecycle ?? new RoundLifecycleService(store);
  const noteSubmission = options.noteSubmission ?? new NoteSubmissionService(store);
  const revealSession = options.revealSession ?? new RevealSessionService(store);
  const connectionLifecycle = options.connectionLifecycle ?? new ConnectionLifecycleService(store);
  const transport = new WebSocketTransport(
    roomManagement,
    options.generateConnectionId ?? randomUUID,
    lobbyManagement,
    gameManagement,
    noteSubmission,
    revealSession,
    roundLifecycle,
    connectionLifecycle,
    options.generateSessionToken,
    {
      maxConnections: config.maxWebSocketConnections,
      maxMessagesPerMinute: config.maxWebSocketMessagesPerMinute,
      logger: app.log,
    },
  );

  let shuttingDown = false;
  app.addHook("onRequest", async (_request, reply) => {
    if (shuttingDown) {
      return reply.code(503).send({ status: "shutting_down" });
    }
  });
  app.addHook("preClose", async () => {
    shuttingDown = true;
    transport.shutdown();
  });

  await app.register(websocket, {
    options: { maxPayload: config.maxWebSocketMessageBytes },
  });
  await app.register(healthRoutes);
  await app.register(websocketRoutes, { transport, allowedOrigins: config.allowedOrigins });

  return app;
}
