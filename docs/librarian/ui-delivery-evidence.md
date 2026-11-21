# Reader UI 候选版验收

2026-11-21，Fork 的 `feat/librarian-ui` 从 `5e7c47c9` 构建。发行包的源码提交为 `126bd0588ea9f68af2a723dfc93a0d591dd13f4a`。生产构建使用真实 Rust API 和 Markdown 文件，截图使用独立合成数据。原型与实装使用同一篇样例的正文和分别一致的视口。原型的固定 AI 对话用合成模型回执对照，来源链接由真实 Reader API 生成。

## 视觉与任务走查

| 场景 | 实测结果 | 截图 |
| --- | --- | --- |
| 1440 × 900 默认阅读 | 标题、导语和正文共用左缘。目录保留单一入口，文档工具和正文有独立层级。 | [原型](../../../2026-11-21-librarian-ui-delivery/prototype-desktop.png) · [候选版](../../../2026-11-21-librarian-ui-delivery/candidate-desktop.png) |
| 1280、1440、1600 px 桌面阅读与 AI | 开启 AI 后正文起点均移动 0 px，工具宽度分别为 316、336、336 px。旧候选在 1440 px 下工具插入正文前，正文下移 146 px。候选在同一区域显示对话和实际引用，关闭后保留会话。 | [1280 原型](../../../2026-11-21-librarian-ui-delivery/prototype-ai-desktop-1280.png) · [1280 候选](../../../2026-11-21-librarian-ui-delivery/candidate-ai-desktop-1280.png) · [1440 原型](../../../2026-11-21-librarian-ui-delivery/prototype-ai-desktop.png) · [1440 候选](../../../2026-11-21-librarian-ui-delivery/candidate-ai-conversation-desktop.png) · [1600 原型](../../../2026-11-21-librarian-ui-delivery/prototype-ai-desktop-1600.png) · [1600 候选](../../../2026-11-21-librarian-ui-delivery/candidate-ai-desktop-1600.png) |
| 360、390 px 单列阅读 | 正文、提纲和 AI 保持在文档流内，宽表格与代码局部滚动。390 px 从长文深处打开 AI 后面板可见，Escape 回到原阅读位置和按钮焦点。1440 px 的版本面板从长文深处打开也可见。实测主要应用栏按钮至少 44 × 44 CSS px。 | [360 原型](../../../2026-11-21-librarian-ui-delivery/prototype-phone-360.png) · [360 候选](../../../2026-11-21-librarian-ui-delivery/candidate-phone-360.png) · [390 原型](../../../2026-11-21-librarian-ui-delivery/prototype-phone.png) · [390 候选](../../../2026-11-21-librarian-ui-delivery/candidate-phone.png) · [390 AI](../../../2026-11-21-librarian-ui-delivery/candidate-ai-phone.png) |
| 登录、初次写作与恢复 | 密码可切换显示，错误后清空密码，Enter 提交并回到目的页。从目录一次打开新建表单，保存后直接进入编辑并获得焦点。取消离开未保存的正文时保留草稿，新建的文件可在目录打开。即时预览沿用阅读字阶，提纲保留独立 Markdown 编辑。 | [旧登录](../../../ui-audit-2026-11-21/candidate-sign-in.png) · [新版登录](../../../2026-11-21-librarian-ui-delivery/candidate-sign-in.png) · [即时预览](../../../2026-11-21-librarian-ui-delivery/candidate-editor.png) · [提纲](../../../2026-11-21-librarian-ui-delivery/candidate-outline.png) |
| 检索、引用和版本 | 快速打开显示最近、检索与命令分组。跨空间结果显示来源，Escape 返回搜索按钮焦点。独立引用显示出链和反链。AI 可从当前文档检查差异与撤销。 | [快速打开](../../../2026-11-21-librarian-ui-delivery/candidate-command.png) |
| 空间、账号和发布 | 工作区管理页按任务组织。320 px 下用键盘跳转到备份、发布与分享，焦点移到区域标题且应用栏可见。公开快照保留阅读排版与实际分享权限。 | [管理桌面](../../../2026-11-21-librarian-ui-delivery/management/management-desktop.png) · [管理窄屏](../../../2026-11-21-librarian-ui-delivery/management/management-phone-dark.png) · [账号](../../../2026-11-21-librarian-ui-delivery/management/accounts-desktop.png) · [发布](../../../2026-11-21-librarian-ui-delivery/management/release-desktop.png) |

