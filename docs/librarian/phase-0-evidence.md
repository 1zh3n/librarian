# Librarian 阶段 0 验收记录

阶段 0 的编辑器核心条件与独立发行验证通过。任务 0–2 由原实现分支开始，后续提交在 `feat/librarian-phase-0-completion`。Android 真机、实体墨水屏待验项与长文切换性能记录在下文。

## 任务 0 · 基线

| 项目 | 实测 |
| --- | --- |
| Clone URL / origin | `git@github.com:1zh3n/librarian.git` |
| Upstream | `https://github.com/silverbulletmd/silverbullet.git` |
| 本地目录 | `/home/xia/Projects/Doc/librarian` |
| 实现分支 | `feat/librarian-phase-0` |
| HEAD、origin/main、upstream/main 基线 | `ebb9f45a78b41d4849bc18fc1147e89662057d4a` |
| OS | Arch Linux x86_64，内核 7.2.10-arch1-1 |
| 工具 | Rust/Cargo 1.99.1、Node 24.22.1、npm 11.19.1、Git 2.56.0 |
| 浏览器 | Playwright 1.58.2，Chrome for Testing / Chrome Headless Shell 145.0.7632.6 |
| 中文 IME | 准备验证 IBus Intelligent Pinyin 1.16.5，输入证据待补 |

分支从干净基线创建。源码点位核对了 `server/src/multi/manager.rs` 的
`MultiManager`、`server/src/handlers/fs.rs` 的 ETag/If-Match，以及
`server/src/revisions/{store,read}.rs` 的批量 commit、文件历史和 diff。

| 命令 | 结果 |
| --- | --- |
| `cargo metadata --locked --no-deps --format-version 1` | 退出 0，9 个 workspace package |
| `cargo fetch --locked` | 退出 0 |
| `cargo test --locked -p silverbullet-server-common --lib --quiet` | 退出 0，143 项通过。上游测试 helper `space/disk.rs::names` 有 dead_code 警告 |

## 任务 1 · Spike 工程

- RED：Playwright 的 HTTP 启动用例在加入 HTML 前得到 404。Vitest 组件用例在加入页面前因缺少 `SpikePage` 模块失败。
- 保留上游锁定的 Vite 8.3.1、Vitest 4.1.11、Playwright 1.58.2。Reader 使用 React 19.3.1、React Aria Components 1.22.1、`@vitejs/plugin-react` 6.3.0、TypeScript 7.0.2、Oxlint 1.94.0、oxlint-tsgolint 7.0.2007 和 Oxfmt 0.79.0。
- 用 npm registry 的包元数据检查 peer 和 engines 范围，并核对 React 插件的默认配置及 Oxlint 的类型感知启动方式。应用的 `npm exec -w @librarian/reader -- tsc --version` 返回 7.0.2。上游 TypeScript 6 别名由原包继续使用。
- React Aria 根入口的 Group 和 OverlayArrow 声明在 `exactOptionalPropertyTypes` 下产生 TS2320。各受影响属性同时继承了 React 的可选 `string | undefined` 和 React Aria 的可选 `string`。Spike 从公开 `react-aria-components/Button` 子入口导入，保留应用类型检查和上游声明检查。Vite 使用 React 插件的默认 Oxc 转换。
- Arch Linux 的 Chromium 运行库从 Arch 官方包归档解包到本地隔离目录。执行浏览器测试时以该目录的 `usr/lib` 作为 `LD_LIBRARY_PATH`。系统包和浏览器版本由环境管理。

- GREEN：`npm ci` 成功。Reader 的 `typecheck`、`lint`、`format:check`、`test`（1 项）、`test:e2e`（Chromium 2 项）和 `build` 均退出 0。

- 上游客户端全量测试首次执行因缺少生成文件 `version.json` 导致 45 个测试文件加载失败。调用 `build/version.ts` 的 `updateVersionFile()` 后复跑 `npm test`，485 个文件和 5,104 项测试全部通过。

## 任务 2 · 双表面与 Markdown 原文

