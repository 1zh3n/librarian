import { useEffect, useRef, useState } from "react";
import { ApiError, discoverAiModels } from "../../api/client";
import type { AiDiscovery, AiDiscoveryInput, DiscoveredModel } from "../../api/client";
import { Button, Form, Input, Label, TextField } from "../../ui/primitives";
import { Choice } from "../workspace/ManagementFields";
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

const providerDefault = "provider_default";

function effortChoices(model: DiscoveredModel) {
  const levels = model.effort?.supportedLevels ?? [];
  const defaultLevel = levels.length && model.effort?.defaultLevel;
  return [
    {
      value: providerDefault,
      label: defaultLevel ? `供应商默认（${defaultLevel}）` : "供应商默认",
    },
    ...(levels.length ? [{ value: "off", label: "关闭思考" }] : []),
    ...levels.map((level) => ({ value: `effort:${level}`, label: level })),
  ];
}

type Catalog = {
  discovery: AiDiscovery;
  model: DiscoveredModel;
  thinking: string;
};

export function AiSettings() {
  const [draft, setDraft] = useState(initialDraft);
  const [refresh, setRefresh] = useState(0);
  const [composing, setComposing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<Catalog>();
  const request = useRef<AbortController>(null);
  const addressValid = validAddress(draft.baseUrl.trim());
  const ready = Boolean(addressValid && draft.apiKey.trim() && !composing);

  function change(field: "baseUrl" | "apiKey", value: string) {
    request.current?.abort();
    setCatalog(undefined);
    setPending(false);
    setError("");
    setRefresh(0);
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    request.current = controller;
    const fetchCatalog = async () => {
      setPending(true);
      setError("");
      try {
        const discovery = await discoverAiModels(
          { ...draft, baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim() },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const first = discovery.models[0];
        if (!first) {
          setError("供应商返回的模型目录为空，请检查连接后刷新模型。");
          setCatalog(undefined);
          return;
        }
        setCatalog((previous) => {
          const model = discovery.models.find(({ id }) => id === previous?.model.id) ?? first;
          const thinking =
            previous &&
            previous.model.id === model.id &&
            effortChoices(model).some(({ value }) => value === previous.thinking)
              ? previous.thinking
              : providerDefault;
          return { discovery, model, thinking };
        });
      } catch (cause) {
        if (!controller.signal.aborted) setError(discoveryError(cause));
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    };
    const timer = window.setTimeout(() => void fetchCatalog(), refresh ? 0 : 450);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft, ready, refresh]);

  return (
    <Form
      aria-label="DeepSeek 连接"
      className={styles.fields}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !pending) setRefresh((count) => count + 1);
      }}
    >
      <h3>DeepSeek 连接</h3>
      <TextField
        className={styles.field}
        type="url"
        value={draft.baseUrl}
        onChange={(value) => change("baseUrl", value)}
      >
        <Label>API 基础地址</Label>
        <Input
          className={styles.input}
          autoCapitalize="none"
          spellCheck={false}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      </TextField>
      {draft.baseUrl && !addressValid && !composing && (
        <p role="alert" className={styles.detail}>
          请输入完整的 API 基础地址，不含凭证、查询参数或片段。
        </p>
      )}
      <TextField
        className={styles.field}
        type="password"
        value={draft.apiKey}
        onChange={(value) => change("apiKey", value)}
        autoComplete="off"
      >
        <Label>API Key</Label>
        <Input
          className={styles.input}
          autoCapitalize="none"
          spellCheck={false}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      </TextField>
      <Button className={styles.refresh} type="submit" isDisabled={!ready || pending}>
        刷新模型
      </Button>
      {pending && <output className={styles.detail}>正在获取模型目录…</output>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {catalog && (
        <>
          <div className={styles.catalog}>
            <Choice
              label="模型"
              value={catalog.model.id}
              entries={catalog.discovery.models.map((model) => ({
                value: model.id,
                label: model.name || model.id,
              }))}
              onChange={(id) => {
                const model = catalog.discovery.models.find((item) => item.id === id);
                if (model) setCatalog({ ...catalog, model, thinking: providerDefault });
              }}
            />
            <Choice
              label="思考等级"
              entries={effortChoices(catalog.model)}
              value={catalog.thinking}
              onChange={(thinking) => setCatalog({ ...catalog, thinking })}
            />
          </div>
          <div className={styles.detail}>
            {catalog.model.name && <p>{catalog.model.id}</p>}
            {!!catalog.model.inputModalities?.length && (
              <p>输入 · {catalog.model.inputModalities.join("、")}</p>
            )}
            {!!catalog.model.outputModalities?.length && (
              <p>输出 · {catalog.model.outputModalities.join("、")}</p>
            )}
            {!catalog.model.effort?.supportedLevels.length && <p>供应商未提供思考等级。</p>}
            <p>
              目录获取时间 · {new Date(catalog.discovery.fetchedAt * 1000).toLocaleString("zh-CN")}
            </p>
          </div>
        </>
      )}
    </Form>
  );
}
