import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

describe("production-readiness controls", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
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

  it("closes active WebSocket connections during application shutdown", async () => {
    app = await buildApp({ config: loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" }) });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(address.replace("http", "ws") + "/ws");
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), { once: true });
    });
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
    const socket = new WebSocket(address.replace("http", "ws") + "/ws");
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), { once: true });
    });
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
    const received: string[] = [];
    socket.addEventListener("message", (event) => received.push(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), { once: true });
    });
    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.some((message) => message.includes('"type":"CONNECTED"'))) resolve();
        else setTimeout(check, 5);
      };
      check();
    });

    const firstResponse = new Promise<void>((resolve) => {
      const check = () => {
        if (received.some((message) => message.includes('"code":"MALFORMED_MESSAGE"'))) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
    socket.send("{invalid");
    await firstResponse;

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
