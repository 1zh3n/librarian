import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../api/client";
import type { McpGrant, McpSettings } from "../../api/client";
import { Button } from "../../ui/Button";
import { CopyButton } from "../../ui/CopyButton";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import styles from "./ConnectionsSettings.module.css";

function errorText(error: unknown, fallback = "无法完成操作，请重试。") {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === "mcp_disabled_by_env") return "MCP 已被部署参数关闭，不能在网页中启用。";
  if (error.code === "account_admin_required") return "只有服务器管理员可以修改 MCP 服务。";
  if (error.status === 401) return "登录状态已失效，请重新登录。";
  if (error.status === 403) return "当前账号没有执行这项操作的权限。";
  if (error.status === 404) return "该连接已不存在，列表已刷新。";
  return fallback;
}

function formatted(value: string | null) {
  if (!value) return "尚未使用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function kindLabel(kind: string) {
  return kind === "cimd" ? "已验证来源" : "自行注册";
}

function statusLabel(settings: McpSettings) {
  if (settings.disabledByEnv) return "部署关闭";
  if (!settings.available) return "不可用";
  return settings.enabled ? "已启用" : "已关闭";
}

function statusDetail(settings: McpSettings) {
  if (settings.disabledByEnv) return "部署参数 SB_MCP=0 已关闭 MCP。网页不能覆盖这个设置。";
  if (!settings.available) return "MCP 当前不可用，请检查服务端配置。";
  if (settings.enabled) return "外部 AI 客户端可以使用 OAuth 连接，并按账户权限访问工作区。";
  return "开启后，外部 AI 客户端才可以通过 OAuth 连接。";
}

