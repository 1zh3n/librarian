import type {
  AiConnection,
  DiscoveredModel,
  ModelSelection,
  ThinkingSelection,
} from "../../api/client";
import { Select } from "../../ui/Forms";
import { Disclosure } from "../../ui/Disclosure";
import styles from "./ReadingSettings.module.css";

export type ModelChoice = Pick<ModelSelection, "modelId" | "thinking">;
const defaultThinking: ThinkingSelection = { mode: "provider_default" };

const modalityLabels: Record<string, string> = {
  text: "文本",
  image: "图片",
  audio: "音频",
  video: "视频",
};

function modalityText(values: string[] | undefined) {
  return values?.length
    ? values.map((value) => modalityLabels[value] ?? value).join("、")
    : undefined;
}

function compactTokens(value: number | undefined) {
  if (value === undefined) return undefined;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function exactTokens(value: number | undefined) {
  return value?.toLocaleString("zh-CN");
}

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
        <Select
          className={styles.field}
          label="模型"
          value={model.id}
          entries={models.map(({ id, name }) => ({ value: id, label: name || id }))}
          onChange={(modelId) => change({ modelId, thinking: defaultThinking })}
        />
        <Select
          className={styles.field}
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
      <div className={styles.modelSummary}>
        {model.name && <p className={styles.modelId}>{model.id}</p>}
        {(() => {
          const input = modalityText(model.inputModalities);
          const output = modalityText(model.outputModalities);
          const context = compactTokens(model.contextWindow);
          const hasFacts = Boolean(
            input || output || context !== undefined || model.maxOutputTokens !== undefined,
          );
          if (!hasFacts) {
            return <p className={styles.detail}>供应商未提供模型能力信息。</p>;
          }
          const summary = [
            input && `输入 ${input}`,
            output && `输出 ${output}`,
            context && `${context} 上下文`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Disclosure
              title={
                <span className={styles.modelDisclosureTitle}>
                  <span>模型能力</span>
                  <span className={styles.modelDisclosureHint}>{summary}</span>
                </span>
              }
              className={styles.modelDisclosure}
              triggerClassName={styles.modelDisclosureTrigger}
              bodyClassName={styles.modelFactsBody}
            >
              <dl className={styles.modelFacts} aria-label="模型能力">
                {input && (
                  <div>
                    <dt>输入</dt>
                    <dd>{input}</dd>
                  </div>
                )}
                {output && (
                  <div>
                    <dt>输出</dt>
                    <dd>{output}</dd>
                  </div>
                )}
                {model.contextWindow !== undefined && (
                  <div>
                    <dt>上下文窗口</dt>
                    <dd>{exactTokens(model.contextWindow)} tokens</dd>
                  </div>
                )}
                {model.maxOutputTokens !== undefined && (
                  <div>
                    <dt>最大输出</dt>
                    <dd>{exactTokens(model.maxOutputTokens)} tokens</dd>
                  </div>
                )}
              </dl>
            </Disclosure>
          );
        })()}
        {!levels.length && <p className={styles.detail}>供应商未提供思考等级。</p>}
      </div>
    </>
  );
}
