# 阶段 2 验收记录

- 分支为 `feat/librarian-phase-2`，基线为阶段 1 验收提交 `19e976f939bd6f379789635da45febcb29d34ae5`。
- Fork 与 `origin` 为 `git@github.com:1zh3n/librarian.git`，`upstream` 为 `https://github.com/silverbulletmd/silverbullet.git`。
- 工作区位于 `/home/xia/Projects/Doc/librarian/.superpowers/sdd/phase-2-worktree`。

## 2.1 多文件事务与恢复

- 故障测试最初缺少事务接缝。接入后，真实路由在两次文件替换之间等待，第二笔失败并回滚后读回原文。故意损坏恢复材料时，最初真实路由返回了 200，修复后在恢复前返回 503。
- 两个独立子进程中断点分别位于 Git 发布前和索引安装前。前者在重开后恢复两份原件，以相同 ID 重试后才发布。后者在重开后返回相同 Git 提交并补齐暂存区，无新增版本。两条路径均核对 BOM、CRLF、尾随空白及 Git blob。
- 事务包含两份文件时，发布前旧 SHA-256 分别为 `f20fa335bf2ea137b62c113488d4792e131ff93fdbe8fa25a200fadd42256e8e` 和 `7fa7e378f50c1991c48328994aaaf2cb4bc0bd93fff2b619986d6b14c7d5227b`。发布版本对应 `189cd6436578af4e00e402ab186d0f2c1cf81188eb8e6bb8c66890cf369843f9` 和 `039c14d9a8ae2880fd523d73ef05f092c04c72657097365b73c2f4c344f27ac2`。Git trailer 携带 `Librarian-Operation-Id`。
- 审查后补测 Git 子进程在服务退出后继续执行的情况。重启在 Git 分支锁下撤销该次发布授权，随后放行旧进程。旧进程发布失败，分支仍指向原提交。同一操作随后可重新提交。临时 Git 索引丢失的另一项测试确认可从提交树重建索引并保留其他暂存文件。
- 外部文件修改仍保留，发生冲突的操作保留恢复材料。Reader 查询与索引读原文共用空间锁，搜索摘要仅在其内容版本与标题投影一致时返回。手动历史恢复复用此事务。
- 七项事务测试使用真实临时文件、SQLite、原生 Space 和 Git。执行 `cargo test --locked -p silverbullet-server --lib product::mutations::tests`。恢复证据覆盖进程退出，文件系统掉电恢复未纳入本次验证。
