// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:3112" }
/**
 * The controller bridge, end to end: the real `useController` hook against the real relay over a
 * real socket, with a raw socket standing in for the PC host.
 *
 * The host half of the seam is covered by `bridge.test.tsx`. It cannot be covered *here* alongside
 * this one, because `src/net/socket.ts` is a deliberate singleton — one JS context has exactly one
 * socket, so a host bridge and a controller bridge in the same document would share it and the test
 * would be proving nothing about two devices. Standing a raw `socket.io-client` in for the host is
 * both simpler and truer: it drives `game:state` and receives `game:intent` exactly as the relay
 * forwards them, which is the contract this hook actually has.
 *
 * What only this test can catch, because no static gate can:
 *   - a claim that does not persist its `seatToken`, so a reload drops the seat
 *   - a stale or reordered frame rendered anyway, flickering the screen backwards
 *   - a reclaim that silently fails and leaves the phone on a dead board
 *   - an intent emitted with the wrong shape, or not at all
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { io as ioClient, type Socket as PeerSocket } from 'socket.io-client';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { store } from '../../src/state/store';
import { useController } from '../../src/net/useController';
import { disconnectSocket } from '../../src/net/socket';
import type { TProjection, TProjectionToken } from '../../src/net/protocol';
import type { TPlayerColour } from '../../src/types';

const PORT = 3112;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** React only batches into `act` when the environment says it is a test. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type TController = ReturnType<typeof useController>;
let controller: TController | null = null;

function capture(value: TController) {
  controller = value;
}

function Harness({ code }: { code: string }) {
  const value = useController({ code });
  useEffect(() => capture(value), [value]);
  return null;
}

/**
 * An ack turned into a promise, so a failure surfaces as a value rather than a hang.
 *
 * Wrapped in `act` because every one of these calls makes the server broadcast back to the
 * controller under test. Without the wrapper React dispatches outside `act` and warns — and only
 * when the timing happens to fall that way, which made it look like flakiness from unrelated files.
 */
async function call<T = Record<string, unknown>>(
  socket: PeerSocket,
  event: string,
  payload: unknown = {}
): Promise<{ ok: boolean; error?: string } & Partial<T>> {
  let response!: { ok: boolean; error?: string } & Partial<T>;
  await act(async () => {
    response = await new Promise((resolve) => socket.emit(event, payload, resolve));
  });
  return response;
}

/** The controller's own record of its seat. Throws rather than returning undefined, so a test that
 *  forgot to claim fails at the assertion rather than three lines later on a property read. */
