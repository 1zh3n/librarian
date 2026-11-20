# Librarian 阶段 0 验收记录

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
