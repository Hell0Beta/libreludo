# Phone Controllers, Lobby & Game Menu

Status: **planned, not yet built**

## Context

LibreLudo today is a **purely client-side, same-device game**. Everything lives in client Redux
(`src/state/store.ts` combines `players`, `board`, `dice`, `session`), the rules are woven through
React hooks that drive framer-motion animations, and the app builds to static files for Cloudflare
Pages (`react-router.config.ts` → `ssr: false`, `prerender: [...]`). There is **no server of any
kind**.

The goal is to make a phone act as a personal controller for a game shown on a PC: the PC hosts the
board, a QR code lets phones join a room, each phone gets a 3D dice it rolls by shaking and a row of
buttons for choosing which piece to move. Alongside that, the landing page currently reads as a
marketing site (hero, emoji feature cards, gradient footer) rather than a game menu, and the game
has no music and a single flat background.

**Decisions already agreed:**

| Question | Decision |
| --- | --- |
| Where do the rules live? | **PC stays authoritative.** The server is a dumb relay: room registry + message forwarding. Existing hooks are reused unchanged. |
| How does a phone get a seat? | **PC creates the room and runs the existing `/setup`** (names + bots). The room then advertises open seats; the phone picks a name from a list. Names match by construction — nothing is typed twice. |
| Phone piece selection | **A row of 4 large token buttons**, not a mirror of the board. |
| 3D dice | **react-three-fiber + drei + rapier**, lazy-loaded so local players never download it. |
| Music | The user supplies the file; we build the system around it. |
| Existing local/bot play | **Kept.** The menu offers both paths. |
| Tailscale | **`tailscale serve` over HTTPS**, because DeviceMotion requires a secure context. |

See [`protocol.md`](./protocol.md) for the wire protocol. That document, not this one, is the
contract between the server and the client: `server/protocol.js` and `src/net/protocol.ts` are
hand-kept mirrors of it, and changing a message shape means changing all three.

---

## Architecture

```
   PHONE (controller)              SERVER (relay)              PC (host, authoritative)
   ─────────────────               ──────────────              ────────────────────────
   shake / tap  ──── "roll" ──────▶  room registry  ─────────▶  useRollDice()  + animation
                                                                      │
   3D dice lands  ◀── "state" ─────  broadcast      ◀───────  store.subscribe → projection
   on the face                                                        │
   tap token      ─── "move" ──────▶  forward       ─────────▶  requestTokenMove (Redux)
   tap again ────────────────────────────────────────────────▶  existing Token move path
```

The server never sees game rules. It knows rooms, seats and sockets.

### Why Socket.IO over `ws`

Rooms (`socket.join(code)`), automatic reconnection with backoff, and ack callbacks
(request/response) all come free. With `ws` those are hand-rolled. Client is ~40 KB gzipped but is
**lazily imported only on controller/host routes**, so local hotseat players never pay for it.

---

## A. Server

Full message specification lives in [`protocol.md`](./protocol.md).

New `server/` directory, run by Node. One process, one port:

- Express (or plain `node:http`) serving `build/client` with an SPA fallback
- Socket.IO attached to the same HTTP server
- In-memory `Map<code, Room>`

```ts
type Seat = {
  colour: TPlayerColour; name: string; isBot: boolean;
  socketId: string | null; seatToken: string | null;      // null seatToken = unclaimed
  detachedAt: number | null;                              // for the reconnect grace period
};
type Room = {
  code: string;
  hostSocketId: string | null;
  seats: Seat[];
  createdAt: number; hostDetachedAt: number | null;
};
```

