# AI 工作区候选验收

AI 功能在 `spike/librarian-ai-workspace` 保存到 `b6ada3b3`。集成分支 `feat/librarian-reader-ai-integration` 从远端 Reader UI 的 `999a4531` 建立。2026 年 11 月 21 日的网页验收使用独立 HTTPS 服务、受管执行器和合成文档。

## 集成后的真实 Reader 与 DeepSeek

从顶栏「设置 → AI」显式启用受管执行器。个人偏好选择 DeepSeek V4 Pro、思考等级 high，保存后关闭弹窗，再从顶栏打开。浏览器回读模型和等级，密钥框为空，关闭后焦点回到设置按钮。复测的四个视口横向溢出均为 0 CSS px。[1440 px](evidence/ai-workspace/settings-reopened-1440.png) · [390 px](evidence/ai-workspace/settings-reopened-390.png) · [360 px](evidence/ai-workspace/settings-reopened-360.png) · [320 px](evidence/ai-workspace/settings-reopened-320.png)

在 80 段的文档中选中第 39 段，请模型读出甲组在柳树湾观察到的 37 只白鹭。下一轮让它读取乙组记录，它引用东桥的 52 只并给出差值 15。先输入追问草稿，按 Enter 打开回答中的乙组引用，然后用浏览器后退。原引用重新获得键盘焦点，草稿保留。发送第三轮后，两次请求的选区均为同一文档、同一 revision、UTF-16 区间 [637, 659)，三次服务端回执属于同一会话。正文段落距视口顶部前后均为 458.21875 CSS px，对话滚动位置前后均为 268 CSS px。[返回时的阅读位置与对话](evidence/ai-workspace/selection-back-1440.png)

| 实际生成 | 模型与思考等级 | 发出请求至完成 | 回执中的来源数 |
| --- | --- | ---: | ---: |
| 读取选区 | `deepseek-flash` · low | 7.1 秒 | 2 |
| 跨文档比较 | `deepseek-v4-pro` · high | 18.8 秒 | 3 |
| 返回后追问 | `deepseek-v4-pro` · high | 20.0 秒 | 3 |
| PDF 与 DOCX | `deepseek-flash` · low | 5.8 秒 | 2 |
| 写入材料汇总 | `deepseek-flash` · low | 7.4 秒 | 3 |

另一个会话上传 PDF 和 DOCX。回答引用 PDF 第 2 页与 DOCX 第 2 段，后续修改将数字写入 Markdown 汇总。打开变更差异并撤销后重新读取正文，SHA-256 与修改前一致。[写入差异](evidence/ai-workspace/materials-diff.png)

管理员的「测试生成」也通过了真实 Messages 调用。在独立工作区会话中，读甲组后刷新整个页面，再切换为 Pro high 并请它与乙组比较，仍然得到差值 15。两轮的最终流式回答分别报告 803 / 91 和 804 / 377 个输入 / 输出 token。工具阶段用量未计入这两组数。[桌面](evidence/ai-workspace/managed-chat-1440.png) · [手机宽度](evidence/ai-workspace/managed-chat-390.png) · [模型、选区、来源、变更和撤销回执](evidence/ai-workspace/live-receipts.json)

自动化复测可从产品仓库执行。先构建 Reader 和原生 fixture，再运行 Playwright 产品套件。引用往返在 `apps/reader/tests/e2e/document-ai.spec.ts` 中覆盖桌面和手机宽度。设置的角色、错误和轮换场景使用受控目录响应。受管执行器集成用真实 Node Harness 和本地 HTTPS Messages 替身，使工具回合、流式文本和失败回执可重复。

## Reader 改名与编辑器合并验证

集成提交 `c6911ef6` 保留了初次接入的 Reader 与 AI 历史。合入 Reader `81d26b63` 后，在独立 HTTPS 服务中重跑了设置保存回读、三轮真实问答、引用返回和继续追问。返回前后，原段落距视口顶部均为 458.21875 CSS px，对话滚动位置均为 129 CSS px。新用例还在另一浏览器标签页给已引用的文档改名，从原回答用改名前的引用打开了新文件名下的相同文档，并在后退后复用了原选区。[选区、会话和版本回执](evidence/ai-workspace/reader-81d-receipts.json)

真实 DeepSeek 读取一份带 BOM、CRLF 和行末空格的 Markdown，改写水位并生成 Git 提交。从 Reader 的「版本」选中写入前的版本并恢复，历史中同时保留原始、AI 写入和恢复三次提交。随后在「文档更多 → 重命名」改名，再用原 ID 和原 revision 的链接重新打开。读回的新文件名、文档 ID 和原始 Markdown 的 SHA-256 均已核对。[改名后从原链接打开](evidence/ai-workspace/restore-rename-reader.png)

Reader 接下来合入的 `5177a45d` 和 `a2eb4c97` 优化了点击页面留白时的光标落点。集成代码 `f16ae23b` 在相同 HTTPS 服务重跑了设置回读、三轮选区问答、版本恢复、使用原链接打开改名文档，以及 PDF 和 DOCX 问答、写入和撤销。正文 SHA-256 在版本恢复与撤销两条路径上均回到写入前的值。[最新生成回执](evidence/ai-workspace/reader-integration-receipts.json) · [引用返回后的现场](evidence/ai-workspace/reader-integration-back.png)

针对复用路径，回归先移动原文档，再在旧路径创建另一份相同正文。旧改名弹窗提交后得到 409，两篇文档保持原位。另一组用例复用历史文件名并从旧 AI 版本恢复，检查差异和恢复取自同一文档。复制出来的 Markdown 从其创建提交开始显示历史。输入时的验证覆盖 Markdown 行内代码跨行选区，以及正文保存与中文输入法组字同时进行时打开同文档引用。后退后的追问使用服务端确认的 revision 和原选区范围。

