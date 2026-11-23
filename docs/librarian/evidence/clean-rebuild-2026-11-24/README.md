# 1C1G 干净重建验收（2026-11-24）

- 主机保持 Vultr Ubuntu 26.04.1 LTS，1 vCPU / 950 MiB；未升配。
- 清空旧数据根、旧 release、系统单元和 Caddy 配置，重新走 host-setup、Caddy 安装、管理员初始化和 57dd8117 部署。
- 数据根 424 KiB，`workspaces = 0`；无演练账号、无测试文档、无 12 MB 测试图片。
- 管理员 TOTP 已启用，10 个恢复码保存在主机 `/root/librarian-admin-totp.json`（0600）；所有测试浏览器会话已清空。
- `publicReaderUrl=https://librarian.zanghua.dev`；MCP 已启用；`/.mcp` 匿名 POST 返回 401，OAuth 资源元数据返回 200。
- 受管 AI runner 已作为系统级 `librarian-managed-runner.service` 运行，心跳在线（`runnerOnline: true`，RSS 约 76 MB）；未配置供应商密钥，`connections = 0`，需要管理员在设置 → AI 添加后才能生成。
- 备份：8.5 KiB 归档 + SHA-256；监控 timer 每 5 分钟运行，`monitor ok`。
- 入口：Cloudflare Full (strict)、Always HTTPS、最低 TLS 1.2、HSTS、AOP、DNSSEC `active`；新 Origin CA 证书有效期到 2041-11-19。
- `preflight.sh`、`smoke.sh`、`verify-entry-config.mjs` 通过。
- 截图：`clean-sessions-1440.png`、`clean-audit-1440.png`。
