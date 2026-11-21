# Librarian 0.1.0 本地发行验收

发行候选 `dd1fcbd2e6f44848f093ac5e786f1fe7d62eed04` 位于 Fork 分支 `feat/librarian-phase-4`。阶段 4 从 `cea8552f` 开始。验收使用 Linux x86_64、Rust 1.99.1、Node.js 24.22.1、Git 2.56.0、Chromium 145 和 Zola 0.23.6。安装归档使用本机 GNU 目标，Librarian 需要 glibc 2.39 或更新版本。 [安装与恢复](deployment.md)

## Git 备份和发布

- 6 项备份集成使用真实的临时裸仓库。验证分组、逐操作、独立目标、接收端阻塞时保留本地写入、失败后用原固定版本重试，以及重启后按远端 ref 补记回执。Git 备份配置由部署者管理，Workspace 管理者选择目标并启动任务。 [Git 备份说明](git-backup.md)
- 3 项 Zola 集成运行固定版本的 `zola build`。验证原始附件、标题和元数据转换、真实生成的 HTML 路径、重复请求、slug 冲突、缺失附件、修复模板后的重试，以及对目标已有内容的保护。
- OAuth MCP 集成验证普通可写成员只能建立待确认发布记录。只读成员无法请求。Workspace 管理页显示目标、完整 Git 版本和所选文档，再由管理者确认构建和提交到本地目标。 [Zola 目标配置](zola-publication.md)

## 浏览器和设备

- 真实产品浏览器测试验证显式保存固定地址及附件。测试同时切换离线状态和阻断 Service Worker 到服务器的请求，再从直接地址刷新。未保存的地址、编辑和搜索保持在线。撤销、退出和切换账号清除对应离线内容。
- 360 px 的触控仿真覆盖正文宽度、代码和表格各自滚动、灰阶、减少动画和刷新。检查主要阅读按钮至少 24×24 CSS px、键盘焦点可见及灰阶正文黑字白底。 [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- 阶段 0 已在 Android 17、Edge 和搜狗软键盘实测中文组合输入、选区和锚点。阶段 1 在实际产品页上用桌面 Chromium 和 IBus 复测原文保存。阶段 4 验收时 ADB 无设备，实际产品页的手机键盘和实体墨水屏刷新留待真机复测。 [阶段 0](phase-0-evidence.md) · [阶段 1](phase-1-evidence.md)

## 长文表现

用解包后的发行二进制、实际 Space 和 Chromium 145.0.7632.6 测量。每组语料有 100,000 个 UTF-16 单位，记录 20 次输入和 10 次读写切换。逐个核对 HTTP 前端资源的 SHA-256，并验证保存字节及深处锚点。采用 `apps/reader/tests/measure-document.mjs`，富标题场景设置 `LIBRARIAN_PERF_RICH_PATTERN=1`。

| 语料 | 输入 p95 | 切换 p95 | 回到阅读的锚点误差 |
| --- | ---: | ---: | ---: |
| 基准正文 | 31.5 ms | 85.0 ms | 0 px |
| 带行内强调的标题 | 31.2 ms | 95.0 ms | 0 px |

两组都达到输入 50 ms 与切换 150 ms 的参考线。空行隔开的安全单行编辑可使用局部分析，含列表起始符号、跨行结构或定义时继续走完整解析。

## 发行与恢复

- 从干净检出用 `npm ci --offline` 安装锁定依赖并构建。发行包自带嵌入 Reader 的 `librarian`、`bin/docs`、独立 AI 执行器、部署指南与依赖许可证清单。CodeMirror、Lezer、Vite 与 Rolldown 的许可证随包提供。
- 解包后二进制以临时数据根初始化管理员并运行真实 REST 和独立 Node 执行器。验收了并发基线拒绝、两份文档同一 Git 批次写入与撤销、CLI 原始附件投递及重试、固定地址、独立 Git 备份、真实 Zola 构建和确定的发布回执。
- 停机导出临时数据根，解包到新的目录，重新读到原件、固定地址、备份回执及发布回执。撤销分享返回 404，重新提交已退出的 cookie 返回 401。
- 用阶段 2 的实际发行二进制创建 Workspace 和文档历史，再以新版打开同一数据根。升级保留原 Workspace、文档 ID 和 Git 提交，并新增备份设置。旧二进制 SHA-256 为 `aa9f74489894d042e6f8e31cf0453e645e5aa945c1cbcbdd24180ee94032e7fe`。
- 归档通过 `sha256sum --check`。固定归档权限、归档时间与嵌入资源时间后，使用不同 umask 重建归档，逐字节相同。SHA-256 为 `289ee61d1a42a8a880a330ef62ec5dd201a5e115851ca760e03502a84d9fd8fb`。 [Linux x86_64 归档](../../../phase-4-release/librarian-0.1.0-linux-x86_64.tar.gz) · [SHA-256 文件](../../../phase-4-release/librarian-0.1.0-linux-x86_64.tar.gz.sha256)

## 自动检查

- 74 项产品 Rust 集成、3 项 docs CLI 单测、1,357 项 server 库测试及 177 项上游 MCP 测试通过。server 库保留 2 项已有忽略测试，其中一项是由重启测试调用的子进程入口。发行配置另运行 5 项入口测试。
- 产品 Playwright 42 项、Spike Playwright 16 项、Vitest 52 项、独立 Node 执行器 5 项通过。
- Rust 格式和严格 Clippy、Reader 的 OpenAPI 验证、类型、严格 lint、格式以及 Vite 生产构建通过。产品正常 Rust 依赖树和实际发行入口无 Chrome Runtime、Lua、Shell 和 Proxy 产品能力。现有 CI 产品测试安装并核对固定的 Zola 归档。

## 外部目标和设备

Git 备份传输验收使用独立临时裸仓库。真实 GitHub 目标需配置专用仓库、写入凭证及可信主机公钥。Zola Publisher 将选定版本提交到部署者配置的本机 bare 仓库，站点托管由部署流程负责。测试使用本机模型替身。真机复测和外部目标接入可在具备设备、目标和授权后进行。
