import { Feedback } from "../../ui/Feedback";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ApiError, getAiSettings, setAiGlobalEnabled, setAiPreference } from "../../api/client";
import type { AiSettingsView, ModelSelection } from "../../api/client";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Forms";
import { AiConnectionForm } from "./AiConnectionForm";
import { ModelChoices, availableChoice, choiceLabel } from "./ModelChoices";
import styles from "./ReadingSettings.module.css";

export type SettingsWrite = (
  action: () => Promise<unknown>,
  message: string,
  after?: (view: AiSettingsView) => void,
) => Promise<void>;

function writeError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "runner_offline") return "受管执行器离线，请刷新服务状态后重试。";
    if (error.status === 409)
      return "配置版本或发现票据已失效。请刷新模型，或重新读取设置后再提交。";
    if (error.status === 401 || error.status === 403)
      return "当前账号无权执行此操作，请检查登录状态与权限。";
    if (error.status === 422) return "无法应用这项设置，请检查模型、思考等级和连接状态。";
  }
  return "无法确认操作结果，请重新读取设置后重试。";
}

function PreferenceForm({ view, write }: { view: AiSettingsView; write: SettingsWrite }) {
  const [draft, setDraft] = useState<ModelSelection | null>(view.preference);
  const choices = view.connections.filter(
    (item) => item.enabled && item.credentialAvailable !== false && item.models.length > 0,
  );
  const current = choices.find((item) => item.id === draft?.connectionId);
  const choice = current && availableChoice(current.models, draft);
  const selection = current && choice ? { connectionId: current.id, ...choice } : null;
  return (
    <section aria-label="我的模型" className={styles.section}>
      <h3>我的模型</h3>
      {view.effectiveSelection && (
        <p className={styles.detail}>
          当前模型 · {choiceLabel(view.connections, view.effectiveSelection)}
        </p>
      )}
      {view.fallbackReason && (
        <Feedback>
          {view.effectiveSelection
            ? "所选模型或思考等级不可用，当前使用上方显示的选择。"
            : "当前没有可用的模型选择。"}
        </Feedback>
      )}
      {choices.length || view.preference ? (
        <>
          <Select
            className={styles.field}
            label="模型连接"
            value={current?.id ?? "global"}
            entries={[
              { value: "global", label: "跟随全局默认" },
              ...choices.map((item) => ({ value: item.id, label: item.label })),
            ]}
            onChange={(id) => {
              const item = choices.find((entry) => entry.id === id);
              const choice = item && availableChoice(item.models);
              setDraft(item && choice ? { connectionId: id, ...choice } : null);
            }}
          />
          {current && choice && (
            <ModelChoices
              models={current.models}
              choice={choice}
              change={(next) => setDraft({ connectionId: current.id, ...next })}
            />
          )}
          <div className={styles.actions}>
            <Button
              className={styles.button}
              isDisabled={JSON.stringify(selection) === JSON.stringify(view.preference)}
              onPress={() => void write(() => setAiPreference(selection), "模型偏好已保存。")}
            >
              保存偏好
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.detail}>尚无已启用的模型连接。</p>
      )}
    </section>
  );
}

