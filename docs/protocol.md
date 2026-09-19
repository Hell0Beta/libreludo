# LibreLudo Realtime Protocol

**This document is the contract between `server/` and `src/net/`.** Change a message shape here in
the same commit that changes the code, or the two sides silently diverge.

Transport: **Socket.IO** over the same HTTP server and port as the static build. Path `/socket.io/`.

The server holds **no game rules**. It knows rooms, seats, and sockets. Every decision about Ludo —
turns, dice, captures, winning — is made by the PC host and reaches phones only as a state
projection.

---

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| **Host** | The PC browser running the authoritative game. Exactly one per room. |
| **Controller** | A phone browser driving one seat. Zero or more per room. |
| **Room** | A 4-character code, a seat list, and an optional host socket. |
| **Seat** | One player slot (`colour` + `name` + `isBot`), optionally claimed by a controller. |
| **`seatToken`** | Opaque secret proving a controller owns a seat. Survives reconnects. |
| **`pairToken`** | Weaker secret: lets a phone *act for* a seat without owning it. |
| **Owner** | The socket holding a seat's `seatToken`. One per seat. |
| **Companion** | A socket paired to a seat via its `pairToken`. Zero or more per seat. |
| **Actor** | An owner *or* a companion — anyone allowed to send `game:intent` for that seat. |
| **Intent** | A controller asking the host to do something. The host may refuse. |

---

## 2. Room codes

4 characters from the alphabet `23456789ABCDEFGHJKMNPQRSTVWXYZ` (**30 characters**).

- `I`, `L`, `O` and `U` are excluded (Crockford-style — `U` is dropped so a random code cannot
  spell something unfortunate), as are the digits `0` and `1`. A code can therefore be read aloud
  or typed without ambiguity.
- Generated with `crypto.randomBytes` using **rejection sampling**, to avoid modulo bias.
- Collisions retried against the live room map. Space is 30⁴ = 810 000.
- Codes are **case-insensitive on input**, uppercase on the wire.
- A released room's code may be reused.

---

## 3. Server state

```ts
type TPlayerColour = 'blue' | 'red' | 'green' | 'yellow';

type Seat = {
  colour: TPlayerColour;
  name: string;              // 1..15 chars, from the host's /setup
  isBot: boolean;
  socketId: string | null;   // null when unclaimed or disconnected
  seatToken: string | null;  // null = never claimed (still open). Ownership.
  pairToken: string | null;  // minted with seatToken. Lets a phone act *for* the seat.
  companions: string[];      // socketIds paired to this seat, alongside the owner
  detachedAt: number | null; // epoch ms; set on disconnect, cleared on reclaim
};

type Room = {
  code: string;                // uppercase, 4 chars
  hostSocketId: string | null; // null while the host is disconnected
  seats: Seat[];
  createdAt: number;
  hostDetachedAt: number | null;
};
```

A seat is **open** when `seatToken === null`, **claimed** when `seatToken !== null`. A claimed seat
with a null `socketId` is **detached** — its controller is temporarily gone.

### The seat summary

What a controller is told about a seat. Never includes `seatToken` **or** `pairToken` — both are
returned once, to the seat's owner, and never broadcast. A leaked `pairToken` would let any phone in
the room play as any player.

```ts
type TSeatSummary = {
  colour: TPlayerColour;
  name: string;
  isBot: boolean;
  claimed: boolean;
  connected: boolean;   // false while detached — the picker shows "reconnecting…"
  paired: boolean;      // true once at least one phone has paired to this seat
};
```

### Grace periods

| Constant | Value | Effect |
| --- | --- | --- |
| `SEAT_GRACE_MS` | 120 000 (2 min) | A detached seat keeps its `seatToken`. Nobody else can claim it. |
| `ROOM_GRACE_MS` | 300 000 (5 min) | A room with no host survives this long so the PC can reload. |
| `SWEEP_INTERVAL_MS` | 30 000 | How often the sweeper runs. |

**A bare socket disconnect must never free a seat.** Phone browsers background and kill tabs
constantly; if disconnect freed the seat, every lock screen would cost a player their place.

The sweeper deletes a room when **both** hold:

1. `hostSocketId === null` and `hostDetachedAt` is older than `ROOM_GRACE_MS`, **and**
2. every claimed seat is detached with `detachedAt` older than `SEAT_GRACE_MS`.

A room with no host but a live controller is kept, so the controller can show "waiting for the
board" rather than being dropped.

---

## 4. Client → server events

All use Socket.IO **acknowledgement callbacks**. Every ack is
`{ ok: true, ...payload }` or `{ ok: false, error: TErrorCode }`.

