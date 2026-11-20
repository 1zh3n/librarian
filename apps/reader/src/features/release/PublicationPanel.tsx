import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../../api/client";
import type {
  CreatePublication,
  DocumentSummary,
  Publication,
  PublicationList,
} from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspaceKeys } from "../../api/queries";
import { Button, Form } from "../../ui/primitives";
import { DocumentChecklist } from "../workspace/DocumentChecklist";
import { Choice, Field } from "../workspace/ManagementFields";
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
    mutationFn: () => {
      const input = {
        workspaceId: workspace,
        targetId,
        commitId: commit.trim(),
        documentIds,
        confirm: true,
      } satisfies Omit<CreatePublication, "operationId">;
      const signature = JSON.stringify(input);
      const id = previous.current?.signature === signature ? previous.current.id : operationId();
      previous.current = { signature, id };
      return api.createPublication({ ...input, operationId: id });
    },
    onSuccess: (result) => {
      if (result.status === "published") previous.current = undefined;
      remember(result);
    },
  });
  const confirm = useMutation({
    mutationFn: (id: string) => api.confirmPublication(id),
    onSuccess: remember,
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

  return (
    <section aria-label="Zola 发布" className={styles.section}>
      <h2>Zola 发布</h2>
      {targets.isError && (
        <p role="alert" className={styles.status}>
          无法读取发布目标。
        </p>
      )}
      {targets.data && choices.length === 0 && (
        <p className={styles.status}>此空间尚未配置发布目标。</p>
      )}
      {choices.length > 0 && documents.length > 0 && (
        <Form
          className={styles.form}
          aria-label="选择发布版本"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) publish.mutate();
          }}
        >
          <Choice label="发布目标" value={targetId} entries={choices} onChange={setTargetId} />
          <DocumentChecklist documents={documents} selected={selected} onChange={setSelected} />
          <div className={styles.fields}>
            {revisionChoices.length > 0 && (
              <Choice
                label="文档版本"
                value={commit}
                entries={revisionChoices}
                onChange={setCommit}
              />
            )}
            <Field label="Git 提交 ID" value={commit} onChange={setCommit} required />
          </div>
          {publish.isError && (
            <p role="alert" className={styles.status}>
              无法提交发布，请检查目标、版本与文档。
            </p>
          )}
          <Button className={styles.primary} type="submit" isDisabled={!ready || busy}>
            {publish.isPending ? "正在发布…" : "确认并发布"}
          </Button>
        </Form>
      )}
      {list.isError && !list.data && (
        <p role="alert" className={styles.status}>
          无法读取发布记录。
        </p>
      )}
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
                    <p role="alert">无法确认该发布。</p>
                  )}
                  <Button
                    className={styles.secondary}
                    isDisabled={busy}
                    onPress={() => confirm.mutate(result.id)}
                  >
                    {result.status === "pending" ? "确认发布" : "重试发布"}
                  </Button>
                </>
              )}
              {result.status === "published" && <output>发布已完成</output>}
              {result.status === "failed" && <p role="alert">{result.message || "发布失败。"}</p>}
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
