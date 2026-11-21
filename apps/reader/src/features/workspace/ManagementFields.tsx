export function formatLocalDate(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() > 9999) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
