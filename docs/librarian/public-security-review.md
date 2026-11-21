# Librarian 公网安全审阅与损失控制

**结论**　当前版本适用于隔离数据的内网试用。建议先给固定成员提供私有远程访问。开放公网工作台或允许不同团队共享实例前，处理下列高优先项并按实际入口复验。审阅基线为发行源码 `dd1fcbd2`。检查覆盖产品路由、浏览器输出、文件和 Git、账户与令牌、AI 及外部集成。 [内网预发布](lan-pre-release.md) · [公网与账号方案](public-access.md) · [OWASP ASVS 5.0](https://asvs.owasp.org/)

## 上线前优先处理

| 优先级 | 代码中确认的边界 | 影响与修复验收 |
| --- | --- | --- |
| 高 | 登录失败用全站共享计数，默认每个 60 秒窗口 10 次。 | 公网登录可用性取决于任何来源的失败量。加入口身份限制、可信来源与账号维度限流、密码校验并发上限。验证单一账号、单一来源的限流不会锁住无关用户。 [登录](../../bin/librarian/src/mcp.rs#L336) · [全局计数](../../server/src/auth/lockout.rs#L7) · [默认值](../../server/src/auth/config.rs#L1) |
| 高 | CLI 投递凭证绑定 Workspace，调用方仍可指定同空间内任意 `deliveryId`。 | 同一 Workspace 的不同来源会共享投递更新边界。一份凭证失陷可能影响其他来源。凭证应绑定单一来源并具有独立过期、轮换、撤销和审计。上线前可为不同来源使用独立空间。 [凭证和更新](../../server/src/product/delivery.rs#L211) · [命名空间](../../server/src/product/delivery.rs#L450) |
| 高 | 部署者配置的 Git 备份目标列表可由所有 Workspace 管理者选择，目标缺少 Workspace 绑定。 | 不同数据责任人共用实例时存在目标误用和首次分支占用。像 Zola 一样在目标配置绑定 Workspace，列表、保存、执行、重试均重新授权。在共用实例上暂缓配置备份目标。 [备份选择](../../server/src/product/backup.rs#L326) · [Zola 目标绑定](../../server/src/product/publication/config.rs#L107) |
| 高 | Zola 只对部分原生 HTML 做链接检查，复制所引用附件的原始字节。缺省状态的文档被选中确认后可按正式页面发布。 | 如对公网原样托管，主动内容可能在读者浏览器执行。发布源应明确标记公开、预览实际输出与附件，限制原生 HTML 和附件类型。静态站使用独立域名和受限构建身份。验证未标记内容以及未允许的文件类型都无法出站。 [Zola 转换](../../server/src/product/publication/render.rs#L110) · [附件与状态](../../server/src/product/publication/render.rs#L153) · [Zola 同目录静态资源](https://www.getzola.org/documentation/content/overview/#asset-colocation) |
| 高 | 写成员可创建可选到期的匿名分享，当前地址会持续读取之后编辑的内容。 | 初始分享范围可能包含未来写入的私密数据。公开分享需明确发布权限、默认为固定版本、有限有效期、精确附件预览和集中撤销。敏感空间只提供成员阅读。 [创建与范围](../../server/src/product/snapshots.rs#L162) · [当前地址](../../server/src/product/snapshots.rs#L505) |
| 高，启用对应服务时 | 普通 Bearer 复用账号全部权限。AI 领取使用实例级凭证。MCP 授权按 Workspace 检查实时角色，审批记录缺少角色提升后的权限上限。 | 一把管理员账号令牌可跨 Workspace。实例级执行器被盗会影响所有有任务的已启用空间。已有 MCP 委托可能随角色提升扩大。使用按用途、按 Workspace、有限期的服务凭证，AI 入口私有化，MCP 固定授权时能力上限并允许重授权。 [账号令牌](../../server/src/multi/users.rs#L760) · [AI 领取](../../server/src/product/ai_runner.rs#L92) · [MCP 同意](../../server/src/handlers/mcp_oauth.rs#L610) |
| 中 | Reader 主页面缺少 CSP、防嵌入与 HTTP Referrer 策略。普通文档和编辑预览可自动加载外部图片。共享凭证位于 URL 路径。 | 为主页面建立 CSP 和防嵌入，先核对编辑器、Worker 和 SSE。默认拒绝第三方媒体自动加载，公开分享使用 `Referrer-Policy: no-referrer` 并在代理与监控中脱敏路径。 [HTML 响应](../../server/src/product/router.rs#L90) · [预览图片](../../apps/reader/src/editor/codemirror/livePreview.ts#L220) · [W3C CSP](https://www.w3.org/TR/CSP3/#directive-frame-ancestors) |
| 中，存储可被其他进程改动时 | 产品先验证相对路径及组件，磁盘适配器按路径另行打开并支持跟随符号链接。 | 若外部进程能改写 Workspace，检查和打开之间的边界可能失效，搜索索引也应使用相同的约束。部署使用专有数据根，禁止共享可写挂载。开放此类挂载前引入目录描述符相对的无链接文件访问。 [文件检查](../../server/src/product/documents.rs#L327) · [磁盘读取](../../server-common/src/space/disk.rs#L120) · [搜索复核](../../server/src/product/search.rs#L84) |
| 中 | 上传有单请求限制，Workspace 创建、AI 队列和整体上传暂存缺少完整的租户额度。MCP 匿名动态注册还使用共享注册配额。 | 账号或自动化凭证被滥用时可耗尽磁盘、查询、队列和公网模型预算。分账号及空间设置上限，限制上传并发和空闲时间，限制公开 MCP 注册。 [Workspace 创建](../../server/src/product/workspace.rs#L431) · [投递暂存](../../server/src/product/delivery.rs#L183) · [MCP 客户端](../../server/src/auth/mcp/clients.rs#L103) · [OWASP 上传限制](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) |

## XSS 与路径防御核对

- Reader 解析 Markdown 后使用 `rehype-sanitize`，安全渲染与原始 Markdown 存储保持独立。Reader 附件通过授权 API，严格限制可内联类型，并返回 `nosniff`。登录和 MCP 同意页有自己的安全头。审阅确认了 Reader 既有控制和上表的输出边界。 [Markdown 保真与清理测试](../../apps/reader/tests/markdown-fidelity.test.ts) · [快照附件测试](../../bin/librarian/tests/snapshots.rs#L356)
- 文档与投递检查相对文件路径，拒绝危险路径分段。ZIP 导入拒绝符号链接等特殊条目、重名与归一化别名，限制解包大小和条目数。快照使用经授权的选择范围，Git 固定版读取经验证的 blob。磁盘共享的前提见上表。 [路径校验](../../server/src/product/mutations.rs#L528) · [ZIP 检查](../../server/src/product/delivery.rs#L668) · [归档回归](../../bin/librarian/tests/deliveries.rs#L292)
- 浏览器写入校验同源，退出撤销服务器会话。真实入口应固定 Host 并由可信代理覆盖转发协议。OAuth 的外部客户端元数据取用默认限制 HTTPS、公开地址和重定向。系统 DNS 返回 fake-IP 或其他非公网地址时，CIMD/JWKS 解析可用固定公共 DoH 回退；DoH 端点 pin 到 `1.1.1.1`，只接受公网答案，正常公网解析不发请求。登录页 CSP 对 React Aria 注入的 pressable 样式使用 SHA-256 白名单，不启用 `unsafe-inline`。公开入口仍建议默认关闭 MCP。 [同源测试](../../bin/librarian/tests/document_api.rs#L579) · [来源计算](../../server/src/auth/cookie.rs#L53) · [外部请求策略](../../server/src/auth/mcp/net.rs#L55)

## 依赖检查

对锁文件运行 OSV-Scanner 2.7.1 和 Reader 的 `npm audit --omit=dev`，再用 `cargo tree` 区分发行依赖和仅工作区依赖。命中版本代表需要判定的依赖范围，公网可达性要按特性和调用链判断。 [OSV-Scanner 锁文件范围](https://google.github.io/osv-scanner/usage/scan-source/)

- Rust 发布依赖命中 9 个 crate。ZIP 8.6.0 有多条公告。产品投递按条目读取、限制展开并拒绝符号链接，未走通用 `extract`，发行依赖图也未启用旧式解码和 AES 特性。公开投递前应升级到覆盖这些公告的 ZIP 版本，再回归现有包兼容性、路径约束和解包体积限制。 [产品 ZIP 读取](../../server/src/product/delivery.rs#L668) · [ZIP 路径公告](https://rustsec.org/advisories/RUSTSEC-2026-0546.html) · [旧式 ZIP 特性公告](https://rustsec.org/advisories/RUSTSEC-2026-0547.html)
- 其余命中包括 `crypto-bigint`、`lru`、`rsa`、`rustix` 和 `tokio`，以及 `chrono`、`paste`、`unsafe-libyaml` 的维护状态公告。优先核对鉴权、来自网络的资源和公开输入是否进入受影响函数。Tokio 可在当前版本线升级至 1.53.3 或更新修复版。 [Tokio 公告](https://rustsec.org/advisories/RUSTSEC-2026-0386.html)
- npm 标记 `source-map-js` 1.2.1 为高风险。Reader 的依赖链经 Vite 的 PostCSS 和 Sass 进入构建过程。本次未确认 Reader 浏览器代码使用受影响函数。升级锁定版本至 1.2.2 或更新修复版并复测生产构建。 [GitHub 公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)

本轮重跑了账号、投递、快照、AI 和 MCP 的 45 项 Rust 集成及 52 项 Reader 单测。结果覆盖现有防御路径，发现项的整改验证另在公网放行条件中。

## 敏感数据处理

先按 Workspace 设置用途。普通内部空间可以使用常规编辑和经配置的备份。受限空间默认禁止匿名链接、离线复制、远端 Zola 发布和向外部模型发全文。高敏数据放在独立实例或专用存储边界，服务账户、数据根和密钥分开。产品当前需要补齐可强制执行的空间策略。保留一般文档普通 AI 改写直接形成可恢复版本的产品行为。

- **密钥**进入部署秘密存储或独立受限文件。Workspace 原文、提纲、附件、Front Matter、AI 提示词和构建模板均按可被 Git、分享、备份或外部模型复制的数据处理。投递和公开发布前检测常见凭证及私密元数据。误存时先撤销凭证，再评估原文、历史、备份和外部目标的清理范围。
- **外发**按渠道单独批准。AI 执行器只能读取当前任务所在空间，但可按需取正文并发送至实际模型服务。受限空间选本地模型、禁用 AI 或显式选择并脱敏来源。控制输入预算、答案和事件留存。Zola 执行身份只获得读取构建输入和写入目标的权限，设置出站限制。 [AI 来源读取](../../server/src/product/ai_runner.rs#L369) · [模型请求](../../bin/librarian/examples/ai_runner.mjs#L481) · [OWASP AI 敏感信息披露](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/)
- **离线与分享**当作设备上新增的副本。当前浏览器缓存会保存全文及选中附件。在线退出、换账号和收到拒绝时可以清理；断网期间服务端撤销无法传达。增加到期的物理清理与容量上限，受限空间不允许保存离线副本。 [离线保留逻辑](../../apps/reader/public/sw.js#L65)
- **备份**采用单独的服务身份和受保护存储。Git 备份记录全树及相关历史对象，整目录归档还含账户和签名状态。对异地归档加密并保留应用身份无法删除的版本，定期抽查恢复完整性。可从每日备份和四小时恢复目标起步，再用数据量和真实还原时间调整。 [Git 备份说明](git-backup.md) · [CISA 备份与恢复指南](https://www.cisa.gov/sites/default/files/2025-03/StopRansomware-Guide%20508.pdf)
- **审计与恢复**记录登录告警、成员变更、令牌发放与撤销、分享和发布操作的主体、目标、时间及结果。日志不采集正文、提示、认证头、分享令牌和真实密钥。事故时隔离入口，停用被影响的发布、运行器和分享。从可信快照在私网恢复，轮换会话签名、重置已发令牌与授权，再开放访问，避免恢复旧授权。 [数据备份范围](deployment.md)

## 公网放行证据

1. 真实目标域名、TLS、入口身份与应用 Workspace 鉴权一起验证。普通用户、管理员、服务凭证和陌生客户端各有明确拒绝路径。
2. 审阅中适用于所选入口的高优先项有代码改动和回归测试。明确关闭暂未达到边界要求的 MCP、公开分享、备份目标或外部执行器功能。
3. 核对公网静态产物、可内联附件、日志脱敏和模型输出范围。对异常负载能按账号或空间限流。
4. 按实际数据容量完成加密异地备份、独立还原和撤回公网入口。内网演练已验证停机和本机独立恢复。 [内网预发布验收](lan-pre-release.md)
