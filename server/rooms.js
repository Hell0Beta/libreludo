/**
 * The room registry and the seat state machine. See docs/protocol.md §3.
 *
 * The shape of `Room` and `Seat` here is exactly the documented shape — nothing else is
 * stored on them, so a room can be handed to a socket layer and serialised without surprises.
 * Any bookkeeping that is not part of the contract (released `seatToken`s) lives beside the
 * map, not on the room.
 *
 * Time is injected. `createRoomStore({ now })` takes a clock so grace periods can be tested
 * without real waits; the pure predicates `isSeatExpired` / `isRoomExpired` take `at`
 * explicitly and are exported for the same reason.
 *
 * Grace periods (protocol.md §3):
 *   SEAT_GRACE_MS  120 s — a detached seat keeps its seatToken; nobody else can claim it.
 *   ROOM_GRACE_MS  300 s — a host-less room is kept this long so the PC can reload.
 *   SWEEP_INTERVAL_MS 30 s — how often the sweeper runs.
 *
 * **A bare socket disconnect must never free a seat.** Disconnecting only sets
 * `socketId = null` and stamps `detachedAt`; the seatToken is untouched until the sweeper
 * runs past SEAT_GRACE_MS.
 */

import { randomUUID } from 'node:crypto';
import { generateRoomCode, normalizeRoomCode } from './codes.js';

export const SEAT_GRACE_MS = 120_000;
export const ROOM_GRACE_MS = 300_000;
export const SWEEP_INTERVAL_MS = 30_000;

/** Mirrors MAX_PLAYER_NAME_LENGTH in src/game/players/constants.ts. */
export const MAX_SEAT_NAME_LENGTH = 15;

export const PLAYER_COLOURS = ['blue', 'red', 'green', 'yellow'];

/**
 * A seat is open when `seatToken === null` and claimed otherwise. A claimed seat with a null
 * `socketId` is detached — its controller is temporarily gone.
 */
export function createSeat({ colour, name, isBot }) {
  return {
    colour,
    name,
    isBot,
    socketId: null,
    seatToken: null,
    /**
     * A second, weaker credential for the same seat.
     *
     * `seatToken` proves *ownership* — it reclaims the seat and outranks everyone else. A phone
     * paired to a PC's seat must be able to act for that colour without being able to take the seat
     * away from the PC, so it gets this instead. Anyone holding a `pairToken` may send intents and
     * previews for the seat; nobody holding one may reclaim or release it.
     */
    pairToken: null,
    /** Sockets paired to this seat, alongside the owner. Not credentials — just live actors. */
    companions: [],
    detachedAt: null,
  };
}

/** What a controller is told about a seat. Never includes the token. */
export function toSeatSummary(seat) {
  return {
    colour: seat.colour,
    name: seat.name,
    isBot: seat.isBot,
    claimed: seat.seatToken !== null,
    connected: seat.socketId !== null,
    /** True once at least one phone has paired to this seat. */
    paired: Array.isArray(seat.companions) && seat.companions.length > 0,
  };
}

export function toSeatSummaries(room) {
  return room.seats.map(toSeatSummary);
}

/** True when a claimed seat has been detached for at least SEAT_GRACE_MS. */
export function isSeatExpired(seat, at) {
  return (
    seat.seatToken !== null &&
    seat.socketId === null &&
    seat.detachedAt !== null &&
    at - seat.detachedAt >= SEAT_GRACE_MS
  );
}

/**
 * Both conditions from protocol.md §3, evaluated against the room as it stands:
 *   1. the host is gone, and has been for ROOM_GRACE_MS, and
 *   2. every claimed seat is detached, and has been for SEAT_GRACE_MS.
 *
 * A room with no host but a live (attached) controller fails condition 2 and is kept, so the
 * controller can show "waiting for the board". A claimed seat with a missing `detachedAt`
 * (an inconsistent state) is treated as *not* expired, because deleting too eagerly is worse
 * than leaking.
 */
export function isRoomExpired(room, at) {
  if (room.hostSocketId !== null) return false;
  if (room.hostDetachedAt === null) return false;
  if (at - room.hostDetachedAt < ROOM_GRACE_MS) return false;

  return room.seats.every(
    (seat) => seat.seatToken === null || isSeatExpired(seat, at)
  );
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] injectable clock, epoch ms
 * @param {() => string} [options.newToken] injectable seat token source
 * @param {(size: number) => Uint8Array} [options.randomBytesFn] injectable for room codes
 */
