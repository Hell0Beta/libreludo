/**
 * Who is allowed to act on this board, and what happens when they do.
 *
 * The board is rendered in two very different situations and the components in between should not
 * have to care which:
 *
 *   - **Local.** `/play` and the host's `/room/:code`. This machine owns the game. A click runs the
 *     rules — `usePerformRoll` for a die, `requestTokenMove` for a piece — and the result is the
 *     truth. Every colour is playable, because hotseat is a real mode and the host also plays.
 *   - **Remote.** A PC that joined someone else's room. The board it is looking at is a mirror of a
 *     frame (see `useProjectionMirror`); the rules live on another machine. A click has to become a
 *     `game:intent` and nothing else, and only for the one colour this screen holds a seat for.
 *
 * Passing that distinction down as props would mean threading four callbacks and a colour through
 * `Board` into every `Token` and `Dice`, on a path where all but one caller wants the default. A
 * context with a local fallback means the local screens change not at all: no provider, no
 * behaviour change, no new prop.
 *
 * **The fallback is the important part.** `useBoardActions` builds the local implementation
 * unconditionally and returns the remote one only when a provider is above it. A missing provider
 * is therefore "this is the host's own board", which is the correct reading and not a bug — so a
 * component that forgets to handle remote mode fails towards the behaviour that was already there.
 *
 * The provider component lives in `BoardModeProvider.tsx`; it is separate only so that this file,
 * which exports no components, does not defeat React Fast Refresh for the one that does.
 */

import { createContext, useContext, useMemo } from 'react';
import { useDispatch } from 'react-redux';
import { requestTokenMove } from '../state/slices/playersSlice';
import { usePerformRoll } from '../hooks/usePerformRoll';
import { logError } from '../utils/logError';
import type { AppDispatch } from '../state/store';
import type { TPlayerColour } from '../types';

export type TBoardActions = {
  /**
   * `'local'` means this machine decides; `'remote'` means it asks. Exposed as well as the
   * callbacks because a few places need to *not do something* rather than do it differently —
   * `Token` skips the local move pipeline entirely in remote mode.
   */
  mode: 'local' | 'remote';
  /**
   * Whether this screen may act for a colour at all. Local play says yes to every colour, because
   * hotseat is one person taking all the turns. A viewer says yes to exactly one.
   */
  canActFor: (colour: TPlayerColour) => boolean;
  /** Roll for a colour: locally, run the roll; remotely, send a `roll` intent. */
  roll: (colour: TPlayerColour) => void;
  /** Move a piece: locally, dispatch `requestTokenMove`; remotely, send a `move` intent. */
  move: (colour: TPlayerColour, tokenId: number) => void;
};

/** Null means "no provider", which is the host's own board. See the note above. */
export const BoardModeContext = createContext<TBoardActions | null>(null);

export function useBoardActions(): TBoardActions {
  const remote = useContext(BoardModeContext);
  const dispatch = useDispatch<AppDispatch>();
  const performRoll = usePerformRoll();

  return useMemo<TBoardActions>(() => {
    if (remote) return remote;
    return {
      mode: 'local',
      canActFor: () => true,
      // `usePerformRoll` is async and the callers are click handlers, so the rejection has to be
      // caught here — an unhandled one in an event handler is a console error and nothing else.
      roll: (colour) => {
        performRoll(colour).catch(logError('boardMode.localRoll'));
      },
      move: (colour, tokenId) => {
        dispatch(requestTokenMove({ colour, id: tokenId }));
      },
    };
  }, [dispatch, performRoll, remote]);
}

/**
 * The remote implementation, built from a controller's emitters.
 *
 * Lives here rather than in the page so that the two halves of the decision — what local mode does
 * and what remote mode does — are readable side by side. A drift between them is the failure this
 * whole module exists to prevent.
 */
export function useRemoteBoardActions({
  seatColour,
  roll,
  move,
}: {
  seatColour: TPlayerColour | null;
  roll: () => void;
  move: (tokenId: number) => void;
}): TBoardActions {
  return useMemo<TBoardActions>(
    () => ({
      mode: 'remote',
      // No seat yet — still picking, or the seat was lost. Watch, do not touch.
      canActFor: (colour) => seatColour !== null && colour === seatColour,
      roll: (colour) => {
        if (colour !== seatColour) return;
        roll();
      },
      move: (colour, tokenId) => {
        if (colour !== seatColour) return;
        move(tokenId);
      },
    }),
    [move, roll, seatColour]
  );
}
