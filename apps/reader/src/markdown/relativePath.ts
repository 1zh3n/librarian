const origin = "https://librarian.invalid/";

export function relativeDocumentPath(document: string, href: string) {
  if (!href || href.startsWith("#") || href.startsWith("?") || href.startsWith("//")) return;
  try {
    const path = document.split("/").map(encodeURIComponent).join("/");
    const base = new URL(path, origin);
    const target = new URL(href, base);
    if (target.origin !== base.origin) return;
    return { path: decodeURIComponent(target.pathname.slice(1)), hash: target.hash };
  } catch {
    return undefined;
  }
}

export function relativeAssetPath(document: string, asset: string) {
  const from = document.split("/").slice(0, -1);
  const to = asset.split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}
