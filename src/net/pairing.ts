/**
 * The URL a pairing QR encodes, and the one place that knows its shape.
 *
 * A pairing link is `origin` + `/join/CODE` + the `pairToken` **in the fragment**. Three decisions
 * are packed into that, and none of them is arbitrary:
 *
 *   - **The fragment, not the query string.** A fragment is not sent to the server and not included
 *     in a `Referer`, so the token stays out of relay logs, out of any access log, and out of any
 *     third-party request the page happens to make. A query string would leak it to all three for no
 *     benefit, and put it in the browser's history — which on a shared machine is a real leak.
 *   - **The device's own origin.** In dev that is `localhost`, over the tailnet it is the `*.ts.net`
 *     name. The screen showing the QR is running on the machine the phone needs to reach, so its own
 *     origin is by definition reachable — no server config, and no way for the two to disagree. Same
 *     reasoning as `InvitePanel`'s join URL.
 *   - **`/join/:code`, not a route of its own.** The pairing link and the invite link are the same
 *     screen with one difference: which seat. Sharing the route means a token that no longer works
 *     — the seat was handed to someone else, the room was remade — degrades into the ordinary seat
 *     picker with an explanation, rather than a dead end that names a player the phone cannot have.
 *     `/join` already knows how to say that; a separate route would have had to learn.
 */

export const PAIR_TOKEN_KEY = 'pair';

/**
 * The fragment that carries a pairing token, on its own.
 *
 * Exported because the pairing link is not the only URL that has to keep one: a phone that pairs on
 * `/join/:code` is sent on to `/controller/:code`, and the token has to travel with it. A companion
 * is dropped the moment its socket goes (docs/protocol.md §4, "Companions have no grace period"), so
 * a phone that sleeps and reconnects comes back holding nothing — and the fragment is what lets it
 * take the same seat again without anyone fetching the QR a second time.
 */
export function pairingFragment(pairToken: string): string {
  return `#${PAIR_TOKEN_KEY}=${encodeURIComponent(pairToken)}`;
}

export function buildPairingUrl(code: string, pairToken: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/join/${code}${pairingFragment(pairToken)}`;
}

/**
 * Read the token back out of a pairing link's fragment.
 *
 * `location.hash` arrives with the leading `#`. Parsed by hand rather than with `URLSearchParams`
 * over the whole URL, because the fragment is not a query string and treating it as one invites the
 * bug where a `#` inside the token silently truncates it.
 *
 * Returns null for anything malformed, and the caller treats that as "this is an ordinary invite" —
 * which is the right reading. A fragment we cannot parse names no seat, so there is nothing to pair
 * to and the picker is the screen for it.
 */
export function readPairingToken(hash: string): string | null {
  if (!hash) return null;
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const prefix = `${PAIR_TOKEN_KEY}=`;
  if (!fragment.startsWith(prefix)) return null;

  const raw = fragment.slice(prefix.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A stray `%` makes `decodeURIComponent` throw. Whatever this is, it is not a token.
    return null;
  }
}
