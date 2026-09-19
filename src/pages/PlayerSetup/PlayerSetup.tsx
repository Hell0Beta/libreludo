import { useEffect, useMemo, useState } from 'react';
import PlayerInput from './components/PlayerInput/PlayerInput';
import MatchInvite from './components/MatchInvite/MatchInvite';
import { Link, useNavigate, useSearchParams, type MetaFunction } from 'react-router';
import { useDispatch } from 'react-redux';
import clsx from 'clsx';
import type { TPlayerInitData } from '../../types';
import { ToastContainer, toast } from 'react-toastify';
import { useCleanup } from '../../hooks/useCleanup';
import { playerCountToWord } from '../../game/players/logic';
import { playerSequences } from '../../game/players/constants';
import HomeIcon from '../../assets/icons/home.svg?react';
import PlayIcon from '../../assets/icons/play.svg?react';
import ShrineIcon from '../../assets/icons/shrine.svg?react';
import styles from './PlayerSetup.module.css';
import { Tooltip } from 'react-tooltip';
import { validateStoredState } from '../../game/storage/validator';
import {
  deleteSaveFromStorage,
  retrieveSaveFromStorage,
  saveExists,
} from '../../game/storage/storage';
import { SAVE_VERSION } from '../../game/storage/constants';
import { isRoomCode } from '../../net/protocol';
import { clearRoomState } from '../../state/slices/roomSlice';
import { logError } from '../../utils/logError';
import type { AppDispatch } from '../../state/store';

/**
 * Match Setup, and the local hotseat setup, on one screen.
 *
 * The two are the same form — pick how many are playing, name them, mark the bots — so they share a
 * screen rather than being two near-identical ones that drift apart. What differs is the right-hand
 * column: hosting a room (`?room=CODE`) puts the invite panel there, so phones can scan and take
 * seats *while* the host is still typing names. Locally there is nothing to invite and the form
 * takes the full width.
 *
 * The room is created before this screen — the menu's Create Custom Room does it and passes the code
 * — so nothing here waits on the network to become usable.
 */

const toastIds = {
  allBotPlayer: 'all-bot-player',
  playerNameEmpty: 'player-name-empty',
  corruptedSave: 'corrupted-save',
  incompatibleSave: 'incompatible-save',
} as const satisfies Record<string, string>;

const DEFAULT_PLAYER_DATA: TPlayerInitData[] = [
  { name: 'Player 1', isBot: false },
  { name: 'Player 2', isBot: false },
  { name: 'Player 3', isBot: false },
  { name: 'Player 4', isBot: false },
];

const PLAYER_COUNTS = [2, 3, 4] as const;

