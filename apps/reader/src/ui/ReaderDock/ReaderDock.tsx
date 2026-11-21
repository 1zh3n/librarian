import { useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import styles from "./ReaderDock.module.css";

export function ReaderDock({
  layoutRef,
  wide,
  navigationVisible,
  sidebarWidth,
  onWidthChange,
  onCollapse,
  navigation,
  children,
}: {
  layoutRef: RefObject<HTMLDivElement | null>;
  wide: boolean;
  navigationVisible: boolean;
  sidebarWidth: number;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  navigation: ReactNode;
  children: ReactNode;
}) {
  const panelRef = usePanelRef();
  const divider = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (navigationVisible) {
      panel.expand();
      panel.resize(wide ? sidebarWidth : 190);
    } else {
      panel.collapse();
    }
  }, [panelRef, navigationVisible, sidebarWidth, wide]);

  return (
    <Group
      className={styles.columns}
      elementRef={layoutRef}
      orientation={wide ? "horizontal" : "vertical"}
      resizeTargetMinimumSize={{ coarse: 44, fine: 14 }}
      onLayoutChanged={(sizes, { isUserInteraction }) => {
        if (
          !isUserInteraction ||
          !wide ||
          !navigationVisible ||
          !layoutRef.current ||
          !divider.current
        )
          return;
        const fraction = sizes["navigation-panel"];
        if (fraction === 0) {
          onCollapse();
          return;
        }
        // The callback precedes the panel DOM update. Its layout already has the final size.
        const available = layoutRef.current.clientWidth - divider.current.offsetWidth;
        const pixels = Math.round((available * (fraction ?? 0)) / 100);
        if (pixels >= 176 && pixels <= 360 && pixels !== sidebarWidth) onWidthChange(pixels);
      }}
    >
      <Panel
        id="navigation-panel"
        panelRef={panelRef}
        collapsible
        collapsedSize={0}
        minSize={wide ? 176 : 130}
        maxSize={wide ? 360 : "34%"}
        defaultSize={navigationVisible ? (wide ? sidebarWidth : 190) : 0}
        groupResizeBehavior="preserve-pixel-size"
      >
        {navigation}
      </Panel>
      {wide && navigationVisible && (
        <Separator
          elementRef={divider}
          className={styles.separator}
          aria-label="调整空间目录宽度"
        />
      )}
      <Panel id="document-panel" minSize={wide ? 300 : "50%"}>
        {children}
      </Panel>
    </Group>
  );
}
