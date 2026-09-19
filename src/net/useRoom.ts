/**
 * The host side of the room: create/rehost a room, declare seats, guard incoming intents, and
 * project game state out to controllers.
 *
 * This is the bridge named in docs/phone-controllers.md §C. Its three jobs, in order of how
 * easy they are to get subtly wrong:
 *
 *   1. **Projection.** A `store.subscribe` recomputes the pure `projectState`, and emits
 *      `game:state` **only when the serialised frame changes**, at most once per ~80 ms, with a
 *      strictly increasing `rev`. Snapshots, not diffs (docs/protocol.md §6).
 *   2. **Intents.** A `game:intent` is re-checked against the *same* guards the local UI uses
 *      (`game/guards.ts`) before anything happens — a controller cannot roll out of turn or move
 *      a piece that is not active. A `roll` goes through `usePerformRoll`; a `move` dispatches
 *      `requestTokenMove`, the identical action a local board click dispatches.
 *   3. **Room lifecycle.** `room:rehost` on load (so a reload rejoins the *same* room and keeps
 *      controllers' claims), falling back to `room:create`; `room:seats` re-sent whenever the
 *      seat list changes.
 *
 * It never writes to the game slices. All room state lives in `roomSlice`.
 */

import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { useNavigate } from 'react-router';
import type { Socket } from 'socket.io-client';
import type { AppDispatch, RootState } from '../state/store';
import type { TPlayerColour } from '../types';
import {
  setConnectionStatus,
  setHostSeat,
  setPreviewToken,
  setRoomCode,
  setRoomError,
  setRoomRole,
  setSeatList,
} from '../state/slices/roomSlice';
import { requestTokenMove } from '../state/slices/playersSlice';
import { isDiceDisabled, canMoveToken } from '../game/guards';
import { projectState, withRevision } from './projection';
import { connect } from './socket';
import { clearHostSeat, readHostSeat, readHostRoom, writeHostRoom, writeHostSeat } from './hostStorage';
import { emitAck, waitForConnect } from './ack';
import { usePerformRoll } from '../hooks/usePerformRoll';
import { logError } from '../utils/logError';
import {
  CLIENT_EVENTS,
  ERROR_CODES,
  SERVER_EVENTS,
  type TErrorCode,
  type THostIntent,
  type THostSelection,
  type TSeatDefinition,
  type TSeatSummary,
} from './protocol';

/** Snapshots are a few hundred bytes; ~80 ms is enough to coalesce a burst of dispatches. */
export const PROJECTION_THROTTLE_MS = 80;

/* --------------------------------------------------------------- helpers */

/**
 * Create a room and remember its code. Used by the menu's Create Custom Room control, which hands
 * the code to `/setup` and on to `/room/:code`.
 */
export async function createHostRoom(): Promise<string> {
  const socket = await connect();
  const connected = await waitForConnect(socket);
  // The overwhelmingly common cause is that nothing is on the relay's port, so say that — and say
  // how to fix it. "Could not reach the relay" on its own sends people looking for a bug in the
  // request code when the answer is one command away.
  if (!connected) {
    throw new Error(
      'Could not reach the relay. Start it with `pnpm server` in another terminal — the dev server only proxies to it, it does not run it.'
    );
  }

  const ack = await emitAck<{ code: string }>(socket, CLIENT_EVENTS.ROOM_CREATE, {});
  if (!ack?.ok) throw new Error(`Could not create a room (${ack?.error ?? 'no response'})`);

  writeHostRoom(ack.code);
  return ack.code;
}

type TUseRoomOptions = {
  /** Room code from `/room/:code`. Falls back to the stored host room when absent. */
  code?: string;
  /**
   * Declare these seats instead of reading them from the game slices.
   *
   * Match Setup has the seat list as *form state* — the host is still typing names — and there are
   * no registered players yet, so the default source is empty and `declareSeats` would refuse to
   * send anything. That would mean no QR code and no way for phones to join until after the game
   * had already started, which is the wrong way round.
   *
   * `/room/:code` passes nothing and keeps reading the game slices, so the two paths stay honest
   * about where their seats come from.
   */
  seats?: TSeatDefinition[];
};

