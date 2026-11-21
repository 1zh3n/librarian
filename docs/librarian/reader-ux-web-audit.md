# Reader 桌面 Web 走查与定点优化

2026-11-21。桌面 Chromium，浅色，1440×900 CSS px。对照产品提交 `393e9afd` 与分支 `feat/librarian-reader-ux`。两边均使用 Rust 产品服务和隔离的合成工作区。长文阅读、目录菜单与共享阅读分别使用相同内容和操作，各自记录坐标。小屏、触摸模拟和文字缩放用作 Web 兼容回归。

## 本轮修正

| 优先级和场景 | 实际阻力 | 改动与验收证据 |
| --- | --- | --- |
| 高 · 在目录指定位置新建 | 右键同一行的两个位置，菜单横坐标总是 12。鼠标点在 x=183 时，菜单右边缘甚至在它左侧 27 px。行下空白落入浏览器菜单，常驻「新建文档」又与菜单重复。 | 整行、树下空白各自识别操作对象。正常位置在指针右下 2 px；靠右或靠下时各自翻转。当前打开的文档保持不动。键盘菜单锚在目标行，取消回原处。根目录「更多」和空空间的首篇文档入口保留可发现性。 [改前画面](evidence/reader-ux-web/context-before.png) · [改后画面](evidence/reader-ux-web/context-after.png) · [五个实测坐标](evidence/reader-ux-web/menu-after.json) |
| 高 · 保存已填表单 | 新建中途失去写权限会销毁已填写的表单。设备设置在首次偏好请求返回前打开时，默认值可能覆盖用户已有设置。 | 新建收到权限变化后保留文档名称和目录并停用提交。个人设置等待真实偏好载入，失败时可重试。两条路径均加入产品浏览器测试。 [新建测试](../../apps/reader/tests/e2e/document-workspace.spec.ts) · [偏好测试](../../apps/reader/tests/e2e/reading-focus.spec.ts) |
| 高 · 提纲与长文目录 | 桌面提纲看似有一整页可写，实际编辑器只有 108 px 高；从文档深处打开目录需要重新找章节，键盘跳转后焦点留在目录链接。 | 提纲可输入高度增到 687 px，可直接点击下部输入。打开长目录会显示当前章节，Enter 跳到目标标题并把键盘焦点移入正文。桌面目录保持展开，便于连续查阅。 [改前测量](evidence/reader-ux-web/reading-before.json) · [改后测量](evidence/reader-ux-web/reading-after.json) |
| 中 · 阅读与工具层级 | 长中文标题断成一长一短两行；只有两条引用也会撑满 766 px 高的面板。 | 样本文档两行由 753/100 px 调为 401/452 px，保留原字号与正文行宽。短引用面板缩至 205 px；版本随内容伸缩，提纲与 AI 保留操作空间。 [阅读前](evidence/reader-ux-web/reading-before.png) · [阅读后](evidence/reader-ux-web/reading-after.png) · [引用前](evidence/reader-ux-web/references-before.png) · [引用后](evidence/reader-ux-web/references-after.png) |
| 中 · 搜索与个人设置 | 无匹配时关搜索需要按两次 Esc。通过快捷键打开搜索再进入设置，关闭后焦点掉到页面背景。个人设置藏在布局菜单中。 | 顶栏并列「布局」「搜索」「设置」。无匹配一次 Esc 关闭；鼠标从设置按钮打开后回到该按钮，快捷键从正文发起则回到正文。实测滚动位置保持 455 px。 [设置前](evidence/reader-ux-web/settings-before.png) · [设置后](evidence/reader-ux-web/settings-after.png) · [焦点与位置](evidence/reader-ux-web/search-after.json) |
| 中 · 分享和发布 | 「备份与发布」把三个表单串起来，共享阅读表单标题在 y=915。长清单只能滚动逐项找，已选文档离开视野就无法核对数量。 | 保留「备份与发布」入口，管理员可在阅读地址、站点发布、Git 备份间切换；只拥有分享能力的用户直接进入表单。阅读地址标题现位于 y=340。长清单支持按路径或标题筛选，跨查询保留勾选和总数。有效期、版本和附件就近展开。 [同屏改前](evidence/reader-ux-web/sharing-before.png) · [同屏改后](evidence/reader-ux-web/sharing-after.png) |
| 中 · 打开共享阅读地址 | 16 篇长标题在正文之前平铺；桌面正文标题从 y=356 才开始。 | 默认收起文档目录，标题位于 y=166。当前篇目有标识，键盘选下一篇后聚焦新标题。单篇阅读地址直接展示正文。 [改前](evidence/reader-ux-web/snapshot-before.png) · [改后](evidence/reader-ux-web/snapshot-after.png) |
| 中 · 确认或取消 | 文档名称已填好，「创建文档」仍和「取消」同为透明背景与相同文字颜色。 | 为 Reader 显式主操作统一使用主题强调色，并区分悬停和禁用。 [创建前](evidence/reader-ux-web/create-before.png) · [创建后](evidence/reader-ux-web/create-after.png) |