### `room:create`

Host only. Creates a room with no seats yet.

```ts
// request
{ }
// ack
{ ok: true, code: string }
```

A socket that already hosts a room is moved out of it (the old room is released).

### `room:seats`

Host only. Declares the seat list, normally right after the host finishes `/setup`.

```ts
// request
{ code: string; seats: Array<{ colour: TPlayerColour; name: string; isBot: boolean }> }
// ack
{ ok: true }
```

**Replaces the whole list.** Re-sending is how the host adds or removes a player. Seats whose
`colour` is unchanged **keep their `seatToken` and `socketId`**, so re-sending does not evict a
controller that is already playing. A seat whose colour disappears is released, and its controller
receives `room:seat-lost`.

Broadcasts `room:seats` to every controller in the room.

### `room:join`

Controller. Fetches the seat list so the joiner can render a picker. Grants no access.

```ts
// request
{ code: string }
// ack
{ ok: true; seats: TSeatSummary[]; hostPresent: boolean }
```

`isBot: true` seats are returned but are **not claimable**; the picker should show them disabled or
hide them.

`hostPresent` is included because a joiner otherwise has no way to learn it. A controller that
connects while the host is away — a phone reloading mid-game, or arriving after the board tab was
closed — would hear nothing at all: `room:host-gone` was emitted before it arrived, and
`room:seats` is only broadcast when the seat list changes. Without this field that phone shows a
live-looking screen for a board that is not there, which is the one lie the controller UI must
never tell. The picker opened by a direct visit to `/lobby` shows the same thing.

### `room:claim`

Controller. Takes an open seat.

```ts
// request
{ code: string; colour: TPlayerColour }
// ack
{ ok: true; seatToken: string; colour: TPlayerColour; name: string; pairToken: string }
```

Errors: `NO_SUCH_ROOM`, `NO_SUCH_SEAT`, `SEAT_TAKEN` (already has a `seatToken`), `SEAT_IS_BOT`.

The `seatToken` is a 32-byte `crypto.randomUUID()`. The controller stores
`{ code, seatToken }` in `localStorage` under `libreludo:seat:<CODE>` and uses it for
`room:reclaim`.

**The host is a controller here too.** The board plays player 1 — the first colour in
`playerSequences`, which is `blue` for every player count — so `useRoom` claims that seat on the
host's own socket as soon as the seats are declared. Nothing new is needed to make player 1
"belong to the board": a claimed seat is refused by `claimSeat` and drawn as taken by the picker,
so the rule falls out of the claim. What the host buys with it is the `pairToken`, which is sent
only to the socket that owns a seat, and is what its spirit card turns into the pairing QR.

The one case that does not claim is a **bot player 1**: `SEAT_IS_BOT` is returned and the host holds
no seat, which is correct — the board rolls for that player, and there is nothing to hand a phone.

The host's `seatToken` is stored beside its room pointer under `libreludo:host`, not under
`libreludo:seat:<CODE>`, because the two have to move together: a host that ends up in a new room is
not still player 1 of the room it left.

### `room:reclaim`

Controller. Re-attaches to a seat it already owns, after a reload or a dropped connection.

```ts
// request
{ code: string; seatToken: string }
// ack
{ ok: true; colour: TPlayerColour; name: string; pairToken: string }
```

Errors: `NO_SUCH_ROOM`, `BAD_SEAT_TOKEN`, `SEAT_EXPIRED` (the seat was swept).

On success the server clears `detachedAt`, binds the new `socketId`, and tells the host
`room:seat-attached`. **The previous socket, if any, is detached** — last writer wins, so a phone
that reconnects before the server noticed the drop does not end up with two live sockets.

`pairToken` is returned here as well as at `room:claim`, and the reason is a reload. A PC playing
from its own board shows a pairing QR built from this token; when it reloads it reclaims on a
brand-new socket, and if the token were only ever sent once the QR could never be shown again — the
phone that had not yet scanned it would be shut out of the seat for the rest of the game. The token
is still sent only to the socket that proves ownership, and it still never appears in a seat
summary.

### `room:pair`

```ts
// request
{ code: string; pairToken: string }
// ack
{ ok: true; colour: TPlayerColour; name: string }
```

A phone attaching itself to a seat **a PC already owns**, so the PC and the phone can both play that
player.

Errors: `NO_SUCH_ROOM`, `BAD_PAIR_TOKEN`.

