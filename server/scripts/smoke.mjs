#!/usr/bin/env node
/**
 * End-to-end smoke test against a *running* relay server.
 *
 *   pnpm server                       # terminal 1
 *   node server/scripts/smoke.mjs     # terminal 2
 *
 * Prints a transcript of the whole lifecycle plus the HTTP surface checks: create -> seats ->
 * join -> claim -> disconnect -> wait -> reclaim, the error codes, and proof that /socket.io/
 * is not being answered by the SPA fallback. Exits non-zero if any step misbehaves.
 */

import { io as ioClient } from 'socket.io-client';

const BASE_URL = process.env.SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3210}`;
const WAIT_AFTER_DROP_MS = Number(process.env.SMOKE_WAIT_MS ?? 1500);

let failures = 0;

function step(label, value) {
  console.log(`  ${label.padEnd(34)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function connect() {
  const socket = ioClient(BASE_URL, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${BASE_URL}`)), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

async function main() {
  console.log(`\n== HTTP surface (${BASE_URL}) ==`);

  const health = await fetch(`${BASE_URL}/healthz`);
  step('GET /healthz', `${health.status} ${await health.text()}`);

  const handshake = await fetch(`${BASE_URL}/socket.io/?EIO=4&transport=polling`);
  const handshakeBody = await handshake.text();
  step('GET /socket.io/?EIO=4', `${handshake.status} ${handshakeBody.slice(0, 42)}...`);
  check(
    'the socket path is answered by Socket.IO',
    handshake.status === 200 && handshakeBody.startsWith('0{'),
    handshakeBody.slice(0, 60)
  );

  const unknown = await fetch(`${BASE_URL}/room/AB2C`);
  const unknownBody = await unknown.text();
  step('GET /room/AB2C (no such route)', `${unknown.status} ${unknown.headers.get('content-type')}`);
  check(
    'an unknown path returns the SPA shell',
    unknown.status === 200 &&
      /<html/i.test(unknownBody) &&
      unknownBody.trim() !== handshakeBody.trim()
  );

  console.log('\n== Room lifecycle ==');
  const host = await connect();
  const controller = await connect();
  const intruder = await connect();

  const hostSeatUpdates = [];
  const hostIntents = [];
  host.on('room:seats', (payload) => hostSeatUpdates.push(payload));
  host.on('game:intent', (payload) => hostIntents.push(payload));

  const created = await emit(host, 'room:create');
  step('host room:create', created);
  const code = created.code;

  const seats = [
    { colour: 'blue', name: 'Alice', isBot: false },
    { colour: 'red', name: 'Bob', isBot: false },
    { colour: 'green', name: 'Robo', isBot: true },
  ];
  step('host room:seats', await emit(host, 'room:seats', { code, seats }));

  const joined = await emit(controller, 'room:join', { code: code.toLowerCase() });
  step('controller room:join (lower-case)', joined);

  const claimed = await emit(controller, 'room:claim', { code, colour: 'blue' });
  step('controller room:claim blue', { ...claimed, seatToken: `${claimed.seatToken?.slice(0, 8)}...` });

  step('controller game:intent roll', await emit(controller, 'game:intent', { kind: 'roll' }));
  await sleep(100);
  step('host received intents', hostIntents);
  check(
    'fromColour is stamped server-side',
    hostIntents.length === 1 && hostIntents[0].fromColour === 'blue'
  );

  console.log(`\n  -- controller drops, waiting ${WAIT_AFTER_DROP_MS} ms --`);
  controller.disconnect();
  await sleep(WAIT_AFTER_DROP_MS);

  step('host saw the seat go offline', hostSeatUpdates.at(-1)?.seats[0]);
  step('intruder room:claim blue', await emit(intruder, 'room:claim', { code, colour: 'blue' }));
  check(
    'a detached seat is not free for the taking',
    (await emit(intruder, 'room:claim', { code, colour: 'blue' })).error === 'SEAT_TAKEN'
  );

  const returned = await connect();
  const reclaimed = await emit(returned, 'room:reclaim', { code, seatToken: claimed.seatToken });
  step('returned room:reclaim', reclaimed);
  check(
    'the same seat comes back',
    reclaimed.ok === true && reclaimed.colour === 'blue' && reclaimed.name === 'Alice'
  );
  await sleep(100);
  step('host saw the seat return', hostSeatUpdates.at(-1)?.seats[0]);

  console.log('\n== Error codes ==');
  step('claim the bot seat', await emit(intruder, 'room:claim', { code, colour: 'green' }));
  step('claim a colour with no seat', await emit(intruder, 'room:claim', { code, colour: 'yellow' }));
  step('intent without a seat', await emit(intruder, 'game:intent', { kind: 'roll' }));
  step('host-only event from a controller', await emit(intruder, 'room:seats', { code, seats: [] }));
  step('unknown room', await emit(intruder, 'room:join', { code: 'ZZZZ' }));
  step('bad seat token', await emit(intruder, 'room:reclaim', { code, seatToken: 'nonsense' }));
  step('malformed payload (bad colour)', await emit(intruder, 'room:claim', { code, colour: 'purple' }));
  step('malformed payload (bad code)', await emit(intruder, 'room:join', { code: 'IIII' }));
  step('malformed payload (not an object)', await emit(host, 'room:create', 'nope'));

  check(
    'a malformed payload is BAD_REQUEST',
    (await emit(intruder, 'room:claim', { code, colour: 'purple' })).error === 'BAD_REQUEST'
  );
  check(
    'a host-only event is NOT_HOST',
    (await emit(intruder, 'room:seats', { code, seats: [] })).error === 'NOT_HOST'
  );
  check(
    'an unseated intent is NOT_SEATED',
    (await emit(intruder, 'game:intent', { kind: 'roll' })).error === 'NOT_SEATED'
  );

  const finalHealth = await fetch(`${BASE_URL}/healthz`);
  step('GET /healthz after', await finalHealth.text());

  for (const socket of [host, returned, intruder]) socket.disconnect();

  console.log(failures === 0 ? '\nSMOKE OK\n' : `\nSMOKE FAILED (${failures} checks)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSMOKE ERROR:', error);
  process.exit(1);
});
