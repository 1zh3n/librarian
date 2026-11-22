# Reader UI 收口与命令面板部署验收

日期：2026-11-22

部署：`d3801f8d`（运行时 `2d5a4997`，测试提交 `d3801f8d`）

内网：<https://192.168.8.166:18447>

回滚备份：`~/.local/state/librarian-ai-workspace-candidate/backups/pre-ui-polish-d3801f8d-20261122-203222`

旧运行时：`runtime/releases/6a98ea96/librarian`

## 部署

| 项 | 结果 |
| --- | --- |
| 发行包 | `librarian-0.1.0-linux-x86_64.tar.gz`，SHA-256 `33d41ba17e83f596742f93b905ad9b1af2e816f5e070a162f916da06b8c52dae` |
| 服务 | app / HTTPS / 托管执行器 active；健康检查 `{"status":"ok","version":"0.1.0"}` |
| 数据 | 升级前后 2 个空间、45 份 Markdown；`spaces.json` 哈希一致；SQLite `integrity_check=ok`。`users.json` 仅管理员 `lastLogin` 更新 |
| Zola | 0.23.6 安装到 `~/.local/bin/zola`；两项发布用例 2/2 通过 |

## 线上实测

真实账号 `ai-review` 登录 18447：

- 设置 → AI 首屏显示「当前模型 · DeepSeek 验收 · DeepSeek-V4.1-Flash · low」。
- 「连接配置」默认折叠，摘要「DeepSeek 验收 · 已启用 · 2 个模型」；「全局 AI 与执行器」摘要「全局 AI 已开启 · 受管执行器在线」。
- 文档 AI 空态显示三个起点；composer 底部显示「DeepSeek 验收 · DeepSeek-V4.1-Flash · low · 受管执行器在线」。
- 空间管理页显示「管理员」角色和用途说明；主 tab 为分段导航；桌面保存右对齐，390 手机保存整行，`scrollWidth=390`。
- 命令面板输入「设置」后显示设置图标和命令行。
- 仅出现自签 HTTPS 的证书脚本提示，没有应用运行错误。

画面：

- [AI 设置摘要](settings-ai-1440.png)
- [文档 AI 空态](document-ai-empty-1440.png)
- [空间管理 1440](management-1440.png)
- [空间管理 390](management-390.png)
- [命令面板 1440](command-palette-1440.png)

## 自动化

| 范围 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `oxlint --type-aware --deny-warnings` | 通过 |
| `oxfmt --check` | 通过 |
| Reader Vitest | 29 文件 / 140 项通过 |
| Reader 构建 | 通过 |
| 完整产品 Playwright | 302/304；2 项并行抖动（`document-global-comparison`、`document-settings-layout`）单独复跑通过 |
| Zola 发布用例 | 2/2 通过 |

## 回滚

```bash
systemctl --user stop librarian-ai-integration-app.service
systemd-run --user --unit=librarian-ai-integration-app \
  --property=Restart=on-failure --property=KillSignal=INT \
  --property=TimeoutStopSec=30s --property=UMask=0077 \
  --setenv=LIBRARIAN_TRUST_LOOPBACK_PROXY=1 \
  ~/.local/state/librarian-ai-workspace-candidate/runtime/releases/6a98ea96/librarian \
  --data-root ~/.local/state/librarian-ai-workspace-candidate/data \
  --listen 127.0.0.1:18086
```

数据不兼容时先用上述备份覆盖 `data/`，再启动旧运行时。

## 未证明

- 真实手机软键盘、读屏和墨水屏。
- 像素级视觉回归仍未建立；当前是确定性几何/样式门禁加同状态截图。
