import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Feedback } from "../ui/Feedback";
import { Form, Field } from "../ui/Forms";
import { PASSWORD_MISMATCH, PasswordField, usePasswordConfirmation } from "../ui/PasswordField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api/client";
import type { AccountSummary } from "../api/client";
import { sessionQuery } from "../api/queries";
import { purgeOfflineReader } from "../features/offline/readerOffline";
import { InviteAdmin } from "../features/settings/InviteAdmin";
import { AuditLog } from "../features/settings/AuditLog";
import { Sessions } from "../features/settings/Sessions";
import { TwoFactor } from "../features/settings/TwoFactor";
import styles from "../features/workspace/Management.module.css";

const accountListKey = ["accounts"] as const;

async function signInAgain() {
  await purgeOfflineReader().catch(() => {});
  window.location.replace("/.auth/librarian/login?next=%2Faccounts");
}

function PasswordForm({
  own = false,
  onSave,
}: {
  own?: boolean;
  onSave: (password: string, currentPassword: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const {
    mismatch,
    clear: clearMismatch,
    check: checkPassword,
    confirmation: confirmationRef,
  } = usePasswordConfirmation();

  async function save(form: HTMLFormElement) {
    const values = new FormData(form);
    const currentPassword = values.get("currentPassword");
    const password = checkPassword(form);
    if (password === undefined) return;
    form.reset();
    setPending(true);
    setError("");
    try {
      await onSave(password, typeof currentPassword === "string" ? currentPassword : "");
    } catch (failure) {
      setError(
        own && failure instanceof ApiError && failure.code === "incorrect_password"
          ? "当前密码不正确。"
          : "无法保存密码，请检查后重试。",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Form
      aria-label={own ? "修改密码" : "重置密码"}
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void save(event.currentTarget);
      }}
    >
      <div className={styles.fields}>
        {own && (
          <PasswordField
            label="当前密码"
            className={styles.field}
            name="currentPassword"
            autoComplete="current-password"
            inputClassName={styles.input}
            revealLabel="当前密码"
          />
        )}
        <PasswordField
          label="新密码"
          className={styles.field}
          name="password"
          autoComplete="new-password"
          minLength={15}
          inputClassName={styles.input}
          onChange={clearMismatch}
          revealLabel="新密码"
        />
        <PasswordField
          label="确认密码"
          className={styles.field}
          name="passwordConfirmation"
          autoComplete="new-password"
          minLength={15}
          inputClassName={styles.input}
          invalid={mismatch}
          onChange={clearMismatch}
          ref={confirmationRef}
          revealLabel="确认密码"
        />
      </div>
      {mismatch && (
        <Feedback tone="error" className={styles.status}>
          {PASSWORD_MISMATCH}
        </Feedback>
      )}
      <p className={styles.status}>新密码至少 15 个字符。</p>
      {error && (
        <Feedback tone="error" className={styles.status}>
          {error}
        </Feedback>
      )}
      <Button type="submit" variant="primary" className={styles.formAction} loading={pending}>
        {pending ? "正在保存…" : "保存密码"}
      </Button>
    </Form>
  );
}

function NewAccount({ onCreated }: { onCreated: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const {
    mismatch,
    clear: clearMismatch,
    check: checkPassword,
    confirmation: confirmationRef,
  } = usePasswordConfirmation();

  async function create(form: HTMLFormElement) {
    const username = new FormData(form).get("username");
    const password = checkPassword(form);
    if (typeof username !== "string" || password === undefined) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api.createAccount({ username: username.trim(), password });
      form.reset();
      setNotice("账号已创建");
      onCreated();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? "该用户名已经存在。"
          : "无法创建账号，请检查用户名和密码。",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Form
      className={styles.form}
      aria-label="新建账号"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void create(event.currentTarget);
      }}
    >
      <div className={styles.fields}>
        <Field
          label="用户名"
          className={styles.field}
          name="username"
          required
          inputClassName={styles.input}
        />
        <PasswordField
          label="初始密码"
          className={styles.field}
          name="password"
          autoComplete="new-password"
          minLength={15}
          inputClassName={styles.input}
          onChange={clearMismatch}
          revealLabel="初始密码"
        />
        <PasswordField
          label="确认密码"
          className={styles.field}
          name="passwordConfirmation"
          autoComplete="new-password"
          minLength={15}
          inputClassName={styles.input}
          invalid={mismatch}
          onChange={clearMismatch}
          ref={confirmationRef}
          revealLabel="确认密码"
        />
      </div>
      {mismatch && (
        <Feedback tone="error" className={styles.status}>
          {PASSWORD_MISMATCH}
        </Feedback>
      )}
      <p className={styles.status}>初始密码至少 15 个字符。</p>
      {error && (
        <Feedback tone="error" className={styles.status}>
          {error}
        </Feedback>
      )}
      {notice && (
        <Feedback tone="success" className={styles.status}>
          {notice}
        </Feedback>
      )}
      <Button type="submit" variant="primary" className={styles.formAction} loading={pending}>
        {pending ? "正在创建…" : "创建账号"}
      </Button>
    </Form>
  );
}

function AccountRow({
  account,
  current,
  onChanged,
}: {
  account: AccountSummary;
  current: string;
  onChanged: () => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [resettingTotp, setResettingTotp] = useState(false);
  const [notice, setNotice] = useState("");
  const self = account.username === current;
  const resetTotp = useMutation({
    mutationFn: () => api.resetTotp(account.username),
    onSuccess: () => {
      setNotice("已重置两步验证");
      setResettingTotp(false);
      onChanged();
    },
  });
  const action = useMutation({
    mutationFn: async (next: "revoke" | "toggle") => {
      if (next === "revoke") {
        await api.revokeAccountSessions(account.username);
      } else {
        await api.updateAccount(account.username, { disabled: !account.disabled });
      }
    },
    onMutate: () => setNotice(""),
    onSuccess: (_, next) => {
      if (next === "revoke") {
        setNotice("已撤销会话");
        if (self) void signInAgain();
      } else {
        setNotice(account.disabled ? "账号已启用" : "账号已停用");
        onChanged();
      }
    },
  });
  return (
    <li>
      <strong>{account.username}</strong>
      <p className={styles.address}>
        {account.isAdmin ? "管理员" : "普通账号"} · {account.disabled ? "已停用" : "已启用"}
      </p>
      <div className={styles.actions}>
        {!self && (
          <>
            <Button
              variant="outline"
              className={styles.formAction}
              isDisabled={action.isPending || resetting}
              onPress={() => action.mutate("toggle")}
            >
              {action.isPending && action.variables === "toggle"
                ? "正在更新…"
                : account.disabled
                  ? "启用账号"
                  : "停用账号"}
            </Button>
            <Button
              variant="outline"
              className={styles.formAction}
              isDisabled={action.isPending}
              onPress={() => {
                action.reset();
                setNotice("");
                setResetting(!resetting);
              }}
            >
              {resetting ? "取消重置" : "重置密码"}
            </Button>
            <Button
              variant="outline"
              className={styles.formAction}
              isDisabled={action.isPending || resetTotp.isPending}
              onPress={() => {
                resetTotp.reset();
                setNotice("");
                setResettingTotp(true);
              }}
            >
              重置两步验证
            </Button>
          </>
        )}
        <Button
          variant="outline"
          className={styles.formAction}
          isDisabled={action.isPending || resetting}
          onPress={() => action.mutate("revoke")}
        >
          {action.isPending && action.variables === "revoke" ? "正在撤销…" : "撤销会话"}
        </Button>
      </div>
      {resetting && (
        <div className={styles.result}>
          <PasswordForm
            onSave={async (password) => {
              await api.replaceAccountPassword(account.username, { password });
              setResetting(false);
              setNotice("已重置密码");
            }}
          />
        </div>
      )}
      {resettingTotp && (
        <ConfirmDialog
          title="重置两步验证？"
          confirmLabel="重置"
          destructive
          busy={resetTotp.isPending}
          error={resetTotp.isError ? "无法重置两步验证。" : undefined}
          onConfirm={() => resetTotp.mutate()}
          onCancel={() => setResettingTotp(false)}
        >
          账号 {account.username} 的两步验证会被移除，所有会话和 API
          令牌会被撤销。下次登录只需要密码。
        </ConfirmDialog>
      )}
      {notice && (
        <Feedback tone="success" className={styles.status}>
          {notice}
        </Feedback>
      )}
      {action.isError && (
        <Feedback tone="error" className={styles.status}>
          无法更新账号，请重试。
        </Feedback>
      )}
    </li>
  );
}

function AdminAccounts({ current }: { current: string }) {
  const client = useQueryClient();
  const accounts = useQuery({
    queryKey: accountListKey,
    queryFn: ({ signal }) => api.listAccounts(signal),
  });
  const refresh = () => void client.invalidateQueries({ queryKey: accountListKey });
  return (
    <>
      <section aria-label="新建账号" className={styles.section}>
        <h2>新建账号</h2>
        <NewAccount onCreated={refresh} />
      </section>
      <section aria-label="邀请新成员" className={styles.section}>
        <h2>邀请新成员</h2>
        <InviteAdmin />
      </section>
      <section aria-label="已有账号" className={styles.section}>
        <h2>已有账号</h2>
        {accounts.isPending && <Feedback className={styles.status}>正在加载账号…</Feedback>}
        {accounts.isError && (
          <Feedback tone="error" className={styles.status}>
            无法加载账号。
          </Feedback>
        )}
        {accounts.data && (
          <ul aria-label="账号列表" className={styles.records}>
            {accounts.data.map((account) => (
              <AccountRow
                key={account.username}
                account={account}
                current={current}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function AccountsRoute() {
  const session = useQuery(sessionQuery);
  return (
    <div className={styles.page}>
      <h1>{session.data?.isAdmin ? "账号管理" : "账号设置"}</h1>
      {session.isPending && <Feedback className={styles.status}>正在读取当前账号…</Feedback>}
      {session.isError && (
        <Feedback tone="error" className={styles.status}>
          无法读取当前账号。
        </Feedback>
      )}
      {session.data && (
        <>
          <section aria-label="修改密码" className={styles.section}>
            <h2>修改密码</h2>
            <PasswordForm
              own
              onSave={async (password, currentPassword) => {
                await api.changeOwnPassword({ password, currentPassword });
                await signInAgain();
              }}
            />
          </section>
          <section aria-label="两步验证" className={styles.section}>
            <h2>两步验证</h2>
            <TwoFactor />
          </section>
          <section aria-label="授权设备" className={styles.section}>
            <h2>授权设备</h2>
            <p className={styles.status}>
              在手机或墨水屏上选择「在电脑或手机上授权」，然后在这里输入设备码。
            </p>
            <Button variant="primary" onPress={() => window.location.assign("/.auth/device")}>
              打开设备授权页
            </Button>
          </section>
          <Sessions />
          {session.data.isAdmin && <AdminAccounts current={session.data.username} />}
          {session.data.isAdmin && <AuditLog />}
        </>
      )}
    </div>
  );
}
