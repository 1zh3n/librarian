# 受管 Reader 的浏览器验收

成员在田野笔记的工作区 AI 读取甲样区，刷新后打开甲的原文，再从同一会话追问乙样区。两轮间在顶栏设置切换自己的模型与思考等级。材料场景使用另一个临时数据目录，成员选择一份 PDF 和一份 DOCX，从回答打开引文核对原句。

## 复跑

从产品 Fork 根目录构建 Reader 后，运行普通产品 Playwright 入口。CI 的产品浏览器任务通过同一入口发现这些用例。

```sh
npm run build -w @librarian/reader
npm run test:e2e:product -w @librarian/reader -- document-managed-chat.spec.ts
```

每个用例创建临时安装目录。Rust fixture 预置成员、文档和带合成凭据的已启用模型连接，通过产品 CLI 注册独立 runner。执行器由发布打包函数安装的 Node、runner 入口与锁定的 Harness 依赖启动。要复核已解包的发行件，将 `LIBRARIAN_MANAGED_BUNDLE` 设置为包含 `bin/node` 的发行目录。Rust 服务与模型均使用临时回环端口，模型端口通过调试构建已有的地址策略放行，runner 校验本次生成的 HTTPS 证书。

模型服务按轮检查模型、等级、消息历史和工具结果。只有检索返回文档 ID 且实际读到 Markdown，服务才给出比较结果。服务要求同轮续调携带原始思考块和签名，跨轮只接受已完成的公开问答。最终答复发出后，服务等待浏览器看到增量正文与“停止”，才结束上游响应。用例检查产品 API 响应、浏览器文字、服务进程日志和 SQLite 逻辑行中的合成私有标记，并以持久化的公开增量作为对照。
