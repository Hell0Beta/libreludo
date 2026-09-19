import { describe, expect, it } from 'vitest';
import { canMoveToken, isDiceDisabled } from '../../src/game/guards';
import type { RootState } from '../../src/state/store';
import { DUMMY_STATE } from '../fixtures/state.dummy';
import { DUMMY_PLAYERS } from '../fixtures/players.dummy';
import diceReducer, {
  registerDice,
  setIsPlaceholderShowing,
} from '../../src/state/slices/diceSlice';
import { getPlayer } from '../../src/state/slices/playersSlice';

function stateWithGame(): RootState {
  const state = {
    ...structuredClone(DUMMY_STATE),
    players: {
      ...structuredClone(DUMMY_STATE.players),
      players: structuredClone(DUMMY_PLAYERS),
      currentPlayerColour: 'blue' as const,
    },
    dice: diceReducer(
      diceReducer(structuredClone(DUMMY_STATE.dice), registerDice('blue')),
      registerDice('red')
    ),
  };
  return state;
}

describe('Test game/guards', () => {
  describe('isDiceDisabled', () => {
    it('should allow a roll for the current human player at rest', () => {
      expect(isDiceDisabled(stateWithGame(), 'blue')).toBe(false);
    });

    it('should refuse a colour that is not the current player', () => {
      expect(isDiceDisabled(stateWithGame(), 'red')).toBe(true);
    });

    it('should refuse when a token of that colour is already active', () => {
      const state = stateWithGame();
      getPlayer(state.players, 'blue').tokens[0].isActive = true;
      expect(isDiceDisabled(state, 'blue')).toBe(true);
    });

    it('should refuse while a token is moving', () => {
      const state = stateWithGame();
      state.players.isAnyTokenMoving = true;
      expect(isDiceDisabled(state, 'blue')).toBe(true);
    });

    it('should refuse when the game has ended', () => {
      const state = stateWithGame();
      state.players.isGameEnded = true;
      expect(isDiceDisabled(state, 'blue')).toBe(true);
    });

    it('should refuse while the placeholder is showing', () => {
      let state = stateWithGame();
      state = {
        ...state,
        dice: diceReducer(
          state.dice,
          setIsPlaceholderShowing({
            colour: 'blue',
            isPlaceholderShowing: true,
          })
        ),
      };
      expect(isDiceDisabled(state, 'blue')).toBe(true);
    });

    it('should refuse a bot seat', () => {
      const state = stateWithGame();
      getPlayer(state.players, 'blue').isBot = true;
      expect(isDiceDisabled(state, 'blue')).toBe(true);
    });
  });

  describe('canMoveToken', () => {
    it('should allow an active token belonging to the current player', () => {
      const state = stateWithGame();
      getPlayer(state.players, 'blue').tokens[1].isActive = true;
      expect(canMoveToken(state, 'blue', 1)).toBe(true);
    });

    it('should refuse a token that is not active', () => {
      expect(canMoveToken(stateWithGame(), 'blue', 1)).toBe(false);
    });

    it("should refuse a token when it is not the sender colour's turn", () => {
      const state = stateWithGame();
      getPlayer(state.players, 'red').tokens[0].isActive = true;
      expect(canMoveToken(state, 'red', 0)).toBe(false);
    });

    it('should refuse a token id that does not exist', () => {
      const state = stateWithGame();
      getPlayer(state.players, 'blue').tokens[0].isActive = true;
      expect(canMoveToken(state, 'blue', 99)).toBe(false);
    });

    it('should refuse a bot seat', () => {
      const state = stateWithGame();
      getPlayer(state.players, 'blue').isBot = true;
      getPlayer(state.players, 'blue').tokens[0].isActive = true;
      expect(canMoveToken(state, 'blue', 0)).toBe(false);
    });
  });
});
