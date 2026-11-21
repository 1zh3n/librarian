import { expect, test } from "@playwright/test";
import type { DocumentSnapshot } from "../../src/api/client";
import { createNote } from "./productFixture";

for (const formatted of [true, false]) {
  test(`clicking the first character ${formatted ? "of" : "after"} bold text keeps its formatting`, async ({
    page,
  }) => {
    const { apiUrl } = await createNote(page, `StyledCaret-${formatted}.md`, "甲**乙**丙。");
    const paragraph = page.getByRole("article").getByText("甲乙丙。");
    const point = await paragraph.evaluate((element, bold) => {
      const text = bold ? element.querySelector("strong")!.firstChild! : element.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 4, y: rect.top + rect.height / 2 };
    }, formatted);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
    await page.keyboard.insertText("新");
    await expect
      .poll(
        async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
      )
      .toBe(formatted ? "甲**新乙**丙。" : "甲**乙**新丙。");
  });
}
