import { Link, useNavigate, type MetaFunction } from 'react-router';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useCleanup } from '../../hooks/useCleanup';
import { createHostRoom } from '../../net/useRoom';
import { logError } from '../../utils/logError';
import MenuRow from './components/MenuRow/MenuRow';
import ShrineCodeEntry from './components/ShrineCodeEntry/ShrineCodeEntry';
import ShrineIcon from '../../assets/icons/shrine.svg?react';
import PlayIcon from '../../assets/icons/play.svg?react';
import SlidersIcon from '../../assets/icons/sliders.svg?react';
import ArrowIcon from '../../assets/icons/arrow-right.svg?react';
import LanternIcon from '../../assets/icons/lantern.svg?react';
import GitHubLogo from '../../assets/icons/github-mark-white.svg?react';
import LicenseIcon from '../../assets/icons/license.svg?react';
import ShareIcon from '../../assets/icons/share.svg?react';
import styles from './HomePage.module.css';

/**
 * The start menu.
 *
 * This replaces what was a marketing landing page — hero, emoji feature cards, gradient footer —
 * with the game menu the design calls for. It also absorbs `/lobby`: creating a room and entering a
 * code both live here now, because they are things you do *before* you have a game, and a separate
 * screen for them meant the menu could not answer "how do I start?" on its own.
 *
 * The three rows map onto three real paths, and nothing here is a dead end:
 *   Create Match        -> /setup, no room: the local hotseat / bot game, unchanged
 *   Create Custom Room  -> creates a room, then /setup?room=CODE: the networked host
 *   Shrine Code Entry   -> a phone goes to /join/CODE to pick a seat and control it; a desktop goes
 *                          to /room/CODE to open the board
 */
