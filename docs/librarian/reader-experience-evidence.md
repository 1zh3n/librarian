# 阅读体验与工作区集成验收

2026-11-21 · `feat/librarian-reader-experience` · 产品源码 `6c792fb845d5b57efd7e481e9ca84563a5fcd0eb` · 独立 Harness Spike `74d23b42`。

## 界面走查

使用 Chromium、同一篇中文样例、浅色和相同视口。AI 截图中的回复是通过真实产品 API 完成的受控回执。原型和候选版的回复及引用内容有差异，布局和入口按相同对话状态比较。原型没有等效的就地编辑状态，编辑截图采用实际产品。

| 任务 | 证据 |
| --- | --- |
| 默认打开文档 | 正文先显示，辅助区收起。有提纲的文档在「写作」预设自动展开提纲。 [桌面并排](../../../reader-experience-review/reading-comparison.png) · [手机](../../../reader-experience-review/candidate-reading-phone.png) |
| 在正文中写 | 点击位置对应原文偏移。编辑画布无整页虚线、常驻返回阅读按钮及 YAML 占位。失焦恢复阅读，键盘可回到同一画布并撤销。 [桌面](../../../reader-experience-review/candidate-editor-desktop.png) · [手机](../../../reader-experience-review/candidate-editor-phone.png) |
| 打开文档 AI | 四个工具共用一组标签，底部输入和实际引用保留在面板内。1440 px 下正文起点变化为 0 px，面板宽度 336 px，输入底边离面板底边 21 px。390 px 下文档无全页横向滚动。 [桌面并排](../../../reader-experience-review/ai-comparison.png) · [手机](../../../reader-experience-review/candidate-ai-phone.png) · [测量](../../../reader-experience-review/measurements.json) |
| 改布局、搜索和设置 | 布局缩略图反映当前选择。搜索栏的输入、跨空间控件和关闭图标同一行。手机与桌面均使用标签设置。 [布局](../../../reader-experience-review/shell/1440x900-layout-menu.png) · [搜索](../../../reader-experience-review/shell/390x844-search-quick-open.png) · [个人设置](../../../reader-experience-review/shell/1440x900-personal-settings.png) · [工作区设置](../../../reader-experience-review/shell/390x844-workspace-settings.png) |

审查补充了键盘打开时的标签焦点、输入法合成结束后退出编辑、切到 AI 时继续使用实际编辑选区，以及已有来源导入中断后避免误认另一笔回执的回归。代码测试验证其行为。新版视觉保留用户走查入口。

## 集成与回归

- GitHub 备份入口显示仓库和分支摘要、目标状态与最近回执。部署配置保存在 `.librarian/backup-targets.json`。使用本地裸 Git 仓库验证备份结果与重试。实际 GitHub 远端推送待授权环境复核。 [备份配置](git-backup.md)
- 外部导入提供 Markdown、ZIP 和项目自动导入。旧来源可从回执中更新。浏览器上传和 CLI 复用版本机制，已有来源的中断上传可原批重试。 [导入说明](delivery.md)
- API 契约、类型检查、lint、格式、生产构建均通过。Reader 单元测试 52 项，产品 Playwright 68 项，编辑器 Spike Playwright 16 项，Rust 测试 86 项。Clippy 使用 `-D warnings`。 [产品回归](../../../reader-experience-review/final-product.log) · [编辑器 Spike](../../../reader-experience-review/final-editor-spike.log) · [Rust](../../../reader-experience-review/rust.log)
- 使用 100,000 UTF-16 单位普通和富格式 Markdown 分别测得输入 p95 为 32.0 ms、31.6 ms，读写切换 p95 为 85.9 ms、92.9 ms。保存字节经 SHA-256 核对，两个语料的回归锚点误差均为 0 px。 [普通长文](../../../reader-experience-review/performance-plain.log) · [富格式长文](../../../reader-experience-review/performance-rich.log)

## AI Spike

官方 DeepSeek Harness 最小进程通过 15 项隔离测试，验证真实 Rust API 与浏览器中的实际来源、Git 差异和撤销原字节。模型使用回环地址的 SSE 替身。环境缺少 `DEEPSEEK_API_KEY`，真实 DeepSeek 及对比线路待测。模型设置和产品接入仍以真实通过结果为前提。 [Spike 记录与复跑方法](deepseek-harness-spike-evidence.md) · [本地结果](../../../reader-experience-review/deepseek.log)

## 发行与内网候选

内网地址为 [https://192.168.8.166:18445/](https://192.168.8.166:18445/)。账号 `preview-admin` 沿用原试用密码，浏览器复用已有局域网根证书。后端绑定 `127.0.0.1:18082`，数据根为 `~/.local/state/librarian-reader-review/data`。用户级临时服务为 `librarian-reader-review-app.service` 和 `librarian-reader-review-https.service`。较早的候选继续使用 18444。 [根证书](../../../pre-release-lan/caddy-data/caddy/pki/authorities/local/root.crt)

安装包从干净分离检出构建并通过 SHA-256。实际二进制通过登录、初始化、CLI 导入、Git 备份、Zola 发布、离线还原与阶段 4 数据升级。在宿主机用 Chromium 通过新的 HTTPS 入口验证登录、四个文档工具标签、工作区导入和备份设置、注销。手机验证使用 Chromium 触屏模拟。实体中文输入设备、实际读屏和第二台客户端待走查。 [安装包](../../../reader-experience-review/release/librarian-0.1.0-linux-x86_64.tar.gz) · [SHA-256](../../../reader-experience-review/release/librarian-0.1.0-linux-x86_64.tar.gz.sha256) · [发行日志](../../../reader-experience-review/release-smoke.log) · [内网日志](../../../reader-experience-review/lan-smoke.log)
