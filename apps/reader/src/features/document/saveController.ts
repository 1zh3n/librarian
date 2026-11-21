import { ApiError } from "../../api/client";

export type MarkdownSnapshot = { markdown: string; revision: string | null };
export type MarkdownWrite = { markdown: string; baseRevision: string | null };
export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";
export type SaveConflict<Snapshot extends MarkdownSnapshot> =
  | { state: "loading" }
  | { state: "ready"; remote: Snapshot }
  | { state: "unavailable" };

type ReplaceSource = (markdown: string, confirmed: string, revision: string | null) => boolean;

const WAIT_BEFORE_SAVE = 450;

export class SaveController<Snapshot extends MarkdownSnapshot> {
  #confirmed: Snapshot;
  #latest: { markdown: string; generation: number };
  #status: SaveStatus = "idle";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active: Promise<void> | undefined;
  #listeners = new Set<() => void>();
  #write: (change: MarkdownWrite) => Promise<Snapshot>;
  #onConfirmed: (snapshot: Snapshot) => void;
  #readCurrent: (() => Promise<Snapshot>) | undefined;
  #replace: ReplaceSource | undefined;
  #unacknowledged: string | undefined;
  #conflict: SaveConflict<Snapshot> | undefined;
  #remoteRequest: Promise<void> | undefined;

  constructor(
    initial: Snapshot,
    write: (change: MarkdownWrite) => Promise<Snapshot>,
    onConfirmed: (snapshot: Snapshot) => void,
    readCurrent?: () => Promise<Snapshot>,
    replace?: ReplaceSource,
  ) {
    this.#confirmed = initial;
    this.#latest = { markdown: initial.markdown, generation: 0 };
    this.#write = write;
    this.#onConfirmed = onConfirmed;
    this.#readCurrent = readCurrent;
    this.#replace = replace;
  }

  status = (): SaveStatus => this.#status;

