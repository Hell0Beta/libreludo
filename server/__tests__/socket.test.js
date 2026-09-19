// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../index.js';
import { ROOM_GRACE_MS, SEAT_GRACE_MS, createRoomStore } from '../rooms.js';

const FIXTURE_BUILD_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'client'
);

const SILENT_LOG = { log() {}, warn() {}, error() {} };

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

/** `emit` with the ack turned into a promise. */
function call(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function collect(socket, event) {
  const received = [];
  socket.on(event, (payload) => received.push(payload));
  return received;
}

async function waitUntil(predicate, label = 'condition', timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('relay server over a real socket', () => {
  let server;
  let store;
  let clock;
  let sockets;

  async function connect() {
    const socket = ioClient(server.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }

  async function createRoom(host, seats) {
    const created = await call(host, 'room:create');
    expect(created.ok).toBe(true);
    if (seats) {
      const declared = await call(host, 'room:seats', { code: created.code, seats });
      expect(declared).toEqual({ ok: true });
    }
    return created.code;
  }

  const HUMANS = [
    { colour: 'blue', name: 'Alice', isBot: false },
    { colour: 'red', name: 'Bob', isBot: false },
    { colour: 'green', name: 'Bot', isBot: true },
  ];

  beforeEach(async () => {
    clock = makeClock();
    store = createRoomStore({ now: clock.now });
    sockets = [];
    server = await startServer({
      port: 0,
      store,
      buildDir: FIXTURE_BUILD_DIR,
      autoSweep: false, // the tests drive the sweeper with the fake clock
      log: SILENT_LOG,
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  });

  it('pairs a phone to a seat a PC owns, and both can act', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);
    const hostSeats = collect(host, 'room:seats');

    const pc = await connect();
    const phone = await connect();

    // The PC takes the seat and is handed both credentials.
    const claimed = await call(pc, 'room:claim', { code, colour: 'blue' });
    expect(claimed.ok).toBe(true);
    expect(typeof claimed.pairToken).toBe('string');
    expect(claimed.pairToken).not.toBe(claimed.seatToken);

    // The phone pairs with the weaker one.
    await call(phone, 'room:join', { code });
    const paired = await call(phone, 'room:pair', { code, pairToken: claimed.pairToken });
    expect(paired).toMatchObject({ ok: true, colour: 'blue', name: 'Alice' });

    // Both sockets now reach the host, stamped with the same colour by the server.
    const intents = collect(host, 'game:intent');
    await call(pc, 'game:intent', { kind: 'roll' });
    await call(phone, 'game:intent', { kind: 'roll' });
    await waitUntil(() => intents.length === 2, 'both intents to reach the host');
    expect(intents.map((intent) => intent.fromColour)).toEqual(['blue', 'blue']);

    // The seat is not handed over: the PC still owns it, and the room can see a phone is paired.
    const blue = hostSeats.at(-1).seats.find((seat) => seat.colour === 'blue');
    expect(blue).toMatchObject({ claimed: true, connected: true, paired: true });
  });

  it('unpairs a phone when it disconnects, without disturbing the owner', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);
    const hostSeats = collect(host, 'room:seats');

    const pc = await connect();
    const phone = await connect();
    const claimed = await call(pc, 'room:claim', { code, colour: 'blue' });
    await call(phone, 'room:join', { code });
    await call(phone, 'room:pair', { code, pairToken: claimed.pairToken });
    await waitUntil(
      () => hostSeats.at(-1)?.seats.find((seat) => seat.colour === 'blue')?.paired === true,
      'the host to see the pairing'
    );

    phone.disconnect();

    await waitUntil(
      () => hostSeats.at(-1)?.seats.find((seat) => seat.colour === 'blue')?.paired === false,
      'the host to see the unpairing'
    );
    // A companion has no grace period, but the owner is untouched by its departure.
    const blue = hostSeats.at(-1).seats.find((seat) => seat.colour === 'blue');
    expect(blue).toMatchObject({ claimed: true, connected: true, paired: false });
  });

  it('refuses a pair token that means nothing', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const phone = await connect();
    await call(phone, 'room:join', { code });

    const ack = await call(phone, 'room:pair', { code, pairToken: 'not-a-real-token' });
    expect(ack).toMatchObject({ ok: false, error: 'BAD_PAIR_TOKEN' });
  });

  it('keeps a paired phone playing when the owner reloads and reclaims', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);
    const hostSeats = collect(host, 'room:seats');

    const pc = await connect();
    const phone = await connect();
    const claimed = await call(pc, 'room:claim', { code, colour: 'blue' });
    await call(phone, 'room:join', { code });
    await call(phone, 'room:pair', { code, pairToken: claimed.pairToken });

    // The PC reloads: its socket dies, then it comes back on a new one with the token it stored.
    pc.disconnect();
    await waitUntil(
      () => store.getRoom(code).seats.find((seat) => seat.colour === 'blue').socketId === null,
      'the owner to detach'
    );
    const reloaded = await connect();
    const reclaimed = await call(reloaded, 'room:reclaim', {
      code,
      seatToken: claimed.seatToken,
    });
    expect(reclaimed.ok).toBe(true);

    /*
     * The phone is not evicted by the owner's return, and it can still play. This is the whole
     * point of separating the two tokens: a reclaim is last-writer-wins, so if the phone had been
     * given the `seatToken` it would have taken the seat rather than sharing it, and if a reclaim
     * dropped companions the reload would silently kick the phone off mid-game.
     */
    const intents = collect(host, 'game:intent');
    await call(phone, 'game:intent', { kind: 'roll' });
    await call(reloaded, 'game:intent', { kind: 'roll' });
    await waitUntil(() => intents.length === 2, 'both actors to reach the host');
    expect(intents.map((intent) => intent.fromColour)).toEqual(['blue', 'blue']);

    const blue = hostSeats.at(-1).seats.find((seat) => seat.colour === 'blue');
    expect(blue).toMatchObject({ claimed: true, connected: true, paired: true });
  });

  it('claims, detaches, and reclaims the same seat', async () => {
    const host = await connect();
    const hostSeats = collect(host, 'room:seats');

    const code = await createRoom(host, HUMANS);
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);

    const controller = await connect();
    const joined = await call(controller, 'room:join', { code });
    expect(joined.ok).toBe(true);
    expect(joined.seats).toEqual([
      { colour: 'blue', name: 'Alice', isBot: false, claimed: false, connected: false, paired: false },
      { colour: 'red', name: 'Bob', isBot: false, claimed: false, connected: false, paired: false },
      { colour: 'green', name: 'Bot', isBot: true, claimed: false, connected: false, paired: false },
    ]);

    const claimed = await call(controller, 'room:claim', { code, colour: 'blue' });
    expect(claimed.ok).toBe(true);
    expect(claimed.colour).toBe('blue');
    expect(claimed.name).toBe('Alice');
    expect(typeof claimed.seatToken).toBe('string');
    const { seatToken, pairToken } = claimed;

    await waitUntil(
      () => hostSeats.at(-1)?.seats[0]?.connected === true,
      'host sees the claim'
    );
    expect(hostSeats.at(-1).seats[0]).toMatchObject({ colour: 'blue', claimed: true });

    // The phone's screen locks. The socket dies.
    controller.disconnect();
    await waitUntil(() => store.getRoom(code).seats[0].socketId === null, 'seat detach');

    await waitUntil(
      () => hostSeats.at(-1)?.seats[0]?.connected === false,
      'host sees the seat go offline'
    );
    expect(hostSeats.at(-1).seats[0].claimed).toBe(true); // still its seat

    // A different phone cannot take it during the grace period.
    const thief = await connect();
    expect(await call(thief, 'room:claim', { code, colour: 'blue' })).toEqual({
      ok: false,
      error: 'SEAT_TAKEN',
    });

    // The original phone comes back.
    clock.advance(90_000);
    const returned = await connect();
    const reclaimed = await call(returned, 'room:reclaim', { code, seatToken });
    /*
     * `pairToken` comes back unchanged. It is not a formality: the QR code a PC shows is rendered
     * from this value, and a PC that reloads reclaims its seat on a brand-new socket. If the token
     * were only ever sent once, at claim, that PC would come back with a board and no way to hand
     * its phone the seat — for the rest of the game.
     */
    expect(reclaimed).toEqual({ ok: true, colour: 'blue', name: 'Alice', pairToken });
    expect(pairToken).not.toBe(seatToken);

    await waitUntil(() => hostSeats.at(-1).seats[0].connected === true, 'host sees the seat return');
    expect(await call(thief, 'room:claim', { code, colour: 'blue' })).toEqual({
      ok: false,
      error: 'SEAT_TAKEN',
    });
  });

  it('rejects a malformed payload with BAD_REQUEST and never touches the room', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const controller = await connect();

    // Not a code from the alphabet.
    expect(await call(controller, 'room:join', { code: 'IIII' })).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
    // Colour outside the enum.
    expect(await call(controller, 'room:claim', { code, colour: 'purple' })).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
    // Empty name.
    expect(
      await call(host, 'room:seats', {
        code,
        seats: [{ colour: 'blue', name: '', isBot: false }],
      })
    ).toEqual({ ok: false, error: 'BAD_REQUEST' });
    // Duplicate colours.
    expect(
      await call(host, 'room:seats', {
        code,
        seats: [
          { colour: 'blue', name: 'Alice', isBot: false },
          { colour: 'blue', name: 'Alice again', isBot: false },
        ],
      })
    ).toEqual({ ok: false, error: 'BAD_REQUEST' });
    // Unknown intent kind.
    expect(await call(controller, 'game:intent', { kind: 'teleport' })).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
    // Not even an object.
    expect(await call(host, 'room:create', 'nope')).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });

    // The seat list is untouched by the rejected room:seats.
    expect(store.getRoom(code).seats.map((seat) => seat.name)).toEqual([
      'Alice',
      'Bob',
      'Bot',
    ]);
  });

  it('accepts a lower-case room code', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const controller = await connect();
    const joined = await call(controller, 'room:join', { code: code.toLowerCase() });
    expect(joined.ok).toBe(true);

    const claimed = await call(controller, 'room:claim', {
      code: code.toLowerCase(),
      colour: 'blue',
    });
    expect(claimed.ok).toBe(true);
    expect(claimed.name).toBe('Alice');
  });

  it('implements every documented error code', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);
    const controller = await connect();

    // NO_SUCH_ROOM — an unknown code that is still well formed.
    expect(await call(controller, 'room:join', { code: 'ZZZZ' })).toEqual({
      ok: false,
      error: 'NO_SUCH_ROOM',
    });
    // NO_SUCH_SEAT
    expect(await call(controller, 'room:claim', { code, colour: 'yellow' })).toEqual({
      ok: false,
      error: 'NO_SUCH_SEAT',
    });
    // SEAT_IS_BOT
    expect(await call(controller, 'room:claim', { code, colour: 'green' })).toEqual({
      ok: false,
      error: 'SEAT_IS_BOT',
    });
    // SEAT_TAKEN
    const claimer = await connect();
    expect((await call(claimer, 'room:claim', { code, colour: 'red' })).ok).toBe(true);
    expect(await call(controller, 'room:claim', { code, colour: 'red' })).toEqual({
      ok: false,
      error: 'SEAT_TAKEN',
    });
    // BAD_SEAT_TOKEN
    expect(await call(controller, 'room:reclaim', { code, seatToken: 'nonsense' })).toEqual({
      ok: false,
      error: 'BAD_SEAT_TOKEN',
    });
    // NOT_SEATED
    expect(await call(controller, 'game:intent', { kind: 'roll' })).toEqual({
      ok: false,
      error: 'NOT_SEATED',
    });
    // NOT_HOST
    expect(await call(controller, 'room:seats', { code, seats: [] })).toEqual({
      ok: false,
      error: 'NOT_HOST',
    });
    // NOT_HOST on rehost, because the host is still attached
    expect(await call(controller, 'room:rehost', { code })).toEqual({
      ok: false,
      error: 'NOT_HOST',
    });
    // BAD_REQUEST
    expect(await call(controller, 'room:claim', { code, colour: 7 })).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });

    // SEAT_EXPIRED — a seat that aged out while the room lived on.
    const seated = await connect();
    const claimed = await call(seated, 'room:claim', { code, colour: 'blue' });
    expect(claimed.ok).toBe(true);
    seated.disconnect();
    await waitUntil(() => store.getRoom(code).seats[0].socketId === null, 'blue detaches');

    clock.advance(SEAT_GRACE_MS + 1);
    server.sweepNow();

    expect(await call(controller, 'room:reclaim', { code, seatToken: claimed.seatToken })).toEqual({
      ok: false,
      error: 'SEAT_EXPIRED',
    });
  });

  it('stamps fromColour from the seat, ignoring anything the client sends', async () => {
    const host = await connect();
    const hostIntents = collect(host, 'game:intent');
    const code = await createRoom(host, HUMANS);

    const controller = await connect();
    await call(controller, 'room:claim', { code, colour: 'blue' });

    expect(await call(controller, 'game:intent', { kind: 'roll', fromColour: 'red' })).toEqual({
      ok: true,
    });
    expect(await call(controller, 'game:intent', { kind: 'move', tokenId: 2 })).toEqual({
      ok: true,
    });

    await waitUntil(() => hostIntents.length >= 2, 'two intents reach the host');
    expect(hostIntents[0]).toEqual({ fromColour: 'blue', kind: 'roll' });
    expect(hostIntents[1]).toEqual({ fromColour: 'blue', kind: 'move', tokenId: 2 });
  });

  it('relays the host projection to controllers but not back to the host', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const controller = await connect();
    await call(controller, 'room:claim', { code, colour: 'blue' });

    const controllerStates = collect(controller, 'game:state');
    const hostStates = collect(host, 'game:state');

    const projection = {
      rev: 1,
      phase: 'playing',
      currentPlayerColour: 'blue',
      isAnyTokenMoving: false,
      isGameEnded: false,
      players: [
        {
          colour: 'blue',
          name: 'Alice',
          isBot: false,
          playerFinishTime: -1,
          tokens: [
            {
              id: 0,
              isActive: true,
              isLocked: false,
              hasTokenReachedHome: false,
              coordinates: { x: 1, y: 2 },
              tokenAlignmentData: { xOffset: 0, yOffset: 0, scaleFactor: 1 },
              direction: null,
            },
          ],
        },
      ],
      dice: [{ colour: 'blue', diceNumber: 6, isPlaceholderShowing: false }],
    };

    expect(await call(host, 'game:state', { projection })).toEqual({ ok: true });

    await waitUntil(() => controllerStates.length >= 1, 'controller receives game:state');
    expect(controllerStates[0]).toEqual({ projection });
    expect(hostStates).toHaveLength(0);

    // A controller cannot push state.
    expect(await call(controller, 'game:state', { projection })).toEqual({
      ok: false,
      error: 'NOT_HOST',
    });
    // A malformed projection is refused before it reaches anyone.
    expect(await call(host, 'game:state', { projection: { rev: 2 } })).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
  });

  it('keeps a room with no host but a live controller, and sweeps it once the controller goes', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const controller = await connect();
    await call(controller, 'room:claim', { code, colour: 'blue' });

    // An idle controller: joined, subscribed, holding no seat.
    const watcher = await connect();
    await call(watcher, 'room:join', { code });

    const hostGone = collect(controller, 'room:host-gone');
    const watcherErrors = collect(watcher, 'room:error');

    host.disconnect();
    await waitUntil(() => store.getRoom(code).hostSocketId === null, 'host detaches');
    await waitUntil(() => hostGone.length === 1, 'controller is told the host is gone');
    expect(typeof hostGone[0].since).toBe('number');

    // Five minutes later the controller is still there: the room must survive.
    clock.advance(ROOM_GRACE_MS + 60_000);
    server.sweepNow();
    expect(store.getRoom(code)).toBeDefined();
    expect(watcherErrors).toHaveLength(0);

    // The controller leaves too.
    controller.disconnect();
    await waitUntil(() => store.getRoom(code).seats[0].socketId === null, 'controller detaches');

    clock.advance(SEAT_GRACE_MS + 1);
    const { removed } = server.sweepNow();
    expect(removed.map((room) => room.code)).toEqual([code]);
    expect(store.getRoom(code)).toBeUndefined();

    // The watcher was never a seat holder, so nothing detached it — it learns from room:error.
    await waitUntil(() => watcherErrors.length === 1, 'the idle controller is told the room is gone');
    expect(watcherErrors[0]).toEqual({ error: 'NO_SUCH_ROOM', code });

    expect(await call(watcher, 'room:join', { code })).toEqual({
      ok: false,
      error: 'NO_SUCH_ROOM',
    });
  });

  it('lets the host rebuild its claim after a reload by re-sending room:seats', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const controller = await connect();
    const claimed = await call(controller, 'room:claim', { code, colour: 'blue' });
    expect(claimed.ok).toBe(true);

    const controllerSeatUpdates = collect(controller, 'room:seats');
    const hostBack = collect(controller, 'room:host-back');

    host.disconnect();
    await waitUntil(() => store.getRoom(code).hostSocketId === null, 'host detaches');

    const reloaded = await connect();
    const rehosted = await call(reloaded, 'room:rehost', { code });
    expect(rehosted.ok).toBe(true);
    expect(rehosted.seats[0]).toMatchObject({ colour: 'blue', claimed: true, connected: true });

    await waitUntil(() => hostBack.length === 1, 'controllers see the host return');

    // The reloaded host re-sends the same seat list; the controller keeps its seat.
    expect(await call(reloaded, 'room:seats', { code, seats: HUMANS })).toEqual({ ok: true });
    expect(store.getRoom(code).seats[0].seatToken).toBe(claimed.seatToken);
    expect(store.getRoom(code).seats[0].socketId).toBeTruthy();

    await waitUntil(() => controllerSeatUpdates.length >= 1, 'controllers get a seat update');
    const latest = controllerSeatUpdates.at(-1);
    expect(latest.hostPresent).toBe(true);
    expect(latest.seats[0]).toMatchObject({ colour: 'blue', claimed: true, connected: true });
  });

  it('detaches the previous socket when a seat is reclaimed elsewhere', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const first = await connect();
    const claimed = await call(first, 'room:claim', { code, colour: 'blue' });
    const lost = collect(first, 'room:seat-lost');

    const second = await connect();
    const reclaimed = await call(second, 'room:reclaim', {
      code,
      seatToken: claimed.seatToken,
    });
    expect(reclaimed.ok).toBe(true);

    await waitUntil(() => lost.length === 1, 'the first socket is evicted');
    expect(lost[0]).toEqual({ reason: 'removed' });
    expect(store.getRoom(code).seats[0].socketId).not.toBe(first.id);

    // Intents now come from the new socket's seat.
    const intents = collect(host, 'game:intent');
    await call(second, 'game:intent', { kind: 'roll' });
    expect(await call(first, 'game:intent', { kind: 'roll' })).toEqual({
      ok: false,
      error: 'NOT_SEATED',
    });
    await waitUntil(() => intents.length >= 1, 'the current socket can still act');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toEqual({ fromColour: 'blue', kind: 'roll' });
  });

  it('tells a controller when the host removes its colour', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const controller = await connect();
    await call(controller, 'room:claim', { code, colour: 'red' });
    const lost = collect(controller, 'room:seat-lost');

    expect(
      await call(host, 'room:seats', {
        code,
        seats: [{ colour: 'blue', name: 'Alice', isBot: false }],
      })
    ).toEqual({ ok: true });

    await waitUntil(() => lost.length === 1, 'controller is told its seat is gone');
    expect(lost[0]).toEqual({ reason: 'removed' });
    expect(store.getRoom(code).seats.map((seat) => seat.colour)).toEqual(['blue']);
  });

  it('releases the room a socket already hosts when it creates another', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);

    const controller = await connect();
    await call(controller, 'room:join', { code });
    await call(controller, 'room:claim', { code, colour: 'blue' });
    const roomError = collect(controller, 'room:error');

    const created = await call(host, 'room:create');
    expect(created.ok).toBe(true);
    expect(created.code).not.toBe(code);
    expect(store.getRoom(code)).toBeUndefined();
    expect(store.size).toBe(1);

    // A controller left behind in the abandoned room must be told, or it would keep rendering
    // stale state forever with no way to recover.
    await waitUntil(() => roomError.length === 1, 'the abandoned room is reported');
    expect(roomError[0]).toEqual({ error: 'NO_SUCH_ROOM', code });
  });

  it('keeps the room and the claim when the host socket drops', async () => {
    const host = await connect();
    const code = await createRoom(host, HUMANS);
    host.disconnect();
    await waitUntil(() => store.getRoom(code)?.hostSocketId === null, 'host detaches');

    expect(store.getRoom(code).seats).toHaveLength(3);
    expect(store.size).toBe(1);
  });
});