## 首轮走查时保留的问题

下表记录起点。来源往返与登录纠错的修订结果见下文。

| 页面或流程 | 本轮观察 | 后续优先级 |
| --- | --- | --- |
| 文档 AI、版本恢复与引用 | 进入编辑、打开和关闭 AI 时，桌面测试长文的当前章节均保持 y=210。发送选区、实际引用与恢复新版本走产品回归。打开回答中的来源后，浏览器后退会收起原 AI 标签，再次查看回答多一步。 | 下一项。用「从回答核对来源 → 后退 → 继续原回答」验收工具状态、焦点和阅读位置。 [返回后的桌面](evidence/reader-ux-web/back-from-ai-source.png) · [实际引用与返回记录](evidence/reader-ux-web/source-return.json) |
| 登录与账号、空间成员 | 桌面登录输错密码后焦点在错误提示，用户名也被清空，纠错需多输一次。账号创建、改密和角色变更走产品回归。 | 次优先。保留本次输入的用户名，密码继续清空；复测键盘纠错和登录返回地址。 |
| 新建空间、常规设置与外部导入 | 主页、成员、导入及新建空间在 1440 px 下均无页面横向溢出。导入、冲突与重试沿用现有产品回归。 | 本轮保留现有页面结构。 |
| 备份、站点发布、只读和离线访问 | 管理者切换具体任务仍可选择目标或提交；固定阅读地址仍可打开、撤销、离线读取，涉及发布的浏览器回归使用本地 Git 和 Zola。 | 使用合成目标验证，生产外部仓库、真实读屏和实体墨水屏另验。 |

桌面逐页测量涵盖常规设置、成员、外部导入、备份与发布、账号、新建空间、Workspace AI 与共享阅读。同一套 Web 在窄屏保留可读性、菜单、设置和输入入口。 [桌面基线](evidence/reader-ux-web/desktop-pages-before.json) · [桌面修订版](evidence/reader-ux-web/desktop-pages-after.json)

## 首轮联合验收

在此工作树构建 Reader 并由 Rust fixture 提供静态资源和 API。完整产品 Playwright 85 项、编辑器 Spike Playwright 16 项、Vitest 52 项全部通过。类型、lint、格式、OpenAPI 生成结果一致性和生产构建均通过。浏览器版 Zola 发布验证使用本机 Zola。 [目录前后对照](evidence/reader-ux-web/context-comparison.png) · [长标题前后对照](evidence/reader-ux-web/heading-comparison.png)


## 从 AI 回答核对来源再返回

开发继续在独立工作树 `librarian/.superpowers/sdd/reader-ux-worktree`、分支 `feat/librarian-reader-ux` 上进行。本轮起点为 `c1059e72`。clone 与 origin 均为 `git@github.com:1zh3n/librarian.git`，upstream 为 `https://github.com/silverbulletmd/silverbullet.git`。核对了 Rust 产品路由、Space 与文件适配器、revision 读写路径以及 §13.7 的桌面拼音、即时预览、Markdown 原字节和读写锚定记录。 [Spike 验收](phase-0-evidence.md) · [单文档验收](phase-1-evidence.md)

在 Chromium 的独立 Rust fixture 中，读到长文中段，向文档 AI 提问，收到执行器替身的真实来源回执，再输入一条未发送的追问。将对话卷回第一条回答，用 Enter 打开引文，然后按浏览器后退。旧分支回到文章开头并收起辅助区。修订后回到发起核对的引用链接，正文和对话各自恢复滚动，追问仍在输入框内。桌面与窄屏采用同一条操作链。改前图取自失败用例轨迹，播放器对图片做了缩放。

| 视口 | 实装画面和操作数据 |
| --- | --- |
| 1440 × 900 | [改前](evidence/reader-ux-web/source-back-1440-before.jpeg) · [返回后](evidence/reader-ux-web/source-back-1440-after.png) · [正文、对话与键盘焦点](evidence/reader-ux-web/source-back-1440-after.json) |
| 390 × 844 | [改前](evidence/reader-ux-web/source-back-390-before.jpeg) · [返回后](evidence/reader-ux-web/source-back-390-after.png) · [正文、对话与键盘焦点](evidence/reader-ux-web/source-back-390-after.json) |