export function ConnectionsSettings({
  account,
  isAdmin,
  active,
  busy,
  setBusy,
}: {
  account: string | undefined;
  isAdmin: boolean | undefined;
  active: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const client = useQueryClient();
  const settingsKey = ["mcp", "settings", account] as const;
  const grantsKey = ["mcp", "grants", account] as const;
  const settings = useQuery({
    queryKey: settingsKey,
    enabled: active && Boolean(account),
    staleTime: 0,
    queryFn: ({ signal }) => api.getMcpSettings(signal),
  });
  const grants = useQuery({
    queryKey: grantsKey,
    enabled: active && Boolean(account),
    staleTime: 0,
    queryFn: ({ signal }) => api.listMcpGrants(signal),
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [revokeError, setRevokeError] = useState("");
  const [revoking, setRevoking] = useState<McpGrant>();
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      active &&
      !busy &&
      document.activeElement === document.body &&
      (message || error || settings.isError || grants.isError)
    ) {
      feedback.current?.focus({ preventScroll: true });
    }
  }, [active, busy, message, error, settings.isError, grants.isError]);

  if (!account || isAdmin === undefined) {
    return <Feedback>暂时无法确认账号权限。</Feedback>;
  }
  if (settings.isError) {
    return (
      <div className={styles.panel}>
        <Feedback tone="error" ref={feedback} tabIndex={-1}>
          无法读取 MCP 设置。
        </Feedback>
        <div className={styles.actions}>
          <Button className={styles.button} onPress={() => void settings.refetch()}>
            重新读取
          </Button>
        </div>
      </div>
    );
  }
  if (!settings.data) return <Feedback>正在读取 MCP 设置…</Feedback>;

  const view = settings.data;
  const origin = view.endpoint.endsWith("/.mcp") ? view.endpoint.slice(0, -5) : view.endpoint;
  const snippets = [
    {
      label: "OpenCode",
      text: `opencode mcp add librarian --url ${view.endpoint}`,
    },
    {
      label: "Codex",
      text: `codex mcp add librarian --url ${view.endpoint}\ncodex mcp login librarian`,
    },
    {
      label: "Claude Code",
      text: `claude mcp add --transport http librarian ${view.endpoint}`,
    },
    {
      label: "ChatGPT / Claude.ai",
      text: `在客户端添加自定义 connector：${view.endpoint}\n服务必须能从公网以 HTTPS 访问。`,
    },
  ];

  async function toggle() {
    if (!isAdmin || busy || view.disabledByEnv) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const saved = await api.setMcpEnabled(!view.enabled);
      client.setQueryData(settingsKey, saved);
      setMessage(saved.enabled ? "MCP 已启用。" : "MCP 已关闭。");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRevoke() {
    if (!revoking || busy) return;
    setBusy(true);
    setRevokeError("");
    setError("");
    try {
      await api.revokeMcpGrant(revoking.id);
      await client.invalidateQueries({ queryKey: grantsKey });
      setMessage(`已撤销「${revoking.clientName}」。`);
      setRevoking(undefined);
      requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        await client.invalidateQueries({ queryKey: grantsKey });
        setMessage("该连接已不存在，列表已刷新。");
        setRevoking(undefined);
        requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
      } else {
        setRevokeError(errorText(cause, "撤销连接失败，请重试。"));
      }
    } finally {
      setBusy(false);
    }
  }

  function requestRevoke(grant: McpGrant, target: Element) {
    const button = target instanceof HTMLElement ? target.closest("button") : null;
    if (button instanceof HTMLButtonElement) revokeTrigger.current = button;
    setMessage("");
    setError("");
    setRevokeError("");
    setRevoking(grant);
  }

  function cancelRevoke() {
    setRevoking(undefined);
    setRevokeError("");
    requestAnimationFrame(() => revokeTrigger.current?.focus({ preventScroll: true }));
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-label="MCP 服务">
        <div className={styles.statusRow}>
          <h3>MCP 服务</h3>
          <span
            className={styles.status}
            data-state={view.enabled ? "enabled" : view.disabledByEnv ? "disabled" : "off"}
          >
            {statusLabel(view)}
          </span>
        </div>
        <p className={styles.detail}>{statusDetail(view)}</p>
        {isAdmin && (
          <div className={styles.actions}>
            {!view.disabledByEnv && (
              <Button
                className={styles.button}
                variant={view.enabled ? "outline" : "primary"}
                isDisabled={busy}
                onPress={() => void toggle()}
              >
                {view.enabled ? "停用 MCP" : "启用 MCP"}
              </Button>
            )}
            {view.disabledByEnv && <Feedback>部署参数已关闭 MCP，不能在网页中启用。</Feedback>}
          </div>
        )}
        {!isAdmin && <p className={styles.detail}>服务开关由服务器管理员管理。</p>}
        {isAdmin && (
          <div className={styles.readerLink}>
            <p className={styles.detail}>
              {view.publicReaderUrl
                ? `成员阅读链接使用 ${view.publicReaderUrl}`
                : "未配置成员阅读链接；MCP 写入仍会成功，但回执中的 readerUrl 为空。"}
            </p>
            {!view.publicReaderUrl && (
              <CopyButton
                className={styles.button}
                text={JSON.stringify({ publicReaderUrl: origin })}
                label="复制配置"
              />
            )}
          </div>
        )}
      </section>

      <section className={styles.section} aria-label="MCP 接入地址">
        <h3>接入地址</h3>
        <p className={styles.detail}>
          把地址添加到支持 Streamable HTTP 的 AI 客户端。首次连接会打开 Librarian 登录页。
        </p>
        <div className={styles.endpointRow}>
          <code>{view.endpoint}</code>
          <CopyButton className={styles.button} text={view.endpoint} label="复制地址" />
        </div>
        <div className={styles.snippets}>
          {snippets.map((snippet) => (
            <div className={styles.snippet} key={snippet.label}>
              <div className={styles.snippetHead}>
                <strong>{snippet.label}</strong>
                <CopyButton className={styles.button} text={snippet.text} label="复制命令" />
              </div>
              <pre>{snippet.text}</pre>
            </div>
          ))}
        </div>
        <Feedback>
          连接使用你的账户权限。移动、删除和发布仍需在 Reader 中确认；你可以在这里撤销连接。
        </Feedback>
      </section>

      <section className={styles.section} aria-label="已连接应用">
        <h3 ref={heading} tabIndex={-1}>
          已连接应用
        </h3>
        {grants.isPending && <p className={styles.detail}>正在读取连接记录…</p>}
        {grants.isError && (
          <Feedback tone="error">
            无法读取连接记录。
            <Button className={styles.inlineButton} onPress={() => void grants.refetch()}>
              重试
            </Button>
          </Feedback>
        )}
        {grants.data?.length === 0 && (
          <p className={styles.empty}>
            还没有外部 AI 连接。复制上方接入地址，在客户端完成授权后会出现在这里。
          </p>
        )}
        {grants.data && grants.data.length > 0 && (
          <ul className={styles.grants} aria-label="已连接应用列表">
            {grants.data.map((grant) => (
              <li className={styles.grant} key={grant.id}>
                <div className={styles.grantHead}>
                  <strong className={styles.grantName}>{grant.clientName}</strong>
                  <span className={styles.kind}>{kindLabel(grant.clientKind)}</span>
                </div>
                <p className={styles.grantMeta}>
                  空间：
                  {grant.spaces.length
                    ? grant.spaces.map((space) => space.name).join("、")
                    : "空间已不可用"}
                </p>
                <p className={styles.grantMeta}>
                  创建：{formatted(grant.createdAt)} · 最近使用：
                  {formatted(grant.lastUsedAt)}
                </p>
                <div className={styles.actions}>
                  <Button
                    className={`${styles.button} ${styles.danger}`}
                    variant="outline"
                    isDisabled={busy}
                    onPress={(event) => requestRevoke(grant, event.target)}
                  >
                    撤销
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {message && (
        <Feedback tone="success" ref={feedback} tabIndex={-1}>
          {message}
        </Feedback>
      )}
      {error && (
        <Feedback tone="error" ref={feedback} tabIndex={-1}>
          {error}
        </Feedback>
      )}

      {revoking && (
        <Dialog title="撤销外部 AI 连接" busy={busy} onClose={cancelRevoke} classes={styles}>
          <p>撤销「{revoking.clientName}」后，该应用将无法继续使用它为已授权空间签发的凭证。</p>
          {revokeError && <Feedback tone="error">{revokeError}</Feedback>}
          <div className={styles.actions}>
            <Button className={styles.button} isDisabled={busy} onPress={cancelRevoke}>
              取消
            </Button>
            <Button
              className={`${styles.button} ${styles.danger}`}
              variant="outline"
              loading={busy}
              onPress={() => void confirmRevoke()}
            >
              确认撤销
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
