import { expect, test, vi } from "vitest";
import { openEditor } from "../src/editor/codemirror/adapter";

function mountEditor(session: ReturnType<typeof openEditor>) {
  const host = document.createElement("div");
  document.body.append(host);
  const unmount = session.mount(host);
  return {
    host,
    dispose: () => {
      unmount();
      host.remove();
    },
  };
}

test("inserts image Markdown with the document line ending and blank lines", () => {
  const session = openEditor("第一行\r\n第二行\r\n");
  session.select({ anchor: 0, head: 0 });
  session.insertMarkdown("![河岸](assets/photo.png)");
  expect(session.source()).toBe("![河岸](assets/photo.png)\r\n\r\n第一行\r\n第二行\r\n");
  expect(session.selection()).toEqual({
    anchor: "![河岸](assets/photo.png)".length + 4,
    head: "![河岸](assets/photo.png)".length + 4,
  });

  const empty = openEditor("");
  empty.insertMarkdown("![图](assets/a.png)");
  expect(empty.source()).toBe("![图](assets/a.png)\n");
});

test("replaces a selection and keeps normal undo history", () => {
  const session = openEditor("前\r\n选中\r\n后");
  session.select({ anchor: 3, head: 5 });
  session.insertMarkdown("![图](assets/a.png)");
  expect(session.source()).toBe("前\r\n\r\n![图](assets/a.png)\r\n\r\n后");
  expect(
    session.applyExternal({
      baseRevision: null,
      revision: "r",
      edits: [{ from: 0, to: 0, insert: "x" }],
    }),
  ).toBe("conflict");
});

test("previews a resolved image and reveals its source when clicked", async () => {
  const markdown = "![河岸](assets/photo.png)\n\n尾";
  const session = openEditor(markdown, {
    resolveImage: (src) => (src === "assets/photo.png" ? "/api/asset.png" : null),
    selection: { anchor: markdown.length, head: markdown.length },
  });
  const { host, dispose } = mountEditor(session);
  try {
    const image = await vi.waitFor(() => {
      const found = host.querySelector<HTMLImageElement>("[data-preview-image] img");
      expect(found).toBeTruthy();
      return found!;
    });
    expect(image.src).toContain("/api/asset.png");
    expect(image.alt).toBe("河岸");
    image.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector("[data-preview-image]")).toBeNull());
    expect(session.source()).toBe(markdown);
  } finally {
    dispose();
  }
});
