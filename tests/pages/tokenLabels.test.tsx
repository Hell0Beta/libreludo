// @vitest-environment jsdom
/**
 * Every pin on the board is numbered.
 *
 * Four pawns of one colour are drawn identically, so before this the board could not answer "which
 * one is Piece 3?" — the question the phone controller asks with every tap, since it labels its
 * buttons `Piece 1`–`Piece 4`. The number on the pin is what makes the two screens agree.
 *
 * The two things a static gate cannot check, and this can:
 *
 *   1. That the number reaches the *rendered* board. The badge is a `<span>` inside a
 *      `motion.button` inside a CSS module; nothing about a type error would catch a missing child.
 *   2. That the button carries an accessible name. The SVG is `aria-hidden`, so without the
 *      `aria-label` every pin is an unlabelled button to a screen reader — a real regression that is
 *      invisible on screen.
 *
 * Seeded once: the store is a module singleton shared across a file, so registering the same players
 * twice throws, and the second render would no longer be the state the first assertions describe.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import Board from '../../src/pages/Play/components/Board/Board';
import { registerDice } from '../../src/state/slices/diceSlice';
import { resizeBoard } from '../../src/state/slices/boardSlice';
import { store } from '../../src/state/store';
import {
  registerNewPlayer,
  setPlayerSequence,
  setTokenAlignmentData,
} from '../../src/state/slices/playersSlice';

function renderBoard(): string {
  return renderToStaticMarkup(
    <Provider store={store}>
      <Board />
    </Provider>
  );
}

describe('Board pin labels', () => {
  store.dispatch(setPlayerSequence({ playerCount: 'two' }));
  store.dispatch(registerNewPlayer({ name: 'Alice', colour: 'blue', isBot: false }));
  store.dispatch(registerNewPlayer({ name: 'Bob', colour: 'green', isBot: false }));
  store.dispatch(registerDice('blue'));
  store.dispatch(registerDice('green'));
  // The board measures itself in a real browser; give it a size so the badge's `calc()` resolves to
  // something non-zero and the test is describing a board that could actually be looked at.
  store.dispatch(resizeBoard(600));

  it('names every pin for a screen reader, in the phone’s own words', () => {
    const markup = renderBoard();

    // "Piece N" is deliberate — the exact phrase the controller uses, so a number said out loud
    // means the same thing on both screens.
    for (const id of [0, 1, 2, 3]) {
      const occurrences = markup.split(`aria-label="Piece ${id + 1}"`).length - 1;
      // Two players, four pins each.
      expect(occurrences, `Piece ${id + 1} should label one pin per colour`).toBe(2);
    }
  });

  it('prints the number on the pin itself', () => {
    const markup = renderBoard();
    // The badge is the only text in a pin, so a count of the four digits across two colours is
    // enough to know the child rendered — and that it is not, say, an off-by-one `id`.
    expect(markup).toContain('>1</span>');
    expect(markup).toContain('>4</span>');
  });

  it('carries the counter-scale, so a fanned-out pin is still readable', () => {
    // A pin alone on its tile: nothing to correct for.
    expect(renderBoard()).toContain('--badge-scale:1');

    // Four pins in a starting yard — where a player looks after rolling a six, and the case the
    // badge would otherwise render at 55% of an already-tiny digit.
    store.dispatch(
      setTokenAlignmentData({
        colour: 'blue',
        id: 0,
        newAlignmentData: { xOffset: -0.18, yOffset: 0.2, scaleFactor: 0.55 },
      })
    );
    // Capped rather than the true inverse (1.82), which would be wider than the gap between
    // neighbouring pins and run four numbers into one another.
    expect(renderBoard()).toContain('--badge-scale:1.3');
  });
});