**Room code** — 4 characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ` (**30 chars**; `I L O U` and the
digits `0 1` are omitted, so a code can be read aloud unambiguously). `crypto.randomBytes` with
rejection sampling, retry on collision. 30⁴ = 810 000.

**Reconnect grace periods are load-bearing.** Phone browsers background and kill tabs constantly,
and the PC host will reload. A seat survives a **2 min** phone disconnect; a room survives a
**5 min** host disconnect. A bare socket disconnect must never free a seat. A 30 s sweeper drops
rooms past their grace period.

**Trust model.** This runs on a tailnet, so the host does basic sanity checks rather than deep
validation: ignore an intent from a seat that isn't `currentPlayerColour`, ignore a `move` for a
token that isn't `isActive`, apply the *same* `isDiceDisabled` guard `Dice.tsx:65-71` uses before
honouring a roll. That's enough to stop a stale phone desyncing the game.

---

## B. State projection

The phone needs a *view*, not the game. Project from `players` + `dice` only — `tokenAlignmentData`,
`initialCoords`, `direction` and `playerSequence` are board-rendering concerns the phone never uses.

```ts
type TProjection = {
  rev: number;                                   // monotonic; phone drops stale frames
  phase: 'lobby' | 'playing' | 'ended';
  currentPlayerColour: TPlayerColour;
  isAnyTokenMoving: boolean;
  isGameEnded: boolean;
  players: Array<{
    colour: TPlayerColour; name: string; isBot: boolean; playerFinishTime: number;
    tokens: Array<{ id: number; isActive: boolean; isLocked: boolean;
                    hasTokenReachedHome: boolean; coordinates: TCoordinate }>;
  }>;
  dice: Array<{ colour: TPlayerColour; diceNumber: number; isPlaceholderShowing: boolean }>;
};
```

`isActive` is already exactly the signal the phone needs — "which of my pieces can move right now"
— because `activateTokens` (`playersSlice.ts:102-119`) sets it after every roll. Nothing new to
compute.

**How often:** a `store.subscribe()` on the host that recomputes the projection and emits **only
when the serialised result changes**, with a ~80 ms trailing throttle. Snapshots, not diffs — the
payload is a few hundred bytes and diffs buy nothing but sequencing bugs on a tailnet. The `rev`
counter lets the phone discard reordered frames.

A store subscriber beats a middleware here: the existing code dispatches from many hooks *and*
calls `saveState` directly in several places, so a subscriber is far less invasive.

---

## C. Client integration

`src/net/`, as built — the plan named four files and it took nine, because the two bridges turned
out to share more than they differ:

| File | What |
| --- | --- |
| `socket.ts` | Lazy singleton Socket.IO client. Deliberately **one socket per document**: the lobby creates a room and `/room/:code` rehosts on the same connection, so navigating between host routes must not drop the host role. |
| `protocol.ts` | Every event name, payload shape and error code on the wire, mirrored from `server/protocol.js` and `docs/protocol.md`. |
| `ack.ts` | `emitAck` / `waitForConnect` — request/response with a timeout. Socket.IO acks never time out on their own, and a relay that goes quiet would otherwise leave a phone spinning forever. |
| `projection.ts` | `projectState` — the pure host-side projection. |
| `controllerGuards.ts` | The phone-side "can I roll / can I move" predicates, over a `TProjection` rather than a `RootState`. A sibling of `game/guards.ts`, not a duplicate: the host owns the game and the phone does not. |
| `hostStorage.ts` | `libreludo:host` — the PC's own room pointer. |
| `seatStorage.ts` | `libreludo:seat:<CODE>` — the phone's `seatToken`, per room. Global keying would make joining a second room look like a reclaim against the first. |
| `useRoom.ts` | Host bridge. |
| `useController.ts` | Controller bridge: join, claim, reclaim on reconnect, render frames. |

A new `roomSlice` holds room/seat/projection state. **The phone never hydrates into the game
slices** — it renders from the projection, so `useCleanup` and the whole game reducer stay a
PC-only concern.

### Two protocol changes the plan did not foresee

Both are in `docs/protocol.md`, which is the contract; they are recorded here because they change
the shape of what the plan described.

1. **`room:join`'s ack carries `hostPresent`.** A controller that connects while the host is away
   would otherwise never learn it: `room:host-gone` was emitted before it arrived, and `room:seats`
   only fires when the seat list changes. That phone would show a live-looking die for a board that
   is not there.
2. **`rev` is seeded from the wall clock, not from 0.** A controller sits through a host reload
   still holding the last revision of the previous host session; a counter restarting at 1 would
   put every frame of the new session below it, and the phone would discard all of them and freeze
   on a board that is still playing. The earlier rule — "treat a drop in `rev` as a reset" — cannot
   be implemented safely, because a reordered frame *is* a drop.

### The one real refactor: lift `tokenClickData` into Redux

Today `Board.tsx:19` holds `tokenClickData` in local `useState` and passes it to every `Token`,
which watches for its own id (`Token.tsx:145-153`). A network intent cannot reach local component
state, so:

1. Add `pendingMove: { timestamp, colour, id } | null` + a `requestTokenMove` action to
   `playersSlice` (transient — **not** added to the storage schema).
2. `Board.tsx` dispatches `requestTokenMove` instead of calling `setTokenClickData`.
3. `Token.tsx` reads it via `useSelector` instead of props.
4. The host bridge dispatches the same action on a network intent.

Now local clicks and remote intents drive the **identical** move path — no duplicated logic.

### Roll path

The roll sequence currently lives inline in `Dice.tsx:73-78`. Extract it into
`src/hooks/usePerformRoll.ts`:

```ts
const n = await rollDice(colour);
const res = await handlePostDiceRoll(colour, n);
if (res?.shouldChangeTurn) changeTurnFn();
```

`Dice.tsx` and the host bridge both call it. Nothing about the timing changes — `useRollDice`'s
1 s placeholder delay (`useRollDice.ts:10,19`) means the host spins, then reveals, and the
projection only carries the final number because `setDiceNumber` is dispatched after the delay.

### Two-tap confirm

Implemented on the **phone only** (tap selects, second tap emits the move intent). The PC keeps its
current single-click-to-move — adding friction there serves no one. *Flag if the PC should match.*

---

## D. Routes and flows

| Route | Who | Purpose |
| --- | --- | --- |
| `/` | both | **Redesigned game menu** (was the landing page) |
| `/lobby` | both | Room code entry; **Create Room shown only for non-phone devices** |
| `/room/:code` | PC host | Board + QR panel + seat status |
| `/join/:code` | phone | Seat picker → then `/controller/:code` |
| `/controller/:code` | phone | Die, Roll, and four pieces (phase 3: a flat die; phase 5 swaps in the 3D one) |
| `/setup`, `/play`, `/how-to-play` | PC | **Unchanged** — local hotseat + bots |

```
PC:     Menu ─▶ Play with phones ─▶ /lobby ─▶ Create Room ─▶ /setup ─▶ /room/ABCD
                                                                        └ QR: …/join/ABCD

