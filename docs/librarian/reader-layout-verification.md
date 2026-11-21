# Reader 长文、草稿与离线阅读验收

2026-11-21，在 4283 端口用真实 Rust fixture 和 Chromium 145.0.7632.6 验收 UI 改版的阶段二与阶段四。发现并复测了一处影响长文阅读的问题。浏览器默认字体加倍时，旧版只放大了标题与界面，正文仍为 18 px。集成修复后，同一导语占用的高度由 131.5 px 增至 526.25 px，正文实际达到 36 px。[同状态修复前后，左旧右新](evidence/reader-layout/font-200-before-after.png)

## 阅读画面

沿用[桌面走查](reader-ux-web-audit.md)中的《从河口到山麓：沿溪调查的记事与方法》。18 节中文长文含引文、链接、宽表和代码。表中均为 CSS px。所有默认视口下正文 18 px、行高 33.3 px，标题与首段左边缘相齐。宽表与代码分别滚到最右侧后，页面和主阅读区的横向位移都为 0。[逐项测量](evidence/reader-layout/measurements.json)

| 视口 | 正文列宽 | 标题与首段左边线 | 首段顶端 / 高度 | 宽表 / 代码实际横移 |
| --- | ---: | ---: | ---: | ---: |
| 1440 × 900 | 756 | 454.5 | 291.6 / 65.8 | 1918 / 1709 |
| 390 × 844 | 358 | 16 | 211.7 / 131.5 | 2316 / 2107 |
| 360 × 844 | 328 | 16 | 211.7 / 131.5 | 2346 / 2137 |
| 320 × 844 | 288 | 16 | 211.7 / 164.4 | 2386 / 2177 |

桌面标题两行分别宽 401.5 和 451.6 px，与上轮修订后的 401 / 452 px 一致。三个窄屏的标题均占两行，首段完整可见。320 px 下首段多占一行，表格的右端可以独立读到。[旧标题对照](evidence/reader-ux-web/heading-comparison.png) · [390、360、320 与 320 宽表右端，从左到右](evidence/reader-layout/narrow-reading.png)

| 状态与操作 | 判定及实测 |
| --- | --- |
| 在 390 × 844 桌面浏览器窗口放大默认字体 | **修复后通过。** 用 Chromium `Page.setFontSizes` 将默认字体从 16 调至 32 px。旧版正文计算字号 18→18 px，修复后 18→36 px。页面宽 390 px，主阅读区可用宽和滚动宽均为 375 px，其余 15 px 为滚动条预留。两幅截图均启用相同的 200% 字体设置。[修复前后](evidence/reader-layout/font-200-before-after.png) |
| 暗色阅读，灰阶下用 Tab 找到正文链接 | **通过。** 普通暗色的正文、导语和引文仍有层次。启用墨水屏偏好后，浅色为黑字白底，深色为白字黑底，链接保留下划线，键盘焦点带 2 px 实线。模拟系统 reduced-motion 后，两种主题在启用墨水屏之前，正文段落的实际过渡时长已为 0 s。[普通暗色](evidence/reader-layout/reading-dark.png) · [浅深灰阶的链接焦点](evidence/reader-layout/gray-focus.png) |

## 段落、选区与草稿

| 状态与操作 | 判定及实测 |
| --- | --- |
| 从首段和第 11 站进入就地编辑，Esc 回到正文，再切换专注 | **通过。** 点击深处段落后，浏览器插入点落在以「木桩边」开头的正文。进入、退出专注及退出编辑后，桌面章节标题始终在 y=210.125，390 px 下始终在 y=210.141。桌面专注时列向中间移动，段宽仍为 756 px、高 66.6 px。手机段宽仍为 358 px、高 99.9 px。两张四宫格均依次为默认阅读、首段编辑、深处阅读、深处编辑。[桌面](evidence/reader-layout/read-edit-1440.png) · [390 px](evidence/reader-layout/read-edit-390.png) |
| 选中「木桩边的水草微微摆动」，打开提纲，输入，再切到引用并返回 | **通过。** 桌面打开后该段仍在 y=257.9，旁边只有一个辅助区。390 px 的提纲占 y=246.1–437.1，所选段落从 y=453.1 继续显示。回到提纲仍有「回访北岸」，关闭后章节回原 y，焦点在「打开文档辅助区」。通过 API 核对正文 Markdown 与初始全文一致。选字使用浏览器 Range。[桌面选区与提纲](evidence/reader-layout/selection-outline-1440.png) · [390 px 选区与提纲](evidence/reader-layout/selection-outline-390.png) |
| 在第 11 站写入「本地待核对」，查无结果后 Esc，再从 Ctrl+K 进入设置并退出 | **通过。** 测试挂起该文档的 PUT，服务器仍返回原文。一次 Esc 关闭无结果搜索，焦点回搜索按钮。退出设置后焦点回正文，两次返回的章节位置均为 y=210.125，段内草稿可见。放行请求后从服务器读到新字，再次进入编辑并撤销，服务器全文与原件相同。[搜索与设置返回后的正文](evidence/reader-layout/search-return.png) |