/**
 * Mount the host bridge for a room. Returns the resolved room code, which can differ from the
 * route code if the original room was swept and a fresh one had to be created.
 */
export function useRoom({ code: routeCode, seats: seatOverride }: TUseRoomOptions = {}) {
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  const navigate = useNavigate();
  const performRoll = usePerformRoll();

  const [socket, setSocket] = useState<Socket | null>(null);
  const [resolvedCode, setResolvedCode] = useState<string | null>(routeCode ?? null);

  const codeRef = useRef<string | null>(routeCode ?? null);
  const flushRef = useRef<(force?: boolean) => void>(() => {});
  const lastSeatsSentRef = useRef<string | null>(null);
  const performRollRef = useRef(performRoll);
  /**
   * The socket generation this bridge has already rehosted/created for. React StrictMode mounts
   * effects twice in dev; without this the room could be created twice (the second
   * `room:create` releases the first). Keyed by socket id, so a genuine reconnect — which gets a
   * new id — still rehosts.
   */
  const joinedSocketIdRef = useRef<string | null | undefined>(null);
  /**
   * `claimHostSeat`, reachable from the seat-signature effect below.
   *
   * That effect is outside the connection effect and cannot close over it, so it goes through a ref
   * — the same shape as `flushRef` and `performRollRef`. Assigned where the rest of the bridge is
   * built, so before the effect can first fire.
   */
  const claimHostSeatRef = useRef<(target: Socket, colour: TPlayerColour) => Promise<void>>(
    async () => {}
  );
  /**
   * The seat this bridge has already claimed, and for which room and socket.
   *
   * All three parts are load-bearing. The socket id because the claim has to be re-made on a
   * reconnect — the server drops a seat's `socketId` when the socket goes. The colour because a
   * host that changes who player 1 is must claim the new colour rather than keep insisting on the
   * old one. And the **code**, because the socket is a singleton that survives navigation: a host
   * that opens a second room without the first tearing down would otherwise match this record and
   * skip the claim entirely, leaving the new room's player 1 unclaimed.
   */
  const hostSeatRef = useRef<{
    code: string;
    socketId: string | null | undefined;
    colour: TPlayerColour;
  } | null>(null);
  /**
   * The seat override, held in a ref so the connection effect does not re-run every time the host
   * types a character. See `TUseRoomOptions.seats`.
   */
  const seatOverrideRef = useRef(seatOverride);

  const status = useSelector((state: RootState) => state.room.status);
  const seats = useSelector((state: RootState) => state.room.seats);
  const hostPresent = useSelector((state: RootState) => state.room.hostPresent);

  /*
   * Kept in step from an effect rather than during render: assigning to a ref while rendering is a
   * side effect React may repeat or discard. Declared *before* the connection effect below, so on
   * mount it has already run by the time `declareSeats` first reads the ref; the initial value of
   * `useRef` covers the very first pass either way.
   */
  useEffect(() => {
    seatOverrideRef.current = seatOverride;
  }, [seatOverride]);

  /**
   * A cheap stable key for the seat list: re-send `room:seats` only when it actually changes.
   * When seats are overridden the signature comes from the override, so typing a name re-declares
   * the seats and every connected phone sees the new name immediately.
   */
  const reduxSeatsSignature = useSelector((state: RootState) =>
    JSON.stringify(state.players.players.map((p) => [p.colour, p.name, p.isBot]))
  );
  const seatsSignature = seatOverride
    ? JSON.stringify(seatOverride.map((d) => [d.colour, d.name, d.isBot]))
    : reduxSeatsSignature;

  useEffect(() => {
    performRollRef.current = performRoll;
  }, [performRoll]);

  /* ------------------------------------------------------ connection + room */

  useEffect(() => {
    let disposed = false;
    let current: Socket | null = null;
    let joining = false;

    const declareSeats = async (target: Socket) => {
      const code = codeRef.current;
      if (!code) return;
      const definitions =
        seatOverrideRef.current ??
        store.getState().players.players.map((p) => ({
          colour: p.colour,
          name: p.name,
          isBot: p.isBot,
        }));
      if (definitions.length === 0) return;
      lastSeatsSentRef.current = JSON.stringify(
        definitions.map((d) => [d.colour, d.name, d.isBot])
      );
      await emitAck<Record<string, never>>(target, CLIENT_EVENTS.ROOM_SEATS, {
        code,
        seats: definitions,
      });
      /*
       * Awaited, not fired alongside: `room:claim` is refused with `NO_SUCH_SEAT` for a colour the
       * server has not been told about yet, and both requests ride the same connection — so the
       * order they are emitted in is the order they are handled in.
       */
      await claimHostSeat(target, definitions[0].colour);
    };

    /**
     * The host takes player 1.
     *
     * The host is a player like anyone else, so it holds a seat the same way a phone does — and that
     * is the whole point rather than a convenience. A seat that is `claimed` is drawn as taken by
     * `SeatPicker` and refused by `room:claim`, so "player 1 belongs to the board" needs no new rule
     * anywhere: it falls out of the claim. What the host buys with it is the `pairToken`, which is
     * sent only to the socket that owns the seat, and is what its spirit card turns into a QR.
     *
     * **Player 1 is the first declared seat, and a bot cannot be claimed.** A host that marks player
     * 1 as a bot gets `SEAT_IS_BOT` and simply holds no seat — correct, because the board rolls for
     * that player and there is nothing to hand a phone.
     */
    const claimHostSeat = async (target: Socket, colour: TPlayerColour) => {
      const code = codeRef.current;
      if (!code) return;

      const already = hostSeatRef.current;
      if (already?.code === code && already.socketId === target.id && already.colour === colour)
        return;

      const stored = readHostSeat();
      // Only a token for *this* colour is worth redeeming. One for a different colour belongs to a
      // seat this host no longer plays, and reclaiming it would bind the wrong player.
      if (stored && stored.colour === colour) {
        const reclaimed = await emitAck<{ colour: TPlayerColour; name: string; pairToken: string }>(
          target,
          CLIENT_EVENTS.ROOM_RECLAIM,
          { code, seatToken: stored.seatToken }
        );
        if (reclaimed?.ok) {
          hostSeatRef.current = { code, socketId: target.id, colour: reclaimed.colour };
          dispatch(setHostSeat({ colour: reclaimed.colour, pairToken: reclaimed.pairToken }));
          return;
        }
        // Swept, or a token the server has never seen. Drop it and take the seat afresh.
        clearHostSeat();
      }

      const claimed = await emitAck<{
        seatToken: string;
        pairToken: string;
        colour: TPlayerColour;
        name: string;
      }>(target, CLIENT_EVENTS.ROOM_CLAIM, { code, colour });

      if (!claimed?.ok) {
        /*
         * `SEAT_TAKEN` means a phone already holds player 1 — possible only if this host was away
         * long enough for the seat to be swept and re-claimed. The host plays on regardless: it
         * drives its own board locally and needs no seat to do it. What it loses is the QR, so the
         * card simply shows nothing rather than a code that would be refused.
         */
        return;
      }

      writeHostSeat({ colour: claimed.colour, seatToken: claimed.seatToken });
      hostSeatRef.current = { code, socketId: target.id, colour: claimed.colour };
      dispatch(setHostSeat({ colour: claimed.colour, pairToken: claimed.pairToken }));
    };

    // Reachable from the seat-signature effect below, which lives outside this closure.
    claimHostSeatRef.current = claimHostSeat;

    const joinAsHost = async (target: Socket) => {
      if (joining) return;
      if (joinedSocketIdRef.current === target.id) return;
      joining = true;
      try {
        dispatch(setRoomRole('host'));
        /*
         * Drop any pairing credential from a previous room before anything else. It is a live secret
         * the server sends only to the socket that owns a seat, and a stale one left in the slice
         * would render a QR for whichever seat this device is *about* to hold — a code that pairs a
         * phone to nothing, or worse, to the wrong player.
         */
        dispatch(setHostSeat(null));

        const desired = codeRef.current ?? readHostRoom();
        if (desired) {
          const ack = await emitAck<{ seats: TSeatSummary[] }>(
            target,
            CLIENT_EVENTS.ROOM_REHOST,
            { code: desired }
          );
          if (ack?.ok) {
            codeRef.current = desired;
            writeHostRoom(desired);
            setResolvedCode(desired);
            dispatch(setRoomCode(desired));
            await declareSeats(target);
            flushRef.current(true);
            joinedSocketIdRef.current = target.id;
            return;
          }
          // Only a missing room is recoverable by creating a new one. NOT_HOST / BAD_REQUEST
          // mean another socket owns the role, or the code is malformed — surface, do not steal.
          if (ack && ack.error !== ERROR_CODES.NO_SUCH_ROOM) {
            dispatch(setRoomError(ack.error));
            dispatch(setConnectionStatus('error'));
            return;
          }
        }

        const created = await emitAck<{ code: string }>(target, CLIENT_EVENTS.ROOM_CREATE, {});
        if (!created) {
          dispatch(setConnectionStatus('error'));
          return;
        }
        if (!created.ok) {
          dispatch(setRoomError(created.error));
          dispatch(setConnectionStatus('error'));
          return;
        }

        codeRef.current = created.code;
        writeHostRoom(created.code);
        setResolvedCode(created.code);
        dispatch(setRoomCode(created.code));
        await declareSeats(target);
        flushRef.current(true);
        joinedSocketIdRef.current = target.id;

        if (routeCode && created.code !== routeCode) {
          void navigate(`/room/${created.code}`, { replace: true });
        }
      } catch (error) {
        logError('useRoom.joinAsHost')(error);
        dispatch(setConnectionStatus('error'));
      } finally {
        joining = false;
      }
    };

    const onSeats = (payload: { seats: TSeatSummary[]; hostPresent: boolean }) => {
      dispatch(setSeatList({ seats: payload.seats, hostPresent: payload.hostPresent }));
      // A controller that has just joined or reconnected holds no frame at all, and the seat list
      // changing is the only signal the host gets that one appeared. Without this force, a phone
      // that reconnects on its own turn renders nothing until the projection happens to change —
      // which, if it is waiting on that very phone to move, is never. docs/protocol.md §8: "the
      // first `game:state` after reconnect restores them." Costs one extra frame per seat change;
      // `game:state` excludes the host, so nothing is sent back to this tab.
      flushRef.current(true);
    };

    const onIntent = (intent: THostIntent) => {
      /*
       * Nothing to roll or move before the game exists.
       *
       * A phone can take a seat during Match Setup, before the host has pressed Begin Match, and at
       * that point no players are registered at all. The guards below are all shaped around a real
       * game — `isDiceDisabled` finds no player and no die and so reports the roll as *allowed* —
       * which would send `usePerformRoll` into an empty dice slice. Bail on the empty game instead.
       */
      if (store.getState().players.players.length === 0) return;

      if (intent.kind === 'roll') {
        if (isDiceDisabled(store.getState(), intent.fromColour)) return;
        performRollRef.current(intent.fromColour).catch(logError('useRoom.onIntent.roll'));
        return;
      }
      if (canMoveToken(store.getState(), intent.fromColour, intent.tokenId)) {
        dispatch(requestTokenMove({ colour: intent.fromColour, id: intent.tokenId }));
      }
    };

    /*
     * A controller's preview. The board highlights the piece so a player can see which of four
     * identical pawns "Piece 2" refers to before committing to the move — without this the first
     * of the two taps is meaningless.
     *
     * Kept as-is rather than validated against the game: the board only *renders* the highlight for
     * a token that exists and is `isActive`, so a preview that has gone stale simply stops showing.
     * That is cheaper and more robust than trying to keep a preview synchronised with the rules.
     */
    const onSelect = (payload: THostSelection) => {
      dispatch(
        payload.tokenId === null
          ? setPreviewToken(null)
          : setPreviewToken({ colour: payload.fromColour, id: payload.tokenId })
      );
    };

    const onRoomError = (payload: { error: TErrorCode }) => {
      dispatch(setRoomError(payload.error));
    };

    const onConnect = () => {
      dispatch(setConnectionStatus('connected'));
      if (current) void joinAsHost(current);
    };

    const onDisconnect = () => {
      dispatch(setConnectionStatus('reconnecting'));
    };

    dispatch(setConnectionStatus('connecting'));

    connect()
      .then((target) => {
        if (disposed) return;
        current = target;
        setSocket(target);
        target.on(SERVER_EVENTS.ROOM_SEATS, onSeats);
        target.on(SERVER_EVENTS.GAME_INTENT, onIntent);
        target.on(SERVER_EVENTS.GAME_SELECT, onSelect);
        target.on(SERVER_EVENTS.ROOM_ERROR, onRoomError);
        target.on('connect', onConnect);
        target.on('disconnect', onDisconnect);

        if (target.connected) onConnect();
      })
      .catch((error) => {
        logError('useRoom.connect')(error);
        dispatch(setConnectionStatus('error'));
      });

    return () => {
      disposed = true;
      if (!current) return;
      current.off(SERVER_EVENTS.ROOM_SEATS, onSeats);
      current.off(SERVER_EVENTS.GAME_INTENT, onIntent);
      current.off(SERVER_EVENTS.GAME_SELECT, onSelect);
      current.off(SERVER_EVENTS.ROOM_ERROR, onRoomError);
      current.off('connect', onConnect);
      current.off('disconnect', onDisconnect);
      // The socket itself is a singleton and is left connected: the lobby created the room on
      // this connection and `/room/:code` must be able to rehost on the same socket.
    };
    // `performRoll` is reached through a ref so this effect re-runs only on a real identity change
    // of the room it is bridging, never on a re-render.
  }, [dispatch, navigate, routeCode, store]);

  /* --------------------------------------------------------- re-send seats */

  useEffect(() => {
    if (!socket || !codeRef.current || seatsSignature === '[]') return;
    if (seatsSignature === lastSeatsSentRef.current) return;
    lastSeatsSentRef.current = seatsSignature;
    const raw = JSON.parse(seatsSignature) as [string, string, boolean][];
    void emitAck<Record<string, never>>(socket, CLIENT_EVENTS.ROOM_SEATS, {
      code: codeRef.current,
      seats: raw.map(([colour, name, isBot]) => ({ colour, name, isBot })),
    }).then(() => claimHostSeatRef.current(socket, raw[0][0] as TPlayerColour));
  }, [socket, seatsSignature]);

  /* ------------------------------------------------------------ projection */

  useEffect(() => {
    if (!socket) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSerialized: string | null = null;
    /*
     * Seeded from the wall clock, not from 0.
     *
     * A host that reloads mid-game resumes emitting from a fresh bridge, and a controller that sat
     * through the reload still holds the last revision the *previous* session sent. Restarting at 1
     * would put every frame of the new session below that number, so the phone would discard them
     * all and freeze on a board that is still very much playing. Seeding high makes `rev` strictly
     * increasing across host restarts as well as within a session, which is what the controller's
     * staleness rule actually needs. A later session always starts above an earlier one's highest
     * revision: frames are ~80 ms apart, so a session cannot emit more revisions than milliseconds
     * have elapsed.
     */
    let rev = Date.now();

    const flush = (force = false) => {
      timer = null;
      if (!socket.connected) return;
      const body = projectState(store.getState());
      const serialized = JSON.stringify(body);
      // Nothing changed: the phone already has this frame. Re-forcing on reconnect re-sends it
      // with a new rev, because a controller that just came back has no frame at all.
      if (!force && serialized === lastSerialized) return;
      lastSerialized = serialized;
      rev += 1;
      socket.emit(CLIENT_EVENTS.GAME_STATE, { projection: withRevision(body, rev) });
    };

    const schedule = () => {
      // Leading-scheduled, trailing-fired: the first change in a burst books the slot, and the
      // state at fire time is what goes out. Coalesces a whole token move into a few frames.
      if (timer !== null) return;
      timer = setTimeout(() => flush(false), PROJECTION_THROTTLE_MS);
    };

    flushRef.current = flush;
    const unsubscribe = store.subscribe(schedule);
    schedule();

    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      flushRef.current = () => {};
    };
  }, [socket, store]);

  return { code: resolvedCode, status, seats, hostPresent };
}
