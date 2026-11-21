import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { DeliveryManifest, DeliveryReceipt, DocumentSummary } from "../../api/client";
import { operationId } from "../../api/operationId";
import { documentsQuery, sessionQuery, workspaceKeys } from "../../api/queries";
import { Disclosure } from "../../ui/Disclosure";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { FilePicker } from "../../ui/FilePicker";
import { Field, Form } from "../../ui/Forms";
import styles from "../workspace/Management.module.css";
import { deliveryHistory } from "./deliveryHistory";

const bytesPerMebibyte = 1024 * 1024;
const markdown = /\.md$/iu;
const zip = /\.zip$/iu;

type PendingImport = { manifest: DeliveryManifest; previousOperationId: string | null };
type Upload = { manifest: DeliveryManifest; files: File[] };

function validationMessage(files: readonly File[]) {
  if (files.some((file) => file.size === 0)) return "所选内容包含空文件。";
  if (files.length === 1 && zip.test(files[0]?.name ?? "")) {
    return (files[0]?.size ?? 0) > 18 * bytesPerMebibyte ? "导入文件超过大小限制。" : undefined;
  }
  if (files.some((file) => !markdown.test(file.name))) return "请选择 Markdown 文件或一个 ZIP。";
  const bytes = files.reduce((total, file) => total + file.size, 0);
  if (
    files.length > 64 ||
    bytes > 24 * bytesPerMebibyte ||
    files.some((file) => file.size > 4 * bytesPerMebibyte)
  ) {
    return "导入文件超过大小限制。";
  }
}

function uploadError(error: Error) {
  if (error instanceof ApiError) {
    if (error.status === 409) return "导入路径或文件版本发生冲突，原件已保留。";
    if (error.status === 413) return "导入文件超过大小限制。";
    if (error.status === 422) return "无法导入，请检查 Markdown 编码和 ZIP 内容。";
    if (error.status === 401 || error.status === 403) return "当前账号无法写入此空间。";
  }
  return "未收到导入结果。可以重试同一批文件，或在导入记录中核对结果。";
}

function toBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error));
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      } else {
        reject(new Error("Unable to read file"));
      }
    });
    reader.readAsDataURL(file);
  });
}

function pendingInSession(key: string | undefined): PendingImport | undefined {
  if (!key) return;
  try {
    return (
      (JSON.parse(window.sessionStorage.getItem(key) ?? "null") as PendingImport | null) ??
      undefined
    );
  } catch {
    return;
  }
}

function storePending(key: string | undefined, pending?: PendingImport) {
  if (!key) return;
  try {
    if (pending) window.sessionStorage.setItem(key, JSON.stringify(pending));
    else window.sessionStorage.removeItem(key);
  } catch {
    // A browser with storage disabled can still retry the current selection.
  }
}

function recoveredNewImport(pending: PendingImport | undefined, records: DeliveryReceipt[]) {
  // Updates share their manifest metadata with other writers. Only new imports have a fresh ID.
  if (pending?.previousOperationId !== null) return;
  const { manifest } = pending;
  return records
    .filter(
      (receipt) =>
        receipt.deliveryId === manifest.deliveryId &&
        receipt.manifest.sourceName === manifest.sourceName &&
        (receipt.manifest.version ?? "") === (manifest.version ?? "") &&
        (receipt.manifest.generatedAt ?? "") === (manifest.generatedAt ?? ""),
    )
    .at(-1);
}

function receiptSummary({ changes }: DeliveryReceipt) {
  const added = changes.filter((change) => change.beforeRevision === null).length;
  const removed = changes.filter((change) => change.revision === null).length;
  const updated = changes.length - added - removed;
  if (changes.length === 0) return "文件内容无变化";
  return [`新增 ${added}`, `更新 ${updated}`, ...(removed ? [`移除 ${removed}`] : [])].join(" · ");
}

