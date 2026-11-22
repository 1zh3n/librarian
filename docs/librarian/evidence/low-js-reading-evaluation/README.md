# 低 JS 阅读面现状证据

日期：2026-11-22
环境：18447，`d36b2d3f`（运行时 `cd1d6804`）
快照：`/r/74fec394c745404a89225e0e13f4b5d0`（`current`、`audience=share`、单文档）

## JS 禁用结果

Chromium `javaScriptEnabled: false`，1440×900：

- `document.title`: `Librarian`
- `body.innerText`: 空
- 截图：[current-share-nojs-1440.png](current-share-nojs-1440.png)

结论：当前分享链接在无 JS 环境下没有正文；`/r/{snapshot}` 只返回 React 壳。

## 当前 Reader 发行体积

本地 `apps/reader/dist` 约 2.1 MB；主要未压缩 JS：

| 文件 | 字节 |
| --- | ---: |
| `editor-*.js` | 492,759 |
| `theme-*.js` | 261,625 |
| `jsx-runtime-*.js` | 220,167 |
| `DocumentRoute-*.js` | 187,762 |
| `ReaderApplication-*.js` | 177,685 |
| `lib-*.js` | 172,559 |
| `route-*.js` | 64,853 |

这些不是首屏网络请求的精确值，但足以说明：SPA 即使只读，也要下载、解析和运行 React 主链路；低 JS 阅读面应提供 0 JS 的独立 HTML。

## 现有服务端 SSR 的边界

- `server/src/ssr.rs` 是上游 SilverBullet 的 SEO 渲染，只用于匿名可读且不可写的 Space。
- 它处理 wiki links，不处理产品 Snapshot 的相对 Markdown 链接和快照资产。
- 它把 raw HTML 原样输出，没有 sanitize；不能直接用于产品分享页。

详细评估见[低 JS 阅读面评估](../../../../../../../../docs/superpowers/specs/2026-11-22-librarian-low-js-reading-evaluation.md)。
