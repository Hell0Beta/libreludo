import clsx from 'clsx';
import styles from './DiceFace.module.css';

/**
 * A die face as pips, at phone size.
 *
 * All nine cells are always rendered and the unused ones are left blank, so the die shows the same
 * size and position on every roll. A face that reflowed as the number changed would make the whole
 * screen jump twice a turn, which is exactly the kind of motion that reads as a bug.
 *
 * This is the flat stand-in for the 3D die in phase 5: the number it shows always comes from the
 * host's projection, never from a local roll, so a phone cannot show a number the board disagrees
 * with even before the board has animated to it.
 */

/** Pip positions in a 3×3 grid, indexed from the top-left. */
const PIPS: Record<number, readonly number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

type Props = {
  /** The number to show, or null when there is nothing to show yet. */
  value: number | null;
  /** The host has committed to a roll and the number is not decided yet. */
  rolling?: boolean;
};

export default function DiceFace({ value, rolling = false }: Props) {
  const pips = value !== null && !rolling ? (PIPS[value] ?? []) : [];

  return (
    <div
      className={clsx(styles.die, rolling && styles.rolling, value === null && styles.blank)}
      role="img"
      aria-label={
        rolling ? 'Rolling' : value === null ? 'No roll yet' : `Rolled ${value}`
      }
    >
      {Array.from({ length: 9 }, (_, cell) => (
        <span key={cell} className={clsx(styles.cell, pips.includes(cell) && styles.pip)} />
      ))}
    </div>
  );
}
