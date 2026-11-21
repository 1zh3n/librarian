import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Menu } from "../src/ui/Menu";
import { Tabs, TabPanel } from "../src/ui/Tabs";

afterEach(cleanup);

test("a tab keeps its accessible label when its visible content is an icon", () => {
  render(
    <Tabs
      label="文档工具"
      value="outline"
      onChange={() => {}}
      items={[{ id: "outline", label: "提纲", content: <span aria-hidden="true">☰</span> }]}
    >
      <TabPanel id="outline">草稿</TabPanel>
    </Tabs>,
  );
  expect(screen.getByRole("tab", { name: "提纲" }).getAttribute("aria-selected")).toBe("true");
});

test("a menu action keeps its accessible label when rendered as a layout preview", () => {
  render(
    <Menu
      label="布局"
      items={[
        {
          id: "reading",
          label: "阅读",
          content: <span aria-hidden="true">▥</span>,
          run: () => {},
        },
      ]}
    />,
  );
  expect(screen.getByRole("menuitem", { name: "阅读" })).toBeDefined();
});
