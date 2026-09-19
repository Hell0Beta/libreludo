import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useSelector } from 'react-redux';
import ShrineIcon from '../../assets/icons/shrine.svg?react';
import type { RootState } from '../../state/store';
import styles from './Tabletop.module.css';

/**
 * The frame every table shares: a crowned header, a column of spirits down the left, a parchment
 * sheet holding the board, and a footer under it.
 *
 * It renders the *frame* and nothing else. Which seats are in the column, what is drawn on the
 * sheet and what the footer offers all differ between a host and a joiner, so they arrive as props —
 * but the sheet, the column widths and the breakpoints are shared, which is the point.
 *
 * The board itself is passed through as `children` rather than rendered here, because whether there
 * is a board at all is a per-page question: a host with no game loaded has something to say about
 * it that a joiner waiting on a first frame does not.
 */

type Props = {
  /** Room code, shown in the header. Null while a host is still creating one. */
  code: string | null;
  /** Under the title — "Hosting", "Reconnecting to the relay…", and so on. */
  statusLine: string;
  /** The spirit column. */
  aside: ReactNode;
  /** What sits on the parchment sheet: a board, or a note about why there isn't one. */
  children: ReactNode;
  footer?: ReactNode;
  /** Rendered outside the frame — a fixed-position dialog, e.g. the leave confirm. */
  dialog?: ReactNode;
};

export default function Tabletop({ code, statusLine, aside, children, footer, dialog }: Props) {
  /*
   * The sheet reserves vertical space proportional to a board tile so the dice, which are drawn
   * outside the board, do not spill out of it. `Board` declares the same variable on its own root
   * for its own children; this declaration is for the padding, which is the sheet's business.
   */
  const boardTileSize = useSelector((state: RootState) => state.board.boardTileSize);

  return (
    <div className={clsx(styles.tabletop, 'app-ground')}>
      <header className={styles.head}>
        <span className={styles.eyebrow}>
          <ShrineIcon aria-hidden="true" />
          {code ? `Sacred Realm · ${code}` : 'Sacred Realm'}
        </span>
        <h1 className={styles.title}>Sanctuary Ludo</h1>
        <p className={styles.statusLine} role="status">
          {statusLine}
        </p>
      </header>

      <div className={styles.layout}>
        {/*
          * Wrapped rather than cloned: the sticky positioning and the docked-bar breakpoint below
          * are the frame's business, and a page that had to remember to pass the right `className`
          * into its aside would be a page that could get the layout wrong.
          */}
        <div className={styles.aside}>{aside}</div>

        <div
          className={styles.boardFrame}
          style={{ '--board-tile-size': `${boardTileSize}px` } as React.CSSProperties}
        >
          {children}
        </div>
      </div>

      {footer && <footer className={styles.foot}>{footer}</footer>}

      {dialog}
    </div>
  );
}

/**
 * The placeholder shown on the sheet when there is nothing to draw on it yet. Exported so both
 * tables say it in the same voice rather than each inventing a sentence.
 */
export function TabletopNote({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}
