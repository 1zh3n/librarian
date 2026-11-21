# DeepSeek Harness 技术验证

2026-11-21 · 本地替身通过 · 真实模型对比完成，选用 Harness

官方 Harness 可嵌入独立执行器。以合成文档验证了工具隔离、来源、条件写入、断线回执重试及撤销。初次 Spike 只用了本地模型替身。下方记录了后续在真实供应商上执行的两轮对比。

## 基线与组合

| 项目 | 实测 |
| --- | --- |
| Fork | `git@github.com:1zh3n/librarian.git`，`origin` 同 URL，`upstream` 为 `https://github.com/silverbulletmd/silverbullet.git` |
| 检出 | `/home/xia/Projects/Doc/librarian/.superpowers/sdd/access-controls-worktree`，分支 `feat/librarian-reader-experience`，开始时 `e1c2368268b20d1adf905852080bab09d8de48cd`。试验以该工作树中的独立增量交付。 |
| Harness | 官方 npm 包 `0.2.2-rc.5`，Cordis `4.1.0`，MIT。独立 `package-lock.json` 固定包和完整性摘要。源码核对点 `2e39e70496aa02986ca6a820c5d497e816b69d7e` 用于比较组合，实测以发布包为准。 |
| 主机 | Linux x86_64，Node `24.22.1`，npm `11.19.1`，34 个依赖包，`node_modules` 占约 16 MiB。 |
| 模型路线 | `deepseek-flash`，官方 DeepSeek Messages 流式适配器，关闭 thinking，`x-api-key` 鉴权。对比线路沿用 Node 的 OpenAI 兼容 Chat Completions。 |

