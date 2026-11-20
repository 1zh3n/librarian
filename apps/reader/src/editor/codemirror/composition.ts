import { StateEffect, StateField } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";

export const setComposing = StateEffect.define<boolean>();

export const composing = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    return transaction.effects.find((effect) => effect.is(setComposing))?.value ?? value;
  },
});

export const compositionEvents = ViewPlugin.fromClass(
  class {
    endFrame: number | undefined;

    destroy() {
      if (this.endFrame !== undefined) {
        cancelAnimationFrame(this.endFrame);
      }
    }
  },
  {
    eventHandlers: {
      compositionstart(_event, view) {
        this.destroy();
        this.endFrame = undefined;
        view.dispatch({ effects: setComposing.of(true) });
      },
      compositionend(_event, view) {
        this.destroy();
        this.endFrame = requestAnimationFrame(() => {
          this.endFrame = undefined;
          view.dispatch({ effects: setComposing.of(false) });
        });
      },
    },
  },
);