**Why a second token rather than reusing `seatToken`.** `seatToken` proves *ownership*: whoever
holds it can reclaim the seat, and reclaim is last-writer-wins, so a phone given that token would
simply take the seat away from the PC. The `pairToken` is minted alongside it at `room:claim` and
grants the right to **act for** a seat — to send `game:intent` and `game:select` — without the right
to own it. A companion cannot reclaim, cannot release, and cannot outlive the owner's claim.

`pairToken` is returned **only to the socket that claimed the seat**; it never appears in a seat
summary, because broadcasting it would let any phone in the room play as any player. Idempotent:
pairing twice from one socket is the same as pairing once, so a reconnecting phone does not
accumulate entries.

**Companions have no grace period.** A bare disconnect removes the socket from every seat it was
paired to, immediately. A paired phone is a spare controller, not an owner — there is nothing to
preserve across a disconnect. The owner's own grace period is unchanged.

### `room:rehost`

Host only. Re-attaches to a room it already owns, after a reload.

```ts
// request
{ code: string }
// ack
{ ok: true; seats: TSeatSummary[] }
```

Errors: `NO_SUCH_ROOM` (unknown or swept — the host must `room:create` instead), `NOT_HOST`
(another socket currently holds the host role for that room).

On success `hostSocketId` is rebound and `hostDetachedAt` cleared. The host then re-sends
`room:seats`, which restores every controller's claim because unchanged colours keep their
`seatToken`. The host stores its own `{ code }` in `localStorage` under `libreludo:host` so it can
find its way back here.

### `game:intent`

```ts
// request
{ kind: 'roll' }
| { kind: 'move'; tokenId: number }
// ack
{ ok: true }              // forwarded; NOT a promise the host will honour it
```

The server stamps `fromColour` from the sending socket's seat and forwards to the host as
`game:intent`. A socket with no seat is rejected with `NOT_SEATED`.

`{ ok: true }` means *delivered*, not *accepted*. The host applies its own guards (see §7) and any
refusal is visible only as the projection not changing.

### `game:select`

```ts
// request
{ tokenId: number | null }   // null clears the selection
// ack
{ ok: true }
```

A controller's **preview**: which piece it is considering moving. The server stamps `fromColour`
from the seat and forwards to the host, exactly like `game:intent`. A socket with no seat is
rejected with `NOT_SEATED`.

**Not an action.** The host stores it and highlights the matching piece on the board; nothing about
the game changes. It exists because four pieces of a colour are drawn identically, so a phone
saying "Piece 2" is meaningless to someone looking at the board — the preview is what makes the
first of the phone's two taps visible. The second tap then commits a move the player has already
seen pointed at the right pawn.

`tokenId` is bounded to 0–3 and is nullable, so a malformed preview cannot reach the host's state
and sit there pointing at a piece that does not exist. A preview for a piece that is not `isActive`
is kept as received and simply **not rendered** — the board decides what to light up, which is
cheaper and more robust than keeping a preview synchronised with the rules.

---

## 5. Server → client events

### `room:seats`

To every controller in the room. Sent on `room:seats`, on any claim/release, and on host
reconnect.

```ts
{
  seats: TSeatSummary[];
  hostPresent: boolean;
}
```

### `room:seat-lost`

To one controller. Its seat was released (the host removed the colour, or `SEAT_EXPIRED` swept it).

```ts
{ reason: 'removed' | 'expired' }
```

The controller clears its stored `seatToken` and returns to the seat picker.

### `room:host-gone` / `room:host-back`

To every controller. Drives the "waiting for the board" state.

```ts
// room:host-gone
{ since: number }     // epoch ms
// room:host-back
{ }
```

### `game:intent`

To the host, forwarded from a controller.

```ts
{ fromColour: TPlayerColour; kind: 'roll' | 'move'; tokenId?: number }
```

### `game:select`

To the host, forwarded from a controller.

```ts
{ fromColour: TPlayerColour; tokenId: number | null }
```

The host highlights that piece on the board. See §4 for why this exists.

### `game:state`

To every controller in the room. The host's projection — see §6.

```ts
{ projection: TProjection }
```

Throttled to at most one per ~80 ms, and only emitted when the serialised projection actually
changed.

### `room:error`

Out-of-band failure, for conditions with no request to attach an ack to (e.g. the room was swept
while a controller was idle).

```ts
{ error: TErrorCode; code?: string }
```

---

## 6. State projection

The host's entire contract with the phone. The phone renders **only** from this and never computes
rules locally.

