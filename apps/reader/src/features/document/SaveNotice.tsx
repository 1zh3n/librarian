import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import { TextAreaField } from "../../ui/Forms";
import type { EditorSession } from "../../editor/codemirror/adapter";
import type { MarkdownSnapshot, SaveController } from "./saveController";
import styles from "./DocumentPage.module.css";

type SaveHandle = Pick<
  SaveController<MarkdownSnapshot>,
  | "status"
  | "subscribe"
  | "flush"
  | "conflict"
  | "reloadRemote"
  | "overwriteRemote"
  | "mergeRemote"
  | "retryRemote"
>;

type ConflictDialog = "reload" | "overwrite" | "merge";

export function SaveNotice({
  saves,
  editor,
  kind,
  onResolved,
}: {
  saves: SaveHandle;
  editor: EditorSession;
  kind: "body" | "outline";
  onResolved?: () => void;
}) {
  const status = useSyncExternalStore(saves.subscribe, saves.status);
  const conflict = useSyncExternalStore(saves.subscribe, saves.conflict);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [dialog, setDialog] = useState<ConflictDialog>();
  const [merged, setMerged] = useState("");
  const [actionError, setActionError] = useState<string>();
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
  function download() {
    const url = URL.createObjectURL(
      new Blob([editor.source()], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = kind === "body" ? "正文-本地草稿.md" : "提纲-本地草稿.md";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function openMerge() {
    setMerged(editor.source());
    setActionError(undefined);
    setDialog("merge");
  }

  function finish(action: () => boolean) {
    setActionError(undefined);
    if (!action()) {
      setActionError("编辑器仍在输入，请结束输入后重试。");
      return;
    }
    setDialog(undefined);
    if (onResolved) onResolved();
    else editor.focus();
  }

  if (status === "saved")
    return (
      <Feedback className={styles.saved} tone="success">
        已保存
      </Feedback>
    );
  if (status !== "conflict" && status !== "error") return null;
  const subject = kind === "body" ? "正文" : "提纲";
  if (status === "error") {
    const description = online
      ? `${subject}保存失败。未保存的内容仍在编辑器中。`
      : `${subject}尚未保存。网络恢复后会重试。`;
    return (
      <Feedback className={styles.saveError} tone="error">
        <span>{description}</span>
        <div className={styles.saveActions}>
          <Button
            className={styles.actionButton}
            onPress={() => !editor.isComposing() && void saves.flush()}
          >
            重试
          </Button>
          <Button className={styles.actionButton} onPress={download}>
            下载草稿
          </Button>
        </div>
      </Feedback>
    );
  }

  const remote = conflict?.state === "ready" ? conflict.remote : undefined;
  const description =
    conflict?.state === "unavailable"
      ? `服务器上的${subject}已更新，但暂时无法读取服务器版本。本地修改仍在编辑器中。`
      : `服务器上的${subject}已更新。本地修改尚未保存，请选择如何处理。`;
  return (
    <>
      <Feedback className={styles.saveError} tone="error">
        <span>{description}</span>
        {conflict?.state === "loading" && (
          <span className={styles.saveHint}>正在读取服务器版本…</span>
        )}
        {conflict?.state === "unavailable" && (
          <span className={styles.saveHint}>
            可以先下载草稿，再重试读取。
            <Button className={styles.actionButton} onPress={() => void saves.retryRemote()}>
              重试读取
            </Button>
          </span>
        )}
        <div className={styles.saveActions}>
          <Button
            variant="primary"
            className={styles.actionButton}
            isDisabled={!remote}
            onPress={openMerge}
          >
            合并…
          </Button>
          <Button
            className={styles.actionButton}
            isDisabled={!remote}
            onPress={() => {
              setActionError(undefined);
              setDialog("reload");
            }}
          >
            重新加载远端
          </Button>
          <Button
            className={styles.actionButton}
            isDisabled={!remote}
            onPress={() => {
              setActionError(undefined);
              setDialog("overwrite");
            }}
          >
            保留本地覆盖
          </Button>
          <Button className={styles.actionButton} onPress={download}>
            下载草稿
          </Button>
        </div>
      </Feedback>

      {dialog === "reload" && remote && (
        <Dialog title="重新加载远端正文" onClose={() => setDialog(undefined)} classes={styles}>
          <p className={styles.dialogText}>
            编辑器中的本地修改将被服务器版本替换。需要保留时，请先取消并下载草稿。
          </p>
          {actionError && <Feedback tone="error">{actionError}</Feedback>}
          <div className={styles.dialogActions}>
            <Button onPress={() => setDialog(undefined)}>取消</Button>
            <Button
              variant="outline"
              className={styles.dangerButton}
              onPress={() => finish(() => saves.reloadRemote())}
            >
              重新加载
            </Button>
          </div>
        </Dialog>
      )}

      {dialog === "overwrite" && remote && (
        <Dialog title="保留本地覆盖" onClose={() => setDialog(undefined)} classes={styles}>
          <p className={styles.dialogText}>
            保存后，服务器上的当前{subject}将被本地草稿覆盖。被覆盖的内容仍可从版本记录恢复。
          </p>
          {actionError && <Feedback tone="error">{actionError}</Feedback>}
          <div className={styles.dialogActions}>
            <Button onPress={() => setDialog(undefined)}>取消</Button>
            <Button
              variant="outline"
              className={styles.dangerButton}
              onPress={() => finish(() => saves.overwriteRemote())}
            >
              覆盖远端
            </Button>
          </div>
        </Dialog>
      )}

      {dialog === "merge" && remote && (
        <Dialog title={`合并${subject}冲突`} onClose={() => setDialog(undefined)} classes={styles}>
          <p className={styles.dialogText}>
            以本地草稿为起点，参考服务器版本修改合并结果。保存后会生成一个新版本。
          </p>
          <div className={styles.mergeGrid}>
            <section className={styles.mergeSide}>
              <h3>服务器版本</h3>
              <pre className={styles.mergePreview} aria-label="服务器版本">
                {remote.markdown || "（空文档）"}
              </pre>
            </section>
            <section className={styles.mergeSide}>
              <h3>本地草稿</h3>
              <pre className={styles.mergePreview} aria-label="本地草稿">
                {editor.source() || "（空文档）"}
              </pre>
            </section>
          </div>
          <TextAreaField
            label="合并结果"
            rows={10}
            value={merged}
            inputClassName={styles.mergeInput}
            onChange={setMerged}
          />
          {actionError && <Feedback tone="error">{actionError}</Feedback>}
          <div className={styles.dialogActions}>
            <Button onPress={() => setDialog(undefined)}>取消</Button>
            <Button variant="primary" onPress={() => finish(() => saves.mergeRemote(merged))}>
              保存合并结果
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
