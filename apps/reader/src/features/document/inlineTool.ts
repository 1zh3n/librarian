// Reserve space in the reading flow while keeping the tool's DOM and keyboard
// order stable across desktop, narrow layouts and tab changes.
export function placeInlineTool(pane: HTMLElement, block: HTMLElement) {
  const grid = pane.parentElement;
  const article = block.closest("article");
  if (!grid || !article) return;
  let row = block;
  while (row.parentElement && row.parentElement !== article) row = row.parentElement;

  row.style.setProperty("--passage-margin", getComputedStyle(row).marginBlockStart);
  row.setAttribute("data-tool-passage", "");
  pane.setAttribute("data-beside-passage", "");
  function place() {
    if (!grid) return;
    const gap = pane.offsetHeight + 16;
    row.style.setProperty("--passage-tool-space", `${gap}px`);
    const top = row.getBoundingClientRect().top - grid.getBoundingClientRect().top - gap;
    pane.style.setProperty("--passage-tool-top", `${top}px`);
  }
  place();
  const observer = new ResizeObserver(place);
  observer.observe(pane);
  observer.observe(article);
  return () => {
    observer.disconnect();
    row.removeAttribute("data-tool-passage");
    row.style.removeProperty("--passage-margin");
    row.style.removeProperty("--passage-tool-space");
    pane.removeAttribute("data-beside-passage");
    pane.style.removeProperty("--passage-tool-top");
  };
}
