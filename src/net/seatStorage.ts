/**
 * A controller's own seat pointer, kept in `localStorage` under `libreludo:seat:<CODE>`
 * (docs/protocol.md §4, `room:claim`).
 *
 * The key is per room on purpose. One phone may hold a seat in a room, wander off, and be used to
 * join a different room later; a single global key would make the second room's join look like a
 * reclaim against the first and silently drop the first seat.
 *
 * The `seatToken` is the *only* proof of ownership. It is never sent to the host, never rendered,
 * and never leaves this device — losing it means losing the seat, which is why it is written the
 * moment `room:claim` acks and cleared only when the server says the seat is gone.
 */

const PREFIX = 'libreludo:seat:';

export type TStoredSeat = {
  code: string;
  seatToken: string;
  colour: string;
};

function keyFor(code: string): string {
  return `${PREFIX}${code.toUpperCase()}`;
}

export function readSeat(code: string): TStoredSeat | null {
  try {
    const raw = localStorage.getItem(keyFor(code));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as TStoredSeat).seatToken === 'string'
    ) {
      return parsed as TStoredSeat;
    }
    return null;
  } catch {
    // Unreadable storage is the same as no seat: the picker is a recoverable place to be.
    return null;
  }
}

export function writeSeat(seat: TStoredSeat): void {
  try {
    localStorage.setItem(keyFor(seat.code), JSON.stringify(seat));
  } catch {
    // Private mode. The seat still works for this tab's lifetime; a reload will re-pick.
  }
}

export function clearSeat(code: string): void {
  try {
    localStorage.removeItem(keyFor(code));
  } catch {
    // Ignore.
  }
}
