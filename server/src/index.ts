/**
 * exvibe local companion server — Bun.serve entrypoint.
 * All routing lives in src/routes/router.ts (see docs/DASHBOARD-SPEC.md
 * "Server API" for the contract).
 */

import { handleRequest } from './routes/router';

const port = Number(process.env['EXVIBE_PORT'] ?? 7878);

const server = Bun.serve({
  port,
  hostname: '127.0.0.1', // loopback only
  // /refresh runs the full pipeline (many claude calls, ~minutes) inside one
  // request — disable the connection idle timeout so it isn't cut off.
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(`exvibe server listening on http://127.0.0.1:${server.port}`);
