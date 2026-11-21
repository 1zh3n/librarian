# DeepSeek Harness 技术验证

2026-11-21 · 本地替身通过 · 真实模型待测

官方 Harness 可嵌入独立执行器。以合成文档验证了工具隔离、来源、条件写入、断线回执重试及撤销。当前环境未提供 `DEEPSEEK_API_KEY`，真实 DeepSeek 的鉴权、模型选用工具的行为、任务完成率与用量均待测。保留现有执行器，真实模型上的两项固定任务及对比线路通过后再决定产品接入。

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