function receiptChanges(
  workspace: string,
  receipt: DeliveryReceipt,
  documents: Map<string, DocumentSummary>,
) {
  if (!receipt.changes.length) return null;
  return (
    <ul aria-label="文件变更">
      {receipt.changes.map(({ path, beforeRevision, revision }) => {
        const document = revision && documents.get(path);
        const name = path.startsWith(`deliveries/${receipt.deliveryId}/`)
          ? path.slice(`deliveries/${receipt.deliveryId}/`.length)
          : path;
        return (
          <li key={path}>
            {revision === null ? "移除" : beforeRevision === null ? "新增" : "更新"}{" "}
            {document ? (
              <Link
                to="/workspaces/$workspaceId/documents/$documentId"
                params={{ workspaceId: workspace, documentId: document.id }}
              >
                {name}
              </Link>
            ) : (
              name
            )}
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceDelivery({
  workspace,
  writable,
  storageKey,
}: {
  workspace: string;
  writable: boolean;
  storageKey?: string | undefined;
}) {
  const client = useQueryClient();
  const query = deliveryHistory(workspace);
  const history = useQuery(query);
  const documents = useQuery(documentsQuery(workspace));
  const byPath = new Map(documents.data?.map((document) => [document.path, document]));
  const recent = history.data ?? [];
  const [pending, setPending] = useState(() =>
    writable ? pendingInSession(storageKey) : undefined,
  );
  const [source, setSource] = useState<DeliveryReceipt>();
  const [sourceName, setSourceName] = useState("");
  const [version, setVersion] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const invalid = validationMessage(files);

  function remember(next?: PendingImport) {
    setPending(next);
    storePending(storageKey, next);
  }

  const upload = useMutation({
    async mutationFn({ manifest, files }: Upload) {
      const archive = files[0];
      if (archive && zip.test(archive.name)) {
        return api.createDelivery(workspace, { manifest, archiveBase64: await toBase64(archive) });
      }
      return api.createDelivery(workspace, {
        manifest,
        files: await Promise.all(
          files.map(async (file) => ({ path: file.name, contentBase64: await toBase64(file) })),
        ),
      });
    },
    onSuccess: async (receipt) => {
      setFiles([]);
      setSource(undefined);
      remember();
      client.setQueryData<DeliveryReceipt[]>(query.queryKey, (records) => [
        receipt,
        ...(records ?? []).filter((record) => record.operationId !== receipt.operationId),
      ]);
      await client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
    },
  });
  const recovered = upload.isIdle ? recoveredNewImport(pending, recent) : undefined;
  const completed = upload.data ?? recovered;
  const resumed = pending && !recovered && !upload.isError ? pending : undefined;
  const lookingUpReceipt = resumed?.previousOperationId === null;
  const latest = new Map<string, string>();
  for (const record of recent) {
    if (!latest.has(record.deliveryId)) latest.set(record.deliveryId, record.operationId);
  }
  const ready =
    files.length > 0 &&
    !invalid &&
    (!source || sourceName.trim()) &&
    (!lookingUpReceipt || history.isSuccess);

  function cancel() {
    upload.reset();
    setFiles([]);
    setSource(undefined);
    remember();
  }

  function editSource(receipt: DeliveryReceipt) {
    cancel();
    setSource(receipt);
    setSourceName(receipt.manifest.sourceName);
    setVersion(receipt.manifest.version ?? "");
    const generated = receipt.manifest.generatedAt
      ? new Date(receipt.manifest.generatedAt)
      : undefined;
    setGeneratedAt(
      generated && Number.isFinite(generated.getTime())
        ? new Date(generated.getTime() - generated.getTimezoneOffset() * 60_000)
            .toISOString()
            .slice(0, 16)
        : "",
    );
  }

  return (
    <section className={styles.section} aria-label="导入文件">
      <h3>导入文件</h3>
      {writable && (
        <Form
          className={styles.form}
          aria-label="导入文件"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || upload.isPending) return;
            if (upload.isError && upload.variables) {
              upload.mutate(upload.variables);
              return;
            }
            const manifest = resumed?.manifest ?? {
              deliveryId: source?.deliveryId ?? `manual-${crypto.randomUUID?.() ?? operationId()}`,
              sourceName: source ? sourceName.trim() : "手动导入",
              ...(source && version.trim() && { version: version.trim() }),
              ...(source && generatedAt && { generatedAt: new Date(generatedAt).toISOString() }),
            };
            remember({
              manifest,
              previousOperationId: resumed?.previousOperationId ?? source?.operationId ?? null,
            });
            upload.mutate({ manifest, files });
          }}
        >
          {source && (
            <>
              <p className={styles.status}>
                更新来源 <code>{source.deliveryId}</code>
                。请选择该来源的完整文件，未包含的原有文件会移除。
              </p>
              <div className={styles.fields}>
                <Field
                  className={styles.field}
                  inputClassName={styles.input}
                  label="来源名称"
                  value={sourceName}
                  onChange={setSourceName}
                  required
                />
                <Field
                  className={styles.field}
                  inputClassName={styles.input}
                  label="版本（可选）"
                  value={version}
                  onChange={setVersion}
                />
                <Field
                  className={styles.field}
                  inputClassName={styles.input}
                  label="生成时间（可选）"
                  type="datetime-local"
                  value={generatedAt}
                  onChange={setGeneratedAt}
                />
              </div>
            </>
          )}
          {resumed && !upload.isPending && (
            <Feedback className={styles.status}>
              {!lookingUpReceipt
                ? "无法从记录确认此次更新。请重新选择同一批文件，或取消此次导入。"
                : history.isPending
                  ? "正在核对此次导入结果…"
                  : history.isError
                    ? "无法核对此次导入，请重新打开导入记录。"
                    : "未查到此次导入回执。请重新选择同一批文件，或取消此次导入。"}
            </Feedback>
          )}
          {!source && !resumed && (
            <p className={styles.status}>选择 Markdown 文件，或选择包含文档和附件的 ZIP。</p>
          )}
          <FilePicker
            files={files}
            disabled={upload.isPending}
            onChange={(next) => {
              if (upload.isError || recovered) remember();
              upload.reset();
              setFiles(next);
            }}
          />
          {files.length > 1 && (
            <ul aria-label="待导入文件">
              {files.map((file) => (
                <li key={file.name}>{file.name}</li>
              ))}
            </ul>
          )}
          {invalid && (
            <Feedback tone="error" className={styles.status}>
              {invalid}
            </Feedback>
          )}
          {completed && (
            <Feedback tone="success" className={styles.status}>
              导入已完成 · {receiptSummary(completed)}
            </Feedback>
          )}
          {upload.isError && !recovered && (
            <Feedback tone="error" className={styles.status}>
              {uploadError(upload.error)}
            </Feedback>
          )}
          <div className={styles.actions}>
            <Button
              variant="primary"
              className={styles.primary}
              type="submit"
              isDisabled={!ready || upload.isPending || Boolean(recovered)}
            >
              {upload.isPending ? "正在导入…" : upload.isError || resumed ? "重试导入" : "确认导入"}
            </Button>
            {(source || resumed || upload.isError) && (
              <Button
                variant="outline"
                className={styles.secondary}
                onPress={cancel}
                isDisabled={upload.isPending}
              >
                取消本次导入
              </Button>
            )}
          </div>
        </Form>
      )}
      <section aria-label="导入记录" className={styles.section}>
        <h4>导入记录</h4>
        {history.isPending && <Feedback className={styles.status}>正在读取导入记录…</Feedback>}
        {history.isError && !history.data && <Feedback tone="error">无法读取导入记录。</Feedback>}
        {history.data?.length === 0 && <p className={styles.empty}>暂无导入记录。</p>}
        {recent.length > 0 && (
          <ul className={styles.records} aria-label="导入回执">
            {recent.map((record) => (
              <li key={record.operationId}>
                <div>
                  {record.manifest.sourceName}
                  {record.manifest.version && ` · ${record.manifest.version}`}
                </div>
                <div>{receiptSummary(record)}</div>
                {receiptChanges(workspace, record, byPath)}
                <Disclosure title="回执详情">
                  <div>
                    来源 ID <code>{record.deliveryId}</code>
                  </div>
                  <div>
                    版本记录 <code>{record.commitId}</code>
                  </div>
                </Disclosure>
                {writable && latest.get(record.deliveryId) === record.operationId && (
                  <Button
                    variant="outline"
                    className={styles.secondary}
                    isDisabled={upload.isPending}
                    onPress={() => editSource(record)}
                  >
                    更新此来源
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

export function DeliveryPanel({ workspace, writable }: { workspace: string; writable: boolean }) {
  const session = useQuery(sessionQuery);
  const storageKey =
    session.data && `librarian:pending-import:${session.data.cacheId}:${workspace}`;
  return (
    <WorkspaceDelivery
      key={storageKey ?? workspace}
      workspace={workspace}
      writable={writable}
      storageKey={storageKey}
    />
  );
}
