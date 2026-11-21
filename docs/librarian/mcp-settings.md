# Reader 连接设置与已连接应用

2026-11-22，产品提交 `73f3442e`（连接设置 `d84ca08c` 加设置布局调整）。设计、狗粮背景和交接仓库证据见交接仓库的 `2026-11-22-librarian-connections-settings-and-dogfood.md`。

## 入口和权限

- 顶栏「设置」→「连接」。
- 所有登录用户都能看到 MCP 状态、接入地址、客户端片段和自己的已连接应用。
- 只有服务器管理员能启停 MCP。
- `SB_MCP=0`/`false` 是部署级关闭，网页显示不可用并拒绝启用。
- 撤销 grant 必须同源；只能撤销当前账户自己的 grant。

## 产品 API

```text
GET  /api/v1/mcp/settings        authenticated
PUT  /api/v1/mcp/settings        server admin, same origin  {enabled}
GET  /api/v1/mcp/grants          authenticated, own grants
DELETE /api/v1/mcp/grants/{id}   authenticated, own grant, same origin -> 204
```

`McpSettings` 返回 `enabled`、`available`、`disabledByEnv`、`endpoint`、`publicReaderUrl`、`publicReaderUrlError`。grant 摘要只返回客户端名称/类型、空间名称、scope、创建和最近使用时间，不返回 token、resource 或 credential version。

`publicReaderUrl` 本期只读；未配置时成员阅读链接为空，UI 复制部署 JSON，写入仍需重启。

## UI

- 管理员服务卡：状态、启停、端点、`publicReaderUrl` 状态、部署关闭原因。
- 所有用户：端点复制、OpenCode/Codex/Claude Code/ChatGPT 片段、账户权限说明。
- 已连接应用：名称、类型、空间、创建/最近使用、撤销确认和焦点恢复。
- 320 px / 200% 字体下弹窗和内容无横向溢出；连接标签可换行，撤销可达。

## 验收

本地：

- `cargo test --locked -p librarian --test mcp_settings_api` — 4/4
- `cargo test --locked -p librarian --test fork_seams` — 14/14
- `cargo test --locked -p silverbullet-server --lib product::mcp_settings` — 2/2
- `cargo test --locked -p librarian` — 全部通过
- `npm run test -w @librarian/reader` — 125/125
- `npm run test:e2e:product -w @librarian/reader -- --workers=1` — 282/282（本机 `/tmp` 放 Zola 0.23.6）
- `npm run test:e2e -w @librarian/reader` — 40/40
- `cargo fmt --check`、`cargo clippy -p librarian --all-targets -D warnings`、TypeScript、Oxlint、Oxfmt、OpenAPI 生成一致性 — 通过

18447：

- 部署 `73f3442e`，数据根备份 `pre-settings-ui-73f3442e-20261122-051607`。
- 设置弹窗在 1440 下固定 736 px：外观、AI、连接切换高度不变，内部滚动；AI 先显示「我的模型」，连接配置和全局执行器可折叠；模型能力显示为「输入 文本、图片 · 输出 文本 · 1M 上下文」，展开后显示精确的 1,048,576 / 393,216 tokens。
- 管理员 `ai-review`：设置 → 连接显示已启用；停用后 POST `/.mcp` 返回 404，重新启用后返回 401。
- 成员 `ai-agent`：看不到服务开关；3 个测试 grant 通过新 UI 全部撤销，列表为空。
- 原有「AI 工作区验收」16 篇文档和「Librarian 项目文档」保持。

未覆盖：

- OpenCode/Codex/Claude Code/ChatGPT 的真实 OAuth 连接。
- 按工具/账户的审计、速率限制和存储配额。
- 空间「外部访问」子页。
- 实体手机中文输入、读屏和墨水屏。

CI 的 `CI` workflow 当前在 GitHub 仓库中被手动禁用，因此本次推送没有新的远端 CI 运行；本地等价检查已通过。
