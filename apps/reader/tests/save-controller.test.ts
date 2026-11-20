import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { SaveController } from "../src/features/document/saveController";

describe("document saves", () => {
  it("keeps edits typed while a save is waiting and uses its returned revision", async () => {
    let resolveFirst: (value: { markdown: string; revision: string }) => void = () => {};
    const pending = new Promise<{ markdown: string; revision: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const write = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ markdown: "后续输入", revision: "next-2" });
    const updated = vi.fn();
    const saves = new SaveController({ markdown: "旧内容", revision: "base" }, write, updated);
    saves.change("第一笔");
    const saving = saves.flush();
    saves.change("后续输入");
    expect(write).toHaveBeenCalledTimes(1);
    resolveFirst({ markdown: "第一笔", revision: "next-1" });
    await saving;
    expect(write.mock.calls).toEqual([
      [{ markdown: "第一笔", baseRevision: "base" }],
      [{ markdown: "后续输入", baseRevision: "next-1" }],
    ]);
    expect(updated.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      { markdown: "第一笔", revision: "next-1" },
      { markdown: "后续输入", revision: "next-2" },
    ]);
    expect(saves.status()).toBe("saved");
  });

  it("retains unsaved edits through a network failure and retries the same base", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ markdown: "本地输入", revision: "next" });
    const saves = new SaveController({ markdown: "旧内容", revision: "base" }, write, vi.fn());
    saves.change("本地输入");
    await saves.flush();
    expect(saves.status()).toBe("error");
    await saves.flush();
    expect(write.mock.calls).toEqual([
      [{ markdown: "本地输入", baseRevision: "base" }],
      [{ markdown: "本地输入", baseRevision: "base" }],
    ]);
    expect(saves.status()).toBe("saved");
  });

  it("keeps a conflicting draft on its original base and ignores a remote refetch", async () => {
    const write = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Conflict", "remote"));
    const saves = new SaveController({ markdown: "旧内容", revision: "base" }, write, vi.fn());
    saves.change("本地输入");
    await saves.flush();
    expect(saves.status()).toBe("conflict");
    expect(saves.acceptRemote({ markdown: "远程输入", revision: "remote" })).toBe(false);
    await saves.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(saves.isDirty()).toBe(true);
  });

  it("confirms the actual saved bytes after losing the write acknowledgement", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection closed after write"))
      .mockRejectedValueOnce(new ApiError(409, "revision_conflict", "Conflict", "persisted"));
    const persisted = { markdown: "已写入磁盘", revision: "persisted" };
    const readCurrent = vi.fn().mockResolvedValue(persisted);
    const confirmed = vi.fn();
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      confirmed,
      readCurrent,
    );
    saves.change(persisted.markdown);
    await saves.flush();
    expect(saves.status()).toBe("error");
    await saves.flush();
    expect(readCurrent).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledWith(persisted);
    expect(saves.status()).toBe("saved");
    expect(saves.isDirty()).toBe(false);
  });

  it("uses the landed revision for later text after an in-flight response is lost", async () => {
    let disconnect = () => {};
    const pending = new Promise((_resolve, reject) => {
      disconnect = () => reject(new TypeError("connection closed after write"));
    });
    const write = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockImplementation(({ baseRevision }: { baseRevision: string }) =>
        baseRevision === "first"
          ? Promise.resolve({ markdown: "后续输入", revision: "second" })
          : Promise.reject(new ApiError(409, "revision_conflict", "Conflict", "first")),
      );
    const readCurrent = vi.fn().mockResolvedValue({ markdown: "第一笔", revision: "first" });
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      vi.fn(),
      readCurrent,
    );
    saves.change("第一笔");
    const saving = saves.flush();
    saves.change("后续输入");
    disconnect();
    await saving;
    await saves.flush();
    expect(saves.status()).toBe("saved");
    expect(write).toHaveBeenLastCalledWith({ markdown: "后续输入", baseRevision: "first" });
  });
});
