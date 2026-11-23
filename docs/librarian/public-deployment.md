# Librarian 公网部署运行手册

日期：2026-11-24
状态：**已在真实 Vultr/Cloudflare 环境完成演练；正式上线前仍需处理第 10 节缺口。**
设计：[安全等级与公网放行设计](../../../docs/superpowers/specs/2026-11-23-librarian-security-levels.md)
计划：[公网部署与安全等级实施计划](../../../docs/superpowers/plans/2026-11-23-librarian-public-deployment.md)
相关：[本地安装与恢复](deployment.md)、[Git 备份](git-backup.md)、[事故响应](incident-response.md)

## 1. 拓扑

```text
浏览器 / MCP 客户端
        │ HTTPS
        ▼
Cloudflare（DNS、代理、WAF、限流）
        │ 443，仅 Cloudflare 段 + Authenticated Origin Pulls
        ▼
Vultr Ubuntu 24.04+ LTS
  Caddy ── 127.0.0.1:8080 ── Librarian
                               ├─ /var/lib/librarian/data
                               ├─ 受管 AI 执行器
                               └─ Zola（首版关闭）
```

- 发行包要求 glibc ≥ 2.39。Ubuntu 24.04 LTS 满足；Debian 12、Ubuntu 22.04 不满足。
- 应用只监听回环。Caddy 终止 TLS，覆盖 `X-Forwarded-Proto`、`X-Real-IP`、`X-Forwarded-For`。
- 源站只接受 Cloudflare 的 Authenticated Origin Pulls 连接；直连 IP 必须失败。

## 2. 主机基线

建议 2 vCPU / 4 GB / 80 GB NVMe 起步；在主机上编译 Rust 发行包时升到 4 vCPU / 8 GB 并加 swap。区域按真实客户端测速选择东京、首尔或新加坡。

```bash
# 以 root 执行
apt update
apt install -y fail2ban sqlite3 git curl jq ufw ca-certificates unattended-upgrades chrony
systemctl enable --now fail2ban
useradd --system --create-home --home-dir /var/lib/librarian --shell /usr/sbin/nologin librarian
install -d -m 0755 /opt/librarian/releases
install -d -m 0700 /etc/librarian /var/backups/librarian
install -d -m 0700 -o librarian -g librarian /var/lib/librarian
```

SSH 只允许密钥和指定管理地址；修改前先保留一个已登录会话。

```bash
cat >/etc/ssh/sshd_config.d/10-librarian.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl reload ssh
```

保留 root 密钥登录；如果要完全禁止 root，先创建并验证一个带 sudo 的部署用户，再改成 `PermitRootLogin no`。修改前先保留一个已登录会话。

防火墙只放行 Cloudflare 的 80/443 和管理地址的 22。Cloudflare 段以 <https://www.cloudflare.com/ips/> 为准，定期核对；不要长期复制过期列表。

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow from <ADMIN_IP> to any port 22 proto tcp
# 对每个 Cloudflare CIDR 执行：
# ufw allow from <CF_CIDR> to any port 80 proto tcp
# ufw allow from <CF_CIDR> to any port 443 proto tcp
ufw enable
```

启用自动安全更新、时间同步和 swap（内存小于 4 GB 时至少 2 GB）。

以上步骤可以脚本化，脚本仍要求先核对管理 CIDR：

```bash
bash deploy/librarian/host-setup.sh --admin-ssh-cidr <ADMIN_IP>/32 --harden-ssh
bash deploy/librarian/install-caddy.sh
```

`host-setup.sh` 安装基础包、fail2ban、创建 `librarian` 用户和目录、配置 swap/journald、可选 SSH 加固，并调用 `cloudflare-ips.sh --apply` 写入 Cloudflare 段和 UFW 规则。`install-caddy.sh` 下载固定版本 Caddy 2.11.9（SHA-256 已写死）、安装 systemd 单元，并下载 Cloudflare Authenticated Origin Pulls CA 到 `/etc/caddy/origin-pull-ca.pem`。

## 3. 首次安装

```bash
cd /tmp
sha256sum -c librarian-0.1.0-linux-x86_64.tar.gz.sha256
install -d -m 0755 /opt/librarian/releases/librarian-0.1.0
tar -xzf librarian-0.1.0-linux-x86_64.tar.gz \
  -C /opt/librarian/releases/librarian-0.1.0 --strip-components=1
