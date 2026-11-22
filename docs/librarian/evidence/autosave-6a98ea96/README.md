# 阅读偏好自动保存部署验收

日期：2026-11-22

部署：`6a98ea96`（运行时 `6a98ea96`）

内网：<https://192.168.8.166:18447>

回滚备份：`~/.local/state/librarian-ai-workspace-candidate/backups/pre-autosave-6a98ea96-20261122-195012`

旧运行时：`~/.local/state/librarian-ai-workspace-candidate/runtime/releases/d36b2d3f/librarian`

## 部署

| 项 | 结果 |
| --- | --- |
| 发行包 | `librarian-0.1.0-linux-x86_64.tar.gz`，SHA-256 `6e0e2485ea8845d410e3a53bf6a04cda79cc759138c52b99ee201bd4b3b45622` |
| 运行时 | `runtime/releases/6a98ea96/librarian`，`BUILD-INFO.txt` Source `6a98ea96e3f419c8cb839ed147897d9b73d77ab5` |
| 服务 | `librarian-ai-integration-app.service` active；`librarian-ai-candidate-https.service` active |
| 托管执行器 | `librarian-ai-release-runner.service` 已重启并 active |
| 健康检查 | `GET /api/v1/health` → `{"status":"ok","version":"0.1.0"}` |
| 新静态资源 | `ReadingSettings-Cbx2_7Qx.js`、`DocumentRoute-Bh_wXUl0.js`、`AiPanel-DaC_yP8D.js` 均返回 200 |
| 数据 | 升级前后 2 个空间、45 份 Markdown；`spaces.json` 与 `users.json` 哈希一致；`PRAGMA integrity_check` 为 `ok` |

## 1440 设置

真实账号 `ai-review` 在内网 18447 打开设置：

- 分组：阅读 / 快捷键 / AI / 连接。
- 不存在「保存设置」按钮；字号从 18 改为 20 后底部显示「已保存」，改回 18 后再次显示「已保存」。
- 关闭后重新打开，偏好已落盘。
- 画面：[settings-auto-1440.png](settings-auto-1440.png)

## 文档 AI 面板

| 视口 | 实测 |
| --- | --- |
| 1440×900 | 336×766，位置 `x=1088, y=118`；正文不重排；「工具」入口有文字 |
| 390×844 触屏 | 全屏 390×844；无调宽手柄；复位/关闭可见 |
| 320×720 / 200% | 设置外框 320，`scrollWidth=320`；4 个分组可见，无横向溢出 |

画面：

- [1440 文档 AI](document-ai-1440.png)
- [390 触屏文档 AI](document-ai-390-touch.png)
- [390 触屏设置](settings-390-touch.png)
- [320 / 200% 设置](settings-320-200.png)

## 自动化

| 范围 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| `oxlint --type-aware --deny-warnings` | 通过 |
| `oxfmt --check` | 通过 |
| Reader Vitest | 29 文件 / 140 项通过 |
| Reader 构建 | 通过 |
| 完整产品 Playwright | 295/298 通过；2 项 Zola 发布因本机未安装 Zola，1 项并行超时单独复跑通过 |

## 回滚

```bash
systemctl --user stop librarian-ai-integration-app.service
systemd-run --user --unit=librarian-ai-integration-app \
  --property=Restart=on-failure --property=KillSignal=INT \
  --property=TimeoutStopSec=30s --property=UMask=0077 \
  --setenv=LIBRARIAN_TRUST_LOOPBACK_PROXY=1 \
  ~/.local/state/librarian-ai-workspace-candidate/runtime/releases/d36b2d3f/librarian \
  --data-root ~/.local/state/librarian-ai-workspace-candidate/data \
  --listen 127.0.0.1:18086
```

如新版本写入了不兼容数据，先停服务，用上述备份覆盖 `data/`，再启动旧运行时。

## 未证明

- 真实手机软键盘、读屏和墨水屏。
- 自签 HTTPS 下浏览器控制台仍有一条证书脚本错误；无应用运行错误，登录和交互正常。
