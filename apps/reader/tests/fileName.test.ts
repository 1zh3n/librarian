import { describe, expect, it } from "vitest";
import { fileName } from "../src/features/navigation/fileName";

describe("fileName", () => {
  it("returns the last path segment", () => {
    expect(fileName("docs/superpowers/plans/2026-11-21-plan.md")).toBe("2026-11-21-plan.md");
  });

  it("keeps extensions and non-ASCII names", () => {
    expect(fileName("记录/笔记 01.md")).toBe("笔记 01.md");
  });

  it("handles leading and trailing slashes", () => {
    expect(fileName("/notes/today.md")).toBe("today.md");
    expect(fileName("notes/today.md/")).toBe("today.md");
    expect(fileName("notes/")).toBe("notes");
  });

  it("does not invent a name for an empty path", () => {
    expect(fileName("")).toBe("");
  });
});
