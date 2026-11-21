import { Icon } from "./Icon";
import { Autocomplete } from "@heroui/react/autocomplete";
import { SearchField as HeroSearchField } from "@heroui/react/search-field";
import { Checkbox as HeroCheckbox } from "@heroui/react/checkbox";
import { Form as HeroForm } from "@heroui/react/form";
import { Input } from "@heroui/react/input";
import { Label } from "@heroui/react/label";
import { ListBox } from "@heroui/react/list-box";
import { Select as HeroSelect } from "@heroui/react/select";
import { TextArea } from "@heroui/react/textarea";
import { TextField } from "@heroui/react/textfield";
import { useRef } from "react";
import type {
  CompositionEventHandler,
  FormEventHandler,
  KeyboardEventHandler,
  ReactNode,
  Ref,
} from "react";

export function Form(props: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
  method?: "post" | "get";
  validationBehavior?: "native" | "aria";
  onSubmit: FormEventHandler<HTMLFormElement>;
  onKeyDown?: KeyboardEventHandler<HTMLFormElement>;
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
  onCompositionStart,
  onCompositionEnd,
  onInvalid,
  action,
  actionClassName,
  ...props
}: FieldProps & {
  ref?: Ref<HTMLInputElement>;
  type?: "text" | "url" | "password" | "datetime-local" | "number" | "search";
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
  onCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
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
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
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
  searchLabel,
}: {
  label: string;
  value: Value;
  entries: readonly { value: Value; label: string }[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
  searchLabel?: string;
}) {
  const searchInput = useRef<HTMLInputElement>(null);
  const keyboardOpening = useRef(false);
  const options = (
    <ListBox
      {...(searchLabel && {
        renderEmptyState: () => <span className="reader-option">没有匹配的目录</span>,
      })}
    >
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
  );
  return (
    <HeroSelect
      className={className ?? "reader-field"}
      value={value}
      isDisabled={disabled}
      onOpenChange={(open) => {
        if (
          open &&
          searchLabel &&
          (keyboardOpening.current || !window.matchMedia("(pointer: coarse)").matches)
        )
          requestAnimationFrame(() => searchInput.current?.focus());
      }}
      onChange={(next) => {
        const entry = entries.find((entry) => entry.value === next);
        if (entry) onChange(entry.value);
      }}
    >
      <Label>{label}</Label>
      <HeroSelect.Trigger
        className="reader-select"
        onKeyDown={() => {
          keyboardOpening.current = true;
        }}
        onPressStart={(event) => {
          keyboardOpening.current = event.pointerType === "keyboard";
        }}
      >
        <HeroSelect.Value />
        <Icon name="chevron-down" />
      </HeroSelect.Trigger>
      <HeroSelect.Popover
        className={searchLabel ? "reader-select-menu reader-searchable-menu" : "reader-select-menu"}
      >
        {searchLabel ? (
          <Autocomplete.Filter
            filter={(text, query) =>
              text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
            }
          >
            <HeroSearchField aria-label={searchLabel} className="reader-picker-search">
              <Icon name="search" />
              <HeroSearchField.Input ref={searchInput} placeholder={searchLabel} />
            </HeroSearchField>
            {options}
          </Autocomplete.Filter>
        ) : (
          options
        )}
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
          <HeroCheckbox.Indicator>
            {({ isSelected }) => isSelected && <Icon name="check" />}
          </HeroCheckbox.Indicator>
        </HeroCheckbox.Control>
        <Label>{children}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}
