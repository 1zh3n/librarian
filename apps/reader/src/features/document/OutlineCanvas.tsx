import { useCallback, useEffect, useRef, useState } from "react";
import type { OutlineSnapshot } from "../../api/client";
import { openMarkdownSession } from "./documentSession";
import type { MarkdownWrite } from "./saveController";
import styles from "./DocumentPage.module.css";

export type OutlineSession = ReturnType<typeof openMarkdownSession<OutlineSnapshot>>;

export function OutlineCanvas({
  snapshot,
  writable,
  visible,
  focusOnCreate,
  write,
  confirmed,
  readCurrent,
  register,
}: {
  snapshot: OutlineSnapshot;
  writable: boolean;
  visible: boolean;
  focusOnCreate: boolean;
  write: (draft: MarkdownWrite) => Promise<OutlineSnapshot>;
  confirmed: (saved: OutlineSnapshot) => void;
  readCurrent: () => Promise<OutlineSnapshot>;
  register: (session: OutlineSession | undefined) => void;
}) {
  const [session] = useState(() =>
    openMarkdownSession({
      initial: snapshot,
      readOnly: !writable,
      ariaLabel: "Markdown 提纲",
      write,
      confirmed,
      readCurrent,
    }),
  );
  const [focusOnFirstMount] = useState(focusOnCreate);
  const mounted = useRef(false);
  useEffect(() => {
    register(session);
    return () => {
      register(undefined);
      session.saves.cancelScheduledSave();
    };
  }, [register, session]);
  useEffect(() => {
    session.sync(snapshot);
  }, [session, snapshot]);

  const mount = useCallback(
    (parent: HTMLDivElement | null) => {
      if (!parent) return;
      const clear = session.editor.mount(parent, focusOnFirstMount && !mounted.current);
      mounted.current = true;
      return clear;
    },
    [focusOnFirstMount, session],
  );
  if (!visible) return null;
  return <div className={styles.outlineCanvas} ref={mount} />;
}
