import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../../api/client";
import type { DeliveryToken } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Disclosure } from "../../ui/Disclosure";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Field, Form } from "../../ui/Forms";
import styles from "../workspace/Management.module.css";
import { deliveryHistory } from "./deliveryHistory";

const validSourceId = /^[a-z0-9-]{1,64}$/u;

function commandFor(workspace: string, deliveryId: string) {
  return [
    "LIBRARIAN_URL='https://librarian.example' \\",
    'LIBRARIAN_DELIVERY_TOKEN="${LIBRARIAN_DELIVERY_TOKEN}" \\',
    `docs push ./docs --workspace ${workspace} --delivery-id=${deliveryId} \\`,
    '  --source-name "项目文档" --version "${CI_COMMIT_SHA}"',
  ].join("\n");
}

export function DeliveryTokens({ workspace }: { workspace: string }) {
  const client = useQueryClient();
  const key = [...workspaceKeys.workspace(workspace), "delivery-tokens"];
  const tokens = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.listDeliveryTokens(workspace, signal),
  });
  const records = useQuery(deliveryHistory(workspace));
  const [name, setName] = useState("");
  const [deliveryId, setDeliveryId] = useState("");
  const expanded = useRef(false);
  const canIssue = Boolean(name.trim() && validSourceId.test(deliveryId.trim()));
  const [issued, setIssued] = useState<{ id: string; token: string }>();
  const [exampleSource, setExampleSource] = useState<string>();
  const [copyStatus, setCopyStatus] = useState("");
  const commandSource = validSourceId.test(deliveryId.trim())
    ? deliveryId.trim()
    : (exampleSource ?? "project-docs");
  const command = commandFor(workspace, commandSource);
  const issue = useMutation({
    async mutationFn(input: { name: string; deliveryId: string }) {
      const { token, ...summary } = await api.issueDeliveryToken(workspace, input);
      if (expanded.current) setIssued({ id: summary.id, token });
      setExampleSource(input.deliveryId);
      return summary;
    },
    onSuccess: async (summary) => {
      setName("");
      setDeliveryId("");
      setCopyStatus("");
      client.setQueryData<DeliveryToken[]>(key, (list) => [summary, ...(list ?? [])]);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeDeliveryToken(workspace, id),
    onSuccess: async (_unused, id) => {
      setIssued((current) => (current?.id === id ? undefined : current));
      await client.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <section aria-label="项目自动导入" className={styles.section}>
      <Disclosure
        title="项目自动导入"
        onChange={(open) => {
          expanded.current = open;
          if (!open) setIssued(undefined);
        }}
      >
        <p className={styles.status}>例如，项目 CI 在生成发布说明后，把文档副本送入这个空间。</p>
        <Form
          className={styles.form}
          aria-label="签发投递凭证"
          onSubmit={(event) => {
            event.preventDefault();
            if (canIssue && !issue.isPending)
              issue.mutate({ name: name.trim(), deliveryId: deliveryId.trim() });
          }}
        >
          <div className={styles.fields}>
            <Field
              className={styles.field}
              inputClassName={styles.input}
              label="凭证名称"
              value={name}
              onChange={setName}
              required
            />
            <Field
              className={styles.field}
              inputClassName={styles.input}
              label="来源 ID"
              value={deliveryId}
              onChange={setDeliveryId}
              required
            />
          </div>
          <p className={styles.status}>
            同一项目沿用同一个来源 ID，使用小写字母、数字或连字符。凭证有效期为 90 天。
          </p>
          {issue.isError && (
            <Feedback tone="error" className={styles.status}>
              无法签发投递凭证。
            </Feedback>
          )}
          <Button
            variant="primary"
            className={styles.primary}
            type="submit"
            isDisabled={!canIssue || issue.isPending}
          >
            {issue.isPending ? "正在签发…" : "签发凭证"}
          </Button>
          {issued && (
            <div className={`${styles.form} ${styles.result}`}>
              <Field
                className={styles.field}
                inputClassName={styles.input}
                label="新签发的凭证"
                value={issued.token}
                readOnly
                autoComplete="off"
              />
              <p className={styles.status}>
                凭证仅显示一次。请将它存入 CI 的 LIBRARIAN_DELIVERY_TOKEN 密钥变量。
              </p>
              <Button
                variant="outline"
                className={styles.secondary}
                onPress={() => setIssued(undefined)}
              >
                关闭凭证
              </Button>
            </div>
          )}
        </Form>
        <div className={styles.result}>
          <p className={styles.status}>运行前，将示例地址改为你的 Librarian 地址。</p>
          <pre aria-label="CLI 示例" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {command}
          </pre>
          {navigator.clipboard && (
            <Button
              variant="outline"
              className={styles.secondary}
              onPress={() => {
                void navigator.clipboard.writeText(command).then(
                  () => setCopyStatus("已复制命令。"),
                  () => setCopyStatus("请手动选择并复制命令。"),
                );
              }}
            >
              复制命令
            </Button>
          )}
          {copyStatus && <Feedback className={styles.status}>{copyStatus}</Feedback>}
        </div>
        {tokens.isError && !tokens.data && (
          <Feedback tone="error" className={styles.status}>
            无法读取投递凭证。
          </Feedback>
        )}
        {tokens.data?.length === 0 && <p className={styles.empty}>暂无投递凭证。</p>}
        {Boolean(tokens.data?.length) && (
          <ul className={styles.records} aria-label="投递凭证列表">
            {tokens.data?.map((token) => {
              const latest = records.data?.find(
                (receipt) => receipt.deliveryId === token.deliveryId,
              );
              const expires =
                token.expiresAt === null ? undefined : new Date(token.expiresAt * 1_000);
              return (
                <li key={token.id}>
                  <div>{token.name}</div>
                  {token.deliveryId && (
                    <div>
                      来源 ID <code>{token.deliveryId}</code>
                    </div>
                  )}
                  {expires && (
                    <time dateTime={expires.toISOString()}>
                      到期 {expires.toLocaleDateString("zh-CN")}
                    </time>
                  )}
                  {latest ? (
                    <div>
                      最近回执 · {latest.manifest.version && `${latest.manifest.version} · `}
                      变更 {latest.changes.length} 个文件 · <code>{latest.commitId}</code>
                    </div>
                  ) : (
                    records.isSuccess && token.deliveryId && <div>暂无最近回执</div>
                  )}
                  {token.revoked ? (
                    <Feedback>已撤销</Feedback>
                  ) : (
                    <>
                      {expires && expires.getTime() <= tokens.dataUpdatedAt && (
                        <Feedback>已过期</Feedback>
                      )}
                      <Button
                        variant="outline"
                        className={styles.secondary}
                        isDisabled={revoke.isPending}
                        onPress={() => revoke.mutate(token.id)}
                      >
                        {revoke.isPending && revoke.variables === token.id
                          ? "正在撤销…"
                          : "撤销凭证"}
                      </Button>
                    </>
                  )}
                  {revoke.isError && revoke.variables === token.id && (
                    <Feedback tone="error" className={styles.status}>
                      无法撤销投递凭证。
                    </Feedback>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Disclosure>
    </section>
  );
}
