/**
 * Read-only HTTP surface for external integrations (issue #45) -- e.g. the
 * Dream Walkers website displaying active/historical pickups without
 * scraping Discord messages.
 *
 * Deliberately not a framework-backed app: three known routes, no request
 * bodies (nothing here ever mutates), no templating -- node:http's own
 * routing is a smaller, more honest surface than pulling in express for
 * this, matching every other "hand-roll it" call already made in this
 * codebase (config.ts's env loading, every repository's own hydrate()).
 *
 * Starts independently of the Discord client -- it serves persisted SQLite
 * state, so gating it behind ClientReady would make an external consumer's
 * availability hostage to gateway login latency for no reason. See
 * index.ts for how this is started/stopped alongside the bot.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAuthorized } from './auth.js';
import { handleGetPickup, handleListPickups, type RouteResult } from './routes.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const PICKUPS_PATH = /^\/api\/pickups\/?$/;
const PICKUP_BY_ID_PATH = /^\/api\/pickups\/(\d+)$/;

/**
 * The request handler, exported separately from `startApiServer` so tests
 * can drive a real listener (bind to 127.0.0.1:0, read back the OS-assigned
 * port) without going through this module's own start/stop lifecycle.
 */
export function createApiServer(apiKey: string): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // /api/health is a liveness probe for Railway's own health checking,
    // deliberately unauthenticated (like any standard health endpoint) --
    // it confirms nothing more sensitive than "the process is up," so
    // gating it behind the API key would only make platform monitoring
    // depend on a secret it has no other reason to hold.
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (!isAuthorized(req, apiKey)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://internal');
    const { pathname, searchParams } = url;

    const isPickupsList = PICKUPS_PATH.test(pathname);
    const byIdMatch = PICKUP_BY_ID_PATH.exec(pathname);

    let result: RouteResult;
    if (req.method === 'GET' && isPickupsList) {
      result = handleListPickups(searchParams);
    } else if (req.method === 'GET' && byIdMatch) {
      result = handleGetPickup(Number(byIdMatch[1]));
    } else if (isPickupsList || byIdMatch) {
      // A known path hit with the wrong method -- 405, not 404. This is
      // what makes "no mutation endpoints" observable: POST /api/pickups
      // lands here, not in the 404 branch below.
      result = { status: 405, body: { error: 'method_not_allowed' } };
    } else {
      result = { status: 404, body: { error: 'not_found' } };
    }

    sendJson(res, result.status, result.body);
  });
}

/**
 * The single live server, started from index.ts's ready-independent boot
 * sequence. Same singleton-stop-function guard as the three poll workers in
 * notifications.ts/auto-finish.ts/message-cleanup.ts -- a second call
 * returns the already-running server's own stopper rather than binding a
 * second listener on the same port (which would fail anyway, but this way
 * it fails loudly never, not with an EADDRINUSE surprise).
 */
let stopRunningServer: (() => void) | null = null;

export function startApiServer(port: number, apiKey: string): () => void {
  if (stopRunningServer) return stopRunningServer;

  const server = createApiServer(apiKey);
  server.listen(port);

  stopRunningServer = () => {
    server.close();
    stopRunningServer = null;
  };
  return stopRunningServer;
}
