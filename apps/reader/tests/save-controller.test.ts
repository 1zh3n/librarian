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

  it("saves after the maximum wait even while typing continues", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn().mockResolvedValue({ markdown: "连续输入第三段", revision: "next" });
      const saves = new SaveController({ markdown: "旧内容", revision: "base" }, write, vi.fn());
      saves.change("连续输入第一段");
      await vi.advanceTimersByTimeAsync(400);
      saves.change("连续输入第二段");
      await vi.advanceTimersByTimeAsync(400);
      saves.change("连续输入第三段");
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_200);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith({
        markdown: "连续输入第三段",
        baseRevision: "base",
      });
      expect(saves.status()).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
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

  it("loads the remote snapshot after a conflict without applying it", async () => {
    const remote = { markdown: "远程输入", revision: "remote" };
    const write = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Conflict", "remote"));
    const readCurrent = vi.fn().mockResolvedValue(remote);
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      vi.fn(),
      readCurrent,
      vi.fn(() => true),
    );
    saves.change("本地输入");
    await saves.flush();
    expect(saves.status()).toBe("conflict");
    expect(saves.conflict()).toEqual({ state: "ready", remote });
    expect(saves.isDirty()).toBe(true);
  });

  it("reloads the remote version and saves later edits on its revision", async () => {
    const remote = { markdown: "远程输入", revision: "remote" };
    const write = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "revision_conflict", "Conflict", "remote"))
      .mockResolvedValueOnce({ markdown: "重载后的续写", revision: "next" });
    const readCurrent = vi.fn().mockResolvedValue(remote);
    const replace = vi.fn(() => true);
    const confirmed = vi.fn();
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      confirmed,
      readCurrent,
      replace,
    );
    saves.change("本地输入");
    await saves.flush();
    expect(saves.reloadRemote()).toBe(true);
    expect(replace).toHaveBeenCalledWith("远程输入", "远程输入", "remote");
    expect(confirmed).toHaveBeenCalledWith(remote);
    expect(saves.status()).toBe("saved");
    expect(saves.isDirty()).toBe(false);

    saves.change("重载后的续写");
    await saves.flush();
    expect(write).toHaveBeenLastCalledWith({
      markdown: "重载后的续写",
      baseRevision: "remote",
    });
    expect(saves.status()).toBe("saved");
  });

  it("keeps the local draft and overwrites the remote revision explicitly", async () => {
    const remote = { markdown: "远程输入", revision: "remote" };
    const write = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "revision_conflict", "Conflict", "remote"))
      .mockResolvedValueOnce({ markdown: "本地输入", revision: "next" })
      .mockResolvedValueOnce({ markdown: "本地输入继续", revision: "next-2" });
    const readCurrent = vi.fn().mockResolvedValue(remote);
    const confirmed = vi.fn();
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      confirmed,
      readCurrent,
      vi.fn(() => true),
    );
    saves.change("本地输入");
    await saves.flush();
    expect(saves.overwriteRemote()).toBe(true);
    await saves.flush();
    expect(write).toHaveBeenLastCalledWith({ markdown: "本地输入", baseRevision: "remote" });
    expect(confirmed).toHaveBeenCalledWith({ markdown: "本地输入", revision: "next" });
    expect(saves.status()).toBe("saved");

    saves.change("本地输入继续");
    await saves.flush();
    expect(write).toHaveBeenLastCalledWith({
      markdown: "本地输入继续",
      baseRevision: "next",
    });
  });

  it("saves an edited merge result on the remote revision", async () => {
    const remote = { markdown: "远程输入", revision: "remote" };
    const write = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "revision_conflict", "Conflict", "remote"))
      .mockResolvedValueOnce({ markdown: "合并结果", revision: "merged" })
      .mockResolvedValueOnce({ markdown: "合并结果续写", revision: "merged-2" });
    const readCurrent = vi.fn().mockResolvedValue(remote);
    const replace = vi.fn(() => true);
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      vi.fn(),
      readCurrent,
      replace,
    );
    saves.change("本地输入");
    await saves.flush();
    expect(saves.mergeRemote("合并结果")).toBe(true);
    expect(replace).toHaveBeenCalledWith("合并结果", "远程输入", "remote");
    await saves.flush();
    expect(write).toHaveBeenLastCalledWith({ markdown: "合并结果", baseRevision: "remote" });
    expect(saves.status()).toBe("saved");

    saves.change("合并结果续写");
    await saves.flush();
    expect(write).toHaveBeenLastCalledWith({
      markdown: "合并结果续写",
      baseRevision: "merged",
    });
  });

  it("confirms a merge equal to the remote without writing again", async () => {
    const remote = { markdown: "远程输入", revision: "remote" };
    const write = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Conflict", "remote"));
    const confirmed = vi.fn();
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      confirmed,
      vi.fn().mockResolvedValue(remote),
      vi.fn(() => true),
    );
    saves.change("本地输入");
    await saves.flush();
    expect(saves.mergeRemote(remote.markdown)).toBe(true);
    await saves.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledWith(remote);
    expect(saves.status()).toBe("saved");
    expect(saves.isDirty()).toBe(false);
  });

  it("keeps the conflict when the remote snapshot cannot be read and retries", async () => {
    const remote = { markdown: "远程输入", revision: "remote" };
    const readCurrent = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(remote);
    const write = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Conflict", "remote"));
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      vi.fn(),
      readCurrent,
      vi.fn(() => true),
    );
    saves.change("本地输入");
    await saves.flush();
    expect(saves.status()).toBe("conflict");
    expect(saves.conflict()).toEqual({ state: "unavailable" });
    await saves.retryRemote();
    expect(saves.conflict()).toEqual({ state: "ready", remote });
  });

  it("does not discard the draft when the editor cannot reset", async () => {
    const remote = { markdown: "远程输入", revision: "remote" };
    const write = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "revision_conflict", "Conflict", "remote"));
    const saves = new SaveController(
      { markdown: "旧内容", revision: "base" },
      write,
      vi.fn(),
      vi.fn().mockResolvedValue(remote),
      vi.fn(() => false),
    );
    saves.change("本地输入");
    await saves.flush();
    expect(saves.reloadRemote()).toBe(false);
    expect(saves.status()).toBe("conflict");
    expect(saves.isDirty()).toBe(true);
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
