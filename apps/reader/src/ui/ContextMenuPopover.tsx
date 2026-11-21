import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Popover } from "./primitives";

export type MenuPoint = { x: number; y: number };

const gap = 2;
const viewportPadding = 4;

export function ContextMenuPopover({
  trigger,
  point,
  close,
  className,
  children,
}: {
  trigger: HTMLElement;
  point: MenuPoint | undefined;
  close: () => void;
  className: string;
  children: ReactNode;
}) {
  const triggerRef = useMemo(() => ({ current: trigger }), [trigger]);
  const menu = useRef<HTMLElement>(null);
  const [opensLeft, setOpensLeft] = useState(false);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element || !point) return;
    const viewport = window.visualViewport;
    const measure = () => {
      const right = viewport ? viewport.offsetLeft + viewport.width : window.innerWidth;
      setOpensLeft(point.x + gap + element.offsetWidth > right - viewportPadding);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
    };
  }, [point]);

  return (
    <Popover
      ref={menu}
      triggerRef={triggerRef}
      {...(point && {
        getTargetRect: () => {
          const view = window.visualViewport;
          const left = view?.offsetLeft ?? 0;
          const top = view?.offsetTop ?? 0;
          const x = Math.max(left, Math.min(point.x, left + (view?.width ?? window.innerWidth)));
          const y = Math.max(top, Math.min(point.y, top + (view?.height ?? window.innerHeight)));
          return new DOMRect(x + (opensLeft ? -gap : gap), y, 0, 0);
        },
      })}
      placement={opensLeft ? "bottom right" : "bottom left"}
      containerPadding={viewportPadding}
      offset={gap}
      isOpen
      className={className}
      onOpenChange={(open) => !open && close()}
    >
      {children}
    </Popover>
  );
}
