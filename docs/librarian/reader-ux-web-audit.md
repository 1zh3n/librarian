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

## 其余页面与下一轮

| 页面或流程 | 本轮观察 | 后续优先级 |
| --- | --- | --- |
| 文档 AI、版本恢复与引用 | 进入编辑、打开和关闭 AI 时，桌面测试长文的当前章节均保持 y=210。发送选区、实际引用与恢复新版本走产品回归。打开回答中的来源后，浏览器后退会收起原 AI 标签，再次查看回答多一步。 | 下一项。用「从回答核对来源 → 后退 → 继续原回答」验收工具状态、焦点和阅读位置。 [返回后的桌面](evidence/reader-ux-web/back-from-ai-source.png) · [实际引用与返回记录](evidence/reader-ux-web/source-return.json) |
| 登录与账号、空间成员 | 桌面登录输错密码后焦点在错误提示，用户名也被清空，纠错需多输一次。账号创建、改密和角色变更走产品回归。 | 次优先。保留本次输入的用户名，密码继续清空；复测键盘纠错和登录返回地址。 |
| 新建空间、常规设置与外部导入 | 主页、成员、导入及新建空间在 1440 px 下均无页面横向溢出。导入、冲突与重试沿用现有产品回归。 | 本轮保留现有页面结构。 |
| 备份、站点发布、只读和离线访问 | 管理者切换具体任务仍可选择目标或提交；固定阅读地址仍可打开、撤销、离线读取，涉及发布的浏览器回归使用本地 Git 和 Zola。 | 使用合成目标验证，生产外部仓库、真实读屏和实体墨水屏另验。 |

桌面逐页测量涵盖常规设置、成员、外部导入、备份与发布、账号、新建空间、Workspace AI 与共享阅读。同一套 Web 在窄屏保留可读性、菜单、设置和输入入口。 [桌面基线](evidence/reader-ux-web/desktop-pages-before.json) · [桌面修订版](evidence/reader-ux-web/desktop-pages-after.json)

## 联合验收

在此工作树构建 Reader 并由 Rust fixture 提供静态资源和 API。完整产品 Playwright 85 项、编辑器 Spike Playwright 16 项、Vitest 52 项全部通过。类型、lint、格式、OpenAPI 生成结果一致性和生产构建均通过。浏览器版 Zola 发布验证使用本机 Zola。 [目录前后对照](evidence/reader-ux-web/context-comparison.png) · [长标题前后对照](evidence/reader-ux-web/heading-comparison.png)
