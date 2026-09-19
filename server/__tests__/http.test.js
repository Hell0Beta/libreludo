// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../index.js';
import { createRoomStore } from '../rooms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_BUILD_DIR = path.resolve(HERE, 'fixtures', 'client');
const MISSING_BUILD_DIR = path.resolve(HERE, 'fixtures', 'does-not-exist');

const SHELL_MARKER = 'LIBRELUDO_TEST_SHELL';
const SILENT_LOG = { log() {}, warn() {}, error() {} };

describe('the HTTP surface', () => {
  let server;
  const sockets = [];

  async function start(options = {}) {
    server = await startServer({
      port: 0,
      store: createRoomStore(),
      buildDir: FIXTURE_BUILD_DIR,
      autoSweep: false,
      log: SILENT_LOG,
      ...options,
    });
    return server;
  }

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
    await server?.close();
  });

  it('answers /healthz with the live room count', async () => {
    const { url, store } = await start();

    const empty = await fetch(`${url}/healthz`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ ok: true, rooms: 0 });

    store.createRoom({ hostSocketId: 'host-1' });
    store.createRoom({ hostSocketId: 'host-2' });

    const busy = await fetch(`${url}/healthz`);
    expect(await busy.json()).toEqual({ ok: true, rooms: 2 });
  });

  it('serves the SPA shell for an unknown path', async () => {
    const { url } = await start();

    const root = await fetch(`${url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain(SHELL_MARKER);

    const deep = await fetch(`${url}/room/AB2C`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toContain('text/html');
    expect(await deep.text()).toContain(SHELL_MARKER);
  });

  it('does not let the SPA fallback swallow /socket.io/', async () => {
    const { url } = await start();

    // A real polling handshake: Socket.IO answers it, the shell does not.
    const handshake = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);
    expect(handshake.status).toBe(200);
    const body = await handshake.text();
    expect(body.startsWith('0{')).toBe(true);
    expect(body).toContain('"sid"');
    expect(body).not.toContain(SHELL_MARKER);

    // A bare request to the socket path is refused by Socket.IO, not answered with HTML.
    const bare = await fetch(`${url}/socket.io/`);
    expect(bare.status).toBe(400);
    expect(await bare.text()).not.toContain(SHELL_MARKER);
  });

  it('falls back only for GET and HEAD', async () => {
    const { url } = await start();
    const posted = await fetch(`${url}/room/AB2C`, { method: 'POST' });
    expect(posted.status).toBe(404);
  });

  it('still serves the socket layer when the client build is absent', async () => {
    const { url, store } = await start({ buildDir: MISSING_BUILD_DIR });

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);

    const page = await fetch(`${url}/`);
    expect(page.status).toBe(503);

    const socket = ioClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });

    const created = await new Promise((resolve) =>
      socket.emit('room:create', {}, resolve)
    );
    expect(created.ok).toBe(true);
    expect(store.size).toBe(1);

    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true, rooms: 1 });
  });
});
