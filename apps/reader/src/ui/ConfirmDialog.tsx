import type { ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Feedback } from "./Feedback";
import styles from "./ConfirmDialog.module.css";

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy = false,
  destructive = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  destructive?: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog title={title} busy={busy} onClose={onCancel} classes={styles}>
      <p className={styles.text}>{children}</p>
      {error && <Feedback tone="error">{error}</Feedback>}
      <div className={styles.actions}>
        <Button isDisabled={busy} onPress={onCancel}>
          取消
        </Button>
        <Button
          variant={destructive ? "outline" : "primary"}
          {...(destructive && { className: styles.danger })}
          loading={busy}
          onPress={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
