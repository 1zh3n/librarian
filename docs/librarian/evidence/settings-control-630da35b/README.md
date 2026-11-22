# 设置控件标尺与 Reader 图片回归

日期：2026-11-22
部署：`630da35b`（设置控件标尺与设置壳层重构）
内网：<https://192.168.8.166:18447>
回滚备份：`backups/pre-settings-control-630da35b-20261122-151811`

## 设置实测

| 项 | 实测 |
| --- | --- |
| 分组 | 阅读 / 快捷键 / AI / 连接 |
| 1440 外框 | 702×574 px；切换阅读、AI、连接高度与宽度不跳 |
| 关闭 | 右上角固定「关闭应用设置」，始终可见 |
| 390 触屏 | 全屏 390×844，4 个分组单行 |
| 320 / 200% | 320×720，无横向溢出；分组按 2×2 重排，标题换行 |
| 内容区 | 542×456 px；表单控件桌面 36 px，触屏 44 px |

画面：

- [1440 阅读设置](settings-reading-1440.png)
- [1440 连接设置](settings-connections-1440.png)
- [390 触屏设置](settings-reading-390-touch.png)
- [320 / 200%](settings-reading-320-200.png)

原始测量见 `measurements.json`。

## 图片回归

设置重构后重新在 18447 检查：

- 阅读图片 1,500×4,914，渲染宽 755.98 px；`scrollWidth=1440`。
- 文档「插入图片…」弹窗正常；1440 居中，390 触屏为 390×270 底部面板。
- 图片 E2E 5 项在干净 worktree 全部通过。

画面：[1440 插入弹窗](image-insert-dialog-1440.png) · [390 触屏插入](image-insert-dialog-390-touch.png)

## 自动化

| 范围 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `oxlint --type-aware --deny-warnings` | 通过 |
| `oxfmt --check` | 通过 |
| Reader Vitest | 29 文件 / 140 项通过 |
| `make check-rust` | 通过 |
| 设置/控件/图片重点 E2E | 10/10 通过 |
| 完整产品 Playwright（修复后） | 296/298 通过；2 个失败单独复跑均通过 |
| 只读导入记录 | 已修复：目录行按文档标题「已授权文档」匹配，不再误用文件名「共享回执」 |

完整套件失败项（`document-citation-navigation`、`document-global-comparison`）单独复跑均通过，属于共享 AI fixture 并发抖动；干净 worktree 需要同步本地未跟踪的 `bin/librarian/runner/node_modules`，该依赖不属于提交。

## 未证明

- 真实墨水屏和手机软键盘/读屏。
- 320/200% 下标题换行为两行，当前接受为重排结果；若要求单行，需要进一步收窄字号或标题。
