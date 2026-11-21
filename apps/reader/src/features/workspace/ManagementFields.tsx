import type { Ref } from "react";
import {
  Button,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  TextField,
} from "../../ui/primitives";
import styles from "./Management.module.css";

export function Choice<Value extends string>({
  label,
  value,
  entries,
  onChange,
}: {
  label: string;
  value: Value;
  entries: readonly { value: Value; label: string }[];
  onChange: (value: Value) => void;
}) {
  return (
    <Select
      className={styles.field}
      value={value}
      onChange={(next) => {
        const match = entries.find((option) => option.value === next);
        if (match) onChange(match.value);
      }}
    >
      <Label>{label}</Label>
      <Button className={styles.select}>
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </Button>
      <Popover className={styles.menu}>
        <ListBox>
          {entries.map((entry) => (
            <ListBoxItem key={entry.value} id={entry.value} className={styles.option}>
              {entry.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function Field({
  label,
  value,
  onChange,
  required,
  ref,
  type,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  required?: boolean;
  ref?: Ref<HTMLInputElement>;
  type?: "text" | "datetime-local";
}) {
  return (
    <TextField
      className={styles.field}
      value={value}
      onChange={onChange}
      isRequired={required ?? false}
      type={type ?? "text"}
    >
      <Label>{label}</Label>
      <Input ref={ref ?? null} className={styles.input} />
    </TextField>
  );
}

export function formatLocalDate(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() > 9999) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
