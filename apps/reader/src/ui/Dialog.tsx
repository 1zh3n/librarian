import { Modal } from "@heroui/react/modal";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";

export function Dialog({
  title,
  showTitle = true,
  showClose = false,
  closeLabel,
  busy = false,
  onClose,
  classes,
  headerClassName,
  closeClassName,
  children,
}: {
  title: string;
  showTitle?: boolean;
  showClose?: boolean;
  closeLabel?: string;
  busy?: boolean;
  onClose: () => void;
  classes: { overlay: string; modal: string; dialog: string };
  headerClassName?: string;
  closeClassName?: string;
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
          {(showTitle || showClose) && (
            <div className={headerClassName ?? ""}>
              {showTitle && <Modal.Heading>{title}</Modal.Heading>}
              {showClose && (
                <Button
                  className={closeClassName ?? ""}
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  isDisabled={busy}
                  aria-label={closeLabel ?? `关闭${title}`}
                  onPress={onClose}
                >
                  <Icon name="x" />
                </Button>
              )}
            </div>
          )}
          {children}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
