/**
 * The host's own room pointer, kept in `localStorage` under `libreludo:host` (docs/protocol.md §8).
 *
 * A PC reload must find its way back into the *same* room, because `room:seats` only preserves
 * controllers' claims for unchanged colours **within the same room**. Recreating a fresh room
 * would evict everyone. The value is the documented `{ code }` object.
 *
 * It also holds the host's own **seat** credentials. The host is a player — player 1, the first
 * colour in the sequence — so it claims a seat like anyone else, and needs the same token to get it
 * back after a reload. Keeping both in one record is not tidiness: they have to move together.
 * A record whose seat belongs to a different room than its code would try to reclaim a token the
 * server has never seen, and a fresh room with a stale seat would refuse every phone that scanned
 * the new QR.
 */

const HOST_KEY = 'libreludo:host';

/** The host's own seat: the token that proves it owns the seat, and the colour it owns. */
export type THostSeat = {
  colour: string;
  seatToken: string;
};

type THostRecord = {
  code: string;
  seat?: THostSeat;
};

function readRecord(): THostRecord | null {
  try {
    const raw = localStorage.getItem(HOST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { code?: unknown }).code === 'string'
    ) {
      return parsed as THostRecord;
    }
    return null;
  } catch {
    // Unreadable storage is the same as no room: the menu is a recoverable place to be.
    return null;
  }
}

function writeRecord(record: THostRecord): void {
  try {
    localStorage.setItem(HOST_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable (private mode). The room still works for this session.
  }
}

export function readHostRoom(): string | null {
  return readRecord()?.code ?? null;
}

/**
 * Remember the room. **Drops the seat if the code changed.**
 *
 * A host that ends up in a new room — the old one was swept, or it started a fresh game — is not
 * still player 1 of the room it left. Carrying the token over would send a `room:reclaim` the
 * server answers with `BAD_SEAT_TOKEN`, and the host would spend its first exchange on a refuted
 * claim instead of claiming the seat it actually has.
 */
export function writeHostRoom(code: string): void {
  const existing = readRecord();
  if (existing?.code === code) {
    writeRecord({ code, seat: existing.seat });
    return;
  }
  writeRecord({ code });
}

export function readHostSeat(): THostSeat | null {
  const seat = readRecord()?.seat;
  if (!seat || typeof seat.seatToken !== 'string' || typeof seat.colour !== 'string') return null;
  return seat;
}

/** Only ever written for the room currently in the record — see `writeHostRoom`. */
export function writeHostSeat(seat: THostSeat): void {
  const code = readHostRoom();
  if (!code) return;
  writeRecord({ code, seat });
}

export function clearHostSeat(): void {
  const code = readHostRoom();
  if (!code) return;
  writeRecord({ code });
}

export function clearHostRoom(): void {
  try {
    localStorage.removeItem(HOST_KEY);
  } catch {
    // Ignore.
  }
}
