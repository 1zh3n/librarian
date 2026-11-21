import { useEffect, useState } from "react";
import { Button } from "./Button";

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({
  text,
  label = "复制",
  className,
  isDisabled = false,
}: {
  text: string;
  label?: string;
  className?: string;
  isDisabled?: boolean;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const available = typeof navigator !== "undefined" && Boolean(navigator.clipboard);

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <Button
      variant="outline"
      {...(className ? { className } : {})}
      isDisabled={isDisabled || !available}
      onPress={() => {
        if (!navigator.clipboard) return;
        void navigator.clipboard.writeText(text).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {!available
        ? "复制不可用"
        : state === "copied"
          ? "已复制"
          : state === "failed"
            ? "复制失败"
            : label}
    </Button>
  );
}
