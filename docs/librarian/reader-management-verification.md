# 管理与只读阅读的组件迁移验收

**结论**　两项问题均已验证完成。Git 备份保存失败会保留草稿，慢响应也会保留提交后更新的选择。管理 Tabs 的键盘焦点只落在当前控件或直接受焦的面板。旧固定稿通过停服冷启动、原地址升级与移除后断网复核。[最终同状态验证](#最终同状态验证) · [旧副本验证](#跨版本的旧副本)

## 范围与对照

按改版计划阶段零、四，检查外部导入、Git 备份、站点发布、账号管理、只读固定地址与离线副本。从有相应权限的用户进入页面起，记录能否用键盘完成操作、区分禁用与可提交状态、从错误恢复，并核对回执或最终正文。

阶段一的 `393e9afd → b58ef36d` 已覆盖分享表单首屏、长清单筛选与快照目录收起。本轮复用这些画面作为历史背景，本次控件的比较另取同状态截图。[阶段一逐页走查](reader-ux-web-audit.md) · [分享表单对照](evidence/reader-ux-web/sharing-after.png) · [快照正文对照](evidence/reader-ux-web/snapshot-after.png)

迁移前使用 `feat/librarian-reader-ux@f949f454` 的归档构建。独立 Rust 产品服务监听 `127.0.0.1:4282`。桌面 Chromium 145，中文、浅色、1440×900 CSS px。窄屏另外使用模拟触摸、减少动效、320／360／390 px，含 390 px 下根字号 200% 与暗色。Git 和 Zola 0.23.6 的目标都是本地合成仓库。文件选择由浏览器发出选择器事件后注入合成文件。设备读屏、系统文件对话框内的操作和公网发布须单独验收。

## 迁移前实测

| 页面 | 操作与观察 | 证据 |
| --- | --- | --- |
| 外部导入 | 从旧 `#release` 入口用左方向键切到导入。Enter 选择空文件后提示并禁止提交。改选有效 Markdown，服务端接收后模拟丢失响应，原文件名可见。Tab、Enter 重试，两次请求内容完全相同，回执新增一篇。键盘焦点同时描边按钮和设置容器。 | [重试导入](evidence/reader-management/before-import-retry.png) |
| Git 备份 | 未选目标时「立即备份」禁用。Enter 打开选择器，End 聚焦末项，Esc 回到触发器且取消选择。选「本地备份／逐操作」后模拟设置 PUT 断线，出现「无法保存备份设置」，两个字段回到默认值。重新选择并保存后可完成本地 Git 备份。 | [末项键盘焦点](evidence/reader-management/before-backup-choice.png) · [触摸暗色](evidence/reader-management/before-touch-dark.png) |
| 站点发布 | 方向键进入子标签，键盘选择本地博客，Space 勾选一篇。输入无效版本并提交后，目标、版本文本及勾选仍在；换成实际的提交 ID 后本地发布成功。错误位于提交按钮上方，同时可见两层容器焦点线。 | [错误与选中范围](evidence/reader-management/before-publication-error.png) |
| 账号管理 | Tab 从用户名到初始密码，Enter 创建重复账号，表单内出现「该用户名已经存在」。返回用户名修改后 Enter 创建成功，密码框清空。 | [纠正重复账号](evidence/reader-management/before-account-error.png) |
| 固定阅读地址与离线 | 固定稿只显示阅读、目录和离线动作。断网保存副本收到错误，恢复网络后按 Enter 重试成功。展开两篇目录后选择另一篇，焦点进入该篇标题。新页断网打开已存地址并显示离线状态。另用独立的持久浏览器资料保存同一旧地址，供升级复核。 | [固定稿目录](evidence/reader-management/before-snapshot-directory.png) · [旧副本记录](evidence/reader-management/legacy-before.json) |

[迁移前逐控件数据、错误恢复与键盘结果](evidence/reader-management/before.json) · [触摸目标尺寸与页面宽度](evidence/reader-management/before-touch.json)

基线针对管理与快照的 19 项产品浏览器用例全部通过，含只读成员仅能查导入记录、旧管理页锚点、固定稿附件、撤销地址、登出及换号清理离线副本。另延迟账号创建请求，实测等待中按钮显示「正在创建…」并禁用，重复 Enter 仅产生一个 POST。[19 项回归明细](evidence/reader-management/before-regression.json) · [必填、键盘、悬停、按下和等待状态](evidence/reader-management/before-states.json)

## 修复前集成包复测

在 4282 运行 4290 验收进程的同一份 fixture 二进制，两边返回相同的静态资源清单。共享工作树的 `dist` 在并行构建中已变化，因此以运行中的二进制和资源摘要标识这次验收。fixture SHA-256 为 `b2481eeeea6f1737d66b5538cf093ba176ee6f2707886a656e3064aeab94e62b`，资源清单 SHA-256 为 `03584b18388cda6f8e8a3c74dd0a74623cdb415c8b868cf40f1dbb5ee6ded05e`。

| 路径与判定 | 相同操作在集成包上的结果 | 同状态画面 |
| --- | --- | --- |
| 外部导入 · 重试通过，发现容器焦点框 | 键盘选择、空文件校验、丢回执后同请求重试均通过。错误提示增加红色左边线，保留文字恢复办法。「重试导入」仍在 y=440，高 40 px。按钮聚焦时整个设置容器也有蓝框。 | [迁移前](evidence/reader-management/before-import-retry.png) · [集成后](evidence/reader-management/after-import-retry.png) |
| Git 备份 · 操作通过，发现草稿丢失 | 下拉现用图标箭头。打开后，已选项有底色，End 指向的候选项有焦点环；Esc 取消并还焦。保存设置的 PUT 断线后，「本地备份／逐操作」仍被重置为「请选择备份目标／按批聚合」。重新选择后，保存与实际 Git 备份均完成。 | [迁移前](evidence/reader-management/before-backup-choice.png) · [集成后](evidence/reader-management/after-backup-choice.png) |
| 站点发布 · 纠错通过，发现容器焦点框 | Space 勾选后标记可辨。无效 Git 版本提交失败，目标、版本输入和选中的一篇都保留。修改提交 ID 后 Zola 发布完成并产生对应链接。主操作仍在 y=761；错误态同时描边两层容器，难以判断下一次键盘操作的位置。 | [迁移前](evidence/reader-management/before-publication-error.png) · [集成后](evidence/reader-management/after-publication-error.png) |
| 账号 · 通过 | 空表单提交后用户名获得焦点，必填错误边框从灰色变为红褐色。重复用户名就近报错，修改后创建成功并清空密码。等待时按钮显示「正在创建…」、保留焦点并阻止第二次提交；实测只有一个 POST。 | [迁移前](evidence/reader-management/before-account-error.png) · [集成后](evidence/reader-management/after-account-error.png) · [交互状态](evidence/reader-management/after-states.json) |
| 只读固定稿、离线 · 通过 | 两篇目录的触发器在两个版本中均为 756×44 px，正文及当前篇标记位置一致。Enter 展开、选第二篇、焦点进入新标题。网络错误后重试保存成功，断网能读显式保存的固定稿。 | [迁移前](evidence/reader-management/before-snapshot-directory.png) · [集成后](evidence/reader-management/after-snapshot-directory.png) |

在模拟触摸设备上，暗色目标选择器及候选项文字清晰，选项能直接点选。集成版 320、360、390 px 下，备份目标触发器与选项均高 44 px。390 px、200% 字号时分别为 106 和 80 px，页面滚动宽度仍为 390 px。导入和账号错误态在这四组视口与字号下也无页面横溢。[暗色迁移前](evidence/reader-management/before-touch-dark.png) · [暗色集成后](evidence/reader-management/after-touch-dark.png) · [触摸测量](evidence/reader-management/after-touch.json) · [五条路径实测](evidence/reader-management/after.json)

### 跨版本的旧副本

在旧版创建并保存两篇固定稿，保留数据根与独立 Chromium 资料。关停 4282 服务再冷启浏览器，原地址从旧缓存显示「河岸记录甲」和「正在读取离线副本」。恢复服务时使用原数据根与集成包的 Web 资源；同一地址加载新入口 `reader-BdfCvtBF.js`，仍显示已保存，键盘可进入「河岸记录乙」。按 Enter 移除副本后断网再请求原内容，读取失败。[旧地址与原始提交](evidence/reader-management/legacy-before.json) · [断网、升级与移除结果](evidence/reader-management/legacy-after.json) · [停服时从旧缓存打开第一篇](evidence/reader-management/old-cache-offline.png) · [恢复服务后用新界面打开第二篇](evidence/reader-management/old-address-upgraded.png)

## 最终同状态验证

用 `a2963d45`（含 Tabs 修复）加本次 BackupPanel 修订独立构建，在 4282 的真实 Rust fixture 与 Chromium、1440×900 浅色下重放。该包的资源清单 SHA-256 为 `0956baa19a840a5c3c1426706c764c6e27f42993968b5fd3c538027749e068b0`。

**Git 备份保存与重试 · 验证完成。** 先在原集成包加产品回归，首次 PUT 断线后，期望「本地备份」，实际为「请选择备份目标」。修订后仍显示「本地备份／逐操作」，错误旁提示重试，「立即备份」保持禁用。直接重试的两个 PUT 请求体相同，服务端确认设置后才允许启动，本地 Git 回执包含实际版本，刷新后可再查。[断线时修前画面](evidence/reader-management/backup-save-broken.png) · [断线时修后画面](evidence/reader-management/backup-save-fixed.png) · [请求与确认值](evidence/reader-management/backup-save-fixed.json)

另一个回归先在仅修复断线的版本上失败。服务端保存「按批聚合」后暂缓响应；此时选择器仍可操作，用户改选「逐操作」。旧实现收到响应后又显示「按批聚合」。最终版将回执写入已保存设置，仅在当前草稿与本次提交相符时清理草稿。实测服务端是「按批聚合」，界面是「逐操作」，无「已保存」提示且启动按钮禁用。再次保存后刷新仍显示「逐操作」。[旧回执抵达后的新选择](evidence/reader-management/backup-newer-selection.png) · [产品回归用例](../../apps/reader/tests/e2e/document-release.spec.ts)

**管理 Tabs 键盘焦点 · 验证完成。** 从以下标签按一次 Tab，每个实际受焦对象均有 2 px 实线。统计从它的父元素向上至页面根的计算外框，三个场景均归零。

| 从标签按 Tab | 实际受焦对象 | 带框祖先个数 | 同状态画面 |
| --- | --- | --- | --- |
| 外部导入 | 选择文件按钮 | 1 → 0 | [修前](evidence/reader-management/tabs-broken-import.png) · [修后](evidence/reader-management/tabs-fixed-import.png) |
| 站点发布 | 发布目标选择器 | 3 → 0 | [修前](evidence/reader-management/tabs-broken-site.png) · [修后](evidence/reader-management/tabs-fixed-site.png) |
| Git 备份（未配置目标） | 提示配置方法的静态面板 | 2 → 0 | [修前](evidence/reader-management/tabs-broken-backup.png) · [修后](evidence/reader-management/tabs-fixed-backup.png) |

导入丢回执后聚焦「重试导入」以及发布提交无效版本后的两种历史问题画面也已复拍，设置区外框均已消失。[焦点实测修前](evidence/reader-management/tabs-broken.json) · [焦点实测修后](evidence/reader-management/tabs-fixed.json) · [导入重试](evidence/reader-management/verified-import-retry.png) · [发布纠错](evidence/reader-management/verified-publication-error.png)

该联合构建的管理、账号、导入、备份、发布与离线产品回归 20/20 通过。Reader 生产构建与类型检查通过，变更的两个 TypeScript 文件通过 Oxlint 和 Oxfmt。[最终 20 项回归结果](evidence/reader-management/final-regression.json)
