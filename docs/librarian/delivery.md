# 向 Librarian 投递文档

在 Workspace 管理的投递凭证区创建凭证，把一次性显示的 token 保存到来源项目的秘密变量。该凭证仅可投递到签发时指定的 Workspace。执行 CLI 时使用有 HTTPS 的 Librarian 地址。

```bash
cargo build --locked --release -p docs
export LIBRARIAN_URL=https://librarian.example
target/release/docs push ./docs \
  --workspace ws_example \
  --delivery-id project-docs \
  --source-name "项目文档" \
  --version 2026-11-21
```

`LIBRARIAN_DELIVERY_TOKEN` 由 CI 的秘密变量提供。CLI 可以接收目录、单个文件或 ZIP。目录中的路径以所选目录为根，隐藏目录会跳过。附件按原字节投递。同一 `deliveryId` 隔离在 `deliveries/<deliveryId>/`，相同 manifest 和文件内容重试会返回同一回执。

HTTP 使用 `POST /api/v1/workspaces/{workspaceId}/deliveries`。JSON 提供 `manifest` 和 `files`，文件条目包含 `path`、`contentBase64`。投递 ZIP 时提供 `archiveBase64`。Manifest 包含 `deliveryId`、`sourceName`、可选的 `version` 和 RFC 3339 `generatedAt`。MCP 的 `workspace_publish` 接收 `workspaceId` 与同样格式的 `delivery` 对象。

新投递替换同一目录下由上一版管理的文件。若其中的原件已被人工修改，服务返回冲突并保留现有字节。版本标签变更而文件一致时，该次投递记录可指向同一 Git 版本。平台接收文件副本及必要来源信息，来源项目的读取权由其自身 CI 保留。
