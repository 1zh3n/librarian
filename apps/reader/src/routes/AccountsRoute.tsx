import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api/client";
import type { AccountSummary } from "../api/client";
import { sessionQuery } from "../api/queries";
import { purgeOfflineReader } from "../features/offline/readerOffline";
import styles from "../features/workspace/Management.module.css";
import { Button, Form, Input, Label, TextField } from "../ui/primitives";

const accountListKey = ["accounts"] as const;

async function signInAgain() {
  await purgeOfflineReader().catch(() => {});
  window.location.replace("/.auth/librarian/login?next=%2Faccounts");
}

function PasswordField({ current = false, label }: { current?: boolean; label: string }) {
  return (
    <TextField
      className={styles.field}
      name={current ? "currentPassword" : "password"}
      type="password"
      autoComplete={current ? "current-password" : "new-password"}
      {...(!current && { minLength: 15 })}
      isRequired
    >
      <Label>{label}</Label>
      <Input className={styles.input} />
    </TextField>
  );
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

  async function save(form: HTMLFormElement) {
    const values = new FormData(form);
    const password = values.get("password");
    const currentPassword = values.get("currentPassword");
    form.reset();
    if (typeof password !== "string") return;
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
        {own && <PasswordField current label="当前密码" />}
        <PasswordField label="新密码" />
      </div>
      <p className={styles.status}>新密码至少 15 个字符。</p>
      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className={styles.primary} isDisabled={pending}>
        {pending ? "正在保存…" : "保存密码"}
      </Button>
    </Form>
  );
}

function NewAccount({ onCreated }: { onCreated: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function create(form: HTMLFormElement) {
    const values = new FormData(form);
    const username = values.get("username");
    const password = values.get("password");
    if (typeof username !== "string" || typeof password !== "string") return;
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
        <TextField className={styles.field} name="username" isRequired>
          <Label>用户名</Label>
          <Input className={styles.input} />
        </TextField>
        <PasswordField label="初始密码" />
      </div>
      <p className={styles.status}>初始密码至少 15 个字符。</p>
      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}
      {notice && <output className={styles.status}>{notice}</output>}
      <Button type="submit" className={styles.primary} isDisabled={pending}>
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
  const [notice, setNotice] = useState("");
  const self = account.username === current;
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
              className={styles.secondary}
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
              className={styles.secondary}
              isDisabled={action.isPending}
              onPress={() => {
                action.reset();
                setNotice("");
                setResetting(!resetting);
              }}
            >
              {resetting ? "取消重置" : "重置密码"}
            </Button>
          </>
        )}
        <Button
          className={styles.secondary}
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
      {notice && <output className={styles.status}>{notice}</output>}
      {action.isError && (
        <p role="alert" className={styles.status}>
          无法更新账号，请重试。
        </p>
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
      <section aria-label="已有账号" className={styles.section}>
        <h2>已有账号</h2>
        {accounts.isPending && <output className={styles.status}>正在加载账号…</output>}
        {accounts.isError && (
          <p role="alert" className={styles.status}>
            无法加载账号。
          </p>
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
      {session.isPending && <output className={styles.status}>正在读取当前账号…</output>}
      {session.isError && (
        <p className={styles.status} role="alert">
          无法读取当前账号。
        </p>
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
          {session.data.isAdmin && <AdminAccounts current={session.data.username} />}
        </>
      )}
    </div>
  );
}
