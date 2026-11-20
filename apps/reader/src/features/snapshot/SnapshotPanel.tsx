import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { CreateSnapshot, DocumentSummary, SnapshotLink } from "../../api/client";
import { Button, Checkbox, Form, Label, TextArea, TextField } from "../../ui/primitives";
import { Choice, Field } from "../workspace/ManagementFields";
import styles from "../workspace/Management.module.css";

const kinds = [
  { value: "current", label: "当前地址" },
  { value: "release", label: "固定版本" },
] as const;
const audiences = [
  { value: "members", label: "仅空间成员" },
  { value: "share", label: "持链接可读" },
] as const;

export function SnapshotPanel({
  workspace,
  documents,
}: {
  workspace: string;
  documents: readonly DocumentSummary[];
}) {
  const [kind, setKind] = useState<CreateSnapshot["kind"]>("current");
  const [audience, setAudience] = useState<NonNullable<CreateSnapshot["audience"]>>("members");
  const [selected, setSelected] = useState<string[]>([]);
  const [attachmentInput, setAttachmentInput] = useState("");
  const [expiry, setExpiry] = useState("");
  const [commit, setCommit] = useState("");
  const [expiryError, setExpiryError] = useState(false);
  const [addresses, setAddresses] = useState<SnapshotLink[]>([]);
  const create = useMutation({
    mutationFn: (body: CreateSnapshot) => api.createSnapshot(workspace, body),
    onSuccess: (address) => setAddresses((items) => [address, ...items]),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSnapshot(id),
    onSuccess: (_response, id) => setAddresses((items) => items.filter((item) => item.id !== id)),
  });
  const documentIds = selected.filter((id) => documents.some((document) => document.id === id));

  return (
    <section className={styles.section} aria-label="阅读地址">
      <h2>阅读地址</h2>
      {documents.length === 0 ? (
        <p className={styles.status}>空间中还没有可选文档。</p>
      ) : (
        <Form
          className={styles.form}
          aria-label="创建阅读地址"
          onSubmit={(event) => {
            event.preventDefault();
            if (!documentIds.length || create.isPending) return;
            const expiresAt = expiry ? Math.floor(new Date(expiry).getTime() / 1_000) : null;
            if (expiresAt !== null && !(expiresAt > Date.now() / 1_000)) {
              setExpiryError(true);
              return;
            }
            setExpiryError(false);
            const attachmentPaths = Array.from(
              new Set(
                attachmentInput
                  .split(/\r?\n/u)
                  .map((path) => path.trim())
                  .filter(Boolean),
              ),
            );
            create.mutate({
              kind,
              audience,
              documentIds,
              expiresAt,
              ...(attachmentPaths.length > 0 && { attachmentPaths }),
              ...(kind === "release" && commit.trim() && { commitId: commit.trim() }),
            });
          }}
        >
          <div className={styles.fields}>
            <Choice label="地址类型" value={kind} entries={kinds} onChange={setKind} />
            <Choice label="访问范围" value={audience} entries={audiences} onChange={setAudience} />
          </div>
          <div className={styles.fields}>
            <Field
              label="地址到期时间（可选）"
              type="datetime-local"
              value={expiry}
              onChange={(value) => {
                setExpiry(value);
                setExpiryError(false);
              }}
            />
            {kind === "release" && (
              <Field label="提交 ID（可选）" value={commit} onChange={setCommit} />
            )}
          </div>
          <fieldset className={styles.fieldset}>
            <legend>文档范围</legend>
            <div className={styles.checklist}>
              {documents.map(({ id, path }) => (
                <Checkbox
                  key={id}
                  className={styles.checkbox}
                  isSelected={selected.includes(id)}
                  onChange={(checked) =>
                    setSelected((items) =>
                      checked ? [...items, id] : items.filter((item) => item !== id),
                    )
                  }
                >
                  <span className={styles.checkboxMark} aria-hidden="true" />
                  <span>{path}</span>
                </Checkbox>
              ))}
            </div>
          </fieldset>
          <TextField className={styles.field} value={attachmentInput} onChange={setAttachmentInput}>
            <Label>附件路径（可选，每行一项）</Label>
            <TextArea rows={2} className={styles.input} />
          </TextField>
          {expiryError && (
            <p role="alert" className={styles.status}>
              到期时间必须晚于现在。
            </p>
          )}
          {create.isError && (
            <p role="alert" className={styles.status}>
              {create.error instanceof ApiError && create.error.status === 409
                ? "当前内容或所选版本已变化，请检查后重试。"
                : "无法创建阅读地址，请检查文档、附件和版本。"}
            </p>
          )}
          <Button
            className={styles.primary}
            type="submit"
            isDisabled={!documentIds.length || create.isPending}
          >
            创建阅读地址
          </Button>
        </Form>
      )}
      {addresses.length > 0 && (
        <ul className={styles.records} aria-label="已创建的阅读地址">
          {addresses.map((address) => (
            <li key={address.id}>
              <a href={address.url} target="_blank" rel="noreferrer">
                打开阅读地址
              </a>
              <div className={styles.address}>
                {new URL(address.url, window.location.origin).href}
              </div>
              <Button
                className={styles.secondary}
                isDisabled={revoke.isPending}
                onPress={() => revoke.mutate(address.id)}
              >
                撤销阅读地址
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoke.isSuccess && <output className={styles.status}>阅读地址已撤销</output>}
      {revoke.isError && (
        <p role="alert" className={styles.status}>
          无法撤销阅读地址。
        </p>
      )}
    </section>
  );
}
