import { Checkbox as HeroCheckbox } from "@heroui/react/checkbox";
import { Form as HeroForm } from "@heroui/react/form";
import { Input } from "@heroui/react/input";
import { Label } from "@heroui/react/label";
import { ListBox } from "@heroui/react/list-box";
import { Select as HeroSelect } from "@heroui/react/select";
import { TextArea } from "@heroui/react/textarea";
import { TextField } from "@heroui/react/textfield";
import type { FormEventHandler, KeyboardEventHandler, ReactNode, Ref } from "react";

export function Form(props: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  method?: "post" | "get";
  validationBehavior?: "native" | "aria";
  onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  return <HeroForm {...props} />;
}

type FieldProps = (
  | { label: string; "aria-label"?: never }
  | { label?: never; "aria-label": string }
) & {
  "aria-describedby"?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (text: string) => void;
  className?: string;
  inputClassName?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  validationBehavior?: "native" | "aria";
  placeholder?: string;
  maxLength?: number;
};

export function Field({
  label,
  className,
  inputClassName,
  ref,
  required,
  disabled,
  readOnly,
  invalid,
  placeholder,
  min,
  max,
  step,
  maxLength,
  pattern,
  autoCapitalize,
  spellCheck,
  onKeyDown,
  onInvalid,
  action,
  actionClassName,
  ...props
}: FieldProps & {
  ref?: Ref<HTMLInputElement>;
  type?: "text" | "password" | "datetime-local" | "number" | "search";
  autoComplete?: string;
  autoCapitalize?: string;
  spellCheck?: boolean;
  min?: number;
  max?: number;
  step?: number;
  minLength?: number;
  pattern?: string;
  action?: ReactNode;
  actionClassName?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  onInvalid?: () => void;
}) {
  const input = (
    <Input
      {...(placeholder !== undefined && { placeholder })}
      ref={ref ?? null}
      className={inputClassName ?? ""}
      min={min}
      max={max}
      step={step}
      maxLength={maxLength}
      pattern={pattern}
      autoCapitalize={autoCapitalize}
      spellCheck={spellCheck}
      onKeyDown={onKeyDown}
      onInvalid={onInvalid}
    />
  );
  return (
    <TextField
      {...props}
      className={className ?? "reader-field"}
      isRequired={required ?? false}
      isDisabled={disabled ?? false}
      isReadOnly={readOnly ?? false}
      {...(invalid !== undefined && { isInvalid: invalid })}
    >
      {label && <Label>{label}</Label>}
      {action ? (
        <div className={actionClassName}>
          {input}
          {action}
        </div>
      ) : (
        input
      )}
    </TextField>
  );
}

export function TextAreaField({
  label,
  inputClassName,
  rows,
  ref,
  placeholder,
  required,
  disabled,
  readOnly,
  invalid,
  ...props
}: FieldProps & {
  rows?: number;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <TextField
      {...props}
      isRequired={required ?? false}
      isDisabled={disabled ?? false}
      isReadOnly={readOnly ?? false}
      {...(invalid !== undefined && { isInvalid: invalid })}
    >
      {label && <Label>{label}</Label>}
      <TextArea
        className={inputClassName ?? ""}
        ref={ref ?? null}
        rows={rows}
        placeholder={placeholder}
      />
    </TextField>
  );
}

export function Select<Value extends string>({
  label,
  value,
  entries,
  onChange,
  disabled = false,
  className,
}: {
  label: string;
  value: Value;
  entries: readonly { value: Value; label: string }[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <HeroSelect
      className={className ?? "reader-field"}
      value={value}
      isDisabled={disabled}
      onChange={(next) => {
        const entry = entries.find((entry) => entry.value === next);
        if (entry) onChange(entry.value);
      }}
    >
      <Label>{label}</Label>
      <HeroSelect.Trigger className="reader-select">
        <HeroSelect.Value />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover className="reader-select-menu">
        <ListBox>
          {entries.map((entry) => (
            <ListBox.Item
              key={entry.value}
              id={entry.value}
              textValue={entry.label}
              className="reader-option"
            >
              {entry.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}

export function Checkbox({
  children,
  checked,
  disabled,
  onChange,
  className,
}: {
  children: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <HeroCheckbox
      className={className ?? ""}
      isSelected={checked}
      isDisabled={disabled ?? false}
      onChange={onChange}
    >
      <HeroCheckbox.Content className="reader-check-label">
        <HeroCheckbox.Control className="reader-check">
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label>{children}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}
