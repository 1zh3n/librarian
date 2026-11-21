# 本地安装与恢复

发行归档包含 Linux x86_64 的 `librarian`、`bin/docs`、许可证、受管执行器及其 Node 24 运行时、旧协议 AI 示例和本页。检查 SHA-256 后解包。Librarian 二进制已嵌入 Web 界面，安装时需要 Git，启用 Zola 发布时还需要安装 Zola 0.23.6。旧协议示例也可使用包内的 `bin/node` 运行。 [Zola 0.23.6](https://github.com/getzola/zola/releases/tag/v0.23.6)

本次本机发行需要 glibc 2.39 或更新版本。

存储目录应放在 Git 检出之外，以便每个受管 Workspace 创建独立的 Git 历史。

```bash
sha256sum -c librarian-0.1.0-linux-x86_64.tar.gz.sha256
tar -xzf librarian-0.1.0-linux-x86_64.tar.gz
cd librarian-0.1.0-linux-x86_64

librarian_root="$HOME/.local/share/librarian"
install -d -m 700 "$librarian_root"
read -r -s -p "首次管理员密码 " librarian_password
printf '\n'
printf '%s\n' "$librarian_password" |
  ./librarian init --data-root "$librarian_root" --username admin
unset librarian_password

./librarian --data-root "$librarian_root" --listen 127.0.0.1:8080
```

打开 [本机 Librarian](http://127.0.0.1:8080/)，登录后即可创建 Workspace。部署到其他设备时，把服务保留在回环地址，由可信 TLS 反向代理保留客户端使用的 Host 并设置 `X-Forwarded-Proto: https`。其他设备需要 HTTPS 安全上下文才能使用离线保存。将数据目录和部署凭证限制给服务账户，并使用同一账户管理目标配置。

- [Git 备份](git-backup.md)
- [账号和工作区成员](accounts.md)
- [Zola 发布](zola-publication.md)
- [外部项目投递和 docs CLI](delivery.md)
- [独立 AI 执行器](ai-runner.md)
- [内网 HTTPS 预发布](lan-pre-release.md)

## 阅读离线副本

在固定版本的阅读地址上点击「保存离线副本」，可在同一浏览器再次打开该版本及所选附件。在线时会检查访问权限。离线时，已经保存在设备上的内容可继续阅读，直至浏览器重新联网收到失效响应或本机清除了副本。通过 Librarian 的命令菜单退出会同时清理本机副本。

## 数据备份与升级

停止服务后备份整个数据根。归档会同时保存 SQLite 元数据、账户、授权、原始 Markdown、附件、Git 历史与备份和发布回执。将归档和用于数据口令的部署秘密放在可控的存储位置。位于数据根之外的 Git 目标、服务凭证和 Workspace 目录需要单独备份。

```bash
umask 077
tar -C "$librarian_root" -czf librarian-data.tar.gz .
sha256sum librarian-data.tar.gz > librarian-data.tar.gz.sha256

sha256sum -c librarian-data.tar.gz.sha256
restore_root="$(mktemp -d)"
tar -C "$restore_root" -xzf librarian-data.tar.gz
./librarian --data-root "$restore_root" --listen 127.0.0.1:8081
```

AI 工作区的停机备份同时包含 `.librarian/metadata.sqlite3`、模型密钥加密所用的 `.librarian/ai-install.key`（首次保存密钥时生成）和 `.librarian/managed-runner.json`。备份前停止受管执行器和旧协议执行器，再停止 Librarian。记录应用和执行器的安装目录、监听地址及 systemd 服务名。归档按凭证保管。恢复到隔离主机时，先核对连接配置和任务队列，再启动执行器。缺少安装密钥时，管理员可在网页重新录入模型密钥。

恢复演练需要先核对已配置的 Workspace 目录和 Git 目标路径，再用隔离端口登录，核对文档、固定快照及版本。升级时先备份，停止旧进程并以新二进制打开原数据根。新二进制会迁移数据库。回滚时使用升级前备份与对应旧二进制。

## 从源代码构建发行包

在干净的 Fork 检出中运行以下命令。归档记录该检出的 commit、二进制目标、工具链和依赖许可清单。

```bash
npm ci
node scripts/package-librarian.mjs /tmp/librarian-release
```

## 从实际旧版本复验升级和回退

准备两个版本的归档、相邻的 `.sha256` 文件和 Zola 0.23.6。在构建检出执行以下命令。脚本在临时目录创建账户、文件和 Git 历史。它先备份旧版数据，再用新版打开同一数据根，并以旧版程序在另一目录打开升级前的备份。正常的上线回退也使用这对旧版二进制和升级前备份，保留升级后的数据供复核。

```bash
cargo build --locked -p librarian
LIBRARIAN_ZOLA=/path/to/zola node scripts/verify-librarian-upgrade.mjs \
  /path/to/previous/librarian-0.1.0-linux-x86_64.tar.gz \
  /path/to/candidate/librarian-0.1.0-linux-x86_64.tar.gz \
  "${CARGO_TARGET_DIR:-$PWD/target}/debug/librarian"
```

本地目录替身只在调试二进制上接收一次性合成密钥。解包的发行二进制负责启动检查、加密凭证可用性检查、执行器认证、升级和还原。历史读写、投递、Git 备份和发布继续使用同一组正常产品接口。
