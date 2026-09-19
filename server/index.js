/**
 * One Node process: the static client build, `/healthz`, and Socket.IO, all on one port.
 *
 * Binds 127.0.0.1 by default. The container is fronted by `tailscale serve`, which terminates
 * HTTPS and proxies to this port; the socket port is never exposed publicly.
 *
 *   node server/index.js
 *   PORT=3210 BUILD_DIR=build/client node server/index.js
 *
 * `/socket.io/` is registered before the catch-all static handler. Socket.IO owns that path at
 * the HTTP-server level, so it can never be served the SPA shell — the guard in the fallback
 * exists to keep that true if the wiring is ever rearranged.
 */

import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRoomStore } from './rooms.js';
import { attachSocketServer } from './socket.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BUILD_DIR = path.resolve(HERE, '..', 'build', 'client');
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Deliberately *not* 3000. That is the conventional Node port, which is exactly why it is a bad
 * choice here: Docker Desktop's backend squats 127.0.0.1:3000 on Windows, so a dev relay cannot
 * bind it and the Vite dev proxy quietly forwards `/socket.io` into Docker instead — which answers
 * 404. The symptom is a wall of `GET /socket.io?EIO=4 404` in the browser and "Could not reach the
 * relay" in the UI, with nothing anywhere saying the port was the problem.
 *
 * The container still uses 3000 internally (see Dockerfile / docker-compose.yml). That is a
 * different network namespace with no Docker Desktop in it, so there is nothing to collide with.
 */
export const DEFAULT_PORT = 3210;

/** The path Socket.IO owns. Never let the SPA fallback answer for it. */
export const SOCKET_PATH = '/socket.io/';

/**
 * True for `/socket.io/...` *and* for a bare `/socket.io`.
 *
 * engine.io-client normalises its `path` option by appending a trailing slash
 * (`addTrailingSlash`, on by default), so the real client only ever asks for the slashed form and
 * this distinction never comes up in practice. It is here because the failure it prevents is
 * nasty: a bare `/socket.io` matches neither engine.io's prefix check nor a slashed guard, so it
 * falls through to the SPA fallback and gets **200 text/html** — a successful-looking response
 * carrying a page of HTML where the client expected a protocol handshake. Guarding both forms
 * turns that into an honest 404 for anything that isn't Socket.IO traffic.
 */
export function isSocketPath(reqPath) {
  return reqPath === SOCKET_PATH.replace(/\/$/, '') || reqPath.startsWith(SOCKET_PATH);
}

/**
 * @param {object} [options]
 * @param {string} [options.buildDir]
 * @param {ReturnType<createRoomStore>} options.store
 * @param {Console} [options.log]
 */
export function createApp({ buildDir = DEFAULT_BUILD_DIR, store, log = console } = {}) {
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, rooms: store.size });
  });

  const hasClientBuild = existsSync(path.join(buildDir, 'index.html'));
  if (!hasClientBuild) {
    log.warn(
      `[server] no client build at ${buildDir} — serving the socket layer only. Run \`pnpm build\`.`
    );
  }

  if (hasClientBuild) {
    // Serves real files (including `/` -> index.html). Anything unmatched falls through.
    app.use(express.static(buildDir, { index: 'index.html' }));
  }

  // SPA fallback. Deliberately last, and deliberately deaf to the socket path.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isSocketPath(req.path)) return next();

    if (!hasClientBuild) {
      res
        .status(503)
        .type('text/plain')
        .send('LibreLudo client build not found. Run `pnpm build` and restart the server.');
      return;
    }

    res.sendFile('index.html', { root: buildDir });
  });

  return app;
}

/**
 * Start the process. Returns handles rather than listening on import, so tests can drive it.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host]
 * @param {string} [options.buildDir]
 * @param {ReturnType<createRoomStore>} [options.store]
 * @param {boolean} [options.autoSweep]
 * @param {Console} [options.log]
 */
export async function startServer({
  port = Number(process.env.PORT ?? DEFAULT_PORT),
  host = process.env.HOST ?? DEFAULT_HOST,
  buildDir = process.env.BUILD_DIR ?? DEFAULT_BUILD_DIR,
  store = createRoomStore(),
  autoSweep = true,
  log = console,
} = {}) {
  const app = createApp({ buildDir, store, log });
  const httpServer = createHttpServer(app);

  // Socket.IO first: it claims /socket.io/ before Express sees a single request.
  const { io, sweepNow, stopSweeper } = attachSocketServer(httpServer, { store, log, autoSweep });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  const close = () =>
    new Promise((resolve) => {
      stopSweeper();
      io.close(() => {
        try {
          httpServer.close();
        } catch {
          // Already closed by io.close().
        }
        resolve();
      });
    });

  return { app, httpServer, io, store, sweepNow, close, port: boundPort, url: `http://${host}:${boundPort}` };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  try {
    const { url } = await startServer({ port, host });
    console.log(`[server] listening on ${url} (internal only — put tailscale serve in front)`);
  } catch (error) {
    // A bare stack trace here sends people looking for a bug in the code. The overwhelmingly
    // likely cause is another program on the port, and the fix is one line.
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `[server] port ${port} is already in use by another program.\n` +
          `[server] Start on a free one instead — PORT=3211 pnpm server — and set the same port in\n` +
          `[server] the '/socket.io' proxy target in vite.config.ts.`
      );
      process.exit(1);
    }
    throw error;
  }
}