function storedSeat(code: string): { code: string; seatToken: string; colour: string } {
  const raw = localStorage.getItem(`libreludo:seat:${code}`);
  if (!raw) throw new Error(`no seat was stored for room ${code}`);
  return JSON.parse(raw) as { code: string; seatToken: string; colour: string };
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

/* ------------------------------------------------------------------ fixtures */

function token(id: number, over: Partial<TProjectionToken> = {}): TProjectionToken {
  return {
    id,
    isActive: false,
    isLocked: true,
    hasTokenReachedHome: false,
    coordinates: { x: 0, y: 0 },
    // A piece alone on its tile: no fan-out offset, no shrink.
    tokenAlignmentData: { xOffset: 0, yOffset: 0, scaleFactor: 1 },
    direction: null,
    ...over,
  };
}

/** A projection the relay's own zod schema will accept — it validates `game:state` on the way in. */
function projection(rev: number, over: Partial<TProjection> = {}): TProjection {
  return {
    rev,
    phase: 'playing',
    currentPlayerColour: 'blue',
    isAnyTokenMoving: false,
    isGameEnded: false,
    players: [
      {
        colour: 'blue',
        name: 'Alice',
        isBot: false,
        playerFinishTime: 0,
        tokens: [token(0), token(1), token(2), token(3)],
      },
      {
        colour: 'red',
        name: 'Bob',
        isBot: false,
        playerFinishTime: 0,
        tokens: [token(0), token(1), token(2), token(3)],
      },
      {
        colour: 'green',
        name: 'Botty',
        isBot: true,
        playerFinishTime: 0,
        tokens: [token(0), token(1), token(2), token(3)],
      },
    ],
    dice: [
      { colour: 'blue', diceNumber: 0, isPlaceholderShowing: false },
      { colour: 'red', diceNumber: 0, isPlaceholderShowing: false },
    ],
    ...over,
  };
}

describe('net/useController — the phone against a live relay', () => {
  let child: ChildProcess;
  let host: PeerSocket;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let peers: PeerSocket[] = [];

  /** A second device: used as "the host" and, where a test needs one, as "another phone". */
  async function peer(): Promise<PeerSocket> {
    const socket = ioClient(ORIGIN, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    peers.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(undefined));
      socket.once('connect_error', reject);
    });
    return socket;
  }

  /** The host: creates the room, declares seats, and pushes projections. */
  async function declareRoom(seats: { colour: TPlayerColour; name: string; isBot: boolean }[]) {
    const created = await call<{ code: string }>(host, 'room:create');
    // The relay mints its own code; the test needs a fixed one, so the controller joins whatever
    // room the "host" socket actually owns. Read it back rather than assuming.
    expect(created.ok).toBe(true);
    const code = created.code!;
    const declared = await call(host, 'room:seats', { code, seats });
    expect(declared.ok).toBe(true);
    return code;
  }

  async function mountController(code: string) {
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
    await waitUntil(() => controller?.phase !== 'connecting', 'the controller to settle');
    return controller!;
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

  beforeEach(async () => {
    localStorage.clear();
    controller = null;
    host = await peer();
  });

  afterEach(async () => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    for (const socket of peers) socket.disconnect();
    peers = [];
    disconnectSocket();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  /** Room codes are minted by the relay, so every test works against whatever it hands back. */
  async function seatedRoom() {
    const code = await declareRoom([
      { colour: 'blue', name: 'Alice', isBot: false },
      { colour: 'red', name: 'Bob', isBot: false },
      { colour: 'green', name: 'Botty', isBot: true },
    ]);
    return code;
  }

  it('offers the seats the host declared, and hides the bot', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);

    expect(phone.phase).toBe('picking');
    expect(phone.hostPresent).toBe(true);
    expect(phone.seats.map((seat) => seat.name)).toEqual(['Alice', 'Bob', 'Botty']);
    expect(phone.seats.find((seat) => seat.colour === 'green')?.isBot).toBe(true);
  });

  it('takes a seat and remembers its token for the next reload', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);

    await act(async () => {
      await phone.claim('blue');
    });

    expect(controller!.phase).toBe('seated');
    expect(controller!.seat).toEqual({ colour: 'blue', name: 'Alice' });

    // The token is the only proof of ownership. If it is not written, a reload loses the seat.
    const stored = storedSeat(code);
    expect(stored).toMatchObject({ code, colour: 'blue' });
    expect(stored.seatToken.length).toBeGreaterThan(0);
  });

  it('refuses a seat another phone already holds', async () => {
    const code = await seatedRoom();
    const other = await peer();
    await call(other, 'room:join', { code });
    expect((await call(other, 'room:claim', { code, colour: 'blue' })).ok).toBe(true);

    const phone = await mountController(code);
    expect(phone.phase).toBe('picking');
    await act(async () => {
      await phone.claim('blue');
    });

    expect(controller!.phase).toBe('picking');
    expect(controller!.message).toMatch(/just took that player/i);
  });

  it('reclaims its seat on reload instead of asking again', async () => {
    const code = await seatedRoom();
    const first = await mountController(code);
    await act(async () => {
      await first.claim('red');
    });
    expect(controller!.seat?.colour).toBe('red');

    // A reload: same storage, fresh mount, fresh socket.
    const reloaded = await mountController(code);
    await waitUntil(() => reloaded.phase === 'seated', 'the seat to be reclaimed');

    expect(controller!.phase).toBe('seated');
    expect(controller!.seat).toEqual({ colour: 'red', name: 'Bob' });
  });

  it('falls back to the picker when its stored seat token means nothing', async () => {
    const code = await seatedRoom();
    // What a phone holds after the room was swept and its code reused by a different game.
    localStorage.setItem(
      `libreludo:seat:${code}`,
      JSON.stringify({ code, seatToken: 'a-token-from-a-room-that-no-longer-exists', colour: 'blue' })
    );

    const phone = await mountController(code);

    expect(phone.phase).toBe('picking');
    expect(phone.message).toMatch(/no longer available/i);
    // The dead token must be cleared, or every future load replays the same failed reclaim.
    expect(localStorage.getItem(`libreludo:seat:${code}`)).toBeNull();
  });

  it('renders a frame, and refuses to render one that is not newer', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);
    await act(async () => {
      await phone.claim('blue');
    });

    await act(async () => {
      host.emit('game:state', { projection: projection(100) });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await waitUntil(() => controller!.projection?.rev === 100, 'the first frame');

    // A reordered packet: older than what the phone already holds.
    await act(async () => {
      host.emit('game:state', { projection: projection(99) });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(controller!.projection?.rev).toBe(100);

    // And a genuinely newer one lands.
    await act(async () => {
      host.emit('game:state', { projection: projection(101) });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(controller!.projection?.rev).toBe(101);
  });

  it('sends a roll intent the host receives, stamped with the seat colour', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);
    await act(async () => {
      await phone.claim('red');
    });

    const intents: { kind: string; fromColour: string }[] = [];
    host.on('game:intent', (intent: { kind: string; fromColour: string }) => intents.push(intent));

    act(() => {
      controller!.roll();
    });
    await waitUntil(() => intents.length === 1, 'the roll intent');

    expect(intents[0]).toEqual({ kind: 'roll', fromColour: 'red' });
  });

  it('sends a move intent carrying the token id', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);
    await act(async () => {
      await phone.claim('blue');
    });

    const intents: { kind: string; fromColour: string; tokenId: number }[] = [];
    host.on('game:intent', (intent: { kind: string; fromColour: string; tokenId: number }) =>
      intents.push(intent)
    );

    act(() => {
      controller!.move(2);
    });
    await waitUntil(() => intents.length === 1, 'the move intent');

    expect(intents[0]).toEqual({ kind: 'move', fromColour: 'blue', tokenId: 2 });
  });

  it('forwards a preview selection so the board can highlight the piece', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);
    await act(async () => {
      await phone.claim('blue');
    });

    const selections: { fromColour: string; tokenId: number | null }[] = [];
    host.on('game:select', (selection: { fromColour: string; tokenId: number | null }) =>
      selections.push(selection)
    );

    act(() => {
      controller!.select(2);
    });
    await waitUntil(() => selections.length === 1, 'the selection to reach the host');
    expect(selections[0]).toEqual({ fromColour: 'blue', tokenId: 2 });

    // Clearing must travel too, or the board keeps a piece lit that nobody is pointing at.
    act(() => {
      controller!.select(null);
    });
    await waitUntil(() => selections.length === 2, 'the cleared selection');
    expect(selections[1]).toEqual({ fromColour: 'blue', tokenId: null });
  });

  it('refuses a preview from a socket with no seat', async () => {
    const code = await seatedRoom();
    // A peer that joined the room but never claimed a seat.
    const unseated = await peer();
    await call(unseated, 'room:join', { code });

    const received: unknown[] = [];
    host.on('game:select', (selection: unknown) => received.push(selection));

    const ack = await call(unseated, 'game:select', { tokenId: 1 });
    expect(ack).toMatchObject({ ok: false, error: 'NOT_SEATED' });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(received).toHaveLength(0);
  });

  it('tells the phone the board is gone, and that it is back', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);
    await act(async () => {
      await phone.claim('blue');
    });
    expect(controller!.hostPresent).toBe(true);

    // The board tab closes. Driving the server from a test always produces a broadcast back to the
    // controller, so the call goes inside an `act` window long enough for that broadcast to land.
    await act(async () => {
      host.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitUntil(() => controller!.hostPresent === false, 'the board to be reported gone');

    // It comes back on a new socket and rehosts the same room.
    await act(async () => {
      host = await peer();
      const rehosted = await call(host, 'room:rehost', { code });
      expect(rehosted.ok).toBe(true);
    });
    await waitUntil(() => controller!.hostPresent === true, 'the board to be reported back');
  });

  it('closes the room on the phone when the relay has never heard of the code', async () => {
    const phone = await mountController('ZZZZ');
    expect(phone.phase).toBe('closed');
    expect(phone.message).toMatch(/not open/i);
  });

  it('treats a link with no usable code as closed without opening a socket', async () => {
    const phone = await mountController('!!!');
    expect(phone.phase).toBe('closed');
    expect(phone.message).toMatch(/missing a room code/i);
  });

  it('hands the seat back to the picker when another phone reclaims it', async () => {
    const code = await seatedRoom();
    const phone = await mountController(code);
    await act(async () => {
      await phone.claim('blue');
    });
    const seatToken = storedSeat(code).seatToken;

    // A second phone presents the same token: last writer wins, and the first is evicted. The
    // server answers with `room:seat-lost` and a fresh seat list, so this goes inside `act`.
    const thief = await peer();
    await act(async () => {
      await call(thief, 'room:join', { code });
      const taken = await call(thief, 'room:reclaim', { code, seatToken });
      expect(taken.ok).toBe(true);
    });

    await waitUntil(() => controller!.phase === 'picking', 'the first phone to lose its seat');
    expect(controller!.message).toMatch(/another phone|released/i);
    // And it must forget the token, or it would fight for the seat on every reload.
    expect(localStorage.getItem(`libreludo:seat:${code}`)).toBeNull();
  });
});
