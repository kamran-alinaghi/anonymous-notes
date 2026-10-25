import { buildApp } from "./app.js";
import { env } from "./config/env.js";

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    const address = await app.listen({
      host: env.host,
      port: env.port,
    });
    app.log.info(
      { event: "server_started", address, environment: env.nodeEnv },
      "Anonymous Note server started",
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    app.log.error({ event: "server_start_failed", code }, "Anonymous Note server failed to start");
    try {
      await app.close();
    } catch {
      // Preserve the startup failure without logging potentially sensitive internals.
    }
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ event: "shutdown_started", signal }, "Graceful shutdown started");
    try {
      await app.close();
      app.log.info({ event: "shutdown_complete", signal }, "Graceful shutdown completed");
    } catch {
      app.log.error({ event: "shutdown_failed", signal }, "Graceful shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void start().catch(() => {
  process.stderr.write("Anonymous Note server initialization failed. Check environment configuration and startup settings.\n");
  process.exitCode = 1;
});
