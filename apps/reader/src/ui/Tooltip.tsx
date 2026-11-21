import { Tooltip as HeroTooltip } from "@heroui/react/tooltip";
import type { ReactElement } from "react";

export function Tooltip({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children: ReactElement;
}) {
  return (
    <HeroTooltip>
      {children}
      <HeroTooltip.Content className={className ?? ""}>{text}</HeroTooltip.Content>
    </HeroTooltip>
  );
}
