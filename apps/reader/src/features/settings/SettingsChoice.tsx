import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "../../ui/primitives";
import styles from "./ReadingSettings.module.css";

export function SettingsChoice<Value extends string>({
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
      onChange={(key) => {
        const option = entries.find((item) => item.value === key);
        if (option) onChange(option.value);
      }}
    >
      <Label>{label}</Label>
      <Button className={styles.input}>
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </Button>
      <Popover className={styles.options}>
        <ListBox>
          {entries.map((item) => (
            <ListBoxItem className={styles.option} key={item.value} id={item.value}>
              {item.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
