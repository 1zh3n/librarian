import { Feedback } from "../../ui/Feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { activateManagedAi, ApiError, getAiProbe, startAiProbe } from "../../api/client";
import type { AiSettingsView, ManagedActivation, ModelSelection } from "../../api/client";
import { operationId } from "../../api/operationId";
import { Button } from "../../ui/Button";
import type { SettingsWrite } from "./AiSettings";
import { choiceLabel } from "./ModelChoices";
import styles from "./ReadingSettings.module.css";

function waiting(status: string | undefined) {
  return (
    status === "queued" || status === "running" || status === "pending" || status === "claimed"
  );
}

function probeError(code: string | null | undefined) {
  switch (code) {
    case "provider_auth_failed":
    case "authentication":
      return "供应商认证失败，请检查连接密钥。";
    case "provider_rate_limited":
    case "rate_limit":
      return "供应商限流，请稍后再测试。";
    case "runner_offline":
      return "执行器离线，请恢复服务后再测试。";
    case "queue_timeout":
    case "provider_timeout":
    case "timeout":
      return "测试生成超时，请检查执行器与供应商。";
    case "incompatible":
      return "所选模型未返回兼容的生成结果，请检查模型与思考等级。";
    case "unavailable":
      return "供应商暂不可用，请检查地址和服务状态。";
    default:
      return "测试生成失败，请检查连接和模型兼容性后重试。";
  }
}

export function AiManagedControls({
  settings,
  selection,
  write,
  active,
  refreshSettings,
}: {
  settings: AiSettingsView;
  selection: ModelSelection | undefined;
  write: SettingsWrite;
  active: boolean;
  refreshSettings: () => Promise<unknown>;
}) {
  const [activation, setActivation] = useState<ManagedActivation>();
  const client = useQueryClient();
  const start = useMutation({
    mutationFn: (target: ModelSelection) =>
      startAiProbe(target.connectionId, { modelId: target.modelId, thinking: target.thinking }),
    onSuccess: (receipt) => {
      client.setQueryData(["ai-probe", receipt.id], receipt);
      void refreshSettings();
    },
  });
  const receipt = start.data;
  const probe = useQuery({
    queryKey: ["ai-probe", receipt?.id],
    queryFn: ({ signal }) => getAiProbe(receipt!.id, signal),
    enabled: Boolean(active && receipt && waiting(receipt.status)),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      active && !query.state.error && waiting(query.state.data?.status) ? 900 : false,
  });
  const result = probe.data ?? receipt;
  const ready = !!selection && settings.runnerOnline;
  const probeBusy = start.isPending || waiting(result?.status);
  return (
    <div className={styles.fields}>
      <div className={styles.actions}>
        <Button
          className={styles.button}
          isDisabled={!ready || probeBusy}
          onPress={() => selection && start.mutate(selection)}
        >
          测试生成
        </Button>
        {settings.dispatchMode === "legacy" && (
          <Button
            className={styles.button}
            isDisabled={!ready || !!activation}
            onPress={() => {
              if (selection)
                setActivation({
                  activationId: operationId(),
                  expectedSettingsVersion: settings.settingsVersion,
                  selection,
                });
            }}
          >
            启用受管 AI
          </Button>
        )}
      </div>
      {start.isPending && <Feedback>正在提交测试生成…</Feedback>}
      {start.isError && (
        <Feedback tone="error">
          {probeError(start.error instanceof ApiError ? start.error.code : undefined)}
        </Feedback>
      )}
      {probe.isError ? (
        <div className={styles.fields}>
          <Feedback tone="error">无法读取测试结果。</Feedback>
          <Button className={styles.refresh} onPress={() => void probe.refetch()}>
            重新读取测试结果
          </Button>
        </div>
      ) : (
        result &&
        (waiting(result.status) ? (
          <Feedback>{result.status === "queued" ? "测试已排队…" : "正在测试生成…"}</Feedback>
        ) : result.status === "succeeded" ? (
          <Feedback>测试生成成功。</Feedback>
        ) : (
          <Feedback tone="error">{probeError(result.errorCode)}</Feedback>
        ))
      )}
      {activation && settings.dispatchMode === "legacy" && (
        <div className={styles.fields}>
          <p>
            启用后，新任务将使用受管执行器。全局默认将设为「
            {choiceLabel(settings.connections, activation.selection)}」。
          </p>
          <div className={styles.actions}>
            <Button className={styles.button} onPress={() => setActivation(undefined)}>
              取消启用
            </Button>
            <Button
              variant="primary"
              isDisabled={!ready || settings.settingsVersion !== activation.expectedSettingsVersion}
              onPress={() => void write(() => activateManagedAi(activation), "受管 AI 已启用。")}
            >
              确认启用受管 AI
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
