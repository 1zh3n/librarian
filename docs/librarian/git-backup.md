# Workspace Git 备份

Librarian 把 Workspace 的已提交版本备份到部署者指定的专用 Git 分支。工作区管理者在 Reader 选择目标和粒度，然后确认发起备份。备份从发起时固定的本地 Git 版本读取，推送期间可以继续保存 Workspace。

## 配置目标

在服务数据根的 `.librarian/backup-targets.json` 中声明可用目标。每个目标的 `workspaceId` 来自工作区管理页地址中的 `ws_...`，或授权后的 `GET /api/v1/workspaces` 返回值。服务账户应独占此文件的写权限。为每个 Workspace 准备一个独立的备份分支，首次备份前让该分支保持不存在。

```json
{
  "targets": [
    {
      "id": "manual-local",
      "label": "手记本地备份",
      "workspaceId": "ws_00000000000000000000000000000001",
      "repository": "/srv/backups/manual.git",
      "branch": "workspace-backup"
    },
    {
      "id": "reference-github",
      "label": "资料库 GitHub 备份",
      "workspaceId": "ws_00000000000000000000000000000002",
      "repository": "ssh://git@github.com/example/librarian-reference.git",
      "branch": "workspace-backup",
      "ssh": {
        "identityFile": "/etc/librarian/backup-keys/reference",
        "knownHostsFile": "/etc/librarian/backup-keys/known_hosts"
      }
    }
  ]
}
```

本地目标使用独立的裸 Git 仓库，可通过 `git init --bare /srv/backups/manual.git` 创建。SSH 目标使用完整的 `ssh://` 地址、目标仓库的专用写入密钥和预先通过可信渠道核对的主机公钥。私钥及 `known_hosts` 使用绝对路径和普通文件，私钥权限设为 `0600`。服务以批处理模式连接，并校验固定的主机公钥。

部署者管理备份仓库和凭证。管理页只显示绑定到当前 Workspace 的目标 ID 与名称，并提供粒度、运行和回执。GitHub 仓库和 SSH 写入密钥由部署者配置。服务从 Workspace 的本地受管仓库提取固定版本，投递来源元数据和来源仓库配置均不会参与选择目标。

### 从旧配置升级

缺少 `workspaceId` 的旧目标会停用。部署者应核对实际授权的 Workspace 和目标分支已有的备份来源，再补写稳定的 `workspaceId`。绑定到同一 Workspace、仓库、分支和密钥时，原选择和任务历史继续有效。为不同的 Workspace 配置独立分支。每次运行与重试都会重新检查绑定。

## 备份与重试

- **分组**会把待备份内容写成一个备份提交。连续备份相同内容复用当前备份提交。
- **逐操作**为两次备份之间的 Librarian 操作各生成一个备份提交。如果还有后续手工保存，备份会额外保存其最终内容。

备份历史保存在专用分支，原始 Workspace 版本仍可在 Reader 中恢复。刚保存的内容需要先形成受管版本。备份详情列出本次所用的源版本及远端确认的提交。

远端失败后使用同一任务重试。重试保留已选定的源版本和待推送提交。目标分支已经收到该提交时，重试会补记同一个回执。目标分支出现其他更新时须由部署者核对该分支。部署者改变已选择目标的仓库、分支或密钥路径后，管理员须重新选择目标。

`.librarian/backup-repos/` 保存备份任务使用的私有 Git 对象和提交，SQLite 保存任务与远端确认。迁移服务时一起保留这两个部分。显式创建的远端备份和本地备份对象独立于临时 Workspace 的到期清理，由部署者管理保留期限。

## 从本地目标恢复

把所需备份分支检出到隔离目录。核对目标提交与文件后，可将文件重新投递到另一个 Workspace。

```sh
git clone --single-branch --branch workspace-backup /srv/backups/manual.git restored-workspace
git -C restored-workspace log --oneline
```
