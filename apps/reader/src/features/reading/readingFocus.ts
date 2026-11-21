import { useRouter } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { DraftPreparation } from "../navigation/useDirectoryActions";
import type { RefObject } from "react";
import type { DevicePreferences, DocumentSummary } from "../../api/client";

type Focus = null | {
  activation: number;
  document: string;
  width: number | undefined;
  toolInset: number;
  navigationInset: number;
};
type SemanticSelection = { document: string; block: string };

const readMeasure = "[data-reading-measure]";
const gridMeasure = "[data-reading-grid]";

export function useReadingFocus(
  viewport: RefObject<HTMLElement | null>,
  layout: RefObject<HTMLDivElement | null>,
  documentId?: string,
) {
  const [focus, setFocus] = useState<Focus>(null);
  const [semantic, setSemantic] = useState<SemanticSelection | null>(null);
  const [announce, setAnnounce] = useState(false);
  const activation = useRef(0);
  const router = useRouter();
  const semanticBlock = semantic?.document === documentId ? semantic?.block : undefined;

  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ pathChanged }) => {
        if (pathChanged) setSemantic(null);
      }),
    [router],
  );
  useEffect(() => {
    if (!announce) return;
    const timer = setTimeout(() => setAnnounce(false), 2_000);
    return () => clearTimeout(timer);
  }, [announce]);

  const setSemanticBlock = useCallback(
    (block: string | undefined) => {
      setSemantic(block && documentId ? { block, document: documentId } : null);
    },
    [documentId],
  );

  const toggle = useCallback(() => {
    if (focus) {
      setSemantic(null);
      setAnnounce(false);
      setFocus(null);
      return;
    }
    if (!documentId) return;
    const canvas = viewport.current?.querySelector(readMeasure)?.getBoundingClientRect();
    const grid = viewport.current?.querySelector(gridMeasure)?.getBoundingClientRect();
    const viewportTop = viewport.current?.getBoundingClientRect().top ?? 0;
    const layoutTop = layout.current?.getBoundingClientRect().top ?? viewportTop;
    activation.current += 1;
    setFocus({
      activation: activation.current,
      document: documentId,
      width: canvas?.width || undefined,
      toolInset: Math.max(0, grid && canvas ? canvas.top - grid.top : 0),
      navigationInset: Math.max(0, viewportTop - layoutTop),
    });
    setAnnounce(true);
  }, [documentId, focus, layout, viewport]);

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "Escape" ||
        isEditingTarget(event.target) ||
        (event.target instanceof Element && event.target.closest("[role=dialog], [role=menu]"))
      )
        return;
      if (semanticBlock) {
        event.preventDefault();
        setSemanticBlock(undefined);
      } else if (focus) {
        event.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focus, semanticBlock, setSemanticBlock, toggle]);

  return {
    active: focus !== null,
    activation: focus?.activation,
    width: focus?.width,
    toolInset: focus?.document === documentId ? focus?.toolInset : undefined,
    navigationInset: focus?.document === documentId ? focus?.navigationInset : undefined,
    announce,
    toggle,
    semanticBlock,
    setSemanticBlock,
  };
}

export function isEditingTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"),
    )
  );
}

type ReaderLayout = {
  draft: RefObject<DraftPreparation | undefined>;
  focus: ReturnType<typeof useReadingFocus>;
  preferences: DevicePreferences;
  layoutSelection: number;
  savePreferences: (patch: Partial<DevicePreferences>) => Promise<DevicePreferences>;
  createdDocument: string | undefined;
  clearCreatedDocument: () => void;
  renameDocument: ((document: DocumentSummary, origin: HTMLElement) => void) | undefined;
  navigationCancelled: (pathname: string) => void;
};

export const ReaderLayoutContext = createContext<ReaderLayout | null>(null);

export function useReaderLayout() {
  const layout = useContext(ReaderLayoutContext);
  if (!layout) throw new Error("Reader layout is unavailable");
  return layout;
}
