import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { Feedback } from "../ui/Feedback";
import { Form, Field } from "../ui/Forms";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../ui/theme.css";
import styles from "./Login.module.css";

function loginError(status: string | undefined) {
  switch (status) {
    case "incorrect":
      return "用户名或密码不正确，请重试。";
    case "limited":
      return "登录尝试过于频繁，请稍后重试。";
    case "unavailable":
      return "暂时无法登录，请稍后重试。";
    case "totp-incorrect":
      return "验证码或恢复码不正确，请重试。";
    case "totp-limited":
      return "验证尝试过于频繁，请稍后重试。";
    case "totp-expired":
      return "验证已过期，请返回登录重新输入密码。";
    case "totp-unavailable":
      return "暂时无法验证，请稍后重试。";
  }
}

function Login({ status, username }: { status: string | undefined; username: string }) {
  const error = loginError(status);
  const incorrect = status === "incorrect";
  const totp = status?.startsWith("totp") ?? false;
  const errorDescription = incorrect || totp ? { "aria-describedby": "login-error" } : {};
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const alert = useRef<HTMLDivElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (incorrect) password.current?.focus();
    else if (totp) code.current?.focus();
    else alert.current?.focus();
  }, [incorrect, totp]);

  if (totp) {
    return (
      <main className={styles.page}>
        <section className={styles.panel} aria-labelledby="login-heading">
          <div className={styles.mark} aria-hidden="true">
            <Icon name="book-open" />
          </div>
          <h1 className={styles.heading} id="login-heading">
            两步验证
          </h1>
          {error && (
            <Feedback
              tone="error"
              id="login-error"
              className={styles.error}
              tabIndex={-1}
              ref={alert}
            >
              {error}
            </Feedback>
          )}
          {status === "totp-expired" ? (
            <a className={styles.back} href="/.auth/librarian/login">
              返回登录
            </a>
          ) : (
            <Form className={styles.form} method="post" onSubmit={() => setPending(true)}>
              <Field
                label="验证码或恢复码"
                name="code"
                autoComplete="one-time-code"
                {...errorDescription}
                required
                className={styles.field}
                inputClassName={styles.input}
                ref={code}
              />
              <Button
                className={styles.submit}
                type="submit"
                variant="primary"
                fullWidth
                loading={pending}
              >
                {pending ? "正在验证…" : "验证"}
              </Button>
            </Form>
          )}
          <p className={styles.totpHint}>输入验证器应用中的 6 位验证码，或使用一次性恢复码。</p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="login-heading">
        <div className={styles.mark} aria-hidden="true">
          <Icon name="book-open" />
        </div>
        <h1 className={styles.heading} id="login-heading">
          登录 Librarian
        </h1>
        {error && (
          <Feedback
            tone="error"
            id="login-error"
            className={styles.error}
            tabIndex={-1}
            ref={alert}
          >
            {error}
          </Feedback>
        )}
        <Form className={styles.form} method="post" onSubmit={() => setPending(true)}>
          <Field
            label="用户名"
            name="username"
            autoComplete="username"
            defaultValue={username}
            {...errorDescription}
            required
            className={styles.field}
            inputClassName={styles.input}
            autoCapitalize="none"
            spellCheck={false}
          />
          <Field
            name="password"
            autoComplete="current-password"
            {...errorDescription}
            type={visible ? "text" : "password"}
            required
            className={styles.field}
            label="密码"
            ref={password}
            inputClassName={styles.input}
            actionClassName={styles.password}
            action={
              <Button
                type="button"
                className={styles.reveal}
                onPress={() => setVisible((current) => !current)}
              >
                {visible ? "隐藏密码" : "显示密码"}
              </Button>
            }
          />
          <Button
            className={styles.submit}
            type="submit"
            variant="primary"
            fullWidth
            loading={pending}
          >
            {pending ? "正在登录…" : "登录"}
          </Button>
        </Form>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing Librarian login root");
const state = document.querySelector<HTMLMetaElement>('meta[name="librarian-login-state"]');
createRoot(root).render(<Login status={state?.content} username={state?.dataset.username ?? ""} />);
