# 向 Librarian 投递文档

## 从浏览器导入文件

打开「空间设置 → 外部导入 → 导入文件」。有写入权限时，可选一个或多个 Markdown 文件，或者一个包含文档和附件的 ZIP，再确认导入。成功后回执展示文件变更，可直接打开其中的 Markdown。只读成员可以查看该空间的回执。

新批次自动分配来源 ID。请求没有返回时，重试同一次导入会复用来源 ID 和原 manifest。刷新后，页面按新批次 ID 核对回执。浏览器会丢失文件选择，若未查到回执，页面会提示重新选择同一批文件。通过历史回执的「更新此来源」可继续使用原来源 ID，并填写来源名称、版本和生成时间。更新时请选择该来源的完整文件集。如果更新请求中断后刷新，可重新选择同一批文件，再提交原 manifest 以取得对应回执。

## 从项目自动导入

项目需要持续交付文档时，空间管理者可在「空间设置 → 外部导入 → 项目自动导入」中签发凭证。同一项目沿用固定的来源 ID，将一次性显示的凭证保存到来源项目 CI 的秘密变量。凭证绑定签发时的 Workspace 和来源 ID，有效期为 90 天。该区域提供引用环境变量的命令示例，列表可以查看到期时间和最近回执。执行 CLI 时使用有 HTTPS 的 Librarian 地址。

```bash
cargo build --locked --release -p docs
export LIBRARIAN_URL=https://librarian.example
target/release/docs push ./docs \
  --workspace ws_example \
  --delivery-id=project-docs \
  --source-name "项目文档" \
  --version 2026-11-21
```

`LIBRARIAN_DELIVERY_TOKEN` 由 CI 的秘密变量提供。CLI 可以接收目录、单个文件或 ZIP。目录中的路径以所选目录为根，隐藏目录会跳过。附件按原字节投递。同一 `deliveryId` 隔离在 `deliveries/<deliveryId>/`，相同 manifest 和文件内容重试会返回同一回执。

从阶段 4 升级时，旧的工作区级投递凭证会被撤销。应用保留历史投递与回执。使用原先的 `--delivery-id` 为各来源重新签发凭证，替换 CI 秘密变量。轮换时可先启用新凭证，确认投递后再撤销旧凭证。

HTTP 使用 `POST /api/v1/workspaces/{workspaceId}/deliveries`。JSON 提供 `manifest` 和 `files`，文件条目包含 `path`、`contentBase64`。投递 ZIP 时提供 `archiveBase64`。Manifest 包含 `deliveryId`、`sourceName`、可选的 `version` 和 RFC 3339 `generatedAt`。MCP 的 `workspace_publish` 接收 `workspaceId` 与同样格式的 `delivery` 对象。

新投递替换同一目录下由上一版管理的文件。若其中的原件已被人工修改，服务返回冲突并保留现有字节。版本标签变更而文件一致时，该次投递记录可指向同一 Git 版本。平台接收文件副本及必要来源信息，来源项目的读取权由其自身 CI 保留。