PHONE:  scan QR ─────────────────────────────────────────▶ /join/ABCD
                                                          └ "Which player are you?"
                                                             [ Alice ] [ Bob ] [ Bot ]
                                                             └▶ /controller/ABCD
```

**QR payload:** `${window.location.origin}/join/${code}`. The host is already browsing the app at
exactly the right URL, so its own origin *is* canonical — no server config needed, and it works
unchanged in dev and on the tailnet. Optional `VITE_PUBLIC_ORIGIN` override.

**Detecting a phone** for hiding Create Room: `matchMedia('(hover: none) and (pointer: coarse)')`,
plus an explicit "I'm on a phone" escape hatch link. The QR path skips the menu entirely, so this
only matters for a phone that navigates to the site directly.

**QR rendering:** `qrcode.react` (SVG, self-contained, no canvas) — small dep, works while offline
on the board screen.

The three new dynamic routes are deliberately **excluded** from `prerender` in
`react-router.config.ts`.

---

## E. 3D dice and shake

`src/phone/DiceScene.tsx`, imported via `React.lazy` **only** from `/controller/:code` — local and
hotseat players never fetch three.js.

**Forcing the face.** Run the rapier sim while the die tumbles, then once velocity drops below a
threshold (or ~1.4 s elapses), stop the sim and **slerp the quaternion to the canonical orientation
for the rolled face**. Physical feel, deterministic outcome. Needs a
`FACE_ROTATION: Record<1|2|3|4|5|6, THREE.Quaternion>` table derived once during implementation
(face → +Y up).

**Shake.** `devicemotion` → `accelerationIncludingGravity` → `|a| - 9.81` → threshold ≈ 12 m/s²,
requiring ≥ 3 threshold crossings inside 500 ms, then a 1.5 s cooldown so the settle doesn't
re-trigger.

**iOS permission.** `DeviceMotionEvent.requestPermission()` only works from a user gesture. So the
controller opens with a single **"Enable sound & shake"** priming tap that requests motion
permission *and* resumes the `AudioContext` in the same gesture — one tap, both unlocks. Denied or
unsupported → the Roll button, which is always present anyway.

**Bundle mitigation.** Add the three.js chunk to `globIgnores` in `pwa.config.ts:31` so it stays out
of the PWA precache and is fetched on demand instead.

---

## F. Token icons

Currently one `src/assets/token.svg` recoloured by `--fill-colour`, so **all four pieces of a
colour are identical**.

Two axes, because the four player colours contain the classic red/green confusion pair:

- **Token identity = shape.** Four distinct silhouettes (`piece-1..4.svg`: pawn, disc, cone, cube),
  identical across players.
- **Player = colour + pattern.** A per-player SVG `<pattern>` fill overlay (solid / stripes / dots /
  cross-hatch) so a red and a green piece remain distinct **in greyscale**.
- **On the phone**, each button is large and additionally carries the piece number and its state
  (Locked / On board / Home), so identification never depends on colour at all.

Touches `Token.tsx` (pick by `id`), `Token.module.css`, new assets, and a new `PlayerTokenButton`
component.

---

## G. Audio and backgrounds

`src/audio/AudioProvider.tsx` + `useAudio()` — one looping `HTMLAudioElement`, `volume`, `muted`.

- **Autoplay:** browsers block until a gesture. Install a one-shot `pointerdown`/`keydown` listener
  at the app root to unlock, and put a visible mute/music toggle in the game menu so there's an
  obvious affordance.
- **Persist** the muted preference in localStorage alongside the existing save.
- Default to **board-only** music — a phone in someone's hand playing music is unpleasant.
  *Flag if it should play on both.*
- Asset at `public/audio/theme.mp3`. **Degrade gracefully when the file is absent** so the app is
  never broken before the track is added.

**Backgrounds:** the four jpgs currently sit untracked at `backgrounds/`. Move them to
`src/assets/backgrounds/` so Vite hashes them and `ViteImageOptimizer` (`vite.config.ts:43`)
compresses them, add a `pickBackground()` util, and replace the single `bg.jpg` import at
`Game.tsx:11,129`.

Two things to settle when this phase starts, noted here so they are not a surprise:

1. **The filenames are unusable** — three are camera-roll or download names
   (`7107311909149123.jpg`, `9359111722739628.jpg`, `Discover the Latest in Vibrant Anime Flower
   Art _.jpg`, `Instagram.jpg`) and one contains spaces. Rename them to something stable
   (`meadow.jpg`, `arches.jpg`, `blossom.jpg`, `shore.jpg`) as part of the move.
2. **They are portrait phone wallpapers in a saturated anime/illustration style, which is not the
   palette section H proposes.** In rough order of darkness: `meadow` (dark indigo sky, green
   field, lantern — this one genuinely fits the `--table: #1B1B3A` direction), `arches` (bright
   blue sea and stone ruins), `blossom` (pink cherry blossom, turquoise, brightest of the four),
   `shore` (top-down beach, green and turquoise). White-on-dark UI will not survive direct contact
   with `blossom` or `shore`. So either the artwork is used only behind the **board** at reduced
   opacity under a scrim, with the menu keeping the flat dark ground; or the menu is designed *onto*
   the artwork with a heavy gradient scrim and a palette sampled from the image. Pick one
   deliberately rather than defaulting. They are also portrait crops, so on a landscape PC board
   they need `background-size: cover` with a deliberate `background-position` or they will crop
   badly.

