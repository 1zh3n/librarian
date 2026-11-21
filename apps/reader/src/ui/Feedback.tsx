import { Alert } from "@heroui/react/alert";
import type { ReactNode, Ref } from "react";

export function Feedback({
  tone = "status",
  children,
  ...props
}: {
  tone?: "error" | "success" | "status";
  className?: string;
  id?: string;
  ref?: Ref<HTMLDivElement>;
  tabIndex?: number;
  children: ReactNode;
}) {
  return (
    <Alert
      {...props}
      role={tone === "error" ? "alert" : "status"}
      data-feedback={tone}
      status={tone === "error" ? "danger" : tone === "success" ? "success" : "default"}
    >
      {children}
    </Alert>
  );
}
