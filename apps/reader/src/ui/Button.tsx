import { Button as HeroButton } from "@heroui/react/button";
import type { ButtonProps } from "@heroui/react/button";

export function Button({ variant = "ghost", ...props }: ButtonProps) {
  return <HeroButton {...props} variant={variant} />;
}
