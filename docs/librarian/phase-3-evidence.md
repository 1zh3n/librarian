# 阶段 3 验收记录

- 实现分支为 `feat/librarian-phase-3`，基线为阶段 2 的 `21d6165b87335c7a07c129246737b02d151400d9`。
- 工作区位于 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/phase-3-worktree`。Fork 与 `origin` 为 `git@github.com:1zh3n/librarian.git`，`upstream` 为 `https://github.com/silverbulletmd/silverbullet.git`。

## 3.1 Workspace

- 管理路由最初返回 404 或 405。八项测试通过后，真实账号可新建独立受管 Space。管理权限、原件和 Git 在重启后保留。临时转长期保持 Workspace 和文档 ID。
- 目录和文件重命名共用文件事务，保留提纲、二进制附件和稳定 ID。路径冲突保持双方文件，模拟 Git 提交后映射落库失败时可以在重启后恢复映射。
- 过期空间先关闭访问及投递凭证。临时目录被移到私有清理区。用真实文件复现了旧路径被重新占用的场景，修复后重启清理只清除私有清理区，原路径新增文件保留。若 `spaces/` 和 `.librarian/` 跨文件系统，访问仍会关闭，实体清理延后。

## 3.2 投递

- HTTP、CLI、MCP 和浏览器上传共用投递服务。同一请求指纹返回原回执，更新使用上一次的内容基线。真实 SQLite 和 Git 测试覆盖二进制附件、原文 BOM 与行尾、已经修改的人工原件、旧版本和凭证撤销。
- ZIP 以 `application/zip` 分块暂存并核查压缩与展开限制。JSON 和流式 ZIP 的等价请求得到同一版本。测试拒绝越界路径、非安全入口、大小写及 Unicode 别名、文件和目录冲突、过大文件。相同原始附件通过受权端点读回。
- 真正的 `docs push` 二进制以仅投递凭证调用运行中的 Librarian。测试包连发两次得到操作 `5645a6cf-801e-41eb-a07a-b90bd84c8355` 和同一 Git 提交 `22044eaf9f3391ec62b38982336d11dd50a28cbe`。测试附件 SHA-256 为 `c634f3ed3ee52272d7ca30fabba7d247f8d32e22bd8e90ce27f09b7deed02ddf`。使用该凭证列表读取返回 401。 [投递说明](delivery.md)

## 3.3 Reader Snapshot

- Current 随稳定 ID 跟进正文和路径，Release 固定到选定 Git 版本与历史路径。五项 Rust 集成覆盖最新及旧版 Markdown、原始附件字节、受保护 Git 引用、同名文件被替换后的读取、历史路径和重启。
- 浏览器验证匿名分享、范围内跳转及撤销。原地址过期或撤销后，正文与附件接口同步拒绝。对临时和已转长期 Workspace 做实际重启清理，检查过期镜像删除及长期版本仍可访问。
- 管理界面可撤回本次打开时生成的链接。已有链接可以通过对应的撤销 API 管理。
- Reader 通过 34 项真实产品 Playwright、16 项编辑器 Spike Playwright、43 项 Vitest 和生成 API、严格类型、lint、格式及生产构建检查。六项新浏览器用例覆盖 360 px 创建和转长期、重命名深链接、原始 ZIP 与附件、凭证、分享与撤销、更新后固定历史阅读。
- Rust 产品集成共 62 项通过，docs CLI 单测 3 项，上游 MCP 测试 177 项。OAuth 回环验证新增的 `workspace_publish` 复用 HTTP 投递回执。
