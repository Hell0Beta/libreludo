// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ROOM_GRACE_MS,
  SEAT_GRACE_MS,
  SWEEP_INTERVAL_MS,
  createRoomStore,
  isRoomExpired,
  isSeatExpired,
  toSeatSummary,
} from '../rooms.js';

const SECOND = 1000;

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(value) {
      current = value;
      return current;
    },
  };
}

/** A store with a fake clock, a deterministic token source and a room with seats. */
function setup(seats = [{ colour: 'blue', name: 'Alice', isBot: false }]) {
  const clock = makeClock();
  let tokenCount = 0;
  const store = createRoomStore({
    now: clock.now,
    newToken: () => `token-${++tokenCount}`,
  });
  const room = store.createRoom({ hostSocketId: 'host-1' });
  store.declareSeats(room, seats);
  return { clock, store, room };
}

describe('grace period constants', () => {
  it('matches docs/protocol.md §3 exactly', () => {
    expect(SEAT_GRACE_MS).toBe(120_000);
    expect(ROOM_GRACE_MS).toBe(300_000);
    expect(SWEEP_INTERVAL_MS).toBe(30_000);
  });
});

describe('seat summaries', () => {
  it('never exposes the seat token', () => {
    const { store, room } = setup();
    store.claimSeat(room, 'blue', 'controller-1');

    const summary = toSeatSummary(room.seats[0]);
    expect(summary).toEqual({
      colour: 'blue',
      name: 'Alice',
      isBot: false,
      claimed: true,
      connected: true,
      paired: false,
    });
    /*
     * Neither credential may cross this boundary. `pairToken` is weaker than `seatToken` — it cannot
     * reclaim a seat — but it still grants the right to act for one, so broadcasting it to everyone
     * in the room would let any phone in the room play as any player.
     */
    expect('seatToken' in summary).toBe(false);
    expect('pairToken' in summary).toBe(false);
    expect('socketId' in summary).toBe(false);
  });
});

describe('claim, detach, reclaim', () => {
  it('returns the same seat to the same token after a drop', () => {
    const { clock, store, room } = setup();

    const claimed = store.claimSeat(room, 'blue', 'controller-1');
    expect(claimed.ok).toBe(true);
    const token = claimed.token;

    // "Socket disconnect" — the only thing that happens to a seat.
    store.detachSeat(room, 'controller-1');
    expect(room.seats[0].socketId).toBeNull();
    expect(room.seats[0].seatToken).toBe(token);
    expect(room.seats[0].detachedAt).toBe(clock.now());
    expect(isSeatExpired(room.seats[0], clock.now())).toBe(false);

    clock.advance(30 * SECOND);
    const reclaimed = store.reclaimSeat(room, token, 'controller-2');
    expect(reclaimed.ok).toBe(true);
    expect(reclaimed.seat.colour).toBe('blue');
    expect(reclaimed.previousSocketId).toBeNull();
    expect(room.seats[0].socketId).toBe('controller-2');
    expect(room.seats[0].detachedAt).toBeNull();
  });

  it('does not let a bare disconnect free the seat', () => {
    const { store, room } = setup();
    store.claimSeat(room, 'blue', 'controller-1');
    store.detachSeat(room, 'controller-1');

    const stolen = store.claimSeat(room, 'blue', 'controller-2');
    expect(stolen).toEqual({ ok: false, error: 'SEAT_TAKEN' });
  });

  it('rejects a wrong token with BAD_SEAT_TOKEN', () => {
    const { store, room } = setup();
    store.claimSeat(room, 'blue', 'controller-1');

    expect(store.reclaimSeat(room, 'not-a-token', 'controller-2')).toEqual({
      ok: false,
      error: 'BAD_SEAT_TOKEN',
    });
  });

  it('is last writer wins: the previous socket is handed back for eviction', () => {
    const { store, room } = setup();
    store.claimSeat(room, 'blue', 'controller-1');

    const reclaimed = store.reclaimSeat(room, room.seats[0].seatToken, 'controller-2');
    expect(reclaimed.ok).toBe(true);
    expect(reclaimed.previousSocketId).toBe('controller-1');
    expect(room.seats[0].socketId).toBe('controller-2');
  });

  it('refuses a bot seat and a colour that does not exist', () => {
    const { store, room } = setup([
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bot', isBot: true },
    ]);

    expect(store.claimSeat(room, 'red', 'controller-1')).toEqual({
      ok: false,
      error: 'SEAT_IS_BOT',
    });
    expect(store.claimSeat(room, 'green', 'controller-1')).toEqual({
      ok: false,
      error: 'NO_SUCH_SEAT',
    });
  });
});