```ts
type TProjection = {
  rev: number;                    // monotonic per room, incremented by the host on each emit
  phase: 'lobby' | 'playing' | 'ended';
  currentPlayerColour: TPlayerColour;
  isAnyTokenMoving: boolean;      // drives the phone's "wait" state
  isGameEnded: boolean;
  players: Array<{
    colour: TPlayerColour;
    name: string;
    isBot: boolean;
    playerFinishTime: number;     // -1 until the player finishes
    tokens: Array<{
      id: number;                 // 0..3
      isActive: boolean;          // ← the phone's only "can I move this?" signal
      isLocked: boolean;
      hasTokenReachedHome: boolean;
      coordinates: TCoordinate;
      tokenAlignmentData: {       // where within the tile, and how much to shrink
        xOffset: number;
        yOffset: number;
        scaleFactor: number;
      };
      direction: 'forward' | 'backward' | null;  // drives a viewer's animation timing
    }>;
  }>;
  dice: Array<{
    colour: TPlayerColour;
    diceNumber: number;
    isPlaceholderShowing: boolean;  // true during the host's ~1 s roll animation
  }>;
};
```

**`tokenAlignmentData` and `direction` travel because a PC can render the board.** They were
excluded when a controller was always a phone — a phone draws a list of pieces and has no tile to
place them on. A non-host PC draws the same `<Token>` the host does, and several pieces sharing a
tile are fanned out by these offsets; without them every piece on a shared tile stacks on one spot
at the wrong size. The offsets are **tile-relative** (`xOffset * boardTileSize`), so they are
resolution-independent and correct on a board of a different size without translation.

