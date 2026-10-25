# Anonymous Note web client

React + TypeScript frontend built with Vite. The client will use the browser WebSocket API to communicate with the existing Fastify server and Zustand for shared UI/session state.

## Prerequisites

- Node.js 22.9 or newer
- npm

## Local development

From the `web/` directory:

```bash
npm install
npm run dev
```

Vite prints the local development URL after startup.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run verify
```

## Current scope

The app shell and the typed WebSocket connection/session client are in place. The client waits for the server's `CONNECTED` handshake, correlates requests by `requestId`, stores server-issued reconnect credentials in `sessionStorage`, rotates credentials after successful restoration, and retries dropped connections with bounded exponential backoff. If restoration fails, it clears the stale credential and requires the user to choose their next action; it never creates a replacement identity automatically.

The connection client is not yet wired into the visible app shell. The next step is the create/join room flow and lobby UI.

Do not store session tokens in URLs, logs, or analytics. The server keeps room and reconnect state in memory, so a server restart invalidates active sessions.