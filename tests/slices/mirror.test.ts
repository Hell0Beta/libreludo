import { describe, expect, it } from 'vitest';
import playersReducer, {
  initialState as playersInitial,
  mirrorProjectedPlayers,
} from '../../src/state/slices/playersSlice';
import diceReducer, {
  initialState as diceInitial,
  mirrorProjectedDice,
} from '../../src/state/slices/diceSlice';
import { TOKEN_LOCKED_COORDINATES } from '../../src/game/tokens/constants';
import type { TProjectionPlayer } from '../../src/net/protocol';
import type { TPlayerColour } from '../../src/types';

/*
 * The mirror is what lets a PC that joined someone else's room draw the real board. It is the only
 * place a frame off the wire becomes game state, so the two things that can go wrong here — a frame
 * that aliases live objects, and a frame that reports a change it did not make — are what these
 * tests are for.
 */

/** `TPlayerState` is not exported; it is exactly what the reducer returns. */
type TPlayerState = ReturnType<typeof playersReducer>;

type TFramePlayer = TProjectionPlayer;

/** The payload `mirrorProjectedPlayers` takes, without reaching into the action creator. */
type TFrame = {
  players: TFramePlayer[];
  currentPlayerColour: TPlayerColour;
  isAnyTokenMoving: boolean;
  isGameEnded: boolean;
};

function framePlayer(colour: TPlayerColour, over: Partial<TFramePlayer> = {}): TFramePlayer {
  return {
    colour,
    name: colour[0].toUpperCase() + colour.slice(1),
    isBot: false,
    playerFinishTime: -1,
    tokens: [0, 1, 2, 3].map((id) => ({
      id,
      isActive: false,
      isLocked: true,
      hasTokenReachedHome: false,
      coordinates: { x: 0, y: 0 },
      tokenAlignmentData: { xOffset: 0, yOffset: 0, scaleFactor: 1 },
      direction: null,
    })),
    ...over,
  };
}

function frame(players: TFramePlayer[], over: Partial<TFrame> = {}): TFrame {
  return {
    players,
    currentPlayerColour: 'blue',
    isAnyTokenMoving: false,
    isGameEnded: false,
    ...over,
  };
}

function applyPlayers(state: TPlayerState, payload: TFrame): TPlayerState {
  return playersReducer(state, mirrorProjectedPlayers(payload));
}

