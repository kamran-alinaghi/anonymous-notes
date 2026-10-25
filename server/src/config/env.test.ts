import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("environment configuration", () => {
  it("uses safe development defaults", () => {
    expect(loadEnv({}).host).toBe("127.0.0.1");
    expect(loadEnv({}).port).toBe(3000);
    expect(loadEnv({}).nodeEnv).toBe("development");
  });

  it("parses validated production settings and normalized origins", () => {
    const config = loadEnv({
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      PORT: "8080",
      LOG_LEVEL: "warn",
      ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com/",
      MAX_WS_CONNECTIONS: "250",
      MAX_WS_MESSAGES_PER_MINUTE: "90",
      MAX_WS_MESSAGE_BYTES: "524288",
    });

    expect(config).toMatchObject({
      nodeEnv: "production",
      host: "0.0.0.0",
      port: 8080,
      logLevel: "warn",
      allowedOrigins: ["https://app.example.com", "https://admin.example.com"],
      maxWebSocketConnections: 250,
      maxWebSocketMessagesPerMinute: 90,
      maxWebSocketMessageBytes: 524288,
    });
  });

  it.each(["0", "-1", "65536", "not-a-port"])("rejects invalid PORT=%s", (port) => {
    expect(() => loadEnv({ PORT: port })).toThrow(/PORT/);
  });

  it("requires explicit allowed origins in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("rejects origin entries containing paths", () => {
    expect(() => loadEnv({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://app.example.com/game",
    })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("rejects unsupported log levels and out-of-range limits", () => {
    expect(() => loadEnv({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
    expect(() => loadEnv({ MAX_WS_CONNECTIONS: "0" })).toThrow(/MAX_WS_CONNECTIONS/);
    expect(() => loadEnv({ MAX_WS_MESSAGE_BYTES: "10" })).toThrow(/MAX_WS_MESSAGE_BYTES/);
  });
});
