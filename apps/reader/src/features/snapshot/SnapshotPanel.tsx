import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { CreateSnapshot, DocumentSummary, SnapshotLinkSummary } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { CopyButton } from "../../ui/CopyButton";
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
  const [stepUpCode, setStepUpCode] = useState("");
  const [stepUpError, setStepUpError] = useState("");
  const client = useQueryClient();
  const totp = useQuery({
    queryKey: ["totp", "status"],
    queryFn: ({ signal }) => api.getTotpStatus(signal),
  });
  const totpEnabled = totp.data?.enabled ?? false;
  const addressesKey = [...workspaceKeys.workspace(workspace), "snapshots"];
  const addresses = useQuery({
    queryKey: addressesKey,
    queryFn: ({ signal }) => api.listSnapshots(workspace, signal),
  });
  const [revoking, setRevoking] = useState<SnapshotLinkSummary>();
  const create = useMutation({
    mutationFn: async (body: CreateSnapshot) => {
      let stepUpToken: string | undefined;
      if (body.audience === "share" && totpEnabled) {
        stepUpToken = (await api.stepUp(stepUpCode)).token;
      }
      return api.createSnapshot(workspace, {
        ...body,
        ...(stepUpToken && { stepUpToken }),
      });
    },
    onSuccess: async () => {
      setStepUpCode("");
      setStepUpError("");
      await client.invalidateQueries({ queryKey: addressesKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSnapshot(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: addressesKey });
    },
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
            if (audience === "share" && totpEnabled && !stepUpCode.trim()) {
              setStepUpError("请输入验证码或恢复码。");
              return;
            }
            setStepUpError("");
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
          {audience === "share" && totpEnabled && (
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
      {create.isSuccess && (
        <Feedback tone="success" className={styles.status}>
          已创建阅读地址
        </Feedback>
      )}
      {addresses.isPending && <Feedback className={styles.status}>正在读取阅读地址…</Feedback>}
      {addresses.isError && (
        <Feedback tone="error" className={styles.status}>
          无法读取阅读地址。
        </Feedback>
      )}
      {addresses.data && addresses.data.length > 0 && (
        <ul className={styles.records} aria-label="已创建的阅读地址">
          {addresses.data.map((address) => {
            const url = new URL(address.url, window.location.origin).href;
            const expires = address.expiresAt
              ? new Date(address.expiresAt * 1_000).toLocaleDateString("zh-CN")
              : undefined;
            return (
              <li key={address.id}>
                <a href={address.url} target="_blank" rel="noreferrer">
                  打开阅读地址
                </a>
                <div className={styles.address}>{url}</div>
                <p className={styles.status}>
                  {address.kind === "release" ? "固定版本" : "当前地址"} ·{" "}
                  {address.audience === "share" ? "持链接可读" : "仅空间成员"} ·{" "}
                  {address.documentCount} 篇文档
                  {expires && ` · 到期 ${expires}`}
                </p>
                <div className={styles.actions}>
                  <CopyButton text={url} label="复制地址" />
                  <Button
                    variant="outline"
                    className={styles.formAction}
                    isDisabled={revoke.isPending}
                    onPress={() => {
                      revoke.reset();
                      setRevoking(address);
                    }}
                  >
                    {revoke.isPending && revoke.variables === address.id
                      ? "正在撤销…"
                      : "撤销阅读地址"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {revoke.isSuccess && (
        <Feedback tone="success" className={styles.status}>
          阅读地址已撤销
        </Feedback>
      )}
      {revoke.isError && !revoking && (
        <Feedback tone="error" className={styles.status}>
          无法撤销阅读地址。
        </Feedback>
      )}
      {revoking && (
        <ConfirmDialog
          title="撤销阅读地址"
          confirmLabel="撤销地址"
          destructive
          busy={revoke.isPending}
          error={
            revoke.isError && revoke.variables === revoking.id ? "无法撤销阅读地址。" : undefined
          }
          onCancel={() => {
            revoke.reset();
            setRevoking(undefined);
          }}
          onConfirm={() =>
            revoke.mutate(revoking.id, {
              onSuccess: () => setRevoking(undefined),
            })
          }
        >
          撤销后，这个阅读地址将立即失效。已经打开的页面不会自动收回。
        </ConfirmDialog>
      )}
    </section>
  );
}
