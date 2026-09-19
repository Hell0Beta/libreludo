import BoardImage from '../../../../assets/board.svg?react';
import Token from '../Token/Token';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../../state/store';
import { useCallback, useState } from 'react';
import { NUMBER_OF_BLOCKS_IN_ONE_ROW, resizeBoard } from '../../../../state/slices/boardSlice';
import { ERRORS } from '../../../../utils/errors';
import Dice from '../Dice/Dice';
import type { TCoordinate } from '../../../../types';
import { getGloballyUniqueTokenId, tokensWithCoord } from '../../../../game/tokens/logic';
import styles from './Board.module.css';
import { useResizeObserver } from '../../../../hooks/useResizeObserver';
import { useBoardActions } from '../../../../net/boardMode';

export default function Board() {
  const { players, currentPlayerColour } = useSelector((state: RootState) => state.players);
  const { boardTileSize, boardSideLength } = useSelector((state: RootState) => state.board);
  const { dice } = useSelector((state: RootState) => state.dice);
  const [boardNode, setBoardNode] = useState<HTMLDivElement | null>(null);
  const dispatch = useDispatch();
  /*
   * Local on the host's own board, remote on a PC that joined someone else's room — see
   * `src/net/boardMode.tsx`. The only difference here is that the click below becomes an intent
   * instead of a dispatch; everything else about resolving a tap to a piece is shared.
   */
  const actions = useBoardActions();

  const onBoardResize = useCallback(() => {
    if (!boardNode) throw new Error(ERRORS.boardDoesNotExist());
    const boardSideLength = boardNode.getBoundingClientRect().width;
    dispatch(resizeBoard(boardSideLength));
  }, [boardNode, dispatch]);

  useResizeObserver(boardNode, onBoardResize);

  const handleBoardClick: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (players.find((p) => p.colour === currentPlayerColour)?.isBot) return;
    // A viewer watching someone else's turn has no business resolving a tap into a move, and
    // `actions.move` would discard it anyway. Bailing here keeps the intent off the wire entirely.
    if (!actions.canActFor(currentPlayerColour)) return;
    if (!boardNode) throw new Error(ERRORS.boardDoesNotExist());
    const { top, left } = boardNode.getBoundingClientRect();
    const boardX = e.clientX - left;
    const boardY = e.clientY - top;
    const tileStartCoords = Array(NUMBER_OF_BLOCKS_IN_ONE_ROW)
      .fill(null)
      .map((_, i) => (i + 1) * boardTileSize);

    if (boardX > boardSideLength || boardY > boardSideLength || boardX < 0 || boardY < 0) return;

    const coordX = tileStartCoords.findIndex((v) => boardX < v);
    const coordY = tileStartCoords.findIndex((v) => boardY < v);

    const coords: TCoordinate = { x: coordX, y: coordY };

    const tokenToMove = tokensWithCoord(coords, players).filter(
      (t) => t.colour === currentPlayerColour
    )[0];

    if (!tokenToMove || tokenToMove.isLocked) return;

    actions.move(tokenToMove.colour, tokenToMove.id);
  };

  return (
    <div
      className={styles.board}
      ref={setBoardNode}
      onClick={handleBoardClick}
      /*
       * `--board-tile-size` is declared here, on the board's own root, because everything the board
       * draws is sized from it — the dice, the tokens' name spacing, the finish screen. It used to
       * be set by `Game.tsx` on its wrapper, which meant any route that rendered `<Board />`
       * directly got an undefined variable: `calc(var(--board-tile-size) * n)` is invalid, so the
       * height/width declarations were dropped and the dice fell back to the source image's
       * intrinsic size. `/room/:code` renders Board bare, so its dice were enormous.
       *
       * Owning it here makes the board self-sufficient on any route. `Game.tsx` still sets it too,
       * for its own exit button; both read the same `boardTileSize`, so they cannot disagree.
       */
      style={{ '--board-tile-size': `${boardTileSize}px` } as React.CSSProperties}
    >
      {players.map((p) =>
        p.tokens.map((t) => (
          <Token colour={t.colour} id={t.id} key={getGloballyUniqueTokenId(t.colour, t.id)} />
        ))
      )}
      {dice.map((d) => (
        <Dice
          colour={d.colour}
          playerName={players.find((p) => p.colour === d.colour)?.name as string}
          key={d.colour}
        />
      ))}
      <BoardImage className={styles.boardImage} aria-hidden="true" />
    </div>
  );
}
