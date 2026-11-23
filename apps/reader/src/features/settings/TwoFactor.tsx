import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Field, Form } from "../../ui/Forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { TotpStart } from "../../api/client";
import styles from "../workspace/Management.module.css";

function errorText(error: unknown) {
  if (error instanceof ApiError && error.status === 403) {
    return "验证码或恢复码不正确。";
  }
  return "无法更新两步验证，请重试。";
}

export function TwoFactor() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["totp", "status"],
    queryFn: ({ signal }) => api.getTotpStatus(signal),
  });
  const [setup, setSetup] = useState<TotpStart>();
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const start = useMutation({
    mutationFn: () => api.startTotp(),
    onSuccess: (value) => {
      setError("");
      setCodes([]);
      setSetup(value);
    },
    onError: (failure) => setError(errorText(failure)),
  });
  const verify = useMutation({
    mutationFn: (code: string) => api.verifyTotp({ secret: setup?.secret ?? "", code }),
    onSuccess: async (value) => {
      setCodes(value.recoveryCodes);
      setSetup(undefined);
      await client.invalidateQueries({ queryKey: ["totp", "status"] });
    },
    onError: (failure) => setError(errorText(failure)),
  });
  const disable = useMutation({
    mutationFn: (code: string) => api.disableTotp({ code }),
    onSuccess: async () => {
      setError("");
      await client.invalidateQueries({ queryKey: ["totp", "status"] });
    },
    onError: (failure) => setError(errorText(failure)),
  });

  if (status.isPending) {
    return <Feedback className={styles.status}>正在读取两步验证状态…</Feedback>;
  }
  if (status.isError) {
    return (
      <Feedback tone="error" className={styles.status}>
        无法读取两步验证状态。
      </Feedback>
    );
  }

  if (codes.length > 0) {
    return (
      <>
        <Feedback tone="success" className={styles.status}>
          两步验证已启用。以下恢复码只显示一次，请离线保存。
        </Feedback>
        <ul className={styles.records} aria-label="恢复码">
          {codes.map((code) => (
            <li key={code}>
              <code className={styles.address}>{code}</code>
            </li>
          ))}
        </ul>
        <Button variant="primary" className={styles.formAction} onPress={() => setCodes([])}>
          我已保存
        </Button>
      </>
    );
  }

  if (setup) {
    return (
      <>
        <p className={styles.status}>
          在验证器应用中手动输入下面的密钥，或打开 otpauth 地址。然后输入当前 6 位验证码。
        </p>
        <code className={styles.address}>{setup.secret}</code>
        <code className={styles.address}>{setup.uri}</code>
        <Form
          className={styles.form}
          aria-label="启用两步验证"
          onSubmit={(event) => {
            event.preventDefault();
            if (verify.isPending) return;
            const code = new FormData(event.currentTarget).get("code");
            if (typeof code === "string") verify.mutate(code);
          }}
        >
          <Field
            label="验证码"
            name="code"
            autoComplete="one-time-code"
            required
            className={styles.field}
            inputClassName={styles.input}
          />
          <Button type="submit" variant="primary" loading={verify.isPending}>
            {verify.isPending ? "正在验证…" : "验证并启用"}
          </Button>
        </Form>
        {error && (
          <Feedback tone="error" className={styles.status}>
            {error}
          </Feedback>
        )}
        <Button onPress={() => setSetup(undefined)}>取消</Button>
      </>
    );
  }

  if (status.data?.enabled) {
    return (
      <>
        <p className={styles.status}>
          已启用。剩余 {status.data.recoveryRemaining} 个恢复码。登录时需要验证器或恢复码。
        </p>
        <Form
          className={styles.form}
          aria-label="关闭两步验证"
          onSubmit={(event) => {
            event.preventDefault();
            if (disable.isPending) return;
            const code = new FormData(event.currentTarget).get("code");
            if (typeof code === "string") disable.mutate(code);
          }}
        >
          <Field
            label="验证码或恢复码"
            name="code"
            autoComplete="one-time-code"
            required
            className={styles.field}
            inputClassName={styles.input}
          />
          <Button type="submit" variant="outline" loading={disable.isPending}>
            {disable.isPending ? "正在关闭…" : "关闭两步验证"}
          </Button>
        </Form>
        {error && (
          <Feedback tone="error" className={styles.status}>
            {error}
          </Feedback>
        )}
      </>
    );
  }

  return (
    <>
      <p className={styles.status}>
        登录时除了密码，还需要验证器应用中的 6 位验证码。建议所有能访问公网实例的账号启用。
      </p>
      <Button
        variant="primary"
        className={styles.formAction}
        loading={start.isPending}
        onPress={() => start.mutate()}
      >
        {start.isPending ? "正在准备…" : "启用两步验证"}
      </Button>
      {error && (
        <Feedback tone="error" className={styles.status}>
          {error}
        </Feedback>
      )}
    </>
  );
}
