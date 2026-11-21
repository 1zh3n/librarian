import { replaceEqualDeep } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  getAiSettings,
  discoverAiModels,
  createAiConnection,
  updateAiConnection,
  removeAiConnection,
  setAiDefault,
} from "../../api/client";
import type {
  AiDiscovery,
  AiDiscoveryInput,
  AiConnection,
  AiSettingsView,
  ModelSelection,
  UpdateAiConnection,
} from "../../api/client";
import { Button, Form, Input, Label, TextField } from "../../ui/primitives";
import { AiManagedControls } from "./AiManagedControls";
import { ModelChoices, availableChoice } from "./ModelChoices";
import type { ModelChoice } from "./ModelChoices";
import type { SettingsWrite } from "./AiSettings";
import styles from "./ReadingSettings.module.css";

const initialDraft: AiDiscoveryInput = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
};

function validAddress(address: string) {
  try {
    const url = new URL(address);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function discoveryError(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "provider_auth_failed":
        return "供应商认证失败，请检查 API Key。";
      case "provider_address_rejected":
        return "此 API 基础地址不可用，请检查地址和部署允许的主机。";
      case "provider_empty_catalog":
        return "供应商返回的模型目录为空，请检查连接后刷新模型。";
      case "provider_invalid_catalog":
      case "provider_response_too_large":
        return "供应商返回的模型目录无效，请检查 API 基础地址后重试。";
    }
    switch (error.status) {
      case 401:
        return "认证失败，请检查 API Key 和登录状态。";
      case 403:
        return "没有发现模型的权限，请检查账号权限。";
      case 429:
        return "请求过于频繁，请稍后刷新模型。";
      case 504:
        return "获取目录超时，请稍后刷新模型。";
    }
  }
  return "获取模型目录失败，请检查 API 基础地址和密钥后刷新模型。";
}

type Catalog = Pick<AiDiscovery, "fetchedAt" | "models"> & { discoveryId?: string };

