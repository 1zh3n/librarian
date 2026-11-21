import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DirectoryTree } from "../src/ui/DirectoryTree/DirectoryTree";
import { WorkspaceContextMenu } from "../src/features/navigation/WorkspaceContextMenu";

afterEach(cleanup);

test("a folder without documents remains available in the tree and has its own commands", async () => {
  render(
    <DirectoryTree
      documents={[]}
      folderPaths={["草稿/次月"]}
      activeDocument={undefined}
      open={() => {}}
      openMenu={() => {}}
    />,
  );
  const child = await screen.findByRole("button", { name: "次月更多" });
  expect(child.closest('[role="row"]')?.querySelectorAll("button")).toHaveLength(1);
  expect(child.closest("[data-context-folder]")?.getAttribute("data-context-folder")).toBe(
    "草稿/次月",
  );
  expect(screen.getByRole("button", { name: "根目录更多" })).toBeDefined();
});

test("a readable row can offer copy without move or deletion", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  try {
    render(
      <WorkspaceContextMenu
        target={{ trigger, folder: "", point: undefined }}
        create={undefined}
        rename={undefined}
        actions={{ copy: () => {} }}
        search={() => {}}
        close={() => {}}
      />,
    );
    expect(await screen.findByRole("menuitem", { name: "复制到…" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "移动到…" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "删除…" })).toBeNull();
  } finally {
    trigger.remove();
  }
});