在来源页进入空间设置后连续后退两次，也能回到原回答。同篇来源有独立的追问草稿。若点击后取消离开，随后从目录切换文档，已取消的引用记录不会覆盖新的草稿或重开辅助区。正文保存与离开同时发生时，以服务端确认的版本和选区发出下一条追问。以上路径使用真实导航、编辑和保存，并用可控的回答记录复现时间顺序。 [浏览器回归](../../apps/reader/tests/e2e/document-citation-navigation.spec.ts)

整篇正文、段落及提纲的链接都带回执版本。提纲核对自己的版本，来源已变更时页面就近提示。服务器返回 401、403 或 404 后撤下此前可见的正文。单独拒绝提纲时正文仍可读。临时读取失败保留编辑草稿。在完整源码中点击本篇段落引文，阅读态会聚焦对应段落。用 Chromium 模拟中文组合输入时，结束组词后也会聚焦引文。权限变化和时间顺序用可控的 API 响应与 Chromium 验证。 [来源目标与失效回归](../../apps/reader/tests/e2e/document-citation-targets.spec.ts)

## 登录纠错

输错密码后，用户名留在原字段，错误信息关联到两个字段，焦点移到已清空的密码框。可直接重输密码并返回带查询参数的原地址。限流状态保留独立提示。 [改前](evidence/reader-ux-web/login-before.png) · [改后](evidence/reader-ux-web/login-after.png) · [键盘操作](evidence/reader-ux-web/login-keyboard-after.json)

## 改版各路径的验收入口

| 使用路径 | 同状态画面和操作数据 |
| --- | --- |
| 在目标目录新建并开始写，调整两侧分栏 | [目录、首行输入、焦点及尺寸](reader-directory-dock.md) |
| 长文阅读、就地编辑与工具切换 | [1440、390、360、320 px 与 200% 文字缩放](reader-layout-verification.md) |
| 搜索、设置、新建和键盘命令 | [迁移前后画面](evidence/reader-collections/overlay-comparison.png) · [设置草稿与焦点](evidence/reader-collections/interactions.json) |
| 账号、导入、备份、发布及旧离线地址 | [逐页对照与固定版本升级](reader-management-verification.md) · [表单触控与错误纠正](evidence/reader-controls/interactions.json) |

## 本轮联合验收

产品实现提交为 `5d9ca253`，使用分支 `feat/librarian-reader-ux` 的 Vite 生产构建和隔离的 Rust 产品服务。实测服务返回的 `/assets/reader-shell.json` 与本地构建逐字节相同，SHA-256 为 `18ddac850a5c4ce2f91caf85f239b567cb6c3768190c863ec00f4ac8900c5ef1`。

| 验收 | 结果 |
| --- | --- |
| 产品 Playwright 全套 · Chromium、真实 Rust API、本地 Git 与 Zola 0.23.6 | 142/142 通过，3 个 worker。覆盖长目录键盘新建、登录纠错、搜索与设置草稿、引用往返、版本恢复、导入、备份、发布和离线地址。 |
| CodeMirror Spike Playwright 与 Reader Vitest | 16/16 与 58/58 通过。 |
| Librarian 发行二进制 crate 的 Rust 测试 | 83/83 通过。 |
| 类型、组件边界和 lint、格式、OpenAPI 一致性、生产构建 | 全部通过。 |

来源往返另外在独立 fixture 逐一复测 1440 和 390 px，并更新了上文两组画面和测量。两个视口返回前后的对话滚动分别为 462 和 658 px，引用链接均获得焦点，正文阅读块坐标分别保持在 457.5 和 845.5 px。收起辅助区回到打开它的段落。设置弹窗与新建弹窗都在提交等待及失败重试中核对过输入值，搜索弹窗内的 Alt+E 不会编辑背后的正文。 [弹窗回归](../../apps/reader/tests/e2e/document-dialog-input.spec.ts)

本轮覆盖 Chromium 的键盘、指针、触屏模拟和文字缩放。AI 使用本地执行器替身，发布使用本地 Git 目标。实体手机软键盘、读屏、墨水屏与真实供应商接入沿发行计划复核。

## 从正文落笔，到目录改名

