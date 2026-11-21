# 运行 Librarian AI 执行器

## 安装受管执行器

Linux x86_64 发行包带有 Node 24、锁定的 DeepSeek Harness 依赖和用户级 systemd 服务安装程序。解包后保留该目录，服务启动命令引用其中的绝对路径。

以拥有 Librarian 数据目录的服务账户操作。运行中的服务器也支持本地注册。首次安装先用 `./librarian init` 建立管理员账户。下面示例使用本机后端地址，HTTPS 反向代理部署也可传带前缀的服务地址。

```bash
./install-managed-runner --data-root "$librarian_root" \
  --librarian-url http://127.0.0.1:8080
systemctl --user daemon-reload
# 先按原有方式启动 Librarian 服务。
systemctl --user enable --now librarian-managed-runner.service
systemctl --user status librarian-managed-runner.service
```

安装程序调用 `librarian runner-enroll --data-root ROOT --identity-file FILE`，在数据根的 `.librarian/managed-runner.json` 保存该实例的身份。文件权限为 `0600`。同一实例升级时继续使用该文件，把新版解到新目录，在新目录运行安装程序并执行 `systemctl --user daemon-reload` 和 `systemctl --user restart librarian-managed-runner.service`。多个实例可分别指定 `--unit-name NAME.service`，服务文件默认保存在用户 systemd 配置目录。

管理者在网页「设置 → AI」录入供应商密钥、选择模型并查看执行器心跳，再执行「启用受管 AI」。升级期间继续运行原有执行器，直至切换前的任务完成。受管执行器的供应商凭证按任务租约获取。用 `systemctl --user stop librarian-managed-runner.service` 停止实例，用 `systemctl --user start librarian-managed-runner.service` 恢复轮询。

## 旧协议执行器


[示例执行器](../../bin/librarian/examples/ai_runner.mjs)是独立的 Node.js 进程，使用 OpenAI 兼容的 Chat Completions 接口。部署者显式启动执行器后，它才会领取任务。Librarian 在每次请求时核对任务所属 Workspace、用户权限和租约，所读取的 Markdown 及其 revision 由 Librarian 提供。

## 配置与启动

准备已启用原生 Workspace 的 Librarian 数据目录。要直接写入并保留可撤销版本，将目标 Space 的 `revisions` 设置为 `managed`。示例使用 Node.js 24，无额外 npm 依赖。

在部署者 shell 中，将数据目录和模型设置替换为实际值。下面的命令为一次新部署生成执行器凭证，并把它的 SHA-256 摘要保存到服务端数据目录。

```bash
librarian_root=/srv/librarian
export LIBRARIAN_URL=http://127.0.0.1:8080
export LIBRARIAN_RUNNER_TOKEN="$(openssl rand -hex 32)"
(
  umask 077
  mkdir -p "$librarian_root/.librarian"
  digest_file="$(mktemp "$librarian_root/.librarian/runner-token.XXXXXX")"
  printf '%s' "$LIBRARIAN_RUNNER_TOKEN" | sha256sum | cut -d ' ' -f 1 > "$digest_file"
  mv "$digest_file" "$librarian_root/.librarian/runner-token.sha256"
)

export OPENAI_BASE_URL=https://model-provider.example/v1
export OPENAI_MODEL=provider-model-id
read -r -s -p "模型 API key " OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY

node bin/librarian/examples/ai_runner.mjs
```

`LIBRARIAN_URL` 指向 Librarian 服务的基地址，程序自动追加 `/api/v1/`。`OPENAI_BASE_URL` 包含供应商的 API 前缀，程序向其 `chat/completions` 子路径发出请求。供应商需要支持 system/user/assistant messages，以及非流式的 JSON 文本回复。

服务进程只需要读取摘要。以 Librarian 服务用户写入摘要，或将摘要文件的读取权限授予该用户。将原始 `LIBRARIAN_RUNNER_TOKEN` 和模型 API key 保存到执行器的部署密钥配置。跨机器部署时，为 Librarian 和模型服务配置 HTTPS。选用符合空间数据处理要求的模型供应商，因为任务提示、搜索结果元数据和实际读取的文档内容会发送至该供应商。

默认持续领取，每个进程同时处理一个任务。追加 `--once` 可领取至多一个任务并退出。空队列时正常退出，执行器故障时返回非零退出码。常驻进程定期续租，停止或失联时未完成租约会过期，任务可由执行器重新领取。

## 运行行为

- 文档任务读取当前正文、已有自由提纲和显式引用。模型可在任务所在 Workspace 内查找候选文档，按需发起读取。搜索结果仅提供文档元数据。Reader 显示服务记录的实际读取来源。
- 「询问」返回答案。「修改」可更新读取过的现有正文和自由提纲。选区作为引用提供，修改该文件前读取同一 revision 的完整 Markdown。执行器从服务返回的来源取得写入路径和基线。服务按基线校验，生成一次 Git 版本。基线变化时保留最新人工保存。
- 进度事件和最终结果按原请求重试。最终答案由服务在任务完成时展示。常见连接故障和限流会重试有限次数。示例将读取的 Markdown 总量限制为 256 KiB，每次任务最多进行 8 轮模型交互。

## 本地冒烟测试

从仓库根目录构建 Reader 和实测用 Librarian 二进制，再运行 Node 测试。

```bash
npm ci
npm run build -w @librarian/reader
cargo build --locked -p librarian --example reader_fixture
node --test bin/librarian/tests/ai_runner_example.test.mjs
```

若设置了 `CARGO_TARGET_DIR`，同时将 `LIBRARIAN_READER_FIXTURE` 指向该目录下的 `debug/examples/reader_fixture`。测试在本机端口 46185–46187 启动原生 Space、模型接口替身和断线代理，使用测试凭证。测试包括问答、实际引用、条件修改、多文件 Git 版本、断线重试、Diff 和撤销。
