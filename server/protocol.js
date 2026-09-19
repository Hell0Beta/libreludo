/**
 * Wire protocol: event names and zod schemas. See docs/protocol.md §4, §5, §9.
 *
 * This is a deliberate, small duplication of the client's `src/net/protocol.ts`. The server is
 * plain ESM JavaScript with no build step, so sharing a module across the boundary would drag
 * a second toolchain into the Docker runtime. Keep the two files in sync by hand when
 * `docs/protocol.md` changes.
 *
 * Every payload that crosses the boundary is parsed with a schema from this module. A parse
 * failure is answered with `{ ok: false, error: 'BAD_REQUEST' }` and the object is discarded —
 * an unvalidated object never reaches a room.
 */

import { z } from 'zod';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './codes.js';

/* ------------------------------------------------------------------ events */

/** Events a client sends to the server. */
export const CLIENT_EVENTS = Object.freeze({
  ROOM_CREATE: 'room:create',
  ROOM_SEATS: 'room:seats',
  ROOM_JOIN: 'room:join',
  ROOM_CLAIM: 'room:claim',
  ROOM_RECLAIM: 'room:reclaim',
  /**
   * A phone pairing to a seat that a PC already owns, using that seat's `pairToken`. Grants the
   * right to act *for* the seat without the right to take it. See protocol.md §4.
   */
  ROOM_PAIR: 'room:pair',
  ROOM_REHOST: 'room:rehost',
  GAME_INTENT: 'game:intent',
  /**
   * A controller's *preview* selection — which piece it is considering moving. Not an action: the
   * host stores it and highlights that piece on the board so the player can see which of four
   * identical pawns they are about to move. See protocol.md §4.
   */
  GAME_SELECT: 'game:select',
  /** Undocumented in protocol.md §4 but required by §10 — the host pushes projections. */
  GAME_STATE: 'game:state',
});

/** Events the server sends to clients. */
export const SERVER_EVENTS = Object.freeze({
  ROOM_SEATS: 'room:seats',
  ROOM_SEAT_LOST: 'room:seat-lost',
  ROOM_HOST_GONE: 'room:host-gone',
  ROOM_HOST_BACK: 'room:host-back',
  GAME_INTENT: 'game:intent',
  GAME_SELECT: 'game:select',
  GAME_STATE: 'game:state',
  ROOM_ERROR: 'room:error',
});

/* -------------------------------------------------------------- error codes */

/** protocol.md §9. */
export const ERROR_CODES = Object.freeze({
  NO_SUCH_ROOM: 'NO_SUCH_ROOM',
  NO_SUCH_SEAT: 'NO_SUCH_SEAT',
  SEAT_TAKEN: 'SEAT_TAKEN',
  SEAT_IS_BOT: 'SEAT_IS_BOT',
  SEAT_EXPIRED: 'SEAT_EXPIRED',
  BAD_SEAT_TOKEN: 'BAD_SEAT_TOKEN',
  BAD_PAIR_TOKEN: 'BAD_PAIR_TOKEN',
  NOT_SEATED: 'NOT_SEATED',
  NOT_HOST: 'NOT_HOST',
  BAD_REQUEST: 'BAD_REQUEST',
});

/** Reasons a controller can be told its seat is gone. */
export const SEAT_LOST_REASONS = Object.freeze({ REMOVED: 'removed', EXPIRED: 'expired' });

/* ----------------------------------------------------------------- schemas */

export const PLAYER_COLOURS = ['blue', 'red', 'green', 'yellow'];
export const playerColourSchema = z.enum(PLAYER_COLOURS);

/** 1..15 characters, matching MAX_PLAYER_NAME_LENGTH in the client. */
export const seatNameSchema = z.string().min(1).max(15);

