import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./NotificationStack.module.css";

const NotificationTarget = createContext<HTMLElement | null>(null);

export function NotificationStackProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return (
    <NotificationTarget.Provider value={target}>
      {children}
      <section ref={setTarget} className={styles.stack} aria-label="通知" />
    </NotificationTarget.Provider>
  );
}

export function NotificationPortal({ children }: { children: ReactNode }) {
  const target = useContext(NotificationTarget);
  return target ? createPortal(children, target) : null;
}
