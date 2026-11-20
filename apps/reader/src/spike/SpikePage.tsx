import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "react-aria-components/Button";
import { openEditor } from "../editor/codemirror/adapter";
import { captureReaderAnchor, restoreReaderAnchor } from "../markdown/anchors";
import type { AnchorPlacement } from "../markdown/anchors";
import { analyzeMarkdown } from "../markdown/analyze";
import { ReaderSurface } from "../markdown/ReaderSurface";
import { spikeFixture } from "./fixture";
import styles from "./SpikePage.module.css";

export function SpikePage() {
  const [editing, setEditing] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [session] = useState(() => openEditor(spikeFixture()));
  const [reading, setReading] = useState(() => {
    const source = session.source();
    return { source, analysis: analyzeMarkdown(source, "spike") };
  });
  const viewport = useRef<HTMLDivElement>(null);
  const restoringEditor = useRef(false);
  const pendingAnchor = useRef<AnchorPlacement | undefined>(undefined);

  const mountEditor = useCallback(
    (parent: HTMLDivElement | null) => {
      if (parent) return session.mount(parent);
    },
    [session],
  );

  useLayoutEffect(() => {
    const surface = viewport.current;
    const placement = pendingAnchor.current;
    if (!surface || !placement) return;
    if (editing) {
      restoringEditor.current = true;
      let cancelled = false;
      const frame = requestAnimationFrame(() => {
        const target = session.trackedAnchor() ?? placement;
        const current = session.source();
        const blocks = (
          current === reading.source ? reading.analysis : analyzeMarkdown(current, "spike")
        ).blocks;
        void session.restoreAnchor(surface, blocks, target.anchor, target.sameRevision).then(() => {
          if (!cancelled) restoringEditor.current = false;
        });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    return restoreReaderAnchor(
      surface,
      reading.analysis.blocks,
      placement.anchor,
      placement.sameRevision,
    );
  }, [editing, reading, session]);

  function enterEditor() {
    const anchor = viewport.current
      ? captureReaderAnchor(viewport.current, reading.analysis.blocks)
      : undefined;
    session.trackAnchor(anchor);
    pendingAnchor.current = anchor ? { anchor, sameRevision: true } : undefined;
    setEditing(true);
  }

  function leaveEditor() {
    const source = session.source();
    const next =
      source === reading.source ? reading : { source, analysis: analyzeMarkdown(source, "spike") };
    if (restoringEditor.current) {
      pendingAnchor.current = session.trackedAnchor();
    } else if (viewport.current) {
      const anchor = session.captureAnchor(viewport.current, next.analysis.blocks);
      pendingAnchor.current = anchor ? { anchor, sameRevision: true } : undefined;
    }
    restoringEditor.current = false;
    session.trackAnchor(undefined);
    setReading(next);
    setEditing(false);
  }

  return (
    <main>
      <div className={styles.toolbar}>
        {editing ? (
          <>
            <Button onPress={leaveEditor}>返回阅读</Button>
            <Button
              onPress={() => {
                if (session.setSourceMode(!sourceMode)) {
                  setSourceMode(!sourceMode);
                }
              }}
            >
              {sourceMode ? "即时预览" : "完整源码"}
            </Button>
          </>
        ) : (
          <Button onPress={enterEditor}>编辑正文</Button>
        )}
      </div>
      <div className={styles.viewport} ref={viewport} data-scroll-surface="">
        <div className={styles.canvas}>
          {editing ? <div ref={mountEditor} /> : <ReaderSurface analysis={reading.analysis} />}
        </div>
      </div>
    </main>
  );
}
