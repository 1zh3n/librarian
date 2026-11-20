import { ApiError } from "../../api/client";

export type MarkdownSnapshot = { markdown: string; revision: string | null };
export type MarkdownWrite = { markdown: string; baseRevision: string | null };
export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";

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
  #unacknowledged: string | undefined;

  constructor(
    initial: Snapshot,
    write: (change: MarkdownWrite) => Promise<Snapshot>,
    onConfirmed: (snapshot: Snapshot) => void,
    readCurrent?: () => Promise<Snapshot>,
  ) {
    this.#confirmed = initial;
    this.#latest = { markdown: initial.markdown, generation: 0 };
    this.#write = write;
    this.#onConfirmed = onConfirmed;
    this.#readCurrent = readCurrent;
  }

  status = (): SaveStatus => this.#status;

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
          this.#setStatus("conflict");
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
          this.#setStatus(conflict ? "conflict" : "error");
          return;
        }
        try {
          saved = await this.#readCurrent();
        } catch {
          this.#setStatus("error");
          return;
        }
        if (saved.revision === null || saved.markdown !== snapshot.markdown) {
          this.#setStatus("conflict");
          return;
        }
      }
      this.#confirm(saved);
      if (snapshot.generation === this.#latest.generation) break;
    }
    this.#setStatus("saved");
  }

  #confirm(snapshot: Snapshot) {
    this.#confirmed = snapshot;
    this.#onConfirmed(snapshot);
  }

  #setStatus(value: SaveStatus) {
    if (this.#status === value) return;
    this.#status = value;
    for (const listener of this.#listeners) listener();
  }
}