export function AiConnectionForm({
  connection: initialConnection,
  initialChoice,
  settings,
  write,
  active,
  saved,
  refreshSettings,
  applySnapshot,
}: {
  connection: AiConnection | undefined;
  initialChoice: ModelChoice | undefined;
  settings: AiSettingsView;
  write: SettingsWrite;
  active: boolean;
  saved: (id?: string, choice?: ModelChoice) => void;
  refreshSettings: () => Promise<unknown>;
  applySnapshot: (view: AiSettingsView) => void;
}) {
  const [connection, setConnection] = useState(initialConnection);
  const checkedOnOpen = useRef(false);
  const [label, setLabel] = useState(connection?.label ?? "DeepSeek");
  const [draft, setDraft] = useState({
    ...initialDraft,
    baseUrl: connection?.baseUrl ?? initialDraft.baseUrl,
  });
  const [refresh, setRefresh] = useState(0);
  const [composing, setComposing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"remove" | "clear">();
  const [catalog, setCatalog] = useState<Catalog | undefined>(connection);
  const [selected, setSelected] = useState<ModelChoice | null>(
    initialChoice ??
      (settings.defaultSelection?.connectionId === connection?.id
        ? settings.defaultSelection
        : null),
  );
  const request = useRef<AbortController>(null);
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const sameEndpoint = !!connection && baseUrl === connection.baseUrl;
  const stored = !!(
    sameEndpoint &&
    connection.hasApiKey &&
    connection.credentialAvailable !== false &&
    !apiKey
  );
  const addressValid = validAddress(baseUrl);
  const ready = addressValid && !composing && Boolean(apiKey || stored);
  const choice = catalog && availableChoice(catalog.models, selected);
  const fallback =
    !!selected &&
    !!choice &&
    (selected.modelId !== choice.modelId || selected.thinking.mode !== choice.thinking.mode);
  const keyChanged = !!apiKey || !sameEndpoint;
  const edited = keyChanged || label.trim() !== connection?.label || !!catalog?.discoveryId;
  const canSave = Boolean(
    label.trim() && edited && (!keyChanged || catalog?.discoveryId) && !pending && !composing,
  );
  const savedSelection: ModelSelection | undefined =
    connection && choice && !keyChanged && !catalog?.discoveryId
      ? { connectionId: connection.id, ...choice }
      : undefined;
  const fetchedAt = connection?.fetchedAt;
  const id = connection?.id;

  function change(field: "apiKey" | "baseUrl", value: string) {
    request.current?.abort();
    checkedOnOpen.current = false;
    const next = { ...draft, [field]: value };
    setDraft(next);
    setCatalog(
      !next.apiKey.trim() && next.baseUrl.trim() === connection?.baseUrl ? connection : undefined,
    );
    setSelected(null);
    setRefresh(0);
    setPending(false);
    setError("");
    setConfirm(undefined);
  }

  useEffect(() => {
    if (!active) {
      checkedOnOpen.current = false;
      return;
    }
    if (
      !ready ||
      (stored &&
        !refresh &&
        (checkedOnOpen.current ||
          (fetchedAt !== undefined && Date.now() / 1000 - fetchedAt <= 900)))
    )
      return;
    const ctrl = new AbortController();
    request.current = ctrl;
    const fetchCatalog = async () => {
      if (stored) checkedOnOpen.current = true;
      setPending(true);
      setError("");
      try {
        const result = await discoverAiModels(
          stored && id ? { connectionId: id } : { provider: "deepseek", baseUrl, apiKey },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        if (!result.models.length) {
          setError("供应商返回的模型目录为空，请检查连接后刷新模型。");
          setCatalog(stored ? connection : undefined);
        } else if (stored && connection) {
          const view = await getAiSettings(ctrl.signal);
          if (ctrl.signal.aborted) return;
          const current = view.connections.find((item) => item.id === connection.id);
          if (
            current &&
            current.baseUrl === connection.baseUrl &&
            current.fetchedAt === result.fetchedAt &&
            replaceEqualDeep(current.models, result.models) === current.models
          ) {
            setConnection(current);
            setCatalog(current);
            setRefresh(0);
          } else {
            setCatalog(result);
          }
          applySnapshot(view);
        } else setCatalog(result);
      } catch (cause) {
        if (!ctrl.signal.aborted) {
          setCatalog(stored ? connection : undefined);
          setError(discoveryError(cause));
        }
      } finally {
        if (!ctrl.signal.aborted) setPending(false);
      }
    };
    const timer = window.setTimeout(() => void fetchCatalog(), refresh || stored ? 0 : 450);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [ready, active, stored, refresh, fetchedAt, id, baseUrl, apiKey, connection, applySnapshot]);

  function persist() {
    if (!canSave) return;
    const discoveryId = catalog?.discoveryId;
    let createdId: string | undefined;
    void write(
      async () => {
        if (connection) {
          const input: UpdateAiConnection = {
            expectedVersion: connection.version,
            label: label.trim(),
            keyChange: apiKey ? { kind: "replace", apiKey } : { kind: "keep" },
          };
          if (!sameEndpoint) input.baseUrl = baseUrl;
          if (discoveryId) input.discoveryId = discoveryId;
          await updateAiConnection(connection.id, input);
        } else if (discoveryId) {
          const result = await createAiConnection({
            provider: "deepseek",
            label: label.trim(),
            baseUrl,
            keyChange: { kind: "replace", apiKey },
            discoveryId,
          });
          createdId = result?.id;
        }
      },
      "连接已保存。",
      (view) =>
        saved(
          connection?.id ??
            createdId ??
            view.connections.find(
              (item) =>
                item.label === label.trim() &&
                !settings.connections.some((previous) => previous.id === item.id),
            )?.id,
          choice,
        ),
    );
  }

  const composition = {
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: () => setComposing(false),
  };
  return (
    <>
      <Form
        className={styles.fields}
        aria-label="DeepSeek 连接"
        onSubmit={(event) => {
          event.preventDefault();
          persist();
        }}
      >
        <h3>DeepSeek 连接</h3>
        <TextField className={styles.field} value={label} onChange={setLabel}>
          <Label>连接名称</Label>
          <Input className={styles.input} />
        </TextField>
        <TextField
          className={styles.field}
          type="url"
          value={draft.baseUrl}
          onChange={(v) => change("baseUrl", v)}
        >
          <Label>API 基础地址</Label>
          <Input
            className={styles.input}
            autoCapitalize="none"
            spellCheck={false}
            {...composition}
          />
        </TextField>
        {draft.baseUrl && !addressValid && !composing && (
          <p role="alert">请输入完整的 API 基础地址，不含凭证、查询参数或片段。</p>
        )}
        <TextField
          className={styles.field}
          type="password"
          value={draft.apiKey}
          onChange={(v) => change("apiKey", v)}
          autoComplete="off"
        >
          <Label>API Key</Label>
          <Input
            className={styles.input}
            autoCapitalize="none"
            spellCheck={false}
            {...composition}
          />
        </TextField>
        {connection && !apiKey && (
          <p className={styles.detail}>
            {!sameEndpoint
              ? "地址已更改，请重新输入密钥。"
              : connection.credentialAvailable === false
                ? "密钥不可用，请重新输入。"
                : connection.hasApiKey
                  ? "已配置密钥"
                  : "尚未配置密钥"}
          </p>
        )}
        <Button
          className={styles.refresh}
          isDisabled={!ready}
          aria-busy={pending}
          aria-disabled={!ready || pending}
          onPress={() => {
            if (!pending) setRefresh((n) => n + 1);
          }}
        >
          刷新模型
        </Button>
        {pending && <output>正在获取模型目录…</output>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {catalog && choice && (
          <>
            <ModelChoices models={catalog.models} choice={choice} change={setSelected} />
            {fallback && <output>原选择已从目录移除，当前使用所示模型和供应商默认等级。</output>}
            <p className={styles.detail}>
              目录获取时间 · {new Date(catalog.fetchedAt * 1000).toLocaleString("zh-CN")}
            </p>
          </>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" isDisabled={!canSave}>
            保存连接
          </Button>
        </div>
      </Form>
      {connection && (
        <>
          <div className={styles.actions}>
            <Button
              className={styles.button}
              isDisabled={edited || (!connection.enabled && !stored)}
              onPress={() =>
                void write(
                  () =>
                    updateAiConnection(connection.id, {
                      expectedVersion: connection.version,
                      enabled: !connection.enabled,
                    }),
                  "连接状态已更新。",
                  () => saved(connection.id, choice),
                )
              }
            >
              {connection.enabled ? "停用连接" : "启用连接"}
            </Button>
            {settings.dispatchMode === "managed" && (
              <Button
                className={styles.button}
                isDisabled={!savedSelection || !connection.enabled || !stored}
                onPress={() =>
                  savedSelection &&
                  void write(() => setAiDefault(savedSelection), "全局默认已保存。")
                }
              >
                设为全局默认
              </Button>
            )}
            {connection.hasApiKey && (
              <Button className={styles.button} onPress={() => setConfirm("clear")}>
                清除密钥
              </Button>
            )}
            <Button className={styles.button} onPress={() => setConfirm("remove")}>
              移除连接
            </Button>
          </div>
          <AiManagedControls
            key={JSON.stringify(savedSelection)}
            settings={settings}
            selection={stored ? savedSelection : undefined}
            write={write}
            active={active}
            refreshSettings={refreshSettings}
          />
          {confirm && (
            <div className={styles.fields}>
              <p>
                {confirm === "remove" ? "移除连接" : "清除密钥"}「{connection.label}
                」？使用此连接的任务将无法继续。
              </p>
              <div className={styles.actions}>
                <Button className={styles.button} onPress={() => setConfirm(undefined)}>
                  取消
                </Button>
                <Button
                  className={styles.button}
                  onPress={() =>
                    void write(
                      () =>
                        confirm === "remove"
                          ? removeAiConnection(connection.id, connection.version)
                          : updateAiConnection(connection.id, {
                              expectedVersion: connection.version,
                              keyChange: { kind: "clear" },
                            }),
                      confirm === "remove" ? "连接已移除。" : "密钥已清除。",
                      () => saved(confirm === "remove" ? undefined : connection.id),
                    )
                  }
                >
                  确认{confirm === "remove" ? "移除" : "清除"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
