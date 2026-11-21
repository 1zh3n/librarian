import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { DeliveryManifest, DeliveryReceipt } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, FilePicker, Form } from "../../ui/primitives";
import { Field } from "../workspace/ManagementFields";
import styles from "../workspace/Management.module.css";

const bytesPerMebibyte = 1024 * 1024;

function limitExceeded(files: readonly File[], archive: File | undefined): boolean {
  if (archive) return archive.size > 18 * bytesPerMebibyte;
  const total = files.reduce((bytes, file) => bytes + file.size, 0);
  return (
    files.length > 64 ||
    total > 24 * bytesPerMebibyte ||
    files.some((file) => file.size > (/\.md$/iu.test(file.name) ? 4 : 12) * bytesPerMebibyte)
  );
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

export function DeliveryPanel({ workspace, writable }: { workspace: string; writable: boolean }) {
  const client = useQueryClient();
  const key = [...workspaceKeys.workspace(workspace), "deliveries"];
  const history = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.listDeliveries(workspace, signal),
  });
  const [deliveryId, setDeliveryId] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [version, setVersion] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const zip = files.filter((file) => /\.zip$/iu.test(file.name));
  const mixed = zip.length > 0 && files.length > 1;
  const tooLarge = limitExceeded(files, zip[0]);

  const upload = useMutation({
    async mutationFn() {
      const manifest: DeliveryManifest = {
        deliveryId: deliveryId.trim(),
        sourceName: sourceName.trim(),
        ...(version.trim() && { version: version.trim() }),
        ...(generatedAt && { generatedAt: new Date(generatedAt).toISOString() }),
      };
      const archive = zip[0];
      if (archive) {
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
      client.setQueryData<DeliveryReceipt[]>(key, (records) => [
        receipt,
        ...(records ?? []).filter((record) => record.operationId !== receipt.operationId),
      ]);
      await client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
    },
  });
  const ready = Boolean(
    deliveryId.trim() && sourceName.trim() && files.length && !mixed && !tooLarge,
  );

  return (
    <section className={styles.section} aria-label="投递文件">
      <h3>投递文件</h3>
      {writable && (
        <Form
          className={styles.form}
          aria-label="投递文件"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !upload.isPending) upload.mutate();
          }}
        >
          <div className={styles.fields}>
            <Field label="投递 ID" value={deliveryId} onChange={setDeliveryId} required />
            <Field label="来源名称" value={sourceName} onChange={setSourceName} required />
            <Field label="版本（可选）" value={version} onChange={setVersion} />
            <Field
              label="生成时间（可选）"
              type="datetime-local"
              value={generatedAt}
              onChange={setGeneratedAt}
            />
          </div>
          <FilePicker files={files} disabled={upload.isPending} onChange={setFiles} />
          {mixed && (
            <p className={styles.status} role="alert">
              每次可上传一个 ZIP，或一组单独文件。
            </p>
          )}
          {!mixed && tooLarge && (
            <p className={styles.status} role="alert">
              投递文件超过大小限制。
            </p>
          )}
          {upload.isSuccess && (
            <output className={styles.status}>已投递 {upload.data.changes.length} 个文件</output>
          )}
          {upload.isError && (
            <p role="alert" className={styles.status}>
              {upload.error instanceof ApiError && upload.error.status === 409
                ? "投递路径或文件版本发生冲突。"
                : upload.error instanceof ApiError && upload.error.status === 413
                  ? "投递文件超过大小限制。"
                  : "无法上传投递，请检查文件与投递信息。"}
            </p>
          )}
          <Button className={styles.primary} type="submit" isDisabled={!ready || upload.isPending}>
            {upload.isPending ? "正在上传…" : "上传投递"}
          </Button>
        </Form>
      )}
      <section aria-label="投递记录" className={styles.section}>
        <h4>投递记录</h4>
        {history.isPending && <output className={styles.status}>正在读取投递记录…</output>}
        {history.isError && !history.data && <p role="alert">无法读取投递记录。</p>}
        {history.data?.length === 0 && <p className={styles.empty}>暂无投递记录。</p>}
        {Boolean(history.data?.length) && (
          <ul className={styles.records} aria-label="投递回执">
            {history.data?.map((record) => (
              <li key={record.operationId}>
                <div>
                  {record.manifest.sourceName} · {record.deliveryId}
                  {record.manifest.version && ` · ${record.manifest.version}`}
                </div>
                <code>{record.commitId}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
