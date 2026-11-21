import { Icon } from "./Icon";
import { Disclosure as HeroDisclosure } from "@heroui/react/disclosure";
import type { ReactNode } from "react";

export function Disclosure({
  title,
  expanded,
  onChange,
  className,
  triggerClassName,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  expanded?: boolean;
  onChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <HeroDisclosure
      className={className ?? ""}
      {...(expanded !== undefined && { isExpanded: expanded })}
      {...(onChange && { onExpandedChange: onChange })}
    >
      <HeroDisclosure.Heading>
        <HeroDisclosure.Trigger className={triggerClassName ?? ""}>
          {title}
          <Icon name="chevron-down" />
        </HeroDisclosure.Trigger>
      </HeroDisclosure.Heading>
      <HeroDisclosure.Content>
        <HeroDisclosure.Body className={bodyClassName ?? ""}>{children}</HeroDisclosure.Body>
      </HeroDisclosure.Content>
    </HeroDisclosure>
  );
}