export default function HomePage() {
  const cleanup = useCleanup();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cleanup();
  }, [cleanup]);

  const handleCreateRoom = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const code = await createHostRoom();
      void navigate(`/setup?room=${code}`);
    } catch (e) {
      logError('HomePage.handleCreateRoom')(e);
      setError(e instanceof Error ? e.message : 'Could not create a room.');
      setCreating(false);
    }
  };

  const share = async () => {
    /*
     * The page's own origin, not a hardcoded domain.
     *
     * This used to read `https://libreludo.org/` — the upstream project's site. On a fork that is
     * simply wrong in both directions: it sends people to a different version of the app than the
     * one they are looking at, and it sends them *away* from whoever is actually running this one.
     * The QR code in `InvitePanel` already derives its URL this way, for the same reason.
     */
    const url = window.location.origin;
    const shareData: ShareData = {
      title: 'LibreLudo · Sanctuary Edition',
      text: 'Play Ludo with friends on LibreLudo — local, or from your phone.',
      url,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(url);
        alert('Link copied to clipboard!');
      }
    } catch (e) {
      logError('HomePage.share')(e);
    }
  };

  return (
    <div className={clsx(styles.page, 'app-ground')}>
      <main className={styles.tablet}>
        {/* Lantern hooks at the tablet's top corners, as in the design. Decorative. */}
        <span className={clsx(styles.lantern, styles.lanternLeft)} aria-hidden="true">
          <LanternIcon />
        </span>
        <span className={clsx(styles.lantern, styles.lanternRight)} aria-hidden="true">
          <LanternIcon />
        </span>

        <header className={styles.wordmark}>
          <span className={styles.emblem} aria-hidden="true">
            <ShrineIcon />
          </span>
          <div className={styles.wordmarkText}>
            <p className={styles.eyebrow}>Spirits of the Ancient Grove</p>
            <h1 className={styles.title}>Sanctuary Ludo</h1>
            <p className={styles.tagline}>Sacred Shrine Tabletop &middot; 2&ndash;4 Spirits</p>
          </div>
          {/*
            The design puts a fictitious realm name here ("Mossy Hollow IV"). Since the app has no
            idea what realm you are in, the slot carries something it does know instead — inventing
            game state that looks real is how a UI starts lying to people.
          */}
          <div className={styles.stamp}>
            <span className={styles.stampLabel}>Open Source</span>
            <span className={styles.stampValue}>v{__LIBRELUDO_VERSION__}</span>
          </div>
        </header>

        <nav className={styles.rows}>
          <MenuRow
            variant="primary"
            icon={<PlayIcon />}
            title="Create Match"
            badge="Quick Play"
            subtitle="Take a corner against wise spirit bots on the sacred board"
            trailing={<ArrowIcon />}
            to="/setup"
          />
          <MenuRow
            icon={<SlidersIcon />}
            title="Create Custom Room"
            subtitle="Host on this device and invite phones to roll their own dice"
            trailing={<ArrowIcon />}
            onClick={() => void handleCreateRoom()}
            busy={creating}
            busyLabel="Opening the shrine…"
          />
          <ShrineCodeEntry
            onJoin={(code) =>
              /*
               * Both devices go to `/join/:code`, which claims a seat and *then* picks a
               * destination from the device — a phone to the controller, a desktop to the table.
               *
               * This used to branch here, sending desktops to `/room/:code`. That is the *host*
               * route: it rehosts or creates the room, so a second desktop entering someone else's
               * code was refused with NOT_HOST. The branch moved into `/join` because the choice
               * depends on the seat that route has just claimed, and this screen has none.
               */
              void navigate(`/join/${code}`)
            }
          />
        </nav>

        {error && (
          <p className={styles.error} role="status">
            {error}
          </p>
        )}

        <Link to="/how-to-play" className={styles.howTo}>
          How to play
        </Link>
      </main>

      <footer className={styles.footer}>
        {/*
          * Two credits and a licence line, and each is doing a different job.
          *
          * The first is the original author's, and it is not decoration: AGPLv3 §4 requires all
          * notices to be kept intact, so a fork that quietly dropped it would be in breach.
          *
          * The second is the notice §5(a) requires of a modified version — "prominent notices
          * stating that you modified it, and giving a relevant date". It is a second *sentence*, not
          * a second name, because a bare extra handle reads as "two authors of one project" rather
          * than "one author changed the other's work", which is the fact the clause is after.
          */}
        <div className={styles.attribution}>
          <p className={styles.credits}>
            Made with{' '}
            <span aria-label="love" role="img">
              ❤️
            </span>{' '}
            by{' '}
            <a href="https://github.com/priyanshurav" target="_blank" rel="noopener noreferrer">
              @priyanshurav
            </a>
          </p>
          <p className={styles.credits}>
            <strong>Sanctuary Edition</strong> — a modified version by{' '}
            <a href="https://github.com/hell0beta" target="_blank" rel="noopener noreferrer">
              @hell0beta
            </a>
            , 2026
          </p>
          <small className={styles.copyright}>
            Copyright &copy; 2025&ndash;{new Date().getFullYear()} Priyanshu Rav &middot;
            Modifications &copy; 2026 Hell0Beta &middot;{' '}
            <a
              href="/LICENSE.txt"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Read the LibreLudo AGPLv3 License"
            >
              AGPLv3
            </a>
          </small>
        </div>
        <div className={styles.footerActions}>
          {/*
            * This source link must point at *this* version, not upstream. AGPLv3 §13 requires a
            * network-interactive modified version to offer its users the Corresponding Source of
            * that version — and a link to someone else's repository does not do that. It also just
            * sends anyone curious to the wrong code.
            */}
          <a
            href="https://github.com/hell0beta/libreludo"
            target="_blank"
            aria-label="View Source on GitHub"
            className={styles.iconBtn}
            rel="noopener noreferrer"
          >
            <GitHubLogo />
          </a>
          <a
            href="/THIRD_PARTY_LICENSES.txt"
            target="_blank"
            aria-label="Third Party Open Source Licenses"
            className={styles.iconBtn}
            rel="noopener noreferrer"
          >
            <LicenseIcon />
          </a>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Share LibreLudo"
            onClick={() => void share()}
          >
            <ShareIcon />
          </button>
        </div>
      </footer>
    </div>
  );
}

export const meta: MetaFunction = () => [{ title: 'LibreLudo | Free and Open Source Ludo Game' }];