## 网页设置与模型目录

管理员从文档打开顶栏设置，在 AI 标签输入 DeepSeek 凭据。浏览器提交同源发现请求，真实供应商返回两个模型。换到下一个控件，目录返回后按 Escape，焦点回到原设置按钮。四个视口的页面横向溢出均为 0 CSS px。

| 视口 | 接入前 | 真实目录返回后 |
| --- | --- | --- |
| 1440 × 900 | [原设置](evidence/ai-workspace/settings-before-1440.png) | [AI 设置](evidence/ai-workspace/settings-after-1440.png) |
| 390 × 844 | [原设置](evidence/ai-workspace/settings-before-390.png) | [AI 设置](evidence/ai-workspace/settings-after-390.png) |
| 360 × 800 | [原设置](evidence/ai-workspace/settings-before-360.png) | [AI 设置](evidence/ai-workspace/settings-after-360.png) |
| 320 × 720 | [原设置](evidence/ai-workspace/settings-before-320.png) | [AI 设置](evidence/ai-workspace/settings-after-320.png) |

| 供应商返回的 ID | 显示名称 | 思考等级 | 供应商默认 | 上下文 / 最大输出（tokens） |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | DeepSeek-V4.1-Flash | low、high、max | high | 1,048,576 / 393,216 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | low、high、max | high | 1,048,576 / 393,216 |

在隔离 HTTPS 服务中从网页保存停用的连接后，派发模式仍为 `legacy`。读取 SQLite 逻辑导出、数据根下 50 个文件（含 28 个 Git 文件）和候选服务日志，均未匹配到提交的凭据。数据库有一条已加密连接，安装密钥 32 字节，权限 0600。截图遮盖密码框，仓库只保留公开目录字段。

设置的 8 项 Rust 接口测试覆盖发现响应变化、有界错误、角色、密钥轮换、模型回退和显式接管。接管测试先在执行器离线时确认原状态，再模拟在线心跳，验证重试取得同一回执、冲突 ID 被拒绝、默认选择与启用状态同时生效。整个测试只向替身发出一次模型目录查询。

## 执行器选型

两次独立运行中，官方 Harness 均完成跨文档问答及带选区的修改，实际来源可打开，撤销后 Markdown 的 SHA-256 与原件一致。旧执行器两次修改通过，两次问答在解析模型首个响应时失败。受管执行器采用 Harness 的 Messages 路线。详细调用记录、版本与对照方法见[真实模型比较](deepseek-harness-spike-evidence.md)。

## 会话与引用

会话服务的 10 项回归与原有 10 项 AI 操作测试覆盖作用域、幂等轮次、上下文预算、取消与提交的竞争、删除与中断恢复。浏览器在 1440 和 390 px 下从回答跳到另一份文档再后退，复验原回答、问题、未发送草稿、来源链接焦点、回答滚动位置和正文段落。返回后继续提问仍携带原选区。该组操作使用产品服务和本地执行器回执。

## 集成分支回归

| 验证对象 | 结果 |
| --- | --- |
| Reader 产品 Playwright | 207/207，采用真实 Rust 服务和 Chromium，2 个 worker |
| 编辑器与阅读锚点 Playwright | 36/36 |
| Reader Vitest | 75/75 |
| Librarian 与 docs Rust 测试 | 152 项通过，另跑版本读取单测 40/40 |
| 受管 Node 执行器、旧执行器、Harness Spike | 38/38、5/5、15/15，Spike 开启浏览器路径 |
| 接口与静态检查 | OpenAPI 生成一致性、TypeScript、UI 组件边界、Oxlint、Oxfmt、Cargo fmt、Clippy 全部通过 |

复测时从产品根目录运行如下命令，先构建与当前 Reader 对应的原生服务。Rust 发布测试需要 Zola 0.23.6。使用独立 Cargo 目标目录时，将 `CARGO_TARGET_DIR` 设为其绝对路径。

```sh
npm ci
npm run build -w @librarian/reader
cargo build --locked -p librarian --bin librarian --example reader_fixture --example reader_managed_fixture
export LIBRARIAN_READER_FIXTURE="${CARGO_TARGET_DIR:-$PWD/target}/debug/examples/reader_fixture"
export LIBRARIAN_MANAGED_READER_FIXTURE="$(dirname "$LIBRARIAN_READER_FIXTURE")/reader_managed_fixture"
npm ci --ignore-scripts --workspaces=false --prefix bin/librarian/runner
npm run test:e2e:product -w @librarian/reader -- --workers=2
npm run test:e2e -w @librarian/reader
npm test -w @librarian/reader
cargo test --locked -p librarian -p docs
node --test bin/librarian/runner/*.test.mjs bin/librarian/tests/ai_runner_example.test.mjs
npm ci --ignore-scripts --workspaces=false --prefix bin/librarian/examples/deepseek-harness-spike
LIBRARIAN_SPIKE_BROWSER=1 npm test --prefix bin/librarian/examples/deepseek-harness-spike
```

A 对应连接与执行器，B 对应会话与引用，C 对应材料。D 的批量写入、稳定文档 ID、移动、删除和条件撤销由 12 项 Rust 专项及产品浏览器用例验证。E 的外部客户端使用 Python MCP SDK 完成 OAuth/PKCE、上传、检索、条件写入、撤销和撤权。[MCP 复测步骤与回执](mcp-workspace.md)

手机宽度、200% 文字缩放、键盘收缩和焦点恢复由 Chromium 走查。实体手机中文输入、系统读屏和墨水屏显示保留为真机验收项。
