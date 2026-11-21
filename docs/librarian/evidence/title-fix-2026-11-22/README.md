# 文档标题回退验收 · 2026-11-22

- 提交：`b135bf03`（`fix(reader): fall back to the first H1 for document titles`）
- 环境：`https://192.168.8.166:18447`，账号 `ai-agent`
- 文档：`doc_58364b96408a4ce7be1631297ced5427`，`docs/superpowers/specs/2026-11-22-librarian-connections-settings-and-dogfood.md`

## 路径与预期

打开文档后，页面主标题应为正文首个 H1「MCP 设置、图片与阅读模式评估」，不再用文件名；正文只渲染一次 H1。目录和搜索标题同步使用该 H1。有 frontmatter `title` 时仍优先 frontmatter，没有 H1 时仍回退文件名。

## 结果

| 画面 | 观察 | 结论 |
| --- | --- | --- |
| [before-390](before-390.png) | 修复前 390 宽：顶栏是文件名，正文 H1 下移 | 复现旧问题 |
| [1440](1440.png) | 主标题为 H1，正文只出现一次；无横向溢出 | 通过 |
| [390](390.png) | 主标题为 H1；页面 `scrollWidth=390` | 通过 |
| [320-200](320-200.png) | 320 宽 + 200% 字号，标题换行可读；页面 `scrollWidth=320` | 通过 |

自动化检查：`document.querySelectorAll("h1")` 在三种视口都只返回 `["MCP 设置、图片与阅读模式评估"]`；`root.scrollWidth` 分别等于 1440、390、320。

## 登录页 CSP 清理

`1905d6a8` 把 React Aria 注入的 pressable 样式加入登录页 CSP 的 SHA-256 白名单，未启用 `unsafe-inline`；18447 登录页控制台无 CSP 错误，表单和触摸样式正常。
