# 阶段 1 验收记录

## 环境

- Fork Clone URL 和 `origin` 均为 `git@github.com:1zh3n/librarian.git`。
- `upstream` 为 `https://github.com/silverbulletmd/silverbullet.git`。
- 实现分支为 `feat/librarian-phase-1`，基线为阶段 0 的 `8255de1a68ce0b5a8a9276a74754f132f8a95d19`。
- 本地工作区位于 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/phase-1-worktree`。

## 1.1 文档身份和条件写入

测试先从产品 Router 请求真实临时 Space，初次运行六个用例因新路由缺失得到 404。浏览器登录用例随后在已有授权页只接受 MCP 返回路径时得到 400。

实现后，`cargo test --locked -p librarian` 通过 18 项测试。新增 9 项测试覆盖以下行为。

- 账号只列出有权限的 Workspace。同路径在不同 Space 拥有不同的文档 ID。重开数据根后，SQLite 的 Workspace 与路径映射保留原 ID。
- 含 BOM、CRLF、尾随空白的正文按原字节读取，空文件正常打开，非法 UTF-8 返回 422。
- 同路径并发创建只有一个请求成功。已有文件返回 409。保存使用 SHA-256 内容 revision，旧 revision 返回 409 和当前 revision，落盘正文继续保持已保存版本。省略条件返回 428。
- 读权限账号写入返回 403，空间外账号读取返回 404，未登录返回 401。Cookie 会话只在同源写入成功。MCP 授权流程的原有测试继续通过。
- 数据根作为 Space 时，产品 SQLite 目录通过原生控制目录规则从文档列表和写入路径排除。全文索引测试在 1.2 复验该规则。
- OpenAPI 响应结构与实际 Workspace、正文及错误响应一致。Reader CI 检查锁定生成器的 TypeScript 输出。

`cargo fmt --all -- --check`、`cargo clippy --locked -p librarian --all-targets -- -D warnings`、Reader 的 `api:check`、类型检查、严格 lint、格式检查及 14 项 Vitest 均通过。

## 1.2 阅读画布、目录与搜索

- 搜索集成测试先因路由缺失返回 404。接入原生 Tantivy 后，同一检索词在两个 Space 中分别检索。返回正文 ID 与目录一致，提纲文件和服务器控制目录从结果排除。
- Chromium 测试运行生成的 Reader 资源和 Librarian 产品 Router，使用临时数据根、真实登录及原生 Space。初次测试发现登录表单发送 `Origin: null`。将表单的 Referrer Policy 改为 `strict-origin` 后，浏览器发送同源 Origin，服务端保留原有同源校验。替换旧入口前，浏览器成功登录并确认深链接仍显示 Spike 内容。
- `test:e2e:product` 通过 4 项，覆盖刷新深链接、单一搜索入口、中文搜索与键盘打开、目录定位，以及 360 px 下正文无横向溢出且代码和表格可以各自横向滚动。1280 px 下收起左栏并打开文档目录后，正文宽度仍超过 560 px。
- 产品包按工作区、文档和命令面板拆分。Spike 移入 Vite 开发路径 `/spike`，原有 16 项 Playwright 回归继续通过。
- 19 项产品 Rust 测试、14 项 Vitest、OpenAPI 生成校验、Rust 格式和严格 Clippy、Reader 类型检查、严格 lint、格式检查与生产构建通过。React Aria 1.22.1 的两个类型声明在严格检查前去掉了由依赖重复定义的 DOM 属性，保留 React Aria 的定义和 TypeScript 严格项。

## 1.3 条件保存、源码和自由提纲

- 提纲测试最初收到 404。实现后，正文与 `.outline.md` 分别校验各自的 revision。提纲首次读取返回空 Markdown 和 null revision，写入冲突返回 409，只读账号返回 403，缺少条件返回 428。测试直接读取磁盘并比较 BOM、混合换行和尾随空白。
- Chromium 在客户端拦住第一次 PUT 的响应。其中的正文为原字节加“甲”，baseRevision 为初始版本。停留期间输入“乙”，待第一次响应返回后第二次 PUT 才发送，baseRevision 为第一次返回的 revision，正文为原字节加“甲乙”。重新加载后仍能看到两个字。
- 浏览器断网时，编辑器保留草稿且磁盘保留原文。网络恢复后浏览器重试保存。另一个请求先保存时，本地显示冲突并保留未保存内容，服务器保留已经写入的版本。草稿可以下载。
- 提纲收起再打开时仍保留自己的撤销。源码和即时预览使用同一 CodeMirror 会话。完整源码在菜单关闭后继续保持编辑焦点，撤销测试通过。
- 添加标签仅修改目标 YAML 值。实测保留 BOM、CRLF、注释、自定义属性及正文空白，单测覆盖已存在的块序列和无法解析的 YAML。
- 20 项产品 Rust 测试、21 项 Vitest、10 项真实产品 Playwright、16 项 Spike Playwright、OpenAPI 校验、严格 Clippy、Reader 类型检查、严格 lint、格式检查和生产构建通过。

## 1.4 Git 历史、Diff 和恢复

- 新路由缺失时，四项历史集成测试均失败。实现后，两笔快速保存在真实受管 Space 的 5 秒安静期结束后归为一个带账号归属的 Git 提交。测试直接读取该 Git blob，确认 CRLF 保留。
- 产品 Diff 返回请求的提交及其 Markdown。恢复先检查基线，冲突时原文和提交列表均保持原状。成功时保留原始提交及待归档人工版本，再生成一个恢复提交。测试逐个读取三个 Git blob，并比对恢复后的磁盘字节。
- 文档内嵌版本面板可读取版本、展示 Diff 并恢复。Chromium 从真实 Space 编辑一份文档，打开旧版 Diff 后完成恢复，读取服务端和实际 Git 历史确认原文与提交。版本浏览器测试运行在独立 Space，避免其他同跑测试延迟其安静期。
- 24 项产品 Rust 测试、21 项 Vitest、11 项产品 Playwright、OpenAPI 校验、Rust 格式和严格 Clippy、Reader 类型检查、严格 lint、格式检查及生产构建通过。
