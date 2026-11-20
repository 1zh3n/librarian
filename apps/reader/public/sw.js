const applicationCache = "librarian-reader-shell-v1";
const identityCache = "librarian-reader-identity-v1";
const snapshotPrefix = "librarian-reader-snapshot-v1-";
const identityKey = "/_reader_offline/identity";
const metadataKey = "/_reader_offline/snapshot";
const shellKey = "/_reader_offline/shell";
const sessionPath = "/api/v1/session";
const snapshotIdPattern = /^[0-9a-f]{32}$/u;
const builtAssetPattern = /^\/assets\/[^/]+\.(?:js|css)$/u;
const denied = new Set([401, 403, 404, 410]);
let writes = Promise.resolve();

function serialize(write) {
  const result = writes.then(write);
  writes = result.catch(() => {});
  return result;
}

function noStore(path, credentials = "same-origin") {
  return fetch(path, { cache: "no-store", credentials, redirect: "error" });
}

async function identity() {
  const saved = await caches.match(identityKey, { cacheName: identityCache });
  return saved ? saved.text() : undefined;
}

async function notifyIdentityChange() {
  for (const client of await globalThis.clients.matchAll({ type: "window" })) {
    client.postMessage({ type: "offline-identity-changed" });
  }
}

async function purge() {
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith(snapshotPrefix)).map((name) => caches.delete(name)),
  );
  await caches.delete(identityCache);
}

async function syncIdentity() {
  const response = await noStore(sessionPath);
  let current;
  if (response.ok) {
    const { cacheId } = await response.json();
    if (typeof cacheId !== "string" || !cacheId || cacheId.length > 256) {
      throw new Error("Invalid session scope");
    }
    current = `session:${cacheId}`;
  } else if (response.status === 401 || response.status === 403) {
    current = "anonymous";
  } else {
    throw new Error("Unable to verify session");
  }
  if ((await identity()) !== current) {
    await purge();
    const store = await caches.open(identityCache);
    await store.put(identityKey, new Response(current));
    await notifyIdentityChange();
  }
  return current;
}

async function snapshotMetadata(id) {
  const response = await caches.match(metadataKey, { cacheName: snapshotPrefix + id });
  if (!response) return undefined;
  const metadata = await response.json();
  if (metadata.expiresAt !== null && metadata.expiresAt * 1_000 <= Date.now()) {
    return undefined;
  }
  return metadata.scope === (await identity()) ? metadata : undefined;
}

function snapshotPath(id, documentId) {
  const base = `/api/v1/snapshots/${id}`;
  return documentId ? `${base}?${new URLSearchParams({ documentId })}` : base;
}

async function saveShell(id) {
  const [manifest, shell] = await Promise.all([
    noStore("/assets/reader-shell.json", "omit"),
    noStore(`/r/${id}`, "omit"),
  ]);
  if (!manifest.ok || !shell.ok || !shell.headers.get("Content-Type")?.startsWith("text/html")) {
    throw new Error("Unable to load the Reader shell");
  }
  const assets = await manifest.json();
  if (
    !Array.isArray(assets) ||
    assets.length === 0 ||
    assets.some((path) => typeof path !== "string" || !builtAssetPattern.test(path))
  ) {
    throw new Error("Invalid Reader asset manifest");
  }
  const store = await caches.open(applicationCache);
  await Promise.all(
    assets.map(async (path) => {
      if (await store.match(path)) return;
      const response = await noStore(path, "omit");
      if (!response.ok) throw new Error("Unable to load the Reader bundle");
      await store.put(path, response);
    }),
  );
  await store.put(shellKey, shell);
}

