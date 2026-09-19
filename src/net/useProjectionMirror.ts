/**
 * Mirror a host's projection into the game slices, so a **viewer** renders the real board.
 *
 * A viewer is a PC that joined someone else's room. It holds a seat and can act for it, but it is
 * not authoritative about anything: every pixel it draws came off the wire.
 *
 * The phone does not use this. `useController` renders straight from `room.projection` — a list of
 * pieces and a die, no board — and that is deliberate: a phone that hydrated into `players`,
 * `board`, `dice` and `session` would be carrying four slices' worth of rules it never applies. A
 * viewer *does* draw the board, and the board is a large, animated, well-tested component that
 * reads those slices. Rewriting it against `TProjection` would leave two boards to keep in step,
 * and the one nobody plays on is the one that rots. So the frame is poured into the slices instead
 * and `Board`, `Token` and `Dice` never learn that the game is somewhere else.
 *
 * What stops the viewer acting like a host is not this hook — it is `BoardMode` (see
 * `src/net/boardMode.tsx`), which turns a click into an intent instead of a local move. Keep the
 * two together: mirroring without the mode switch would give the viewer a board it could play on
 * locally, which would diverge from the host on the first move and never come back.
 */

import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import type { AppDispatch } from '../state/store';
import { mirrorProjectedPlayers } from '../state/slices/playersSlice';
import { mirrorProjectedDice } from '../state/slices/diceSlice';
import { useCleanup } from '../hooks/useCleanup';
import type { TProjection } from './protocol';

export function useProjectionMirror(projection: TProjection | null) {
  const dispatch = useDispatch<AppDispatch>();
  const cleanup = useCleanup();

  useEffect(() => {
    if (!projection) return;
    dispatch(
      mirrorProjectedPlayers({
        players: projection.players,
        currentPlayerColour: projection.currentPlayerColour,
        isAnyTokenMoving: projection.isAnyTokenMoving,
        isGameEnded: projection.isGameEnded,
      })
    );
    dispatch(mirrorProjectedDice(projection.dice));
  }, [dispatch, projection]);

  /*
   * Someone else's game must not outlive the screen that was showing it. Without this, leaving a
   * room and starting a local hotseat would begin against whatever was left in the slices — and
   * `Game.tsx` only overwrites them when a save exists, so on a fresh browser it would not.
   *
   * Runs on unmount only. `cleanup` is stable, so the empty-looking dependency list is the real
   * one, not a lie about what the effect reads.
   */
  useEffect(() => cleanup, [cleanup]);
}