  conflict = (): SaveConflict<Snapshot> | undefined => this.#conflict;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  isDirty() {
    return (
      this.#status === "saving" ||
      this.#unacknowledged !== undefined ||
      this.#latest.markdown !== this.#confirmed.markdown
    );
  }

  confirmed() {
    return this.#confirmed;
  }

  change(markdown: string) {
    if (markdown === this.#latest.markdown) return;
    this.#latest = { markdown, generation: this.#latest.generation + 1 };
    this.cancelScheduledSave();
    if (this.#status === "saving" || this.#status === "conflict") return;
    if (!this.isDirty()) {
      this.#setStatus("saved");
      return;
    }
    if (this.#status === "error") return;
    this.#setStatus("pending");
    this.#timer = setTimeout(() => void this.flush(), WAIT_BEFORE_SAVE);
  }

  cancelScheduledSave() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  flush() {
    this.cancelScheduledSave();
    if (this.#active) return this.#active;
    if (!this.isDirty() || this.#status === "conflict") return Promise.resolve();
    this.#active = this.#writeChanges().finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }

  acceptRemote(
    snapshot: Snapshot,
    apply: (snapshot: Snapshot, previous: Snapshot) => boolean = () => true,
  ) {
    if (this.isDirty() || snapshot.revision === this.#confirmed.revision) return false;
    if (!apply(snapshot, this.#confirmed)) return false;
    this.#confirmed = snapshot;
    this.#latest = { markdown: snapshot.markdown, generation: this.#latest.generation + 1 };
    this.#setStatus("idle");
    return true;
  }

  reloadRemote() {
    const remote = this.#readyRemote();
    if (!remote || !this.#replace) return false;
    if (!this.#replace(remote.markdown, remote.markdown, remote.revision)) return false;
    this.#confirmed = remote;
    this.#latest = { markdown: remote.markdown, generation: this.#latest.generation + 1 };
    this.#unacknowledged = undefined;
    this.#clearConflict();
    this.#onConfirmed(remote);
    this.#setStatus("saved");
    return true;
  }

  overwriteRemote() {
    const remote = this.#readyRemote();
    if (!remote) return false;
    this.#confirmed = remote;
    this.#unacknowledged = undefined;
    this.#clearConflict();
    if (this.#latest.markdown === remote.markdown) {
      this.#onConfirmed(remote);
      this.#setStatus("saved");
      return true;
    }
    this.#setStatus("idle");
    void this.flush();
    return true;
  }

  mergeRemote(markdown: string) {
    const remote = this.#readyRemote();
    if (!remote || !this.#replace) return false;
    if (!this.#replace(markdown, remote.markdown, remote.revision)) return false;
    this.#confirmed = remote;
    this.#latest = { markdown, generation: this.#latest.generation + 1 };
    this.#unacknowledged = undefined;
    this.#clearConflict();
    if (markdown === remote.markdown) {
      this.#onConfirmed(remote);
      this.#setStatus("saved");
      return true;
    }
    this.#setStatus("idle");
    void this.flush();
    return true;
  }

  async retryRemote() {
    if (this.#status !== "conflict" || this.#conflict?.state === "ready") return;
    await this.#loadRemote();
  }

  async #writeChanges() {
    this.#setStatus("saving");
    if (this.#unacknowledged !== undefined && this.#readCurrent) {
      let remote: Snapshot;
      try {
        remote = await this.#readCurrent();
      } catch {
        this.#setStatus("error");
        return;
      }
      if (remote.revision !== this.#confirmed.revision) {
        if (remote.revision === null || remote.markdown !== this.#unacknowledged) {
          this.#enterConflict(remote);
          return;
        }
        this.#confirm(remote);
      }
      this.#unacknowledged = undefined;
    }
    while (this.#latest.markdown !== this.#confirmed.markdown) {
      const snapshot = this.#latest;
      const baseRevision = this.#confirmed.revision;
      let saved: Snapshot;
      try {
        saved = await this.#write({ markdown: snapshot.markdown, baseRevision });
        if (saved.revision === null || saved.markdown !== snapshot.markdown) {
          throw new Error("Server did not confirm this Markdown snapshot");
        }
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 409;
        if (!conflict && this.#readCurrent) this.#unacknowledged = snapshot.markdown;
        if (!conflict || !this.#readCurrent) {
          if (conflict) this.#enterConflict();
          else this.#setStatus("error");
          return;
        }
        try {
          saved = await this.#readCurrent();
        } catch {
          this.#enterConflict(undefined, false);
          return;
        }
        if (saved.revision === null || saved.markdown !== snapshot.markdown) {
          this.#enterConflict(saved);
          return;
        }
      }
      this.#confirm(saved);
      if (snapshot.generation === this.#latest.generation) break;
    }
    this.#setStatus("saved");
  }

  #readyRemote() {
    return this.#status === "conflict" && this.#conflict?.state === "ready"
      ? this.#conflict.remote
      : undefined;
  }

  #enterConflict(remote?: Snapshot, load = true) {
    const alreadyConflicted = this.#status === "conflict";
    this.#conflict = remote
      ? { state: "ready", remote }
      : this.#readCurrent && load
        ? { state: "loading" }
        : { state: "unavailable" };
    this.#setStatus("conflict");
    if (alreadyConflicted) this.#emit();
    if (!remote && this.#readCurrent && load) void this.#loadRemote();
  }

  async #loadRemote() {
    if (!this.#readCurrent || this.#remoteRequest) return this.#remoteRequest;
    if (this.#conflict?.state !== "ready") {
      this.#conflict = { state: "loading" };
      this.#emit();
    }
    this.#remoteRequest = (async () => {
      try {
        const remote = await this.#readCurrent!();
        if (this.#status !== "conflict") return;
        this.#conflict = { state: "ready", remote };
      } catch {
        if (this.#status !== "conflict") return;
        this.#conflict = { state: "unavailable" };
      } finally {
        this.#remoteRequest = undefined;
        if (this.#status === "conflict") this.#emit();
      }
    })();
    return this.#remoteRequest;
  }

  #clearConflict() {
    this.#conflict = undefined;
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }

  #confirm(snapshot: Snapshot) {
    this.#confirmed = snapshot;
    this.#onConfirmed(snapshot);
  }

  #setStatus(value: SaveStatus) {
    if (this.#status === value) return;
    this.#status = value;
    this.#emit();
  }
}
