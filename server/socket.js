/**
 * Socket.IO wiring. Turns validated protocol events into room-store mutations and broadcasts.
 * See docs/protocol.md §4, §5 and §8.
 *
 * Rules this file exists to enforce:
 *   - every request is answered through an ack: `{ ok: true, ... }` or `{ ok: false, error }`
 *   - `room:seats` preserves claims for unchanged colours
 *   - `room:reclaim` is last-writer-wins, so two sockets never share a seat
 *   - `game:intent` is stamped with the sender's `fromColour`; a client cannot name its colour
 *   - a bare disconnect detaches, it never releases
 */

import { Server } from 'socket.io';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  ERROR_CODES,
  SEAT_LOST_REASONS,
  emptyPayloadSchema,
  roomSeatsSchema,
  roomJoinSchema,
  roomClaimSchema,
  roomReclaimSchema,
  roomRehostSchema,
  roomPairSchema,
  gameIntentSchema,
  gameSelectSchema,
  gameStateSchema,
  ok,
  fail,
} from './protocol.js';
import { SWEEP_INTERVAL_MS, createRoomStore, toSeatSummaries } from './rooms.js';

/**
 * @param {import('node:http').Server} httpServer
 * @param {object} [options]
 * @param {ReturnType<createRoomStore>} [options.store]
 * @param {Console} [options.log]
 * @param {boolean} [options.autoSweep] start the 30 s sweeper
 * @param {number} [options.sweepIntervalMs]
 */