本轮从 `999a4531` 开始。用户希望写作时只看到光标，能就地预览；点中文字就在那个字符处输入，点文字附近的留白就地定位，点整篇正文下方则进入文末可写空行。引用和列表的非空项按 Enter 续写，空项按 Enter 退出当前层。

在 Chromium 中，原版点击粗体第一个字的左半边，会把输入加在粗体外；点击粗体后普通文字的第一个字，又会把输入加进粗体。现在分别从文本节点起点映射到它自己的 Markdown 范围，用保存后读回的原文验证。点空白新增的换行可以单独撤销。即时预览参考 Typora 对光标所在语法的呈现，列表的缩进和编号沿用 CodeMirror 命令。 [正文走查](evidence/reader-editing-workflow/writing.png) · [格式边界用例](../../apps/reader/tests/e2e/document-edit-boundary.spec.ts) · [Typora 即时预览](https://support.typora.io/Quick-Start/) · [CodeMirror Markdown 命令](https://github.com/codemirror/lang-markdown/blob/main/src/commands.ts)

桌面 X11 上用真实 IBus 拼音输入 `zhongwen`，首个 Enter 按输入法设置提交拼音原串，第二个 Enter 才写入换行和引用前缀。嵌套引用、任务列表、有序列表、围栏和撤销在浏览器另测。 [IBus 事件与原文](evidence/reader-editing-workflow/desktop-ibus-enter.json) · [按键回归](../../apps/reader/tests/e2e/editor-markdown.spec.ts)

从「渡口走访手记」的目录里给另一篇「船工访谈」改文件名。重名时保留输入，成功后手记的滚动位置维持 650 px，原章节仍在视口 y=240。目标文档保留 ID、提纲和 Markdown，目录可同时看到自定义标题和新文件名。成员阅读地址按文档 ID 定位。其他文档内写死旧文件名的相对链接需要另行更新。 [改名窗口](evidence/reader-editing-workflow/rename-prompt.png) · [改名后](evidence/reader-editing-workflow/reading-after-rename.png) · [触屏](evidence/reader-editing-workflow/touch-rename.png) · [API 与位置记录](evidence/reader-editing-workflow/after.json)

目录、空间设置、搜索、登录与文档工具复用 Reader 的 Lucide 图标。图形继承文字颜色，按钮负责名称和热区。HeroUI 提供按钮和选择控件的状态语义，应用可以自行提供业务图标。 [组件与真实热区用例](../../apps/reader/tests/e2e/document-icons.spec.ts) · [HeroUI 按钮](https://heroui.com/en/docs/react/migration/button) · [HeroUI 选择控件](https://heroui.com/en/docs/react/components/select)

在第 11 站点进正文，第一帧就输入并打开搜索。原来的位置恢复会因缓冲区有新文字而中断，受控复现中标题从视口 y=210 跳到 y=704。修正后连续输入会映射回同一锚点，关闭搜索后仍看得到正在写的一段。 [首帧输入与返回用例](../../apps/reader/tests/e2e/document-redesign-acceptance.spec.ts)

交付构建通过 164 项产品 Playwright、31 项编辑器 Spike Playwright、58 项 Vitest，以及类型、组件边界、lint、格式和 OpenAPI 一致性检查。对局域网 HTTPS 服务回读的资源清单与本地构建逐字节一致。使用普通试用账号从「河岸清晨」打开改名框、取消，再进入编辑和返回阅读，原地址可继续使用。

在 Chromium 上连续点三次文末空白，其中一次先按 Esc 回到阅读。旧版会追加三个换行。修正后第一次只追加一个换行，后两次复用该行，期间只有一次正文保存请求。随后输入「明早继续。」并从 API 回读，文字就在第二行。空文档、已有多行留白和缩进的原文也分别验证了输入与撤销。 [第三次点击后的光标](evidence/reader-editing-workflow/reused-final-line.png) · [浏览器回归](../../apps/reader/tests/e2e/document-edit.spec.ts)

在 1280 × 800 的三段短文中，点第一行句号右方 65 px，输入「岸边已能落脚。」，API 回读显示这句话接在第一段原句末尾，另两段完整。随后点最后一段下方两次，只补入一个换行。浏览器同时覆盖桌面和窄屏折行两侧、段间上下两侧、长文视口下沿、引用列表缩进，以及预览和源码中的已存空行。 [第一行续写画面](evidence/reader-editing-workflow/nearby-line-end.png) · [阅读纸面落点](../../apps/reader/tests/e2e/document-edit.spec.ts) · [编辑器坐标回归](../../apps/reader/tests/e2e/editor-paper-placement.spec.ts)
