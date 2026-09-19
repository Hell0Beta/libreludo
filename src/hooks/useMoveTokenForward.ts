import { useDispatch, useStore } from 'react-redux';
import { type TToken } from '../types';
import { ERRORS } from '../utils/errors';
import type { AppDispatch, RootState } from '../state/store';
import { useCallback } from 'react';
import type { TSequenceCalculationResult } from '../types/tokens';
import { useUpdateTokenPositionAndAlignment } from './useUpdateTokenPositionAndAlignment';
import { deactivateAllTokens, getToken, setIsAnyTokenMoving } from '../state/slices/playersSlice';
import { tokenMotionRegistry } from '../game/movement/tokenMotionRegistry';
import { getGloballyUniqueTokenId } from '../game/tokens/logic';
import { useCoordsToPosition } from './useCoordsToPosition';
import { transitionStates } from '../game/tokens/constants';

/**
 * How long past the nominal animation to wait before giving up on a single step.
 *
 * A hidden tab throttles `requestAnimationFrame`, and framer-motion's `animate` then never
 * resolves — which would leave `isAnyTokenMoving` true and wedge the turn forever. The race is a
 * backstop: in a visible tab the animation always wins, so timing is unchanged.
 */
const MOVE_STEP_TIMEOUT_BUFFER_MS = 1200;

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

export const useMoveTokenForward = () => {
  const dispatch = useDispatch<AppDispatch>();
  const updateTokenPositionAndAlignment = useUpdateTokenPositionAndAlignment();
  const store = useStore<RootState>();
  const getPosition = useCoordsToPosition();

  return useCallback(
    async (
      moveSequence: TSequenceCalculationResult['moveSequence'],
      token: TToken
    ): Promise<void> => {
      const { colour, id, isLocked } = token;
      if (isLocked) throw new Error(ERRORS.lockedToken(colour, id));
      const { durationMs, timingFn } = transitionStates.forward;
      dispatch(deactivateAllTokens(colour));
      dispatch(setIsAnyTokenMoving(true));
      const entry = tokenMotionRegistry.get(getGloballyUniqueTokenId(colour, id));
      if (!entry) return;
      entry.setExternallyAnimating(true);
      for (const coord of moveSequence) {
        updateTokenPositionAndAlignment({ colour, id, newCoords: coord, direction: 'forward' });
        const updatedToken = getToken(store.getState().players, colour, id);
        const { x, y } = getPosition(coord, updatedToken.tokenAlignmentData);
        await withTimeout(
          entry.animateTo(x, y, { duration: durationMs / 1000, ease: timingFn }),
          durationMs + MOVE_STEP_TIMEOUT_BUFFER_MS
        );
      }
      entry.setExternallyAnimating(false);
      dispatch(setIsAnyTokenMoving(false));
    },
    [dispatch, store, updateTokenPositionAndAlignment, getPosition]
  );
};
