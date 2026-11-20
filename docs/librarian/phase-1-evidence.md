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
