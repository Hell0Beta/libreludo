import { playerColours } from '../../game/players/constants';
import type { TPlayerColour } from '../../types';
import type { TSeatSummary } from '../../net/protocol';
import styles from './SeatPicker.module.css';

/**
 * "Which player are you?" — the picker a phone sees after scanning the board's QR code.
 *
 * The seats come from the host's own `/setup` run, so the names here are the names already on the
 * board. Nothing is typed twice and nothing can drift (docs/phone-controllers.md §D).
 *
 * A seat is only offered when the server will actually accept the claim. A seat that already has a
 * `seatToken` is refused with `SEAT_TAKEN` even if its owner is offline — that claim is what keeps a
 * phone's seat alive across a lock screen — so a disconnected seat is shown as taken rather than as
 * an inviting tile that fails on tap.
 */

type Props = {
  seats: TSeatSummary[];
  hostPresent: boolean;
  busy: boolean;
  onPick: (colour: TPlayerColour) => void;
};

function seatState(seat: TSeatSummary): { label: string; available: boolean } {
  if (seat.isBot) return { label: 'Bot', available: false };
  if (seat.claimed) {
    return seat.connected
      ? { label: 'Taken', available: false }
      : { label: 'Reconnecting…', available: false };
  }
  return { label: 'Free', available: true };
}

export default function SeatPicker({ seats, hostPresent, busy, onPick }: Props) {
  const playable = seats.filter((seat) => !seat.isBot);

  /*
   * Two different kinds of empty, and they need different words. An all-bot game is reachable —
   * `/setup` lets the host mark every player as a bot — and telling that host "the board has not
   * started a game yet" would be simply wrong.
   */
  if (playable.length === 0) {
    return (
      <div className={styles.picker}>
        <p className={styles.empty}>
          {seats.length === 0
            ? 'The board has not started a game yet. Wait for the host to set up the players, then this list will fill in.'
            : 'Every player in this game is a bot, so there is nothing here for a phone to control.'}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.picker}>
      <h2 className={styles.heading}>Which player are you?</h2>
      {!hostPresent && (
        <p className={styles.offline}>
          The board is offline. You can still pick a player; you will join when it comes back.
        </p>
      )}
      <ul className={styles.tiles}>
        {playable.map((seat) => {
          const state = seatState(seat);
          return (
            <li key={seat.colour}>
              <button
                type="button"
                className={styles.tile}
                style={{ '--seat-colour': playerColours[seat.colour] } as React.CSSProperties}
                disabled={busy || !state.available}
                onClick={() => onPick(seat.colour)}
              >
                <span className={styles.swatch} aria-hidden="true" />
                <span className={styles.name}>{seat.name}</span>
                <span className={styles.state}>{state.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
