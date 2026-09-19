/**
 * Room code generation.
 *
 * 4 characters from an ambiguity-free alphabet: the digits `0`/`1` and the letters `I`/`L`
 * (and, as documented, `O`) are excluded so a code can be read aloud or dictated without
 * confusion. See docs/protocol.md §2.
 *
 * NOTE: `ROOM_CODE_ALPHABET` below is 30 characters, not the 31 that protocol.md §2 claims.
 * The literal string in the document also omits `U` (30⁴ = 810 000, not 31⁴). The literal
 * string is implemented here because a code drawn from it is valid under *both* readings;
 * emitting `U` would be rejected by a client that copied the document's string verbatim.
 *
 * Codes are produced with `crypto.randomBytes` and **rejection sampling**: bytes that would
 * make the mapping from byte to symbol non-uniform are discarded rather than folded with a
 * modulo. 256 / 30 = 8.53..., so accepting only the first 240 bytes and then splitting that
 * range into 30 buckets of exactly 8 gives every symbol an identical probability.
 */

import { randomBytes } from 'node:crypto';

/** The wire alphabet. Order is irrelevant to correctness, but keep it stable. */
// 30 characters: 2-9, A-Z minus I, L, O and U. See the note above about protocol.md's "31".
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Every code is exactly this many characters. */
export const ROOM_CODE_LENGTH = 4;

/** How many times to redraw a whole code before giving up on finding a free one. */
export const DEFAULT_MAX_CODE_ATTEMPTS = 1000;

const BYTE_VALUES = 256;
const SAMPLES_PER_SYMBOL = Math.floor(BYTE_VALUES / ROOM_CODE_ALPHABET.length); // 8
const MAX_ACCEPTED_BYTE = SAMPLES_PER_SYMBOL * ROOM_CODE_ALPHABET.length; // 248
const MAX_REFILLS = 64;

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`, 'i');

/** Thrown when no free code could be found in `maxAttempts` draws. */
export class RoomCodeExhaustedError extends Error {
  constructor(attempts) {
    super(`Could not find a free room code after ${attempts} attempts`);
    this.name = 'RoomCodeExhaustedError';
    this.attempts = attempts;
  }
}

/** Case-insensitive test for "is this a syntactically valid room code". */
export function isRoomCode(value) {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value.trim());
}

/**
 * Codes are case-insensitive on input and uppercase on the wire (protocol.md §2).
 * Returns the empty string for non-string input rather than throwing.
 */
export function normalizeRoomCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/**
 * Draw one code. Does not consider collisions — use `generateRoomCode` for that.
 *
 * @param {(size: number) => Uint8Array} [randomBytesFn] injectable for tests
 */
export function randomRoomCode(randomBytesFn = randomBytes) {
  let code = '';
  let refills = 0;

  while (code.length < ROOM_CODE_LENGTH) {
    if (refills++ >= MAX_REFILLS) {
      throw new Error('Room code generation failed: random source produced too many rejected bytes');
    }

    const bytes = randomBytesFn(ROOM_CODE_LENGTH * 2);

    for (const byte of bytes) {
      // Rejection sampling: a byte in [248, 255] has no bucket, so discard it. Its absence is
      // what makes `Math.floor(byte / 8)` a uniform draw over the 31 symbols.
      if (byte >= MAX_ACCEPTED_BYTE) continue;

      code += ROOM_CODE_ALPHABET[Math.floor(byte / SAMPLES_PER_SYMBOL)];

      if (code.length === ROOM_CODE_LENGTH) break;
    }
  }

  return code;
}

/**
 * Draw codes until one is not taken.
 *
 * @param {object} [options]
 * @param {(code: string) => boolean} [options.isTaken] predicate over the live room map
 * @param {number} [options.maxAttempts]
 * @param {(size: number) => Uint8Array} [options.randomBytesFn]
 * @throws {RoomCodeExhaustedError}
 */
export function generateRoomCode({
  isTaken = () => false,
  maxAttempts = DEFAULT_MAX_CODE_ATTEMPTS,
  randomBytesFn = randomBytes,
} = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = randomRoomCode(randomBytesFn);
    if (!isTaken(code)) return code;
  }

  throw new RoomCodeExhaustedError(maxAttempts);
}
