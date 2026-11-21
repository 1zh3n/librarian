import { useLayoutEffect, useRef, useState } from "react";
import { Focusable } from "react-aria-components";
import styles from "./ReaderDock.module.css";

const minWidth = 200;
const maxWidth = 480;
const step = 16;

export function ReaderToolResizeHandle({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => Promise<unknown>;
}) {
  const handle = useRef<HTMLHRElement>(null);
  const grid = useRef<HTMLElement | null>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const change = useRef(0);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState({ now: width, max: maxWidth, controls: "" });

  useLayoutEffect(() => {
    const pane = handle.current?.parentElement;
    const layout = pane?.closest<HTMLElement>("[data-reading-grid]");
    if (!pane || !layout) return;
    grid.current = layout;
    function measure() {
      if (!pane || !layout || !handle.current?.getClientRects().length) return;
      const now = Math.round(pane.getBoundingClientRect().width);
      // Ask the actual grid for its largest usable width at this breakpoint.
      const previous = layout.style.getPropertyValue("--tool-width");
      layout.style.setProperty("--tool-width", `${maxWidth}px`);
      const max = Math.round(pane.getBoundingClientRect().width);
      layout.style.setProperty("--tool-width", previous);
      setRange((old) =>
        old.now === now && old.max === max && old.controls === pane.id
          ? old
          : { now, max, controls: pane.id },
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    observer.observe(pane);
    return () => {
      observer.disconnect();
      layout.style.removeProperty("--tool-width");
      grid.current = null;
    };
  }, []);

  function preview(next: number) {
    const size = Math.min(range.max, Math.max(minWidth, Math.round(next)));
    grid.current?.style.setProperty("--tool-width", `${size}px`);
    return size;
  }

  async function commit(next: number) {
    const current = ++change.current;
    setFailed(false);
    try {
      await onWidthChange(next);
    } catch {
      if (current === change.current && grid.current) setFailed(true);
    } finally {
      if (current === change.current && !drag.current)
        grid.current?.style.removeProperty("--tool-width");
    }
  }

  function cancel() {
    if (!drag.current) return;
    drag.current = null;
    grid.current?.style.removeProperty("--tool-width");
  }

  return (
    <>
      <Focusable>
        <hr
          ref={handle}
          aria-label="调整文档辅助区宽度"
          aria-controls={range.controls}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={range.max}
          aria-valuenow={range.now}
          aria-valuetext={`${range.now} 像素`}
          className={styles.toolHandle}
          onKeyDownCapture={(event) => {
            if (event.key === "Escape" && drag.current) {
              event.preventDefault();
              event.stopPropagation();
              cancel();
              return;
            }
            const now = Math.round(
              event.currentTarget.parentElement!.getBoundingClientRect().width,
            );
            const next = {
              ArrowLeft: now + step,
              ArrowRight: now - step,
              Home: minWidth,
              End: range.max,
            }[event.key];
            if (next === undefined || drag.current) return;
            event.preventDefault();
            const size = Math.max(minWidth, Math.min(next, range.max));
            if (size !== now) void commit(preview(size));
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current || !event.isPrimary) return;
            const node = event.currentTarget;
            drag.current = {
              pointer: event.pointerId,
              x: event.clientX,
              width: Math.round(node.parentElement!.getBoundingClientRect().width),
            };
            node.focus({ preventScroll: true });
            node.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (start?.pointer === event.pointerId) preview(start.width + start.x - event.clientX);
          }}
          onPointerUp={(event) => {
            const start = drag.current;
            if (start?.pointer !== event.pointerId) return;
            const next = preview(start.width + start.x - event.clientX);
            drag.current = null;
            if (next !== start.width) void commit(next);
            else grid.current?.style.removeProperty("--tool-width");
          }}
          onLostPointerCapture={cancel}
          onPointerCancel={cancel}
        />
      </Focusable>
      {failed && <p role="alert">辅助区宽度未保存，请重新调整。</p>}
    </>
  );
}
