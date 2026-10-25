import type { FastifyInstance } from "fastify";

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return {
      status: "ok",
      message: "Anonymous Note server is running!",
    };
  });

  app.get("/health", async (_request, reply) => {
    return reply.code(200).send({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });
}
