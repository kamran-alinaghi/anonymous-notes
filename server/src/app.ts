import Fastify from "fastify";
import websocket from "@fastify/websocket";

import { InMemoryRoomStore } from "./rooms/room-store.js";
import { RoomManagementService } from "./rooms/room-management.js";
import { healthRoutes } from "./routes/health.js";
import { websocketRoutes } from "./websocket/index.js";
import { WebSocketTransport } from "./websocket/transport.js";

export interface AppOptions {
  roomManagement?: RoomManagementService;
  generateConnectionId?: () => string;
}

export async function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true });
  const roomManagement = options.roomManagement ??
    new RoomManagementService(new InMemoryRoomStore());
  const transport = new WebSocketTransport(
    roomManagement,
    options.generateConnectionId ?? (() => crypto.randomUUID()),
  );

  await app.register(websocket);

  await app.register(healthRoutes);
  await app.register(websocketRoutes, { transport });

  return app;
}
