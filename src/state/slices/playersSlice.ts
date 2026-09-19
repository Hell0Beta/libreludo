import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { genLockedTokens } from '../../game/tokens/factory';
import { ERRORS } from '../../utils/errors';
import { TOKEN_LOCKED_COORDINATES, TOKEN_START_COORDINATES } from '../../game/tokens/constants';
import type { TProjectionPlayer } from '../../net/protocol';
import { getAvailableSteps, isTokenMovable } from '../../game/tokens/logic';
import type {
  TPlayer,
  TPlayerColour,
  TPlayerNameAndColour,
  TCoordinate,
  TPlayerCount,
  TTokenDirection,
} from '../../types';
import type { TToken, TTokenColourAndId, TTokenAlignmentData } from '../../types';
import { playerSequences } from '../../game/players/constants';

type TPlayerState = {
  players: TPlayer[];
  currentPlayerColour: TPlayerColour;
  playerSequence: TPlayerColour[];
  isAnyTokenMoving: boolean;
  isGameEnded: boolean;
  playerFinishOrder: TPlayerNameAndColour[];
  /**
   * A move request waiting to be carried out by the matching `Token`. Transient: a local board
   * click and a network `move` intent both land here, so both drive the identical move path.
   * Never persisted — see `saveState`, which writes an explicit schema.
   */
  pendingMove: TTokenColourAndId & { timestamp: number } | null;
};

export const initialState: TPlayerState = {
  players: [],
  currentPlayerColour: 'blue',
  playerSequence: [],
  isAnyTokenMoving: false,
  isGameEnded: false,
  playerFinishOrder: [],
  pendingMove: null,
};

export function getPlayer(state: TPlayerState, colour: TPlayerColour) {
  const playerIndex = state.players.findIndex((p) => p.colour === colour);
  const player = state.players[playerIndex];
  if (!player) throw new Error(ERRORS.playerDoesNotExist(colour));
  return player;
}

export function getToken(state: TPlayerState, colour: TPlayerColour, id: number): TToken {
  const player = getPlayer(state, colour);
  const token = player.tokens.find((t) => t.id === id);
  if (!token) throw new Error(ERRORS.tokenDoesNotExist(player.colour, id));
  return token;
}

/**
 * A projected token turned back into a full `TToken`.
 *
 * `initialCoords` is not on the wire and does not need to be: it is
 * `TOKEN_LOCKED_COORDINATES[colour][id]`, a constant compiled into every copy of the app, so
 * sending it would be shipping a lookup table one token at a time.
 */
function tokenFromProjection(
  colour: TPlayerColour,
  projected: TProjectionPlayer['tokens'][number]
): TToken {
  return {
    id: projected.id,
    colour,
    coordinates: { ...projected.coordinates },
    isLocked: projected.isLocked,
    isActive: projected.isActive,
    hasTokenReachedHome: projected.hasTokenReachedHome,
    initialCoords: TOKEN_LOCKED_COORDINATES[colour][projected.id],
    tokenAlignmentData: { ...projected.tokenAlignmentData },
    direction: projected.direction,
  };
}

/**
 * Who has finished, in the order they did it, derived from the frame alone.
 *
 * The host builds `playerFinishOrder` incrementally in `markTokenAsReachedHome` and there is no
 * field on the wire for it — but `playerFinishTime` is projected per player, and sorting by it
 * reproduces the same list. The one case sorting misses is the runner-up: when everyone else has
 * finished the host appends the last player *without* giving them a finish time, because they never
 * got all four pieces home. Appending them here when the game has ended matches that exactly.
 */
function finishOrderFromProjection(
  players: TProjectionPlayer[],
  isGameEnded: boolean
): TPlayerNameAndColour[] {
  const finished = players
    .filter((p) => p.playerFinishTime > 0)
    .sort((a, b) => a.playerFinishTime - b.playerFinishTime)
    .map((p) => ({ name: p.name, colour: p.colour }));
  if (!isGameEnded) return finished;
  const runnerUp = players.find((p) => p.playerFinishTime <= 0);
  return runnerUp ? [...finished, { name: runnerUp.name, colour: runnerUp.colour }] : finished;
}

