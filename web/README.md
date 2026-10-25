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

The frontend supports creating a room, joining a room with a six-letter code, selecting the reveal mode, viewing the lobby, copying the room code, reordering players as host, and starting the game. It displays connection status and server errors and restores the lobby when a valid session reconnects while the room is still in the lobby phase.

The WebSocket client waits for the server's `CONNECTED` handshake, correlates requests by `requestId`, stores server-issued reconnect credentials in `sessionStorage`, rotates credentials after successful restoration, and retries dropped connections with bounded exponential backoff. If restoration fails, it clears the stale credential and requires the user to choose their next action; it never creates a replacement identity automatically.

The subject-selection and note-writing screens are not implemented yet. The server keeps room and reconnect state in memory, so a server restart invalidates active sessions. Do not store session tokens in URLs, logs, or analytics.
