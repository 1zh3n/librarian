# Librarian 内网预发布

阶段 4 的 Linux x86_64 发行包经 SHA-256 验证后，通过用户级 systemd 运行 Librarian 和 Caddy 2.11.9。在本机用内网 HTTPS 地址完成了登录、读写、退出、重启和备份还原。测试只使用合成文档。 [发行验收](release-evidence.md) · [Caddy 2.11.9](https://github.com/caddyserver/caddy/releases/tag/v2.11.9)

## 本次实例

| 项目 | 值 |
| --- | --- |
| 内网入口 | `https://192.168.8.166:18443` |
| 允许的来源 | `192.168.8.0/24` |
| Librarian 后端 | `127.0.0.1:18080` |
| 服务 | `librarian-lan-app.service`、`librarian-lan-https.service` |
| 试用数据 | `~/.local/state/librarian-lan-pre-release/data` |
| 运行目录 | Fork 中的 `.superpowers/sdd/pre-release-lan` |
| 测试管理员 | `preview-admin` |

本机测试密码保存在预发布运行目录的 `credentials/admin-password`，权限为 `0600`。客户端仅需导入 Caddy 的根证书公钥文件 `caddy-data/caddy/pki/authorities/local/root.crt`。高位端口只绑定指定的 LAN IPv4，Caddy 另按来源子网校验。内网客户端采用该证书建立 HTTPS，应用自行鉴权。本次未变动宿主证书库、DNS 和路由器。MCP 在预发布实例关闭。 [Caddy 内部 HTTPS](https://caddyserver.com/docs/running)

## 复现部署

从已核对的发行包解包，准备可信来源的 Caddy 和专用运行目录。以下命令中的路径、LAN 地址和子网按目标主机填写。数据根必须位于 Git 检出之外，以便每个 Workspace 建立自己的受管仓库。运行目录权限采用 `0700`。

```bash
release_program=/path/to/unpacked/librarian
caddy_program=/path/to/verified/caddy
repo=/path/to/librarian
lan_data="${XDG_STATE_HOME:-$HOME/.local/state}/librarian-preview/data"
lan_runtime="${XDG_STATE_HOME:-$HOME/.local/state}/librarian-preview/runtime"

umask 077
install -d -m 700 "$lan_data" "$lan_runtime/caddy-data" "$lan_runtime/caddy-config"
if git -C "$lan_data" rev-parse --show-toplevel >/dev/null 2>&1; then
  printf '%s\n' '数据目录必须位于 Git 检出之外。' >&2
  exit 1
fi

# 仅首次运行
read -r -s -p '预发布管理员密码 ' preview_password
printf '\n'
printf '%s\n' "$preview_password" |
  "$release_program" init --data-root "$lan_data" --username preview-admin
unset preview_password

systemd-run --user --unit=librarian-lan-app \
  --property=Type=exec --property=Restart=on-failure \
  --property=KillSignal=SIGINT --property=TimeoutStopSec=30s \
  --property=UMask=0077 --setenv=SB_MCP=0 \
  "$release_program" --data-root "$lan_data" --listen 127.0.0.1:18080

LIBRARIAN_LAN_IP=192.168.8.166 LIBRARIAN_LAN_CIDR=192.168.8.0/24 \
  "$caddy_program" adapt --config "$repo/deploy/librarian/lan.Caddyfile" \
  --adapter caddyfile > "$lan_runtime/caddy.json"

systemd-run --user --unit=librarian-lan-https \
  --property=Type=exec --property=Restart=on-failure --property=UMask=0077 \
  --setenv=XDG_DATA_HOME="$lan_runtime/caddy-data" \
  --setenv=XDG_CONFIG_HOME="$lan_runtime/caddy-config" \
  "$caddy_program" run --config "$lan_runtime/caddy.json"

curl --fail --cacert "$lan_runtime/caddy-data/caddy/pki/authorities/local/root.crt" \
  https://192.168.8.166:18443/api/v1/health
```

用 `systemctl --user restart librarian-lan-app librarian-lan-https` 重启。用 `systemctl --user stop librarian-lan-https librarian-lan-app` 停止。停机和宿主重启后按上面的两条 `systemd-run` 命令重启临时服务。这套配置适用于内网试用。

## 验收记录

- TLS 连接验证了私有证书链。未登录的 Workspace 请求返回 401。登录后 Cookie 包含 Secure、HttpOnly 和 SameSite Lax。
- Chromium 145 用经 OpenSSL 验证过的服务器证书公钥验证了页面登录、Reader 正文与浏览器安全上下文。首次测试的诊断输出含一个临时会话，该会话随后已从预发布服务撤销。重测后的会话已注销。
- 通过 HTTPS 新建 Workspace 和 Markdown，读回原文。注销后旧会话返回 401。重启前后同一文档和账号可读。
- 停止应用后归档数据根，验证 SHA-256。解包到独立路径，通过回环口启动恢复实例，复核账号和文档。主预发布实例已恢复运行。
- 数据根和恢复目录留在仓库外。验证来自本机经 LAN 地址访问。第二台设备和异地备份目标留待实际测试。
