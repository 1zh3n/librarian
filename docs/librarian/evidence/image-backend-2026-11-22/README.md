# 图片后端与 Reader 图片接入验收

日期：2026-11-22
部署：`4a2cf5fc`（后端 `782d28a4`，Reader 图片接入 `4a2cf5fc`）
内网：<https://192.168.8.166:18447>
数据根：`/home/xia/.local/state/librarian-ai-workspace-candidate/data`
回滚备份：`backups/pre-reader-images-4a2cf5fc-20261122-141906`

## 1. 真实 MCP 狗粮

使用 OpenCode 当前 CIMD 连接背后的真实 OAuth grant（`ai-agent`）调用 18447 的 `.mcp`，不是模拟服务。

| 检查 | 结果 |
| --- | --- |
| 工具数 | 21，含 `workspace_upload_image`、`workspace_read_asset`、`workspace_list_assets` |
| 小图上传 | `dogfood/dogfood.png`，296 B，2×3 |
| 12 MiB 上传 | `dogfood/twelve-mib.png`，12,582,912 B；本地耗时 0.437 s |
| 8 MiB 内读取 | image content，revision 与上传一致 |
| 12 MiB 读取 | `inline: false`，metadata + asset URL，不返回 image content |
| 列表 | 返回路径、revision、size、contentType、isImage；revision 与 SHA-256 一致 |
| 替换 | `baseRevision` 替换为 1×1 PNG，read 返回新字节 |
| 撤销替换 | read 恢复 296 B 原图 |
| 撤销上传 | 小图与 12 MiB 图从资产列表消失 |

实现细节见 `mcp-dogfood.json`；部署命令和 release 路径见 `deployment.json`。

## 2. 真实 HTTP 资产读取

用已登录的 Chromium 请求 `dogfood/reader-wide.png`：

- `Content-Type: image/png`
- `Cache-Control: private, no-cache`
- `ETag: "fdd479...4193"`
- `X-Content-Revision: fdd479...4193`
- `If-None-Match` 重验证返回 `304`

## 3. Reader 图片接入

入口：文档「更多」菜单 →「插入图片…」。阅读态选择后会进入编辑态；编辑态同一入口保持打开。

- 默认保存到当前文档同目录的 `assets/`。
- 支持一次 8 张、单张 12 MiB、PNG/JPEG/WebP/GIF/AVIF。
- 服务端重名返回最终路径；第二次同名上传插入 `assets/photo-2.png`。
- 编辑器内支持选择文件、拖放和粘贴图片；插入进入正常撤销栈。
- 编辑态图片预览；点击预览显示原 Markdown。
- 阅读态图片限制在正文列宽，懒加载、异步解码；断图显示 alt；本地 SVG 不内联。
- 18447 真实 UI 上传：`dogfood/ui-upload-large.md` 通过菜单上传 `screen-01.png`（1,440×901），最终 Markdown 为 `![screen-01](assets/screen-01.png)`。

## 4. 画面与测量

| 路径 | 画面 | 结果 |
| --- | --- | --- |
| 1440 阅读 | [reader-image-1440.png](reader-image-1440.png) | 图片 1,500×4,914，渲染宽 755.98 px；`scrollWidth=1440` |
| 390 阅读 | [reader-image-390.png](reader-image-390.png) | 图片宽 342.98 px；`scrollWidth=390` |
| 320 / 200% | [reader-image-320-200.png](reader-image-320-200.png) | 图片宽 240.98 px；`scrollWidth=320` |
| 1440 编辑预览 | [editor-image-preview-1440.png](editor-image-preview-1440.png) | 预览 naturalWidth 1,500，宽 755.98 px |
| 1440 编辑源码 | [editor-image-source-1440.png](editor-image-source-1440.png) | 点击预览回到 `![Reader 设计总览](reader-wide.png)` |
| 1440 文档菜单 | [image-menu-1440.png](image-menu-1440.png) | 唯一「插入图片…」入口 |
| 1440 插入弹窗 | [image-insert-dialog-1440.png](image-insert-dialog-1440.png) | 目标目录、格式与大小说明、选择/插入/取消 |
| 390 触屏插入 | [image-insert-dialog-390-touch.png](image-insert-dialog-390-touch.png) | 底部面板 390×270；不遮挡标题与正文起点 |
| 1440 真实 UI 上传 | [reader-ui-upload-large-1440.png](reader-ui-upload-large-1440.png) | 菜单上传 1,440×901 PNG，图片宽 756 px，正文自动保存 |

原始测量见 `ui-measurements.json`。

## 5. 自动化

| 范围 | 结果 |
| --- | --- |
| Reader Vitest | 29 文件 / 140 项通过 |
| 图片 E2E | 5/5：选择上传、服务端重名、粘贴、拖放、阅读态入口 |
| 产品 Playwright | 293 通过；2 个 release 用例在把 Zola 0.23.6 加入 PATH 后 6/6 通过 |
| 未通过 | `document-workspace.spec.ts` 的只读导入记录用例：新 Workspace 的 `deliveries/` 文档出现在 API 列表和正文，但目录树为空。与图片改动无关，待单独确认目录树对投递物理路径的预期 |
| 类型/lint/format | `tsc --noEmit`、`oxlint --type-aware --deny-warnings`、`oxfmt --check` 通过 |
| Rust | `make check-rust`、`cargo test -p librarian --tests`、server lib 1403 项通过 |

## 6. 未证明

- 真实墨水屏刷新、Android/iPhone 软键盘和读屏播报。
- 大图在低端设备上的内存峰值和长列表懒加载性能。
- 图片 EXIF 隐私脱敏；当前明确保留原件元数据。
