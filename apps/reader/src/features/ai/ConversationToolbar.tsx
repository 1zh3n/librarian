import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ConversationView, Workspace } from "../../api/client";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import { Select } from "../../ui/Forms";
import { Icon } from "../../ui/Icon";
import { ActionMenu } from "../../ui/Menu";
import dialog from "../document/CreateDocumentDialog.module.css";
import styles from "./AiPanel.module.css";

export function ConversationToolbar({
  global,
  spaces,
  conversations,
  selected,
  firstQuestion,
  busy,
  pick,
  more,
  remove,
  focusPrompt,
  saveScopeVisit,
}: {
  global: boolean;
  spaces: readonly Workspace[];
  conversations: readonly ConversationView[];
  selected: string | undefined;
  firstQuestion: string;
  busy: boolean;
  pick: (id: string) => void;
  more: (() => void) | undefined;
  remove: () => Promise<void>;
  focusPrompt: () => void;
  saveScopeVisit: () => void;
}) {
  const navigate = useNavigate();
  const menu = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const entries = conversations.map((c) => {
    const title = c.title || (selected === c.id && firstQuestion) || "未命名对话";
    return {
      id: c.id,
      label: title,
      content: (
        <span className={styles.historyEntry}>
          <span>{title}</span>
          <small>{new Date(c.createdAt).toLocaleString()}</small>
        </span>
      ),
      run: () => pick(c.id),
    };
  });
  const title =
    entries.find((c) => c.id === selected)?.label ??
    (selected === "recent" ? "最近操作" : "会话历史");
  function cancel() {
    setDeleting(false);
    requestAnimationFrame(() => menu.current?.focus({ preventScroll: true }));
  }
  async function erase() {
    setError(false);
    setPending(true);
    try {
      await remove();
      setDeleting(false);
      requestAnimationFrame(focusPrompt);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className={styles.toolbar}>
      {global && (
        <Select
          label="对话范围"
          className={styles.scope}
          value="global"
          disabled={busy}
          entries={[
            { value: "global", label: "全部空间" },
            ...spaces.map((s) => ({ value: s.id, label: s.name })),
          ]}
          onChange={(value) => {
            if (value === "global") return;
            saveScopeVisit();
            void navigate({
              to: "/workspaces/$workspaceId/ai",
              params: { workspaceId: value },
              search: {},
            });
          }}
        />
      )}
      {entries.length > 0 || !global ? (
        <ActionMenu
          label="会话历史"
          popoverClassName={styles.chatMenu}
          trigger={
            <Button
              className={styles.historyButton}
              aria-label={`切换会话 · ${title}`}
              isDisabled={busy}
            >
              <Icon name="history" />
              <span>{title}</span>
              <Icon name="chevron-down" />
            </Button>
          }
          choiceGroup={{
            label: "会话",
            selectedId: selected,
            items: [
              ...entries,
              ...(!global ? [{ id: "recent", label: "最近操作", run: () => pick("recent") }] : []),
            ],
          }}
          items={more ? [{ id: "more", label: "更多会话", run: more }] : []}
        />
      ) : null}
      <Button
        className={styles.newChat}
        aria-label="新对话"
        isDisabled={busy}
        onPress={() => {
          pick("new");
          focusPrompt();
        }}
      >
        <Icon name="plus" />
        <span>新对话</span>
      </Button>
      {selected && selected !== "new" && selected !== "recent" && (
        <ActionMenu
          label="会话操作"
          popoverClassName={styles.chatMenu}
          trigger={
            <Button ref={menu} isIconOnly aria-label="会话操作" isDisabled={busy}>
              <Icon name="ellipsis" />
            </Button>
          }
          items={[
            {
              id: "delete",
              label: "删除会话",
              className: styles.danger,
              run: () => {
                setError(false);
                setDeleting(true);
              },
            },
          ]}
        />
      )}
      {deleting && (
        <Dialog title="删除会话" classes={dialog} busy={pending} onClose={cancel}>
          <p>删除本次对话和材料？已保存的文档版本仍可在历史中查看。</p>
          {error && <Feedback tone="error">删除会话失败，请重试。</Feedback>}
          <div className={dialog.actions}>
            <Button variant="outline" isDisabled={pending} onPress={cancel}>
              取消
            </Button>
            <Button
              variant="primary"
              className={dialog.deleteButton}
              loading={pending}
              onPress={() => void erase()}
            >
              确认删除会话
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
