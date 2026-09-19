// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:3111" }
/**
 * The host bridge, end to end: the real `useRoom` hook, the real Redux store, and the real relay
 * server over a real socket.
 *
 * This is the test that was missing when the networking landed. `projection.test.ts` proves the
 * pure function and `guards.test.ts` proves the pure predicates, but neither proves the *wiring* —
 * that a store change actually reaches a phone, that a phone's intent actually reaches the store,
 * and that the guard is actually consulted in between. Those are the parts a static gate cannot
 * check and that a reader is most likely to get subtly wrong.
 *
 * The relay runs as a child process rather than an import: `server/` is plain ESM JavaScript with
 * no TypeScript project, so importing it from this type-checked `tests/` tree would need a
 * hand-written declaration that could drift. A real process is also a truer test — it exercises the
 * actual entry point, not a test-only construction of it.
 *
 * jsdom's URL is pinned to the relay's port by the `@vitest-environment-options` line above, which
 * is what lets the same-origin `io({ path })` in `src/net/socket.ts` resolve here without the
 * production code knowing it is under test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { io as ioClient, type Socket as ControllerSocket } from 'socket.io-client';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `useRoom` reaches for exactly one thing in `react-router` — `useNavigate`, to rewrite the URL
 * when a room had to be recreated under a new code. The real module cannot be imported here: the
 * `reactRouter()` vite plugin injects a browser-only preamble check into every module that imports
 * it, and under vitest that throws "can't detect preamble" before a single test runs. Stubbing the
 * one hook the bridge uses avoids pulling the router runtime into a test that is about sockets.
 */
const navigate = vi.fn();
vi.mock('react-router', () => ({ useNavigate: () => navigate }));

import { hydrateRootState, store } from '../../src/state/store';
import { DUMMY_STATE } from '../fixtures/state.dummy';
import { useRoom } from '../../src/net/useRoom';
import { disconnectSocket } from '../../src/net/socket';
import type { TProjection } from '../../src/net/protocol';
import { activateTokens, registerNewPlayer, setPlayerSequence } from '../../src/state/slices/playersSlice';
import { registerDice } from '../../src/state/slices/diceSlice';
import { clearRoomState } from '../../src/state/slices/roomSlice';

const PORT = 3111;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST_KEY = 'libreludo:host';

/** React only batches into `act` when the environment says it is a test. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The latest value `useRoom` returned, so assertions can read what the host bridge exposes. */
type TRoom = ReturnType<typeof useRoom>;
let room: TRoom | null = null;

/** Stable identity, so the capture effect below re-runs only when the hook value itself changes. */
function capture(value: TRoom) {
  room = value;
}

function Harness({ code }: { code?: string }) {
  const value = useRoom({ code });
  // Captured in an effect rather than during render: assigning to an outer variable while
  // rendering is a side effect, and React may render without committing.
  useEffect(() => capture(value), [value]);
  return null;
}

/**
 * An ack turned into a promise, so a failure surfaces as a value rather than a hang.
 *
 * Wrapped in `act` because every one of these calls makes the server broadcast back to the host
 * bridge under test. Without the wrapper React dispatches outside `act` and warns — and only when
 * the timing happens to fall that way, which made it look like flakiness from unrelated files.
 */
async function call<T = Record<string, unknown>>(
  socket: ControllerSocket,
  event: string,
  payload: unknown = {}
): Promise<{ ok: boolean; error?: string } & Partial<T>> {
  let response!: { ok: boolean; error?: string } & Partial<T>;
  await act(async () => {
    response = await new Promise((resolve) => socket.emit(event, payload, resolve));
  });
  return response;
}

function collect<T>(socket: ControllerSocket, event: string): T[] {
  const received: T[] = [];
  socket.on(event, (payload: T) => received.push(payload));
  return received;
}