export function AiSettings({
  isAdmin,
  username,
  active,
  busy,
  setBusy,
}: {
  isAdmin: boolean;
  username: string;
  active: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const client = useQueryClient();
  const applySnapshot = useCallback(
    (view: AiSettingsView) => {
      client.setQueryData(["ai", "settings", username], view);
    },
    [client, username],
  );
  const query = useQuery({
    queryKey: ["ai", "settings", username],
    staleTime: 0,
    queryFn: ({ signal }) => getAiSettings(signal),
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const [savedSelection, setSavedSelection] = useState<ModelSelection>();
  const [editing, setEditing] = useState<string>();
  const [epoch, setEpoch] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  // A successful write can replace or disable the focused control.
  useLayoutEffect(() => {
    if (active && !busy && document.activeElement === document.body) {
      feedback.current?.focus({ preventScroll: true });
    }
  }, [active, busy, message, error, query.isError]);

  const write: SettingsWrite = async (action, notice, after) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await action();
      const { data } = await query.refetch({ throwOnError: true });
      if (data) after?.(data);
      setMessage(notice);
    } catch (cause) {
      setError(writeError(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  async function reload() {
    const { isSuccess } = await query.refetch();
    if (isSuccess) {
      setEpoch((n) => n + 1);
      setError("");
      setMessage("");
    }
  }

  const view = query.data;
  if (query.isError)
    return (
      <div className={styles.fields}>
        <Feedback tone="error" ref={feedback} tabIndex={-1}>
          无法读取 AI 设置。
        </Feedback>
        <Button className={styles.refresh} onPress={() => void reload()}>
          重新读取设置
        </Button>
      </div>
    );
  if (!view) return <Feedback>正在读取 AI 设置…</Feedback>;
  const connection =
    view.connections.find((item) => item.id === editing) ??
    (editing === "new"
      ? undefined
      : (view.connections.find((item) => item.id === view.defaultSelection?.connectionId) ??
        view.connections[0]));
  return (
    <>
      <p className={styles.detail}>
        {view.globalEnabled ? "全局 AI 已开启" : "全局 AI 已暂停"} ·{" "}
        {view.dispatchMode === "legacy" ? "现有执行器" : "受管执行器"}
      </p>
      <fieldset className={styles.controls} disabled={busy} aria-busy={busy}>
        {isAdmin && (
          <section aria-label="管理连接" className={styles.section}>
            {view.connections.length > 0 && (
              <Select
                className={styles.field}
                label="管理连接"
                value={connection?.id ?? "new"}
                entries={[
                  ...view.connections.map((item) => ({ value: item.id, label: item.label })),
                  { value: "new", label: "新增连接" },
                ]}
                onChange={(id) => {
                  setEditing(id);
                  setSavedSelection(undefined);
                  setError("");
                  setMessage("");
                }}
              />
            )}
            <AiConnectionForm
              key={JSON.stringify([connection?.id, epoch])}
              connection={connection}
              initialChoice={
                connection && savedSelection?.connectionId === connection.id
                  ? savedSelection
                  : undefined
              }
              settings={view}
              active={active}
              saved={(id, choice) => {
                setSavedSelection(id && choice ? { connectionId: id, ...choice } : undefined);
                setEditing(id);
                setEpoch((n) => n + 1);
              }}
              write={write}
              refreshSettings={() => query.refetch()}
              applySnapshot={applySnapshot}
            />
          </section>
        )}
        <PreferenceForm key={JSON.stringify([view.preference, epoch])} view={view} write={write} />
        {isAdmin ? (
          <section aria-label="全局 AI" className={styles.section}>
            <h3>全局 AI</h3>
            <p className={styles.detail}>受管执行器{view.runnerOnline ? "在线" : "离线"}</p>
            <Button
              className={styles.refresh}
              isDisabled={query.isFetching}
              onPress={() => void query.refetch()}
            >
              刷新服务状态
            </Button>
            {view.defaultSelection && (
              <p className={styles.detail}>
                全局默认 · {choiceLabel(view.connections, view.defaultSelection)}
              </p>
            )}
            <Button
              className={styles.refresh}
              onPress={() =>
                void write(() => setAiGlobalEnabled(!view.globalEnabled), "全局 AI 状态已更新。")
              }
            >
              {view.globalEnabled ? "暂停全局 AI" : "恢复全局 AI"}
            </Button>
          </section>
        ) : (
          <p className={styles.detail}>模型连接由服务器管理员配置。</p>
        )}
      </fieldset>
      {message && (
        <Feedback tone="success" ref={feedback} tabIndex={-1}>
          {message}
        </Feedback>
      )}
      {error && (
        <div className={styles.fields}>
          <Feedback tone="error" ref={feedback} tabIndex={-1}>
            {error}
          </Feedback>
          <Button className={styles.refresh} onPress={() => void reload()}>
            重新读取设置
          </Button>
        </div>
      )}
    </>
  );
}