---

## H. Menu and visual direction

Grounded in the subject — a **physical board game**: four coloured quadrants, a cross of cells,
pawns, pips. Those four colours already exist in the codebase and are load-bearing, so the
interface is built *out of them* rather than having a marketing palette bolted on top.

Explicitly avoided, as the generic generated-design defaults: cream + serif + terracotta; near-black
+ acid green; broadsheet hairlines; the SaaS rounded-card kit; tracked-out all-caps eyebrows;
numbered markers; `→` appended to buttons.

**Tokens**

| Token | Value | Role |
| --- | --- | --- |
| `--table` | `#1B1B3A` | deep indigo-slate felt the board sits on (kin to the existing `--color-primary: #4f46e5` — the plan originally misquoted this as `#7C5FFF`) |
| `--surface` | `#2A2A55` | raised panel on the table |
| `--ink` | `#F2F0FF` | off-white text on the dark ground |
| `--blue` `--red` `--green` `--yellow` | `#1295E7` `#FF3B3B` `#049645` `#FFD22E` | the four player colours, red/yellow nudged for contrast on dark |
| `--gold` | `#F5C451` | the single accent meaning "active / your turn" |

**Type.** Keep **Inter Variable** for UI and body — already bundled, zero cost, good at small sizes.
Add **one display face** with real character for the wordmark and headings. Bricolage Grotesque was
the candidate, and it is confirmed available: `@fontsource-variable/bricolage-grotesque@5.3.0`
resolves from the registry, matching the `@fontsource-variable/inter@5.3.0` already in the tree.
Self-hosted via the same `@font-face` pattern as `src/fonts.css`, so no network fetch at runtime.
One family for UI, one clearly distinct for display. (`qrcode.react@4.2.0` also confirmed for
section D.)