为保持图像可对照，示例正文、主题、视口与选中工具均记录在复核脚本。辅助区优先遵循产品设计中的文档内布局，静态原型的模拟回执和文档元数据应按具体场景比较。320 px 登录页在 200% 文字下无横向滚动，输入仍可操作。输入边界对填充在浅色为 3.69∶1，在深色为 3.68∶1。实际键盘 Tab 焦点可见。墨水屏与减少动效以浏览器设置验证。 [布局测量](../../../2026-11-21-librarian-ui-delivery/measurements.json) · [亮色放大](../../../2026-11-21-librarian-ui-delivery/login-light-320-200.png) · [暗色放大](../../../2026-11-21-librarian-ui-delivery/login-dark-320-200.png)

## 组件与回归

- HeroUI 3.2.7 用于共享按钮、切换按钮、表单与输入，导入集中于 `apps/reader/src/ui/`。目录树、命令面板及已有组合控件复用 React Aria Components 1.22.1。文件选择通过共享 `FilePicker` 使用 React Aria FileTrigger。服务端 MCP 同意页保留原生提交，共用产品主题。
- Tailwind 4 负责编译选用的 HeroUI 组件样式。Librarian 视觉仍由 CSS Modules 与语义 token 控制。保留 Markdown 自身的列表和表格语义。生产共享主题 CSS 为 67.50 kB，gzip 为 6.89 kB。
- Reader API 契约、TypeScript、lint、Oxfmt、生产构建、52 个 Vitest 用例、54 个产品 Playwright 用例和 16 个编辑 Spike Playwright 用例通过。Rust Clippy 以 `-D warnings` 通过。Librarian 与 docs 的 Rust 测试共 85 项通过。
- 隔离浏览器走查确认只读成员看不到文档新建入口，重名后保留表单输入，登录 429 后显示重试提示并清空密码。 [账号状态走查](../../../2026-11-21-librarian-ui-delivery/account-states.log)
- Chromium 145 使用 100,000 字符的普通和富格式 Markdown。输入 p95 分别为 31.8 ms 和 31.6 ms，读写切换 p95 为 80.3 ms 和 91.7 ms。两套语料的保存字节经 SHA-256 核对，返回阅读锚点误差均为 0 px。 [普通长文](../../../2026-11-21-librarian-ui-delivery/performance-plain.log) · [富格式长文](../../../2026-11-21-librarian-ui-delivery/performance-rich.log)

## 内网候选与发行

- 内网试用地址为 `https://192.168.8.166:18444`，账号 `preview-admin` 沿用原试用密码。浏览器需要信任已用于内网预发布的 Caddy 根证书。 [根证书](../../../pre-release-lan/caddy-data/caddy/pki/authorities/local/root.crt)
- 后端绑定 `127.0.0.1:18081`，Caddy 对入口限制来源为 `192.168.8.0/24`。试用数据为 `~/.local/state/librarian-ui-preview/data`，服务为 `librarian-ui-app.service` 和 `librarian-ui-https.service`。阶段 4 实例在 18443 端口继续运行。
- 在宿主机验证了可信 TLS 链、实际浏览器安全上下文、登录、样例正文、独立提纲、文档引用与退出。安装包从干净的分离检出构建，解包后二进制通过初始化、原件读写、备份发布、停机还原、旧版升级和投递凭证迁移。 [内网截图](../../../2026-11-21-librarian-ui-delivery/lan-browser-desktop.png) · [安装包](../../../2026-11-21-librarian-ui-delivery/release/librarian-0.1.0-linux-x86_64.tar.gz) · [SHA-256](../../../2026-11-21-librarian-ui-delivery/release/librarian-0.1.0-linux-x86_64.tar.gz.sha256) · [发行走查](../../../2026-11-21-librarian-ui-delivery/release-smoke.log)

本轮设备覆盖为宿主桌面 Chromium、触屏与窄屏模拟。新界面的实体手机中文键盘、实际读屏、墨水屏和第二台内网设备待复核。模型与备份走查使用本地合成模型回执和临时 Git 目标。内网候选用于 UI 试用，实际模型提供商和 GitHub 远端没有连接到该实例。
