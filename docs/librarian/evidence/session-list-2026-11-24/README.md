# 登录设备列表验收（2026-11-24）

- 账号设置新增“登录设备”区域：当前设备、其他浏览器会话、创建时间、有效时间、共享设备标记。
- 单设备撤销需要确认；当前设备不显示撤销按钮，使用退出登录结束当前会话。
- “撤销其他设备”保留当前会话，并显示撤销数量。
- 390 px 和 320 px + 200% 字号下无横向溢出。
- Playwright：`document-accounts.spec.ts` 的 `lists and revokes other browser sessions`。
- 截图：`sessions-390.png`、`sessions-320-200.png`。
