import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Feedback";
import { Field, Form } from "../ui/Forms";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { InvitePreview } from "../api/client";
import "../styles/tokens.css";
import "../ui/theme.css";
import login from "../login/Login.module.css";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let buffer = 0;
  let result = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    throw Object.assign(new Error(body.code ?? "request_failed"), { code: body.code });
  }
  return (await response.json()) as T;
}

function Invite({ token }: { token: string }) {
  const [preview, setPreview] = useState<InvitePreview>();
  const [secret] = useState(newSecret);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState(token ? "" : "邀请链接不完整。");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    request<InvitePreview>(`/api/v1/invites/${encodeURIComponent(token)}`)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch(() => {
        if (active) setError("邀请不存在、已过期或已被使用。");
      });
    return () => {
      active = false;
    };
  }, [token]);

  async function accept(form: HTMLFormElement) {
    const values = new FormData(form);
    const password = values.get("password");
    const code = values.get("code");
    if (typeof password !== "string" || typeof code !== "string") return;
    setPending(true);
    setError("");
    try {
      const accepted = await request<{ recoveryCodes: string[] }>(
        `/api/v1/invites/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password, totpSecret: secret, code }),
        },
      );
      setCodes(accepted.recoveryCodes);
    } catch (failure) {
      const reason = (failure as { code?: string }).code;
      setError(
        reason === "account_exists"
          ? "这个用户名已经被使用，请联系管理员重新邀请。"
          : reason === "invalid_totp_code"
            ? "验证码不正确，请检查验证器时间后重试。"
            : "无法接受邀请，链接可能已过期。",
      );
    } finally {
      setPending(false);
    }
  }

  if (codes.length > 0) {
    return (
      <main className={login.page}>
        <section className={login.panel} aria-labelledby="invite-heading">
          <div className={login.mark} aria-hidden="true">
            <Icon name="book-open" />
          </div>
          <h1 className={login.heading} id="invite-heading">
            邀请已接受
          </h1>
          <p className={login.totpHint}>
            请离线保存以下恢复码。它们只显示一次；登录时也可以使用验证器中的 6 位验证码。
          </p>
          <ul aria-label="恢复码">
            {codes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <a className={login.back} href="/.auth/librarian/login">
            前往登录
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className={login.page}>
      <section className={login.panel} aria-labelledby="invite-heading">
        <div className={login.mark} aria-hidden="true">
          <Icon name="book-open" />
        </div>
        <h1 className={login.heading} id="invite-heading">
          接受邀请
        </h1>
        {error && (
          <Feedback tone="error" className={login.error}>
            {error}
          </Feedback>
        )}
        {!preview ? (
          !error && <Feedback>正在读取邀请…</Feedback>
        ) : (
          <>
            {preview.admin ? (
              <p className={login.totpHint}>
                管理员邀请：为「{preview.username}」设置密码。接受后该账号拥有服务器管理员权限。
              </p>
            ) : (
              <p className={login.totpHint}>
                为「{preview.username}」设置密码。可加入：
                {preview.workspaces.map((workspace) => workspace.name).join("、") || "（暂无空间）"}
              </p>
            )}
            <p className={login.totpHint}>
              在验证器应用中手动输入密钥：<code>{secret}</code>
            </p>
            <Form
              className={login.form}
              onSubmit={(event) => {
                event.preventDefault();
                if (!pending) void accept(event.currentTarget);
              }}
            >
              <Field
                label="设置密码"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={15}
                required
                className={login.field}
                inputClassName={login.input}
              />
              <Field
                label="验证器验证码"
                name="code"
                autoComplete="one-time-code"
                required
                className={login.field}
                inputClassName={login.input}
              />
              <Button
                className={login.submit}
                type="submit"
                variant="primary"
                fullWidth
                loading={pending}
              >
                {pending ? "正在接受…" : "接受邀请"}
              </Button>
            </Form>
          </>
        )}
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing invite root");
const token = new URLSearchParams(window.location.search).get("token") ?? "";
createRoot(root).render(<Invite token={token} />);