export function attachSocketServer(
  httpServer,
  { store = createRoomStore(), log = console, autoSweep = true, sweepIntervalMs = SWEEP_INTERVAL_MS } = {}
) {
  const io = new Server(httpServer, { serveClient: false });

  /* ------------------------------------------------------------- helpers */

  const broadcastSeats = (room) => {
    io.to(room.code).emit(SERVER_EVENTS.ROOM_SEATS, {
      seats: toSeatSummaries(room),
      hostPresent: room.hostSocketId !== null,
    });
  };

  const sendSeatLost = (socketId, reason) => {
    io.to(socketId).emit(SERVER_EVENTS.ROOM_SEAT_LOST, { reason });
  };

  const socketById = (socketId) => io.sockets.sockets.get(socketId) ?? null;

  /** Tell a controller its seat is gone and take it out of the room channel. */
  const evictController = (socketId, room, reason) => {
    if (!socketId) return;
    sendSeatLost(socketId, reason);
    socketById(socketId)?.leave(room.code);
  };

  /**
   * Parse the payload, then run the handler. A missing payload and a missing ack are both
   * tolerated: `socket.emit('room:create')` and `socket.emit('room:create', ack)` are the same
   * request as far as the protocol is concerned.
   */
  const onValidated = (socket, event, schema, handler) => {
    socket.on(event, (rawPayload, rawAck) => {
      let payload = rawPayload;
      let ack = rawAck;

      if (typeof payload === 'function') {
        ack = payload;
        payload = undefined;
      }
      if (typeof ack !== 'function') ack = () => {};

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        log.warn(`[socket] ${event} from ${socket.id} rejected: BAD_REQUEST`);
        ack(fail(ERROR_CODES.BAD_REQUEST));
        return;
      }

      try {
        handler(parsed.data, ack);
      } catch (error) {
        log.error(`[socket] ${event} handler failed`, error);
        ack(fail(ERROR_CODES.BAD_REQUEST));
      }
    });
  };

  /* ------------------------------------------------------------ handlers */

  io.on('connection', (socket) => {
    log.log(`[socket] connected ${socket.id}`);

    // room:create — host only, in the sense that the caller becomes the host.
    onValidated(socket, CLIENT_EVENTS.ROOM_CREATE, emptyPayloadSchema, (_payload, ack) => {
      // "A socket that already hosts a room is moved out of it."
      const previous = store.findRoomHostedBy(socket.id);
      if (previous) {
        io.to(previous.code).emit(SERVER_EVENTS.ROOM_ERROR, {
          error: ERROR_CODES.NO_SUCH_ROOM,
          code: previous.code,
        });
        store.deleteRoom(previous.code);
        socket.leave(previous.code);
      }

      const room = store.createRoom({ hostSocketId: socket.id });
      socket.join(room.code);

      log.log(`[socket] room:create ${room.code} by ${socket.id}`);
      ack(ok({ code: room.code }));
    });

    // room:seats — host only. Replaces the whole list.
    onValidated(socket, CLIENT_EVENTS.ROOM_SEATS, roomSeatsSchema, ({ code, seats }, ack) => {
      const room = store.getRoom(code);
      if (!room) return ack(fail(ERROR_CODES.NO_SUCH_ROOM));
      if (room.hostSocketId !== socket.id) return ack(fail(ERROR_CODES.NOT_HOST));

      const { lost } = store.declareSeats(room, seats);

      for (const seat of lost) evictController(seat.socketId, room, SEAT_LOST_REASONS.REMOVED);

      broadcastSeats(room);
      ack(ok());
    });

    // room:join — controller. Grants nothing, subscribes to the room's broadcasts.
    onValidated(socket, CLIENT_EVENTS.ROOM_JOIN, roomJoinSchema, ({ code }, ack) => {
      const room = store.getRoom(code);
      if (!room) return ack(fail(ERROR_CODES.NO_SUCH_ROOM));

      socket.join(room.code);
      // `hostPresent` rides along because a joiner cannot otherwise learn it: `room:host-gone` was
      // emitted before it arrived, and `room:seats` only fires when the seat list changes.
      ack(ok({ seats: toSeatSummaries(room), hostPresent: room.hostSocketId !== null }));
    });

    // room:claim — controller. Takes an open seat.
    onValidated(socket, CLIENT_EVENTS.ROOM_CLAIM, roomClaimSchema, ({ code, colour }, ack) => {
      const room = store.getRoom(code);
      if (!room) return ack(fail(ERROR_CODES.NO_SUCH_ROOM));

      const result = store.claimSeat(room, colour, socket.id);
      if (!result.ok) return ack(fail(result.error));

      // A phone that switches seat leaves its old one detached, not released: the token
      // survives its grace period in case the switch was a mistake.
      const previous = room.seats.find(
        (seat) => seat.colour !== colour && seat.socketId === socket.id
      );
      if (previous) {
        previous.socketId = null;
        previous.detachedAt = store.now();
      }

      socket.join(room.code);
      ack(
        ok({
          seatToken: result.token,
          // Only ever sent to the seat's owner: it is what the pairing QR encodes.
          pairToken: result.seat.pairToken,
          colour: result.seat.colour,
          name: result.seat.name,
        })
      );
      broadcastSeats(room);
    });

    /**
     * room:pair — a phone attaching itself to a seat a PC already owns.
     *
     * The `pairToken` grants the right to *act for* a seat, not to own it. That distinction is the
     * whole point: a paired phone can roll and move for its colour, but cannot reclaim the seat or
     * take it away from the PC that claimed it, because it never holds the `seatToken`.
     */
    onValidated(socket, CLIENT_EVENTS.ROOM_PAIR, roomPairSchema, ({ code, pairToken }, ack) => {
      const room = store.getRoom(code);
      if (!room) return ack(fail(ERROR_CODES.NO_SUCH_ROOM));

      const result = store.pairSeat(room, pairToken, socket.id);
      if (!result.ok) return ack(fail(result.error));

      socket.join(room.code);
      ack(ok({ colour: result.seat.colour, name: result.seat.name }));
      broadcastSeats(room);
    });

    // room:reclaim — controller. Last writer wins.
    onValidated(socket, CLIENT_EVENTS.ROOM_RECLAIM, roomReclaimSchema, ({ code, seatToken }, ack) => {
      const room = store.getRoom(code);
      if (!room) return ack(fail(ERROR_CODES.NO_SUCH_ROOM));

      const result = store.reclaimSeat(room, seatToken, socket.id);
      if (!result.ok) return ack(fail(result.error));

      if (result.previousSocketId) {
        evictController(result.previousSocketId, room, SEAT_LOST_REASONS.REMOVED);
      }

      socket.join(room.code);
      /*
       * `pairToken` comes back too, and for the same reason `room:claim` returns it: the holder of
       * the `seatToken` is the seat's owner, and the pairing QR is the owner's to show. Minting it
       * once at claim and never repeating it would mean a PC that reloads mid-game — which reclaims
       * its seat and gets a fresh socket — could never show its QR again, and the phone that had not
       * yet scanned it would be locked out of the seat for the rest of the game.
       *
       * It is still only ever sent to the socket that proves ownership; it never appears in a seat
       * summary.
       */
      ack(
        ok({
          colour: result.seat.colour,
          name: result.seat.name,
          pairToken: result.seat.pairToken,
        })
      );
      broadcastSeats(room);
    });

    // room:rehost — host only. Re-attaches after a reload.
    onValidated(socket, CLIENT_EVENTS.ROOM_REHOST, roomRehostSchema, ({ code }, ack) => {
      const room = store.getRoom(code);
      if (!room) return ack(fail(ERROR_CODES.NO_SUCH_ROOM));

      const result = store.rehost(room, socket.id);
      if (!result.ok) return ack(fail(result.error));

      socket.join(room.code);
      ack(ok({ seats: toSeatSummaries(room) }));

      if (result.wasDetached) io.to(room.code).emit(SERVER_EVENTS.ROOM_HOST_BACK, {});
      broadcastSeats(room);
    });

    // game:intent — controller. `fromColour` comes from the seat, never from the payload.
    onValidated(socket, CLIENT_EVENTS.GAME_INTENT, gameIntentSchema, (intent, ack) => {
      // Owner *or* companion — see findSeatForActor. A paired phone acts for the seat it is paired
      // to, exactly as the PC that owns it does.
      const seated = store.findSeatForActor(socket.id);
      if (!seated) return ack(fail(ERROR_CODES.NOT_SEATED));

      const { room, seat } = seated;
      if (room.hostSocketId !== null) {
        io.to(room.hostSocketId).emit(SERVER_EVENTS.GAME_INTENT, {
          fromColour: seat.colour,
          ...intent,
        });
      }

      // "delivered, not accepted": the host applies its own guards, and a missing host is
      // something the controller already knows about from room:host-gone.
      ack(ok());
    });

    // game:select — controller. A preview, forwarded to the host so it can highlight the piece.
    onValidated(socket, CLIENT_EVENTS.GAME_SELECT, gameSelectSchema, ({ tokenId }, ack) => {
      const seated = store.findSeatForActor(socket.id);
      if (!seated) return ack(fail(ERROR_CODES.NOT_SEATED));

      const { room, seat } = seated;
      if (room.hostSocketId !== null) {
        io.to(room.hostSocketId).emit(SERVER_EVENTS.GAME_SELECT, {
          fromColour: seat.colour,
          tokenId,
        });
      }

      ack(ok());
    });

    // game:state — host only. The projection is relayed untouched to every controller.
    onValidated(socket, CLIENT_EVENTS.GAME_STATE, gameStateSchema, ({ projection }, ack) => {
      const room = store.findRoomHostedBy(socket.id);
      if (!room) return ack(fail(ERROR_CODES.NOT_HOST));

      io.to(room.code).except(socket.id).emit(SERVER_EVENTS.GAME_STATE, { projection });
      ack(ok());
    });

    /**
     * A bare disconnect detaches; it never releases. The seat keeps its seatToken so the
     * controller can reclaim it, and the room outlives a host reload.
     */
    socket.on('disconnect', (reason) => {
      log.log(`[socket] disconnected ${socket.id} (${reason})`);

      const room = store.findRoomHostedBy(socket.id);
      if (room) {
        store.detachHost(room, socket.id);
        io.to(room.code).emit(SERVER_EVENTS.ROOM_HOST_GONE, { since: room.hostDetachedAt });
      }

      const seated = store.findSeatBySocket(socket.id);
      if (seated) {
        store.detachSeat(seated.room, socket.id);
        broadcastSeats(seated.room);
      }

      /*
       * Companionships end immediately. A paired phone is a spare controller, not an owner: there is
       * nothing to preserve across a disconnect, and holding a dead socket id in the list would only
       * make `paired` lie.
       */
      for (const { room } of store.detachCompanion(socket.id)) broadcastSeats(room);
    });
  });

  /* ------------------------------------------------------------- sweeper */

  const sweepNow = () => {
    const { removed, expired } = store.sweep();

    for (const room of removed) {
      log.log(`[sweeper] released room ${room.code}`);
      io.to(room.code).emit(SERVER_EVENTS.ROOM_ERROR, {
        error: ERROR_CODES.NO_SUCH_ROOM,
        code: room.code,
      });
    }

    for (const room of new Set(expired.map(({ room: expiredRoom }) => expiredRoom))) {
      log.log(`[sweeper] released expired seats in ${room.code}`);
      // The controller is detached by definition, so this refreshes the host and any picker
      // that is watching rather than notifying the owner.
      broadcastSeats(room);
    }

    return { removed, expired };
  };

  let timer = null;
  if (autoSweep) {
    timer = setInterval(sweepNow, sweepIntervalMs);
    // Never hold the process open just for the sweeper.
    timer.unref?.();
  }

  return {
    io,
    store,
    sweepNow,
    stopSweeper: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
