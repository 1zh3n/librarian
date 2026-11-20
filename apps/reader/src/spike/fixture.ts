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
  if (fixture !== "anchors") return spikeMarkdown;
  return [
    "# 锚点测试",
    "![迟到的图片](/spike-delayed-image.png)",
    ...Array.from({ length: 90 }, (_, index) =>
      index === 12 || index === 60 ? "## 重复标题" : `第 ${index + 1} 段`,
    ),
  ].join("\n\n");
}