async function waitUntil(predicate: () => boolean, label: string, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Register a three-human game. `playerSequences` is keyed by the *word*, not the number. */
function seedLocalGame() {
  store.dispatch(hydrateRootState(structuredClone(DUMMY_STATE)));
  store.dispatch(registerNewPlayer({ name: 'Alice', colour: 'blue', isBot: false }));
  store.dispatch(registerNewPlayer({ name: 'Bob', colour: 'red', isBot: false }));
  store.dispatch(registerNewPlayer({ name: 'Carol', colour: 'green', isBot: false }));
  store.dispatch(setPlayerSequence({ playerCount: 'three' }));
  for (const colour of ['blue', 'red', 'green'] as const) store.dispatch(registerDice(colour));
}

describe('net/useRoom — the host bridge against a live relay', () => {
  let child: ChildProcess;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let controllers: ControllerSocket[] = [];

  /** Connect a stand-in phone. */
  async function phone(): Promise<ControllerSocket> {
    const socket = ioClient(ORIGIN, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    controllers.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(undefined));
      socket.once('connect_error', reject);
    });
    return socket;
  }

  /** Mount the bridge and wait until it has a room and is connected. */
  async function mountHost(code?: string) {
    act(() => {
      root?.unmount();
      container?.remove();
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      root.render(
        <Provider store={store}>
          <Harness code={code} />
        </Provider>
      );
    });
    await waitUntil(() => room?.code != null && room.status === 'connected', 'the host to join');
    // The host claims player 1 as part of joining. Most tests want that settled before they act,
    // because until it lands the seat list still describes blue as free.
    await waitUntil(() => store.getState().room.hostSeat != null, 'the host to claim player 1');
    return room!.code!;
  }

  /**
   * Play the host's own seat the way a phone now has to: by **pairing**, not claiming.
   *
   * Player 1 belongs to the board, so `room:claim` for blue is refused with `SEAT_TAKEN`. These
   * tests all want blue, because blue is the colour to play — so the way in is the QR on the host's
   * spirit card, and the token that QR encodes is the one the host earned when it claimed the seat.
   *
   * This is the honest path rather than a workaround: a phone that wants to play against the board
   * is exactly the case pairing exists for.
   */
  async function pairToHostSeat(code: string, controller: ControllerSocket) {
    const { pairToken } = store.getState().room.hostSeat!;
    await call(controller, 'room:join', { code });
    const ack = await call(controller, 'room:pair', { code, pairToken });
    expect(ack.ok).toBe(true);
  }

  beforeAll(async () => {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });

    const deadline = Date.now() + 20_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const res = await fetch(`${ORIGIN}/healthz`);
        up = res.ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!up) throw new Error(`the relay never came up on ${ORIGIN}`);
  }, 30_000);

  afterAll(async () => {
    child?.kill();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  beforeEach(() => {
    seedLocalGame();
    localStorage.removeItem(HOST_KEY);
    /*
     * The store is a module singleton, so room state outlives a test. `hostSeat` in particular is
     * an in-memory secret the host earns per room: leaving it behind would let the next test pair
     * with the previous test's token before its own claim had landed.
     */
    store.dispatch(clearRoomState());
    room = null;
  });

  afterEach(async () => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    for (const socket of controllers) socket.disconnect();
    controllers = [];
    disconnectSocket();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('creates a room and exposes a well-formed code', async () => {
    const code = await mountHost();
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    // The host pointer is written, so a reload can rehost the same room.
    const stored = JSON.parse(localStorage.getItem(HOST_KEY)!) as { code: string };
    expect(stored.code).toBe(code);
  });

  it('rehosts the stored room instead of creating a second one', async () => {
    const first = await mountHost();

    // Remount, exactly as a page reload does: same socket, same stored code.
    const second = await mountHost(first);
    expect(second).toBe(first);
  });

  it('takes player 1 for the board, so no phone can claim it', async () => {
    const code = await mountHost();
    const controller = await phone();
    await call(controller, 'room:join', { code });

    /*
     * The seat the host plays is claimed by the host, and `claimSeat` refuses a seat that already
     * has a token. That single rule is what makes "player 1 belongs to the board" true everywhere at
     * once — the picker draws it as Taken without knowing anything about hosts, and this refusal is
     * the server-side half of the same fact.
     */
    expect(await call(controller, 'room:claim', { code, colour: 'blue' })).toEqual({
      ok: false,
      error: 'SEAT_TAKEN',
    });

    // A different seat is still free, so the refusal is about *this* seat and not a broken claim.
    expect((await call(controller, 'room:claim', { code, colour: 'red' })).ok).toBe(true);
  });

  it('hands a phone the host’s seat by pairing, and both can then act for it', async () => {
    const code = await mountHost();
    const controller = await phone();
    await pairToHostSeat(code, controller);

    await waitUntil(
      () => room!.seats.some((s) => s.colour === 'blue' && s.paired),
      'the host to see the pairing'
    );
    // The board still owns it: pairing grants the right to *act for* the seat, never to take it.
    expect(room!.seats.find((s) => s.colour === 'blue')).toMatchObject({
      name: 'Alice',
      claimed: true,
      connected: true,
      paired: true,
    });
  });

  it('shows a controller that claims a seat, and keeps it across a reconnect', async () => {
    const code = await mountHost();
    const controller = await phone();

    await call(controller, 'room:join', { code });
    // Red, not blue: blue is the host's own seat now. See `pairToHostSeat`.
    const claimed = await call<{ seatToken: string }>(controller, 'room:claim', {
      code,
      colour: 'red',
    });
    expect(claimed.ok).toBe(true);

    await waitUntil(
      () => room!.seats.some((s) => s.colour === 'red' && s.connected),
      'the host to see the claim'
    );
    const red = room!.seats.find((s) => s.colour === 'red')!;
    expect(red).toMatchObject({ name: 'Bob', claimed: true, connected: true, isBot: false });
    // Green was never claimed, and the host must not imply otherwise.
    expect(room!.seats.find((s) => s.colour === 'green')).toMatchObject({
      claimed: false,
      connected: false,
    });

    // The phone's screen locks and the tab is killed. The server answers with a seat broadcast, so
    // the disconnect goes inside an `act` window long enough for that broadcast to land in it.
    await act(async () => {
      controller.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitUntil(
      () => room!.seats.some((s) => s.colour === 'red' && !s.connected),
      'the host to see the seat drop'
    );
    // Detached, not released: it is still Bob's seat.
    expect(room!.seats.find((s) => s.colour === 'red')).toMatchObject({
      claimed: true,
      connected: false,
    });

    const returned = await phone();
    const reclaimed = await call(returned, 'room:reclaim', {
      code,
      seatToken: claimed.seatToken,
    });
    expect(reclaimed.ok).toBe(true);
    await waitUntil(
      () => room!.seats.some((s) => s.colour === 'red' && s.connected),
      'the host to see the seat return'
    );
  });

  it('pushes a projection when the store changes, and only when it changes', async () => {
    const code = await mountHost();
    const controller = await phone();
    await pairToHostSeat(code, controller);

    const frames = collect<{ projection: TProjection }>(controller, 'game:state');
    // A controller that just took a seat holds no frame, so the host must send one even though
    // nothing about the game itself changed — docs/protocol.md §8.
    await waitUntil(() => frames.length >= 1, 'a frame on taking a seat');

    // A dispatch that does not alter the projection must not produce a frame: the throttle
    // compares serialised bodies, so the phone is not spammed with identical snapshots.
    const before = frames.length;
    await act(async () => {
      store.dispatch({ type: 'room/__noopThatChangesNothing' });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(frames.length).toBe(before);

    // A real game event must.
    await act(async () => {
      store.dispatch(activateTokens({ all: true, colour: 'blue', diceNumber: 6 }));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await waitUntil(() => frames.length > before, 'a frame after the change');

    const latest = frames.at(-1)!.projection;
    const previous = frames.at(-2)!.projection;
    expect(latest.players.find((p) => p.colour === 'blue')!.tokens.every((t) => t.isActive)).toBe(
      true
    );
    // Strictly increasing, so a phone can discard a reordered frame instead of flickering back.
    expect(latest.rev).toBeGreaterThan(previous.rev);
  });

  it('honours a roll intent from the colour whose turn it is', async () => {
    const code = await mountHost();
    const controller = await phone();
    await pairToHostSeat(code, controller);

    expect(store.getState().players.currentPlayerColour).toBe('blue');
    const bagBefore = store.getState().dice.rollBag.blue.length;

    expect((await call(controller, 'game:intent', { kind: 'roll' })).ok).toBe(true);

    // `useRollDice` shows the placeholder, waits ~1 s, then draws from the bag. The bag shrinking
    // is the proof the real roll sequence ran, not just that the intent was acked.
    await waitUntil(
      () => store.getState().dice.rollBag.blue.length < bagBefore,
      'the host to actually roll',
      6000
    );
    expect(store.getState().dice.dice.find((d) => d.colour === 'blue')!.isPlaceholderShowing).toBe(
      false
    );
  }, 15_000);

  it("refuses a roll intent from a colour that is not to play", async () => {
    const code = await mountHost();
    const controller = await phone();
    await call(controller, 'room:join', { code });
    // Bob takes red, but it is blue's turn.
    const claimed = await call(controller, 'room:claim', { code, colour: 'red' });
    expect(claimed.ok).toBe(true);

    const bagBefore = store.getState().dice.rollBag.red.length;
    // The relay acks an intent it merely *delivers* — the guard is the host's job.
    expect((await call(controller, 'game:intent', { kind: 'roll' })).ok).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(store.getState().dice.rollBag.red.length).toBe(bagBefore);
    expect(store.getState().dice.dice.find((d) => d.colour === 'red')!.isPlaceholderShowing).toBe(
      false
    );
  }, 15_000);

  it('refuses a move intent for a token that is not active', async () => {
    const code = await mountHost();
    const controller = await phone();
    await pairToHostSeat(code, controller);

    const blue = () => store.getState().players.players.find((p) => p.colour === 'blue')!;
    // Nothing has been rolled, so no token is movable.
    expect(blue().tokens.every((t) => !t.isActive)).toBe(true);

    expect((await call(controller, 'game:intent', { kind: 'move', tokenId: 0 })).ok).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    // No `requestTokenMove` was dispatched, so no Token mounted an effect for it.
    expect(store.getState().players.pendingMove).toBeNull();
  }, 15_000);

  it("refuses a move intent for another player's token", async () => {
    const code = await mountHost();
    const controller = await phone();
    await pairToHostSeat(code, controller);

    // Make a *red* token active, then have blue try to move it.
    await act(async () => {
      store.dispatch(activateTokens({ all: true, colour: 'red', diceNumber: 6 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect((await call(controller, 'game:intent', { kind: 'move', tokenId: 0 })).ok).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    // Blue is to play, so `canMoveToken(state, 'blue', 0)` fails on `isActive` for blue's own
    // token; the active red token is unreachable because the colour comes from the seat.
    expect(store.getState().players.pendingMove).toBeNull();
  }, 15_000);
});
