import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ToggleButton } from "../../ui/primitives";
import { api, ApiError } from "../../api/client";
import type { RestoredDocument } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import styles from "./VersionPanel.module.css";

const dates = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function VersionPanel({
  workspace,
  documentId,
  writable,
  onRestore,
}: {
  workspace: string;
  documentId: string;
  writable: boolean;
  onRestore: (commit: string) => Promise<RestoredDocument>;
}) {
  const client = useQueryClient();
  const historyKey = workspaceKeys.history(workspace, documentId);
  const history = useInfiniteQuery({
    queryKey: historyKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.getDocumentHistory(documentId, pageParam, signal),
    getNextPageParam: (page) => (page.more ? page.revisions.at(-1)?.commitId : undefined),
    refetchInterval: (query) => (query.state.data?.pages[0]?.uncommitted ? 1_500 : false),
  });
  const first = history.data?.pages[0];
  const [selected, select] = useState("");
  const version = useQuery({
    queryKey: workspaceKeys.version(workspace, documentId, selected),
    queryFn: ({ signal }) => api.getVersionDiff(documentId, selected, signal),
    enabled: Boolean(selected),
  });
  const restore = useMutation({
    mutationFn: onRestore,
    onSuccess: async (result) => {
      select(result.commitId);
      await client.invalidateQueries({ queryKey: historyKey, exact: true });
    },
  });

  const disabled = history.error instanceof ApiError && history.error.code === "revisions_disabled";
  const showRestore =
    writable &&
    first?.mode === "managed" &&
    version.data?.markdown != null &&
    version.data.commitId !== restore.data?.commitId;
  return (
    <section className={styles.panel} aria-label="版本历史">
      {history.isPending && <output>正在读取历史…</output>}
      {history.isError && (
        <p role="alert">{disabled ? "此空间未启用版本历史" : "无法读取版本历史"}</p>
      )}
      {first?.uncommitted && <output>当前修改等待归档</output>}
      {first && first.revisions.length === 0 && !first.uncommitted && <p>这篇文档暂无版本</p>}
      <ol className={styles.versions}>
        {history.data?.pages
          .flatMap((page) => page.revisions)
          .map((revision) => (
            <li key={revision.commitId}>
              <ToggleButton
                className={styles.entry}
                isSelected={selected === revision.commitId}
                onChange={(active) => {
                  select(active ? revision.commitId : "");
                  restore.reset();
                }}
              >
                <span className={styles.name}>{revision.message}</span>
                <span className={styles.details}>
                  {dates.format(revision.timestamp)} · {revision.author}
                </span>
              </ToggleButton>
            </li>
          ))}
      </ol>
      {history.hasNextPage && (
        <Button
          className={styles.action}
          isDisabled={history.isFetchingNextPage}
          onPress={() => void history.fetchNextPage()}
        >
          加载更早版本
        </Button>
      )}
      {selected && version.isFetching && !version.data && <output>正在读取差异…</output>}
      {selected && version.isError && <p role="alert">无法读取版本差异</p>}
      {version.data && (
        <pre className={styles.diff} aria-label="版本差异">
          {version.data.diff}
        </pre>
      )}
      {showRestore && (
        <Button
          className={styles.action}
          isDisabled={restore.isPending}
          onPress={() => restore.mutate(selected)}
        >
          {restore.isPending ? "正在恢复…" : "恢复这一版"}
        </Button>
      )}
      {restore.isError && (
        <p role="alert">
          {restore.error instanceof ApiError && restore.error.code === "already_current"
            ? "这一版和当前正文相同"
            : restore.error instanceof ApiError && restore.error.status === 409
              ? "正文已更新。请刷新后重试恢复。"
              : "无法恢复版本，请先保存本地修改。"}
        </p>
      )}
      {restore.isSuccess && <output>已恢复并保存为新版本</output>}
    </section>
  );
}
