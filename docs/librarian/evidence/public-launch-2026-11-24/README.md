# 公网部署演练证据（2026-11-24）

目标：在真实 Vultr 主机、真实域名和 Cloudflare 免费套餐上完成上线前演练。此主机仍标记为演练环境，不直接作为生产实例。

## 环境

- 主机：Vultr `45.76.150.132`，Ubuntu 26.04.1 LTS，1 vCPU / 950 MiB / 23 GiB，2.3 GiB swap。
- 域名：`librarian.zanghua.dev`，Cloudflare 免费套餐，代理开启。
- 入口：Cloudflare → Caddy 2.11.9 → `127.0.0.1:8080`。
- 应用：`librarian 0.1.0`，数据根 `/var/lib/librarian/data`。
- 后续部署：`feat/librarian-public-hardening` @ `145ad2bc`，运行 `librarian-0.1.0-linux-x86_64-20261124T134936Z`。
- 生产规格建议仍为 2 vCPU / 4 GB 起步；当前主机只用于功能演练。

## 入口和 TLS

- Cloudflare Origin CA 证书签发到 2041-11-19，CN/SAN 为 `librarian.zanghua.dev`。
- SSL/TLS：Full (strict)。
- Always Use HTTPS：开。
- 最低 TLS：1.2。
- HSTS：`max-age=86400; includeSubDomains`。
- Authenticated Origin Pulls：全局模式开启；Caddy `client_auth` 为 `require_and_verify`。
- Cloudflare 段：22 个 IPv4/IPv6 段写入 `/etc/librarian/cloudflare.env` 和 UFW。
- DNSSEC：NameSilo 已写入 DS，Cloudflare 状态 `active`；Cloudflare 和 Google DoH 对 DS 与 `librarian` A 记录均返回 `AD: true`。

```text
zanghua.dev. 3600 IN DS 2371 13 2 BB93F991EF91A0701C5F0AE9BFEC02E631A40010B80A394C460B1F685942F531
```

外部检查：

```text
PASS HTTPS URL responds
PASS public header ^strict-transport-security:
PASS public header ^content-security-policy:
PASS public header ^referrer-policy: no-referrer
PASS public header ^x-frame-options: DENY
PASS public header ^x-content-type-options: nosniff
PASS HTTP redirects to HTTPS
PASS origin IP is not directly reachable
PASS local health endpoint
Preflight passed.
```

源站直连主机侧返回：

```text
curl: (55) OpenSSL SSL_read: ... tlsv13 alert certificate required
```

外部端口检查节点对 `45.76.150.132:443` 全部返回 `Connection timed out`。

## 应用和安全流程

- 管理员密码登录、TOTP 二次验证、恢复码登录通过。
- 安全等级升级 S1→S3 通过。
- 降级无确认返回 `security_downgrade_confirmation_required`。
- 启用 TOTP 后降级无 step-up 返回 `step_up_required`；带 step-up token 通过。
- 匿名分享无 step-up 返回 `step_up_required`；带 token 创建成功，`/r/<key>/read` 匿名读取正文成功。
- 邀请预览、接受邀请、邀请账号 TOTP 登录、成员写入、会话撤销、管理员重置 TOTP 通过。
- 含 `BEGIN PRIVATE KEY` 的分享返回 `policy_blocked` / `private_key`。
- S2 空间匿名分享返回 `policy_blocked` / `anonymous_share_disabled`。
- 登录失败第 11 次开始返回 429。
- 工作区配额第 11 个返回 `workspace_quota_exceeded`。
- `publicReaderUrl=https://librarian.zanghua.dev`；MCP 开启后 `/.mcp` 匿名 POST 返回 401，`WWW-Authenticate` 指向资源元数据；元数据端点返回 200。
- 12,002,983 字节 PNG 经 Cloudflare 上传成功（201）。
- 审计表记录 `workspace.security_level.change`、`policy.blocked`、`account.step_up`、`account.totp.*`、`account.invite.*`、`account.sessions.revoke`。

## 备份和还原

- `backup.sh` 停止服务、SQLite `integrity_check`、生成归档和 SHA-256，再启动服务。
- 归档：`librarian-data-20261123T164915Z.tar.gz`，27 KiB，校验通过。
- 使用 `restore.sh` 在独立 systemd 单元 `librarian-restore.service`、独立数据根、端口 18081 上还原。
- 还原后健康检查通过；管理员 TOTP 登录、工作区、`Note.md`、`Reader.md` 和匿名分享正文均可读取。

## 升级和回滚

- `deploy.sh` 先备份，再解包到新 release、切换 `current`、重启并轮询健康检查。
- 部署后健康检查通过，工作区和两份文档仍在。
- 手动切回上一 release 并重启，健康检查通过。

## 主机加固和监控

- `fail2ban` 已启用，`sshd` jail 已封禁 `62.60.130.148`。
- SSH：`PasswordAuthentication no`、`KbdInteractiveAuthentication no`、`PermitRootLogin prohibit-password`；新密钥连接验证通过。
- `unattended-upgrades`、`chrony`、journald 限额、swap 已启用。
- `monitor.sh` 已安装，timer 每 5 分钟运行；本地 webhook 收到磁盘阈值告警 JSON，健康运行输出 `monitor ok`。
- 尚未配置真实 webhook，因此没有外部告警到达证据。

## 画面

- `public-login-1440.png`：公网登录页。
- `public-workspace-1440.png`：登录后的工作区，公开等级徽标。
- `public-workspace-390.png`：390 px 工作区。
- `public-settings-1440.png`：空间设置和安全等级能力摘要。
- `../session-list-2026-11-24/`：登录设备列表和撤销。
- `../audit-log-2026-11-24/`：管理员审计查询和 CSV 导出。
- `../clean-rebuild-2026-11-24/`：清空演练数据后的 1C1G 生产实例。

## 未完成

- 注册商锁/账号 2FA。
- 真实告警 webhook、异地 restic 备份。
- 生产规格升级、zone-level AOP 自定义证书。
- 发布和 S2 grant 的 step-up、S2 例外、会话列表 UI、完整 OpenAPI、审计查询 UI。
- 12 MiB 上传已测；SSE 长连接、并发编辑、240 篇目录和负载测试未在本轮完成。
