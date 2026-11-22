# 低 JS 静态阅读部署验收

日期：2026-11-22
部署：`ca8a3428`
内网：<https://192.168.8.166:18447>
回滚备份：`backups/pre-static-reading-ca8a3428-20261122-203336`

`ca8a3428` 只把静态阅读错误页的 `Content-Type` 修正为 `text/html`；运行时阅读器、路由和样式与 `9a417d90` 相同。后续 `62d360b1` 只增加过期/只读成员测试，不改运行时代码。

## 交付

| 路径 | 行为 |
| --- | --- |
| `/workspaces/{workspace}/documents/{document}/read` | 登录成员读取私有文档；复用 workspace 读权限、`document_scope`、`read_markdown` 和现有资产端点 |
| `/r/{snapshot}/read` | 分享/成员快照静态阅读；复用 `with_snapshot` 的过期、撤销、成员和固定版本语义 |
| `?eink=1` | 纯黑白、图片 `grayscale(1)`、零动效 |
| `?theme=light\|dark\|auto` | 显式明暗主题 |
| `?text=200` | 200% 正文字号，不依赖浏览器缩放 |
| `/r/{snapshot}`、`/workspaces/.../documents/...` 的 `<noscript>` | 无 JS 时显示「静态阅读版」链接，不改变有 JS 时的 SPA 行为 |

SPA 入口：文档「更多」菜单与快照页头的「低 JS 阅读」。分享地址默认仍是 SPA；真实墨水屏反馈后再决定是否把默认入口切到静态页。

## 实测

真实数据：私有文档「图片后端狗粮」和含 3 篇文档的分享快照。快照包含 `dogfood/reader-wide.png` 与 `dogfood/assets/screen-01.png`。验收后已撤销该快照，`shareUrl` 现在返回 404，这是撤销语义的预期结果。

| 场景 | 结果 |
| --- | --- |
| 私有 1440 | 0 个 `<script>`、0 个脚本请求；HTML 1513 B；CSS 7170 B；`scrollWidth=1440` |
| 私有 390 / e-ink | 0 JS；`scrollWidth=390`；图片宽 369.98 px；`filter=grayscale(1)` |
| 私有 320 / 200% / e-ink | 0 JS；`scrollWidth=320`；标题和长代码换行；图片宽 299.98 px |
| 分享 1440 | 0 JS；HTML 2177 B；3 篇文档目录；图片 `naturalWidth=1500`；正文与图片可见 |
| 分享切文档 | 目录链接可用，第二篇标题「UI 上传大图验证」和图片正常 |
| 分享打印 | 目录和页脚隐藏，正文和标题保留 |
| 撤销后 | `404`，`Content-Type: text/html; charset=utf-8`，显示「阅读地址不可用」 |
| HTML + CSS | 私有约 8.7 KB、分享约 9.3 KB（不含图片），低于 150 KB 目标 |
| 页面时序 | DOMContentLoaded 约 9–12 ms，load 约 9–23 ms（内网、无图片解码阻塞） |

响应头：

```text
Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Vary: Cookie
```

画面：

- [私有文档 1440](private-1440.png)
- [私有文档 390 / e-ink](private-390-eink.png)
- [私有文档 320 / 200% / e-ink](private-320-text-200-eink.png)
- [分享快照 1440](share-1440.png)
- [分享快照切换第二篇](share-second-document-1440.png)
- [分享快照打印样式](share-print-1440.png)
- [无 JS 打开 SPA 时的提示](spa-noscript-private-1440.png)
- [撤销后的 404](share-revoked-1440.png)

原始测量见 `measurements.json`。

## 测试

| 范围 | 结果 |
| --- | --- |
| `cargo test -p silverbullet-server --lib product::reading` | 5/5 通过：GFM、表格、中文标题、frontmatter、链接/图片重写、外部图片、XSS、标题去重、空文档 |
| `cargo test -p librarian --test fork_seams static_reading_pages` | 通过：私有登录/未登录/只读成员、缺失文档、成员快照、分享快照、多文档、撤销、过期、404 Content-Type、CSS 缓存 |
| `document-static-reading.spec.ts` | 通过：SPA 文档菜单/快照页头入口、禁用 JavaScript 的私有/分享、noscript 入口、1440/390/320、200%、表格、代码、图片、目录、打印、撤销 |
| Reader Vitest | 140/140 通过 |
| Reader TypeScript / Oxlint / Oxfmt | 通过 |
| `make check-rust` | 通过（`cargo fmt --check` + workspace clippy `-D warnings`） |
| 完整产品 Playwright | 303/304 通过；唯一失败是 `document-release.spec.ts` 的备份设置重试用例，单文件复跑 6/6 通过；属于并行共享 fixture 的抖动，与本切片无关 |

完整日志见 `product-playwright.log`。

## 安全与已知限制

- raw HTML 首版转义为文本，不执行、不内联；`script`、`iframe`、事件属性和 `javascript:`/`data:` URL 不进入输出。
- 外部图片不输出 `<img>`，仅显示 alt；SVG 不内联，按附件/替代文字处理。
- 外链保留 `http`/`https`/`mailto`，统一 `rel="noreferrer"`。
- 快照只读取 manifest 明确包含的附件；未选择的图片显示 alt，不自动扩大快照范围。
- 静态页没有应用内搜索、AI、目录筛选、评论或图片查看器；浏览器查找、打印和缩放可用。
- 未在真实墨水屏/Max2 上验证刷新、残影、字体渲染和长文滚动，当前只证明 Chromium 无 JS + e-ink 样式。该项仍是最终设备验收待办。
- 未改变 `/r/{id}` 的默认 SPA 行为；无 JS 用户会看到 `<noscript>` 静态阅读链接。是否默认切换需真实设备反馈。
- `?text=200` 是静态页独立参数，不读取 Reader 的阅读偏好设置。