组合装载 LLM 服务和官方 Messages 适配器、内存 Session 与 projection、系统提示、工具注册中心、原生工具执行器和 Agent 循环。官方 `sdk-minimal` 预设会装载 shell 与图片读取，因此采用显式组合。Agent 每次处理一个租约，工具串行，最多 8 次模型请求，正文及提纲按 UTF-8 计 256 KiB。Runner 不配置 Harness 会话持久化。测试调用中以实际 wire schema 验证问答只有 `search_workspace`、`read_document`，修改增加 `submit_document_edits`。依次去掉三项中的一项时，替身即使硬发调用也会收到 `UNKNOWN_TOOL`，其余工具均未触发。 [官方源码核对点](https://github.com/deepseek-ai/deepseek-harness/tree/2e39e70496aa02986ca6a820c5d497e816b69d7e) · [官方发布包](https://www.npmjs.com/package/@deepseek-ai/dsh-agent-loop/v/0.2.2-rc.5) · [官方 Messages 协议](https://api-docs.deepseek.com/guides/anthropic_api/) · [模型 ID](https://api-docs.deepseek.com/quick_start/pricing/)

Librarian 继续通过现有 `claims`、`documents`、`sources`、`events`、`renew`、`fail` 和 `result` 接口持有权限、来源、版本和操作状态。Runner 从已读来源推导路径及基线，把 staged 修改一次性回传。固定系统指令由 Runner 注入，Workspace 附加指令需等服务端提供可信配置字段。独立示例接受 loopback Librarian，模型地址限 loopback 或官方 Messages，输出仅含结构化回执、工具计数所需的名称及用量、耗时和错误代码。

## 本地证据

样本为 `reader_fixture` 的短期数据根。田野笔记包含两篇 Markdown 及第二篇的提纲，另一个样本空间有独立文档。测试将已有样本账号设为田野笔记的只读成员，以已有写入成员操作修改。节点与 Rust fixture 均为本地进程，模型替身只监听回环接口。

| 路线 | 验证 |
| --- | --- |
| 原 Node 示例执行器 | 5 项通过。带正文及提纲来源的问答，模型短暂中断后恢复，双文件写入在丢失回执后重试，差异与撤销，未读来源及并发修改保护。 |
| Rust `ai_operations` | 10 项通过。覆盖过期租约拒绝迟到结果、并发冲突、来源核验、条件写入和撤销。 |
| Reader `document-ai`、`document-revisions` | 8 项通过。覆盖真实路由的选区、来源链接、差异、撤销、草稿保存和重连。 |
| Harness 独立测试 | 15 项通过，包含 Chromium 读取真实执行回执及点击撤销。官方适配器通过合成 SSE 调用。覆盖三项工具各自缺失、8 轮和 256 KiB 上限、401 鉴权分类、只读用户、租约范围、来源、选区和提纲、重复回执、差异、原字节撤销、超时、伪造来源、权限撤回及并发保存。 |

问答测试通过搜索列出同空间的两个候选，模型只读其中一个。回执显示一个来源、无提交。修改测试读取选区、自由提纲及当前整篇，返回一个已确认 Git 版本，回执丢失后两次 `PUT /result` 的请求体相同，差异显示 `+清晨听见鸟叫。`，撤销后用 UTF-8 字节比较原文。Chromium 渲染该问答的唯一来源链接，并从同一真实写入回执打开差异后点击撤销。真实服务约束也覆盖 `UNREAD_SOURCE`、超时 `MODEL_TIMEOUT`、新人工保存优先的 `revision_conflict` 和撤回写权限后 `403`。

一次带浏览器的本地运行记录如下。token 为替身发送的固定用量，模型耗时不含 Librarian 回传及重试。ID 只对应此次临时数据根。

| 场景 | 模型请求与工具 | 输入 / 输出 token | 模型耗时 | 回执 |
| --- | --- | --- | --- | --- |
| 问答 | 3 次 · `search_workspace` → `read_document` | 60 / 15 | 54 ms | `7544870b-ab7a-4b0c-8c10-142a24a432dd`，成功，1 个来源，无提交 |
| 修改 | 3 次 · `read_document` → `submit_document_edits` | 60 / 15 | 38 ms | `ff5e5d5f-51f4-41ef-90bf-c9d547412fd4`，成功，3 个来源，提交 `2d6207b8c9b4f7a4384f049e066929a6c8580045` |

进程取消测试在暂存之后、最终答复之前触发，验证没有提交或 Markdown 写入。当前 Reader 无用户直接取消操作的公开 API。进程取消后操作由服务端现有租约恢复处理，过期租约拒绝迟到结果由 Rust 集成测试覆盖。

## 复跑

在 Fork 根目录运行下列命令。若同机已有应用，给 Playwright 指定独立 `LIBRARIAN_PRODUCT_TEST_PORT`。公共基线与 Spike 的浏览器测试使用已构建的 Reader 和已安装的 Chromium。

```sh
npm run build -w @librarian/reader
cargo build --locked -p librarian --example reader_fixture
cargo test --locked -p librarian --test ai_operations
export LIBRARIAN_READER_FIXTURE="${CARGO_TARGET_DIR:-$PWD/target}/debug/examples/reader_fixture"
node --test bin/librarian/tests/ai_runner_example.test.mjs
npm run test:e2e:product -w @librarian/reader -- document-ai.spec.ts document-revisions.spec.ts
spike=bin/librarian/examples/deepseek-harness-spike
npm ci --ignore-scripts --workspaces=false --prefix "$spike"
LIBRARIAN_SPIKE_BROWSER=1 npm test --prefix "$spike"
```

共享构建环境使用 `CARGO_TARGET_DIR=/home/xia/Projects/Doc/librarian/target`，并把 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/2026-11-21-librarian-foundation/host/root/usr/lib` 加入 `LD_LIBRARY_PATH`。

## 真实模型复跑条件

从独立的 `reader_fixture` 开始，使用从环境注入的 `DEEPSEEK_API_KEY`。以下启动命令仅指向合成 fixture。每次提交一个任务后运行一次执行器。默认模式为 `deepseek-flash`。

```sh
"$LIBRARIAN_READER_FIXTURE" 46183
```

在另一个终端运行。

```sh
export LIBRARIAN_URL=http://127.0.0.1:46183
export LIBRARIAN_RUNNER_TOKEN=reader-fixture-ai-token-only-for-tests
node bin/librarian/examples/deepseek-harness-spike/runner.mjs --once
```

1. 用 fixture 的 `reader` 账号打开「田野笔记」的 Workspace AI，提交问答「分别查阅河岸清晨与林间回声。这两篇各记录了什么？请逐篇总结。」领取后应显示两个正文实际来源及可点击路径，操作应没有提交。
2. 在「林间回声」打开文档 AI，提交修改「只把正文中的『鸟鸣』改成『鸟叫』，保留其余字节与提纲。」回传后在 Reader 查看差异和单个 Git 版本，点击撤销，比较前后的 `/documents/{documentId}` Markdown UTF-8 字节。
3. 重新启动 fixture，在同一模型和同一初始样本上重复。旧线路以 `OPENAI_BASE_URL=https://api.deepseek.com OPENAI_MODEL=deepseek-flash OPENAI_API_KEY="$DEEPSEEK_API_KEY" node bin/librarian/examples/ai_runner.mjs --once` 领取任务。记录两条线路的鉴权、交互次数、token、响应时间、错误及最终业务回执。旧线路的 CLI 未打印模型调用计数或 token，可通过受控的本地转发测量，或在记录中将这些指标列为缺失。


## 真实 DeepSeek 对比与选型

2026-11-21。选用官方 DeepSeek Harness 作为受管执行器，旧 Node 示例继续服务既有部署。Harness 在两次独立运行中均完成跨文档问答和单文档条件修改。旧 Node 的跨文档问答连续两次在解析模型动作时终止。样本仅覆盖固定的两项任务。

- 基线为 `c1059e7241aa62ebcb704264423b946a79c99f13`，产品工作树为 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/ai-workspace-worktree`，独立分支为 `spike/librarian-ai-workspace`。Fork、origin 和 upstream 与上表相同。开工时工作树干净。Rust 服务继续使用现有 claims、sources、result、diff 和 undo 接口。
- 两轮分别为每条路线启动一套全新的回环 Rust fixture，使用相同的两篇合成文档、提纲、账号和上节固定提示词。模型均为官方 `deepseek-flash`。Harness 使用 Messages 和禁用思考；旧 Node 使用 Chat Completions 和供应商默认思考设置。计时为领取任务的 CLI 墙钟时间，包含服务回传；两种调用配置不同，此处不作速度排名。
- Chromium 实际点开「野外/01.md」「野外/02.md」两条来源并返回。回答分别概括湿地水位和林间鸟鸣，服务端问答无 Git 提交。修改指定的正文一处，提纲保持原样。每次成功修改的版本列表只增加一项，Reader 展示期望 diff，由界面撤销。
- 四次修改前与撤销后的 UTF-8 SHA-256 均为 `fd913a8fa2e95c21dd587d6f4f61e9610a602ec41ed04db0917566613f517d04`，修改后均为 `188a932223a082510b40360346cbe75925ad412ca53c3d6d31b8c0805a311534`。
- 旧 Node 两次问答的供应商 HTTP 状态均为 200；第一步模型消息不能解析为执行器要求的 JSON，没有来源或版本。重测记录到 content 为 160 字符字符串且没有原生工具调用。Harness 两轮回执均无工具错误。表中 token 按各官方适配器的 usage 计数，旧 Node 通过只观察状态和用量的 fetch 探针计量。

| 轮次 | 路线 | 任务 | 模型请求 | 工具／动作 | 输入 / 输出 token | 耗时 ms | 操作 ID | 新版本 | 结果 |
| --- | --- | --- | ---: | --- | ---: | ---: | --- | --- | --- |
| 1 | harness | 问答 | 3 | search_workspace → search_workspace → read_document → read_document | 2272 / 744 | 5810 | cf377423-b436-4061-a97f-ecbbb48de289 | 无 | 通过 |
| 1 | harness | 修改 | 3 | read_document → submit_document_edits | 810 / 200 | 3081 | ad265508-8fd2-4725-b15b-3211d9c60622 | 6b69cda166499cb0b9c13792864928aa34b7d0e7 | 通过 |
| 1 | node | 问答 | 1 | 首个响应无法解析为动作 JSON | 299 / 54 | 670 | a616fb4f-fd3b-4028-be28-df4f213f205e | 无 | 失败 |
| 1 | node | 修改 | 1 | finish | 484 / 264 | 1838 | 43195712-def0-48b9-9ab7-3888c16ab9ab | 398be90cf12feeaab32cf1f8deef84d1dcca3193 | 通过 |
| 2 | harness | 问答 | 3 | search_workspace → search_workspace → read_document → read_document | 2052 / 517 | 4137 | 3e855820-7835-4fd4-8430-ffafb62bd91f | 无 | 通过 |
| 2 | harness | 修改 | 3 | read_document → submit_document_edits | 853 / 217 | 2794 | 221afcbf-c2a8-4137-a93f-1f6c97992e30 | 7dba67a516f8a4b548e8f43053eb5e61e053d50d | 通过 |
| 2 | node | 问答 | 1 | 首个响应无法解析为动作 JSON | 299 / 54 | 818 | 2a5e0ac1-e762-40f9-a046-e64c2ea4cc9c | 无 | 失败 |
| 2 | node | 修改 | 1 | finish | 498 / 411 | 2766 | c7ed3b94-cde9-4561-8d06-baeecc8e1ead | d7638fc062a11994e7df6791d02d365392bae0eb | 通过 |

认证目录 `GET /models` 于 2026-11-21 13:44 UTC 返回 200。返回的两个 ID 为 `deepseek-flash` 和 `deepseek-v4-pro`，名称为 DeepSeek-V4.1-Flash 和 DeepSeek-V4-Pro，均声明 low、high、max，默认 high。仅 flash 执行了上述生成任务。目录为此次响应样本，产品应采用发现结果。

受管适配注意事项：此次 Harness 真实任务显式关闭思考。锁定版本的 Messages 序列化器在没有设置等级时会写入 high，且总会携带 thinking。A3 需要在受管传输边界实现“供应商默认”省略这两个参数，保留所选动态等级，按实际脱敏请求和回包验收。用户配置的端点需要支持模型目录和 Messages。

同一工作树复跑 Reader 构建、10 项 Rust AI 操作、5 项旧 Node、15 项 Harness（启用 Chromium）、10 项 AI 和版本浏览器用例、11 项 Fork 接缝及 6 项投递用例。既有 MCP 工具和权限回归通过；新增受管协议、网页配置和真实外部客户端发行验收属于后续工作。
