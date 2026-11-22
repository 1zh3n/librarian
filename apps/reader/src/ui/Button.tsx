import { Button as HeroButton } from "@heroui/react/button";
import { ToggleButton as HeroToggleButton } from "@heroui/react/toggle-button";
import type { ReactNode, Ref } from "react";

type ButtonProps = {
  "aria-current"?: "page";
  "aria-label"?: string;
  "aria-keyshortcuts"?: string;
  "aria-haspopup"?: "menu" | "dialog";
  "aria-controls"?: string;
  "aria-expanded"?: boolean;
  children: ReactNode;
  variant?: "ghost" | "primary" | "outline";
  size?: "sm" | "md" | "lg";
  className?: string;
  fullWidth?: boolean;
  isIconOnly?: boolean;
  isDisabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
  ref?: Ref<HTMLButtonElement>;
  slot?: "chevron";
  onPress?: (event: { target: Element }) => void;
  onPressStart?: () => void;
};

export function Button({ variant = "ghost", loading = false, ...props }: ButtonProps) {
  return <HeroButton {...props} variant={variant} isPending={loading} />;
}

export function ToggleButton(props: {
  children: ReactNode;
  className?: string;
  isSelected: boolean;
  onChange: (selected: boolean) => void;
  isDisabled?: boolean;
  "aria-label"?: string;
}) {
  return <HeroToggleButton {...props} />;
}
