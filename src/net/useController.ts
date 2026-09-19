/**
 * The controller side of the room: join, take a seat, keep it across a lock screen, and render the
 * game from the projection.
 *
 * This is the phone's entire relationship with the game. It never touches `players`, `board`,
 * `dice` or `session` — a controller that hydrated into the game slices would run `useCleanup` on
 * unmount and start computing Ludo rules it has no business computing. Everything it knows arrives
 * as a `game:state` frame and lives in `roomSlice` (docs/protocol.md §6).
 *
 * The parts that are easy to get wrong, in order:
 *
 *   1. **Reconnect.** Socket.IO reconnects on a *new* socket id, so the server has already detached
 *      the seat by the time the phone comes back. Every `connect` therefore re-runs join +
 *      `room:reclaim` from the stored `seatToken`, which is the only thing that proves the seat is
 *      ours (docs/protocol.md §8).
 *   2. **Stale frames.** `rev` is strictly increasing on the host; a frame at or below the one we
 *      already hold is dropped rather than rendered, so a reordered packet cannot flicker the
 *      screen back to a state the board has already left.
 *   3. **Losing the seat.** A swept or stolen seat must land the phone back on the picker with an
 *      explanation, never on a dead board — and the stored token must be cleared, or the next
 *      reload replays the same failure.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import type { Socket } from 'socket.io-client';
import type { AppDispatch, RootState } from '../state/store';
import {
  clearRoomState,
  setConnectionStatus,
  setHostPresent,
  setProjection,
  setRoomCode,
  setRoomError,
  setRoomRole,
  setSeatList,
} from '../state/slices/roomSlice';
import { connect, disconnectSocket } from './socket';
import { emitAck, waitForConnect } from './ack';
import { clearSeat, readSeat, writeSeat } from './seatStorage';
import { logError } from '../utils/logError';
import type { TPlayerColour } from '../types';
import {
  CLIENT_EVENTS,
  ERROR_CODES,
  SERVER_EVENTS,
  isRoomCode,
  type TErrorCode,
  type TProjection,
  type TSeatLostReason,
  type TSeatSummary,
} from './protocol';

/**
 * `closed` and `error` are kept apart on purpose: `closed` is "that room is not there and no
 * amount of retrying will change it", `error` is "the relay is not answering". They need different
 * words and different offers, and collapsing them produces the useless "something went wrong".
 */
export type TControllerPhase = 'connecting' | 'picking' | 'seated' | 'closed' | 'error';

export type TControllerSeat = { colour: TPlayerColour; name: string };

/** Copy for a refused claim. Every code a claim can actually return is spelled out. */
const CLAIM_ERRORS: Partial<Record<TErrorCode, string>> = {
  [ERROR_CODES.NO_SUCH_ROOM]: 'The host has closed the room.',
  [ERROR_CODES.NO_SUCH_SEAT]: 'That player is no longer in the game. Pick another.',
  [ERROR_CODES.SEAT_TAKEN]: 'Someone just took that player. Pick another.',
  [ERROR_CODES.SEAT_IS_BOT]: 'That player is a bot — the board rolls for it.',
};

/** Copy for a refused pair. A pairing QR names one seat, so there is nothing to pick instead. */
const PAIR_ERRORS: Partial<Record<TErrorCode, string>> = {
  [ERROR_CODES.NO_SUCH_ROOM]: 'The host has closed the room.',
  [ERROR_CODES.BAD_PAIR_TOKEN]:
    'That pairing code is not valid any more. Ask the player at the board to show the QR code again.',
};

/**
 * Why a seat went away. `removed` covers both "the host re-declared the seats and yours is gone"
 * and "another phone reclaimed it"; the server does not distinguish them, and inventing a
 * distinction the wire does not carry would be a guess printed as fact.
 */
const SEAT_LOST_COPY: Record<TSeatLostReason, string> = {
  removed: 'Your player was given to another phone, or the board changed the game. Pick a player to rejoin.',
  expired: 'You were away too long, so your player was released. Pick a player to rejoin.',
};

function describeError(error: TErrorCode): string {
  return (
    CLAIM_ERRORS[error] ?? 'The board refused that. Try again, or ask the host to restart the room.'
  );
}

