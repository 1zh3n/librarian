import { StateEffect, StateField } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

export const setComposing = StateEffect.define<boolean>();

export const composing = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    return transaction.effects.find((effect) => effect.is(setComposing))?.value ?? value;
  },
});

// The IME may confirm before its first text update. Keep the keymap from
// handling that Enter while allowing the native confirmation default.
function confirmComposition(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
    event.stopPropagation();
  }
}

export const compositionEvents = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLElement;
    endFrame: number | undefined;

    constructor(view: EditorView) {
      this.dom = view.dom;
      this.dom.addEventListener("keydown", confirmComposition, true);
    }

    cancelPendingEnd() {
      if (this.endFrame !== undefined) {
        cancelAnimationFrame(this.endFrame);
        this.endFrame = undefined;
      }
    }

    destroy() {
      this.cancelPendingEnd();
      this.dom.removeEventListener("keydown", confirmComposition, true);
    }
  },
  {
    eventHandlers: {
      compositionstart(_event, view) {
        this.cancelPendingEnd();
        view.dispatch({ effects: setComposing.of(true) });
      },
      compositionend(_event, view) {
        this.cancelPendingEnd();
        this.endFrame = requestAnimationFrame(() => {
          this.endFrame = undefined;
          view.dispatch({ effects: setComposing.of(false) });
        });
      },
    },
  },
);
