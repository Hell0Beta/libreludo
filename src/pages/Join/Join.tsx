import { useEffect, useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams, type MetaFunction } from 'react-router';
import clsx from 'clsx';
import SeatPicker from '../../components/SeatPicker/SeatPicker';
import { useController } from '../../net/useController';
import { pairingFragment, readPairingToken } from '../../net/pairing';
import { isPhoneDevice } from '../../utils/device';
import styles from './Join.module.css';

/**
 * Where the QR code lands, and where a typed code lands: take a seat, then go to the screen that
 * seat's device gets.
 *
 * **Two ways in, one page.** An invite link (`/join/CODE`) shows the seat picker. A *pairing* link
 * (`/join/CODE#pair=…`, from a player's spirit card on someone else's table) names its seat in the
 * fragment and takes it directly, so the picker — which would offer a choice the fragment has
 * already made — is skipped.
 *
 * They share a page because the failure modes want the same screen. A pairing token that no longer
 * works means the seat moved on; the useful thing to show is the ordinary picker with that
 * explained, which this page already is. A separate `/pair/:code` route would have had to grow its
 * own copy of everything below.
 *
 * **The destination is chosen from the device after the seat is taken, not before.** A phone goes to
 * `/controller/:code` — a die and a row of pieces, no board. A desktop goes to `/table/:code` — the
 * real board, mirrored from the host, playable for its own colour and no other. The seat itself is
 * taken identically either way, because a PC holds a seat exactly as a phone does; only what it does
 * with it differs.
 *
 * The seat survives the navigation because the socket is a singleton and nobody tears it down —
 * both destinations re-attach with the stored `seatToken` rather than asking again.
 */
export default function Join() {
  const { code: routeCode } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();

  // Memoised on the hash so the pairing token is a stable value across renders; `useController`
  // reads it through a ref, but the effect below compares it.
  const pairingToken = useMemo(() => readPairingToken(hash), [hash]);

  const { phase, code, message, claiming, seats, hostPresent, claim } = useController({
    code: routeCode,
    pairing: pairingToken,
  });

  useEffect(() => {
    if (phase !== 'seated' || !code) return;

    /*
     * A paired phone carries its fragment onward, because the pairing has to outlive this screen.
     * The controller mounts its own `useController`, and a companion is dropped by the server the
     * moment its socket goes — so without the fragment in the URL, the first time the phone sleeps
     * it comes back to a seat picker for a seat it was already given.
     *
     * A desktop does not: it claimed or paired on its own behalf and holds a `seatToken` it can
     * reclaim with, so there is nothing a fragment would add.
     */
    if (isPhoneDevice()) {
      const target = `/controller/${code}`;
      void navigate(pairingToken ? `${target}${pairingFragment(pairingToken)}` : target, {
        replace: true,
      });
      return;
    }
    void navigate(`/table/${code}`, { replace: true });
  }, [phase, code, navigate, pairingToken]);

  if (phase === 'connecting') {
    return (
      <div className={clsx(styles.join, 'app-ground')}>
        <div className={styles.card}>
          <p className={styles.notice} role="status">
            Finding the board…
          </p>
          {/* See Controller.tsx: a timed-out reclaim lands here with something to say. */}
          {message && (
            <p className={styles.warning} role="status">
              {message}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'closed' || phase === 'error') {
    return (
      <div className={clsx(styles.join, 'app-ground')}>
        <main className={styles.card}>
          <h1 className={styles.title}>
            {phase === 'closed' ? 'Room closed' : 'Cannot reach the board'}
          </h1>
          <p className={styles.notice} role="status">
            {message}
          </p>
          <Link to="/" className={styles.primaryLink}>
            Enter a shrine code
          </Link>
        </main>
      </div>
    );
  }

  /*
   * Seated, or about to be. The effect above is already sending us on, so say so rather than falling
   * through to the picker — which would flash a list of seats the player has just finished choosing
   * from, with their own seat in it.
   *
   * The second case is a pairing in flight. `useController` pairs as soon as the socket is up, which
   * leaves one render at `picking` with the seat list visible for a moment. Suppressing the picker
   * there is not cosmetic: a pairing link names its seat, so offering a choice for a fraction of a
   * second invites a tap that would claim a *different* player and make the fragment a lie.
   *
   * `message` is what distinguishes "pairing now" from "pairing refused" — `pair` clears it on the
   * way in and sets it on the way out, so a refusal falls through to the picker with its reason.
   */
  if (phase === 'seated' || (pairingToken && !message)) {
    return (
      <div className={clsx(styles.join, 'app-ground')}>
        <div className={styles.card}>
          <p className={styles.notice} role="status">
            Taking your seat…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx(styles.join, 'app-ground')}>
      <main className={styles.card}>
        {code && <p className={styles.roomCode}>Room {code}</p>}
        {/*
          * A pairing link that was refused lands here, and the heading says so. "Join the game" over
          * a list of seats would read as if nothing had happened, when in fact the player was handed
          * a specific seat and it was gone — which is worth being told before being asked to choose.
          */}
        <h1 className={styles.title}>{pairingToken ? 'That seat has gone' : 'Join the game'}</h1>
        {message && (
          <p className={styles.warning} role="status">
            {message}
          </p>
        )}
        <SeatPicker
          seats={seats}
          hostPresent={hostPresent}
          busy={claiming}
          onPick={(colour) => void claim(colour)}
        />
        {/* A phone that scanned a stale code, or lost its seat, must be able to get out of here. */}
        <Link to="/" className={styles.back}>
          Back to menu
        </Link>
      </main>
    </div>
  );
}

export const meta: MetaFunction = () => [{ title: 'LibreLudo - Join' }];
