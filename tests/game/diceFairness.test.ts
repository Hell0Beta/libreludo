/**
 * Are the dice fair?
 *
 * The answer is not "yes, they are a die" — they are a **bag**. `generateRollBag` is
 * `[1,2,3,4,5,6]` repeated six times, `useRollDice` picks a uniformly random *index* into it, and
 * `setDiceNumber` removes that element. So every individual draw is uniform over what is left, but
 * the draws are **not independent**: the bag holds exactly six of each face, refills only when
 * empty, and therefore hands out exactly six of each face per 36 rolls.
 *
 * That distinction is what this file pins down, because it is the thing a reader gets wrong. It
 * also means the two properties below are different, and both matter:
 *
 *   1. **Uniform** — over many rolls, no face is favoured. Which is what "is it truly random?"
 *      is usually asking, and the answer is yes.
 *   2. **Dependent** — 36 consecutive rolls contain six of every face, exactly. Runs are real, and
 *      they self-correct. A player who rolls four sixes early *will* roll fewer later.
 *
 * Deterministic by construction: a seeded PRNG stands in for `Math.random`, so the numbers are
 * reproducible and the tolerances can be tight. A fairness test that flakes is a test nobody
 * trusts, and this is exactly the kind of assertion that would get deleted the first time it went
 * red on an unrelated commit.
 */

import { describe, expect, it } from 'vitest';
import diceReducer, {
  generateRollBag,
  initialState,
  registerDice,
  renewRollBag,
  setDiceNumber,
  type TDiceState,
} from '../../src/state/slices/diceSlice';

/**
 * xorshift32 — small, seeded, and good enough to sample an index. Stands in for `Math.random`,
 * which is the only stochastic input the real roll path has.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Roll `draws` times through the **real reducers**, with the index rule copied from `useRollDice`:
 *
 *     if (bag.length === 0) dispatch(renewRollBag(colour));
 *     const index = Math.floor(Math.random() * bag.length);
 *
 * That one line is the only part of the roll that is not in the slice, so it is the only part
 * reproduced here — everything else is the shipping code.
 */
function roll(colour: 'blue' | 'red', draws: number, rng: () => number) {
  let state: TDiceState = diceReducer(initialState, registerDice(colour));
  const faces: number[] = [];

  for (let i = 0; i < draws; i++) {
    if (state.rollBag[colour].length === 0) state = diceReducer(state, renewRollBag(colour));
    const bag = state.rollBag[colour];
    const index = Math.floor(rng() * bag.length);
    faces.push(bag[index]);
    state = diceReducer(state, setDiceNumber({ colour, randomIndex: index }));
  }

  return faces;
}

function tally(faces: number[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const face of faces) counts[face - 1] += 1;
  return counts;
}

describe('Test game/dice fairness', () => {
  it('should start with six of every face', () => {
    expect(tally(generateRollBag())).toEqual([6, 6, 6, 6, 6, 6]);
  });

  it('should never empty the bag without refilling it', () => {
    // A bag drawn from while empty would index `undefined` and put `undefined` on the die, which
    // `getDiceImage` then throws on. Cheap to assert, and it is a crash rather than a bias.
    let state: TDiceState = diceReducer(initialState, registerDice('blue'));
    const rng = makeRng(7);
    for (let i = 0; i < 72; i++) {
      if (state.rollBag.blue.length === 0) state = diceReducer(state, renewRollBag('blue'));
      expect(state.rollBag.blue.length).toBeGreaterThan(0);
      const index = Math.floor(rng() * state.rollBag.blue.length);
      state = diceReducer(state, setDiceNumber({ colour: 'blue', randomIndex: index }));
      expect(state.dice[0].diceNumber).toBeGreaterThanOrEqual(1);
      expect(state.dice[0].diceNumber).toBeLessThanOrEqual(6);
    }
  });

  describe('uniformity', () => {
    it('should give every face the same chance over a long run', () => {
      const faces = roll('blue', 20_000, makeRng(20260919));
      const counts = tally(faces);
      const expected = faces.length / 6;

      for (const [face, count] of counts.entries()) {
        // Sampling without replacement has *lower* variance than independent rolls, so the real
        // spread here is far tighter than this bound. It is set wide enough to survive a seed
        // change and narrow enough that a one-face bias would blow straight through it.
        expect(
          Math.abs(count - expected) / expected,
          `face ${face + 1} came up ${count} times, expected about ${expected}`
        ).toBeLessThan(0.02);
      }
    });

    it('should not favour a colour — the bags are independent', () => {
      // The report that prompted this file was "player 2 seems to get more sixes", so the
      // per-colour comparison is the one worth making explicit.
      const blue = tally(roll('blue', 12_000, makeRng(11)));
      const red = tally(roll('red', 12_000, makeRng(22)));

      const sixes = (counts: number[]) => counts[5] / 12_000;
      expect(Math.abs(sixes(blue) - sixes(red))).toBeLessThan(0.02);
      expect(Math.abs(sixes(blue) - 1 / 6)).toBeLessThan(0.02);
      expect(Math.abs(sixes(red) - 1 / 6)).toBeLessThan(0.02);
    });
  });

  describe('dependence — the part that is not random', () => {
    it('should deliver exactly six of every face per 36 rolls', () => {
      const faces = roll('blue', 36 * 5, makeRng(3));
      for (let block = 0; block < 5; block++) {
        expect(tally(faces.slice(block * 36, block * 36 + 36))).toEqual([6, 6, 6, 6, 6, 6]);
      }
    });

    it('should make a run of sixes self-correcting', () => {
      /*
       * The consequence a player actually feels. Force the first four draws to be sixes and the
       * rest of that bag can only contain two more — so a lucky streak is always paid for inside
       * the same 36. This is the mechanism behind "the dice even out eventually", and also behind
       * the long droughts that follow a hot start.
       */
      let state: TDiceState = diceReducer(initialState, registerDice('blue'));
      for (let i = 0; i < 4; i++) {
        const bag = state.rollBag.blue;
        const sixAt = bag.indexOf(6);
        state = diceReducer(state, setDiceNumber({ colour: 'blue', randomIndex: sixAt }));
      }
      expect(state.rollBag.blue.filter((face) => face === 6)).toHaveLength(2);
      // And the bag is 32 long, so the next draw is uniform over what is left — not over a die.
      expect(state.rollBag.blue).toHaveLength(32);
    });
  });
});
