import Fastify from "fastify";
import websocket from "@fastify/websocket";

const app = Fastify({ logger: true });

async function start() {
  await app.register(websocket);

  app.get("/", async () => {
    return { message: "Anonymous Note server is running!" };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    socket.send("Connected to Anonymous Note server!");
  });

  await app.listen({ port: 3000, host: "127.0.0.1" });
}

start();