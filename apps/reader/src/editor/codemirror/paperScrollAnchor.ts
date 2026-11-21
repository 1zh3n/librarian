import { EditorView } from "@codemirror/view";

export interface PaperAnchor {
  viewport: HTMLElement;
  at: number;
  screenTop: number;
  glyphSide?: 1 | -1;
  keepCaretVisible?: boolean;
}

// CodeMirror can refine off-screen block heights after mounting or unfolding
// the writing line. Preserve the reading position through those measurements.
export function paperScrollAnchor() {
  let held: { anchor: PaperAnchor; input: AbortController; scrollTop: number } | undefined;

  function release() {
    held?.input.abort();
    held = undefined;
  }

  function align(view: EditorView) {
    const current = held;
    if (!current) return;
    const { at, glyphSide, screenTop, viewport } = current.anchor;
    const glyph = glyphSide && view.coordsAtPos(at, glyphSide);
    const top = glyph?.top ?? view.documentTop + view.lineBlockAt(at).top;
    let delta = top - screenTop;
    if (current.anchor.keepCaretVisible) {
      const caret = view.coordsAtPos(view.state.selection.main.head);
      if (caret) delta = Math.max(delta, caret.bottom - viewport.getBoundingClientRect().bottom);
    }
    if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
    current.scrollTop = viewport.scrollTop;
  }

  return {
    release,
    hold(view: EditorView, anchor: PaperAnchor) {
      release();
      const input = new AbortController();
      const { viewport } = anchor;
      held = { anchor, input, scrollTop: viewport.scrollTop };
      const options = { capture: true, passive: true, signal: input.signal };
      for (const event of [
        "wheel",
        "touchstart",
        "pointerdown",
        "keydown",
        "beforeinput",
        "focusout",
      ])
        viewport.addEventListener(event, release, options);
      viewport.addEventListener(
        "scroll",
        () => {
          if (held && held.scrollTop !== viewport.scrollTop) release();
        },
        { signal: input.signal },
      );
      align(view);
    },
    extension: EditorView.updateListener.of((update) => {
      if (!held) return;
      if (update.docChanged || update.selectionSet) release();
      else if (update.geometryChanged && !update.transactions.length) align(update.view);
    }),
  };
}
