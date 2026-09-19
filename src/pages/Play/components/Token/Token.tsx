import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deactivateAllTokens,
  getToken,
  setIsAnyTokenMoving,
} from '../../../../state/slices/playersSlice';
import { type TPlayer, type TPlayerColour } from '../../../../types';
import { type TToken } from '../../../../types';
import { useDispatch, useSelector, useStore } from 'react-redux';
import type { AppDispatch, RootState } from '../../../../state/store';
import TokenImage from '../../../../assets/token.svg?react';
import { useCoordsToPosition } from '../../../../hooks/useCoordsToPosition';
import { useMoveAndCaptureToken } from '../../../../hooks/useMoveAndCaptureToken';
import { playerColours } from '../../../../game/players/constants';
import { transitionStates } from '../../../../game/tokens/constants';
import styles from './Token.module.css';
import clsx from 'clsx';
import { getGloballyUniqueTokenId } from '../../../../game/tokens/logic';
import { useChangeTurn } from '../../../../hooks/useChangeTurn';
import { useUnlockAndAlignTokens } from '../../../../hooks/useUnlockAndAlignTokens';
import { saveState } from '../../../../game/storage/saveState';
import { animate, motion, useMotionValue } from 'framer-motion';
import { tokenMotionRegistry } from '../../../../game/movement/tokenMotionRegistry';
import { logError } from '../../../../utils/logError';
import { useBoardActions } from '../../../../net/boardMode';

type Props = {
  colour: TPlayerColour;
  id: number;
};

/**
 * How far the number is allowed to grow back after the pin is shrunk to share a tile.
 *
 * The honest inverse of the smallest fan-out scale (0.55) is 1.82, and it is wrong: pins four to a
 * tile sit only ~0.36 of a tile apart, so a badge at 1.82× would be wider than the gap to its
 * neighbour and the four numbers would run into one another — at exactly the moment there are four
 * of them to tell apart. Capped just short of touching.
 *
 * `Math.min` also does the guard duty: a scale of 0 or `NaN` off a malformed frame gives `Infinity`
 * or `NaN` here, and both clamp to a sane number rather than reaching CSS as an invalid transform.
 */
const MAX_BADGE_SCALE = 1.3;

function badgeScaleFor(scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return 1;
  return Math.min(1 / scaleFactor, MAX_BADGE_SCALE);
}

