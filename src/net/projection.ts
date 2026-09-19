/**
 * The host's state projection: the phone's entire view of the game.
 *
 * Kept as a *pure* function of the Redux state so it can be unit tested without a socket, a
 * component, or a browser. It reads `players` + `dice` and nothing else — `tokenAlignmentData`,
 * `initialCoords`, `direction`, `playerSequence` and the board/session slices are board-rendering
 * concerns the phone has no use for (docs/protocol.md §6).
 *
 * `rev` is deliberately *not* part of this function's result. It is a transport concern — the
 * host assigns it, strictly increasing, at emit time (docs/protocol.md §6 "Sequencing"). Keeping
 * it out means the change-detection comparison in `useRoom` never sees a field that changes on
 * every emit, so "did the projection actually change?" stays an honest question.
 */

import type { RootState } from '../state/store';
import type {
  TProjection,
  TProjectionPlayer,
  TProjectionPhase,
  TProjectionDice,
} from './protocol';

export type TProjectionBody = Omit<TProjection, 'rev'>;

/** `ended` wins over everything; a room with no seats yet is still in the lobby. */
export function projectionPhase(state: RootState): TProjectionPhase {
  if (state.players.isGameEnded) return 'ended';
  if (state.players.players.length === 0) return 'lobby';
  return 'playing';
}

/**
 * Build the projection body. Pure and deterministic: same state in, same object out.
 *
 * Coordinates are copied, not passed by reference, so the emitted snapshot can never be mutated
 * out from under the host's live state by a later reducer.
 */
export function projectState(state: RootState): TProjectionBody {
  const players: TProjectionPlayer[] = state.players.players.map((player) => ({
    colour: player.colour,
    name: player.name,
    isBot: player.isBot,
    playerFinishTime: player.playerFinishTime,
    tokens: player.tokens.map((token) => ({
      id: token.id,
      isActive: token.isActive,
      isLocked: token.isLocked,
      hasTokenReachedHome: token.hasTokenReachedHome,
      coordinates: { x: token.coordinates.x, y: token.coordinates.y },
      // Copied field by field, like the coordinates above: the emitted frame must never be able to
      // alias the host's live state, or a later reducer would mutate a snapshot in flight.
      tokenAlignmentData: {
        xOffset: token.tokenAlignmentData.xOffset,
        yOffset: token.tokenAlignmentData.yOffset,
        scaleFactor: token.tokenAlignmentData.scaleFactor,
      },
      direction: token.direction,
    })),
  }));

  const dice: TProjectionDice[] = state.dice.dice.map((die) => ({
    colour: die.colour,
    diceNumber: die.diceNumber,
    isPlaceholderShowing: die.isPlaceholderShowing,
  }));

  return {
    phase: projectionPhase(state),
    currentPlayerColour: state.players.currentPlayerColour,
    isAnyTokenMoving: state.players.isAnyTokenMoving,
    isGameEnded: state.players.isGameEnded,
    players,
    dice,
  };
}

/** Stamp the host-assigned revision onto a body to make the frame on the wire. */
export function withRevision(body: TProjectionBody, rev: number): TProjection {
  return { rev, ...body };
}
