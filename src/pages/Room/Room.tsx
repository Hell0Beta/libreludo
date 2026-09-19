import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { useLocation, useNavigate, useParams, type MetaFunction } from 'react-router';
import Board from '../Play/components/Board/Board';
import SpiritAside from './components/SpiritAside/SpiritAside';
import Tabletop, { TabletopNote } from '../../components/Tabletop/Tabletop';
import ConfirmDialog from '../../components/Tabletop/ConfirmDialog';
import { useRoom } from '../../net/useRoom';
import { disconnectSocket } from '../../net/socket';
import { clearHostRoom } from '../../net/hostStorage';
import { useWakeLock } from '../../hooks/useWakeLock';
import { useExecuteBotMove } from '../../hooks/useExecuteBotMove';
import { useRollDice } from '../../hooks/useRollDice';
import { registerNewPlayer, setPlayerSequence } from '../../state/slices/playersSlice';
import { registerDice } from '../../state/slices/diceSlice';
import { setGameStartTime } from '../../state/slices/sessionSlice';
import { buildPairingUrl } from '../../net/pairing';
import { playerSequences } from '../../game/players/constants';
import { playerCountToWord } from '../../game/players/logic';
import type { AppDispatch, RootState } from '../../state/store';
import type { TPlayerInitData } from '../../types';
import { logError } from '../../utils/logError';
import styles from './Room.module.css';

/**
 * The host's tabletop: the board, seated in the courtyard, with the four spirits down the left.
 *
 * This is the machine that owns the game. It renders the board from the real slices — the same ones
 * it is about to project — with no `BoardModeProvider` above it, so a click runs the rules locally.
 * A PC that joined someone else's room renders the same board through `pages/Table`, mirroring
 * frames into those slices instead of computing them. Both use `components/Tabletop` for the frame.
 *
 * It owns three things the local `/play` route does not need to think about — the relay bridge, the
 * seat column, and the fact that the board is now being driven by other people's phones.
 *
 * The invite QR lives on Match Setup now, not here, because by the time you are looking at this
 * screen everyone who is going to join has joined.
 */
export default function Room() {
  const { code: routeCode } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();

  const initData = (location.state as { initData?: TPlayerInitData[] } | null)?.initData;

  const { code, status, seats, hostPresent } = useRoom({ code: routeCode });

  const { isGameEnded, currentPlayerColour, players } = useSelector(
    (state: RootState) => state.players
  );

  /*
   * The QR a phone scans to become a second controller for **player 1** — the host's own seat.
   *
   * The host is a player, so it claims a seat like anyone else (see `useRoom`'s `claimHostSeat`),
   * and that claim is what earns it the `pairToken` this renders. Without the claim there is no
   * token, and a host sitting at the board with a phone in its pocket has no way to hand that phone
   * its own colour — which is the ordinary case, not an exotic one.
   *
   * Null until the claim acks, and null forever if player 1 is a bot: the board rolls for a bot, so
   * there is nothing to pair a phone to.
   */
  const hostSeat = useSelector((state: RootState) => state.room.hostSeat);
  const pairing = useMemo(
    () =>
      hostSeat && code
        ? { colour: hostSeat.colour, url: buildPairingUrl(code, hostSeat.pairToken) }
        : null,
    [hostSeat, code]
  );

  const [showExit, setShowExit] = useState(false);
  const executeBotMove = useExecuteBotMove();
  const rollDice = useRollDice();

  useWakeLock();

  /* ------------------------------------------- register players (no save!) */

  const registeredRef = useRef(false);
  useEffect(() => {
    if (registeredRef.current) return;
    if (!initData || initData.length === 0) return;
    registeredRef.current = true;

    const playerCountWord = playerCountToWord(initData.length);
    const sequence = playerSequences[playerCountWord];

    dispatch(setPlayerSequence({ playerCount: playerCountWord }));
    dispatch(setGameStartTime(Date.now()));

    for (let i = 0; i < initData.length; i++) {
      dispatch(
        registerNewPlayer({
          name: initData[i].name,
          colour: sequence[i],
          isBot: initData[i].isBot,
        })
      );
      dispatch(registerDice(sequence[i]));
    }
  }, [dispatch, initData]);

  /* ---------------------------------------------------------------- bots */

  useEffect(() => {
    if (players.length === 0) return;
    const currentPlayer = store
      .getState()
      .players.players.find((p) => p.colour === currentPlayerColour);
    if (currentPlayer?.isBot) {
      rollDice(currentPlayerColour)
        .then((diceNumber) => executeBotMove(currentPlayerColour, diceNumber))
        .catch(logError('Room.botTurnEffect'));
    }
  }, [currentPlayerColour, executeBotMove, rollDice, store, players.length]);

  /* --------------------------------------------------------------- exit */

  const handleLeave = () => {
    disconnectSocket();
    clearHostRoom();
    void navigate('/');
  };

  const noGame = players.length === 0;

  return (
    <Tabletop
      code={code}
      statusLine={
        status === 'connected'
          ? 'Hosting'
          : status === 'error'
            ? 'Relay unreachable'
            : status === 'reconnecting'
              ? 'Reconnecting to the relay…'
              : 'Connecting…'
      }
      aside={
        <SpiritAside
          seats={seats}
          currentPlayerColour={currentPlayerColour}
          isGameEnded={isGameEnded}
          hostPresent={hostPresent}
          pairing={pairing}
        />
      }
      footer={
        <button type="button" className={styles.leaveBtn} onClick={() => setShowExit(true)}>
          Leave room
        </button>
      }
      dialog={
        showExit ? (
          <ConfirmDialog
            title="Leave this room?"
            body="Phones currently connected will stop receiving moves and the board will shut down."
            cancelLabel="Stay"
            confirmLabel="Leave room"
            onCancel={() => setShowExit(false)}
            onConfirm={handleLeave}
          />
        ) : null
      }
    >
      {noGame ? (
        <TabletopNote>No game loaded. Open a room from the menu to start a board.</TabletopNote>
      ) : (
        <Board />
      )}
    </Tabletop>
  );
}

export const meta: MetaFunction = () => [{ title: 'LibreLudo - Room' }];
