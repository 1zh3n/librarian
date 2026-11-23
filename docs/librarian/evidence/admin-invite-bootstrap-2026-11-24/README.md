# 管理员邀请初始化验收（2026-11-24）

- 新流程：`librarian init --admin-invite` 只创建一次性管理员邀请，不生成服务器密码、TOTP secret 或二维码。
- 邀请 URL 只写到主机 `/root/librarian-admin-invite`（0600），一次性、默认 60 分钟，部署时使用 1440 分钟。
- 邀请页在浏览器里生成 TOTP secret，用户自己设置密码，接受后账号才以管理员身份创建。
- 浏览器生成 secret 并显示恢复码；没有服务器端 PNG、没有 root TOTP 文件。
- `librarian admin-invite` 提供 root-only 的恢复路径：管理员丢失 TOTP 时创建新的管理员邀请。
- 集成测试覆盖：一次性 token、预览 `admin: true`、接受后创建管理员、TOTP 已启用、恢复码 10 个、重复接受返回 404。
- 公网邀请页验证：预览返回 200 / `admin: true`；页面显示“管理员邀请”“服务器管理员权限”、密码和验证码输入框。
- 当前演练实例：`users.json` 为空、1 条待接受管理员邀请；MCP 已开；managed runner 心跳在线；备份和监控通过。管理员需接受邀请后才能登录。
- 未保存邀请页截图，因为页面包含 TOTP secret；以 API 与页面可见性检查作为证据。
