/**
 * Host-side play guards (docs/protocol.md §7).
 *
 * These are the *same* predicates the local UI uses, lifted into pure functions so the network
 * bridge can re-apply them without a second copy of the rule. `Dice.tsx` used to compute
 * `isDiceDisabled` inline; it now calls `isDiceDisabled` from here, and `useRoom` calls it before
 * honouring a controller's `roll` intent. Two code paths, one rule.
 *
 * They are correctness-of-play guards, not a security boundary — the deployment target is a
 * private tailnet.
 */

import type { RootState } from '../state/store';
import type { TPlayerColour } from '../types';
import { isAnyTokenActiveOfColour } from './tokens/logic';

/**
 * The exact condition that disables the dice button: not your turn, pieces still to move, a token
 * mid-animation, the game over, the spinner showing, or the seat is a bot.
 */
export function isDiceDisabled(state: RootState, colour: TPlayerColour): boolean {
  const { players, isAnyTokenMoving, isGameEnded, currentPlayerColour } = state.players;
  const die = state.dice.dice.find((d) => d.colour === colour);
  const player = players.find((p) => p.colour === colour);

  return (
    currentPlayerColour !== colour ||
    isAnyTokenActiveOfColour(colour, players) ||
    isAnyTokenMoving ||
    isGameEnded ||
    (die?.isPlaceholderShowing ?? false) ||
    (player?.isBot ?? false)
  );
}

/**
 * A `move` intent is only honoured when it is the sender's turn, the token belongs to the sender,
 * and the token is currently active (i.e. the last roll made exactly this piece movable).
 */
export function canMoveToken(
  state: RootState,
  colour: TPlayerColour,
  tokenId: number
): boolean {
  if (state.players.currentPlayerColour !== colour) return false;
  const player = state.players.players.find((p) => p.colour === colour);
  if (!player || player.isBot) return false;
  const token = player.tokens.find((t) => t.id === tokenId);
  return token?.isActive === true;
}
