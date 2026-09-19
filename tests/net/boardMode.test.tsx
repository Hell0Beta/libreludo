// @vitest-environment jsdom
/**
 * The board's two modes.
 *
 * `boardMode` is small, but it is the seam that decides whether a click plays the game or asks
 * someone else to. Getting it wrong is not a visible break — a viewer with the switch stuck on
 * `local` renders a correct board and then plays a *private* game that diverges from the host on the
 * first move — so the properties worth pinning are the ones that are invisible on screen: that the
 * local fallback is what a missing provider gives you, and that remote mode refuses a colour it does
 * not hold.
 */

import { describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../src/state/store';
import {
  useBoardActions,
  useRemoteBoardActions,
  type TBoardActions,
} from '../../src/net/boardMode';
import BoardModeProvider from '../../src/net/BoardModeProvider';
import type { TPlayerColour } from '../../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Render a hook and hand back what it returned.
 *
 * `store` is the app's real singleton rather than a fresh one: `useBoardActions` reaches for
 * `requestTokenMove` through `useDispatch`, and the assertion for local mode is about what the
 * *dispatch* did — so the action has to land somewhere observable.
 */
function capture(
  useValue: () => TBoardActions,
  wrap: (node: ReactElement) => ReactElement = (node) => node
): () => TBoardActions {
  const host = document.createElement('div');
  const root = createRoot(host);
  const box: { value: TBoardActions | null } = { value: null };

  function Probe() {
    box.value = useValue();
    return null;
  }

  act(() => {
    root.render(<Provider store={store}>{wrap(<Probe />)}</Provider>);
  });

  return () => {
    if (!box.value) throw new Error('the probe never rendered');
    return box.value;
  };
}

describe('Test net/boardMode', () => {
  describe('useBoardActions without a provider', () => {
    it('should be local, and allow every colour', () => {
      const actions = capture(() => useBoardActions())();
      expect(actions.mode).toBe('local');
      // Hotseat is one person taking every turn, so there is no colour this screen may not act for.
      expect(actions.canActFor('blue')).toBe(true);
      expect(actions.canActFor('yellow')).toBe(true);
    });

    it('should dispatch a move rather than sending one', () => {
      const before = store.getState().players.pendingMove;
      const actions = capture(() => useBoardActions())();
      act(() => actions.move('blue', 2));

      const after = store.getState().players.pendingMove;
      expect(after).not.toBe(before);
      expect(after).toMatchObject({ colour: 'blue', id: 2 });
    });
  });

  describe('useRemoteBoardActions', () => {
    function remote(seatColour: TPlayerColour | null, roll = vi.fn(), move = vi.fn()) {
      const actions = capture(() => useRemoteBoardActions({ seatColour, roll, move }))();
      return { actions, roll, move };
    }

    it('should be remote, and act only for its own seat', () => {
      const { actions } = remote('red');
      expect(actions.mode).toBe('remote');
      expect(actions.canActFor('red')).toBe(true);
      expect(actions.canActFor('blue')).toBe(false);
    });

    it('should refuse every colour before a seat is taken', () => {
      const { actions } = remote(null);
      // Still picking, or the seat was lost: watch, do not touch.
      expect(actions.canActFor('blue')).toBe(false);
      expect(actions.canActFor('red')).toBe(false);
    });

    it('should send its own roll and drop everyone else’s', () => {
      const { actions, roll } = remote('red');
      actions.roll('red');
      actions.roll('blue');
      // The host guards this too, but an intent for another player's turn should never leave the
      // screen that has no business sending it.
      expect(roll).toHaveBeenCalledTimes(1);
    });

    it('should send its own move and drop everyone else’s', () => {
      const { actions, move } = remote('red');
      actions.move('red', 3);
      actions.move('blue', 1);
      expect(move).toHaveBeenCalledTimes(1);
      expect(move).toHaveBeenCalledWith(3);
    });

    it('should not touch the store, even for its own colour', () => {
      const before = store.getState().players.pendingMove;
      const { actions } = remote('blue');
      act(() => {
        actions.move('blue', 0);
        actions.roll('blue');
      });
      // A viewer that wrote `pendingMove` would drive the local move pipeline against a mirrored
      // board — the divergence this whole module exists to prevent.
      expect(store.getState().players.pendingMove).toBe(before);
    });
  });

  describe('useBoardActions under a provider', () => {
    it('should hand back the remote implementation rather than build a local one', () => {
      const roll = vi.fn();
      const move = vi.fn();
      const remoteActions: TBoardActions = {
        mode: 'remote',
        canActFor: (colour) => colour === 'green',
        roll,
        move,
      };

      const actions = capture(
        () => useBoardActions(),
        (node) => <BoardModeProvider actions={remoteActions}>{node}</BoardModeProvider>
      )();

      expect(actions.mode).toBe('remote');
      expect(actions.canActFor('green')).toBe(true);
      actions.roll('green');
      expect(roll).toHaveBeenCalledWith('green');
    });
  });
});
