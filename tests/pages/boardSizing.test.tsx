// @vitest-environment jsdom
/**
 * The board must declare `--board-tile-size` on its own root.
 *
 * This is a regression test for a bug that shipped: everything the board draws is sized from that
 * custom property (`Dice.module.css` computes every die's height, width, radius and padding from
 * it), and it used to be set by `Game.tsx` on its wrapper. `/room/:code` renders `<Board />`
 * directly, so the variable was undefined there, `calc(var(--board-tile-size) * n)` was invalid,
 * the height and width declarations were dropped, and the dice fell back to their source image's
 * intrinsic size — enormous ones.
 *
 * The failure was invisible to every other gate: types pass, lint passes, nothing throws, and the
 * board still renders. It only shows on a screen, which is exactly the kind of thing a test has to
 * hold.
 *
 * One test, seeded once: the store is a module singleton shared by every test in a file, so seeding
 * twice registers the same players a second time and the second render is no longer the state the
 * first assertion was written against.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import Board from '../../src/pages/Play/components/Board/Board';
import { registerDice } from '../../src/state/slices/diceSlice';
import { resizeBoard } from '../../src/state/slices/boardSlice';
import { store } from '../../src/state/store';
import { registerNewPlayer, setPlayerSequence } from '../../src/state/slices/playersSlice';

describe('Board sizing contract', () => {
  it('declares --board-tile-size on its own root element', () => {
    store.dispatch(setPlayerSequence({ playerCount: 'two' }));
    store.dispatch(registerNewPlayer({ name: 'Alice', colour: 'blue', isBot: false }));
    store.dispatch(registerNewPlayer({ name: 'Bob', colour: 'green', isBot: false }));
    store.dispatch(registerDice('blue'));
    store.dispatch(registerDice('green'));
    // The board measures itself in a real browser; give it a size so the derived value is non-zero.
    store.dispatch(resizeBoard(600));

    const markup = renderToStaticMarkup(
      <Provider store={store}>
        <Board />
      </Provider>
    );

    const tileSize = store.getState().board.boardTileSize;
    expect(tileSize).toBeGreaterThan(0);

    // It must be on the *outermost* element. A child would not help a board rendered without
    // `Game`'s wrapper, which is precisely the case that broke.
    expect(markup.startsWith('<div')).toBe(true);
    const rootTag = markup.slice(0, markup.indexOf('>'));
    expect(rootTag).toContain(`--board-tile-size:${tileSize}px`);
  });
});
