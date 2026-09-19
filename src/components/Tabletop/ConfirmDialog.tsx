import styles from './ConfirmDialog.module.css';

type Props = {
  title: string;
  body: string;
  /** The action that does the thing. Named after it — "Leave room", not "OK". */
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true">
      <div className={styles.dialog}>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={styles.confirm} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
