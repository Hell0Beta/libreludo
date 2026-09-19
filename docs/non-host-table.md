# A non-host PC at the table, and the phone that pairs to it

A second PC can join someone else's room, see the real board, and play its own colour from it — and
hand a phone the same colour by scanning a QR in its spirit card, so both devices act for one
player. The host does the same for player 1, its own seat.

This document is the record of that change. The protocol half is in
[`protocol.md`](./protocol.md); the networking it builds on is in
[`phone-controllers.md`](./phone-controllers.md).

---

## The flow, as a player experiences it

```
PC 1 (host)                     PC 2 (joiner)                     Phone
────────────                    ─────────────                     ─────
Create Custom Room
/setup  name the seats
claims player 1 → its own QR
QR + passcode shown
                                types the code on the menu
                                /join/CODE → pick a seat
                                /table/CODE
                                ┌ board, mirrored live
                                └ "Realm Spirits" column,
                                   own card carries a QR
                                                                  scans that QR
                                                                  /join/CODE#pair=…
                                                                  → /controller/CODE
                                                                  die + pieces
                                both roll and both move for the same colour
```

**Player 1 is the board's.** The host claims that seat the moment the seats are declared, so the
picker draws it as Taken and `room:claim` refuses it — "player 1 belongs to the host" needs no rule
of its own, it falls out of the existing claim. Any phone that wants in on that colour pairs to it
instead, which is the same route the joiner PC's QR uses.

---

## What a joiner is, and what it is not

A PC that joins is a **viewer**: it holds a seat, it can act for it, and it is authoritative about
nothing. Every pixel it draws came off the wire; every click it makes is a request.

That is the same relationship the phone has, and it is deliberately built out of the *same* pieces:
`useController` claims the seat, `game:intent` carries the actions, and the owner/companion split
from `protocol.md` §4 governs who may do what. A PC claims a seat exactly as a phone does. Only what
it does with the seat differs.

|  | Host | Joiner PC | Phone |
| --- | --- | --- | --- |
| Holds the game | yes | no | no |
| Holds a seat | yes — player 1 | yes | yes |
| Renders the board | yes | **yes** (mirrored) | no |
| Acts directly on the board | yes | **yes**, for its own seat | no |
| Reads its state from | its own slices | the projection, poured into those slices | the projection directly |
| Pairing QR | **yes**, for player 1 | **yes**, for its seat | no |

---

## The decision that shapes everything: mirror the frame, don't build a second board

A joiner needs the real board. The obvious implementation is a second set of board components
reading `room.projection` — and that is the trap. It is two boards to keep in step, and the one
nobody plays on is the one that rots.

So the frame is poured into the slices the board already reads, and `Board`, `Token` and `Dice`
never learn that the game is running on another machine:

- `mirrorProjectedPlayers` and `mirrorProjectedDice` (`src/state/slices/`)
- `useProjectionMirror` (`src/net/`) dispatches them per frame, and clears the slices on unmount

Two things the wire does not carry are reconstructed rather than sent. `initialCoords` is
`TOKEN_LOCKED_COORDINATES[colour][id]`, a constant compiled into every copy of the app.
`playerFinishOrder` is derived by sorting `playerFinishTime` — with one case sorting misses, the
runner-up, whom `markTokenAsReachedHome` appends *without* a finish time because they never got all
four pieces home.

**Every field is compared before it is assigned.** Immer records *any* assignment as a change, so a
mirror that wrote `coordinates` on every frame would produce a fresh object ~12 times a second
against a position that had not moved, re-running every token's framer-motion effect each time.
`tests/slices/mirror.test.ts` pins this with reference equality, not value equality.

### What stops the joiner playing a private game

Mirroring alone would be worse than useless: the viewer would render a correct board and then play a
*local* game that diverges from the host on the first move and never comes back. The switch is
`BoardMode` (`src/net/boardMode.ts`):

- **local** — `/play` and the host's `/room/:code`. A click runs the rules. Every colour is playable,
  because hotseat is one person taking all the turns.
- **remote** — a joiner. A click becomes a `game:intent`, and only for the one colour this screen
  holds.

It is a context with a **local fallback**, not a required provider. A missing provider reads as "this
is the host's own board", which is correct — so a component that forgets to handle remote mode fails
towards the behaviour that was already there rather than towards a silently broken one.

Three places needed more than a callback swap:

1. `Token`'s `pendingMove` effect is skipped entirely in remote mode. Nothing writes `pendingMove` on
   a viewer, so this is a no-op today; the guard makes that a property of the code rather than a fact
   about current traffic.
2. `Token.handleTokenClick` stops propagation in remote mode. `Board` resolves a tap to whichever
   active piece of the current colour sits on that tile — correct for a tap on the board, a duplicate
   intent for a tap that landed on the piece itself.
3. `Dice` disables on `isDiceDisabled(state, colour) || !canActFor(colour)`. The first asks "may this
   colour roll in the game", which on a viewer is true for whoever's turn it is — including another
   player's die, sitting on a board it is only watching. The second asks "may *this screen* act for
   them".