const reducers = {
  registerNewPlayer: (
    state: TPlayerState,
    action: PayloadAction<{
      name: string;
      colour: TPlayerColour;
      isBot: boolean;
    }>
  ) => {
    const player = state.players.find((p) => p.colour === action.payload.colour);
    if (player) throw new Error(ERRORS.playerAlreadyExists(action.payload.colour));
    state.players.push({
      name: action.payload.name,
      colour: action.payload.colour,
      isBot: action.payload.isBot,
      tokens: genLockedTokens(action.payload.colour),
      numberOfConsecutiveSix: 0,
      playerFinishTime: -1,
    });
  },

  updateTokenCoordinatesAndDirection: (
    state: TPlayerState,
    action: PayloadAction<{
      colour: TPlayerColour;
      id: number;
      newCoords: TCoordinate;
      direction: TTokenDirection;
    }>
  ) => {
    const token = getToken(state, action.payload.colour, action.payload.id);

    token.coordinates = action.payload.newCoords;
    token.direction = action.payload.direction;
  },

  changeTurn: (state: TPlayerState) => {
    const { currentPlayerColour, playerSequence } = state;

    const currentPlayerIndex = playerSequence.indexOf(currentPlayerColour);
    const nextPlayerIndex =
      currentPlayerIndex === playerSequence.length - 1 ? 0 : currentPlayerIndex + 1;

    state.currentPlayerColour = playerSequence[nextPlayerIndex];
  },

  setPlayerSequence: (
    state: TPlayerState,
    action: PayloadAction<{ playerCount: TPlayerCount }>
  ) => {
    state.playerSequence = playerSequences[action.payload.playerCount];
  },

  activateTokens: (
    state: TPlayerState,
    action: PayloadAction<{ all: boolean; colour: TPlayerColour; diceNumber: number }>
  ) => {
    const player = getPlayer(state, action.payload.colour);
    if (action.payload.all) {
      return player.tokens.forEach((t) => {
        if (
          (!t.hasTokenReachedHome && t.isLocked) ||
          (!t.isLocked && getAvailableSteps(t) >= action.payload.diceNumber)
        )
          t.isActive = true;
      });
    }
    player.tokens.forEach((t) => {
      if (isTokenMovable(t, action.payload.diceNumber)) t.isActive = true;
    });
  },

  deactivateAllTokens: (state: TPlayerState, action: PayloadAction<TPlayerColour>) => {
    const player = getPlayer(state, action.payload);
    player.tokens.forEach((t) => (t.isActive = false));
  },

  unlockToken: (state: TPlayerState, action: PayloadAction<TTokenColourAndId>) => {
    const token = getToken(state, action.payload.colour, action.payload.id);
    if (!token.isLocked)
      throw new Error(ERRORS.tokenAlreadyUnlocked(action.payload.colour, action.payload.id));
    token.isLocked = false;
    token.direction = 'forward';
    token.coordinates = TOKEN_START_COORDINATES[action.payload.colour];
  },
  lockToken: (state: TPlayerState, action: PayloadAction<TTokenColourAndId>) => {
    const token = getToken(state, action.payload.colour, action.payload.id);
    if (token.isLocked)
      throw new Error(ERRORS.tokenAlreadyLocked(action.payload.colour, action.payload.id));
    token.isLocked = true;
    token.direction = 'forward';
    token.coordinates = { ...token.initialCoords };
  },

  incrementNumberOfConsecutiveSix: (state: TPlayerState, action: PayloadAction<TPlayerColour>) => {
    const player = getPlayer(state, action.payload);
    player.numberOfConsecutiveSix++;
  },

  resetNumberOfConsecutiveSix: (state: TPlayerState, action: PayloadAction<TPlayerColour>) => {
    const player = getPlayer(state, action.payload);
    player.numberOfConsecutiveSix = 0;
  },

  setIsAnyTokenMoving: (state: TPlayerState, action: PayloadAction<boolean>) => {
    state.isAnyTokenMoving = action.payload;
  },
  markTokenAsReachedHome: (state: TPlayerState, action: PayloadAction<TTokenColourAndId>) => {
    if (state.isGameEnded) return;
    const token = getToken(state, action.payload.colour, action.payload.id);
    token.hasTokenReachedHome = true;
    token.isLocked = true;
    const player = getPlayer(state, action.payload.colour);
    const hasPlayerWon = player.tokens.every((t) => t.hasTokenReachedHome);
    if (!hasPlayerWon) return;
    player.playerFinishTime = Date.now();
    state.playerSequence = state.playerSequence.filter((p) => p !== action.payload.colour);
    state.playerFinishOrder.push({ name: player.name, colour: action.payload.colour });
    if (state.playerSequence.length === 1) {
      state.playerFinishOrder.push({
        name: getPlayer(state, state.playerSequence[0]).name,
        colour: state.playerSequence[0],
      });
      state.isGameEnded = true;
    }
  },
  setTokenAlignmentData: (
    state: TPlayerState,
    action: PayloadAction<{
      colour: TPlayerColour;
      id: number;
      newAlignmentData: TTokenAlignmentData;
    }>
  ) => {
    const token = getToken(state, action.payload.colour, action.payload.id);
    token.tokenAlignmentData = action.payload.newAlignmentData;
  },

  /**
   * Ask the token with this colour/id to move. Previously this lived in `Board.tsx`'s local
   * `useState`; moving it into Redux lets a network intent reach the same code path a board click
   * does. The timestamp is what `Token` compares to tell a fresh request from a re-render.
   */
  requestTokenMove: (state: TPlayerState, action: PayloadAction<TTokenColourAndId>) => {
    state.pendingMove = {
      timestamp: Date.now(),
      colour: action.payload.colour,
      id: action.payload.id,
    };
  },

  /**
   * Pour a host's projection frame into the player state, so a **viewer** — a PC that joined
   * someone else's room — can render the real board with the real components.
   *
   * The alternative was a second set of board components reading `room.projection` directly. That
   * is two boards to keep in step, and the one nobody plays on is the one that rots. Writing the
   * frame into the slice the board already reads means `Board`, `Token` and `Dice` never have to
   * learn that the game is running on another machine.
   *
   * **Only ever dispatched on a viewer.** On the host this would overwrite the authoritative game
   * with a snapshot of itself, one frame stale.
   *
   * Two things the wire does not carry are reconstructed rather than sent. `initialCoords` is a
   * compiled-in constant (see `tokenFromProjection`), and `numberOfConsecutiveSix` is read only by
   * `executeTokenMove`, which a viewer never runs — it emits an intent instead.
   *
   * `playerSequence` deliberately stays empty: it is an input to `changeTurn` and
   * `markTokenAsReachedHome`, both of which only ever run on the host. Filling it from the roster
   * would look right and be wrong, because the real sequence shrinks as players finish.
   *
   * Every field is compared before it is assigned. Immer records *any* assignment as a change, and
   * a fresh `coordinates` object twelve times a second would re-run every token's animation effect
   * against a position that had not actually moved.
   */
  mirrorProjectedPlayers: (
    state: TPlayerState,
    action: PayloadAction<{
      players: TProjectionPlayer[];
      currentPlayerColour: TPlayerColour;
      isAnyTokenMoving: boolean;
      isGameEnded: boolean;
    }>
  ) => {
    const frame = action.payload;

    // The roster itself can change between frames — the host re-declared the game, or started a
    // different one. Rebuild in that case rather than patching: a colour that went away would
    // otherwise sit on the board forever, because nothing in the new frame names it.
    const sameRoster =
      state.players.length === frame.players.length &&
      state.players.every((p, i) => p.colour === frame.players[i].colour);

    if (!sameRoster) {
      state.players = frame.players.map((p) => ({
        name: p.name,
        colour: p.colour,
        isBot: p.isBot,
        playerFinishTime: p.playerFinishTime,
        numberOfConsecutiveSix: 0,
        tokens: p.tokens.map((t) => tokenFromProjection(p.colour, t)),
      }));
    } else {
      for (let i = 0; i < frame.players.length; i++) {
        const next = frame.players[i];
        const player = state.players[i];
        if (player.name !== next.name) player.name = next.name;
        if (player.isBot !== next.isBot) player.isBot = next.isBot;
        if (player.playerFinishTime !== next.playerFinishTime)
          player.playerFinishTime = next.playerFinishTime;

        for (const projected of next.tokens) {
          const token = player.tokens.find((t) => t.id === projected.id);
          if (!token) continue;
          if (token.isActive !== projected.isActive) token.isActive = projected.isActive;
          if (token.isLocked !== projected.isLocked) token.isLocked = projected.isLocked;
          if (token.hasTokenReachedHome !== projected.hasTokenReachedHome)
            token.hasTokenReachedHome = projected.hasTokenReachedHome;
          if (token.direction !== projected.direction) token.direction = projected.direction;
          if (
            token.coordinates.x !== projected.coordinates.x ||
            token.coordinates.y !== projected.coordinates.y
          ) {
            token.coordinates = { ...projected.coordinates };
          }
          const held = token.tokenAlignmentData;
          const sent = projected.tokenAlignmentData;
          if (
            held.xOffset !== sent.xOffset ||
            held.yOffset !== sent.yOffset ||
            held.scaleFactor !== sent.scaleFactor
          ) {
            token.tokenAlignmentData = { ...sent };
          }
        }
      }
    }

    if (state.currentPlayerColour !== frame.currentPlayerColour)
      state.currentPlayerColour = frame.currentPlayerColour;
    if (state.isAnyTokenMoving !== frame.isAnyTokenMoving)
      state.isAnyTokenMoving = frame.isAnyTokenMoving;
    if (state.isGameEnded !== frame.isGameEnded) state.isGameEnded = frame.isGameEnded;

    const finishOrder = finishOrderFromProjection(frame.players, frame.isGameEnded);
    if (finishOrder.length !== state.playerFinishOrder.length)
      state.playerFinishOrder = finishOrder;
  },

  clearPlayersState: () => initialState,
};

const playersSlice = createSlice({
  name: 'players',
  initialState,
  reducers,
});

export const {
  registerNewPlayer,
  updateTokenCoordinatesAndDirection,
  setPlayerSequence,
  changeTurn,
  activateTokens,
  deactivateAllTokens,
  unlockToken,
  lockToken,
  incrementNumberOfConsecutiveSix,
  resetNumberOfConsecutiveSix,
  setIsAnyTokenMoving,
  markTokenAsReachedHome,
  setTokenAlignmentData,
  requestTokenMove,
  mirrorProjectedPlayers,
  clearPlayersState,
} = playersSlice.actions;

export default playersSlice.reducer;