**Layout — a game menu, not a landing page.** A single centred column: the wordmark, then a vertical
stack of full-width items, each a *cell* whose left edge is tinted with one of the four player
colours. Focus lifts the item and lights its edge. No hero, no feature grid, no emoji cards, no
gradient footer.

```
        ╔══════════════════════╗
        ║   L I B R E L U D O  ║
        ╚══════════════════════╝

   ▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜
   ▌ ▶  Play with phones        ▐   blue edge
   ▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟
   ▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜
   ▌    Pass and play           ▐   red edge
   ▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟
   ▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜
   ▌    How to play             ▐   green edge
   ▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟
   ▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜
   ▌    Load last game          ▐   yellow edge
   ▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟
            ♪  ⚙
```

**Principle:** the four player colours are the *only* decoration. The cross motif appears once — as
the wordmark's counter or the focus indicator — not scattered. Copy uses active voice, an action
keeps its name through the whole flow, and errors say what happened and how to fix it.

**Lobby and forms.** Same dark ground. The room code entry is **four discrete character cells**, not
a text input — it reads as a game and matches the 4-char code exactly. The phone's seat picker is
four large coloured name tiles.

Restyle `HomePage.module.css`, `PlayerSetup.module.css`, `HowToPlay.module.css` and the shared
`index.css` tokens. `--color-primary` / `--color-primary-hover` stay defined so untouched components
keep working.

---

## I. Docker and Tailscale

`Dockerfile`, multi-stage: `node:22-alpine` → `corepack enable && pnpm install --frozen-lockfile &&
pnpm build` → runtime copying `build/client`, `server/`, and prod-only `node_modules` (express +
socket.io), `CMD ["node", "server/index.js"]`.

```yaml
# docker-compose.yml
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: libreludo
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY}
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - ts-state:/var/lib/tailscale
      - ./tailscale/serve.json:/config/serve.json:ro
    cap_add: [NET_ADMIN]
    restart: unless-stopped
  app:
    build: .
    network_mode: "service:tailscale"     # shares the tailscale netns
    environment:
      PORT: 3000
    depends_on: [tailscale]
    restart: unless-stopped
volumes:
  ts-state:
```

```json
// tailscale/serve.json
{ "TCP": { "443": { "HTTPS": true } },
  "Web": { "${TS_CERT_DOMAIN}:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } } }
```

**Prerequisites:** enable **MagicDNS** and **HTTPS certificates** for the tailnet in the Tailscale
admin console, then put `TS_AUTHKEY` in a gitignored `.env`.

The app learns its own public URL from `window.location.origin` — no server config, and identical in
dev and on the tailnet.

---

## J. Phasing

Ordered so the riskiest unknowns are proven first. **Phases 1–3 are fully testable in two desktop
browser windows** — a laptop browser can join as a controller, claim a seat and use the tap-to-roll
fallback. Only shake and the 3D feel need real hardware.

| # | Phase | Status | Verifiable by |
| --- | --- | --- | --- |
| 0 | `docs/` | **done** | Read it |
| 1 | Server, rooms, protocol (`server/`) — no UI | **done** | Node script / socket tests |
| 2 | Host bridge, `/room/:code`, QR display | **done** | Two browser windows |
| 3 | Controller UI (no 3D): seat claim, token row, select/confirm, tap-to-roll | **done** | Two browser windows |
| 4 | Docker + Tailscale | **done**, Tailscale unverified | Real devices on the tailnet |
| 5 | 3D dice + shake | | **Real phone** (needs phase 4 for HTTPS) |
| 6 | Token icons | | Board + phone |
| 7 | Menu redesign, audio, backgrounds | | Browser |
| 8 | Polish, tests, docs | | A read of the finished seam |