**Deliberately excluded** — inputs to the host's own decisions, not descriptions of what is on the
board: `initialCoords` (a compiled-in constant — `TOKEN_LOCKED_COORDINATES` is in every copy of the
app, so sending it would be shipping a lookup table one token at a time), `playerSequence` (read
only by `changeTurn` and `markTokenAsReachedHome`, and it *shrinks* as players finish, so a viewer
that rebuilt it from the roster would look right and be wrong), `numberOfConsecutiveSix` (read only
by `executeTokenMove`), `boardTileSize`, `boardSideLength`, `tokenWidth`, `tokenHeight` (a viewer
measures its own board), session timings, and the `dice.rollBag` (the host's private randomness).

**`isActive` is the whole interface.** `activateTokens` (`src/state/slices/playersSlice.ts:102`)
already sets it per token after every roll, encoding exactly "this piece can move now". The phone
does not re-derive it, and must not try.

### Sequencing

`rev` is assigned by the host and is strictly increasing. A controller **discards any projection
whose `rev` is less than or equal to the last one it rendered.** Without this, a reordered frame
makes the dice and the token row visibly flicker backwards.

The host seeds `rev` from the wall clock rather than from 0, so the guarantee survives a host
reload. This matters: a controller sits through a board reload still holding the last revision of
the *previous* host session, so a counter that restarted at 1 would leave every frame of the new
session below it — and the phone would discard all of them and freeze on a board that is still
playing. A later session always starts above an earlier one's highest revision, because frames are
~80 ms apart and a session therefore cannot emit more revisions than milliseconds have elapsed.

An earlier version of this document said a controller should treat a drop in `rev` as a reset and
accept it. That rule cannot be implemented safely — a reordered frame *is* a drop, so honouring it
reintroduces exactly the backwards flicker the counter exists to prevent. Seeding high removes the
need for the rule.

---

## 7. Host-side guards

The server forwards intents without judgement. The **host** must apply all of these before acting,
or a stale or hostile controller can desync the game:

| Intent | Guard |
| --- | --- |
| `roll` | `fromColour === currentPlayerColour`, and the same `isDiceDisabled` condition `Dice.tsx:65-71` computes — not a bot, no token already `isActive`, `!isAnyTokenMoving`, `!isGameEnded`, `!isPlaceholderShowing`. |
| `move` | `fromColour === currentPlayerColour`, and the named token belongs to `fromColour` and has `isActive === true`. |

A refused intent is dropped silently — no error event. The controller sees nothing change, which is
the honest signal that the move was not legal.

These are correctness-of-play guards, not a security boundary: the deployment target is a private
tailnet, and every participant is already trusted with the game.

---

## 8. Disconnect and reconnect

```
CONTROLLER DROPS                     HOST DROPS
─────────────────                    ──────────
socket disconnect                    socket disconnect
  │                                    │
  ├ seat.socketId = null               ├ hostSocketId = null
  ├ seat.detachedAt = now              ├ hostDetachedAt = now
  ├ host ← room:seat-attached          ├ controllers ← room:host-gone { since }
  └ controllers ← room:seats           └ room kept ROOM_GRACE_MS
      (that seat: connected: false)

CONTROLLER RETURNS                   HOST RETURNS
──────────────────                   ────────────
room:reclaim { code, seatToken }     room:reclaim-host? → see below
  │                                    │
  ├ ok → detachedAt = null             ├ hostSocketId = new socket
  │      socketId = new socket         ├ hostDetachedAt = null
  │      old socket (if any) detached  ├ controllers ← room:host-back
  └ ack { colour, name }               └ controllers ← room:seats
```

**Host reconnect.** The host re-establishes by calling `room:create` again and immediately
re-sending `room:seats` with the same colours. Because `room:seats` preserves the `seatToken` of
unchanged colours **within the same room**, this only works if the host rejoins the *same* room.
The host therefore stores its own `{ code }` in `localStorage` under `libreludo:host` and calls a
new `room:rehost { code }` on load, which rebinds it to the existing room if that room still exists
and its old host is gone. If the room was swept, `room:rehost` returns `NO_SUCH_ROOM` and the host
creates a fresh room — controllers then get `room:error { error: 'NO_SUCH_ROOM' }`, clear their
`seatToken`, and return to the picker.

On reconnect the host **must also resume the game from its own saved state**. Controllers are
stateless mirrors and need nothing replayed; the first `game:state` after reconnect restores them.

---

## 9. Error codes

| Code | Meaning | Who sees it |
| --- | --- | --- |
| `NO_SUCH_ROOM` | Unknown or swept code. | Anyone |
| `NO_SUCH_SEAT` | Colour not in the room's seat list. | Controller |
| `SEAT_TAKEN` | Seat already has a `seatToken`. | Controller |
| `SEAT_IS_BOT` | Seat is a bot; not claimable. | Controller |
| `SEAT_EXPIRED` | Seat was swept during the grace period. | Controller |
| `BAD_SEAT_TOKEN` | `reclaim` token does not match. | Controller |
| `BAD_PAIR_TOKEN` | `room:pair` token matches no seat. | Controller |
| `NOT_SEATED` | Sent `game:intent` without a seat, and is neither the owner nor a companion of one. | Controller |
| `NOT_HOST` | Sent a host-only event from a non-host socket. | Host |
| `BAD_REQUEST` | Payload failed validation. | Anyone |

Payloads are validated with **zod** on both sides (zod is already a dependency of the client; the
server adds it too). A payload that fails validation is rejected with `BAD_REQUEST` and never
reaches the room.

---

## 10. Lifecycle of a game

```
HOST                                     SERVER                       CONTROLLER
 │                                          │                              │
 ├─ room:create ───────────────────────────▶│                              │
 │◀──────────────────────────── { code } ───┤                              │
 │                                          │                              │
 │  (host runs /setup locally)              │                              │
 ├─ room:seats [Alice, Bob] ───────────────▶│                              │
 │◀───────────────────────────── { ok } ────┤                              │
 │                                          │                              │
 │                                          │◀── room:join { ABCD } ───────┤
 │                                          ├── { seats } ────────────────▶│
 │                                          │                              │
 │                                          │◀── room:claim { ABCD, blue }─┤
 │                                          ├── { seatToken } ────────────▶│
 │◀── room:seats (claimed: true) ───────────┤                              │
 │                                          │                              │
 │  (game starts; host begins projecting)   │                              │
 ├─ game:state { projection } ─────────────▶├─── game:state ──────────────▶│
 │                                          │                              │
 │                                          │◀── game:intent { roll } ─────┤
 │◀── game:intent { fromColour: blue } ─────┤                              │
 │                                          │                              │
 │  (host validates, rolls, animates)       │                              │
 ├─ game:state { projection } ─────────────▶├─── game:state ──────────────▶│
 │                                          │                              │
```

---

## 11. Open questions

- **Seat reordering.** `room:seats` currently replaces the list. If a future flow lets the host
  reorder players mid-game, seats keyed by `colour` are unaffected, but the host must not change a
  seat's colour while it has a live controller.
- **More than four controllers.** The seat list is bounded by the four Ludo colours, so the room is
  naturally capped. A seat may now have several *actors* — its owner and any number of paired
  companions — but only one owner.
- **Seat colours are still fixed at claim.** A `room:claim` for a colour that already has a
  `seatToken` is refused with `SEAT_TAKEN`, which is what stops a second PC taking a seat out from
  under its owner. Ownership only ever moves through `room:reclaim`, which needs the token.
- **Bots take seats out of circulation a different way.** A `room:claim` for a bot seat is refused
  with `SEAT_IS_BOT` and no token is ever minted, so a bot seat is never `claimed` — `isBot` alone
  is what keeps it out of the picker. Worth remembering when reading a seat summary: `claimed` is
  about who *holds* a seat, not about whether it is available.
