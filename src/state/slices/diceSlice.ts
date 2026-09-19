import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TPlayerColour } from '../../types';
import { ERRORS } from '../../utils/errors';
import type { TDice } from '../../types';

export type TDiceState = {
  dice: TDice[];
  rollBag: Record<TPlayerColour, number[]>;
};

export const initialState: TDiceState = {
  dice: [],
  rollBag: { blue: [], red: [], green: [], yellow: [] },
};

export function getDice(state: TDiceState, colour: TPlayerColour): TDice {
  const dice = state.dice.find((d) => d.colour === colour);
  if (!dice) throw new Error(ERRORS.diceDoesNotExist(colour));
  return dice;
}

export function generateRollBag(): number[] {
  const diceNumbers = Array(36)
    .fill(null)
    .map((_, i) => (i % 6) + 1);
  return diceNumbers;
}

const reducers = {
  registerDice: (state: TDiceState, action: PayloadAction<TPlayerColour>) => {
    state.dice.push({
      colour: action.payload,
      diceNumber: 1,
      isPlaceholderShowing: false,
    });
    state.rollBag[action.payload] = generateRollBag();
  },
  setIsPlaceholderShowing: (
    state: TDiceState,
    action: PayloadAction<{ colour: TPlayerColour; isPlaceholderShowing: boolean }>
  ) => {
    const dice = getDice(state, action.payload.colour);
    dice.isPlaceholderShowing = action.payload.isPlaceholderShowing;
  },
  setDiceNumber: (
    state: TDiceState,
    action: PayloadAction<{ colour: TPlayerColour; randomIndex: number }>
  ) => {
    const dice = getDice(state, action.payload.colour);
    dice.diceNumber = state.rollBag[action.payload.colour][action.payload.randomIndex];
    state.rollBag[action.payload.colour] = state.rollBag[action.payload.colour].filter(
      (_, i) => i !== action.payload.randomIndex
    );
  },
  renewRollBag: (state: TDiceState, action: PayloadAction<TPlayerColour>) => {
    state.rollBag[action.payload] = generateRollBag();
  },

  /**
   * Pour a host's projected dice into the slice a **viewer's** board reads. See
   * `mirrorProjectedPlayers` for why the frame is written into the game slices rather than read
   * out of `roomSlice` by a second set of components.
   *
   * `rollBag` is left alone, and stays empty on a viewer. It is the host's private randomness — it
   * is deliberately not on the wire, and a viewer never draws from it, because a roll there is an
   * intent sent to the host rather than a number generated locally.
   */
  mirrorProjectedDice: (state: TDiceState, action: PayloadAction<TDice[]>) => {
    const frame = action.payload;
    const sameRoster =
      state.dice.length === frame.length && state.dice.every((d, i) => d.colour === frame[i].colour);

    if (!sameRoster) {
      state.dice = frame.map((d) => ({ ...d }));
      return;
    }
    // Field by field, for the reason given on `mirrorProjectedPlayers`: an assignment Immer can
    // see is a change, whether or not the value differs.
    for (let i = 0; i < frame.length; i++) {
      const die = state.dice[i];
      if (die.diceNumber !== frame[i].diceNumber) die.diceNumber = frame[i].diceNumber;
      if (die.isPlaceholderShowing !== frame[i].isPlaceholderShowing)
        die.isPlaceholderShowing = frame[i].isPlaceholderShowing;
    }
  },

  clearDiceState: () => initialState,
};

const diceSlice = createSlice({
  name: 'dice',
  initialState,
  reducers,
});

export const {
  registerDice,
  setDiceNumber,
  setIsPlaceholderShowing,
  renewRollBag,
  mirrorProjectedDice,
  clearDiceState,
} = diceSlice.actions;

export default diceSlice.reducer;