Phase 7 is independent of all the networking and can be pulled forward if the visible redesign is
wanted sooner.

> **Later work, in its own document:** a non-host PC can now join someone else's room, render the
> real board and play its own colour from it, and hand a phone the same seat by scanning a QR in its
> spirit card. See [`non-host-table.md`](./non-host-table.md).

Phases 2–3 are built against [`protocol.md`](./protocol.md) alone: the client never reads the
server source, so a change that needs both files edited is a change to the protocol document
first.

**What "verifiable by" actually meant.** Every phase marked done was verified by the automated
gates (`pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`) plus integration tests in
`tests/net/` that drive the real relay server over a real socket — the host bridge and the
controller bridge separately, since `src/net/socket.ts` is a singleton and one browser context
cannot be two devices.

The "two browser windows" column is the plan's original intent and has **not** been carried out.
Nobody has looked at the Lobby, Room, Join or Controller pages on a screen, and the QR code has
never been scanned by a camera. The socket behaviour behind those screens is well covered; the
rendered result is unreviewed, and should be treated as such until someone opens them.

---

## Things in the existing code that will fight this

1. **`Game.tsx:48-57` hydrates from the local save on mount.** In networked mode a stale save would
   desync the host from the room. Networked mode must skip save hydration and save-on-hide, or
   namespace the save key per room. **Biggest trap.**
2. **A backgrounded host tab stalls the game.** `useMoveTokenForward.ts:33-38` awaits framer-motion
   animations, and `requestAnimationFrame` is throttled in hidden tabs — so a move can hang forever
   if the PC user switches tabs. Mitigate with `navigator.wakeLock.request('screen')` on the host
   board, and a `Promise.race` timeout on the network-driven move so a stall can't wedge the turn.
3. **The PWA service worker will cache `/socket.io/`.** `pwa.config.ts:41` sets
   `navigateFallback: '/index.html'` with no denylist for the socket path — reconnection breaks once
   the SW takes over. Add the socket path to `navigateFallbackDenylist` and exclude it from runtime
   caching.
4. **`Play.tsx:27` redirects to `/setup`** when there's no `initData` and no save. The networked
   board route must not go through this component.
5. **`useCleanup` clears every slice on unmount** — correct for the host, wrong for a phone. Solved
   by keeping the phone out of the game slices entirely (section C).
6. **`Game.tsx:41-46` uses `useBlocker` + `confirm()`** for exit. It will fight phone-driven
   navigation and is inconsistent with the redesigned UI; replace with a styled modal.
7. **`Dice.tsx:65-71`'s `isDiceDisabled`** must be re-applied on the host before honouring a remote
   roll, or a phone can roll out of turn.
8. **`vite.config.ts:42` runs `vite-plugin-checker` with TypeScript** — all new code must type-check
   on every build.
9. **Dev-server caveat:** a phone cannot reach the PC's `localhost`, and plain-HTTP LAN access is
   not a secure context, so **shake genuinely cannot be tested without phase 4**.

## Verification

- **Unit (vitest, existing suite in `tests/`):** room-code generation and collision retry; the
  projection function (pure — feed it a `RootState`, assert the shape); `requestTokenMove` reducer;
  the seat-claim/reclaim state machine. Run `pnpm test`, `pnpm type-check`, `pnpm lint`.
- **Two-window end-to-end (no phone):** create a room on window A, `/setup` with 2 humans, open
  `/join/<code>` on window B, claim a seat, tap Roll → the board on A animates and B's dice lands on
  the same number; tap a token twice → the piece moves on A. Verify an out-of-turn roll from B is
  ignored.
- **Reconnect:** reload window B mid-game and confirm it reclaims its seat from the stored
  `seatToken` rather than being asked to pick again. Kill the host tab and confirm B shows
  "waiting for the board".
- **Real device (after phase 4):** `docker compose up`, browse to
  `https://libreludo.<tailnet>.ts.net`, confirm the page is a secure context, that the priming tap
  grants motion permission on iOS, that shaking rolls, that the die settles on the host's number,
  and that music starts on first gesture and stays muted across reloads.
- **Regression:** the existing local hotseat and bot game must still work end to end via
  `/setup` → `/play`, and `pnpm build` must still produce a working static bundle.
