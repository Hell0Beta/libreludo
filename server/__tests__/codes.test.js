// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_CODE_ATTEMPTS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  RoomCodeExhaustedError,
  generateRoomCode,
  isRoomCode,
  normalizeRoomCode,
  randomRoomCode,
} from '../codes.js';

/** A `randomBytes` stand-in that cycles a fixed byte pattern. */
function byteSource(bytes) {
  let cursor = 0;
  return (size) => {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) out[i] = bytes[cursor++ % bytes.length];
    return out;
  };
}

describe('room codes', () => {
  it('uses the ambiguity-free alphabet from protocol.md', () => {
    // The document says "31 characters", but the literal string it prints is 30 (it omits U
    // as well as I, L, O, 0 and 1). The literal string wins; see server/codes.js.
    expect(ROOM_CODE_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(ROOM_CODE_ALPHABET).toHaveLength(30);
    expect(ROOM_CODE_LENGTH).toBe(4);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[ILO01U]/);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
  });

  it('never produces I, L, O, 0 or 1 across many samples', () => {
    const samples = 20_000;
    const seen = new Set();
    const malformed = [];

    for (let i = 0; i < samples; i++) {
      const code = randomRoomCode();
      if (code.length !== ROOM_CODE_LENGTH || !/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(code)) {
        malformed.push(code);
      }
      for (const character of code) seen.add(character);
    }

    // Asserted once over the whole sample rather than per draw. Six matchers per iteration is
    // 120 000 assertions, which is slow enough to blow the 5 s default timeout when the suite runs
    // files in parallel — it made this test flaky without testing anything more.
    expect(malformed).toEqual([]);

    // Every symbol of the alphabet must be reachable: a mapping bug (an off-by-one that never
    // yields the last bucket) would leave `Z` unobserved over 80 000 draws.
    expect([...seen].sort().join('')).toBe([...ROOM_CODE_ALPHABET].sort().join(''));
  });

  it('discards out-of-range bytes instead of folding them with a modulo', () => {
    // 240..255 have no bucket. Feeding them should advance the stream, not emit a symbol.
    expect(randomRoomCode(byteSource([255, 254, 248, 0]))).toBe('2222');
    // 239 is the last accepted byte and maps to the final symbol.
    expect(randomRoomCode(byteSource([239]))).toBe('ZZZZ');
    // 240 is rejected even though a plain modulo would have called it symbol 0.
    expect(randomRoomCode(byteSource([240, 241, 242, 243, 244, 245, 246, 247, 120]))).toBe('HHHH');
  });

  it('retries a collision and terminates once a code is free', () => {
    let calls = 0;

    const code = generateRoomCode({
      randomBytesFn: byteSource([0]),
      isTaken: () => {
        calls++;
        return calls <= 3; // three collisions, then free
      },
    });

    expect(code).toBe('2222');
    expect(calls).toBe(4);
  });

  it('gives up with a typed error when every draw collides', () => {
    expect(() =>
      generateRoomCode({ randomBytesFn: byteSource([0]), isTaken: () => true, maxAttempts: 5 })
    ).toThrow(RoomCodeExhaustedError);

    try {
      generateRoomCode({ randomBytesFn: byteSource([0]), isTaken: () => true, maxAttempts: 5 });
    } catch (error) {
      expect(error).toBeInstanceOf(RoomCodeExhaustedError);
      expect(error.attempts).toBe(5);
    }

    expect(DEFAULT_MAX_CODE_ATTEMPTS).toBeGreaterThanOrEqual(100);
  });

  it('normalizes codes case-insensitively on input', () => {
    expect(normalizeRoomCode(' ab2c ')).toBe('AB2C');
    expect(isRoomCode('ab2c')).toBe(true);
    expect(isRoomCode('ab2')).toBe(false);
    expect(isRoomCode('ABCI')).toBe(false);
    expect(isRoomCode('AB0C')).toBe(false);
    expect(isRoomCode(null)).toBe(false);
  });
});
