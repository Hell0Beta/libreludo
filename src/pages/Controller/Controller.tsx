import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, type MetaFunction } from 'react-router';
import clsx from 'clsx';
import SeatPicker from '../../components/SeatPicker/SeatPicker';
import DiceFace from './components/DiceFace/DiceFace';
import PlayerTokenButton from './components/PlayerTokenButton/PlayerTokenButton';
import { useController } from '../../net/useController';
import { readPairingToken } from '../../net/pairing';
import {
  canMoveTokenOnPhone,
  dieOf,
  playerOf,
  rollBlockedReason,
  tokenPlace,
} from '../../net/controllerGuards';
import { playerColours } from '../../game/players/constants';
import styles from './Controller.module.css';

/**
 * The phone: a die, a Roll button, and four big pieces.
 *
 * Everything on this screen is derived from the host's projection. The phone has no dice of its
 * own, no rules, and no board — if the projection has not arrived, this screen says so rather than
 * guessing. That is what stops a phone and the board from ever disagreeing about whose turn it is.
 *
 * Two taps to move, as agreed: the first selects a piece, the second tap on the same piece commits
 * the move. The confirm lands on the piece itself rather than a separate button, so the second tap
 * is where the finger already is.
 */

function LeaveButton({ onLeave }: { onLeave: () => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <button type="button" className={styles.leaveBtn} onClick={() => setConfirming(true)}>
        Leave this game
      </button>
      {confirming && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <h2>Leave this game?</h2>
            <p>
              Your player goes back to the board&rsquo;s list and another phone can take it. The
              game carries on without you.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => setConfirming(false)}
              >
                Stay
              </button>
              <button type="button" className={styles.confirmBtn} onClick={onLeave}>
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function Controller() {
  const { code: routeCode } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();

  /*
   * A phone that arrived from a player's pairing QR still carries the token in its fragment, and it
   * has to keep carrying it: the server drops a companion the moment its socket goes, so a phone
   * that sleeps or loses signal comes back holding nothing. Passing the fragment through means
   * `useController` re-takes the same seat on every reconnect, with no QR and no picker — and a
   * phone that claimed a seat of its own simply has an empty fragment here and reclaims as before.
   */
  const pairingToken = useMemo(() => readPairingToken(hash), [hash]);

  const {
    phase,
    code,
    seat,
    message,
    claiming,
    status,
    seats,
    hostPresent,
    projection,
    claim,
    roll,
    move,
    select,
    leave,
  } = useController({ code: routeCode, pairing: pairingToken });

  const [picked, setPicked] = useState<number | null>(null);

  /*
   * The selection is *derived*, not stored. A piece stays selected only while it is still movable,
   * so when the board moves on — the turn passes, the piece is captured, the die is re-rolled — the
   * ring disappears on the very next frame with no effect and no second render. Keeping it in state
   * and clearing it from an effect would leave one golden frame where the piece looks armed and
   * is not.
   */
  const selected =
    picked !== null && projection && seat && canMoveTokenOnPhone(projection, seat.colour, picked)
      ? picked
      : null;

  /*
   * Tell the board which piece is being considered, so it can light up the matching token.
   *
   * Driven by the *derived* `selected` rather than by the tap handler, so it also fires when the
   * selection is invalidated — the turn passing, the piece being captured — and clears the
   * highlight on the board without any extra bookkeeping. An effect is the right home for this: it
   * is synchronising an external system with state, not computing state.
   */
  useEffect(() => {
    select(selected);
  }, [selected, select]);

  const handleLeave = () => {
    leave();
    void navigate('/');
  };

  const handleTap = (tokenId: number) => {
    // Second tap on the piece already selected: this is the confirmation.
    if (selected === tokenId) {
      move(tokenId);
      setPicked(null);
      return;
    }
    setPicked(tokenId);
  };

  /* ------------------------------------------------------- non-playing states */

  /*
   * `picking` with a pairing token and no message is a pair *in flight*, not an invitation to pick.
   * It happens on every reconnect, because the server drops a companion the moment its socket goes —
   * so without this, a phone that loses signal would flash a list of every player in the room, and
   * a tap could claim one of them for real and leave the pairing token describing a different seat.
   */
  if (phase === 'connecting' || (phase === 'picking' && pairingToken && !message)) {
    return (
      <div className={clsx(styles.screen, 'app-ground')}>
        <p className={styles.notice} role="status">
          Finding the board…
        </p>
        {/*
          A reclaim that times out leaves the phase here on a first load, so this state can carry a
          message. Showing it beats a bare spinner that never resolves and never explains itself.
        */}
        {message && (
          <p className={styles.warning} role="status">
            {message}
          </p>
        )}
      </div>
    );
  }

  if (phase === 'closed' || phase === 'error') {
    return (
      <div className={clsx(styles.screen, 'app-ground')}>
        <div className={styles.card}>
          <h1 className={styles.cardTitle}>
            {phase === 'closed' ? 'Room closed' : 'Cannot reach the board'}
          </h1>
          <p className={styles.notice} role="status">
            {message}
          </p>
          {/*
            One button, not two: the menu now owns code entry, so "enter a code" and "back to the
            menu" are the same destination. Two controls that do the same thing is worse than one
            that says which thing it does.
          */}
          <button type="button" className={styles.primaryBtn} onClick={() => void navigate('/')}>
            Enter a shrine code
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'picking' || !seat) {
    return (
      <div className={clsx(styles.screen, 'app-ground')}>
        <div className={styles.card}>
          {code && <p className={styles.roomCode}>Room {code}</p>}
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
          <LeaveButton onLeave={handleLeave} />
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------------ playing */

  const me = projection ? playerOf(projection, seat.colour) : null;
  const myDie = projection ? dieOf(projection, seat.colour) : null;
  /** The reason the Roll button is unavailable, or null when it is available. */
  const rollBlocked = projection ? rollBlockedReason(projection, seat.colour) : null;
  const tokens = me?.tokens ?? [];

  return (
    <div className={clsx(styles.screen, 'app-ground')}>
      <header className={styles.header}>
        <span
          className={styles.seatChip}
          style={{ '--seat-colour': playerColours[seat.colour] } as React.CSSProperties}
        >
          <span className={styles.dot} aria-hidden="true" />
          {seat.name}
        </span>
        <span className={styles.headerRight}>
          {status === 'reconnecting' && <span className={styles.pill}>Reconnecting…</span>}
          <span className={styles.roomCode}>{code}</span>
        </span>
      </header>

      {!hostPresent && (
        <p className={styles.offline} role="status">
          The board is offline. Rolls and moves will not reach it until the host is back.
        </p>
      )}

      {!projection ? (
        <p className={styles.notice} role="status">
          You&rsquo;re in. Waiting for the board&rsquo;s first update…
        </p>
      ) : (
        <>
          <section className={styles.diceArea}>
            <DiceFace value={myDie?.diceNumber ?? null} rolling={myDie?.isPlaceholderShowing} />
            <button
              type="button"
              className={clsx(styles.rollBtn, rollBlocked !== null && styles.blocked)}
              disabled={rollBlocked !== null}
              onClick={roll}
            >
              {rollBlocked ?? 'Roll the dice'}
            </button>
          </section>

          <section className={styles.pieces}>
            <h2 className={styles.piecesHeading}>Your pieces</h2>
            {tokens.length === 0 ? (
              <p className={styles.notice}>The board has not sent your pieces yet.</p>
            ) : (
              <div className={styles.tokenGrid}>
                {tokens.map((token) => (
                  <PlayerTokenButton
                    key={token.id}
                    colour={seat.colour}
                    tokenId={token.id}
                    place={tokenPlace(token)}
                    isActive={token.isActive}
                    isSelected={selected === token.id}
                    disabled={!canMoveTokenOnPhone(projection, seat.colour, token.id)}
                    onTap={handleTap}
                  />
                ))}
              </div>
            )}
            <p className={styles.hint} aria-live="polite">
              {selected === null
                ? 'Tap a piece to choose it, then tap it again to move.'
                : `Tap piece ${selected + 1} again to move it.`}
            </p>
          </section>
        </>
      )}

      {message && (
        <p className={styles.warning} role="status">
          {message}
        </p>
      )}

      {projection?.isGameEnded && <p className={styles.finished}>Game over</p>}

      <LeaveButton onLeave={handleLeave} />
    </div>
  );
}

export const meta: MetaFunction = () => [{ title: 'LibreLudo - Your dice' }];
