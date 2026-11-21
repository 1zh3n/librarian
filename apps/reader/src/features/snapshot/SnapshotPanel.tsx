import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { CreateSnapshot, DocumentSummary, SnapshotLink } from "../../api/client";
import { Disclosure } from "../../ui/Disclosure";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Field, Form, Select, TextAreaField } from "../../ui/Forms";
import { DocumentChecklist } from "../workspace/DocumentChecklist";
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
  const [expanded, setExpanded] = useState(false);
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
      <h3>阅读地址</h3>
      {documents.length === 0 ? (
        <p className={styles.empty}>添加文档后即可创建阅读地址。</p>
      ) : (
        <Form
          className={styles.form}
          aria-label="创建阅读地址"
          onSubmit={(event) => {
            event.preventDefault();
            if (!documentIds.length || create.isPending) return;
            const expiresAt = expiry ? Math.floor(new Date(expiry).getTime() / 1_000) : null;
            if (expiresAt !== null && !(expiresAt > Date.now() / 1_000)) {
              setExpanded(true);
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
            <Select
              className={styles.field}
              label="地址类型"
              value={kind}
              entries={kinds}
              onChange={setKind}
            />
            <Select
              className={styles.field}
              label="访问范围"
              value={audience}
              entries={audiences}
              onChange={setAudience}
            />
          </div>
          <DocumentChecklist documents={documents} selected={selected} onChange={setSelected} />
          <Disclosure
            title={kind === "release" ? "版本、有效期与附件" : "有效期与附件"}
            expanded={expanded}
            onChange={setExpanded}
            bodyClassName={styles.form}
          >
            <div className={styles.fields}>
              <Field
                className={styles.field}
                inputClassName={styles.input}
                label="地址到期时间（可选）"
                type="datetime-local"
                value={expiry}
                onChange={(value) => {
                  setExpiry(value);
                  setExpiryError(false);
                }}
              />
              {kind === "release" && (
                <Field
                  className={styles.field}
                  inputClassName={styles.input}
                  label="提交 ID（可选）"
                  value={commit}
                  onChange={setCommit}
                />
              )}
            </div>
            <TextAreaField
              label="附件路径（可选，每行一项）"
              className={styles.field}
              inputClassName={styles.input}
              rows={2}
              value={attachmentInput}
              onChange={setAttachmentInput}
            />
            {expiryError && (
              <Feedback tone="error" className={styles.status}>
                到期时间必须晚于现在。
              </Feedback>
            )}
          </Disclosure>
          {create.isError && (
            <Feedback tone="error" className={styles.status}>
              {create.error instanceof ApiError && create.error.status === 409
                ? "当前内容或所选版本已变化，请检查后重试。"
                : "无法创建阅读地址，请检查文档、附件和版本。"}
            </Feedback>
          )}
          <Button
            variant="primary"
            className={styles.formAction}
            type="submit"
            isDisabled={!documentIds.length || create.isPending}
          >
            {create.isPending ? "正在创建阅读地址…" : "创建阅读地址"}
          </Button>
        </Form>
      )}
      {create.isSuccess && addresses.some(({ id }) => id === create.data.id) && (
        <Feedback tone="success" className={styles.status}>
          已创建阅读地址
        </Feedback>
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
                variant="outline"
                className={styles.formAction}
                isDisabled={revoke.isPending}
                onPress={() => revoke.mutate(address.id)}
              >
                {revoke.isPending && revoke.variables === address.id ? "正在撤销…" : "撤销阅读地址"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoke.isSuccess && (
        <Feedback tone="success" className={styles.status}>
          阅读地址已撤销
        </Feedback>
      )}
      {revoke.isError && (
        <Feedback tone="error" className={styles.status}>
          无法撤销阅读地址。
        </Feedback>
      )}
    </section>
  );
}
