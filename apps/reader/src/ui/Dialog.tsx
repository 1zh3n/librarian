import { Modal } from "@heroui/react/modal";
import type { ReactNode } from "react";

export function Dialog({
  title,
  showTitle = true,
  busy = false,
  onClose,
  classes,
  children,
}: {
  title: string;
  showTitle?: boolean;
  busy?: boolean;
  onClose: () => void;
  classes: { overlay: string; modal: string; dialog: string };
  children: ReactNode;
}) {
  return (
    <Modal.Backdrop
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      className={classes.overlay}
    >
      <Modal.Container className={classes.modal}>
        <Modal.Dialog {...(!showTitle && { "aria-label": title })} className={classes.dialog}>
          {showTitle && <Modal.Heading>{title}</Modal.Heading>}
          {children}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