describe('room:seats replacement', () => {
  it('preserves the claim of an unchanged colour and releases a removed one', () => {
    const { store, room } = setup([
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bob', isBot: false },
    ]);
    store.claimSeat(room, 'blue', 'controller-blue');
    store.claimSeat(room, 'red', 'controller-red');
    const blueToken = room.seats[0].seatToken;
    const redToken = room.seats[1].seatToken;

    // Host re-sends from /setup: Bob is gone, Carol joins, Alice is renamed.
    const { lost } = store.declareSeats(room, [
      { colour: 'blue', name: 'Alice B', isBot: false },
      { colour: 'green', name: 'Carol', isBot: false },
    ]);

    expect(room.seats.map((seat) => seat.colour)).toEqual(['blue', 'green']);
    expect(room.seats[0].name).toBe('Alice B');
    expect(room.seats[0].seatToken).toBe(blueToken);
    expect(room.seats[0].socketId).toBe('controller-blue');
    expect(room.seats[1].seatToken).toBeNull();

    expect(lost).toEqual([{ colour: 'red', socketId: 'controller-red' }]);
    expect(store.reclaimSeat(room, redToken, 'controller-red')).toEqual({
      ok: false,
      error: 'SEAT_EXPIRED',
    });
  });

  it('keeps the seat order the host declared', () => {
    const { store, room } = setup([
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bob', isBot: false },
    ]);
    store.declareSeats(room, [
      { colour: 'red', name: 'Bob', isBot: false },
      { colour: 'blue', name: 'Alice', isBot: false },
    ]);
    expect(room.seats.map((seat) => seat.colour)).toEqual(['red', 'blue']);
  });
});

