import { useCallback, useEffect, useState } from "react";
import type { OutlineSnapshot } from "../../api/client";
import { openMarkdownSession } from "./documentSession";
import type { MarkdownWrite } from "./saveController";
import styles from "./DocumentPage.module.css";

export type OutlineSession = ReturnType<typeof openMarkdownSession<OutlineSnapshot>>;

export function OutlineCanvas({
  snapshot,
  writable,
  visible,
  write,
  confirmed,
  register,
}: {
  snapshot: OutlineSnapshot;
  writable: boolean;
  visible: boolean;
  write: (draft: MarkdownWrite) => Promise<OutlineSnapshot>;
  confirmed: (saved: OutlineSnapshot) => void;
  register: (session: OutlineSession | undefined) => void;
}) {
  const [session] = useState(() =>
    openMarkdownSession({
      initial: snapshot,
      readOnly: !writable,
      ariaLabel: "Markdown 提纲",
      write,
      confirmed,
    }),
  );
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
      if (parent) return session.editor.mount(parent);
    },
    [session],
  );
  if (!visible) return null;
  return <div className={styles.outlineCanvas} ref={mount} />;
}
