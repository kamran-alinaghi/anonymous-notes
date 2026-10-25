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

This commit establishes the application shell, responsive styling, strict TypeScript configuration, and a smoke test. It does not connect to the backend yet. The next step is the typed WebSocket client and connection/session state, followed by create/join room and lobby flows.

Do not store session tokens in URLs, logs, or analytics. The connection implementation will keep session credentials in session-scoped browser storage and handle server-issued token rotation during reconnect.