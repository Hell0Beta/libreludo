/**
 * What a controller is allowed to offer, derived from the projection alone.
 *
 * This is the phone-side sibling of `game/guards.ts`, and the split is deliberate rather than
 * duplication to be tidied away. `guards.ts` reads `RootState` because the *host* owns the game;
 * a phone holds no game slices at all — it renders from a `TProjection` — so it cannot call those
 * functions even if it wanted to.
 *
 * **This is an affordance, not a boundary.** Everything here only decides whether a button looks
 * pressable. The host re-checks the same conditions with `guards.ts` before acting on any intent
 * (docs/protocol.md §7), and the relay refuses an intent from an unseated socket. A phone that
 * ignored this module entirely and emitted anyway would achieve nothing. So it is safe for these
 * two views of "can I roll?" to differ in emphasis — the phone is stricter about
 * `isAnyTokenMoving` below, which is a UX choice with no security meaning.
 */

import type { TPlayerColour } from '../types';
import type { TProjection, TProjectionPlayer, TProjectionToken } from './protocol';

export function playerOf(
  projection: TProjection,
  colour: TPlayerColour
): TProjectionPlayer | null {
  return projection.players.find((player) => player.colour === colour) ?? null;
}

export function dieOf(projection: TProjection, colour: TPlayerColour) {
  return projection.dice.find((die) => die.colour === colour) ?? null;
}

/** True when the player has already rolled and has a piece waiting to be moved. */
export function hasActiveToken(projection: TProjection, colour: TPlayerColour): boolean {
  return playerOf(projection, colour)?.tokens.some((token) => token.isActive) ?? false;
}

/**
 * Why the Roll control is unavailable, or `null` when it is available.
 *
 * Returns the reason rather than a bare boolean so the button can say *why* it is dark — "Waiting
 * for Bob" is a better screen than a dead button, and the projection already carries the name.
 * Mirrors `isDiceDisabled` in `game/guards.ts` term for term.
 */
export function rollBlockedReason(
  projection: TProjection,
  colour: TPlayerColour
): string | null {
  /*
   * A phone can hold a seat through Match Setup, so "the game has not started" is a state it really
   * reaches — and one that must not be reported as "you are not in this game", which is what the
   * missing-player check below would say and which reads as a bug to the person holding the phone.
   */
  if (projection.phase === 'lobby') return 'Waiting for the board to start';

  const player = playerOf(projection, colour);
  if (!player) return 'You are not in this game';

  if (projection.isGameEnded) return 'The game has finished';
  if (projection.isAnyTokenMoving) return 'A piece is still moving';
  if (hasActiveToken(projection, colour)) return 'Move a piece first';
  if (player.isBot) return 'Bots roll for themselves';

  if (projection.currentPlayerColour !== colour) {
    const current = playerOf(projection, projection.currentPlayerColour);
    return current ? `Waiting for ${current.name}` : 'Waiting for your turn';
  }

  const die = dieOf(projection, colour);
  if (!die) return 'No dice for your colour';
  // The host has committed to a roll and is animating it. The number is not decided yet.
  if (die.isPlaceholderShowing) return 'Rolling…';

  return null;
}

/**
 * Whether this piece can be moved right now.
 *
 * `isActive` is set by `activateTokens` on the host after every roll, so it already answers "which
 * of my pieces may move" — the phone never computes Ludo rules to find out (docs/protocol.md §6).
 */
export function canMoveTokenOnPhone(
  projection: TProjection,
  colour: TPlayerColour,
  tokenId: number
): boolean {
  if (projection.isGameEnded) return false;
  if (projection.currentPlayerColour !== colour) return false;
  if (projection.isAnyTokenMoving) return false;
  return tokenOf(projection, colour, tokenId)?.isActive === true;
}

export function tokenOf(
  projection: TProjection,
  colour: TPlayerColour,
  tokenId: number
): TProjectionToken | null {
  return playerOf(projection, colour)?.tokens.find((token) => token.id === tokenId) ?? null;
}

export type TTokenPlace = 'home' | 'yard' | 'board';

/**
 * Where a piece is, in words a player would use. `hasTokenReachedHome` is checked before
 * `isLocked` because a finished piece keeps `isLocked: true` from its time in the yard.
 */
export function tokenPlace(token: TProjectionToken): TTokenPlace {
  if (token.hasTokenReachedHome) return 'home';
  if (token.isLocked) return 'yard';
  return 'board';
}

export const TOKEN_PLACE_LABEL: Record<TTokenPlace, string> = {
  home: 'Home',
  yard: 'In the yard',
  board: 'On the board',
};