- RED：加入适配层前，`markdown-fidelity.test.ts` 因导入不存在失败。编辑后返回阅读的端到端用例在临时编辑框阶段没有语义块标记。
- CodeMirror 使用 LF 视图和 UTF-16 坐标。适配层在 EditorState 中保存原始字符串，把每笔编辑投影回原文范围，并保存 CRLF 宽度。显式补丁可以写入 CR、LF 或 CRLF。编辑触发换行结合或拆分时，以补丁后原文决定 CodeMirror 的换行边界。
- 阅读端使用 remark CommonMark、GFM、Front Matter、remark-rehype 和 rehype-sanitize。顶层可见块带稳定内容签名和同签名出现序号，位置含 BOM 偏移。原始 HTML 标签不渲染，危险 URL 属性被剥离；标记之间的 Markdown 文本仍可阅读。
- GREEN：应用类型检查、lint、格式检查、Vitest 10 项、Playwright 3 项和生产构建通过。其中保真用例 9 项，覆盖空文本、混合换行、BOM、尾空白、无末尾换行、中文、emoji、注释及未知扩展。构建输出有 Vite 单 Chunk 超过 500 kB 的提示。

## 任务 3 · Live Preview 与桌面中文输入

- CodeMirror 的 Lezer CommonMark/GFM 树控制源码标记的显示。行内装饰随可视范围更新。顶层表格和 Front Matter 使用保留源范围的可进入组件。嵌套表格、未识别语法和无法稳定预览的语法保留可编辑源码，阅读端仍按自己的语法支持渲染。完整源码使用同一编辑会话、选区和撤销栈。
- 对照上游 `hide_mark.ts`、`table.ts`、`frontmatter.ts` 和 `android_input.ts`，Spike 采用公开事务、语法树、装饰和几何 API。组合期间映射已有装饰，结束后再重算。Android 专用输入策略留待真机数据决定。
- 桌面实测为 Arch Linux、Xvfb 1280 × 900、Chrome for Testing 145.0.7632.6（GTK3/X11）、IBus 1.5.34 与 Intelligent Pinyin 1.16.5。使用 XTEST 发送系统按键并读取浏览器信任事件。独立 D-Bus 会话通过 `IBus.SetGlobalEngine` 选中 `libpinyin`，设置 `IBUS_ENABLE_SYNC_MODE=2`。Playwright 合成组合输入另有回归用例。[IBus GTK 输入实现](https://github.com/ibus/ibus/blob/main/client/gtk2/ibusimcontext.c)
- 初次启动时 CLI 的引擎切换未完成。改由 D-Bus 设定引擎后，从 Chromium 原生输入框对照验证预编辑和提交，再在 Reader 中重复操作。

| 输入操作 | 预期与实测 |
| --- | --- |
| 输入 `zhongwen` 后按 Space | 预编辑出现「中文」，提交后进入标题，完整源码仍保留 Markdown 标记 |
| 输入 `zhongwen` 后按 Esc | 取消预编辑，保持原标题 |
| 逗号键、Ctrl+Z、Ctrl+Shift+Z | 插入「，」，撤销与重做均正确 |
| 提交「中文」后撤销、重做 | 恢复原标题后再次得到同一中文文本 |
| 在强调内组合，左右移动并点击源码按钮或其它行 | 组合时源码开关保持当前状态，原候选范围未被重建，结束后正文没有重复提交，强调标记保留 |
| Ctrl+V 粘贴 `河岸📝` | 中文与 UTF-16 代理对一起进入正文 |

[预编辑截图](evidence/phase-0/ibus-preedit.png) · [提交与粘贴截图](evidence/phase-0/ibus-committed.png)

## 任务 4 · 读写锚点

- Chromium 桌面 1280 × 720、系统字体、容许误差 8 CSS px。长文来回切换、重复标题、空文档和延迟图片重排用例通过。图片加载时重新对齐原块，用户主动滚动、键盘或点击时结束恢复。
- 同一正文版本优先使用块 ID。跨版本按 CodeMirror 事务映射后的 UTF-16 位置查找后续语义块，避免误中重新编号的重复段落。恢复期间正文变化时，停止过期的几何恢复。
- 审查补测覆盖删除 CRLF 或独立 CR 后的撤销与重做，以及普通编辑将邻接 CR/LF 合并的情况。历史保存行尾位置与类型。两个回归在修复前失败，修复后台架验证源字符串与可见行始终一致。

## 任务 5 · 外部补丁与设备

- 自动验证了干净态选区映射、组合期间延后、组合结束时重核基线、脏缓冲冲突和普通撤销保留外部提交。接受外部版本时重建本地撤销边界，已确认的 AI 版本由版本功能撤销。
- Chromium 360 × 740 无整页横向滚动，宽表格与代码块各自滚动。Pixel 7 触控仿真与灰阶、减少动态效果设置用于静态检查。正文前景 `#25241f`、背景 `#fbfaf6`。[灰阶截图](evidence/phase-0/monochrome-360.png)
- Android 真机通过 USB 回环访问同一 Librarian 发行二进制。系统 Android 17，Microsoft Edge 157.0.4341.53，搜狗输入法小米版 10.32.21.202609081832。设备像素比 3，浏览器内容宽约 385 CSS px，软键盘弹出后可视高度从 658.7 px 缩到 350.7 px。
- 原生触控输入 `zhongwen` 后，软键盘显示预编辑和「中文」候选。点选候选后只提交一次，在浏览器 EditContext 中捕捉到可信 `textupdate`，返回阅读的标题为「河边的笔记中文」。在该键盘配置中预编辑留在输入法面板，正文直到选字才变化。
- 长按「文」建立编辑区内真实选区。长文阅读滑动后可见「第 10 段」，进入编辑并弹出软键盘后这一段仍可见。键盘打开时再次滑动，正文滚动位置从约 502 px 移到 772 px。阅读和编辑的内容宽与容器宽均为 385 CSS px。
- 实体墨水屏刷新与残影留作阶段 4.3 复验。阶段 0 记录静态灰阶，发布前用真实产品文档复跑手机输入，按设备记录结果。
- 长文取 100,000 UTF-16 单位，使用重复的中文标题与带强调段落。Arch Linux x86_64、Ryzen 7 255、Chromium 145、1280 × 720，生产 Bundle。以输入或点击到第二个动画帧测量，20 次单字符输入，10 次阅读/编辑切换，返回阅读前包含正文改动。最终数据见本页的验证表。

| 规格 §13.7 | 结论 |
| --- | --- |
| 1. 中文 IME | 桌面真实 IBus、组合、撤销和重做通过 |
| 2. Live Preview | 标题、强调、链接、列表、任务、引用、顶层表格与代码块通过，嵌套表格使用源码 |
| 3. 光标揭示 | 进入强调揭示标记、移出恢复预览。表格可用 Enter 揭示 |
| 4. Markdown 原文 | 混合换行、BOM、尾空白、Front Matter、注释和未知语法保真，补测撤销与邻接换行 |
| 5. 阅读和编辑块锚 | 往返、空文档、图片重排和重复/消失的块通过 |
| 6. 外部补丁 | 组合延后、冲突保留、选区映射和独立撤销边界通过 |
| 7. 性能与设备 | 输入参考线通过，长文切换超参考线，阶段 1 处理阅读解析和渲染开销。360 px 与静态灰阶通过，Android Edge 与搜狗拼音真机通过，实体墨水屏刷新待复验 |
| 8. 双表面语义 | 共同 CommonMark/GFM fixture 通过，适配层注明嵌套表格的预览范围 |

`editor/document.ts`、`editor/codemirror/`、`markdown/` 的保真、渲染和锚点接口可在阶段 1 复用。Spike 的 fixture 与操作界面留作验证入口。

## 任务 6 · 独立发行版

- `npm run build -w @librarian/reader` 生成 Reader 资产。产品二进制内嵌 HTML、指纹化 JS/CSS 和授权模板，HTML 按 `no-cache` 返回，资产按 `immutable` 返回。
- 根页面和已知 Workspace/文档深链接返回同一产品入口。`/api/v1/health` 返回构建版本，API 未知路由返回 JSON 404。配置真实含原始 HTML 的 Space 后，深链接仍不嵌入 Space 的 Markdown 或启动上游 SSR。
- 产品运行树没有 `silverbullet-server-runtime-chrome`。Shell、Proxy、Runtime、Lua 和上游文件端点未挂在产品 HTTP 路由。上游二进制保留自身入口。Rust workspace 的 Make/CI 检查先生成 Reader Bundle。

## 任务 7 · 后端接缝

- 两个临时原生 Space 用同名 `Same.md` 分别验证字节和账号权限。MCP 使用独立 `workspace_list`，返回当前成员权限与 grant 的交集。实际回环回调验证 PKCE 授权、凭证刷新重连和撤销。跨源登录 POST 被拒绝。
- 通过现有 `MultiHost` 到 Space 的文件处理器检查 `If-None-Match: *` 创建，`If-Match` 条件保存及旧 ETag 的 412。阶段 1 的产品 API 在业务边界映射为 409/428。客户端不会直接调用上游文件端点。
- 在受管 Space 中通过 `RevisionEngine::snapshot_now` 和 `RevisionStore` 验证原始字节、Git blob 和 Diff。磁盘外部写入经 watcher 进入全文索引，也能建立可读修订。上游默认版本模式为 Disabled，实际测试显式启用 Managed。上游修订用例使用本地 bare remote 覆盖已有远端快进与空远端首次推送。产品没有对托管 Git 服务发起同步。
- 未配置语义模型时 Tantivy 查到中文子串「鸟鸣」「微光」「鹭鸟」，覆盖启动索引、API 写入与外部写入。
- 产品登录入口当前也可以在 MCP 关闭时显示。阶段 1 的产品登录统一处理这一入口的启用条件。OAuth 授权和工具仍由 MCP 开关控制。

## 最终验证

| 命令或检查 | 结果 |
| --- | --- |
| `npm ci --offline` | 干净依赖重装通过 |
| Reader 类型检查、lint、格式、Vitest、Playwright、构建 | 通过，Vitest 14 项，Playwright 16 项。JS 主 Chunk 939.03 kB（gzip 310.04 kB） |
| `cargo test --locked -p librarian` | 9 项通过 |
| `cargo test --locked -p silverbullet-server --lib` | 1349 项通过，1 项忽略。需要先走上游 `npm run build` 生成模板 |
| `cargo test --locked -p silverbullet-server-mcp` | 177 项通过 |
| `cargo test --locked -p silverbullet-server-common --lib` | 143 项通过，有上游测试 helper 的 dead_code 提示 |
| `cargo fmt --all -- --check` 与 `cargo clippy --locked -p librarian --all-targets -- -D warnings` | 通过。修复当前 Rust 工具链在既有依赖中的 lint，保留门槛 |
| `cargo test --locked -p silverbullet-server-search --lib -- semantic::store` | 字节级向量读写等 12 项通过 |
| `cargo build --locked --release -p librarian` | 通过。实际进程返回 Reader、深链接、指纹资产与健康检查，未知 API 与排除能力返回 404 |
| `cargo tree --locked -p librarian` | 通过，产品依赖未包含 Chrome Runtime crate |
| Android 真机浏览器 | Edge、搜狗拼音候选、提交、长按选区和长文滚动通过 |
| 长文输入与切换 | 输入 p95 31.2 ms（参考线 50 ms），切换 p95 217.5 ms（参考线 150 ms）。五次进入编辑为 22.9–30.4 ms，五次编辑后返回阅读为 188.4–217.5 ms |

启动只带 Spike 的发行入口可用 `cargo run --locked -p librarian -- --listen 127.0.0.1:8080`。要接入现有测试账号与 Workspace 配置，传 `--data-root <path>`。先在 Fork 中构建 Reader Bundle。
