import Fastify from "fastify";
import websocket from "@fastify/websocket";

import { healthRoutes } from "./routes/health.js";
import { websocketRoutes } from "./websocket/index.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(websocket);

  await app.register(healthRoutes);
  await app.register(websocketRoutes);

  return app;
}