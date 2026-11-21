# AI 工作区候选验收

AI 工作区从 Reader UI 分支的 `c1059e72` 开始，产品代码在 `spike/librarian-ai-workspace`。2026 年 11 月 21 日的验收使用隔离数据根和合成文档。下面的供应商走查与本地替身测试分别记录。

## 网页设置与模型目录

管理员从文档打开顶栏设置，在 AI 标签输入 DeepSeek 凭据。浏览器提交同源发现请求，真实供应商返回两个模型。换到下一个控件，目录返回后按 Escape，焦点回到原设置按钮。四个视口的页面横向溢出均为 0 CSS px。

| 视口 | 接入前 | 真实目录返回后 |
| --- | --- | --- |
| 1440 × 900 | [原设置](evidence/ai-workspace/settings-before-1440.png) | [AI 设置](evidence/ai-workspace/settings-after-1440.png) |
| 390 × 844 | [原设置](evidence/ai-workspace/settings-before-390.png) | [AI 设置](evidence/ai-workspace/settings-after-390.png) |
| 360 × 800 | [原设置](evidence/ai-workspace/settings-before-360.png) | [AI 设置](evidence/ai-workspace/settings-after-360.png) |
| 320 × 720 | [原设置](evidence/ai-workspace/settings-before-320.png) | [AI 设置](evidence/ai-workspace/settings-after-320.png) |

| 供应商返回的 ID | 显示名称 | 思考等级 | 供应商默认 | 上下文 / 最大输出（tokens） |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | DeepSeek-V4.1-Flash | low、high、max | high | 1,048,576 / 393,216 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | low、high、max | high | 1,048,576 / 393,216 |

在隔离 HTTPS 服务中从网页保存停用的连接后，派发模式仍为 `legacy`。读取 SQLite 逻辑导出、数据根下 50 个文件（含 28 个 Git 文件）和候选服务日志，均未匹配到提交的凭据。数据库有一条已加密连接，安装密钥 32 字节，权限 0600。截图遮盖密码框，仓库只保留公开目录字段。

设置的 8 项 Rust 接口测试覆盖发现响应变化、有界错误、角色、密钥轮换、模型回退和显式接管。接管测试先在执行器离线时确认原状态，再模拟在线心跳，验证重试取得同一回执、冲突 ID 被拒绝、默认选择与启用状态同时生效。整个测试只向替身发出一次模型目录查询。

## 执行器选型

两次独立运行中，官方 Harness 均完成跨文档问答及带选区的修改，实际来源可打开，撤销后 Markdown 的 SHA-256 与原件一致。旧执行器两次修改通过，两次问答在解析模型首个响应时失败。受管执行器采用 Harness 的 Messages 路线。详细调用记录、版本与对照方法见[真实模型比较](deepseek-harness-spike-evidence.md)。

## 会话与引用

会话服务的 10 项回归与原有 10 项 AI 操作测试覆盖作用域、幂等轮次、上下文预算、取消与提交的竞争、删除与中断恢复。浏览器在 1440 和 390 px 下从回答跳到另一份文档再后退，复验原回答、问题、未发送草稿、来源链接焦点、回答滚动位置和正文段落。返回后继续提问仍携带原选区。该组操作使用产品服务和本地执行器回执。