/** Case-insensitive on input, uppercase on the wire. */
export const roomCodeSchema = z
  .string()
  .trim()
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`, 'i'))
  .transform((value) => value.toUpperCase());

/** A `crypto.randomUUID()` today; the bound just stops absurd payloads. */
export const seatTokenSchema = z.string().min(1).max(128);

export const seatDefinitionSchema = z.object({
  colour: playerColourSchema,
  name: seatNameSchema,
  isBot: z.boolean(),
});

/**
 * `room:create` takes no payload, and Socket.IO lets a client omit it entirely (the ack then
 * arrives as the only argument). Both are normalised to `{}` here.
 */
export const emptyPayloadSchema = z
  .object({})
  .nullish()
  .transform(() => ({}));

export const roomSeatsSchema = z.object({
  code: roomCodeSchema,
  seats: z
    .array(seatDefinitionSchema)
    .max(PLAYER_COLOURS.length)
    .refine(
      (seats) => new Set(seats.map((seat) => seat.colour)).size === seats.length,
      { message: 'seat colours must be unique' }
    ),
});

export const roomJoinSchema = z.object({ code: roomCodeSchema });

export const roomClaimSchema = z.object({
  code: roomCodeSchema,
  colour: playerColourSchema,
});

export const roomReclaimSchema = z.object({
  code: roomCodeSchema,
  seatToken: seatTokenSchema,
});

export const roomRehostSchema = z.object({ code: roomCodeSchema });

export const roomPairSchema = z.object({
  code: roomCodeSchema,
  pairToken: seatTokenSchema,
});

export const gameIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('roll') }),
  z.object({ kind: z.literal('move'), tokenId: z.number().int().min(0) }),
]);

/**
 * A controller's preview selection. `tokenId: null` clears it — the player deselected, or their
 * selection was invalidated by the board moving on.
 *
 * Bounded to 0–3 like every other token id on the wire, so a malformed preview cannot reach the
 * host's state and sit there highlighting a piece that does not exist.
 */
export const gameSelectSchema = z.object({
  tokenId: z.number().int().min(0).max(3).nullable(),
});

/* ------------------------------------------------------------- projection */

const coordinateSchema = z.object({ x: z.number(), y: z.number() });

/**
 * Where a piece sits *within* its tile, and how much to shrink it.
 *
 * Several pieces can share a tile, and the host fans them out with these offsets. A viewer that
 * only knows `coordinates` would stack them all on top of each other and mis-scale them, so this
 * has to travel with the projection.
 */
const alignmentSchema = z.object({
  xOffset: z.number(),
  yOffset: z.number(),
  scaleFactor: z.number(),
});

const tokenProjectionSchema = z.object({
  id: z.number().int().min(0).max(3),
  isActive: z.boolean(),
  isLocked: z.boolean(),
  hasTokenReachedHome: z.boolean(),
  coordinates: coordinateSchema,
  tokenAlignmentData: alignmentSchema,
  /** The direction of the last move, or null. Drives animation timing on a viewer. */
  direction: z.enum(['forward', 'backward']).nullable(),
});

const playerProjectionSchema = z.object({
  colour: playerColourSchema,
  name: z.string(),
  isBot: z.boolean(),
  playerFinishTime: z.number(),
  tokens: z.array(tokenProjectionSchema),
});

const diceProjectionSchema = z.object({
  colour: playerColourSchema,
  diceNumber: z.number().int(),
  isPlaceholderShowing: z.boolean(),
});

/**
 * The host's projection, relayed untouched. The server has no opinion about its contents; the
 * schema only keeps malformed or hostile frames out of the controller channel.
 */
export const projectionSchema = z.object({
  rev: z.number().int().min(0),
  phase: z.enum(['lobby', 'playing', 'ended']),
  currentPlayerColour: playerColourSchema,
  isAnyTokenMoving: z.boolean(),
  isGameEnded: z.boolean(),
  players: z.array(playerProjectionSchema).max(PLAYER_COLOURS.length),
  dice: z.array(diceProjectionSchema).max(PLAYER_COLOURS.length),
});

export const gameStateSchema = z.object({ projection: projectionSchema });

/* ------------------------------------------------------------------- acks */

export function ok(payload = {}) {
  return { ok: true, ...payload };
}

export function fail(error) {
  return { ok: false, error };
}
