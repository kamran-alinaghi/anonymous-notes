import type { FastifyInstance } from "fastify";

import type { WebSocketTransport } from "./transport.js";
import type { SessionConnection } from "./sessions.js";

export interface WebSocketRouteOptions {
  transport: WebSocketTransport;
  allowedOrigins: readonly string[];
}

export async function websocketRoutes(app: FastifyInstance, options: WebSocketRouteOptions) {
  app.get(
    "/ws",
    {
      websocket: true,
      onRequest: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin && !options.allowedOrigins.includes(origin)) {
          app.log.warn({ event: "websocket_origin_rejected" }, "WebSocket request rejected by origin policy");
          return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
        }
        if (!options.transport.canAcceptConnection) {
          return reply.code(503).send({ error: "SERVER_BUSY" });
        }
      },
    },
    (socket) => {
      options.transport.attach(socket as unknown as SessionConnection);
    },
  );
}
