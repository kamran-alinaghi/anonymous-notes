import { isIP } from "node:net";

export type NodeEnvironment = "development" | "test" | "production";
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: LogLevel;
  allowedOrigins: string[];
  maxWebSocketConnections: number;
  maxWebSocketMessagesPerMinute: number;
  maxWebSocketMessageBytes: number;
}

type EnvironmentSource = Record<string, string | undefined>;

function parseInteger(
  source: EnvironmentSource,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid environment variable ${name}: expected an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid environment variable ${name}: expected a value from ${minimum} to ${maximum}.`);
  }
  return value;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const origins = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const normalized = origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("Invalid environment variable ALLOWED_ORIGINS: provide comma-separated http(s) origins.");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== origin.replace(/\/$/, "") ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new Error("Invalid environment variable ALLOWED_ORIGINS: each entry must be an origin without a path.");
    }
    return parsed.origin;
  });
  return [...new Set(normalized)];
}

export function loadEnv(source: EnvironmentSource = process.env): AppConfig {
  const rawNodeEnv = source.NODE_ENV ?? "development";
  if (rawNodeEnv !== "development" && rawNodeEnv !== "test" && rawNodeEnv !== "production") {
    throw new Error("Invalid environment variable NODE_ENV: expected development, test, or production.");
  }

  const host = source.HOST?.trim() || "127.0.0.1";
  const hostname = host.endsWith(".") ? host.slice(0, -1) : host;
  const validHostname = hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname.split(".").every((label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
    );
  if (isIP(host) === 0 && !validHostname) {
    throw new Error("Invalid environment variable HOST: expected a hostname or IP address.");
  }

  const rawLogLevel = source.LOG_LEVEL ?? (rawNodeEnv === "development" ? "debug" : "info");
  const validLogLevels: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
  if (!validLogLevels.includes(rawLogLevel as LogLevel)) {
    throw new Error("Invalid environment variable LOG_LEVEL: unsupported log level.");
  }

  const allowedOrigins = parseOrigins(source.ALLOWED_ORIGINS);
  if (rawNodeEnv === "production" && allowedOrigins.length === 0) {
    throw new Error("Invalid environment configuration: ALLOWED_ORIGINS is required in production.");
  }

  return {
    nodeEnv: rawNodeEnv,
    host,
    port: parseInteger(source, "PORT", 3000, 1, 65535),
    logLevel: rawLogLevel as LogLevel,
    allowedOrigins,
    maxWebSocketConnections: parseInteger(source, "MAX_WS_CONNECTIONS", 1000, 1, 100_000),
    maxWebSocketMessagesPerMinute: parseInteger(source, "MAX_WS_MESSAGES_PER_MINUTE", 120, 1, 100_000),
    maxWebSocketMessageBytes: parseInteger(source, "MAX_WS_MESSAGE_BYTES", 262_144, 1024, 10_485_760),
  };
}

export const env = loadEnv();
