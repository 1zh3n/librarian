# 密码确认与内嵌查看图标验收（2026-11-24）

- 产品分支：`feat/librarian-public-hardening`
- 产品提交：`ca29d3f0`（功能 `1896ddc8`，复核修复 `2bd559b8`，格式整理 `7d9f581c`）
- 部署版本：`librarian-0.1.0-linux-x86_64-20261124T144424Z`
- 范围：邀请接受、管理员新建账号、管理员重置密码、用户修改密码、登录页。
- 用户决定：密码最短长度保持 15；恢复码行为不变；登录页不加确认密码；查看密码使用输入框内的小眼睛图标。

## 结果

- 四处设置密码的表单均增加「确认密码」。两次不一致时不发 API 请求，显示「两次输入的密码不一致。」，焦点移到确认框，已输入内容保留。
- 确认框通过 `aria-describedby` 关联错误文本；确认框的 `aria-invalid` 与错误提示在同一次提交后生效，读屏可重新读取原因。
- 眼睛按钮是输入框内的原生按钮，没有独立底色或边框；可访问名称为「显示密码」「隐藏密码」「显示确认密码」等。名称随状态变化，因此不使用会冲突的 `aria-pressed`。
- 登录页原来的「显示密码」文字按钮替换为内嵌图标。
- 新建账号成功后或表单 `reset()` 后，密码框会重新挂载为掩码状态，不会把下一个密码显示成明文。
- 确认密码只校验是否一致，不再用 `minLength` 抢先拦截短值；短确认也会显示自定义不一致提示。
- 密码框关闭浏览器拼写检查和自动首字母大写。
- 邀请页 TOTP 长密钥可以换行；320 CSS px + 200% 字号下登录、邀请、账号页均不横向溢出。
- 邀请页只截取密码表单区域，不把 TOTP secret 保存到仓库。

## 测量

- 390 px 邀请页：密码输入框 `x=51.6875, width=286.625, height=48`；眼睛按钮 `x=294.3125, width=44, height=48`，位于输入框内部。
- 320 px、200% 字号：登录页、邀请页、账号页 `document.documentElement.scrollWidth = 320`。
- 公网 360 px 登录页：密码输入框 `x=47.796875, width=264.40625, height=48`；眼睛按钮 `x=268.203125, width=44, height=48`，位于输入框内部。

## 自动化

在 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/public-hardening`：

```text
npm run typecheck -w @librarian/reader        pass
npm run lint -w @librarian/reader             pass
npm run format:check -w @librarian/reader     pass
npm test -w @librarian/reader                 31 files / 147 tests pass
make check-rust                               pass
```

Playwright（product fixture，`--workers=1`）：

```text
document-login document-invite document-accounts
20 passed
```

新增覆盖：

- 登录：眼睛图标在输入框矩形内、Tab 聚焦、图标 `eye`/`eye-off` 切换、最小 44×44、无 `aria-pressed`、无确认密码、拼写/大小写属性。
- 邀请：表单有可访问名称；不一致时不发 accept 请求、错误与焦点、确认框可读取错误描述、密码/确认密码独立显示隐藏、320 px + 200% 不溢出。
- 账号：新建账号、重置密码、修改密码都先验证不一致分支，再完成成功路径；新建账号额外断言不一致时 POST 次数为 0、成功创建后确认框错误可读取、成功创建后密码框回到掩码、短确认仍显示自定义错误、旧成功提示被清除。
- 账号页 320 px + 200% 字号下确认框可见且页面不横向溢出。

## 部署与公网验证

- 包 SHA-256：`25effe5f7445df52af3b5c86e2e9486908f8db810bdb49392ca9ae73782309ae`。
- 主机服务：`librarian`、`caddy`、`librarian-managed-runner`、`fail2ban` active；`monitor` Result=success；最新备份校验 OK。
- 主机数据：1 个管理员账号，0 个待接受邀请，0 个 workspace；受管 runner 心跳在线；fail2ban 当前 0 封禁。
- 公网：`/api/v1/health` 200；`/` 303 到登录页；`/r/nonexistent` 200；登录页 200，加载 `PasswordField` 分包。
- 公网 Playwright 只填写假密码，不提交：眼睛按钮位于输入框内，44×48；切换后输入类型为 `text`，再切换为 `password`；320 px + 200% `scrollWidth = 320`；保存 `public-login-320-200.png`。
- 唯一控制台错误是 Cloudflare 自动注入的 `static.cloudflareinsights.com/beacon.min.js` 被现有 `script-src 'self'` CSP 阻止。该错误与本次改动无关，未放宽 CSP。
- 管理员邀请是一次性 token，本轮没有在生产创建新邀请；邀请表单的成功/失败路径由本地 product fixture 覆盖。

## 画面

- `login-1440.png`、`login-390.png`、`login-320-200.png`
- `invite-form-1440-mismatch.png`、`invite-form-1440-visible.png`、`invite-form-390.png`、`invite-form-320-200.png`
- `accounts-1440.png`、`accounts-390.png`、`accounts-create-390-mismatch.png`、`accounts-password-320-200.png`
- `public-login-320-200.png`

## 剩余非阻塞项

- 四个表单的确认密码接线仍重复；后续可抽成组合控件。
- 图标宽高共用 `--password-reveal-size`，但焦点轮廓的圆角仍使用通用 `--radius`，与登录页较大的输入框圆角不完全一致。

## 结论

通过。已部署到公网并验证登录页；邀请页和账号页的完整成功/失败路径由本地 product fixture 覆盖。
