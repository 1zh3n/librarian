# 受管 Reader 的浏览器验收

成员在田野笔记的工作区 AI 读取甲样区，刷新后打开甲的原文，再从同一会话追问乙样区。两轮间在顶栏设置切换自己的模型与思考等级。材料场景使用另一个临时数据目录，成员选择一份 PDF 和一份 DOCX，从回答打开引文核对原句。

## 复跑

从产品 Fork 根目录构建 Reader 后，运行普通产品 Playwright 入口。CI 的产品浏览器任务通过同一入口发现这些用例。

```sh
npm run build -w @librarian/reader
npm run test:e2e:product -w @librarian/reader -- document-managed-chat.spec.ts
```

每个用例创建临时安装目录。Rust fixture 预置成员、文档和带合成凭据的已启用模型连接，通过产品 CLI 注册独立 runner。执行器使用发行打包函数放入临时目录的 Node 和 runner 入口，依赖来自 CI 预先安装的 runner 锁文件。浏览器用例本身全程离线。要复核已解包的发行件，将 `LIBRARIAN_MANAGED_BUNDLE` 设置为包含 `bin/node` 的发行目录。Rust 服务与模型均使用临时回环端口，模型端口通过调试构建已有的地址策略放行，runner 校验本次生成的 HTTPS 证书。

模型服务按轮检查模型、等级、消息历史和工具结果。只有检索返回文档 ID 且实际读到 Markdown，服务才给出比较结果。服务要求同轮续调携带原始思考块和签名，跨轮只接受已完成的公开问答。最终答复发出后，服务等待浏览器看到增量正文与“停止”，才结束上游响应。用例检查产品 API 响应、浏览器文字、服务进程日志和 SQLite 逻辑行中的合成私有标记，并以持久化的公开增量作为对照。

## checkpoint 的实测

2026-11-21，在进入 Reader 集成分支前，Chromium 运行了下列两个用例。两者均通过。截图来自 `b6ada3b3` 所记录的 AI 工作树状态，使用合成数据和本地 HTTPS 模型。另以已解包候选件内的 Node 和 runner 单独复跑两轮比较，通过。

| 操作 | 浏览器和服务实测 | 截图 |
| --- | --- | --- |
| 第一轮读取甲，刷新后改用另一模型追问乙 | 第一轮为 field-observer · low，第二轮为 field-compare · high。上游保持连接时可见增量正文与“停止”。完成后，两轮各自保留模型标签和实际来源，可分别打开甲、乙原文。SQLite 的公开增量与两轮最终正文一致。 | [流式回答](checkpoint/comparison-stream.png) · [两轮与来源](checkpoint/comparison-desktop.png) |
| 窄屏输入后继续聊天 | 320 × 844、390 × 844 的 200% 根字号下，输入框及“询问”可以滚动到视口内，页面没有横向溢出。两次均启用 Chromium 减少动效模拟。 | [320 px](checkpoint/comparison-320-text100-reduced.png) · [200% 文字](checkpoint/comparison-390-text200-reduced.png) |
| 选择两个文件，核对引用 | 预算 PDF 第 2 页显示“预算为七十。”；会议 DOCX 第 2 段显示“复核数字为四十二。”。收起原文后，焦点回到相应引用。 | [PDF 页码](checkpoint/pdf-page-2.png) · [DOCX 段落](checkpoint/docx-paragraph-2.png) |

集成分支沿用同一用例，并增加两个断言。成员保存模型偏好后按 Escape，焦点回到顶栏设置。窄屏下成员可以把第二轮正文完整滚动到阅读位置，再输入下一问。
