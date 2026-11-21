// Browsers return the nearest caret even when the pointer lands in a gutter.
// Check the two characters adjoining that caret, including at a soft wrap.
export function textCaretAtClick(root: HTMLElement, { clientX: x, clientY: y }: MouseEvent) {
  const doc = root.ownerDocument;
  const caret = doc.caretPositionFromPoint?.(x, y);
  const fallback = caret ? undefined : doc.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode ?? fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (!(node instanceof Text) || offset === undefined || !root.contains(node)) return;
  const range = doc.createRange();
  for (const index of [offset - 1, offset]) {
    if (index < 0 || index >= node.length) continue;
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    for (const box of range.getClientRects()) {
      if (box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        return { node, offset };
      }
    }
  }
}
