# 管理与只读阅读的组件迁移验收

## 范围与对照

按改版计划阶段零、四，检查外部导入、Git 备份、站点发布、账号管理、只读固定地址与离线副本。从有相应权限的用户进入页面起，记录能否用键盘完成操作、区分禁用与可提交状态、从错误恢复，并核对回执或最终正文。

阶段一的 `393e9afd → b58ef36d` 已覆盖分享表单首屏、长清单筛选与快照目录收起。本轮复用这些画面作为历史背景，本次控件的比较另取同状态截图。[阶段一逐页走查](reader-ux-web-audit.md) · [分享表单对照](evidence/reader-ux-web/sharing-after.png) · [快照正文对照](evidence/reader-ux-web/snapshot-after.png)

迁移前使用 `feat/librarian-reader-ux@f949f454` 的归档构建。独立 Rust 产品服务监听 `127.0.0.1:4282`。桌面 Chromium 145，中文、浅色、1440×900 CSS px。窄屏另外使用模拟触摸、减少动效、320／360／390 px，含 390 px 下根字号 200% 与暗色。Git 和 Zola 0.23.6 的目标都是本地合成仓库。文件选择由浏览器发出选择器事件后注入合成文件。设备读屏、系统文件对话框内的操作和公网发布须单独验收。

## 迁移前实测

| 页面 | 操作与观察 | 证据 |
| --- | --- | --- |
| 外部导入 | 从旧 `#release` 入口用左方向键切到导入。Enter 选择空文件后提示并禁止提交。改选有效 Markdown，服务端接收后模拟丢失响应，原文件名可见。Tab、Enter 重试，两次请求内容完全相同，回执新增一篇。键盘焦点同时描边按钮和设置容器。 | [重试导入](evidence/reader-management/before-import-retry.png) |
| Git 备份 | 未选目标时「立即备份」禁用。Enter 打开选择器，End 聚焦末项，Esc 回到触发器且取消选择。选「本地备份／逐操作」后模拟设置 PUT 断线，出现「无法保存备份设置」，两个字段回到默认值。重新选择并保存后可完成本地 Git 备份。 | [末项键盘焦点](evidence/reader-management/before-backup-choice.png) · [触摸暗色](evidence/reader-management/before-touch-dark.png) |
| 站点发布 | 方向键进入子标签，键盘选择本地博客，Space 勾选一篇。输入无效版本并提交后，目标、版本文本及勾选仍在；换成实际的提交 ID 后本地发布成功。错误位于提交按钮上方，同时可见两层容器焦点线。 | [错误与选中范围](evidence/reader-management/before-publication-error.png) |
| 账号管理 | Tab 从用户名到初始密码，Enter 创建重复账号，表单内出现「该用户名已经存在」。返回用户名修改后 Enter 创建成功，密码框清空。 | [纠正重复账号](evidence/reader-management/before-account-error.png) |
| 固定阅读地址与离线 | 固定稿只显示阅读、目录和离线动作。断网保存副本收到错误，恢复网络后按 Enter 重试成功。展开两篇目录后选择另一篇，焦点进入该篇标题。新页断网打开已存地址并显示离线状态。另用独立的持久浏览器资料保存同一旧地址，供升级复核。 | [固定稿目录](evidence/reader-management/before-snapshot-directory.png) · [旧副本记录](evidence/reader-management/legacy-before.json) |

[迁移前逐控件数据、错误恢复与键盘结果](evidence/reader-management/before.json) · [触摸目标尺寸与页面宽度](evidence/reader-management/before-touch.json)

基线针对管理与快照的 19 项产品浏览器用例全部通过，含只读成员仅能查导入记录、旧管理页锚点、固定稿附件、撤销地址、登出及换号清理离线副本。另延迟账号创建请求，实测等待中按钮显示「正在创建…」并禁用，重复 Enter 仅产生一个 POST。[19 项回归明细](evidence/reader-management/before-regression.json) · [必填、键盘、悬停、按下和等待状态](evidence/reader-management/before-states.json)
