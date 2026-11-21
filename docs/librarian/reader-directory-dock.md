# 目录新建与分栏记忆验收

产品 Fork 的 clone URL 与 origin 均为 `git@github.com:1zh3n/librarian.git`，upstream 为 `https://github.com/silverbulletmd/silverbullet.git`。本地共享检出位于 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/reader-ux-worktree`，分工基线为 `feat/librarian-reader-ux@c1059e72`。2026-11-21 在端口 4281 由 Rust fixture 提供 Reader 生产 bundle、隔离工作区、文档与设备设置 API。目录创建和读取沿用 Rust 的文件及 revision 实现。此前的编辑器技术验证见 [CodeMirror Spike 记录](phase-0-evidence.md)。

## 从目录定位到开始写

| 操作 | 实际结果 | 证据 |
| --- | --- | --- |
| 在读《在读》时，从「观测」同一行的两端打开菜单 | 1440×900 视口下点击 (51,240) 与 (183,240)，菜单左上角分别为 (53,242) 和 (185,242)。宽 144、高 82。屏幕右缘和下缘分别翻转，四边可见。侧栏页头和空白的新建目录为空，正文选区、链接和编辑器保留原生操作。 | [指针实拍](evidence/reader-directory-dock/directory-pointer.png) · [各目标与碰边坐标](evidence/reader-directory-dock/measurements.json) |
| 滚动至「研究/观测/样本23」，用 Shift+F10 新建，取消，再打开并提交 | 取消后焦点回到「样本23」，原阅读地址保留。提交后焦点进入 Markdown 正文，输入「继续观测。」并保存，Rust 回读路径为 `研究/观测/滚动定位后新建.md`，正文与首行输入一致。旧样板只露出选中行顶边。修订后选中行完整显示在 y=862–900，编辑器仍有焦点。 | [同状态改前](evidence/reader-directory-dock/created-before.png) · [改后](evidence/reader-directory-dock/nested-editor.png) |
| 390×844 模拟触屏，从文件夹行尾「更多」新建 | 行入口可见，点按区至少 44×44。触发同名错误后保留名称和「研究/观测」，改名为「夜间记录」后进入编辑器，直接输入「晚风」。目录关闭，文档实际创建于目标文件夹。 | [触屏目录](evidence/reader-directory-dock/touch-directory.png) · [目录、权限变更及只读回归](../../apps/reader/tests/e2e/document-workspace.spec.ts) |

## 收起、调整与恢复

| 操作 | 实际结果 |
| --- | --- |
| 用右方向键加宽左目录，拖至收起，刷新后展开 | 原尺寸 236px，调整后设备回读 308px。收起后展开按钮获得焦点，设备记录目录已关闭。刷新后从该按钮展开，实测恢复到 308px。旧版同一按键后设备仍回读 236px。 |
| 在 1440×900 下开启两侧面板，读取之前保存的 480px 工具宽度 | 网格限宽后的实际面板为 370px。End 到达可见上限时仍保留既有偏好。右方向键从实宽缩至 354px。拖动预览时设备值仍为 354px，Esc 恢复。再次拖动并松手后保存 330px，刷新后仍渲染为 330px。AI 输入框的草稿贯穿键盘和拖动操作。 |
| 切换 320、360、390px 与 1920px 视口 | 三个窄屏均隐藏右分隔器，设备仍回读 330px。1920px 下工具靠右，向右调整一步时左沿移动 16px、右沿保持原位。Home 到 200px，End 到当前列可用上限。 |

[右栏实拍](evidence/reader-directory-dock/desktop-tools.png) · [宽度及焦点测量](evidence/reader-directory-dock/measurements.json) · [设备回读与真实拖动用例](../../apps/reader/tests/e2e/document-reader-dock.spec.ts)

## 复测

Reader 构建后，以 `LIBRARIAN_PRODUCT_TEST_PORT=4281` 运行产品 Playwright 的 `document-workspace.spec.ts`、`document-reader-dock.spec.ts` 和 `reading-focus.spec.ts`，37 项通过。将右栏初始设备值固定为 480px 后，再运行两条分栏用例，均通过。中文首行采用 Chromium 文本输入；本次验收覆盖鼠标、键盘和模拟触屏。实体软键盘、读屏播报与墨水屏刷新待相应设备复核。
