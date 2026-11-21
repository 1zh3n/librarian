import { Tabs as HeroTabs } from "@heroui/react/tabs";
import type { ReactNode } from "react";

export function Tabs({
  label,
  value,
  disabled = false,
  onChange,
  items,
  className,
  listClassName,
  tabClassName,
  children,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  items: readonly { id: string; label: string; content?: ReactNode }[];
  className?: string;
  listClassName?: string;
  tabClassName?: string;
  children: ReactNode;
}) {
  return (
    <HeroTabs
      className={className ?? ""}
      isDisabled={disabled}
      selectedKey={value}
      onSelectionChange={(id) => onChange(String(id))}
    >
      <HeroTabs.List aria-label={label} className={listClassName ?? ""}>
        {items.map(({ id, label, content }) => (
          <HeroTabs.Tab aria-label={label} key={id} id={id} className={tabClassName ?? ""}>
            {content ?? label}
          </HeroTabs.Tab>
        ))}
      </HeroTabs.List>
      {children}
    </HeroTabs>
  );
}

export function TabPanel({
  id,
  keepMounted = false,
  className,
  children,
}: {
  id: string;
  keepMounted?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <HeroTabs.Panel id={id} className={className ?? ""} shouldForceMount={keepMounted}>
      {children}
    </HeroTabs.Panel>
  );
}
