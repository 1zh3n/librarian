import { useEffect, useId, useRef, useState } from "react";
import type { Ref } from "react";
import { Field } from "./Forms";
import { Icon } from "./Icon";
import styles from "./PasswordField.module.css";

export const PASSWORD_MISMATCH = "两次输入的密码不一致。";
export const PASSWORD_MIN_LENGTH = 15;

type PasswordFieldProps = {
  label: string;
  name: string;
  autoComplete: string;
  className?: string;
  inputClassName?: string;
  minLength?: number;
  required?: boolean;
  invalid?: boolean;
  onChange?: () => void;
  revealLabel?: string;
  "aria-describedby"?: string;
  ref?: Ref<HTMLInputElement>;
};

export function PasswordField({
  label,
  name,
  autoComplete,
  className,
  inputClassName,
  minLength,
  required = true,
  invalid,
  onChange,
  revealLabel = "密码",
  "aria-describedby": describedBy,
  ref,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <Field
      label={label}
      name={name}
      type={visible ? "text" : "password"}
      autoComplete={autoComplete}
      autoCapitalize="none"
      spellCheck={false}
      required={required}
      {...(minLength !== undefined ? { minLength } : {})}
      {...(invalid !== undefined ? { invalid } : {})}
      {...(onChange ? { onChange } : {})}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      {...(className !== undefined ? { className } : {})}
      {...(inputClassName !== undefined ? { inputClassName } : {})}
      {...(ref !== undefined ? { ref } : {})}
      actionClassName={styles.control}
      action={
        <button
          type="button"
          className={styles.reveal}
          aria-label={`${visible ? "隐藏" : "显示"}${revealLabel}`}
          onClick={() => setVisible((current) => !current)}
        >
          <Icon name={visible ? "eye-off" : "eye"} />
        </button>
      }
    />
  );
}

export function usePasswordConfirmation() {
  const [mismatch, setMismatch] = useState(false);
  const errorId = useId();
  const confirmation = useRef<HTMLInputElement>(null);
  const clear = () => setMismatch(false);

  useEffect(() => {
    if (mismatch) confirmation.current?.focus();
  }, [mismatch]);

  function check(form: HTMLFormElement): string | undefined {
    const values = new FormData(form);
    const password = values.get("password");
    const value = values.get("passwordConfirmation");
    if (typeof password !== "string" || typeof value !== "string") return undefined;
    if (password !== value) {
      setMismatch(true);
      return undefined;
    }
    setMismatch(false);
    return password;
  }

  return { mismatch, errorId, confirmation, check, clear };
}