export default function PlayerSetup() {
  const [playerCount, setPlayerCount] = useState(2);
  const [btnsDisabled, setBtnsDisabled] = useState(false);
  const [playersData, setPlayersData] = useState<TPlayerInitData[]>(DEFAULT_PLAYER_DATA);
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const [searchParams] = useSearchParams();
  // Present only when the menu sent us here to host a networked game. Its absence keeps the local
  // hotseat flow (`/setup` -> `/play`) byte-for-byte unchanged.
  const roomParam = searchParams.get('room');
  const isHosting = isRoomCode(roomParam ?? '');
  const roomCode = isHosting ? (roomParam as string).toUpperCase() : null;
  const cleanup = useCleanup();

  const playerSequence = useMemo(
    () => playerSequences[playerCountToWord(playerCount)],
    [playerCount]
  );

  /*
   * The seats as the relay should hear them, derived from the form. A name the host has cleared
   * would fail the protocol's 1–15 character rule, and the relay would reject the whole seat list
   * with BAD_REQUEST — taking the QR code down with it — so an empty field is announced under a
   * placeholder until it is filled in.
   */
  const seats = useMemo(
    () =>
      playerSequence.map((colour, index) => ({
        colour,
        name: playersData[index].name.trim() || 'Player',
        isBot: playersData[index].isBot,
      })),
    [playerSequence, playersData]
  );

  useEffect(() => {
    cleanup();
  }, [cleanup]);

  const humanCount = seats.filter((seat) => !seat.isBot).length;

  const handlePlayBtnClick = (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
    try {
      e.preventDefault();
      if (btnsDisabled) return;
      setBtnsDisabled(true);

      if (saveExists()) {
        const res = confirm('Start a new game? Your current save will be lost');
        if (!res) return setBtnsDisabled(false);
      }

      deleteSaveFromStorage(); // this is to prevent the old game from getting loaded

      const playerInitData = playersData.slice(0, playerCount);
      const areAllPlayersBot = playerInitData.every((d) => d.isBot);
      const isAnyNameEmpty = playerInitData.some(
        (d) => d.name === '' || [...d.name].every((c) => c === ' ')
      );

      if (isAnyNameEmpty) {
        toast('Player name must not be empty', {
          type: 'error',
          toastId: toastIds.playerNameEmpty,
        });
      } else if (areAllPlayersBot) {
        toast('There must be at least one human player', {
          type: 'error',
          toastId: toastIds.allBotPlayer,
        });
      } else if (roomCode) {
        // Networked: the board route hosts the room and declares these seats to the relay.
        return void navigate(`/room/${roomCode}`, { state: { initData: playerInitData } });
      } else {
        return void navigate('/play', { state: { initData: playerInitData } });
      }
      setBtnsDisabled(false);
    } catch (e) {
      logError('PlayerSetup.handlePlayBtnClick')(e);
      setBtnsDisabled(false);
    }
  };

  const handleLoadLinkClick = (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
    try {
      e.preventDefault();
      if (btnsDisabled) return;
      setBtnsDisabled(true);
      const { success, data } = validateStoredState(retrieveSaveFromStorage());
      if (!success) {
        toast("Save file does not exist or it's corrupted", {
          type: 'error',
          toastId: toastIds.corruptedSave,
        });
      } else if (data.version !== SAVE_VERSION) {
        toast(`Incompatible save: v${data.version} (requires v${SAVE_VERSION})`, {
          type: 'error',
          toastId: toastIds.incompatibleSave,
        });
      } else {
        return void navigate('/play');
      }
      setBtnsDisabled(false);
    } catch (e) {
      logError('PlayerSetup.handleLoadLinkClick')(e);
      setBtnsDisabled(false);
    }
  };

  const handleLeave = () => {
    dispatch(clearRoomState());
    void navigate('/');
  };

  return (
    <div className={clsx(styles.page, 'app-ground')}>
      <div className={styles.banner} aria-hidden="true" />

      <main className={styles.sheet}>
        <header className={styles.head}>
          <div>
            <span className={styles.chip}>
              <ShrineIcon aria-hidden="true" />
              {isHosting ? 'Elder Woods Conclave' : 'Grove Gathering'}
            </span>
            <h1 className={styles.title}>Match Setup</h1>
            <p className={styles.subtitle}>
              Convene spirit travelers &amp; ancient automations around the sacred stone board.
            </p>
          </div>
          <Link to="/" className={styles.homeBtn} aria-label="Back to the menu">
            <HomeIcon />
          </Link>
        </header>

        <div className={clsx(styles.columns, isHosting && styles.columnsHosting)}>
          <section className={styles.seatsColumn}>
            <div className={styles.blockHead}>
              <h2 className={styles.blockTitle}>Quadrant Seats &amp; Players</h2>
              <span className={styles.blockNote}>
                {humanCount} human{humanCount === 1 ? '' : 's'}
              </span>
            </div>
            <p className={styles.blockBlurb}>
              Select active spirits to sit upon the four cardinal stone gates.
            </p>

            <div className={styles.countRow} role="group" aria-label="Number of players">
              {PLAYER_COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={clsx(styles.countBtn, n === playerCount && styles.countBtnActive)}
                  aria-pressed={n === playerCount}
                  onClick={() => setPlayerCount(n)}
                >
                  {n} Players
                </button>
              ))}
            </div>

            <div className={styles.dossiers}>
              {playerSequence.map((colour, index) => (
                <PlayerInput
                  colour={colour}
                  name={playersData[index].name}
                  isBot={playersData[index].isBot}
                  onBotStatusChange={(isBot) =>
                    setPlayersData(playersData.map((d, i) => (i === index ? { ...d, isBot } : d)))
                  }
                  onNameChange={(name) =>
                    setPlayersData(playersData.map((d, i) => (i === index ? { ...d, name } : d)))
                  }
                  key={colour}
                />
              ))}
            </div>
          </section>

          {isHosting && roomCode && (
            <aside className={styles.inviteColumn}>
              <MatchInvite roomCode={roomCode} seats={seats} />
            </aside>
          )}
        </div>
      </main>

      <footer className={styles.footerBar}>
        <div className={styles.readiness}>
          <strong className={styles.readinessTitle}>
            {isHosting ? 'Conclave ready' : 'Grove ready'}
          </strong>
          <span className={styles.readinessNote}>
            {seats.length} quadrant seat{seats.length === 1 ? '' : 's'} prepared for invocation.
          </span>
        </div>

        <div className={styles.footerActions}>
          {isHosting ? (
            <button type="button" className={styles.loadLink} onClick={handleLeave}>
              Close room
            </button>
          ) : (
            <Link
              className={styles.loadLink}
              to="/play"
              title="Load last game"
              onClick={handleLoadLinkClick}
              aria-disabled={btnsDisabled}
            >
              Load last game
            </Link>
          )}
          <Link
            className={styles.beginBtn}
            to={isHosting ? `/room/${roomCode}` : '/play'}
            onClick={handlePlayBtnClick}
            aria-disabled={btnsDisabled}
          >
            <PlayIcon aria-hidden="true" />
            Begin Match
          </Link>
        </div>
      </footer>

      <ToastContainer position="top-center" />
      <Tooltip
        id="bot-status-tooltip"
        className="tooltip"
        openEvents={{ focus: false, mouseover: true }}
        place="bottom-start"
      />
    </div>
  );
}

export const meta: MetaFunction = () => [{ title: 'LibreLudo - Match Setup' }];
