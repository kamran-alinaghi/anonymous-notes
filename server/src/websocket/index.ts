import type { FastifyInstance } from "fastify";

import type { WebSocketTransport } from "./transport.js";
import type { SessionConnection } from "./sessions.js";

export interface WebSocketRouteOptions {
  transport: WebSocketTransport;
}

export async function websocketRoutes(app: FastifyInstance, options: WebSocketRouteOptions) {
  app.get("/ws", { websocket: true }, (socket) => {
    options.transport.attach(socket as unknown as SessionConnection);
  });
}