type TUseControllerOptions = {
  /** Room code from `/join/:code` or `/controller/:code`. */
  code?: string;
  /**
   * A pairing token this device arrived holding — the fragment of a link from a player's spirit
   * card. When set, the stored seat is **not** consulted.
   *
   * That is the whole reason the option exists. A phone that already holds a seat in this room would
   * otherwise reclaim it before the pairing was ever attempted, and a pairing code handed to it
   * would be silently ignored. Someone passing their phone round to act for another player is
   * exactly the case a pairing link is for, so the invitation has to outrank the seat already in
   * storage.
   *
   * The stored seat is left on disk rather than cleared: pairing confers no ownership, and if this
   * phone's own player is still waiting for it, a later visit without a fragment should still find
   * it. Nothing is lost either way, because a claim overwrites.
   */
  pairing?: string | null;
};

export function useController({ code: rawCode, pairing }: TUseControllerOptions = {}) {
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  const code = rawCode ? rawCode.toUpperCase() : null;

  const [phase, setPhase] = useState<TControllerPhase>('connecting');
  const [seat, setSeat] = useState<TControllerSeat | null>(null);
  /**
   * The credential that lets a phone act for this seat without owning it, held **in memory only**.
   *
   * Deliberately not written to `seatStorage` beside the `seatToken`. It is a weaker secret, but it
   * is still a secret, and the server re-sends it on reclaim — which is the path a reload already
   * takes — so persisting it would be keeping a spare key in a drawer for a door that is unlocked
   * for us anyway. It is null until a claim or reclaim acks, and on a phone that paired rather than
   * claimed it stays null forever, because a companion has no QR to show.
   */
  const [pairToken, setPairToken] = useState<string | null>(null);
  /** A sentence to show the user about the last thing that happened. Null when nothing has. */
  const [message, setMessage] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  /*
   * A malformed code is knowable without a socket, so it is *derived* at render rather than pushed
   * into state from the effect body. Setting state synchronously in an effect causes a second
   * render for something React already knew during the first.
   */
  const codeIsUsable = code !== null && isRoomCode(code);

  const socketRef = useRef<Socket | null>(null);
  const claimingRef = useRef(false);
  /**
   * Held in a ref, not read from the closure, so that the connection effect does not re-run when
   * the fragment changes. The effect is keyed on the room it is bridging; a pairing token is an
   * *intent* read once when the socket comes up, not a dependency of the connection itself.
   */
  const pairingRef = useRef(pairing);
  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);
  /**
   * The socket generation this hook has already joined for. Reset only by a new socket id.
   * `undefined` is in the type because that is what `Socket#id` is typed as before the handshake
   * completes, and on a socket that never connected.
   */
  const enteredSocketIdRef = useRef<string | null | undefined>(null);

  const status = useSelector((state: RootState) => state.room.status);
  const seats = useSelector((state: RootState) => state.room.seats);
  const hostPresent = useSelector((state: RootState) => state.room.hostPresent);
  const projection = useSelector((state: RootState) => state.room.projection);

  useEffect(() => {
    // Nothing to join. The rendered phase is already `closed` for this case — see the return below.
    if (!code || !isRoomCode(code)) return;

    let disposed = false;
    let current: Socket | null = null;

    const enter = async (target: Socket) => {
      // One join per socket generation. A React StrictMode double-mount, or a `connect` event that
      // lands while this is still awaiting, would otherwise run it twice. Both requests are
      // idempotent on the server, but the duplicate would re-dispatch the seat list pointlessly.
      if (enteredSocketIdRef.current === target.id) return;
      enteredSocketIdRef.current = target.id;

      dispatch(setRoomRole('controller'));
      dispatch(setRoomCode(code));

      const joined = await emitAck<{ seats: TSeatSummary[]; hostPresent: boolean }>(
        target,
        CLIENT_EVENTS.ROOM_JOIN,
        { code }
      );
      if (disposed) return;

      if (!joined) {
        dispatch(setConnectionStatus('error'));
        setPhase('error');
        setMessage('The board server accepted the connection but never answered. Is the relay running?');
        return;
      }
      if (!joined.ok) {
        if (joined.error === ERROR_CODES.NO_SUCH_ROOM) {
          clearSeat(code);
          setPhase('closed');
          setMessage('That room is not open. Ask the host to show the QR code again.');
          return;
        }
        dispatch(setRoomError(joined.error));
        setPhase('error');
        setMessage(describeError(joined.error));
        return;
      }

      dispatch(setSeatList({ seats: joined.seats, hostPresent: joined.hostPresent }));

      /*
       * Arrived holding a pairing code. Skip the stored seat entirely — see `TUseControllerOptions.
       * pairing` for why the invitation has to outrank it. The screen is left in `picking` on
       * purpose: it is the phase that means "this socket is up and holds nothing", which is exactly
       * the precondition `pair` needs, and the caller is already watching for it.
       */
      if (pairingRef.current) {
        setPhase('picking');
        return;
      }

      const stored = readSeat(code);
      if (!stored) {
        setPhase('picking');
        return;
      }

      const reclaimed = await emitAck<{
        colour: TPlayerColour;
        name: string;
        pairToken: string;
      }>(target, CLIENT_EVENTS.ROOM_RECLAIM, { code, seatToken: stored.seatToken });
      if (disposed) return;

      if (!reclaimed) {
        /*
         * No answer — the relay went quiet mid-handshake. That is *not* proof the seat is gone, and
         * clearing the token here would strand the phone on the picker for good: the token is the
         * only thing that can ever reclaim the seat, so discarding it on a timeout turns a five
         * second network hiccup into a permanent loss. Keep it, keep whatever screen we were on,
         * and let the next reconnect try again.
         */
        dispatch(setConnectionStatus('error'));
        setMessage('Lost touch with the board. It should come back on its own.');
        return;
      }

      if (reclaimed.ok) {
        setSeat({ colour: reclaimed.colour, name: reclaimed.name });
        setPairToken(reclaimed.pairToken ?? null);
        setPhase('seated');
        return;
      }

      // The server answered, and refused. *Now* the token is genuinely dead — swept, or the host
      // re-declared the seats without this colour (a host reload that lost its game does exactly
      // that). Clear it, or every future load replays the same failed reclaim.
      clearSeat(code);
      setSeat(null);
      setPairToken(null);

      if (reclaimed.error === ERROR_CODES.NO_SUCH_ROOM) {
        setPhase('closed');
        setMessage('That room is not open. Ask the host to show the QR code again.');
        return;
      }
      setPhase('picking');
      setMessage('Your seat is no longer available. Pick a player to rejoin.');
    };

    const onSeats = (payload: { seats: TSeatSummary[]; hostPresent: boolean }) => {
      dispatch(setSeatList(payload));
    };

    const onHostGone = () => {
      dispatch(setHostPresent(false));
    };

    const onHostBack = () => {
      dispatch(setHostPresent(true));
    };

    const onState = (payload: { projection: TProjection }) => {
      const next = payload?.projection;
      // Deliberately a shape check, not a full zod parse. The schema in `protocol.ts` exists to
      // validate what *clients* send the server; these frames come from our own host, and a
      // stricter-than-reality schema here would silently drop real frames — a worse failure than
      // rendering a field that turned out to be undefined.
      if (!next || typeof next.rev !== 'number') return;
      const heldRev = store.getState().room.projection?.rev ?? -1;
      // Strictly increasing: a frame that is not newer than what we hold is stale or reordered.
      if (next.rev <= heldRev) return;
      dispatch(setProjection(next));
    };

    const onSeatLost = (payload: { reason: TSeatLostReason }) => {
      clearSeat(code);
      setSeat(null);
      /*
       * A seat that is gone takes its pairing credential with it. Clearing this is not just tidiness:
       * the QR on a viewer's spirit card is rendered from it, and a card still offering to pair a
       * phone to a seat this socket no longer holds would hand out a token the server has already
       * re-minted for whoever took the seat.
       */
      setPairToken(null);
      setPhase('picking');
      setMessage(SEAT_LOST_COPY[payload?.reason] ?? SEAT_LOST_COPY.expired);
    };

    const onRoomError = (payload: { error: TErrorCode }) => {
      dispatch(setRoomError(payload.error));
      if (payload.error === ERROR_CODES.NO_SUCH_ROOM) {
        clearSeat(code);
        setSeat(null);
        setPhase('closed');
        setMessage('The host closed the room. Ask them to start a new one.');
      }
    };

    const onConnect = () => {
      dispatch(setConnectionStatus('connected'));
      if (current) void enter(current);
    };

    const onDisconnect = () => {
      dispatch(setConnectionStatus('reconnecting'));
    };

    dispatch(setConnectionStatus('connecting'));

    connect()
      .then(async (target) => {
        if (disposed) return;
        current = target;
        socketRef.current = target;

        target.on(SERVER_EVENTS.ROOM_SEATS, onSeats);
        target.on(SERVER_EVENTS.GAME_STATE, onState);
        target.on(SERVER_EVENTS.ROOM_SEAT_LOST, onSeatLost);
        target.on(SERVER_EVENTS.ROOM_HOST_GONE, onHostGone);
        target.on(SERVER_EVENTS.ROOM_HOST_BACK, onHostBack);
        target.on(SERVER_EVENTS.ROOM_ERROR, onRoomError);
        target.on('connect', onConnect);
        target.on('disconnect', onDisconnect);

        // `connect()` resolves when the socket object exists, which is not the same as being
        // connected. Emitting into a socket that is still dialling would be buffered and then race
        // the ack timeout, turning a slow relay into a false "did not answer".
        const ready = target.connected || (await waitForConnect(target));
        if (disposed) return;
        if (!ready) {
          dispatch(setConnectionStatus('error'));
          setPhase('error');
          setMessage('Could not reach the board server. Make sure both devices are on the same network.');
          return;
        }
        onConnect();
      })
      .catch((error) => {
        logError('useController.connect')(error);
        dispatch(setConnectionStatus('error'));
        setPhase('error');
        setMessage('Could not reach the board server.');
      });

    return () => {
      disposed = true;
      enteredSocketIdRef.current = null;
      if (!current) return;
      current.off(SERVER_EVENTS.ROOM_SEATS, onSeats);
      current.off(SERVER_EVENTS.GAME_STATE, onState);
      current.off(SERVER_EVENTS.ROOM_SEAT_LOST, onSeatLost);
      current.off(SERVER_EVENTS.ROOM_HOST_GONE, onHostGone);
      current.off(SERVER_EVENTS.ROOM_HOST_BACK, onHostBack);
      current.off(SERVER_EVENTS.ROOM_ERROR, onRoomError);
      current.off('connect', onConnect);
      current.off('disconnect', onDisconnect);
      // The socket stays connected: it is a singleton, and a phone that navigates between
      // `/join/:code` and `/controller/:code` must not drop its seat doing so.
    };
  }, [code, dispatch, store]);

  /* ---------------------------------------------------------------- actions */

  const claim = useCallback(
    async (colour: TPlayerColour) => {
      const target = socketRef.current;
      if (!target || !code || claimingRef.current) return;
      claimingRef.current = true;
      setClaiming(true);
      setMessage(null);
      try {
        const ack = await emitAck<{
          seatToken: string;
          pairToken: string;
          colour: TPlayerColour;
          name: string;
        }>(target, CLIENT_EVENTS.ROOM_CLAIM, { code, colour });
        if (!ack) {
          setMessage('The board server did not answer. Try again.');
          return;
        }
        if (!ack.ok) {
          setMessage(describeError(ack.error));
          return;
        }
        writeSeat({ code, seatToken: ack.seatToken, colour: ack.colour });
        setSeat({ colour: ack.colour, name: ack.name });
        setPairToken(ack.pairToken ?? null);
        setPhase('seated');
      } catch (error) {
        logError('useController.claim')(error);
        setMessage('Could not take that player.');
      } finally {
        claimingRef.current = false;
        setClaiming(false);
      }
    },
    // The setters are stable for the life of the component, but React Compiler infers them from
    // this closure and refuses to preserve memoization unless every one it finds is named. Naming
    // them is free; the alternative is dropping the `useCallback` and hoping the compiler memoizes
    // it — which it will not, once it has bailed on the component.
    [code, setPhase, setSeat, setPairToken, setMessage, setClaiming]
  );

  /**
   * Take a seat from a **pairing** code rather than the picker — the `pairToken` a viewer's spirit
   * card put in its QR.
   *
   * This is the companion half of the owner/companion split (docs/protocol.md §4). A paired phone
   * acts for the seat and cannot take it: it is never given a `seatToken`, so nothing that happens
   * here can displace the PC that showed the code. Both keep playing — the PC from the board it is
   * already holding, the phone from its die and its pieces.
   *
   * A companion also gets **no stored seat**, deliberately. There is nothing to preserve across a
   * disconnect — the server drops a companion the moment its socket goes — so writing a `seatToken`
   * here would be a promise the phone cannot keep, and a reload would land on a reap that fails and
   * a picker the player never asked for. Scanning the QR again is the way back, and it always works.
   */
  const pair = useCallback(
    async (pairToken: string) => {
      const target = socketRef.current;
      if (!target || !code || claimingRef.current) return;
      claimingRef.current = true;
      setClaiming(true);
      setMessage(null);
      try {
        const ack = await emitAck<{ colour: TPlayerColour; name: string }>(
          target,
          CLIENT_EVENTS.ROOM_PAIR,
          { code, pairToken }
        );
        if (!ack) {
          setMessage('The board server did not answer. Try again.');
          return;
        }
        if (!ack.ok) {
          setMessage(PAIR_ERRORS[ack.error] ?? describeError(ack.error));
          return;
        }
        setSeat({ colour: ack.colour, name: ack.name });
        setPhase('seated');
      } catch (error) {
        logError('useController.pair')(error);
        setMessage('Could not pair with that player.');
      } finally {
        claimingRef.current = false;
        setClaiming(false);
      }
    },
    [code, setPhase, setSeat, setMessage, setClaiming]
  );

  /**
   * Hold the seat a pairing link named, whenever this socket is up and holds nothing.
   *
   * Deliberately here rather than on `/join`, and driven by `phase` rather than by a mount, because
   * a pairing has to survive a reconnect and a navigation *and both happen again*:
   *
   *   - A companion is dropped the instant its socket goes — no grace period, by design — so a phone
   *     that sleeps comes back needing to pair again. `enter()` runs on every new socket generation
   *     and leaves the phase at `picking` when a pairing token is present, which is what re-arms
   *     this.
   *   - `/join` hands the phone on to `/controller`, which mounts its own `useController`. If this
   *     lived on `/join` the pairing would be a one-off, and the very first reconnect would strand
   *     the phone on a seat picker for a seat it had already been given.
   *
   * A refusal is not retried: `pair` sets a message, and a message is the thing that stops this from
   * looping. The screen underneath is the ordinary picker, which is a fine place to land.
   */
  useEffect(() => {
    if (phase !== 'picking' || !pairingRef.current || message) return;
    void pair(pairingRef.current);
  }, [phase, pair, message]);

  /**
   * Both intents are fire-and-forget, with no ack callback. The relay acks *delivery*, not
   * acceptance — it answers `ok` whether or not the host goes on to honour the intent — so an ack
   * would carry no information. What the phone shows afterwards comes from the next projection,
   * which is the truth, rather than from an optimistic local guess.
   */
  const roll = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit(CLIENT_EVENTS.GAME_INTENT, { kind: 'roll' });
  }, []);

  const move = useCallback((tokenId: number) => {
    if (!socketRef.current) return;
    socketRef.current.emit(CLIENT_EVENTS.GAME_INTENT, { kind: 'move', tokenId });
  }, []);

  /**
   * Tell the board which piece is being *considered*, so it can highlight it. `null` clears it.
   *
   * This is the answer to a real problem: four pieces of a colour are drawn identically, so "Piece
   * 2" on this screen means nothing to someone looking at the board. The preview makes the first of
   * the two taps visible — the second tap then commits a move the player has already seen pointed
   * at the right pawn.
   *
   * Fire-and-forget, like the intents: it changes nothing about the game, and the board ignores a
   * preview for a piece that cannot move.
   */
  const select = useCallback((tokenId: number | null) => {
    if (!socketRef.current) return;
    socketRef.current.emit(CLIENT_EVENTS.GAME_SELECT, { tokenId });
  }, []);

  const leave = useCallback(() => {
    if (code) clearSeat(code);
    disconnectSocket();
    socketRef.current = null;
    setSeat(null);
    setPairToken(null);
    dispatch(clearRoomState());
    // Every setter this closure touches is named, for the reason given on `claim`.
  }, [code, dispatch, setSeat, setPairToken]);

  return {
    phase: codeIsUsable ? phase : 'closed',
    code,
    seat,
    /**
     * The pairing credential for this seat, or null — on a phone that paired, on a viewer that has
     * not claimed, and on any seat whose owner is not this socket. Whoever renders the pairing QR
     * renders nothing when this is null, which is what keeps the token off every screen but its
     * owner's.
     */
    pairToken,
    message: codeIsUsable
      ? message
      : 'That link is missing a room code. Scan the QR code on the board, or type the code.',
    claiming,
    status,
    seats,
    hostPresent,
    projection,
    claim,
    pair,
    roll,
    move,
    select,
    leave,
  };
}
