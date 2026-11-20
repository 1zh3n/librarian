import { useState } from "react";
import { Button } from "react-aria-components/Button";
import { openEditor } from "../editor/codemirror/adapter";
import { analyzeMarkdown } from "../markdown/analyze";
import { ReaderSurface } from "../markdown/ReaderSurface";
import { spikeMarkdown } from "./fixture";
import styles from "./SpikePage.module.css";

export function SpikePage() {
  const [editing, setEditing] = useState(false);
  const [session] = useState(() => openEditor(spikeMarkdown));
  const [analysis, setAnalysis] = useState(() => analyzeMarkdown(spikeMarkdown, "spike"));

  function leaveEditor() {
    setAnalysis(analyzeMarkdown(session.source(), "spike"));
    setEditing(false);
  }

  return (
    <main className={styles.canvas}>
      {editing ? (
        <>
          <Button onPress={leaveEditor}>返回阅读</Button>
          <div
            className={styles.source}
            ref={(parent) => {
              if (parent) {
                return session.mount(parent);
              }
            }}
          />
        </>
      ) : (
        <>
          <Button onPress={() => setEditing(true)}>编辑正文</Button>
          <ReaderSurface analysis={analysis} />
        </>
      )}
    </main>
  );
}