describe('the sweeper', () => {
  it('KEEPS a room whose host is gone but whose controller is still live', () => {
    const { clock, store, room } = setup([
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bob', isBot: false },
    ]);
    store.claimSeat(room, 'blue', 'controller-blue');
    store.claimSeat(room, 'red', 'controller-red');

    store.detachHost(room, 'host-1');
    clock.advance(ROOM_GRACE_MS + 60 * SECOND); // host gone for six minutes

    const { removed } = store.sweep();
    expect(removed).toEqual([]);
    expect(store.size).toBe(1);
    expect(room.hostSocketId).toBeNull();
    expect(room.seats[0].seatToken).not.toBeNull();
  });

  it('KEEPS a room where the only controller detached recently, long after the host left', () => {
    const { clock, store, room } = setup();
    store.claimSeat(room, 'blue', 'controller-blue');

    store.detachHost(room, 'host-1');
    clock.advance(ROOM_GRACE_MS + 60 * SECOND);
    store.detachSeat(room, 'controller-blue'); // blue's phone just dropped
    clock.advance(30 * SECOND);

    // Host gone 6.5 min, but the seat has only been detached 30 s: both conditions must hold.
    expect(store.sweep().removed).toEqual([]);
    expect(store.size).toBe(1);
    expect(room.seats[0].seatToken).not.toBeNull();
  });

  it('DELETES a room past both grace periods', () => {
    const { clock, store, room } = setup();
    store.claimSeat(room, 'blue', 'controller-blue');

    store.detachHost(room, 'host-1');
    store.detachSeat(room, 'controller-blue');
    clock.advance(ROOM_GRACE_MS + SEAT_GRACE_MS + 1);

    const { removed } = store.sweep();
    expect(removed).toEqual([room]);
    expect(store.size).toBe(0);
    expect(store.getRoom(room.code)).toBeUndefined();
  });

  it('DELETES a host-less room that has no claimed seats at all', () => {
    const { clock, store, room } = setup();
    store.detachHost(room, 'host-1');
    clock.advance(ROOM_GRACE_MS + 1);

    expect(store.sweep().removed).toEqual([room]);
    expect(store.size).toBe(0);
  });

  it('does not delete a room whose host is present', () => {
    const { clock, store } = setup();
    clock.advance(30 * 60 * SECOND);
    expect(store.sweep().removed).toEqual([]);
    expect(store.size).toBe(1);
  });

  it('frees an expired seat while the room lives on', () => {
    const { clock, store, room } = setup();
    const claimed = store.claimSeat(room, 'blue', 'controller-blue');
    const token = claimed.token;

    store.detachSeat(room, 'controller-blue');
    clock.advance(SEAT_GRACE_MS + 1);

    const { removed, expired } = store.sweep();
    expect(removed).toEqual([]); // the host is still here
    expect(expired.map(({ seat }) => seat.colour)).toEqual(['blue']);
    expect(room.seats[0].seatToken).toBeNull();
    expect(room.seats[0].detachedAt).toBeNull();

    // The owner is now told the seat is gone...
    expect(store.reclaimSeat(room, token, 'controller-blue')).toEqual({
      ok: false,
      error: 'SEAT_EXPIRED',
    });
    // ...and someone else can take it.
    expect(store.claimSeat(room, 'blue', 'controller-2').ok).toBe(true);
  });

  it('does not expire a seat that is merely detached', () => {
    const { clock, store, room } = setup();
    store.claimSeat(room, 'blue', 'controller-blue');
    store.detachSeat(room, 'controller-blue');

    clock.advance(SEAT_GRACE_MS - 1);
    expect(store.sweep().expired).toEqual([]);
    expect(room.seats[0].seatToken).not.toBeNull();

    clock.advance(2);
    expect(store.sweep().expired).toHaveLength(1);
  });

  it('treats a claimed seat with no detachedAt as not expired', () => {
    const seat = { colour: 'blue', name: 'Alice', isBot: false, socketId: null, seatToken: 't', detachedAt: null };
    expect(isSeatExpired(seat, 1e15)).toBe(false);
    expect(isRoomExpired({ hostSocketId: null, hostDetachedAt: 0, seats: [seat] }, 1e15)).toBe(false);
  });
});

describe('host lifecycle', () => {
  it('detaches and rebinds the host', () => {
    const { store, room } = setup();
    expect(store.detachHost(room, 'host-1')).toBe(true);
    expect(room.hostSocketId).toBeNull();
    expect(room.hostDetachedAt).not.toBeNull();

    const rehosted = store.rehost(room, 'host-2');
    expect(rehosted).toEqual({ ok: true, wasDetached: true });
    expect(room.hostSocketId).toBe('host-2');
    expect(room.hostDetachedAt).toBeNull();
  });

  it('refuses a second host while the first is attached', () => {
    const { store, room } = setup();
    expect(store.rehost(room, 'host-2')).toEqual({ ok: false, error: 'NOT_HOST' });
    expect(room.hostSocketId).toBe('host-1');
  });

  it('does not report a host-back when the host never left', () => {
    const { store, room } = setup();
    expect(store.rehost(room, 'host-1')).toEqual({ ok: true, wasDetached: false });
  });
});

describe('lookups', () => {
  it('finds a room by its host and a seat by its socket', () => {
    const { store, room } = setup([
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bob', isBot: false },
    ]);
    store.claimSeat(room, 'red', 'controller-red');

    expect(store.findRoomHostedBy('host-1')).toBe(room);
    expect(store.findRoomHostedBy('nobody')).toBeNull();

    const found = store.findSeatBySocket('controller-red');
    expect(found.room).toBe(room);
    expect(found.seat.colour).toBe('red');
    expect(store.findSeatBySocket('nobody')).toBeNull();
  });

  it('normalizes the code on lookup and reuses a released code', () => {
    const { store, room } = setup();
    expect(store.getRoom(room.code.toLowerCase())).toBe(room);
    store.deleteRoom(room.code);
    expect(store.size).toBe(0);
    expect(store.getRoom(room.code)).toBeUndefined();
  });
});

