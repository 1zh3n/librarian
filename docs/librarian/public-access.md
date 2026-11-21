# Librarian 域名、外网入口和账号方案

建议先给固定成员提供私有远程访问。继续使用单机 Librarian、独立数据根和应用内 Workspace 权限。需要公开文章时，通过 Zola 把审阅过的内容部署至独立的静态站点。确有跨组织编辑需求时，再给工作台增加公网身份网关。

## 域名与网络方案

| 情况 | DNS 与入口 | 访问控制与代价 |
| --- | --- | --- |
| 固定团队或个人从外网登录 | 使用现有 Tailscale 的 MagicDNS 与 Serve，后端保持回环监听。若必须用自有域名，可在私有 DNS 解析到可达的内网地址，并用 DNS-01 签发证书。 | 客户端需进入私有网络。按成员和设备授权，Librarian 继续核对账号与 Workspace 权限。 |
| 指定访客用普通浏览器登录 | 用受控子域名如 `app.example.com`，由 Cloudflare Tunnel 的代理 CNAME 指向托管隧道。连接器从服务器主动出站。 | 用 Access 的 IdP、允许列表及 MFA 保护入口，连接器或源站验证 Access 应用令牌。依赖外部网关，需评估内容经过服务商边缘和可达性。 |
| 自管公网工作台 | 在专用主机上把 `A` 和经验证的 `AAAA` 解析到对应公网代理。代理负责证书和 443，Librarian 仍走本机私有上游。 | 依赖专用可达地址、主机维护、入口限流、产品账号加固和事件响应。此路线等待安全审阅中的上线条件通过。 |
| 仅公开成稿 | 让独立站点的域名指向静态托管。构建和发布环节只获得经批准的文件以及静态站点写入权限。 | 公开阅读无应用账号，编辑、版本、备份和执行器继续使用私有工作台。 |

Tailscale Serve 支持私有访问和 tailnet DNS 证书，访问权限适用现有网络规则。为敏感设备使用中性名称，因为签发证书时证书名进入公开日志。自有域名的 DNS-01 只需公开验证用 DNS 记录，可将挑战委托给专门子域，验证凭证与应用主机分离。Cloudflare Tunnel 的应用域名使用代理 CNAME，代理应验证应用身份令牌，源站不应再配置可直达的公网入口。 [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) · [Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates) · [ACME DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge) · [Tunnel DNS](https://developers.cloudflare.com/tunnel/get-started/) · [Cloudflare Access 源站保护](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)

本机已存在 LAN 和 Tailscale 接口。当前网络证据只支持内网预发布，公网 IPv4 入站、IPv6 防火墙和运营商限制需按目标主机核对。直接开放前从一台外部设备核查域名解析、证书、登录前的拒绝、登录后的权限和源站不可直达。只发布实际验证可用并受到同等控制的地址记录。 [实际内网预发布](lan-pre-release.md)

## 账号与各类客户端

| 入口 | 当前实现 | 外网要求 |
| --- | --- | --- |
| Web 登录 | 产品本地密码，服务器会话 Cookie，管理员由 `librarian init` 创建。产品路由未接入上游账户管理和浏览器 OIDC。 | 试用阶段采用邀请制，由团队 IdP 或私有网络先核对入口。长期在产品接入 OIDC 与离职禁用、会话撤销及管理审计。 |
| Workspace | 服务器管理员、创建者、读成员与写成员。产品路径复用当前 Workspace 授权检查，服务器管理员具跨空间权限。 | 日常使用普通账号，管理员与运维账户分离。邀请、角色变更和解绑应可审计。 |
| CLI 投递 | 专用 Bearer 令牌，限指定 Workspace。单个 Workspace 内的来源隔离尚待加强。 | 给每个来源单独的服务身份、命名空间和可轮换的有限期令牌。 |
| MCP | 独立 OAuth 授权，已支持 PKCE、选定 Workspace、授权撤销与权限动态检查。 | 按获准能力固定权限上限。部署默认保留 `SB_MCP=0`，按需开放并限制客户端注册。 |
| AI 执行器 | 一个实例级凭证领取任务，租约内再核对发起人与 Workspace。 | 执行器只走私有入口，凭证按服务或 Workspace 拆分。真实模型接入前明确允许的数据类型和外部留存。 |
| 阅读分享 | 支持成员阅读和带随机访问凭证的共享链接。 | 敏感空间只开放成员阅读。公共展示优先使用独立静态站。需要分享时使用固定内容、到期时间和可撤销授权。 |

入口身份和 Workspace 授权需要同时成立。首轮可沿用现有 IdP，在网关要求 passkey 或同等级的抗钓鱼 MFA，并保留应用本身的账号检查。产品接入 OIDC 后用 `iss` 和 `sub` 绑定稳定本地账号。邮箱适合邀请和联系，账号关联需要显式确认。保留受控的应急管理员，日常身份不使用该账号。 [OpenID Connect 账号标识](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability) · [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) · [Librarian 权限](../../server/src/product/auth.rs#L100)

Cloudflare Access 可用独立 HTTP 服务令牌保护机器客户端。当前 `docs push` 已占用 `Authorization` 传应用令牌，未提供额外网关头参数。CLI、MCP 客户端和执行器应先通过私有网络，或逐个验证双层机读凭证支持。应用令牌与网关令牌分别管理。 [Access 服务令牌](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) · [docs CLI 请求](../../bin/docs/src/main.rs#L90)

## 放行顺序

1. 私有远程试用使用单独的试用数据根、固定小组和正常登录。记录主机名、信任链、许可成员与停用方式。
2. 配置选定的公网入口前，完成账号和内容边界整改。为拥有域名、网关及机器凭证的角色分别授权。 [上线阻断项](public-security-review.md)
3. 用目标代理上的真实域名复测深链接、HTTPS Cookie、同源写入、受保护的分享/附件、权限撤销、离线阅读、SSE 与临界上传。保持请求 Host 为预期域名并由可信代理设置转发协议，避免把用户提交的转发头一路透传。若启用 MCP，同时校验 `server.json` 的规范公网起始地址和 OAuth 发现。
4. 在独立客户端完成负向权限检查和备份还原演练。开通域名由部署者控制；应用、静态站、备份及模型服务各保留独立的停用开关。
