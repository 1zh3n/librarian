# 密码确认与内嵌查看图标验收（2026-11-24）

- 产品分支：`feat/librarian-public-hardening`
- 产品提交：`1896ddc8`（前置格式整理：`7d9f581c`）
- 范围：邀请接受、管理员新建账号、管理员重置密码、用户修改密码、登录页。
- 用户决定：密码最短长度保持 15；恢复码行为不变；登录页不加确认密码；查看密码使用输入框内的小眼睛图标。

## 结果

- 四处设置密码的表单均增加「确认密码」。两次不一致时不发 API 请求，显示「两次输入的密码不一致。」，焦点移到确认框，已输入内容保留。
- 眼睛按钮是输入框内的原生按钮，没有独立底色或边框；可访问名称为「显示密码」「隐藏密码」「显示确认密码」等，`aria-pressed` 反映状态。
- 登录页原来的「显示密码」文字按钮替换为内嵌图标。
- 邀请页 TOTP 长密钥可以换行；320 CSS px + 200% 字号不再横向溢出。
- 证据截图不包含 TOTP secret；邀请页只截取密码表单区域。

## 测量

- 390 px 邀请页：密码输入框 `x=51.6875, width=286.625, height=48`；眼睛按钮 `x=294.3125, width=44, height=48`，位于输入框内部。
- 320 px、200% 字号：登录页与邀请页 `document.documentElement.scrollWidth = 320`。
- 登录页 320 px、200% 字号：眼睛按钮 44×44 CSS px 以上，Tab 顺序为密码输入框 → 眼睛按钮。

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

- 登录：眼睛图标在输入框矩形内、Tab 聚焦、图标 `eye`/`eye-off` 切换、最小 44×44。
- 邀请：不一致时不发 accept 请求、错误与焦点、密码/确认密码独立显示隐藏、320 px + 200% 不溢出。
- 账号：新建账号、重置密码、修改密码都先验证不一致分支，再完成成功路径；新建账号额外断言不一致时 POST 次数为 0。

## 画面

- `login-1440.png`、`login-390.png`、`login-320-200.png`
- `invite-form-1440-mismatch.png`、`invite-form-1440-visible.png`、`invite-form-390.png`、`invite-form-320-200.png`
- `accounts-1440.png`、`accounts-390.png`、`accounts-create-390-mismatch.png`

## 结论

通过。需要部署后在公网邀请页和账号页复验一次；部署不由本次本地验证自动执行。
