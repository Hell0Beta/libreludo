import clsx from 'clsx';
import { playerColours } from '../../../../game/players/constants';
import { TOKEN_PLACE_LABEL, type TTokenPlace } from '../../../../net/controllerGuards';
import type { TPlayerColour } from '../../../../types';
import styles from './PlayerTokenButton.module.css';

/**
 * One piece, as a big target for a thumb.
 *
 * Deliberately not a miniature of the board. Four identical pawns on a 9×9 grid are unreadable at
 * phone size, and worse, the player colour is the *only* thing distinguishing one piece from
 * another on the board. So each button carries the piece number and where it is in words, and
 * identification never rests on colour at all — which also keeps it working for anyone who cannot
 * separate the red and green (docs/phone-controllers.md §F).
 *
 * The first tap selects; the second tap on the same piece moves it. The confirm affordance is the
 * button itself changing state, not a separate button, so the two taps land in the same place.
 */

type Props = {
  colour: TPlayerColour;
  tokenId: number;
  place: TTokenPlace;
  /** The host has said this piece can move right now. */
  isActive: boolean;
  isSelected: boolean;
  disabled: boolean;
  onTap: (tokenId: number) => void;
};

export default function PlayerTokenButton({
  colour,
  tokenId,
  place,
  isActive,
  isSelected,
  disabled,
  onTap,
}: Props) {
  return (
    <button
      type="button"
      className={clsx(styles.token, isActive && styles.active, isSelected && styles.selected)}
      style={{ '--token-colour': playerColours[colour] } as React.CSSProperties}
      disabled={disabled}
      aria-pressed={isSelected}
      aria-label={`Piece ${tokenId + 1}, ${TOKEN_PLACE_LABEL[place]}${
        isActive ? ', can move now' : ''
      }`}
      onClick={() => onTap(tokenId)}
    >
      <span className={styles.number}>{tokenId + 1}</span>
      <span className={styles.place}>{TOKEN_PLACE_LABEL[place]}</span>
    </button>
  );
}