async function cacheSnapshot(id) {
  const scope = await syncIdentity();
  const path = snapshotPath(id);
  const response = await noStore(path);
  if (!response.ok) throw new Error("Snapshot access denied");
  const snapshot = await response.clone().json();
  if (
    snapshot.kind !== "release" ||
    snapshot.id !== id ||
    (scope === "anonymous" && snapshot.audience !== "share")
  ) {
    throw new Error("Only a fixed reading address can be saved");
  }
  const cacheName = snapshotPrefix + id;
  if (await snapshotMetadata(id)) return;
  await caches.delete(cacheName);

  try {
    const store = await caches.open(cacheName);
    await store.put(path, response);
    const documentIds = snapshot.documents.map((document) => document.id);
    for (const documentId of documentIds) {
      const selectedPath = snapshotPath(id, documentId);
      const selected = await noStore(selectedPath);
      if (!selected.ok) throw new Error("Unable to save a selected document");
      await store.put(selectedPath, selected);
    }
    for (const attachment of snapshot.attachmentPaths) {
      const assetPath = `${path}/assets/${attachment.split("/").map(encodeURIComponent).join("/")}`;
      const asset = await noStore(assetPath);
      if (!asset.ok) throw new Error("Unable to save a selected attachment");
      await store.put(assetPath, asset);
    }
    await saveShell(id);
    if ((await syncIdentity()) !== scope) {
      throw new Error("Session changed while saving");
    }
    await store.put(
      metadataKey,
      new Response(JSON.stringify({ scope, expiresAt: snapshot.expiresAt, documentIds })),
    );
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
}

async function snapshotRead(request, id, navigation) {
  let response;
  try {
    response = navigation ? await fetch(request) : await fetch(request, { cache: "no-store" });
  } catch (error) {
    const metadata = await snapshotMetadata(id);
    if (!metadata) throw error;
    if (navigation) {
      const selected = new URL(request.url).searchParams.get("documentId");
      if (selected && !metadata.documentIds.includes(selected)) throw error;
      const shell = await caches.match(shellKey, { cacheName: applicationCache });
      if (!shell) throw error;
      return shell;
    }
    const saved = await caches.match(request, { cacheName: snapshotPrefix + id });
    if (!saved) throw error;
    const headers = new Headers(saved.headers);
    headers.set("X-Librarian-Offline", "1");
    return new Response(saved.body, { headers, status: saved.status });
  }
  if (denied.has(response.status)) {
    await serialize(() => caches.delete(snapshotPrefix + id));
  }
  return response;
}

async function changeAuthorization(request, id) {
  const response = await fetch(request);
  if (response.ok) {
    await serialize(async () => {
      if (id) {
        await caches.delete(snapshotPrefix + id);
      } else {
        await purge();
        await notifyIdentityChange();
      }
    });
  }
  return response;
}

globalThis.addEventListener("install", (event) => {
  event.waitUntil(globalThis.skipWaiting());
});

globalThis.addEventListener("activate", (event) => {
  event.waitUntil(globalThis.clients.claim());
});

globalThis.addEventListener("message", (event) => {
  const port = event.ports[0];
  if (!port) return;
  const { type, id } = event.data ?? {};
  const result = serialize(async () => {
    if (type === "check-session") {
      await syncIdentity();
      return;
    }
    if (type === "purge") {
      await purge();
      await notifyIdentityChange();
      return;
    }
    if (typeof id !== "string" || !snapshotIdPattern.test(id)) {
      throw new Error("Invalid snapshot id");
    }
    if (type === "status") return Boolean(await snapshotMetadata(id));
    if (type === "remove") return caches.delete(snapshotPrefix + id);
    if (type === "save") await cacheSnapshot(id);
  });
  event.waitUntil(
    result.then(
      (value) => port.postMessage({ ok: true, value }),
      () => port.postMessage({ ok: false }),
    ),
  );
});

globalThis.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== globalThis.location.origin) return;
  const snapshot = /^\/api\/v1\/snapshots\/([0-9a-f]{32})(?:$|\/assets\/)/u.exec(url.pathname)?.[1];
  if (request.method === "POST" && url.pathname === `${sessionPath}/logout`) {
    event.respondWith(changeAuthorization(request));
  } else if (request.method === "DELETE" && snapshot && url.pathname === snapshotPath(snapshot)) {
    event.respondWith(changeAuthorization(request, snapshot));
  } else if (request.method === "GET") {
    const reader =
      request.mode === "navigate" ? /^\/r\/([0-9a-f]{32})$/u.exec(url.pathname)?.[1] : undefined;
    if (reader) {
      event.respondWith(snapshotRead(request, reader, true));
    } else if (snapshot) {
      event.respondWith(snapshotRead(request, snapshot, false));
    } else if (builtAssetPattern.test(url.pathname)) {
      event.respondWith(
        caches
          .match(request, { cacheName: applicationCache })
          .then((asset) => asset ?? fetch(request)),
      );
    }
  }
});
