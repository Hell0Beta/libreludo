import { describe, expect, it } from 'vitest';
import roomReducer, {
  clearRoomState,
  initialState as roomInitialState,
  setConnectionStatus,
  setProjection,
  setRoomCode,
  setRoomError,
  setRoomRole,
  setSeatList,
} from '../../src/state/slices/roomSlice';
import { projectState } from '../../src/net/projection';
import { DUMMY_STATE } from '../fixtures/state.dummy';

const SEATS = [
  {
    colour: 'blue' as const,
    name: 'Alice',
    isBot: false,
    claimed: true,
    connected: true,
    paired: false,
  },
  {
    colour: 'red' as const,
    name: 'Robo',
    isBot: true,
    claimed: false,
    connected: false,
    paired: false,
  },
];

describe('Test room slice reducers', () => {
  it('should start empty and idle', () => {
    expect(roomInitialState).toEqual({
      code: null,
      role: null,
      status: 'idle',
      seats: [],
      hostPresent: false,
      projection: null,
      // The controller's preview selection — which piece the board should highlight.
      previewToken: null,
      // The host's own pairing credential, earned when it claims player 1. Null until that acks,
      // and null forever on a machine that is not hosting.
      hostSeat: null,
      lastError: null,
    });
  });

  it('should store the room code and role', () => {
    let state = roomReducer(roomInitialState, setRoomCode('AB2C'));
    state = roomReducer(state, setRoomRole('host'));
    expect(state.code).toBe('AB2C');
    expect(state.role).toBe('host');
  });

  it('should store connection status transitions', () => {
    let state = roomReducer(roomInitialState, setConnectionStatus('connecting'));
    state = roomReducer(state, setConnectionStatus('connected'));
    expect(state.status).toBe('connected');
    state = roomReducer(state, setConnectionStatus('reconnecting'));
    expect(state.status).toBe('reconnecting');
  });

  it('should replace the seat list and host presence together', () => {
    const state = roomReducer(
      roomInitialState,
      setSeatList({ seats: SEATS, hostPresent: false })
    );
    expect(state.seats).toEqual(SEATS);
    expect(state.hostPresent).toBe(false);
  });

  it('should store a controller projection', () => {
    const projection = { rev: 3, ...projectState(DUMMY_STATE) };
    const state = roomReducer(roomInitialState, setProjection(projection));
    expect(state.projection).toEqual(projection);
  });

  it('should record and clear the last error', () => {
    let state = roomReducer(roomInitialState, setRoomError('NO_SUCH_ROOM'));
    expect(state.lastError).toBe('NO_SUCH_ROOM');
    state = roomReducer(state, setRoomError(null));
    expect(state.lastError).toBeNull();
  });

  it('should clear back to the initial state', () => {
    let state = roomReducer(roomInitialState, setRoomCode('AB2C'));
    state = roomReducer(state, setRoomRole('controller'));
    state = roomReducer(state, setSeatList({ seats: SEATS, hostPresent: true }));
    state = roomReducer(state, setConnectionStatus('connected'));
    expect(roomReducer(state, clearRoomState())).toEqual(roomInitialState);
  });
});
