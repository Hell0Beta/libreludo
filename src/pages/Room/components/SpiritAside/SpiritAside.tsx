import clsx from 'clsx';
import { QRCodeSVG } from 'qrcode.react';
import { playerColours } from '../../../../game/players/constants';
import type { TPlayerColour } from '../../../../types';
import type { TSeatSummary } from '../../../../net/protocol';
import styles from './SpiritAside.module.css';

/**
 * The four seats, down the left of the tabletop.
 *
 * Deliberately an aside rather than a strip under the board: four dossiers stacked vertically can
 * each carry a name, a role and a connection state without shrinking, and the board keeps the
 * square it needs. The column collapses under the board below 768px so a tablet or a small laptop
 * still gets a usable board rather than a letterbox.
 *
 * It reads from the *server's* seat summaries, not from the game state — who is connected is a room
 * fact, not a game fact, and the projection the phones get carries no such thing.
 *
 * **One dossier may carry a pairing QR**, and it is the one this device holds. A player at a board
 * can hand a phone the same colour: the phone scans, pairs, and both act for it. The card offering
 * it is rendered from a `pairToken`, which the server sends only to the socket that owns the seat —
 * so a card that shows no QR is a card whose seat is not ours to give away, not a bug. On the
 * host's screen that is player 1, which the host claims like anyone else; on a joiner's it is
 * whichever seat it took.
 *
 * A bot seat never shows one, and that guard is not the same fact as the one above. Ownership and
 * bot-ness are independent: a seat can be claimed and *then* become a bot, and when that happens the
 * owner still holds a perfectly valid token for a player the board now rolls for. See the note on
 * `pairingUrl` below.
 */

type Props = {
  seats: TSeatSummary[];
  /** Whose turn it is, so the active dossier can light up. */
  currentPlayerColour: TPlayerColour;
  isGameEnded: boolean;
  hostPresent: boolean;
  /**
   * The pairing link for the seat this device owns, and which seat that is. Built by
   * `buildPairingUrl`; null whenever this device owns nothing, which is the common case.
   */
  pairing?: { colour: TPlayerColour; url: string } | null;
  className?: string;
};

/**
 * What this seat actually is, in the order that matters to a player looking at it.
 *
 * Deliberately device-neutral. These were written when a controller was always a phone, so a PC
 * that had claimed a seat reported "On a phone" — a sentence that is now simply false, on the screen
 * built to show it. The server cannot tell the two apart and should not guess.
 */
function roleOf(seat: TSeatSummary): string {
  if (seat.isBot) return 'Bot guardian';
  if (seat.connected && seat.paired) return 'Board and phone';
  if (seat.connected) return 'Connected';
  if (seat.claimed) return 'Away';
  return 'Open seat';
}

export default function SpiritAside({
  seats,
  currentPlayerColour,
  isGameEnded,
  hostPresent,
  pairing = null,
  className,
}: Props) {
  const playable = seats.filter((seat) => !seat.isBot);
  const online = playable.filter((seat) => seat.connected).length;

  return (
    <aside className={clsx(styles.aside, className)} aria-label="Players">
      <header className={styles.head}>
        <h2 className={styles.title}>Realm Spirits</h2>
        <span className={styles.online}>
          {online}/{playable.length} online
        </span>
      </header>

      {!hostPresent && (
        <p className={styles.warn} role="status">
          The relay has lost this board. Phones cannot reach it until it reconnects.
        </p>
      )}

      {seats.length === 0 ? (
        <p className={styles.empty}>No seats yet.</p>
      ) : (
        <ul className={styles.list}>
          {seats.map((seat) => {
            const isActive = !isGameEnded && seat.colour === currentPlayerColour;
            /*
             * Never for a bot. A seat can be claimed and *then* become a bot — `declareSeats` keeps
             * an existing seat's tokens when its colour is unchanged and refreshes only the name and
             * `isBot`, so flipping a player in Match Setup leaves the host holding a valid token for
             * a seat the board now rolls for. `hostSeat` is still live, so the guard has to be here:
             * a phone that scanned this QR would pair successfully and then find every roll and move
             * refused (`canMoveToken` and `rollBlockedReason` both reject bots), with no way to tell
             * that from a broken board.
             */
            const pairingUrl =
              pairing?.colour === seat.colour && !seat.isBot ? pairing.url : null;
            return (
              <li
                key={seat.colour}
                className={clsx(styles.dossier, isActive && styles.dossierActive)}
                style={{ '--seat-colour': playerColours[seat.colour] } as React.CSSProperties}
              >
                <div className={styles.row}>
                  <span className={styles.avatar} aria-hidden="true">
                    {seat.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className={styles.text}>
                    <span className={styles.name}>{seat.name}</span>
                    <span className={styles.role}>{roleOf(seat)}</span>
                  </span>
                  <span
                    className={clsx(
                      styles.state,
                      seat.connected && styles.stateLive,
                      seat.claimed && !seat.connected && styles.stateAway
                    )}
                    aria-label={roleOf(seat)}
                  />
                </div>

                {pairingUrl && (
                  <div className={styles.pairing}>
                    <QRCodeSVG value={pairingUrl} size={104} level="M" marginSize={1} />
                    <p className={styles.pairingHint}>
                      Scan to roll and move for {seat.name} from a phone. This board keeps playing
                      too.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {isGameEnded && <p className={styles.finished}>Game over</p>}
    </aside>
  );
}
