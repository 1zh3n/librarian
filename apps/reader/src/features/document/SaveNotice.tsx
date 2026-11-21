import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import type { EditorSession } from "../../editor/codemirror/adapter";
import type { MarkdownSnapshot, SaveController } from "./saveController";
import styles from "./DocumentPage.module.css";

type SaveHandle = Pick<SaveController<MarkdownSnapshot>, "status" | "subscribe" | "flush">;

export function SaveNotice({
  saves,
  editor,
  kind,
}: {
  saves: SaveHandle;
  editor: EditorSession;
  kind: "body" | "outline";
}) {
  const status = useSyncExternalStore(saves.subscribe, saves.status);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const reconnect = () => {
      setOnline(true);
      if (saves.status() === "error" && !editor.isComposing()) void saves.flush();
    };
    const disconnect = () => setOnline(false);
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", disconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", disconnect);
    };
  }, [editor, saves]);

  if (status === "saved")
    return (
      <Feedback className={styles.saved} tone="success">
        已保存
      </Feedback>
    );
  if (status !== "conflict" && status !== "error") return null;
  const subject = kind === "body" ? "正文" : "提纲";
  const description =
    status === "conflict"
      ? `服务器上的${subject}已更新。未保存的内容仍在编辑器中。`
      : online
        ? `${subject}保存失败。未保存的内容仍在编辑器中。`
        : `${subject}尚未保存。网络恢复后会重试。`;
  return (
    <Feedback className={styles.saveError} tone="error">
      <span>{description}</span>
      {status === "error" && (
        <Button
          className={styles.actionButton}
          onPress={() => !editor.isComposing() && void saves.flush()}
        >
          重试
        </Button>
      )}
      <Button
        className={styles.actionButton}
        onPress={() => {
          const url = URL.createObjectURL(
            new Blob([editor.source()], { type: "text/markdown;charset=utf-8" }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = kind === "body" ? "正文-本地草稿.md" : "提纲-本地草稿.md";
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        }}
      >
        下载草稿
      </Button>
    </Feedback>
  );
}
