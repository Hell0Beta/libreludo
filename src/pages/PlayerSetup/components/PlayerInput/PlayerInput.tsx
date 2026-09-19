import type { TPlayerColour } from '../../../../types';
import BotIcon from '../../../../assets/icons/bot.svg?react';
import HumanIcon from '../../../../assets/icons/human.svg?react';
import { MAX_PLAYER_NAME_LENGTH, playerColours } from '../../../../game/players/constants';
import 'react-tooltip/dist/react-tooltip.css';
import styles from './PlayerInput.module.css';

type Props = {
  colour: TPlayerColour;
  name: string;
  isBot: boolean;
  onBotStatusChange: (isBot: boolean) => void;
  onNameChange: (name: string) => void;
};

function PlayerInput({ colour, isBot, name, onBotStatusChange, onNameChange }: Props) {
  return (
    <div
      className={styles.playerInput}
      /* The dossier's left edge is carved in the player's colour, so a seat is identifiable at a
         glance without reading the name. */
      style={{ '--seat-colour': playerColours[colour] } as React.CSSProperties}
    >
      <span className={styles.playerInputColourDot} aria-hidden="true" />
      <input
        type="text"
        placeholder="Enter player name"
        className={styles.playerNameInput}
        value={name}
        onChange={(e) => onNameChange(e.target.value.slice(0, MAX_PLAYER_NAME_LENGTH))}
        aria-label={`Name for the ${colour} seat`}
      />
      <button
        className={styles.botStatusBtn}
        data-tooltip-id="bot-status-tooltip"
        data-tooltip-content={isBot ? 'Playing as a bot — tap for a human' : 'Playing as a human — tap for a bot'}
        aria-label="Toggle Ludo bot on or off"
        aria-pressed={isBot}
        onClick={() => onBotStatusChange(!isBot)}
      >
        {isBot ? <BotIcon /> : <HumanIcon />}
        <span className={styles.botStatusLabel}>{isBot ? 'Bot' : 'Human'}</span>
      </button>
    </div>
  );
}

export default PlayerInput;
