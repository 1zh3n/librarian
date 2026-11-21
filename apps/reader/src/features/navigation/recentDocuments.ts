const limit = 8;

function key(username: string, workspace: string) {
  return `librarian.recent.${encodeURIComponent(username)}.${workspace}`;
}

export function recentDocuments(username: string, workspace: string): string[] {
  if (!username || !workspace) return [];
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(key(username, workspace)) ?? "[]",
    );
    return Array.isArray(value)
      ? value
          .filter((id): id is string => typeof id === "string" && /^doc_[a-f0-9]+$/u.test(id))
          .slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentDocument(username: string, workspace: string, document: string) {
  const previous = recentDocuments(username, workspace);
  if (previous[0] === document) return;
  try {
    window.localStorage.setItem(
      key(username, workspace),
      JSON.stringify([document, ...previous.filter((id) => id !== document)].slice(0, limit)),
    );
  } catch {
    // Navigation remains available when storage is disabled.
  }
}
