import { Tooltip as HeroTooltip } from "@heroui/react/tooltip";
import type { ReactElement } from "react";

export type TooltipPlacement = "top" | "start";

export function Tooltip({
  text,
  className,
  placement = "top",
  children,
}: {
  text: string;
  className?: string;
  placement?: TooltipPlacement;
  children: ReactElement;
}) {
  return (
    <HeroTooltip>
      {children}
      <HeroTooltip.Content className={className ?? ""} placement={placement}>
        {text}
      </HeroTooltip.Content>
    </HeroTooltip>
  );
}
