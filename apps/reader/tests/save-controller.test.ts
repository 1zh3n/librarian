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
});
