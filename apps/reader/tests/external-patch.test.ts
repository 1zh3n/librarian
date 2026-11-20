import { expect, test, vi } from "vitest";
import { openEditor } from "../src/editor/codemirror/adapter";

const base = "甲\r\n中文📝\n乙";
const prepend = {
  baseRevision: "r1",
  revision: "r2",
  edits: [{ from: 0, to: 0, insert: "新\r\n" }],
};

function mountEditor(session: ReturnType<typeof openEditor>) {
  const host = document.createElement("div");
  document.body.append(host);
  const unmount = session.mount(host);
  const editor = host.querySelector<HTMLElement>("[contenteditable]")!;
  return {
    editor,
    dispose: () => {
      unmount();
      host.remove();
    },
  };
}

test("maps_clean_selection_after_remote_patch", () => {
  const session = openEditor(base, { revision: "r1", selection: { anchor: 7, head: 3 } });
  expect(session.applyExternal(prepend)).toBe("applied");
  expect(session.source()).toBe("新\r\n甲\r\n中文📝\n乙");
  expect(session.selection()).toEqual({ anchor: 10, head: 6 });
  expect(session.applyExternal(prepend)).toBe("conflict");
});

test("defers_remote_patch_during_composition", async () => {
  const settled = vi.fn();
  const session = openEditor(base, { revision: "r1", onDeferredExternalResult: settled });
  const { editor, dispose } = mountEditor(session);
  try {
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(session.applyExternal(prepend)).toBe("deferred");
    expect(session.source()).toBe(base);
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith("r2", "applied"));
    expect(session.source()).toBe("新\r\n" + base);

    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const second = { ...prepend, baseRevision: "r2", revision: "r3" };
    expect(session.applyExternal(second)).toBe("deferred");
    session.applyChanges([{ from: 0, to: 0, insert: "候选" }]);
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith("r3", "conflict"));
    expect(session.source()).toBe("候选新\r\n" + base);
  } finally {
    dispose();
  }
});

test("preserves_dirty_text_on_conflict", () => {
  const session = openEditor(base, { revision: "r1" });
  session.applyChanges([{ from: 0, to: 1, insert: "人工" }]);
  expect(session.applyExternal(prepend)).toBe("conflict");
  expect(session.source()).toBe("人工\r\n中文📝\n乙");
});
