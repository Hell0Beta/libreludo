import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TErrorCode, TProjection, TSeatSummary } from '../../net/protocol';
import type { TPlayerColour } from '../../types';

export type TRoomRole = 'host' | 'controller' | null;
export type TConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type TRoomState = {
  /** Uppercase 4-char code, or null when not in a room. */
  code: string | null;
  role: TRoomRole;
  status: TConnectionStatus;
  /** Live seat summaries from `room:seats`, as the server reports them. */
  seats: TSeatSummary[];
  hostPresent: boolean;
  /** The latest projection a *controller* has received. The host leaves this null. */
  projection: TProjection | null;
  /**
   * The piece a controller is *considering* moving, so the board can highlight it.
   *
   * Four pieces of a colour are drawn identically, so the phone's "Piece 2" means nothing to a
   * player looking at the board. This is the bridge: the host stores the controller's preview and
   * the matching token lights up. Transient, never saved, and cleared when the selection stops
   * being valid — it is a pointer at something, not game state.
   */
  previewToken: { colour: TPlayerColour; id: number } | null;
  /**
   * The host's own pairing credential — the `pairToken` for the seat it claims as player 1.
   *
   * The host is a player, so it holds a seat like anyone else, and the QR that lets a phone act for
   * that seat is rendered from this. Held here rather than in `useRoom`'s local state because the
   * screen that draws it is a sibling of the hook that earns it.
   *
   * `pairToken` is a live secret the server sends only to the socket that owns the seat, so it is
   * never persisted: a reload reclaims the seat and the reclaim ack hands it back. `colour` comes
   * with it and says which spirit card to put the QR in.
   */
  hostSeat: { colour: TPlayerColour; pairToken: string } | null;
  lastError: TErrorCode | null;
};

/**
 * Room/seat/projection state. Deliberately separate from the game slices: a phone renders only
 * from here, so it never hydrates into `players`/`board`/`dice`/`session` and `useCleanup` — which
 * clears those four on unmount — stays a PC-only concern.
 *
 * Transient by design; not part of the persisted storage schema.
 */
export const initialState: TRoomState = {
  code: null,
  role: null,
  status: 'idle',
  seats: [],
  hostPresent: false,
  projection: null,
  previewToken: null,
  hostSeat: null,
  lastError: null,
};

const reducers = {
  setRoomCode: (state: TRoomState, action: PayloadAction<string | null>) => {
    state.code = action.payload;
  },
  setRoomRole: (state: TRoomState, action: PayloadAction<TRoomRole>) => {
    state.role = action.payload;
  },
  setConnectionStatus: (state: TRoomState, action: PayloadAction<TConnectionStatus>) => {
    state.status = action.payload;
  },
  setSeatList: (
    state: TRoomState,
    action: PayloadAction<{ seats: TSeatSummary[]; hostPresent: boolean }>
  ) => {
    state.seats = action.payload.seats;
    state.hostPresent = action.payload.hostPresent;
  },
  setProjection: (state: TRoomState, action: PayloadAction<TProjection>) => {
    state.projection = action.payload;
  },
  /**
   * `room:host-gone` and `room:host-back` carry no seat list, and the server does not broadcast
   * `room:seats` when the host drops — so without this a controller would keep a stale
   * `hostPresent: true` and show a live-looking screen for a board that is not there.
   */
  setHostPresent: (state: TRoomState, action: PayloadAction<boolean>) => {
    state.hostPresent = action.payload;
  },
  /** A controller's preview selection. `null` clears the highlight. */
  setPreviewToken: (
    state: TRoomState,
    action: PayloadAction<{ colour: TPlayerColour; id: number } | null>
  ) => {
    state.previewToken = action.payload;
  },
  setRoomError: (state: TRoomState, action: PayloadAction<TErrorCode | null>) => {
    state.lastError = action.payload;
  },
  /** The host's own seat, or null while it holds none. See `TRoomState.hostSeat`. */
  setHostSeat: (
    state: TRoomState,
    action: PayloadAction<{ colour: TPlayerColour; pairToken: string } | null>
  ) => {
    state.hostSeat = action.payload;
  },
  clearRoomState: () => initialState,
};

const roomSlice = createSlice({
  name: 'room',
  initialState,
  reducers,
});

export const {
  setRoomCode,
  setRoomRole,
  setConnectionStatus,
  setSeatList,
  setProjection,
  setHostPresent,
  setPreviewToken,
  setRoomError,
  setHostSeat,
  clearRoomState,
} = roomSlice.actions;

export default roomSlice.reducer;
