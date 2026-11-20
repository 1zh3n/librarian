import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "react-aria-components/Button";
import { openEditor } from "../editor/codemirror/adapter";
import { captureReaderAnchor, restoreReaderAnchor } from "../markdown/anchors";
import type { ScrollAnchor } from "../markdown/anchors";
import { analyzeMarkdown } from "../markdown/analyze";
import { ReaderSurface } from "../markdown/ReaderSurface";
import { spikeFixture } from "./fixture";
import styles from "./SpikePage.module.css";

export function SpikePage() {
  const [editing, setEditing] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [session] = useState(() => openEditor(spikeFixture()));
  const [analysis, setAnalysis] = useState(() => analyzeMarkdown(session.source(), "spike"));
  const viewport = useRef<HTMLDivElement>(null);
  const restoringEditor = useRef(false);
  const pendingAnchor = useRef<ScrollAnchor | undefined>(undefined);

  const mountEditor = useCallback(
    (parent: HTMLDivElement | null) => {
      if (parent) return session.mount(parent);
    },
    [session],
  );

  useLayoutEffect(() => {
    const surface = viewport.current;
    const anchor = pendingAnchor.current;
    if (!surface || !anchor) return;
    if (editing) {
      restoringEditor.current = true;
      let cancelled = false;
      const frame = requestAnimationFrame(() => {
        void session.restoreAnchor(surface, analysis.blocks, anchor).then(() => {
          if (!cancelled) restoringEditor.current = false;
        });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }
    return restoreReaderAnchor(surface, analysis.blocks, anchor);
  }, [editing, analysis, session]);

  function enterEditor() {
    if (viewport.current) {
      pendingAnchor.current = captureReaderAnchor(viewport.current, analysis.blocks);
    }
    setEditing(true);
  }

  function leaveEditor() {
    const next = analyzeMarkdown(session.source(), "spike");
    if (viewport.current && !restoringEditor.current) {
      pendingAnchor.current = session.captureAnchor(viewport.current, next.blocks);
    }
    restoringEditor.current = false;
    setAnalysis(next);
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
          {editing ? <div ref={mountEditor} /> : <ReaderSurface analysis={analysis} />}
        </div>
      </div>
    </main>
  );
}
