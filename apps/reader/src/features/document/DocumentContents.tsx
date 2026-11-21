import { useLayoutEffect, useRef, useState } from "react";
import type { DocumentHeading } from "../../markdown/analyze";
import styles from "./DocumentPage.module.css";

export function headingAtReadingPosition(viewport: HTMLElement) {
  const barHeight = getComputedStyle(
    viewport.querySelector("article") ?? viewport,
  ).getPropertyValue("--document-toolbar-height");
  const top = viewport.getBoundingClientRect().top + Number.parseFloat(barHeight || "0") + 13;
  const headings = viewport.querySelectorAll<HTMLElement>("article :is(h1,h2,h3,h4,h5,h6)[id]");
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (headings[mid]!.getBoundingClientRect().top <= top) low = mid + 1;
    else high = mid;
  }
  return headings[Math.max(0, low - 1)]?.id;
}

export function DocumentContents({
  headings,
  initial,
  onChoose,
}: {
  headings: readonly DocumentHeading[];
  initial: string | undefined;
  onChoose: (id: string) => void;
}) {
  const list = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState(initial);
  useLayoutEffect(() => {
    const nav = list.current;
    const viewport = nav?.closest("main");
    if (!nav || !viewport) return;
    let frame = 0;
    const scroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (getComputedStyle(nav).getPropertyValue("--inline-tool").trim() === "0") {
          setCurrent(headingAtReadingPosition(viewport));
        }
      });
    };
    viewport.addEventListener("scroll", scroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", scroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  useLayoutEffect(() => {
    const nav = list.current;
    const link = nav?.querySelector('[aria-current="location"]');
    if (!nav || !link) return;
    const bounds = nav.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.bottom > bounds.bottom || item.top < bounds.top) {
      nav.scrollTop += item.top - bounds.top - (bounds.height - item.height) / 2;
    }
  }, [current]);
  return (
    <nav ref={list} className={styles.contents} aria-label="文档目录">
      <h2 className={styles.contentsTitle}>文档目录</h2>
      {headings.map((heading) => (
        <a
          key={heading.id}
          href={`#${encodeURIComponent(heading.id)}`}
          aria-current={heading.id === current ? "location" : undefined}
          style={{ paddingInlineStart: Math.max(heading.level - 2, 0) * 12 + 8 }}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.shiftKey
            )
              return;
            event.preventDefault();
            setCurrent(heading.id);
            onChoose(heading.id);
          }}
        >
          {heading.label}
        </a>
      ))}
    </nav>
  );
}
