import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type {
  CreatePublication,
  DocumentSummary,
  Publication,
  PublicationList,
} from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspaceKeys } from "../../api/queries";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Field, Form, Select } from "../../ui/Forms";
import { DocumentChecklist } from "../workspace/DocumentChecklist";
import styles from "../workspace/Management.module.css";

export function PublicationPanel({
  workspace,
  documents,
}: {
  workspace: string;
  documents: readonly DocumentSummary[];
}) {
  const client = useQueryClient();
  const key = [...workspaceKeys.workspace(workspace), "publications"];
  const targets = useQuery({
    queryKey: [...key, "targets"],
    queryFn: ({ signal }) => api.listPublicationTargets(workspace, signal),
  });
  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.listPublications(workspace, signal),
  });
  const totp = useQuery({
    queryKey: ["totp", "status"],
    queryFn: ({ signal }) => api.getTotpStatus(signal),
  });
  const totpEnabled = totp.data?.enabled ?? false;
  const [stepUpCode, setStepUpCode] = useState("");
  const [stepUpError, setStepUpError] = useState("");
  const [targetId, setTargetId] = useState("");
  const [commit, setCommit] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const previous = useRef<{ signature: string; id: string } | undefined>(undefined);
  const documentIds = selected.filter((id) => documents.some((document) => document.id === id));
  const [primary] = documentIds;
  const versions = useQuery({
    queryKey: [...key, "history", primary],
    queryFn: ({ signal }) => api.getDocumentHistory(primary ?? "", undefined, signal),
    enabled: Boolean(primary),
  });

  function remember(result: Publication) {
    client.setQueryData<PublicationList>(key, (prior) => ({
      publications: [result, ...(prior?.publications ?? []).filter(({ id }) => id !== result.id)],
    }));
    void client.invalidateQueries({ queryKey: key, exact: true });
  }

  const publish = useMutation({
    mutationFn: async () => {
      let stepUpToken: string | undefined;
      if (totpEnabled) {
        stepUpToken = (await api.stepUp(stepUpCode)).token;
      }
      const input = {
        workspaceId: workspace,
        targetId,
        commitId: commit.trim(),
        documentIds,
        confirm: true,
      } satisfies Omit<CreatePublication, "operationId" | "stepUpToken">;
      const signature = JSON.stringify(input);
      const id = previous.current?.signature === signature ? previous.current.id : operationId();
      previous.current = { signature, id };
      return api.createPublication({
        ...input,
        operationId: id,
        ...(stepUpToken ? { stepUpToken } : {}),
      });
    },
    onSuccess: (result) => {
      setStepUpCode("");
      setStepUpError("");
      if (result.status === "published") previous.current = undefined;
      remember(result);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        (error.code === "invalid_totp_code" || error.code === "totp_required")
      ) {
        setStepUpError(error.message);
      }
    },
  });
  const confirm = useMutation({
    mutationFn: async (id: string) => {
      let stepUpToken: string | undefined;
      if (totpEnabled) {
        stepUpToken = (await api.stepUp(stepUpCode)).token;
      }
      return api.confirmPublication(id, stepUpToken);
    },
    onSuccess: (result) => {
      setStepUpCode("");
      setStepUpError("");
      remember(result);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        (error.code === "invalid_totp_code" || error.code === "totp_required")
      ) {
        setStepUpError(error.message);
      }
    },
  });

  const choices = targets.data?.targets.map(({ id, label }) => ({ value: id, label })) ?? [];
  const revisionChoices =
    versions.data?.revisions.map((revision) => ({
      value: revision.commitId,
      label: `${revision.message} · ${revision.commitId.slice(0, 8)}`,
    })) ?? [];
  const busy = publish.isPending || confirm.isPending;
  const ready =
    choices.some((choice) => choice.value === targetId) && commit.trim() && documentIds.length > 0;

  function requireStepUpCode() {
    if (totpEnabled && !stepUpCode.trim()) {
      setStepUpError("请输入验证码或恢复码。");
      return false;
    }
    setStepUpError("");
    return true;
  }

  return (
    <section aria-label="Zola 发布" className={styles.section}>
      <h3>Zola 发布</h3>
      {totpEnabled && (
        <Field
          className={styles.field}
          inputClassName={styles.input}
          label="验证码或恢复码"
          value={stepUpCode}
          onChange={(value) => {
            setStepUpCode(value);
            setStepUpError("");
          }}
          autoComplete="one-time-code"
        />
      )}
      {stepUpError && (
        <Feedback tone="error" className={styles.status}>
          {stepUpError}
        </Feedback>
      )}
      {targets.isPending && <Feedback className={styles.status}>正在读取发布目标…</Feedback>}
      {targets.isError && (
        <Feedback tone="error" className={styles.status}>
          无法读取发布目标。
        </Feedback>
      )}
      {targets.data && choices.length === 0 && (
        <p className={styles.empty}>此空间尚未配置发布目标。</p>
      )}
      {choices.length > 0 && documents.length === 0 && (
        <p className={styles.empty}>添加文档后即可选择发布版本。</p>
      )}
      {choices.length > 0 && documents.length > 0 && (
        <Form
          className={styles.form}
          aria-label="选择发布版本"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy && requireStepUpCode()) publish.mutate();
          }}
        >
          <Select
            className={styles.field}
            label="发布目标"
            value={targetId}
            entries={choices}
            onChange={setTargetId}
          />
          <DocumentChecklist documents={documents} selected={selected} onChange={setSelected} />
          <div className={styles.fields}>
            {revisionChoices.length > 0 && (
              <Select
                className={styles.field}
                label="文档版本"
                value={commit}
                entries={revisionChoices}
                onChange={setCommit}
              />
            )}
            <Field
              className={styles.field}
              inputClassName={styles.input}
              label="Git 提交 ID"
              value={commit}
              onChange={setCommit}
              required
            />
          </div>
          {publish.isError && (
            <Feedback tone="error" className={styles.status}>
              无法提交发布，请检查目标、版本与文档。
            </Feedback>
          )}
          <Button
            variant="primary"
            className={styles.formAction}
            type="submit"
            isDisabled={!ready || busy}
          >
            {publish.isPending ? "正在发布…" : "确认并发布"}
          </Button>
        </Form>
      )}
      {list.isError && !list.data && (
        <Feedback tone="error" className={styles.status}>
          无法读取发布记录。
        </Feedback>
      )}
      {list.data?.publications.length === 0 && <p className={styles.empty}>暂无发布记录。</p>}
      {Boolean(list.data?.publications.length) && (
        <ul aria-label="发布记录" className={styles.records}>
          {list.data?.publications.map((result) => (
            <li className={styles.result} key={result.id}>
              <div>
                {choices.find(({ value }) => value === result.targetId)?.label ?? result.targetId}
              </div>
              <div>
                来源版本 <code>{result.sourceCommitId}</code>
              </div>
              {result.status !== "published" && (
                <>
                  <ul aria-label="待发布文档">
                    {result.documentIds.map((id) => (
                      <li key={id}>
                        {documents.find((document) => document.id === id)?.path ?? id}
                      </li>
                    ))}
                  </ul>
                  {confirm.isError && confirm.variables === result.id && (
                    <Feedback tone="error">无法确认该发布。</Feedback>
                  )}
                  <Button
                    variant="outline"
                    className={styles.formAction}
                    isDisabled={busy}
                    onPress={() => {
                      if (requireStepUpCode()) confirm.mutate(result.id);
                    }}
                  >
                    {confirm.isPending && confirm.variables === result.id
                      ? "正在发布…"
                      : result.status === "pending"
                        ? "确认发布"
                        : "重试发布"}
                  </Button>
                </>
              )}
              {result.status === "published" && <Feedback tone="success">发布已完成</Feedback>}
              {result.status === "failed" && (
                <Feedback tone="error">{result.message || "发布失败。"}</Feedback>
              )}
              {result.publishedCommitId && (
                <div>
                  发布版本 <code>{result.publishedCommitId}</code>
                </div>
              )}
              {result.url && /^https?:\/\//iu.test(result.url) && (
                <a href={result.url} target="_blank" rel="noreferrer">
                  打开发布页面
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