ln -sfn /opt/librarian/releases/librarian-0.1.0 /opt/librarian/current
chown -R root:root /opt/librarian

# 初始化管理员；密码只从终端输入，不进入 shell 历史。
install -m 0600 deploy/librarian/librarian.env.example /etc/librarian/librarian.env
read -r -s -p "首次管理员密码 " admin_password; printf '\n'
printf '%s\n' "$admin_password" | sudo -u librarian /opt/librarian/current/librarian \
  init --data-root /var/lib/librarian/data --username admin
unset admin_password

# MCP 和资产回执使用公网 Reader 地址；写入后下次启动生效。
install -d -m 0700 -o librarian -g librarian /var/lib/librarian/data/.librarian
printf '%s\n' '{"publicReaderUrl":"https://app.example.com"}' \
  > /var/lib/librarian/data/.librarian/server.json
chown librarian:librarian /var/lib/librarian/data/.librarian/server.json
chmod 600 /var/lib/librarian/data/.librarian/server.json

install -m 0644 deploy/librarian/librarian.service /etc/systemd/system/librarian.service
systemctl daemon-reload
systemctl enable --now librarian
curl -fsS http://127.0.0.1:8080/api/v1/health
```

- `publicReaderUrl` 必须是应用实际对外地址，且不含查询串或片段；未配置时 MCP/资产回执会返回 `reader_url_unavailable`。
- MCP 由 `SB_MCP=1` 允许，但还需要管理员在 Reader 的 MCP 设置里打开，或调用 `PUT /api/v1/mcp/settings` 传 `{"enabled":true}`。公网首版应打开。

- 数据根必须在 Git 检出之外；这里是 `/var/lib/librarian/data`。
- 备份必须包含 `.librarian/ai-install.key` 和 `.librarian/managed-runner.json`，否则模型密钥和受管执行器无法恢复。
- 首版不配置 Zola 发布目标。

### 受管 AI 执行器

```bash
runuser -u librarian -- /opt/librarian/current/librarian runner-enroll \
  --data-root /var/lib/librarian/data \
  --identity-file /var/lib/librarian/data/.librarian/managed-runner.json
install -m 0644 deploy/librarian/librarian-managed-runner.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now librarian-managed-runner
systemctl is-active librarian-managed-runner
```

- 系统级单元以 `librarian` 用户运行；`ExecStart` 通过 `readlink -f` 解析 `current` 符号链接，避免 runner 的入口判断失效。
- 执行器只保存身份文件，供应商密钥在 Reader 的 **设置 → AI** 里录入；执行器在线后管理员再选择模型并启用受管 AI。
- 升级后执行器会随 `current` 指向的新 release 运行；身份文件留在数据根，不要随 release 删除。

## 4. Caddy

```bash
bash deploy/librarian/install-caddy.sh

install -m 0644 deploy/librarian/public.Caddyfile /etc/caddy/Caddyfile
install -o caddy -g caddy -m 0600 /path/to/origin.pem /etc/caddy/origin.pem
install -o caddy -g caddy -m 0600 /path/to/origin.key /etc/caddy/origin.key
cat >/etc/librarian/caddy.env <<'EOF'
LIBRARIAN_DOMAIN=app.example.com
LIBRARIAN_ORIGIN_CERT=/etc/caddy/origin.pem
LIBRARIAN_ORIGIN_KEY=/etc/caddy/origin.key
LIBRARIAN_BACKEND_PORT=8080
EOF
chmod 0600 /etc/librarian/caddy.env

