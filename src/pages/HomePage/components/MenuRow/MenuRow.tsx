import type { ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import styles from './MenuRow.module.css';

/**
 * One row of the start menu: a carved slab you press.
 *
 * Two variants, straight from the design. `primary` is the moss-filled slab that carries the
 * action the player almost always wants; `plain` is the parchment slab for everything else. Both
 * sit on a thicker bottom edge so they read as objects with weight rather than filled rectangles —
 * pressing one compresses it into that edge.
 *
 * Renders as a `Link` when given `to` and a `button` otherwise, so the two paths behave correctly
 * for keyboard and middle-click without either looking different.
 */

type Props = {
  icon: ReactNode;
  title: string;
  subtitle: string;
  /** Small chip after the title, e.g. "QUICK PLAY". */
  badge?: string;
  /** Trailing glyph, usually an arrow. */
  trailing?: ReactNode;
  /** Navigation target. Mutually exclusive with `onClick`. */
  to?: string;
  onClick?: () => void;
  variant?: 'primary' | 'plain';
  /** Shows the busy label and blocks further presses. */
  busy?: boolean;
  busyLabel?: string;
};

export default function MenuRow({
  icon,
  title,
  subtitle,
  badge,
  trailing,
  to,
  onClick,
  variant = 'plain',
  busy = false,
  busyLabel = 'Working…',
}: Props) {
  const className = clsx(styles.row, styles[variant], busy && styles.busy);

  const body = (
    <>
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.text}>
        <span className={styles.titleLine}>
          <span className={styles.title}>{title}</span>
          {badge && <span className={styles.badge}>{badge}</span>}
        </span>
        <span className={styles.subtitle}>{busy ? busyLabel : subtitle}</span>
      </span>
      {trailing && (
        <span className={styles.trailing} aria-hidden="true">
          {trailing}
        </span>
      )}
    </>
  );

  if (to) {
    return (
      <Link className={className} to={to} aria-busy={busy}>
        {body}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick} disabled={busy}>
      {body}
    </button>
  );
}
