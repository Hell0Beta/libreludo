/**
 * Lazy singleton Socket.IO client.
 *
 * `socket.io-client` is ~40 KB gzipped and must never enter the local hotseat/bot bundle. It is
 * therefore imported **dynamically**, behind `connect()`, and never at module scope. A type-only
 * import of `Socket` is erased at compile time and costs nothing.
 *
 * Connection is same-origin by default. In production the relay serves the static build and the
 * socket on one port; in dev a Vite proxy forwards `/socket.io` to the relay on 3210 (see
 * `vite.config.ts`), so client code never needs a hardcoded dev URL.
 */

import type { Socket } from 'socket.io-client';

export const SOCKET_PATH = '/socket.io';

let socket: Socket | null = null;
let connecting: Promise<Socket> | null = null;

/**
 * Resolve the singleton socket, creating it on first call. Repeated calls return the same
 * instance, so navigating from the menu to `/room/:code` does not open a second connection
 * (and does not drop the host role).
 */
export function connect(): Promise<Socket> {
  if (socket) return Promise.resolve(socket);
  if (connecting) return connecting;

  connecting = import('socket.io-client')
    .then(({ io }) => {
      if (socket) return socket;
      socket = io({ path: SOCKET_PATH });
      return socket;
    })
    .finally(() => {
      connecting = null;
    });

  return connecting;
}

/** The live socket, or null if `connect()` has not completed yet. */
export function getSocket(): Socket | null {
  return socket;
}

/** Tear the connection down. Used by tests and by an explicit "leave room". */
export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