export function createRoomStore({ now = () => Date.now(), newToken = randomUUID, randomBytesFn } = {}) {
  /** @type {Map<string, import('./rooms.js').Room>} */
  const rooms = new Map();

  /**
   * seatToken -> colour, per room code, for tokens that have been released (by expiry or by
   * the host removing the colour). Not part of the Room shape: a reclaim presenting one of
   * these is SEAT_EXPIRED rather than BAD_SEAT_TOKEN.
   * @type {Map<string, Map<string, string>>}
   */
  const releasedTokens = new Map();

  function rememberReleasedToken(code, token, colour) {
    if (token === null) return;
    let tokens = releasedTokens.get(code);
    if (!tokens) {
      tokens = new Map();
      releasedTokens.set(code, tokens);
    }
    tokens.set(token, colour);
  }

  function forgetReleasedTokens(code) {
    releasedTokens.delete(code);
  }

  function getRoom(code) {
    return rooms.get(normalizeRoomCode(code));
  }

  function createRoom({ hostSocketId }) {
    const code = generateRoomCode({
      isTaken: (candidate) => rooms.has(candidate),
      randomBytesFn,
    });

    const room = {
      code,
      hostSocketId,
      seats: [],
      createdAt: now(),
      hostDetachedAt: null,
    };

    rooms.set(code, room);
    return room;
  }

  function deleteRoom(code) {
    const room = getRoom(code);
    if (!room) return null;
    rooms.delete(room.code);
    forgetReleasedTokens(room.code);
    return room;
  }

  function findRoomHostedBy(socketId) {
    if (socketId === null || socketId === undefined) return null;
    for (const room of rooms.values()) {
      if (room.hostSocketId === socketId) return room;
    }
    return null;
  }

  function findSeatBySocket(socketId) {
    if (socketId === null || socketId === undefined) return null;
    for (const room of rooms.values()) {
      const seat = room.seats.find((candidate) => candidate.socketId === socketId);
      if (seat) return { room, seat };
    }
    return null;
  }

  /**
   * Replace the seat list wholesale, preserving `seatToken` / `socketId` / `detachedAt` for
   * colours that survive the change. That preservation is what lets a host reload and
   * re-send `room:seats` without evicting controllers who are already playing.
   *
   * @returns {{ lost: Array<{ colour: string, socketId: string | null }> }}
   */
  function declareSeats(room, definitions) {
    const wanted = new Set(definitions.map((definition) => definition.colour));
    const lost = [];

    for (const seat of room.seats) {
      if (wanted.has(seat.colour)) continue;
      lost.push({ colour: seat.colour, socketId: seat.socketId });
      rememberReleasedToken(room.code, seat.seatToken, seat.colour);
    }

    const previous = new Map(room.seats.map((seat) => [seat.colour, seat]));

    room.seats = definitions.map((definition) => {
      const existing = previous.get(definition.colour);
      if (!existing) return createSeat(definition);
      // Same colour: keep the claim, refresh the host-editable fields.
      existing.name = definition.name;
      existing.isBot = definition.isBot;
      return existing;
    });

    return { lost };
  }

  /** @returns {{ ok: true, seat: object, token: string } | { ok: false, error: string }} */
  function claimSeat(room, colour, socketId) {
    const seat = room.seats.find((candidate) => candidate.colour === colour);
    if (!seat) return { ok: false, error: 'NO_SUCH_SEAT' };
    if (seat.isBot) return { ok: false, error: 'SEAT_IS_BOT' };
    if (seat.seatToken !== null) return { ok: false, error: 'SEAT_TAKEN' };

    const token = newToken();
    seat.seatToken = token;
    // Minted alongside the seat rather than on demand, so the QR can be shown the moment a seat is
    // taken without another round trip.
    seat.pairToken = newToken();
    seat.socketId = socketId;
    seat.companions = [];
    seat.detachedAt = null;

    return { ok: true, seat, token };
  }

  /**
   * Re-attach to a seat from its token. Last writer wins: the caller is told which socket, if
   * any, previously held the seat so it can be detached — two live sockets on one seat is the
   * one state that must never exist.
   *
   * @returns {{ ok: true, seat: object, previousSocketId: string | null }
   *          | { ok: false, error: string }}
   */
  function reclaimSeat(room, seatToken, socketId) {
    const seat = room.seats.find((candidate) => candidate.seatToken === seatToken);

    if (!seat) {
      const released = releasedTokens.get(room.code);
      return { ok: false, error: released?.has(seatToken) ? 'SEAT_EXPIRED' : 'BAD_SEAT_TOKEN' };
    }

    const previousSocketId = seat.socketId === socketId ? null : seat.socketId;
    seat.socketId = socketId;
    seat.detachedAt = null;

    return { ok: true, seat, previousSocketId };
  }

  /**
   * A socket went away (or was replaced by a reclaim). This is the *only* thing a bare
   * disconnect does to a seat: the token survives, so the seat is still owned.
   */
  function detachSeat(room, socketId) {
    const seat = room.seats.find((candidate) => candidate.socketId === socketId);
    if (!seat) return null;

    seat.socketId = null;
    seat.detachedAt = now();
    return seat;
  }

  /**
   * The seat a socket may act for — as its owner, or as a paired companion.
   *
   * This is the one place the "owner or companion" question is answered, so `game:intent` and
   * `game:select` cannot drift apart on it. Returns the same `{ room, seat }` shape as
   * `findSeatBySocket` so callers can swap between them.
   */
  function findSeatForActor(socketId) {
    if (socketId === null || socketId === undefined) return null;
    for (const room of rooms.values()) {
      for (const seat of room.seats) {
        if (seat.socketId === socketId) return { room, seat };
        if (Array.isArray(seat.companions) && seat.companions.includes(socketId)) {
          return { room, seat };
        }
      }
    }
    return null;
  }

  /**
   * Pair a socket to a seat from its `pairToken`. Idempotent: pairing twice from one socket is the
   * same as pairing once, so a phone that reconnects and re-pairs does not accumulate entries.
   *
   * @returns {{ ok: true, seat: object } | { ok: false, error: string }}
   */
  function pairSeat(room, pairToken, socketId) {
    const seat = room.seats.find((candidate) => candidate.pairToken === pairToken);
    if (!seat) return { ok: false, error: 'BAD_PAIR_TOKEN' };
    if (!Array.isArray(seat.companions)) seat.companions = [];
    if (!seat.companions.includes(socketId)) seat.companions.push(socketId);
    return { ok: true, seat };
  }

  /** Remove a socket from every seat's companions. Returns the affected seats. */
  function detachCompanion(socketId) {
    const affected = [];
    for (const room of rooms.values()) {
      for (const seat of room.seats) {
        if (!Array.isArray(seat.companions)) continue;
        const at = seat.companions.indexOf(socketId);
        if (at === -1) continue;
        seat.companions.splice(at, 1);
        affected.push({ room, seat });
      }
    }
    return affected;
  }

  function detachHost(room, socketId) {
    if (room.hostSocketId !== socketId) return false;
    room.hostSocketId = null;
    room.hostDetachedAt = now();
    return true;
  }

  function attachHost(room, socketId) {
    room.hostSocketId = socketId;
    room.hostDetachedAt = null;
  }

  /** @returns {{ ok: true, wasDetached: boolean } | { ok: false, error: 'NOT_HOST' }} */
  function rehost(room, socketId) {
    if (room.hostSocketId !== null && room.hostSocketId !== socketId) {
      return { ok: false, error: 'NOT_HOST' };
    }

    const wasDetached = room.hostSocketId === null;
    attachHost(room, socketId);
    return { ok: true, wasDetached };
  }

  /**
   * One pass of the 30 s sweeper.
   *
   * Deletion is decided against the *pre-sweep* state, then seats are expired in the rooms
   * that survived — expiring first would empty `seats` of claims and make condition 2 vacuously
   * true, deleting rooms a moment too early.
   *
   * @returns {{ removed: object[], expired: Array<{ room: object, seat: object }> }}
   */
  function sweep() {
    const at = now();

    const removed = [];
    for (const room of rooms.values()) {
      if (isRoomExpired(room, at)) removed.push(room);
    }
    for (const room of removed) {
      rooms.delete(room.code);
      forgetReleasedTokens(room.code);
    }

    const expired = [];
    for (const room of rooms.values()) {
      for (const seat of room.seats) {
        if (!isSeatExpired(seat, at)) continue;
        rememberReleasedToken(room.code, seat.seatToken, seat.colour);
        seat.seatToken = null;
        seat.detachedAt = null;
        expired.push({ room, seat });
      }
    }

    return { removed, expired };
  }

  return {
    now,
    get size() {
      return rooms.size;
    },
    rooms,
    getRoom,
    createRoom,
    deleteRoom,
    findRoomHostedBy,
    findSeatBySocket,
    findSeatForActor,
    pairSeat,
    detachCompanion,
    declareSeats,
    claimSeat,
    reclaimSeat,
    detachSeat,
    detachHost,
    attachHost,
    rehost,
    sweep,
  };
}
