type WorkerMessage =
  | { type: "check-session" | "purge" }
  | { type: "save" | "status" | "remove"; id: string };

let workerRegistration: Promise<ServiceWorker | null> | undefined;

export function offlineAvailable() {
  return import.meta.env.PROD && "serviceWorker" in navigator;
}

function worker() {
  if (!offlineAvailable()) return Promise.resolve(null);
  if (navigator.serviceWorker.controller)
    return Promise.resolve(navigator.serviceWorker.controller);
  return (workerRegistration ??= navigator.serviceWorker
    .register("/sw.js")
    .then(async () => (await navigator.serviceWorker.ready).active)
    .catch((error: unknown) => {
      workerRegistration = undefined;
      throw error;
    }));
}

export async function offlineRequest(message: WorkerMessage) {
  const active = await worker();
  if (!active) throw new Error("Offline Reader worker unavailable");
  return new Promise<boolean>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error("Offline Reader request timed out"));
    }, 60_000);
    channel.port1.onmessage = (event: MessageEvent<{ ok: boolean; value?: boolean }>) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (event.data.ok) resolve(Boolean(event.data.value));
      else reject(new Error("Offline Reader request failed"));
    };
    active.postMessage(message, [channel.port2]);
  });
}

export function initializeOfflineReader() {
  if (!offlineAvailable()) return;
  const sync = () => void offlineRequest({ type: "check-session" }).catch(() => {});
  sync();
  window.addEventListener("online", sync);
}

export async function purgeOfflineReader() {
  if (!offlineAvailable()) return;
  try {
    await offlineRequest({ type: "purge" });
  } catch {
    if (!("caches" in window)) return;
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith("librarian-reader-"))
        .map((name) => caches.delete(name)),
    );
  }
}
