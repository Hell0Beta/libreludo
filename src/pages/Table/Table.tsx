/**
 * The board as seen from a chair that does not own the game.
 *
 * This is a PC that joined someone else's room. It is a **viewer**: every pixel it draws came off
 * the wire, and every click it makes is a request rather than a move. Three things make that work,
 * and they only work together:
 *
 *   1. `useController` joins the room and holds the seat — the same hook the phone uses, because a
 *      PC claims a seat exactly as a phone does (docs/protocol.md §11).
 *   2. `useProjectionMirror` pours each frame into `players` and `dice`, so `Board`, `Token` and
 *      `Dice` render here without knowing the game is somewhere else.
 *   3. `BoardModeProvider` puts the board in remote mode, so a click becomes a `game:intent`.
 *
 * Take any one away and the result is subtly wrong rather than obviously broken: without the mirror
 * the board is simply empty; without the mode switch it renders correctly and then plays a *local*
 * game that diverges from the host on the first move and never comes back.
 *
 * The host's own screen is `pages/Room`, which uses none of this and renders the same board from
 * the same slices — the ones it computed itself.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate, useParams, type MetaFunction } from 'react-router';
import Board from '../Play/components/Board/Board';
import SpiritAside from '../Room/components/SpiritAside/SpiritAside';
import Tabletop, { TabletopNote } from '../../components/Tabletop/Tabletop';
import ConfirmDialog from '../../components/Tabletop/ConfirmDialog';
import { useController } from '../../net/useController';
import { useProjectionMirror } from '../../net/useProjectionMirror';
import { useRemoteBoardActions } from '../../net/boardMode';
import BoardModeProvider from '../../net/BoardModeProvider';
import { buildPairingUrl } from '../../net/pairing';
import type { RootState } from '../../state/store';
import styles from './Table.module.css';

export default function Table() {
  const { code: routeCode } = useParams();
  const navigate = useNavigate();
  const [showExit, setShowExit] = useState(false);

  const {
    phase,
    code,
    message,
    seat,
    pairToken,
    seats,
    hostPresent,
    projection,
    roll,
    move,
    leave,
  } = useController({ code: routeCode });

  /*
   * Before the board is rendered, and unconditionally — a hook cannot be called from inside the
   * branch that decides whether there is a game. A null projection is a no-op, so the connecting
   * and picking phases cost nothing.
   */
  useProjectionMirror(projection);

  const actions = useRemoteBoardActions({
    seatColour: seat?.colour ?? null,
    roll,
    move,
  });

  /*
   * The QR a phone scans to become a second controller for *this* seat. Built from the token the
   * server sent to this socket alone, and only once both halves are known — the seat colour says
   * which dossier to put it in, the token says what it says.
   */
  const pairing = useMemo(
    () => (seat && pairToken ? { colour: seat.colour, url: buildPairingUrl(code ?? '', pairToken) } : null),
    [seat, pairToken, code]
  );

  const { currentPlayerColour, isGameEnded, players } = useSelector(
    (state: RootState) => state.players
  );

  /**
   * A joiner with no seat is not at a table yet. Sending them to `/join/:code` rather than growing a
   * second seat picker here keeps one screen where a seat is chosen — and `/join` sends a desktop
   * straight back once it has one, so this settles rather than looping.
   *
   * In an effect, not in the render body: navigating while rendering is a side effect React may
   * repeat or discard, and this one fires on a phase the player has not caused.
   */
  useEffect(() => {
    if (phase === 'picking' && code) void navigate(`/join/${code}`, { replace: true });
  }, [phase, code, navigate]);

  const seated = phase === 'seated';

  const handleLeave = () => {
    leave();
    void navigate('/');
  };

  return (
    <BoardModeProvider actions={actions}>
      <Tabletop
        code={code}
        statusLine={
          !seated
            ? 'Not at this table'
            : hostPresent
              ? 'Watching the board'
              : 'The relay has lost this board'
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
          seated ? (
            /* Leaving clears the stored seat token, which is the only thing that can reclaim it.
               A stray click would cost the player their chair for the rest of the game. */
            <button type="button" className={styles.leaveBtn} onClick={() => setShowExit(true)}>
              Leave table
            </button>
          ) : (
            code && (
              <button
                type="button"
                className={styles.leaveBtn}
                onClick={() => void navigate(`/join/${code}`, { replace: true })}
              >
                Choose a player
              </button>
            )
          )
        }
        dialog={
          showExit ? (
            <ConfirmDialog
              title="Leave the table?"
              body="This gives up your player. To get it back you will have to pick it again, if the host has not started without you."
              cancelLabel="Stay"
              confirmLabel="Leave table"
              onCancel={() => setShowExit(false)}
              onConfirm={handleLeave}
            />
          ) : null
        }
      >
        {!seated ? (
          <TabletopNote>
            {message ??
              'Connecting to the board… if this does not change, the room may have been closed.'}
          </TabletopNote>
        ) : players.length === 0 ? (
          /* Seated, but the host has not started a game. The next frame will say when it does. */
          <TabletopNote>Waiting for the board to start…</TabletopNote>
        ) : (
          <Board />
        )}
      </Tabletop>
    </BoardModeProvider>
  );
}

export const meta: MetaFunction = () => [{ title: 'LibreLudo - Table' }];
