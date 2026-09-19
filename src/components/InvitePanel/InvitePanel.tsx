import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import clsx from 'clsx';
import { playerColours } from '../../game/players/constants';
import type { TSeatSummary } from '../../net/protocol';
import styles from './InvitePanel.module.css';

/**
 * "Sacred Seal" — the QR code, the passcode, and who has joined.
 *
 * Extracted from `Room.tsx` so Match Setup can show it *while* the host is still naming players.
 * That is the point of the whole screen: a phone can scan and take a seat before the game starts,
 * and the host watches it appear in the list below rather than finding out afterwards.
 *
 * The QR payload is `window.location.origin` + `/join/<code>` — the host's own origin. In dev that
 * is `localhost`, over the tailnet it is the `*.ts.net` name, and in both cases it is the URL that
 * actually works for the person scanning it. No server config, and no way for the two to disagree.
 */

type Props = {
  code: string | null;
  seats: TSeatSummary[];
  hostPresent: boolean;
  /** Shown above the QR when the panel is used for a game in progress. */
  compact?: boolean;
};

function seatStatus(seat: TSeatSummary): string {
  if (seat.isBot) return 'Bot';
  if (seat.connected) return 'Connected';
  if (seat.claimed) return 'Reconnecting…';
  return 'Waiting';
}

export default function InvitePanel({ code, seats, hostPresent, compact = false }: Props) {
  const [copied, setCopied] = useState(false);
  const [origin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin));

  const joinUrl = code ? `${origin}/join/${code}` : '';
  const playable = seats.filter((seat) => !seat.isBot);
  const joined = playable.filter((seat) => seat.connected).length;

  const copy = async () => {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the URL is on screen and selectable regardless.
    }
  };

  const share = async () => {
    if (!joinUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'LibreLudo', text: 'Join my Ludo board', url: joinUrl });
      } else {
        await copy();
      }
    } catch {
      // The user dismissed the share sheet. Nothing to report.
    }
  };

  return (
    <section className={clsx(styles.panel, compact && styles.compact)} aria-label="Invite players">
      <header className={styles.head}>
        <h2 className={styles.title}>Invite Companion Spirits</h2>
        <span className={clsx(styles.pill, hostPresent && styles.pillLive)}>
          {hostPresent ? 'Broadcasting' : 'Offline'}
        </span>
      </header>

      <p className={styles.blurb}>
        {playable.length === 0
          ? 'Add players below and their seats will appear here for phones to take.'
          : `${joined} of ${playable.length} seated. Scan to roll your own dice on your phone.`}
      </p>

      {code && (
        <div className={styles.codeRow}>
          <div className={styles.qrWrap}>
            <QRCodeSVG value={joinUrl} size={compact ? 112 : 132} level="M" marginSize={1} />
            <span className={styles.qrCaption}>Sacred Seal</span>
          </div>

          <div className={styles.codeSide}>
            <span className={styles.codeLabel}>Lobby passcode</span>
            <span className={styles.codeValue}>{code}</span>
            <div className={styles.codeActions}>
              <button type="button" className={styles.smallBtn} onClick={() => void copy()}>
                {copied ? 'Copied' : 'Passcode'}
              </button>
              <button type="button" className={styles.smallBtn} onClick={() => void share()}>
                Share
              </button>
            </div>
          </div>
        </div>
      )}

      {playable.length > 0 && (
        <ul className={styles.seats}>
          {playable.map((seat) => (
            <li key={seat.colour} className={styles.seat}>
              <span
                className={styles.dot}
                style={{ '--seat-colour': playerColours[seat.colour] } as React.CSSProperties}
                aria-hidden="true"
              />
              <span className={styles.seatName}>{seat.name}</span>
              <span
                className={clsx(
                  styles.seatState,
                  seat.connected && styles.seatStateLive,
                  seat.claimed && !seat.connected && styles.seatStateAway
                )}
              >
                {seatStatus(seat)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