export default function Token({ colour, id }: Props) {
  const dispatch = useDispatch<AppDispatch>();
  const actions = useBoardActions();
  // A viewer may only touch its own colour, and it may not move anything itself — the click below
  // becomes an intent. See `src/net/boardMode.tsx`.
  const canAct = actions.canActFor(colour);
  const { tokenHeight, tokenWidth } = useSelector((state: RootState) => state.board);
  const { players } = useSelector((state: RootState) => state.players);
  // A board click and a network move intent both land in `players.pendingMove`, so this one
  // effect is the single entry point for "move this token".
  const tokenClickData = useSelector((state: RootState) => state.players.pendingMove);
  /*
   * The piece a phone is *considering* moving. Four pieces of a colour are drawn identically, so
   * "Piece 2" on the controller is meaningless to someone looking at the board — this is what makes
   * the first of the two taps visible. Gated on `isActive` so a preview that has gone stale (the
   * turn passed, the piece was captured) simply stops lighting up rather than pointing at a piece
   * that can no longer move.
   */
  const previewToken = useSelector((state: RootState) => state.room.previewToken);
  const tokenClickDataRef = useRef(tokenClickData);
  const [isCurrentlyFocused, setIsCurrentlyFocused] = useState(false);
  const tokenElRef = useRef<HTMLButtonElement | null>(null);
  const changeTurnFn = useChangeTurn();
  const unlockAndAlignTokens = useUnlockAndAlignTokens();
  const store = useStore<RootState>();
  const isExternallyAnimating = useRef(false);
  const { numberOfConsecutiveSix, tokens: playerTokens } = useMemo(
    () => players.find((v) => v.colour === colour),
    [players, colour]
  ) as TPlayer;
  const token = useMemo(() => playerTokens.find((t) => t.id === id), [playerTokens, id]) as TToken;

  const { coordinates, isActive, isLocked, tokenAlignmentData, direction } = token;

  const { scaleFactor } = tokenAlignmentData;
  const getPosition = useCoordsToPosition();
  const { x, y } = getPosition(coordinates, tokenAlignmentData);
  const diceNumber = useSelector((state: RootState) =>
    state.dice.dice.find((d) => d.colour === colour)
  )?.diceNumber;
  const moveAndCapture = useMoveAndCaptureToken();
  const motionX = useMotionValue<number>(x);
  const motionY = useMotionValue<number>(y);

  useEffect(() => {
    if (isExternallyAnimating.current) return;
    Promise.all([
      animate(motionX, x, {
        duration: direction ? transitionStates[direction].durationMs / 1000 : 0,
        ease: direction ? transitionStates[direction].timingFn : undefined,
      }),
      animate(motionY, y, {
        duration: direction ? transitionStates[direction].durationMs / 1000 : 0,
        ease: direction ? transitionStates[direction].timingFn : undefined,
      }),
    ]).catch(logError('Token.animate'));
  }, [direction, motionX, motionY, x, y]);
  useEffect(() => {
    tokenMotionRegistry.set(getGloballyUniqueTokenId(colour, id), {
      x: motionX,
      y: motionY,
      setExternallyAnimating: (v) => {
        isExternallyAnimating.current = v;
      },
      animateTo: (x, y, transition) =>
        Promise.all([animate(motionX, x, transition), animate(motionY, y, transition)]).then(
          () => {}
        ),
    });
    return () => {
      tokenMotionRegistry.delete(getGloballyUniqueTokenId(colour, id));
    };
  }, [colour, id, motionX, motionY]);

  /*
   * Memoised because `performMove` below depends on it, and `performMove` is a dependency of the
   * effect that handles a network move intent. Left un-memoised, `unlock` gets a new identity every
   * render, which gives the effect a new dependency every render and re-runs it continuously.
   */
  const unlock = useCallback(async () => {
    try {
      dispatch(setIsAnyTokenMoving(true));
      unlockAndAlignTokens({ colour, id });
      dispatch(deactivateAllTokens(colour));
      const updatedToken = getToken(store.getState().players, colour, id);
      const { x: targetX, y: targetY } = getPosition(
        updatedToken.coordinates,
        updatedToken.tokenAlignmentData
      );
      const entry = tokenMotionRegistry.get(getGloballyUniqueTokenId(colour, id));
      if (!entry) return;
      entry.setExternallyAnimating(true);
      await entry.animateTo(targetX, targetY, {
        duration: transitionStates.forward.durationMs / 1000,
        ease: transitionStates.forward.timingFn,
      });
      entry.setExternallyAnimating(false);
      dispatch(setIsAnyTokenMoving(false));
      saveState(store.getState());
    } catch (e) {
      logError('Token.unlock')(e);
    }
  }, [colour, dispatch, getPosition, id, store, unlockAndAlignTokens]);

  const executeTokenMove = useCallback(async () => {
    try {
      if (!isActive || diceNumber === -1 || !diceNumber || isLocked) return;
      const moveData = await moveAndCapture(token, diceNumber);
      if (!moveData) return;
      const { hasTokenReachedHome, isCaptured, hasPlayerWon } = moveData;
      if (hasPlayerWon) return changeTurnFn();
      if (
        (diceNumber !== 6 || numberOfConsecutiveSix >= 3) &&
        !isCaptured &&
        !hasTokenReachedHome
      ) {
        return changeTurnFn();
      }
      saveState(store.getState());
    } catch (e) {
      logError('Token.executeTokenMove')(e);
    }
  }, [
    changeTurnFn,
    diceNumber,
    isActive,
    isLocked,
    moveAndCapture,
    numberOfConsecutiveSix,
    store,
    token,
  ]);

  /**
   * The single entry point for "move this token", shared by a board click and a network intent.
   *
   * A piece still in the yard is **released**, not moved: `unlock` lifts it to its start square and
   * clears the lock. `executeTokenMove` refuses a locked token by design, so skipping that step is
   * not a cosmetic difference — without it a controller can never bring a piece out, which is the
   * entire point of rolling a six. Local clicks always did this; the network path did not, so a
   * phone could select a yard piece and then have nothing happen on the second tap.
   */
  const performMove = useCallback(async () => {
    if (isLocked && isActive && diceNumber !== -1 && diceNumber) void unlock();
    await executeTokenMove();
  }, [diceNumber, executeTokenMove, isActive, isLocked, unlock]);

  useEffect(() => {
    // A viewer never runs the move pipeline. Its `pendingMove` is never written — `useRoom` writes
    // it on the host, and a mirrored frame does not carry it — so this would be a no-op, but the
    // guard is what makes that a property of the code rather than a fact about today's traffic.
    if (actions.mode === 'remote') return;

    const prevClickData = tokenClickDataRef.current;
    const newTokenClickData = tokenClickData;

    if (!newTokenClickData || prevClickData?.timestamp === newTokenClickData.timestamp) return;
    tokenClickDataRef.current = newTokenClickData;

    if (newTokenClickData.colour === colour && newTokenClickData.id === id) void performMove();
  }, [actions.mode, colour, id, performMove, tokenClickData]);

  const handleTokenClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    if (e.detail === 0) e.stopPropagation();
    tokenElRef.current?.blur?.();

    if (actions.mode === 'remote') {
      /*
       * Stop the click reaching the board. `Board` resolves a tap to whichever active piece of the
       * current colour sits on that tile and sends its own move — correct for a tap on empty board,
       * a duplicate intent for a tap that landed on the piece itself, which is exactly what this is.
       */
      e.stopPropagation();
      actions.move(colour, id);
      return;
    }

    void performMove();
  };

  return (
    <motion.button
      id={getGloballyUniqueTokenId(colour, id)}
      className={clsx(styles.token, {
        [styles.previewed]: isActive && previewToken?.colour === colour && previewToken.id === id,
      })}
      /*
       * The only accessible name a pin has. The board draws four identical pawns per colour and the
       * SVG is `aria-hidden`, so without this every piece is an unlabelled button — which is also
       * what a screen reader needs in order to say which piece it is offering to move.
       *
       * "Piece 3" and not "Pin 3" or "Token 3": it is the exact phrase the phone controller uses, so
       * a player can say the number out loud and both screens agree on what it means.
       */
      aria-label={`Piece ${id + 1}`}
      tabIndex={isActive && canAct ? undefined : -1}
      onFocus={() => setIsCurrentlyFocused(true)}
      onBlur={() => setIsCurrentlyFocused(false)}
      disabled={!isActive || !canAct}
      onClick={handleTokenClick}
      ref={tokenElRef}
      animate={{ scale: scaleFactor }}
      transition={{
        duration: direction ? transitionStates[direction].durationMs / 1000 : 0,
        ease: direction ? transitionStates[direction].timingFn : undefined,
      }}
      style={{
        height: tokenHeight,
        width: tokenWidth,
        x: motionX,
        y: motionY,
      }}
    >
      <span className={clsx(styles.bouncer, { [styles.active]: isActive && !isCurrentlyFocused })}>
        <TokenImage
          className={styles.svg}
          aria-hidden="true"
          style={
            {
              '--fill-colour': playerColours[colour],
            } as React.CSSProperties
          }
        />

        {/*
         * The pin's number, so four identical pawns of one colour can be told apart on the board —
         * and so the board and the phone agree: "Piece 3" on the controller is the pin wearing a 3
         * here.
         *
         * Inside the bouncer rather than beside it, so it rides the bob. A number that hangs still
         * while the pawn under it bounces reads as a rendering bug, and it is the movable pins —
         * the bouncing ones — whose numbers matter most.
         *
         * `aria-hidden`, because the button above already carries the same fact as its accessible
         * name. Without this a screen reader reads the number twice.
         */}
        <span
          className={styles.number}
          aria-hidden="true"
          /*
           * Set here rather than on the button because framer-motion types `style` as `MotionStyle`,
           * which has no room for an arbitrary custom property — and this is a plain span, so it
           * takes the same cast every other custom property in the codebase does.
           */
          style={{ '--badge-scale': badgeScaleFor(scaleFactor) } as React.CSSProperties}
        >
          {id + 1}
        </span>
      </span>
    </motion.button>
  );
}
