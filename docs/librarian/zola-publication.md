# 本地 Zola 发布

部署者在数据目录的 `.librarian/publication-targets.json` 配置目标。每个目标绑定一个 Workspace。管理者从发布设置选择目标，或确认外部工具提出的发布。工具也可以调用 MCP 的 `publication_request` 建立待确认记录。

```json
{
  "targets": [
    {
      "id": "personal-blog",
      "label": "个人博客",
      "workspaceId": "ws_0123456789abcdef0123456789abcdef",
      "repository": "/srv/local-targets/blog.git",
      "branch": "main",
      "contentPath": "content/articles",
      "template": "article.html",
      "baseUrl": "https://example.test/docs"
    }
  ]
}
```

`repository` 指向数据目录以外的本地 bare Git 仓库。目标分支需已有提交，并包含可构建的 Zola 配置、模板和现有站点内容。目标仓库及模板由部署者维护。安装 Zola 0.23.6 并加入 `PATH`，或设置 `LIBRARIAN_ZOLA` 为该版本的可执行文件路径。 [Zola 0.23.6](https://github.com/getzola/zola/releases/tag/v0.23.6)

发布选择一个已有的 Workspace Git 提交和一组文档。按目标匹配 `publication` 中的 `slug`。转换标题、`published_at`、`tags` 与草稿状态，并应用目标模板。相对 Markdown 链接必须指向同次选择的正文。附件从同一 Git 版本读取，保持原始字节。标签要求站点配置 `tags` 分组。 [Zola Page](https://www.getzola.org/documentation/content/page/) · [Zola Section](https://www.getzola.org/documentation/content/section/) · [Zola 内部链接](https://www.getzola.org/documentation/content/linking/)

确认后先在临时检出运行 Zola 构建。构建通过后更新目标 Git 分支。后续发布按清单更新或移除上次生成的文件，遇到独立文件冲突或已生成文件被手动修改则保留目标原件并报告失败。相同操作 ID 重试返回已保存的回执。发布 URL 取目标基址与首个非草稿文档的路径。

| 操作 | HTTP 路径 |
| --- | --- |
| 查看目标 | `GET /api/v1/publications/targets?workspaceId=…` |
| 查看发布记录 | `GET /api/v1/publications?workspaceId=…` |
| 创建记录 | `POST /api/v1/publications` |
| 查看单条状态 | `GET /api/v1/publications/{id}` |
| 确认执行 | `POST /api/v1/publications/{id}/confirm` |

创建记录包含 `workspaceId`、`targetId`、`commitId`、`documentIds` 和规范 UUID `operationId`。管理者可同时传入 `confirm: true`。发布记录状态为 `pending`、`published` 或 `failed`。更改目标配置后重新建立发布提案。
