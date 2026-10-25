import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

function waitForMessage(
  socket: WebSocket,
  messages: string[],
  predicate: (message: string) => boolean,
): Promise<string> {
  const existing = messages.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message."));
    }, 2_000);
    const onMessage = (event: MessageEvent) => {
      const message = String(event.data);
      messages.push(message);
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  const messages: string[] = [];
  socket.addEventListener("message", (event) => messages.push(String(event.data)));
  const connected = waitForMessage(socket, messages, (message) => message.includes('"type":"CONNECTED"'));
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), { once: true });
    }),
    connected,
  ]);
  return socket;
}

describe("production-readiness controls", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("surfaces a startup bind failure and permits resource cleanup", async () => {
    const blocker = Fastify({ logger: false });
    await blocker.listen({ host: "127.0.0.1", port: 0 });
    const port = (blocker.server.address() as AddressInfo).port;

    try {
      app = await buildApp({ config: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" }) });
      await expect(app.listen({ host: "127.0.0.1", port })).rejects.toThrow();
      await app.close().catch(() => undefined);
      app = undefined;
    } finally {
      await blocker.close();
    }
  });

  it("exposes a deployment health endpoint", async () => {
    app = await buildApp({ config: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" }) });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
    expect(response.json().uptimeSeconds).toEqual(expect.any(Number));
  });

  it("rejects browser WebSocket upgrades from unapproved origins", async () => {
    app = await buildApp({
      config: loadEnv({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        ALLOWED_ORIGINS: "https://app.example.com",
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/ws",
      headers: { origin: "https://attacker.example" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "ORIGIN_NOT_ALLOWED" });
  });

  it("rejects connections above the configured concurrent connection limit", async () => {
    app = await buildApp({
      config: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", MAX_WS_CONNECTIONS: "1" }),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = address.replace("http", "ws") + "/ws";
    const first = new WebSocket(url);
    const firstMessages: string[] = [];
    first.addEventListener("message", (event) => firstMessages.push(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      first.addEventListener("open", () => resolve(), { once: true });
      first.addEventListener("error", () => reject(new Error("First WebSocket failed to open.")), { once: true });
    });
    await waitForMessage(first, firstMessages, (message) => message.includes('"type":"CONNECTED"'));

    const second = new WebSocket(url);
    const secondMessages: string[] = [];
    second.addEventListener("message", (event) => secondMessages.push(String(event.data)));
    const closeEvent = await new Promise<CloseEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Second WebSocket connection was not closed.")), 2_000);
      second.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve(event);
      }, { once: true });
      second.addEventListener("error", () => {
        // Some clients also report a transport error before the close event.
      }, { once: true });
    });

    expect(closeEvent.code).toBe(1013);
    expect(secondMessages.some((message) => message.includes('"type":"CONNECTED"'))).toBe(false);
    first.close();
    await app.close();
    app = undefined;
  });

  it("closes active WebSocket connections during application shutdown", async () => {
    app = await buildApp({ config: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" }) });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(address.replace("http", "ws") + "/ws");
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });

    await app.close();
    const closeEvent = await closed;
    expect(closeEvent.code).toBe(1001);
    app = undefined;
  });

  it("enforces the configured WebSocket payload size", async () => {
    app = await buildApp({
      config: loadEnv({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        MAX_WS_MESSAGE_BYTES: "1024",
      }),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(address.replace("http", "ws") + "/ws");
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });

    socket.send("x".repeat(2048));
    const closeEvent = await closed;
    expect(closeEvent.code).toBe(1009);
    await app.close();
    app = undefined;
  });

  it("closes a connection that exceeds the per-minute message limit", async () => {
    app = await buildApp({
      config: loadEnv({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        MAX_WS_MESSAGES_PER_MINUTE: "1",
      }),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(address.replace("http", "ws") + "/ws");
    const messages: string[] = [];
    socket.addEventListener("message", (event) => messages.push(String(event.data)));
    const connected = waitForMessage(socket, messages, (message) => message.includes('"type":"CONNECTED"'));
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), { once: true });
      }),
      connected,
    ]);

    const malformedResponse = waitForMessage(socket, messages, (message) => message.includes('"code":"MALFORMED_MESSAGE"'));
    socket.send("{invalid");
    await malformedResponse;

    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });
    socket.send("{invalid-again");
    const closeEvent = await closed;
    expect(closeEvent.code).toBe(1008);
    await app.close();
    app = undefined;
  });
});
