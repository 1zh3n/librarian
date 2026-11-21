import { Icon } from "./Icon";
import { Dropdown } from "@heroui/react/dropdown";
import type { ReactElement, ReactNode } from "react";

export type MenuAction = {
  id: string;
  label: string;
  content?: ReactNode;
  disabled?: boolean;
  className?: string;
  run: () => void;
};

type MenuOptions = {
  label: string;
  items: readonly MenuAction[];
  choiceGroup?: {
    label: string;
    selectedId: string | undefined;
    items: readonly MenuAction[];
    className?: string;
  };
  className?: string;
};

function renderAction(action: MenuAction) {
  return (
    <Dropdown.Item
      key={action.id}
      id={action.id}
      textValue={action.label}
      aria-label={action.label}
      className={action.className ?? ""}
      isDisabled={action.disabled ?? false}
      onAction={action.run}
    >
      {({ isSelected }) => (
        <>
          {action.content ?? action.label}
          {isSelected && <Icon name="check" />}
        </>
      )}
    </Dropdown.Item>
  );
}

export function Menu({
  label,
  items,
  choiceGroup,
  className,
  focusFirst = false,
}: MenuOptions & { focusFirst?: boolean }) {
  return (
    <Dropdown.Menu
      aria-label={label}
      className={className ?? ""}
      {...(focusFirst && { autoFocus: "first" as const })}
    >
      {choiceGroup && (
        <Dropdown.Section
          aria-label={choiceGroup.label}
          className={choiceGroup.className ?? ""}
          selectionMode="single"
          selectedKeys={choiceGroup.selectedId === undefined ? [] : [choiceGroup.selectedId]}
          shouldCloseOnSelect
        >
          {choiceGroup.items.map(renderAction)}
        </Dropdown.Section>
      )}
      {items.map(renderAction)}
    </Dropdown.Menu>
  );
}

export function ActionMenu({
  trigger,
  popoverClassName,
  ...options
}: MenuOptions & {
  trigger: ReactElement;
  popoverClassName?: string;
}) {
  return (
    <Dropdown>
      {trigger}
      <Dropdown.Popover placement="bottom start" className={popoverClassName ?? ""}>
        <Menu {...options} />
      </Dropdown.Popover>
    </Dropdown>
  );
}
