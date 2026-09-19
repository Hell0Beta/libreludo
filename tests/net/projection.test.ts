import { describe, expect, it } from 'vitest';
import { projectState, projectionPhase, withRevision } from '../../src/net/projection';
import { DUMMY_STATE } from '../fixtures/state.dummy';
import { DUMMY_PLAYERS } from '../fixtures/players.dummy';
import diceReducer, { registerDice, setDiceNumber } from '../../src/state/slices/diceSlice';
import type { RootState } from '../../src/state/store';

function stateWithGame(): RootState {
  return {
    ...structuredClone(DUMMY_STATE),
    players: { ...structuredClone(DUMMY_STATE.players), players: structuredClone(DUMMY_PLAYERS) },
    dice: {
      ...structuredClone(DUMMY_STATE.dice),
      dice: [
        { colour: 'blue', diceNumber: 4, isPlaceholderShowing: false },
        { colour: 'red', diceNumber: 1, isPlaceholderShowing: true },
      ],
    },
  };
}

describe('Test net/projection', () => {
  describe('projectionPhase', () => {
    it('should be lobby before any player is registered', () => {
      expect(projectionPhase(DUMMY_STATE)).toBe('lobby');
    });
    it('should be playing once players exist', () => {
      expect(projectionPhase(stateWithGame())).toBe('playing');
    });
    it('should be ended when the game has ended, even with players present', () => {
      const state = stateWithGame();
      state.players.isGameEnded = true;
      expect(projectionPhase(state)).toBe('ended');
    });
  });

  describe('projectState', () => {
    it('should project only players and dice, copied rather than referenced', () => {
      const state = stateWithGame();
      const projection = projectState(state);

      expect(projection.phase).toBe('playing');
      expect(projection.currentPlayerColour).toBe(state.players.currentPlayerColour);
      expect(projection.isAnyTokenMoving).toBe(false);
      expect(projection.isGameEnded).toBe(false);
      expect(projection.players).toHaveLength(DUMMY_PLAYERS.length);
      expect(projection.dice).toEqual([
        { colour: 'blue', diceNumber: 4, isPlaceholderShowing: false },
        { colour: 'red', diceNumber: 1, isPlaceholderShowing: true },
      ]);

      const firstPlayer = projection.players[0];
      expect(firstPlayer).toEqual({
        colour: 'blue',
        name: 'Player 1',
        isBot: false,
        playerFinishTime: -1,
        tokens: DUMMY_PLAYERS[0].tokens.map((t) => ({
          id: t.id,
          isActive: t.isActive,
          isLocked: t.isLocked,
          hasTokenReachedHome: t.hasTokenReachedHome,
          coordinates: { x: t.coordinates.x, y: t.coordinates.y },
          tokenAlignmentData: {
            xOffset: t.tokenAlignmentData.xOffset,
            yOffset: t.tokenAlignmentData.yOffset,
            scaleFactor: t.tokenAlignmentData.scaleFactor,
          },
          direction: t.direction,
        })),
      });

      // Mutating the projection must not touch live state. Alignment is checked alongside the
      // coordinates because it is the other nested object, and a spread would alias it silently.
      projection.players[0].tokens[0].coordinates.x = 999;
      projection.players[0].tokens[0].tokenAlignmentData.scaleFactor = 999;
      projection.players[0].name = 'mutated';
      expect(state.players.players[0].tokens[0].coordinates.x).not.toBe(999);
      expect(state.players.players[0].tokens[0].tokenAlignmentData.scaleFactor).not.toBe(999);
      expect(state.players.players[0].name).toBe('Player 1');
    });

    /*
     * `tokenAlignmentData` and `direction` used to be listed here as fields that must *not* travel,
     * on the reasoning that the phone renders a list of pieces and has no tile to place them on.
     * That stopped being true when a non-host PC became able to render the real board: it draws the
     * same `<Token />` the host does, and a piece sharing a tile with others is fanned out by these
     * offsets. Without them every piece on a shared tile stacks on one spot at the wrong size.
     *
     * The fields below are still host-only, and for reasons that have not changed — they are inputs
     * to the host's own decisions, not descriptions of what is on the board.
     */
    it('should not leak host-only fields no viewer can use', () => {
      const projection = projectState(stateWithGame()) as Record<string, unknown>;
      expect(projection).not.toHaveProperty('initialCoords');
      expect(projection).not.toHaveProperty('playerSequence');
      expect(projection).not.toHaveProperty('boardTileSize');
      expect(projection).not.toHaveProperty('board');
      expect(projection).not.toHaveProperty('session');

      const token = (projection.players as ReturnType<typeof projectState>['players'])[0]
        .tokens[0] as unknown as Record<string, unknown>;
      // Where the piece *started* is the host's business; a viewer only needs where it is now.
      expect(token).not.toHaveProperty('initialCoords');
    });

    it('should reflect a dice change in the projected frame', () => {
      const state = stateWithGame();
      const before = projectState(state);
      const dice = state.dice.dice.find((d) => d.colour === 'blue');
      expect(dice).toBeDefined();
      state.dice = diceReducer(state.dice, registerDice('green'));
      state.dice = diceReducer(state.dice, setDiceNumber({ colour: 'green', randomIndex: 0 }));
      const after = projectState(state);

      expect(after.dice).not.toEqual(before.dice);
      expect(after.dice.some((d) => d.colour === 'green')).toBe(true);
    });

    it('should be deterministic: the same state stringifies identically', () => {
      const state = stateWithGame();
      expect(JSON.stringify(projectState(state))).toBe(JSON.stringify(projectState(state)));
    });
  });

  describe('withRevision', () => {
    it('should stamp the host-assigned rev on top of the body', () => {
      const body = projectState(stateWithGame());
      expect(withRevision(body, 7)).toEqual({ rev: 7, ...body });
    });
  });
});
