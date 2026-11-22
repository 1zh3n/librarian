# Librarian 0.1.0 发行候选验收

日期：2026-11-22
版本：`0.1.0`
代码：`6326a8c9`，目标分支 `release/0.1`；全量验收基线 `12fa1e39`
定位：**内网/LAN 候选**，不是公网发行版
部署：<https://192.168.8.166:18447>
回滚备份：`backups/pre-row-menu-6326a8c9-20261122-234634`

## 范围

本候选包含账号、Workspace、文档读写/版本、导入投递、快照/离线阅读、AI、MCP、图片、Reader UI 本轮重构和低 JS 静态阅读。详细范围见[0.1 收尾清单](../../../../../../../../docs/superpowers/plans/2026-11-22-librarian-0.1-release.md)。

## 验收

| 项 | 结果 |
| --- | --- |
| `make check-rust` | 通过，见 `check-rust.log` |
| Reader Vitest | 141/141，见 `reader-vitest.log` |
| Reader TypeScript / Oxlint / Oxfmt | 通过 |
| 完整产品 Playwright（单 worker） | 305/305，见 `playwright-workers1.log` |
| Rust workspace 全量测试（单 test 线程） | 通过，见 `cargo-test-workspace.log` |
| `cargo audit` | 9 个漏洞 + 5 个警告，见 `cargo-audit.log` 和[依赖维护规范](../../../../../../../../docs/superpowers/specs/2026-11-22-librarian-dependency-maintenance.md) |
| 18447 健康检查 / 登录 / 文档 / 低 JS | 通过：`health=200`、正文可读、静态页 `200`、0 个 `<script>` |
| 240 篇笔记侧栏加载 | 约 3.4 s → 0.19–0.30 s；`documents` 接口约 2.8 s → 11–12 ms |

## 本轮修复

- `SaveController` 增加从首次未保存改动起算的 2 秒最长等待，持续输入不会无限推迟保存；新增假时钟测试。
- `url` 升级到 2.5.9，移除 `RUSTSEC-2026-0592`；审计从 10 个漏洞降到 9 个。
- 修复低 JS `<noscript>` 注入后 `release_surface` 的精确 HTML 断言，补文档/快照深链检查。
- MCP 超大 body 测试改用真实 `BODY_LIMIT + 1`，此前 16 MiB 测试低于 20 MiB 上限，误判为 413。
- AI 设置测试在展开管理区块前等待「我的模型」加载，消除并行/单 worker 下的竞态失败。
- 文档列表批量创建/读取 document ID，并用文件清单判断 outline，避免 240 次逐文档 DB upsert 与 sidecar stat。
- 目录行点击切换展开/收起；桌面行内三点隐藏，移动端暂时保留。

## 资源限制

上一轮 `cargo test --workspace` 被 SIGKILL，原因是大规模并行编译/测试争用内存，不是代码编译错误。本轮统一使用：

```bash
taskset -c 0-14 \
  CARGO_BUILD_JOBS=1 \
  CARGO_PROFILE_TEST_DEBUG=0 \
  CARGO_PROFILE_DEV_DEBUG=0 \
  RUST_TEST_THREADS=1 \
  nice -n 10 \
  cargo test --workspace --all-features --locked
```

- 保留 CPU 15 不参与编译/测试。
- Cargo 只开 1 个 job，测试只开 1 个线程。
- 关闭 debug info，降低内存和磁盘压力。
- 完整产品 Playwright 使用 `--workers=1`，避免共享 fixture 竞态。

## 已知限制

- Max2 真机、真实软键盘、系统读屏、iOS/Safari 尚未验收；0.1 只能称内网候选。
- 公网开放未达标，必须按[公网安全审阅](../../public-security-review.md)处理高优先项。
- MCP 治理（审计/限流/配额/管理员全局 grant）不在 0.1 范围。
- 编辑器 Tab 缩进、表格单元格精确落点、源码/预览滚动锚定等长尾问题留到 0.2。
- 像素级视觉回归和独立 App/PWA 决策不在 0.1 范围。

## 分支与标签

- `release/0.1`：从 `12fa1e39` 的验收提交 `ff9a88bf` 创建；分支允许后续文档提交，修复只 cherry-pick 到此分支。
- 0.2 功能继续在 `feat/librarian-reader-ai-integration` 迭代。
- Max2/真机验收完成前不打 `v0.1.0` 正式标签，只保留候选分支。
