/**
 * Request/response plumbing shared by the host bridge (`useRoom`) and the controller bridge
 * (`useController`).
 *
 * Socket.IO acks have no timeout of their own: a relay that accepts a connection and then stops
 * answering leaves a caller pending forever, and on a phone that is a spinner that never resolves.
 * Both helpers here turn "no answer" into a value the caller can act on.
 */

import type { Socket } from 'socket.io-client';
import type { TAck } from './protocol';

export const ACK_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 5000;

export function waitForConnect(socket: Socket, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  if (socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const handleConnect = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off('connect', handleConnect);
      resolve(false);
    }, timeoutMs);
    socket.once('connect', handleConnect);
  });
}

/**
 * An ack wrapped in a timeout. `null` means "no answer", which is distinct from a protocol error
 * (`{ ok: false, error }`) — one is a broken relay, the other is a refusal — so callers can word
 * the two differently.
 */
export function emitAck<T>(
  socket: Socket,
  event: string,
  payload: unknown
): Promise<TAck<T> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ACK_TIMEOUT_MS);

    socket.emit(event, payload, (response: TAck<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    });
  });
}
