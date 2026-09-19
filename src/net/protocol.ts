/**
 * Client half of the wire protocol. Mirrors `server/protocol.js` exactly and is the only place
 * in the client that names a protocol event or payload shape. See docs/protocol.md §4, §5, §9.
 *
 * The server is plain ESM JavaScript with no build step, so the two files are duplicated by hand
 * rather than shared across the boundary. When docs/protocol.md changes, change both — a
 * divergence here is invisible until it fails mid-game.
 */

import { z } from 'zod';
import type { TPlayerColour, TCoordinate, TTokenAlignmentData, TTokenDirection } from '../types';

/* ------------------------------------------------------------------ events */

/** Events a client sends to the server. */
export const CLIENT_EVENTS = {
  ROOM_CREATE: 'room:create',
  ROOM_SEATS: 'room:seats',
  ROOM_JOIN: 'room:join',
  ROOM_CLAIM: 'room:claim',
  ROOM_RECLAIM: 'room:reclaim',
  /**
   * A phone pairing to a seat a PC already owns, using that seat's `pairToken`. Grants the right to
   * act *for* the seat without the right to take it — see docs/protocol.md §4.
   */
  ROOM_PAIR: 'room:pair',
  ROOM_REHOST: 'room:rehost',
  GAME_INTENT: 'game:intent',
  /**
   * A controller's *preview* selection — which piece it is considering moving. Not an action: the
   * host stores it and highlights that piece on the board, so a player can see which of four
   * identical pawns they are about to move before committing. See docs/protocol.md §4.
   */
  GAME_SELECT: 'game:select',
  GAME_STATE: 'game:state',
} as const;

/** Events the server sends to clients. */
export const SERVER_EVENTS = {
  ROOM_SEATS: 'room:seats',
  ROOM_SEAT_LOST: 'room:seat-lost',
  ROOM_HOST_GONE: 'room:host-gone',
  ROOM_HOST_BACK: 'room:host-back',
  GAME_INTENT: 'game:intent',
  GAME_SELECT: 'game:select',
  GAME_STATE: 'game:state',
  ROOM_ERROR: 'room:error',
} as const;

/* -------------------------------------------------------------- error codes */

/** protocol.md §9. */
export const ERROR_CODES = {
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
} as const;

export type TErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Reasons a controller can be told its seat is gone. */
export const SEAT_LOST_REASONS = { REMOVED: 'removed', EXPIRED: 'expired' } as const;

export type TSeatLostReason = (typeof SEAT_LOST_REASONS)[keyof typeof SEAT_LOST_REASONS];

/* ---------------------------------------------------------- room codes (§2) */

/** 30 characters: `2-9`, `A-Z` minus `I`, `L`, `O` and `U`. Keep in sync with server/codes.js. */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 4;

const roomCodePattern = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`, 'i');

/** Local, server-free validity check for the lobby's four cells. */
export function isRoomCode(value: string): boolean {
  return roomCodePattern.test(value.trim());
}

/* ----------------------------------------------------------------- schemas */

export const PLAYER_COLOURS = ['blue', 'red', 'green', 'yellow'] as const;
export const playerColourSchema = z.enum(['blue', 'red', 'green', 'yellow']);

/** 1..15 characters, matching MAX_PLAYER_NAME_LENGTH in the client. */
export const seatNameSchema = z.string().min(1).max(15);

/** Case-insensitive on input, uppercase on the wire. */
export const roomCodeSchema = z
  .string()
  .trim()
  .regex(roomCodePattern)
  .transform((value) => value.toUpperCase());

/** A `crypto.randomUUID()` today; the bound just stops absurd payloads. */
export const seatTokenSchema = z.string().min(1).max(128);

export const seatDefinitionSchema = z.object({
  colour: playerColourSchema,
  name: seatNameSchema,
  isBot: z.boolean(),
});

export const emptyPayloadSchema = z
  .object({})
  .nullish()
  .transform(() => ({}));

export const roomSeatsSchema = z.object({
  code: roomCodeSchema,
  seats: z
    .array(seatDefinitionSchema)
    .max(PLAYER_COLOURS.length)
    .refine((seats) => new Set(seats.map((seat) => seat.colour)).size === seats.length, {
      message: 'seat colours must be unique',
    }),
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
 * A controller's preview selection. `tokenId: null` clears it — the player deselected, or the board
 * moved on and the selection stopped meaning anything.
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
 * Several pieces can share a tile and the host fans them out with these offsets. A viewer that knew
 * only `coordinates` would stack them all on one another and mis-scale them, so this travels too.
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
  /** Direction of the last move, or null. Drives animation timing on a viewer. */
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

/* ------------------------------------------------------------------- types */

export type TSeatDefinition = z.infer<typeof seatDefinitionSchema>;

/** What a controller is told about a seat. Never includes `seatToken`. */
export type TSeatSummary = {
  colour: TPlayerColour;
  name: string;
  isBot: boolean;
  claimed: boolean;
  connected: boolean;
  /** True once at least one phone has paired to this seat. */
  paired: boolean;
};

export type TGameIntent =
  | { kind: 'roll' }
  | { kind: 'move'; tokenId: number };

/** A `game:intent` as the host receives it — the server stamps `fromColour` from the seat. */
export type THostIntent = TGameIntent & { fromColour: TPlayerColour };

/** A `game:select` as the host receives it. Not an action — a preview to highlight. */
export type THostSelection = {
  fromColour: TPlayerColour;
  tokenId: number | null;
};

export type TProjectionToken = {
  id: number;
  isActive: boolean;
  isLocked: boolean;
  hasTokenReachedHome: boolean;
  coordinates: TCoordinate;
  tokenAlignmentData: TTokenAlignmentData;
  direction: TTokenDirection | null;
};

export type TProjectionPlayer = {
  colour: TPlayerColour;
  name: string;
  isBot: boolean;
  playerFinishTime: number;
  tokens: TProjectionToken[];
};

export type TProjectionDice = {
  colour: TPlayerColour;
  diceNumber: number;
  isPlaceholderShowing: boolean;
};

export type TProjection = z.infer<typeof projectionSchema>;

export type TProjectionPhase = TProjection['phase'];

/* ------------------------------------------------------------------- acks */

export type TAck<T> = ({ ok: true } & T) | { ok: false; error: TErrorCode };

export type TRoomCreateAck = TAck<{ code: string }>;
/** `hostPresent` is part of the ack, not just `room:seats` — see docs/protocol.md §4, `room:join`. */
export type TRoomJoinAck = TAck<{ seats: TSeatSummary[]; hostPresent: boolean }>;
export type TRoomRehostAck = TAck<{ seats: TSeatSummary[] }>;
export type TRoomClaimAck = TAck<{
  seatToken: string;
  /** The weaker credential a phone can pair with. Only ever shown to the seat's owner. */
  pairToken: string;
  colour: TPlayerColour;
  name: string;
}>;
export type TRoomReclaimAck = TAck<{
  colour: TPlayerColour;
  name: string;
  /**
   * The same pairing credential `room:claim` returns, and for the same reason: whoever holds the
   * `seatToken` owns the seat, and showing the pairing QR is an owner's act. A PC that reloads
   * reclaims with a new socket, and without this it could never show its QR again — the phone that
   * had not yet scanned it would be shut out of the seat for the rest of the game.
   */
  pairToken: string;
}>;
export type TSimpleAck = TAck<Record<string, never>>;