### The preview halo

`previewToken` — the highlight that makes the phone's first of two taps visible — is *not* projected,
so a joiner's board does not light up when its paired phone is choosing a piece. This is a known gap,
not a decision: the mechanism that would fix it (project `previewToken`, mirror it into `roomSlice`)
is small, and the two-tap flow was designed around the board showing what the phone is pointing at.
Worth doing before anyone relies on the pairing in earnest.

---

## Pairing: a phone as a second controller for one seat

From `protocol.md` §4. `seatToken` proves **ownership** — whoever holds it can reclaim the seat, and
reclaim is last-writer-wins. `pairToken` grants the right to **act for** a seat without the right to
own it. A phone given the `seatToken` would simply take the seat away from the PC; a phone given the
`pairToken` cannot.

The QR lives in the spirit card of the seat this device owns, and its payload is:

```
<origin>/join/CODE#pair=<pairToken>
```

Three things about that shape, none of them arbitrary:

- **The fragment, not the query string.** A fragment is not sent to the server and is not a
  `Referer`, so the token stays out of relay logs, access logs and history. A query string would leak
  it to all three for no benefit.
- **The device's own origin** — `localhost` in dev, the `*.ts.net` name over the tailnet. The screen
  showing the QR is running on the machine the phone needs to reach, so its own origin is by
  definition reachable. Same reasoning as the invite QR.
- **`/join/:code`, not a route of its own.** A pairing link that no longer works means the seat moved
  on, and the useful thing to show is the ordinary seat picker with that explained — which `/join`
  already is. A separate route would have had to grow its own copy.

### The fragment has to outlive the join screen

A companion has **no grace period**: the server drops it from every seat the moment its socket goes.
So a paired phone that sleeps comes back holding nothing.

That is why the fragment travels on to `/controller/:code`, why `useController` takes a `pairing`
option and re-pairs whenever the phase is `picking` on a live socket, and why `Join` and `Controller`
both suppress the seat picker while a pair is in flight — a pairing link names its seat, so offering
a choice for a fraction of a second invites a tap that would claim a *different* player and make the
fragment a lie.

`useController`'s `pairing` option also **outranks the stored seat**. A phone that already holds a
seat in the room would otherwise reclaim it before the pairing was ever attempted, and a pairing code
handed to it would be silently ignored — which is exactly the case a pairing link is for, since
someone passing a phone round is the whole point.

---

## Protocol change

One, and it is additive:

> `room:reclaim` now returns `pairToken` alongside `colour` and `name`.

It was already minted at `room:claim`. The reason it has to come back: a PC that reloads reclaims on
a brand-new socket, and the QR is rendered from this value — if it were sent only once, a reload
would leave the PC with a board and no way to hand its phone the seat, for the rest of the game. It
is still sent only to the socket that proves ownership, and still never appears in a seat summary.

---

## Files

| File | What it is |
| --- | --- |
| `src/net/boardMode.ts` | The context, `useBoardActions` (local fallback), `useRemoteBoardActions` |
| `src/net/BoardModeProvider.tsx` | The provider component, split out so the hooks file stays fast-refreshable |
| `src/net/useProjectionMirror.ts` | Dispatches a frame into the game slices; clears them on unmount |
| `src/net/pairing.ts` | `buildPairingUrl` / `pairingFragment` / `readPairingToken` |
| `src/pages/Table/` | The joiner's table |
| `src/components/Tabletop/` | The shell both tables share |
| `src/components/Tabletop/ConfirmDialog.tsx` | The leave confirm, shared by both |
| `src/state/slices/playersSlice.ts` | `mirrorProjectedPlayers`, `tokenFromProjection`, `finishOrderFromProjection` |
| `src/state/slices/diceSlice.ts` | `mirrorProjectedDice` |

`/room/:code` stays the **host's** route and was not merged with `/table/:code`. The role is decided
by the server (a rehost either succeeds or answers `NOT_HOST`), and keeping the two routes apart
means the host path — which works — was refactored only for its chrome, never for its behaviour.

---

## Verification

`pnpm lint`, `pnpm type-check`, `pnpm test` (302 tests), `pnpm build` — all green.

New coverage:

- `tests/slices/mirror.test.ts` — roster rebuild, no aliasing of the frame, reference stability
  across identical frames, the runner-up case in the finish order, `rollBag` left alone.
- `tests/net/boardMode.test.tsx` — the local fallback, and that remote mode refuses a colour it does
  not hold and never touches the store.
- `tests/net/pairing.test.ts` — the fragment round-trip, and the parsing edge cases (a second `#`, a
  malformed escape, a key that merely starts the same way).
- `server/__tests__/socket.test.js` — `pairToken` survives a reclaim, and a paired phone keeps
  playing when the owner reloads.

**Not** covered, and worth knowing before trusting any of this on a screen: nobody has looked at
`/table/:code` or scanned a pairing QR with a camera. The socket behaviour behind both is well
tested; the rendered result is unreviewed.
