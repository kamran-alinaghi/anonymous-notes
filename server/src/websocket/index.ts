import type { FastifyInstance } from "fastify";

export async function websocketRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket) => {
    socket.send("Connected to Anonymous Note server!");

    socket.on("message", (message:any) => {
      app.log.info(`Received WebSocket message: ${message.toString()}`);
    });
  });
}