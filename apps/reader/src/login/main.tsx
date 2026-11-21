import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Form, Input, Label, TextField } from "../ui/primitives";
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
  }
}

function Login({ status, username }: { status: string | undefined; username: string }) {
  const error = loginError(status);
  const incorrect = status === "incorrect";
  const errorDescription = incorrect ? { "aria-describedby": "login-error" } : {};
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const alert = useRef<HTMLParagraphElement>(null);
  const password = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (incorrect) password.current?.focus();
    else alert.current?.focus();
  }, [incorrect]);

  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="login-heading">
        <div className={styles.mark} aria-hidden="true" />
        <h1 className={styles.heading} id="login-heading">
          登录 Librarian
        </h1>
        {error && (
          <p id="login-error" className={styles.error} role="alert" tabIndex={-1} ref={alert}>
            {error}
          </p>
        )}
        <Form className={styles.form} method="post" onSubmit={() => setPending(true)}>
          <TextField
            name="username"
            autoComplete="username"
            defaultValue={username}
            {...errorDescription}
            isRequired
            className={styles.field}
          >
            <Label>用户名</Label>
            <Input className={styles.input} autoCapitalize="none" spellCheck={false} />
          </TextField>
          <TextField
            name="password"
            autoComplete="current-password"
            {...errorDescription}
            type={visible ? "text" : "password"}
            isRequired
            className={styles.field}
          >
            <Label>密码</Label>
            <div className={styles.password}>
              <Input ref={password} className={styles.input} />
              <Button
                type="button"
                className={styles.reveal}
                onPress={() => setVisible((current) => !current)}
              >
                {visible ? "隐藏密码" : "显示密码"}
              </Button>
            </div>
          </TextField>
          <Button
            className={styles.submit}
            type="submit"
            variant="primary"
            fullWidth
            isDisabled={pending}
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
