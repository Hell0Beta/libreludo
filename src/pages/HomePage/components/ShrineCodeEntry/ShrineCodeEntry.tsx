import { useRef, useState } from 'react';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isRoomCode } from '../../../../net/protocol';
import KeyIcon from '../../../../assets/icons/key.svg?react';
import styles from './ShrineCodeEntry.module.css';

/**
 * The room-code row of the start menu: four carved cells and a Join slab.
 *
 * The cell behaviour — sanitising to the wire alphabet, spreading a pasted code across the
 * remaining cells, and stepping with arrows and backspace — is the logic that used to live in
 * `src/pages/Lobby/Lobby.tsx`. It moved here when `/lobby` was folded into the menu rather than
 * being rewritten, because the details (which keys step, where a paste lands) were worked out once
 * and are easy to get subtly wrong a second time.
 */

const ALPHABET = new Set(ROOM_CODE_ALPHABET.split(''));

/** Drop anything that cannot appear in a code, and upper-case the rest. */
function sanitize(value: string): string {
  return [...value.toUpperCase()].filter((char) => ALPHABET.has(char)).join('');
}

type Props = {
  onJoin: (code: string) => void;
};

export default function ShrineCodeEntry({ onJoin }: Props) {
  const [cells, setCells] = useState<string[]>(() =>
    Array.from({ length: ROOM_CODE_LENGTH }, () => '')
  );
  const cellRefs = useRef<Array<HTMLInputElement | null>>([]);

  const code = cells.join('');
  const isComplete = isRoomCode(code);

  const setCell = (index: number, value: string) => {
    setCells((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const focusCell = (index: number) => {
    const target = Math.max(0, Math.min(ROOM_CODE_LENGTH - 1, index));
    cellRefs.current[target]?.focus();
    cellRefs.current[target]?.select();
  };

  const handleCellChange = (index: number, rawValue: string) => {
    const value = sanitize(rawValue);
    if (value.length === 0) {
      setCell(index, '');
      return;
    }
    if (value.length > 1) {
      // A pasted code lands here: spread it across the remaining cells.
      setCells((prev) => {
        const next = [...prev];
        for (let i = 0; i < value.length && index + i < ROOM_CODE_LENGTH; i++) {
          next[index + i] = value[i];
        }
        return next;
      });
      focusCell(index + value.length);
      return;
    }
    setCell(index, value);
    if (index < ROOM_CODE_LENGTH - 1) focusCell(index + 1);
  };

  const handleCellKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && cells[index] === '' && index > 0) {
      e.preventDefault();
      setCell(index - 1, '');
      focusCell(index - 1);
    }
    if (e.key === 'ArrowLeft') focusCell(index - 1);
    if (e.key === 'ArrowRight') focusCell(index + 1);
    if (e.key === 'Enter' && isComplete) onJoin(code);
  };

  return (
    <div className={styles.entry}>
      <span className={styles.icon} aria-hidden="true">
        <KeyIcon />
      </span>

      <div className={styles.body}>
        <span className={styles.label}>Shrine code entry</span>
        <div className={styles.cells} role="group" aria-label="Room code">
          {cells.map((char, index) => (
            <input
              key={index}
              ref={(node) => {
                cellRefs.current[index] = node;
              }}
              className={styles.cell}
              value={char}
              onChange={(e) => handleCellChange(index, e.target.value)}
              onKeyDown={(e) => handleCellKeyDown(index, e)}
              onFocus={(e) => e.target.select()}
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={ROOM_CODE_LENGTH}
              aria-label={`Room code character ${index + 1}`}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        className={styles.join}
        onClick={() => onJoin(code)}
        disabled={!isComplete}
      >
        Join Shrine
      </button>
    </div>
  );
}
