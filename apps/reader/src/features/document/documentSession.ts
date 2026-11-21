import { openEditor } from "../../editor/codemirror/adapter";
import { minimalChange } from "../../editor/document";
import { SaveController } from "./saveController";
import type { MarkdownSnapshot, MarkdownWrite } from "./saveController";

export function openMarkdownSession<Snapshot extends MarkdownSnapshot>({
  initial,
  write,
  confirmed,
  readCurrent,
  readOnly,
  ariaLabel,
  documentBody = false,
}: {
  initial: Snapshot;
  write: (write: MarkdownWrite) => Promise<Snapshot>;
  confirmed: (snapshot: Snapshot) => void;
  readCurrent: () => Promise<Snapshot>;
  readOnly: boolean;
  ariaLabel: string;
  documentBody?: boolean;
}) {
  const editor = openEditor(initial.markdown, {
    revision: initial.revision,
    readOnly,
    ariaLabel,
    hideMetadataInPreview: documentBody,
    documentTypography: documentBody,
    onBufferChange(markdown, composing) {
      if (composing) saves.cancelScheduledSave();
      else if (!readOnly) saves.change(markdown);
    },
  });
  const saves = new SaveController(
    initial,
    write,
    (snapshot) => {
      editor.acknowledge(snapshot.markdown, snapshot.revision);
      confirmed(snapshot);
    },
    readCurrent,
    (markdown, confirmedMarkdown, revision) =>
      editor.resetSource(markdown, confirmedMarkdown, revision),
  );

  function sync(snapshot: Snapshot) {
    if (editor.isComposing()) return false;
    return saves.acceptRemote(snapshot, (remote, previous) => {
      const result = editor.applyExternal({
        baseRevision: previous.revision,
        revision: remote.revision,
        edits: minimalChange(previous.markdown, remote.markdown),
      });
      return result === "applied";
    });
  }

  return { editor, saves, sync };
}
