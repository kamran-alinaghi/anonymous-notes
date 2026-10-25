# Anonymous Note server

TypeScript backend for Anonymous Note, built with Node.js, Fastify, and `@fastify/websocket`.

## Prerequisites

- Node.js 22 or newer
- npm (the version bundled with your Node.js installation)

## Local development

From the `server/` directory:

```bash
npm ci
cp .env.example .env
npm run dev
```

On Windows PowerShell, copy the example with:

```powershell
Copy-Item .env.example .env
```

The development command loads `.env` when present and watches TypeScript source files. The default listener is `127.0.0.1:3000`. Use `http://127.0.0.1:3000/health` to check the health endpoint and `ws://127.0.0.1:3000/ws` for WebSocket connections.

## Environment variables

All settings are validated at startup. Invalid values stop startup with an error naming the setting; secret values are not printed.

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | One of `development`, `test`, or `production`. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` inside a container when required. |
| `PORT` | `3000` | TCP port, from 1 through 65535. |
| `LOG_LEVEL` | `debug` in development; `info` otherwise | Fastify log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. |
| `ALLOWED_ORIGINS` | empty outside production | Comma-separated exact HTTP(S) origins allowed to open browser WebSocket connections. Required in production. Do not include paths. |
| `MAX_WS_CONNECTIONS` | `1000` | Maximum concurrent WebSocket connections per process. |
| `MAX_WS_MESSAGES_PER_MINUTE` | `120` | Maximum inbound messages per connection in a rolling one-minute window. Exceeding the limit closes that connection. |
| `MAX_WS_MESSAGE_BYTES` | `262144` | Maximum WebSocket message payload size in bytes. Valid range: 1 KiB through 10 MiB. |

Copy `.env.example` to `.env` for local development. Do not commit `.env` or put session tokens, credentials, or other secrets in configuration files. Deployment environments should supply variables through their secret/configuration facility. This server currently has no application secret that must be configured.

Browser clients must send an `Origin` matching one of the configured `ALLOWED_ORIGINS`. Connections without an Origin header are permitted for non-browser clients; do not treat Origin checking as authentication. Session credentials remain the authentication mechanism.

## Tests and quality checks

```bash
npm test
npm run typecheck
npm run build
npm run verify
npm audit --omit=dev
```

- `npm test` runs the Vitest suite.
- `npm run typecheck` runs strict TypeScript checks without emitting files.
- `npm run build` compiles `src/` to `dist/`.
- `npm run verify` runs tests, typecheck, and build in sequence.
- `npm audit --omit=dev` checks the production dependency tree against the npm advisory database.

The GitHub Actions workflow runs install, verification, and the production dependency audit on changes affecting the server.

## Production startup

Set production variables in the deployment environment. At minimum, set `NODE_ENV=production`, `HOST`, `PORT`, and `ALLOWED_ORIGINS`. For example:

```bash
NODE_ENV=production HOST=0.0.0.0 PORT=3000 ALLOWED_ORIGINS=https://your-frontend.example npm run build
NODE_ENV=production HOST=0.0.0.0 PORT=3000 ALLOWED_ORIGINS=https://your-frontend.example npm start
```

The `start` script loads a local `.env` if present, then runs the compiled `dist/server.js`. In a container or hosting platform, configure the variables in the platform and expose the selected port. Terminate the process with `SIGTERM` (normal platform shutdown) or `SIGINT` (Ctrl+C). The server stops accepting new work, closes active WebSocket connections with a going-away status, clears in-memory connection credentials, and closes Fastify resources.

Terminate TLS at a trusted reverse proxy or hosting platform. Keep the server listener private to that proxy when practical. Configure the platform's health check to request `GET /health`.

## Runtime behavior and limitations

- Room state, player membership, reconnect credentials, and game progress live in memory only. Restarting the process loses active games and invalidates reconnect credentials.
- The service is single-process. Multiple replicas do not share rooms, connection state, or credentials; do not scale horizontally without adding a shared state/coordination design.
- WebSocket connection, payload, and message-rate limits apply per process or connection as documented above. These are safeguards, not a replacement for edge-level denial-of-service protection.
- The health endpoint confirms that the HTTP process responds; it does not prove that a game can survive a restart or that external infrastructure is healthy.
- Operational logs include connection and lifecycle metadata only. They must not contain note text, session tokens, or credentials.
- Production readiness still depends on deployment-specific TLS, network policy, log retention, monitoring, and an explicit data-retention/privacy review.
