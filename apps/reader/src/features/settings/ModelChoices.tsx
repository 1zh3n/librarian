import type {
  AiConnection,
  DiscoveredModel,
  ModelSelection,
  ThinkingSelection,
} from "../../api/client";
import { Choice } from "../workspace/ManagementFields";
import styles from "./ReadingSettings.module.css";

export type ModelChoice = Pick<ModelSelection, "modelId" | "thinking">;
const defaultThinking: ThinkingSelection = { mode: "provider_default" };

export function availableChoice(
  models: DiscoveredModel[],
  prior?: ModelChoice | null,
): ModelChoice | undefined {
  const model = models.find(({ id }) => id === prior?.modelId) ?? models[0];
  if (!model) return;
  const levels = model.effort?.supportedLevels ?? [];
  const thinking = prior?.modelId === model.id ? prior.thinking : defaultThinking;
  const supported =
    levels.length > 0 && (thinking.mode !== "effort" || levels.includes(thinking.level));
  return { modelId: model.id, thinking: supported ? thinking : defaultThinking };
}

export function choiceLabel(connections: AiConnection[], selection: ModelSelection) {
  const connection = connections.find(({ id }) => id === selection.connectionId);
  const model = connection?.models.find(({ id }) => id === selection.modelId);
  const { thinking } = selection;
  return [
    connection?.label,
    model?.name || selection.modelId,
    thinking.mode === "effort"
      ? thinking.level
      : thinking.mode === "off"
        ? "关闭思考"
        : "供应商默认",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ModelChoices({
  models,
  choice,
  change,
}: {
  models: DiscoveredModel[];
  choice: ModelChoice;
  change: (choice: ModelChoice) => void;
}) {
  const model = models.find(({ id }) => id === choice.modelId);
  if (!model) return null;
  const levels = model.effort?.supportedLevels ?? [];
  const thinking = choice.thinking;
  return (
    <>
      <div className={styles.catalog}>
        <Choice
          label="模型"
          value={model.id}
          entries={models.map(({ id, name }) => ({ value: id, label: name || id }))}
          onChange={(modelId) => change({ modelId, thinking: defaultThinking })}
        />
        <Choice
          label="思考等级"
          value={thinking.mode === "effort" ? "effort:" + thinking.level : thinking.mode}
          entries={[
            {
              value: "provider_default",
              label:
                levels.length && model.effort?.defaultLevel
                  ? `供应商默认（${model.effort.defaultLevel}）`
                  : "供应商默认",
            },
            ...(levels.length ? [{ value: "off", label: "关闭思考" }] : []),
            ...levels.map((level) => ({ value: "effort:" + level, label: level })),
          ]}
          onChange={(value) =>
            change({
              modelId: model.id,
              thinking:
                value === "provider_default" || value === "off"
                  ? { mode: value }
                  : { mode: "effort", level: value.slice("effort:".length) },
            })
          }
        />
      </div>
      <div className={styles.detail}>
        {model.name && <p>{model.id}</p>}
        {!!model.inputModalities?.length && <p>输入 · {model.inputModalities.join("、")}</p>}
        {!!model.outputModalities?.length && <p>输出 · {model.outputModalities.join("、")}</p>}
        {model.contextWindow != null && (
          <p>上下文窗口 · {model.contextWindow.toLocaleString()} tokens</p>
        )}
        {model.maxOutputTokens != null && (
          <p>最大输出 · {model.maxOutputTokens.toLocaleString()} tokens</p>
        )}
        {!levels.length && <p>供应商未提供思考等级。</p>}
      </div>
    </>
  );
}
