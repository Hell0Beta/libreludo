import dice1 from '../../../../assets/dice/1.svg';
import dice2 from '../../../../assets/dice/2.svg';
import dice3 from '../../../../assets/dice/3.svg';
import dice4 from '../../../../assets/dice/4.svg';
import dice5 from '../../../../assets/dice/5.svg';
import dice6 from '../../../../assets/dice/6.svg';
import dicePlaceholder from '../../../../assets/dice/dice_placeholder.gif';
import { useCallback, useEffect } from 'react';
import { type TPlayerColour } from '../../../../types';
import { useSelector } from 'react-redux';
import type { RootState } from '../../../../state/store';
import { ERRORS } from '../../../../utils/errors';
import { playerColours } from '../../../../game/players/constants';
import { isDiceDisabled } from '../../../../game/guards';
import styles from './Dice.module.css';
import clsx from 'clsx';
import { useBoardActions } from '../../../../net/boardMode';

type Props = {
  colour: TPlayerColour;
  playerName: string;
};

function getDiceImage(diceNumber: number | undefined): string {
  switch (diceNumber) {
    case 1:
      return dice1;
    case 2:
      return dice2;
    case 3:
      return dice3;
    case 4:
      return dice4;
    case 5:
      return dice5;
    case 6:
      return dice6;
    default:
      throw new Error(ERRORS.invalidDiceNumber(diceNumber as never));
  }
}

export default function Dice({ colour, playerName }: Props) {
  const { diceNumber, isPlaceholderShowing } =
    useSelector((state: RootState) => state.dice.dice.find((d) => d.colour === colour)) ?? {};
  const actions = useBoardActions();
  /*
   * The guard is shared with the host bridge so a controller's roll intent is refused under
   * exactly the conditions that disable this button.
   *
   * The second clause is what a viewer adds. `isDiceDisabled` answers "may this colour roll *in the
   * game*", which on a viewer is true for whoever's turn it is — including another player's die
   * sitting on a board it is only watching. `canActFor` asks the different question, "may *this
   * screen* act for them", and on the host it is unconditionally true, so hotseat is unaffected.
   */
  const diceDisabled =
    useSelector((state: RootState) => isDiceDisabled(state, colour)) || !actions.canActFor(colour);

  const handleDiceClick = useCallback(() => {
    if (diceDisabled) return;
    actions.roll(colour);
  }, [actions, colour, diceDisabled]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.key.toLowerCase() !== 'd' || diceDisabled) return;
      handleDiceClick();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleDiceClick, diceDisabled]);
  return (
    <div className={clsx(styles.diceContainer, styles[colour])}>
      <button
        className={clsx(styles.dice, {
          [styles.active]: !diceDisabled,
        })}
        tabIndex={diceDisabled ? -1 : undefined}
        title={!diceDisabled ? 'Roll Dice (Press D)' : undefined}
        disabled={diceDisabled}
        style={{ '--player-colour': playerColours[colour] } as React.CSSProperties}
        type="button"
        onClick={handleDiceClick}
      >
        <img
          src={isPlaceholderShowing ? dicePlaceholder : getDiceImage(diceNumber)}
          alt="Dice image"
          aria-hidden="true"
        />
      </button>
      <span className={styles.playerName}>{playerName}</span>
    </div>
  );
}
