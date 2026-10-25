# Anonymous Note web client

React + TypeScript frontend built with Vite. The browser WebSocket API communicates with the Fastify server.

## Prerequisites

- Node.js 22.9 or newer
- npm

## Local development

From the `web/` directory:

```bash
npm install
npm run dev
```

Vite prints the local development URL after startup. By default, the frontend connects to `ws://<current-hostname>:3000/ws` (or `wss://` when the page uses HTTPS). To configure a different backend URL, set `VITE_WS_URL` in a local `.env` file, for example:

```dotenv
VITE_WS_URL=ws://127.0.0.1:3000/ws
```

Do not put session credentials or other secrets in Vite environment variables; variables prefixed with `VITE_` are exposed to the browser.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run verify
```

## Current scope

The frontend supports creating a room, joining a room with a six-letter code, selecting the reveal mode, viewing the lobby, copying the room code, reordering players as host, and starting the game. During gameplay, the designated player can submit a subject (up to 300 characters); each actual player writes one note of up to 1,000 characters for every other actual player and submits the complete batch atomically. The UI shows submission progress, with per-player submission status visible only to the host. It displays connection status and server errors and restores the current game phase when a valid session reconnects.

The WebSocket client waits for the server's `CONNECTED` handshake, correlates requests by `requestId`, stores server-issued reconnect credentials in `sessionStorage`, rotates credentials after successful restoration, and retries dropped connections with bounded exponential backoff. If restoration fails, it clears the stale credential and requires the user to choose their next action; it never creates a replacement identity automatically.

The reveal, round-completion, and game-finished screens are not implemented yet. The server keeps room and reconnect state in memory, so a server restart invalidates active sessions. Do not store session tokens in URLs, logs, or analytics.