describe('pairing a companion to a seat', () => {
  function setup() {
    // A counter, not a real UUID, so a test can name the tokens it expects.
    let tokenCount = 0;
    const store = createRoomStore({
      now: () => 1_700_000_000_000,
      newToken: () => `token-${++tokenCount}`,
    });
    const room = store.createRoom({ hostSocketId: 'host-1' });
    store.declareSeats(room, [
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bob', isBot: false },
    ]);
    return { store, room };
  }

  it('mints a pair token distinct from the seat token', () => {
    const { store, room } = setup();
    const { seat } = store.claimSeat(room, 'blue', 'pc-1');

    expect(typeof seat.pairToken).toBe('string');
    expect(seat.pairToken).not.toBe(seat.seatToken);
  });

  it('lets a paired socket act for the seat', () => {
    const { store, room } = setup();
    const { seat } = store.claimSeat(room, 'blue', 'pc-1');
    const paired = store.pairSeat(room, seat.pairToken, 'phone-1');

    expect(paired.ok).toBe(true);
    expect(paired.seat.colour).toBe('blue');
    // Both the owner and the companion resolve to the same seat.
    expect(store.findSeatForActor('pc-1').seat.colour).toBe('blue');
    expect(store.findSeatForActor('phone-1').seat.colour).toBe('blue');
    // A socket with neither credential gets nothing.
    expect(store.findSeatForActor('stranger')).toBeNull();
  });

  it('refuses an unknown pair token', () => {
    const { store, room } = setup();
    store.claimSeat(room, 'blue', 'pc-1');

    expect(store.pairSeat(room, 'not-a-real-token', 'phone-1')).toEqual({
      ok: false,
      error: 'BAD_PAIR_TOKEN',
    });
  });

  it('is idempotent, so a reconnecting phone does not accumulate entries', () => {
    const { store, room } = setup();
    const { seat } = store.claimSeat(room, 'blue', 'pc-1');

    store.pairSeat(room, seat.pairToken, 'phone-1');
    store.pairSeat(room, seat.pairToken, 'phone-1');

    expect(seat.companions).toEqual(['phone-1']);
  });

  /*
   * The security property the whole split exists for. A `pairToken` is handed to a phone over a QR
   * code in front of whoever is standing there, so it must not be able to take the seat away from
   * the PC that claimed it — only the `seatToken` may do that.
   */
  it('does not let a companion reclaim the seat', () => {
    const { store, room } = setup();
    const { seat } = store.claimSeat(room, 'blue', 'pc-1');
    store.pairSeat(room, seat.pairToken, 'phone-1');

    const attempt = store.reclaimSeat(room, seat.pairToken, 'phone-1');

    expect(attempt.ok).toBe(false);
    expect(attempt.error).toBe('BAD_SEAT_TOKEN');
    // The owner is untouched.
    expect(seat.socketId).toBe('pc-1');
  });

  it('drops the companion on disconnect, leaving the owner alone', () => {
    const { store, room } = setup();
    const { seat } = store.claimSeat(room, 'blue', 'pc-1');
    store.pairSeat(room, seat.pairToken, 'phone-1');

    const affected = store.detachCompanion('phone-1');

    expect(affected).toHaveLength(1);
    expect(seat.companions).toEqual([]);
    expect(store.findSeatForActor('phone-1')).toBeNull();
    // The PC keeps its seat.
    expect(seat.socketId).toBe('pc-1');
  });

  it('survives a host re-declaring its seats', () => {
    const { store, room } = setup();
    const { seat } = store.claimSeat(room, 'blue', 'pc-1');
    store.pairSeat(room, seat.pairToken, 'phone-1');

    // A host reload re-sends the same colours; claims and pairings must both survive.
    store.declareSeats(room, [
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bob', isBot: false },
    ]);

    const blue = room.seats.find((candidate) => candidate.colour === 'blue');
    expect(blue.seatToken).toBe(seat.seatToken);
    expect(blue.pairToken).toBe(seat.pairToken);
    expect(blue.companions).toEqual(['phone-1']);
  });
});
