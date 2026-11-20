export const spikeMarkdown = [
  "---",
  "title: 河边的笔记",
  "---",
  "# 河边的笔记",
  "",
  "清晨的水面很**安静**，沿着[小径](https://example.com/)走到了河边。",
  "",
  "> 别惊动停在芦苇里的鸟。",
  "",
  "- [x] 记下潮位",
  "- [ ] 回来看日落",
  "",
  "| 地点 | 水位 |",
  "| --- | --- |",
  "| 石桥 | 低 |",
  "",
  "```text",
  "潮水退了。",
  "```",
].join("\n");

export function spikeFixture(): string {
  const fixture = new URLSearchParams(window.location.search).get("fixture");
  if (fixture === "empty") return "";
  if (fixture === "narrow") {
    const wide = "潮水退了。".repeat(30);
    return (
      spikeMarkdown +
      `\n\n| ${wide} | ${wide} |\n| --- | --- |\n| 海边 | 低 |\n\n\`\`\`text\n${wide}\n\`\`\``
    );
  }
  if (fixture === "performance") {
    const sample = "## 河边的笔记\n\n清晨潮水尚低，芦苇间有几只鸟。**记录**风向和水位。\n\n";
    return sample.repeat(Math.ceil(100_000 / sample.length)).slice(0, 100_000);
  }
  if (fixture !== "anchors") return spikeMarkdown;
  return [
    "# 锚点测试",
    "![迟到的图片](/spike-delayed-image.png)",
    ...Array.from({ length: 90 }, (_, index) =>
      index === 12 || index === 60 ? "## 重复标题" : `第 ${index + 1} 段`,
    ),
  ].join("\n\n");
}
