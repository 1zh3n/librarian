# 外部客户端访问 Librarian 工作区

将部署的 `/.mcp` 配为客户端的 Streamable HTTP 服务地址。客户端按服务公布的 OAuth 元数据启动授权，用户在 Librarian 登录，核对应用和工作区后同意。使用回调和 PKCE 的公共客户端可以动态注册。凭证续签保留原 grant，使用另一个应用重新授权会得到独立的操作范围。

部署者可在数据根的 `.librarian/server.json` 配置成员收到的阅读地址。修改后重启服务。反向代理负责把公开路径前缀转发到 Reader。

```json
{"publicReaderUrl":"https://docs.example.org/reader"}
```

## 客户端注册和网络限制

客户端可以按服务公布的元数据使用 CIMD（`https://.../client.json` 作为 `client_id`）或回退到动态注册（DCR）。CIMD 要求服务器能访问客户端公布的 HTTPS 地址。系统 DNS 返回透明代理 fake-IP 或其他非公网地址时，服务端会用固定的公共 DoH（`https://cloudflare-dns.com/dns-query`，解析到 `1.1.1.1`）重新查询 A/AAAA，只接受公网结果；正常公网解析不会发出 DoH 请求。回退只发送客户端元数据主机名，不发送文档内容。

如果 DoH 也不可达，授权页才会显示 `SilverBullet could not verify this app, so it cannot connect.`。此时让客户端使用预注册或 DCR 客户端 ID，而不是放宽 SSRF 校验：

- OpenCode 2.3.2：在 `mcp.servers.<name>.oauth.client_id` 写入一个在 `/.auth/register` 注册的公共客户端 ID；配置了 `client_id` 时 OpenCode 不再选择 CIMD。
- Codex 0.171.0：`codex mcp add ... --oauth-client-id <id>` 或 `codex mcp login <name> --oauth-client-registration dcr`。
- 其他客户端：按其文档配置静态客户端，或在 Reader 的「连接」里查看已连接应用后撤销重试。

Codex 还会在 OAuth 发现阶段拒绝私网 IP 字面量作为授权服务器，并要求 Rust 进程信任部署证书。给服务器配置 DNS 主机名、匹配的证书并让 `publicReaderUrl` 使用该主机名，才适合把 Codex 作为验收客户端；`SSL_CERT_FILE` 或系统信任库是部署侧配置。细节和实测记录见交接仓库 `docs/superpowers/specs/2026-11-22-librarian-connections-settings-and-dogfood.md` 的 9.7 节。

`workspace_list` 列出获准的工作区。单篇 Markdown 可调用 `document_create` 或取得当前内容 revision 后调用 `document_update`。两者保留原有请求和版本回执，响应另含 `documentId`、`path`、`readerPath` 和 `readerUrl`。未配置公开地址时写入仍然成功，回执给出相对路径、空的 `readerUrl` 和 `readerUrlError: "reader_url_unavailable"`。链接由服务端配置生成，打开正文仍需当前成员权限。

## 上传方案和附件

调用 `workspace_upload_files`，传 `workspaceId`、`operationId`、`targetDirectory` 和 `files`。每个文件含相对 `path` 和原字节的 `contentBase64`。例如，目标目录选「项目甲」，同时上传「方案.md」和「图.png」，Markdown 中的相对引用可以保持原样。目录根用空字符串表示。

默认只创建。替换现有文件时，在 `updates` 指定相对于目标目录的 `path` 及当前 SHA-256 `baseRevision`。该批次写成一个 Git 版本。相同调用使用原 UUID 重试，读取回执的 `documents` 即可把成员链接发回原对话。网页上传使用 `POST /api/v1/workspaces/{id}/imports`，也接受 `archiveBase64` 形式的 ZIP；已提交回执可通过 `GET /api/v1/workspaces/{id}/imports/{operationId}` 查询。

### Reader HTTP 和 TypeScript 接口

`GET /api/v1/documents/{document}`、创建文档和条件更新都返回同一个 `DocumentSnapshot`。它保留 `document`、`markdown`、`revision`，并包含 `documentId`、`path`、`readerPath`、可空的 `readerUrl` 和可选的 `readerUrlError`。只编辑提纲时，正文和正文 revision 保持原值，嵌套的 `document.outlineEnabled` 反映提纲状态。版本恢复回执的 `snapshot` 也使用该类型。

Reader 客户端提供 `api.importWorkspaceFiles(workspace, body, signal?)` 和 `api.getWorkspaceImport(workspace, operationId, signal?)`。请求类型为 `WorkspaceImportRequest`，文件组和 ZIP 各有一个分支。两个方法都返回 `WorkspaceImportReceipt`，包含 `operationId`、`workspaceId`、`commitId`、`changes` 和 `documents: DocumentMemberLink[]`。

## 批量编辑、确认和撤销

| 工具 | 参数和结果 |
| --- | --- |
| `workspace_apply_edits` | 同一工作区的 `edits` 以路径或文档 ID 定位，含完整 `markdown` 和 `baseRevision`。新建时用路径和 `null` 基线。 |
| `workspace_request_reorganization` | 传 `request: {kind:"move",from,to}` 或 `{kind:"delete",documentIds}`。回执包含待确认计划和 Reader 链接。原账户在 Reader 核对并确认。 |
| `workspace_get_operation` | 传 `workspaceId` 和原 `operationId`，查看当前回执。 |
| `workspace_undo_operation` | 传相同的工作区和操作 ID。服务按已提交内容的版本检查撤销条件，冲突保留后续人工修改。 |

这四个工具与文件上传均使用规范 UUID。回执绑定账户、OAuth client 和 grant。不同 grant 即使属于同一账户也不能读取或撤销该 MCP 操作。Reader 确认时复核原 grant 和当前工作区角色。从已连接应用撤销 grant 会使此前发出的待确认计划失效。旧 `workspace_publish` 继续按原 manifest 和来源范围工作。

## 本机 OAuth 客户端验收

`bin/librarian/tests/mcp_workspace_smoke.py` 使用固定版本的 Python MCP SDK、自建回环回调和临时数据根，驱动动态注册、PKCE、授权、上传带附件的方案、批量改写、撤销及撤回 grant 后再次确认。用含 E1 的 debug 二进制运行：

```sh
uv run --script bin/librarian/tests/mcp_workspace_smoke.py "$CARGO_TARGET_DIR/debug/librarian"
```

脚本使用进程内令牌存储。样本文档和临时账号随夹具退出清理。


在本机隔离实例上，Python MCP SDK 1.30.0 于 2026-11-21 完成了这条路径。实际列出 18 个工具，中文检索命中刚上传的方案。客户端核对了附件条件更新与撤销后的原字节、网页 ZIP 导入、单篇文档创建和更新的成员链接，以及同批改写的提交和撤销。一次删除由成员在 Reader 接口确认后撤销，另一次在确认前撤回授权。旧 access token 再次请求返回 401，原会话确认已撤权请求返回 404；移除工作区成员后，原文档读取也返回 404。
