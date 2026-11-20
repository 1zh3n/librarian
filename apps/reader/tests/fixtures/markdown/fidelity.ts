export const mixedMarkdown =
  "\uFEFF---\r\ntitle: 河边\n---\r\n\r\n# 河边的笔记 😀\r\n\n<!-- 保留 -->\r\n\r\n清晨  \n\n[[未知扩展]]\r尾行";

export const fidelityFixtures = [
  { name: "empty", markdown: "" },
  { name: "LF and trailing spaces", markdown: "# 标题\n\n尾空白  \n" },
  { name: "CRLF without final newline", markdown: "# 标题\r\n\r\n末行" },
  { name: "BOM and mixed line endings", markdown: mixedMarkdown },
];

export const unsafeMarkup = [
  "<script>hiddenScriptText</script>",
  "",
  "[unsafe](javascript:alert%281%29) [safe](https://example.com/path)",
  "",
  "![unsafe source](data:text/html,danger) <span>hiddenRawHtml</span>",
].join("\n");
