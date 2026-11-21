import { Icon } from "../../ui/Icon";
import { useEffect, useState } from "react";
import { useReaderLayout } from "../reading/readingFocus";
import type { DevicePreferences } from "../../api/client";
import type { ReactNode, RefObject } from "react";
import { ReaderToolResizeHandle } from "../../ui/ReaderDock/ReaderToolResizeHandle";
import { Button } from "../../ui/Button";
import { Tabs, TabPanel } from "../../ui/Tabs";
import styles from "./DocumentPage.module.css";

const documentTabs = [
  { id: "outline", label: "提纲", icon: "align-left" },
  { id: "ai", label: "AI", icon: "sparkles" },
  { id: "history", label: "版本", icon: "history" },
  { id: "references", label: "引用", icon: "link" },
] as const;
type DocumentTab = (typeof documentTabs)[number]["id"];
export type Tool = DocumentTab | "contents" | "metadata";

function isDocumentTab(value: unknown): value is DocumentTab {
  return documentTabs.some(({ id }) => id === value);
}

type ToolChoice = {
  entry: string | undefined;
  normal?: { layout: DevicePreferences["layout"]; selection: number; tool: Tool | undefined };
  focus?: { activation: number; tool: Tool | undefined };
  lastTab?: DocumentTab;
};

export function useDocumentTools(
  outlineEnabled: boolean,
  entry: string | undefined,
  initial: DocumentTab | "paper" | "layout",
) {
  const { preferences, layoutSelection, focus } = useReaderLayout();
  function initialChoice(): ToolChoice {
    if (initial === "layout") return { entry };
    const tool = initial === "paper" ? undefined : initial;
    return {
      entry,
      normal: { layout: preferences.layout, selection: layoutSelection, tool },
      ...(focus.activation !== undefined && { focus: { activation: focus.activation, tool } }),
      ...(tool && { lastTab: tool }),
    };
  }
  const [choice, setChoice] = useState(initialChoice);
  if (choice.entry !== entry) setChoice(initialChoice());
  const layoutDefault =
    preferences.layout === "review"
      ? "history"
      : preferences.layout === "research"
        ? "ai"
        : preferences.layout === "writing" && outlineEnabled
          ? "outline"
          : undefined;
  const normal = choice.normal;
  const tool = focus.active
    ? choice.focus?.activation === focus.activation
      ? choice.focus?.tool
      : undefined
    : normal?.layout === preferences.layout && normal.selection === layoutSelection
      ? normal.tool
      : layoutDefault;
  const lastTab = choice.lastTab === "outline" && !outlineEnabled ? undefined : choice.lastTab;
  function chooseTool(next: Tool | undefined) {
    const activation = focus.activation;
    setChoice((previous) => ({
      ...previous,
      ...(activation === undefined
        ? { normal: { layout: preferences.layout, selection: layoutSelection, tool: next } }
        : { focus: { activation, tool: next } }),
      ...(isDocumentTab(next) && { lastTab: next }),
    }));
  }
  const rememberedTab: DocumentTab = lastTab ?? (outlineEnabled ? "outline" : "ai");
  return { tool, chooseTool, rememberedTab };
}

export function DocumentToolPanel({
  ref,
  id,
  tool,
  rememberedTab,
  onSelect,
  onClose,
  outline,
  ai,
  history,
  references,
  contents,
  metadata,
}: {
  ref: RefObject<HTMLElement | null>;
  id: string;
  tool: Tool | undefined;
  rememberedTab: DocumentTab;
  onSelect: (tab: DocumentTab) => void;
  onClose: () => void;
  outline?: ReactNode;
  ai: ReactNode;
  history: ReactNode;
  references: ReactNode;
  contents: ReactNode;
  metadata: ReactNode;
}) {
  const { preferences, savePreferences } = useReaderLayout();
  useEffect(() => {
    const pane = ref.current;
    if (!tool || !pane) return;
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    pane.addEventListener("keydown", keydown);
    return () => pane.removeEventListener("keydown", keydown);
  }, [onClose, ref, tool]);
  const tabbed = isDocumentTab(tool);
  const tabs = documentTabs.filter((tab) => tab.id !== "outline" || outline !== undefined);
  const panels = { outline, ai, history, references };
  return (
    <section
      ref={ref}
      id={id}
      className={styles.toolPane}
      data-tabbed={tabbed || undefined}
      hidden={!tool}
      aria-label="文档辅助区"
      tabIndex={-1}
    >
      <ReaderToolResizeHandle
        width={preferences.toolsWidth}
        onWidthChange={(toolsWidth) => savePreferences({ toolsWidth })}
      />
      <Button className={styles.closePane} isIconOnly aria-label="收起文档辅助区" onPress={onClose}>
        <Icon name="panel-right-close" />
      </Button>
      <div hidden={!tabbed}>
        <Tabs
          label="文档工具"
          className={styles.toolTabs}
          listClassName={styles.tabList}
          tabClassName={styles.toolTab}
          value={tabbed ? tool : rememberedTab}
          onChange={(key) => {
            if (tabbed && isDocumentTab(key)) onSelect(key);
          }}
          items={tabs.map(({ id, label, icon }) => ({
            id,
            label,
            content: (
              <>
                <Icon className={styles.tabIcon} name={icon} />
                {label}
              </>
            ),
          }))}
        >
          {tabs.map(({ id }) => {
            const keepSession = id === "outline" || id === "ai";
            return (
              <TabPanel key={id} id={id} className={styles.tabPanel} keepMounted={keepSession}>
                {(keepSession || tool === id) && panels[id]}
              </TabPanel>
            );
          })}
        </Tabs>
      </div>
      {tool === "contents" && contents}
      {tool === "metadata" && metadata}
    </section>
  );
}
