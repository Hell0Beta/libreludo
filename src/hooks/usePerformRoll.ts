import { useCallback } from 'react';
import type { TPlayerColour } from '../types';
import { useRollDice } from './useRollDice';
import { useHandlePostDiceRoll } from './useHandlePostDiceRoll';
import { useChangeTurn } from './useChangeTurn';

/**
 * The complete "roll for this colour" sequence, extracted from the inline body of `Dice.tsx` so
 * the host bridge can drive a network `roll` intent through exactly the same code path a click
 * does. Timing is unchanged: `useRollDice`'s ~1 s placeholder delay means the spinner shows on
 * the host first, and the projection only ever carries the final number.
 *
 * The two callers are `Dice.tsx` (local click / "d" key) and `useRoom` (a controller's intent).
 */
export function usePerformRoll() {
  const rollDice = useRollDice();
  const handlePostDiceRoll = useHandlePostDiceRoll();
  const changeTurnFn = useChangeTurn();

  return useCallback(
    async (colour: TPlayerColour): Promise<void> => {
      const diceNumber = await rollDice(colour);
      const res = await handlePostDiceRoll(colour, diceNumber);
      if (res?.shouldChangeTurn) changeTurnFn();
    },
    [rollDice, handlePostDiceRoll, changeTurnFn]
  );
}