## 只读成员与固定版本

在「另一空间」先固定长文，再由写入者更新开头。只读成员在 360 × 844 看到更新后的第一段。点段落、按 Alt+E 仍停在阅读态，文档菜单可打开目录。打开固定版本后读到原导语，点击「保存离线副本」，关闭该页。在同一浏览器上下文断网、阻断 Service Worker 对服务端的请求，用**新标签页直接导航**到固定地址。界面显示「正在读取离线副本」及发布时的原文，页面宽 360 px。通过。[左为只读成员菜单，右为离线固定稿](evidence/reader-layout/member-snapshot.png)

## 构建与复跑

Fork 的 clone URL 和 origin 均为 `git@github.com:1zh3n/librarian.git`，upstream 为 `https://github.com/silverbulletmd/silverbullet.git`。操作目录为 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/reader-ux-worktree`。操作分支为 `feat/librarian-reader-ux`。本机使用 Node 24.22.1、Playwright 1.58.2 和 Noto Serif CJK SC。

| 实测时间（上海） | 源码与打包状态 | 结果 |
| --- | --- | --- |
| 21:42 起 | 起点 `c1059e7241aa62ebcb704264423b946a79c99f13`。独立 Vite 生产构建与当时的 Reader dist 逐文件相同。Rust fixture 提供前端和 API。 | 浏览器默认字体加倍时正文仍为 18 px。既有阅读、编辑、搜索设置、成员、导入、备份发布和快照等八个文件共 85 项，84 项通过。登录纠错用户名保留用例当时失败，后续登录回归通过。 |
| 21:50 | HEAD 为 `f949f454`，共享工作树仍有并行改动。字号对照左图的浏览器 trace 记录入口为 `reader-BvSs7XQI.js`，应用模块为 `ReaderApplication-B1ztcuyZ.js`。 | 新增字号断言在旧包报期望 36、实得 18。 |
| 21:52 构建，21:53–21:55 复测 | HEAD 为 `f949f45402971a117f0353fb2c4087b88b0c64b6`，加当时工作树中的 rem 修复与并行产品改动。Vite 生产包经 Cargo 嵌入 Rust fixture，实际响应含 `reader-8efZ1lkS.js` 和 `ReaderApplication-BTlRVAd3.js`。服务返回的 `reader-shell.json` SHA-256 为 `7fb2352c68e4be4826e83e39e6652b3e3c3182f9ab052f7b8c34029cb65c0a27`。 | 字号对照右图及其余实测图取自此包。新增验收 11/11，另跑既有阅读、编辑、专注设置、登录、离线五个文件 53/53。 |

以上记录对应本地阶段性集成包。最终集成版由主代理另行回归。每次运行会在各用例的 Playwright 输出目录写入原尺寸截图及 JSON 测量。新增文件通过严格 TypeScript 单文件依赖检查、项目 Oxlint 与 Oxfmt 检查。[验收用例](../../apps/reader/tests/e2e/document-redesign-acceptance.spec.ts)

可在产品工作树用以下命令复跑。

```bash
export LD_LIBRARY_PATH="$PWD/../2026-11-21-librarian-foundation/host/root/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LIBRARIAN_PRODUCT_TEST_PORT=4283
npm run build -w @librarian/reader
npm run test:e2e:product -w @librarian/reader -- document-redesign-acceptance.spec.ts --workers=1 --output=/tmp/reader-layout-4283-results
```

触屏与灰阶使用 Chromium 模拟。实体软键盘、读屏播报与墨水屏刷新需在相应设备核验。AI 回答来源往返由主代理单独验收。