describe('Test state/slices mirror', () => {
  describe('mirrorProjectedPlayers', () => {
    it('should build the roster from an empty slice', () => {
      const state = applyPlayers(playersInitial, frame([framePlayer('blue'), framePlayer('red')]));

      expect(state.players.map((p) => p.colour)).toEqual(['blue', 'red']);
      expect(state.players[0].name).toBe('Blue');
      expect(state.players[0].tokens).toHaveLength(4);
      // `playerSequence` is an input to `changeTurn` and `markTokenAsReachedHome`, neither of which
      // a viewer runs. Filling it from the roster would look right and be wrong, because the real
      // one shrinks as players finish.
      expect(state.playerSequence).toEqual([]);
    });

    it('should reconstruct initialCoords from the compiled-in constant rather than the wire', () => {
      const state = applyPlayers(playersInitial, frame([framePlayer('blue')]));
      // It is not projected; `TOKEN_LOCKED_COORDINATES` is in every copy of the app.
      expect(state.players[0].tokens[0].initialCoords).toEqual(TOKEN_LOCKED_COORDINATES.blue[0]);
    });

    it('should not alias the frame it was handed', () => {
      const payload = frame([framePlayer('blue')]);
      const state = applyPlayers(playersInitial, payload);

      payload.players[0].tokens[0].coordinates.x = 999;
      payload.players[0].tokens[0].tokenAlignmentData.scaleFactor = 999;
      payload.players[0].name = 'mutated';

      expect(state.players[0].tokens[0].coordinates.x).not.toBe(999);
      expect(state.players[0].tokens[0].tokenAlignmentData.scaleFactor).not.toBe(999);
      expect(state.players[0].name).toBe('Blue');
    });

    it('should rebuild rather than patch when the roster changes', () => {
      const before = applyPlayers(playersInitial, frame([framePlayer('blue'), framePlayer('red')]));
      const after = applyPlayers(before, frame([framePlayer('blue'), framePlayer('green')]));

      // A colour that went away must not sit on the board forever — nothing in the new frame names
      // it, so patching would leave it there.
      expect(after.players.map((p) => p.colour)).toEqual(['blue', 'green']);
    });

    /*
     * The interesting assertion in this file.
     *
     * Immer records *any* assignment as a change, so a mirror that writes `coordinates` on every
     * frame produces a brand-new object ~12 times a second against a position that did not move —
     * and every token's framer-motion effect re-runs against it. Reference equality is the thing
     * that has to hold, not value equality.
     */
    it('should leave untouched objects identical across identical frames', () => {
      const first = applyPlayers(playersInitial, frame([framePlayer('blue')]));
      const token = first.players[0].tokens[0];

      const second = applyPlayers(first, frame([framePlayer('blue')]));
      expect(second).toBe(first); // Immer returns the same state when nothing was written
      expect(second.players[0].tokens[0]).toBe(token);
      expect(second.players[0].tokens[0].coordinates).toBe(token.coordinates);
      expect(second.players[0].tokens[0].tokenAlignmentData).toBe(token.tokenAlignmentData);
    });

    it('should replace coordinates only when they actually moved', () => {
      const first = applyPlayers(playersInitial, frame([framePlayer('blue')]));
      const moved = framePlayer('blue');
      moved.tokens[0].coordinates = { x: 3, y: 0 };

      const second = applyPlayers(first, frame([moved]));
      expect(second.players[0].tokens[0].coordinates).toEqual({ x: 3, y: 0 });
      // The other three pieces are exactly where they were, objects and all.
      expect(second.players[0].tokens[1]).toBe(first.players[0].tokens[1]);
    });

    it('should carry the fields a viewer animates on', () => {
      const moved = framePlayer('blue');
      moved.tokens[0] = {
        ...moved.tokens[0],
        isActive: true,
        isLocked: false,
        direction: 'forward',
        tokenAlignmentData: { xOffset: 0.25, yOffset: -0.25, scaleFactor: 0.8 },
      };

      const state = applyPlayers(playersInitial, frame([moved]));
      expect(state.players[0].tokens[0]).toMatchObject({
        isActive: true,
        isLocked: false,
        direction: 'forward',
        tokenAlignmentData: { xOffset: 0.25, yOffset: -0.25, scaleFactor: 0.8 },
      });
    });

    it('should mirror the turn and the moving flag', () => {
      const state = applyPlayers(
        playersInitial,
        frame([framePlayer('blue')], { currentPlayerColour: 'red', isAnyTokenMoving: true })
      );
      expect(state.currentPlayerColour).toBe('red');
      expect(state.isAnyTokenMoving).toBe(true);
    });

    describe('finish order', () => {
      it('should order finishers by their finish time', () => {
        const state = applyPlayers(
          playersInitial,
          frame([
            framePlayer('blue', { playerFinishTime: 2000 }),
            framePlayer('red', { playerFinishTime: 1000 }),
            framePlayer('green'),
          ])
        );
        expect(state.playerFinishOrder.map((p) => p.colour)).toEqual(['red', 'blue']);
      });

      /*
       * The case sorting misses. `markTokenAsReachedHome` appends the last player *without* giving
       * them a finish time — they never got all four pieces home, everyone else simply finished
       * first. A derivation that only sorted would drop them and the game-over screen would show
       * one player short.
       */
      it('should append the runner-up once the game has ended', () => {
        const state = applyPlayers(
          playersInitial,
          frame(
            [
              framePlayer('blue', { playerFinishTime: 2000 }),
              framePlayer('red', { playerFinishTime: 1000 }),
              framePlayer('green'),
            ],
            { isGameEnded: true }
          )
        );
        expect(state.playerFinishOrder.map((p) => p.colour)).toEqual(['red', 'blue', 'green']);
        expect(state.isGameEnded).toBe(true);
      });

      it('should not append a runner-up while the game is still running', () => {
        const state = applyPlayers(
          playersInitial,
          frame([
            framePlayer('blue', { playerFinishTime: 2000 }),
            framePlayer('red', { playerFinishTime: 1000 }),
            framePlayer('green'),
          ])
        );
        expect(state.playerFinishOrder.map((p) => p.colour)).toEqual(['red', 'blue']);
      });
    });
  });

  describe('mirrorProjectedDice', () => {
    const diceFrame = [
      { colour: 'blue' as TPlayerColour, diceNumber: 4, isPlaceholderShowing: false },
      { colour: 'red' as TPlayerColour, diceNumber: 1, isPlaceholderShowing: true },
    ];

    it('should build the dice list from an empty slice', () => {
      const state = diceReducer(diceInitial, mirrorProjectedDice(diceFrame));
      expect(state.dice).toEqual(diceFrame);
    });

    it('should leave rollBag alone, and empty', () => {
      const state = diceReducer(diceInitial, mirrorProjectedDice(diceFrame));
      // The host's private randomness is deliberately not on the wire, and a viewer never draws
      // from it — a roll there is an intent sent to the host, not a number generated locally.
      expect(state.rollBag).toEqual({ blue: [], red: [], green: [], yellow: [] });
    });

    it('should leave the dice array identical across identical frames', () => {
      const first = diceReducer(diceInitial, mirrorProjectedDice(diceFrame));
      const second = diceReducer(first, mirrorProjectedDice(diceFrame));
      expect(second).toBe(first);
      expect(second.dice[0]).toBe(first.dice[0]);
    });

    it('should rebuild when the roster changes', () => {
      const first = diceReducer(diceInitial, mirrorProjectedDice(diceFrame));
      const second = diceReducer(
        first,
        mirrorProjectedDice([
          { colour: 'green', diceNumber: 6, isPlaceholderShowing: false },
          { colour: 'red', diceNumber: 1, isPlaceholderShowing: false },
        ])
      );
      expect(second.dice.map((d) => d.colour)).toEqual(['green', 'red']);
    });

    it('should update a die that actually changed', () => {
      const first = diceReducer(diceInitial, mirrorProjectedDice(diceFrame));
      const second = diceReducer(
        first,
        mirrorProjectedDice([
          { colour: 'blue', diceNumber: 6, isPlaceholderShowing: false },
          { colour: 'red', diceNumber: 1, isPlaceholderShowing: true },
        ])
      );
      expect(second.dice[0].diceNumber).toBe(6);
      expect(second.dice[1]).toBe(first.dice[1]);
    });
  });
});
