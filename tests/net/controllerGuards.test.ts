import { describe, expect, it } from 'vitest';
import {
  canMoveTokenOnPhone,
  dieOf,
  hasActiveToken,
  playerOf,
  rollBlockedReason,
  tokenOf,
  tokenPlace,
} from '../../src/net/controllerGuards';
import type { TProjection, TProjectionToken } from '../../src/net/protocol';

function token(id: number, over: Partial<TProjectionToken> = {}): TProjectionToken {
  return {
    id,
    isActive: false,
    isLocked: true,
    hasTokenReachedHome: false,
    coordinates: { x: 0, y: 0 },
    // A piece alone on its tile: no fan-out offset, no shrink.
    tokenAlignmentData: { xOffset: 0, yOffset: 0, scaleFactor: 1 },
    direction: null,
    ...over,
  };
}

function projection(over: Partial<TProjection> = {}): TProjection {
  return {
    rev: 1,
    phase: 'playing',
    currentPlayerColour: 'blue',
    isAnyTokenMoving: false,
    isGameEnded: false,
    players: [
      {
        colour: 'blue',
        name: 'Alice',
        isBot: false,
        playerFinishTime: 0,
        tokens: [token(0), token(1), token(2), token(3)],
      },
      {
        colour: 'red',
        name: 'Bob',
        isBot: false,
        playerFinishTime: 0,
        tokens: [token(0), token(1), token(2), token(3)],
      },
    ],
    dice: [
      { colour: 'blue', diceNumber: 3, isPlaceholderShowing: false },
      { colour: 'red', diceNumber: 0, isPlaceholderShowing: false },
    ],
    ...over,
  };
}

/** Replace blue's tokens wholesale, so a test states only what it cares about. */
function withBlueTokens(tokens: TProjectionToken[], over: Partial<TProjection> = {}): TProjection {
  const base = projection(over);
  return {
    ...base,
    players: base.players.map((player) =>
      player.colour === 'blue' ? { ...player, tokens } : player
    ),
  };
}

describe('net/controllerGuards', () => {
  describe('lookups', () => {
    it('finds a player by colour, and says so when there is none', () => {
      expect(playerOf(projection(), 'blue')?.name).toBe('Alice');
      expect(playerOf(projection(), 'green')).toBeNull();
    });

    it('finds a die by colour', () => {
      expect(dieOf(projection(), 'red')?.diceNumber).toBe(0);
      expect(dieOf(projection(), 'yellow')).toBeNull();
    });

    it('finds one token of a colour, and rejects an id that colour does not have', () => {
      expect(tokenOf(projection(), 'blue', 2)?.id).toBe(2);
      expect(tokenOf(projection(), 'blue', 9)).toBeNull();
    });
  });

  describe('rollBlockedReason', () => {
    it('is null exactly when the player may roll', () => {
      expect(rollBlockedReason(projection(), 'blue')).toBeNull();
    });

    it('names the player whose turn it is', () => {
      expect(rollBlockedReason(projection(), 'red')).toBe('Waiting for Alice');
    });

    it('asks for a move when a piece is already active — one roll per turn', () => {
      const state = withBlueTokens([
        token(0, { isActive: true, isLocked: false }),
        token(1),
        token(2),
        token(3),
      ]);
      expect(hasActiveToken(state, 'blue')).toBe(true);
      expect(rollBlockedReason(state, 'blue')).toBe('Move a piece first');
    });

    it('waits while the host is animating', () => {
      expect(rollBlockedReason(projection({ isAnyTokenMoving: true }), 'blue')).toBe(
        'A piece is still moving'
      );
    });

    it('waits while the die is still tumbling on the host', () => {
      const state = projection({
        dice: [{ colour: 'blue', diceNumber: 0, isPlaceholderShowing: true }],
      });
      expect(rollBlockedReason(state, 'blue')).toBe('Rolling…');
    });

    it('reports the end of the game ahead of anything else', () => {
      const state = projection({ isGameEnded: true, isAnyTokenMoving: true });
      expect(rollBlockedReason(state, 'blue')).toBe('The game has finished');
    });

    it('does not offer a roll to a colour that is not in the game', () => {
      expect(rollBlockedReason(projection(), 'green')).toBe('You are not in this game');
    });

    it('never offers a roll for a bot seat', () => {
      const base = projection();
      const state: TProjection = {
        ...base,
        players: base.players.map((player) =>
          player.colour === 'blue' ? { ...player, isBot: true } : player
        ),
      };
      expect(rollBlockedReason(state, 'blue')).toBe('Bots roll for themselves');
    });
  });

  describe('canMoveTokenOnPhone', () => {
    const active = withBlueTokens([
      token(0, { isActive: true, isLocked: false }),
      token(1),
      token(2),
      token(3),
    ]);

    it('allows a piece the host has marked active', () => {
      expect(canMoveTokenOnPhone(active, 'blue', 0)).toBe(true);
    });

    it('refuses a piece that is not active', () => {
      expect(canMoveTokenOnPhone(active, 'blue', 1)).toBe(false);
    });

    it('refuses a piece of another colour entirely', () => {
      expect(canMoveTokenOnPhone(active, 'red', 0)).toBe(false);
    });

    it('refuses an id that does not exist', () => {
      expect(canMoveTokenOnPhone(active, 'blue', 7)).toBe(false);
    });

    it('refuses while the turn belongs to someone else', () => {
      expect(canMoveTokenOnPhone(active, 'blue', 0)).toBe(true);
      const theirs: TProjection = { ...active, currentPlayerColour: 'red' };
      expect(canMoveTokenOnPhone(theirs, 'blue', 0)).toBe(false);
    });

    /*
     * The host's own `canMoveToken` does not check this — a second click during an animation is
     * simply ignored there. The phone is stricter on purpose: a thumb can hit a piece twice in
     * quick succession, and a disabled button is clearer feedback than a tap that does nothing.
     */
    it('refuses while a piece is mid-move', () => {
      expect(canMoveTokenOnPhone({ ...active, isAnyTokenMoving: true }, 'blue', 0)).toBe(false);
    });

    it('refuses once the game has ended', () => {
      expect(canMoveTokenOnPhone({ ...active, isGameEnded: true }, 'blue', 0)).toBe(false);
    });
  });

  describe('tokenPlace', () => {
    it('reads a finished piece as home even though it keeps isLocked', () => {
      expect(tokenPlace(token(0, { hasTokenReachedHome: true, isLocked: true }))).toBe('home');
    });

    it('reads a piece still in the yard as the yard', () => {
      expect(tokenPlace(token(0, { isLocked: true }))).toBe('yard');
    });

    it('reads a released piece as on the board', () => {
      expect(tokenPlace(token(0, { isLocked: false }))).toBe('board');
    });
  });
});