# 由 cloudflare-ips.sh 写入，Caddy 单元同时读取这个文件。
cat /etc/librarian/cloudflare.env
set -a
. /etc/librarian/caddy.env
. /etc/librarian/cloudflare.env
set +a
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
```

- 证书使用 Cloudflare Origin CA，源站不开放公共 ACME。
- `install-caddy.sh` 已把 Cloudflare AOP CA 写到 `/etc/caddy/origin-pull-ca.pem`；Caddyfile 的 `client_auth` 要求并校验证书。Cloudflare 侧需在 **SSL/TLS → Origin Server → Authenticated Origin Pulls → Global** 打开，或用 `PATCH /zones/<zone>/settings/tls_client_auth` 把值设为 `on`。
- Origin 证书和私钥必须让 `caddy` 用户可读；不要只用 root 0600。
- `trusted_proxies_strict` 必须保留；否则左侧可伪造的 `X-Forwarded-For` 会污染来源限流。
- Caddy 覆盖三个转发头后，应用只在回环对端且 `LIBRARIAN_TRUST_LOOPBACK_PROXY=1` 时采信。
- SSE 依赖 `flush_interval -1`；不要在 Caddy 或 Cloudflare 开启会缓冲事件流的压缩/优化。

## 5. Cloudflare 与域名

1. NameSilo 把 NS 改为 Cloudflare 分配的两条地址；开启注册商锁和 2FA。
2. `A`/`AAAA` 指向 Vultr，代理开启；开启 DNSSEC（在 Cloudflare 启用后把 DS 记录写入 NameSilo）。不要设置只允许某个公共 CA 的 `CAA`，除非确认 Universal SSL 的签发方；Origin CA 不受公共 CAA 约束。
3. SSL/TLS 设为 **Full (strict)**；开启 Always Use HTTPS；HSTS 先 `max-age=86400`；最低 TLS 1.2。
4. 开启 WAF 托管规则；对 `/api/v1/*auth*`、登录页、MCP OAuth 路径做速率限制。
5. 缓存规则：`/assets/*` 可缓存；HTML、`/api/*`、`/.mcp*`、`/.well-known/*`、SSE 全部 bypass。
6. 开启 Authenticated Origin Pulls；Caddyfile 已配置 `require_and_verify`。全局 AOP 使用 Cloudflare 共享客户端证书；需要更强隔离时改用 zone-level AOP 自定义证书。源站防火墙只允许 Cloudflare 段。
7. 关闭 Rocket Loader、Email Obfuscation、自动 HTTPS 重写以外的 HTML 注入功能。
8. 免费套餐的自定义 WAF/限流规则数量有限；不够时在 Caddy/应用层补，不要假设 Cloudflare 一定拦住。

自动化这些设置需要一个限定到该 zone 的 API token，权限为 Zone Read、DNS Edit、SSL and Certificates Edit、Zone Settings Edit。

上线前用外部设备核对：真实证书链、登录前拒绝、登录后权限、静态阅读、上传、SSE、撤销、深链接和源站不可直达。

## 6. 备份与恢复

```bash
install -m 0755 deploy/librarian/backup.sh deploy/librarian/restore.sh /usr/local/sbin/
install -m 0644 deploy/librarian/librarian-backup.service \
  deploy/librarian/librarian-backup.timer /etc/systemd/system/
install -m 0600 deploy/librarian/backup.env.example /etc/librarian/backup.env
systemctl daemon-reload
systemctl enable --now librarian-backup.timer
systemctl start librarian-backup.service
```

- `backup.sh` 停止服务、检查 SQLite、生成 `librarian-data-<stamp>.tar.gz` 和 `.sha256`，保留最近 14 份。
- 异地备份：安装 restic，把仓库和密码文件写入 `/etc/librarian/backup.env`；脚本会自动 `restic backup` 和保留策略。
- 每月至少做一次 `restore.sh` 演练：在隔离主机解包、校验、启动、登录核对文档和版本。
- 备份目录和 restic 密码分开保管；应用身份不能删除异地版本。

## 7. 监控

```bash
install -m 0644 deploy/librarian/librarian-monitor.service \
  deploy/librarian/librarian-monitor.timer /etc/systemd/system/
install -m 0600 deploy/librarian/alert.env.example /etc/librarian/alert.env
systemctl daemon-reload
systemctl enable --now librarian-monitor.timer
systemctl start librarian-monitor.service
```

`monitor.sh` 检查本机/公网健康、`librarian`/`caddy` 服务、磁盘、可用内存、负载、公网证书剩余天数和备份年龄。超过阈值时向 `ALERT_WEBHOOK_URL` POST JSON；未配置时把失败写入 journal 并让 unit 失败。timer 每 5 分钟运行一次。

配置真实 webhook 后至少验证一条告警：

```bash
# 临时把磁盘阈值设为 1% 触发一次告警
LIBRARIAN_DISK_MAX_PERCENT=1 bash deploy/librarian/monitor.sh
```

`alert.env` 里可覆盖 `LIBRARIAN_PUBLIC_URL`、`LIBRARIAN_DISK_MAX_PERCENT`、`LIBRARIAN_CERT_MIN_DAYS`、`LIBRARIAN_BACKUP_MAX_HOURS` 等阈值。ntfy、Telegram、Discord 或邮件可用一个本地 relay 把 JSON 转成目标格式。

## 8. 升级与回滚

```bash
# 新发行包先校验，再部署；deploy.sh 会先备份数据。
bash deploy/librarian/deploy.sh /tmp/librarian-0.1.0-linux-x86_64.tar.gz
```

- 脚本把新版本解包到 `/opt/librarian/releases/<name>-<stamp>`，切换 `current`，重启并轮询健康检查。
- 健康检查失败会自动切回上一版并重启。
- 手动回滚：`ln -sfn <previous-release> /opt/librarian/current && systemctl restart librarian`。
- 数据库迁移只向前；回滚二进制时使用升级前备份，不要假设降级迁移存在。

## 9. 上线检查

```bash
bash deploy/librarian/smoke.sh http://127.0.0.1:8080 https://app.example.com
node deploy/librarian/verify-entry-config.mjs
bash deploy/librarian/preflight.sh --domain app.example.com --origin-ip <ORIGIN_IP> --local-health

# 源站直连必须失败
curl --resolve app.example.com:443:<ORIGIN_IP> https://app.example.com/ --max-time 5

# 公网响应头
curl -sS -D - -o /dev/null https://app.example.com/ | grep -Ei \
  'content-security-policy|strict-transport-security|referrer-policy|x-frame-options'

# 定时任务和监控
systemctl list-timers 'librarian-*' --no-pager
systemctl start librarian-monitor.service
journalctl -u librarian-monitor.service -n 5 --no-pager
```

- 直连源站现在应返回 `certificate required` 或连接超时；如果是 HTTP 200，说明 AOP 或防火墙未生效。
- 如果从代理/本机运行 `preflight.sh`，源站直连检查可能被本地网络代理干扰；以外部节点或主机上的 AOP 报错为准。

另外必须完成 [公网部署计划](../../../docs/superpowers/plans/2026-11-23-librarian-public-deployment.md) 的放行检查表：安全等级、DLP、MCP 治理、配额、身份加固、备份还原、升级回滚、告警。

## 10. 已知缺口

本手册只覆盖部署工程。以下能力仍未完成或需要人工配置：

- 发布和 S2 grant 的 step-up、S2 空间例外开关；
- 会话列表 UI、审计查询 UI、TOTP/邀请/step-up 的完整 OpenAPI 条目；
- Cloudflare WAF 托管规则、缓存规则、DNSSEC、注册商锁和账号 2FA；
- 异地 restic 备份和真实告警 webhook 的到达验证；
- 生产主机规格（当前演练主机为 1 vCPU / 950 MB，低于建议的 2 vCPU / 4 GB）；
- 当前启用的是 Cloudflare 全局 AOP（共享客户端证书）；需要更强隔离时改用 zone-level AOP 自定义证书；
- 隐私/条款页面。

## 11. 相关文件

- `deploy/librarian/public.Caddyfile`
- `deploy/librarian/host-setup.sh`
- `deploy/librarian/install-caddy.sh`
- `deploy/librarian/cloudflare-ips.sh`
- `deploy/librarian/preflight.sh`
- `deploy/librarian/librarian.service`
- `deploy/librarian/librarian.env.example`
- `deploy/librarian/backup.sh`、`restore.sh`、`deploy.sh`、`smoke.sh`
- `deploy/librarian/monitor.sh`
- `deploy/librarian/librarian-backup.service`、`librarian-backup.timer`
- `deploy/librarian/librarian-monitor.service`、`librarian-monitor.timer`、`alert.env.example`
- `deploy/librarian/librarian-managed-runner.service`
- `deploy/librarian/verify-entry-config.mjs`
- [事故响应](incident-response.md)
