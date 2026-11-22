import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import styles from "./DocumentAiPanel.module.css";

const STORAGE_KEY = "librarian.documentAi";
const GAP = 16;
const DEFAULT_WIDTH = 336;
const DEFAULT_HEIGHT = 766;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 320;
const MAX_WIDTH = 720;

type Geometry = { x: number; y: number; width: number; height: number };

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function clamp(geometry: Geometry): Geometry {
  const { width: viewportWidth, height: viewportHeight } = viewport();
  const width = Math.min(
    Math.max(geometry.width, MIN_WIDTH),
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - GAP * 2)),
  );
  const height = Math.min(
    Math.max(geometry.height, MIN_HEIGHT),
    Math.max(MIN_HEIGHT, viewportHeight - GAP * 2),
  );
  return {
    width,
    height,
    x: Math.min(Math.max(geometry.x, GAP), Math.max(GAP, viewportWidth - width - GAP)),
    y: Math.min(Math.max(geometry.y, GAP), Math.max(GAP, viewportHeight - height - GAP)),
  };
}

function defaultGeometry(): Geometry {
  const { width: viewportWidth, height: viewportHeight } = viewport();
  const toolbarSafeTop = 118;
  const top = Math.max(GAP, Math.min(toolbarSafeTop, viewportHeight - MIN_HEIGHT - GAP));
  const available = Math.max(MIN_HEIGHT, viewportHeight - top - GAP);
  const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, viewportWidth - GAP * 2));
  const height = Math.min(DEFAULT_HEIGHT, available);
  return {
    width,
    height,
    x: Math.max(GAP, viewportWidth - width - GAP),
    y: top,
  };
}

function loadGeometry(): Geometry {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Geometry>;
      if (
        typeof parsed.x === "number" &&
        typeof parsed.y === "number" &&
        typeof parsed.width === "number" &&
        typeof parsed.height === "number"
      ) {
        return clamp(parsed as Geometry);
      }
    }
  } catch {
    // A corrupt or unavailable localStorage entry falls back to the dock.
  }
  return defaultGeometry();
}

function persist(geometry: Geometry) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(geometry));
  } catch {
    // Geometry is a convenience; failure does not block the conversation.
  }
}

function isNarrow() {
  return window.matchMedia("(max-width: 44rem)").matches;
}

export function DocumentAiPanel({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [geometry, setGeometry] = useState<Geometry>(loadGeometry);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(geometry);
  const shell = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    latest.current = geometry;
  }, [geometry]);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      // Returning from a source may already focus the answer link or composer.
      if (document.activeElement === document.body)
        closeButton.current?.focus({ preventScroll: true });
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function keydown(event: KeyboardEvent) {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        !shell.current?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose, open]);
  useEffect(() => {
    function resize() {
      setGeometry((current) => clamp(current));
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || isNarrow()) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = latest.current;
    setDragging(true);
    function move(moveEvent: PointerEvent) {
      setGeometry(
        clamp({
          ...start,
          x: start.x + moveEvent.clientX - startX,
          y: start.y + moveEvent.clientY - startY,
        }),
      );
    }
    function end() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDragging(false);
      persist(latest.current);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function beginResize(event: ReactPointerEvent<HTMLElement>, both: boolean) {
    if (event.button !== 0 || isNarrow()) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = latest.current;
    setDragging(true);
    function move(moveEvent: PointerEvent) {
      setGeometry(
        clamp({
          ...start,
          width: start.width + moveEvent.clientX - startX,
          height: both ? start.height + moveEvent.clientY - startY : start.height,
        }),
      );
    }
    function end() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDragging(false);
      persist(latest.current);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function resizeBy(delta: number) {
    setGeometry((current) => {
      const next = clamp({ ...current, width: current.width + delta });
      latest.current = next;
      persist(next);
      return next;
    });
  }

  function reset() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // The default is still applied in memory.
    }
    setGeometry(defaultGeometry());
  }

  return createPortal(
    <div
      ref={shell}
      className={styles.shell}
      hidden={!open}
      data-document-ai-panel
      data-dragging={dragging || undefined}
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
      }}
    >
      <header className={styles.header} onPointerDown={beginDrag}>
        <h2>文档 AI</h2>
        <div className={styles.headerActions}>
          <Button size="sm" variant="ghost" aria-label="复位文档 AI" onPress={reset}>
            复位
          </Button>
          <Button
            ref={closeButton}
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="收起文档 AI"
            onPress={onClose}
          >
            <Icon name="x" />
          </Button>
        </div>
      </header>
      <div className={styles.body}>{children}</div>
      <Button
        variant="ghost"
        className={styles.resizeWidth}
        aria-label="调整文档 AI 宽度"
        onPointerDown={(event) => beginResize(event, false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            resizeBy(-16);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            resizeBy(16);
          }
        }}
      >
        <span aria-hidden="true" />
      </Button>
      <div
        className={styles.resizeCorner}
        aria-hidden="true"
        onPointerDown={(event) => beginResize(event, true)}
      />
    </div>,
    document.body,
  );
}
