# 工作区安全等级 UI 验收

日期：2026-11-23
代码：`feat/librarian-public-hardening`（安全等级 UI 切片）
测试：`apps/reader/tests/e2e/document-workspace-security.spec.ts`、`apps/reader/tests/workspace-security.test.tsx`

## 场景

打开「空间设置 → 安全等级」，把专用验收空间从「内部」改为「受限」，确认外部 AI/MCP、匿名分享、发布和离线副本关闭；再改回「内部」，必须经过「降低安全等级？」确认。最后通过 `GET /api/v1/workspaces` 回读等级。

## 画面

| 文件 | 状态 | 观察 |
| --- | --- | --- |
| `security-1440.png` | 1440×900，内部，初始 | 等级徽标、说明、六项能力摘要、选择器和保存按钮在同一分组；保存按钮在未改动时禁用 |
| `security-confirm-1440.png` | 1440×900，降级确认弹窗 | 弹窗列出从「受限」到「内部」的影响；主按钮为「降低等级」，取消不提交 |
| `security-document-1440.png` | 1440×900，文档页 | 侧栏空间按钮显示「受限」徽标；右下角 AI 按钮显示「外部 AI 已关闭」且不可用 |
| `security-390.png` | 390×844，受限 | 侧栏折叠时，顶栏面包屑显示「受限」徽标；单列能力摘要无横向溢出 |
| `security-320-200.png` | 320×760，200% 文字 | 无横向溢出；保存按钮宽度不超过视口 |

## 自动检查

- 1440×900：修改为「受限」后保存成功，徽标高亮为「受限」，外部 AI 行从「允许」变为「关闭」。
- 降低等级：出现确认弹窗；确认后保存成功，回读 `securityLevel=internal`。
- 390：`document.documentElement.scrollWidth ≤ 390`。
- 320 + 200%：`document.documentElement.scrollWidth ≤ 320`，保存按钮 `boundingBox().width ≤ 320`。
- 组件测试：受限等级显示六项能力，保存按钮在无改动时禁用。

## 待验证

- 真实触屏、读屏播报和 200% 系统字体下的实际视觉效果。
- W8 完成后，把降级确认替换为 15 分钟内的 TOTP 二次验证；当前用显式确认弹窗。
- 空间列表、文档页的等级徽标和 AI/MCP 设置中的空间状态提示尚未在本切片加入。
