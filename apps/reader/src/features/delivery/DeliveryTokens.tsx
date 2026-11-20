import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import type { DeliveryToken } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, Form, Input, Label, TextField } from "../../ui/primitives";
import { Field } from "../workspace/ManagementFields";
import styles from "../workspace/Management.module.css";

export function DeliveryTokens({ workspace }: { workspace: string }) {
  const client = useQueryClient();
  const key = [...workspaceKeys.workspace(workspace), "delivery-tokens"];
  const tokens = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.listDeliveryTokens(workspace, signal),
  });
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<{ id: string; token: string }>();
  const issue = useMutation({
    async mutationFn(label: string) {
      const { token, ...summary } = await api.issueDeliveryToken(workspace, { name: label });
      setIssued({ id: summary.id, token });
      return summary;
    },
    onSuccess: async (summary) => {
      setName("");
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
    <section aria-label="投递凭证" className={styles.section}>
      <h2>投递凭证</h2>
      <Form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !issue.isPending) issue.mutate(name.trim());
        }}
      >
        <Field label="凭证名称" value={name} onChange={setName} required />
        {issue.isError && (
          <p role="alert" className={styles.status}>
            无法签发投递凭证。
          </p>
        )}
        <Button
          className={styles.primary}
          type="submit"
          isDisabled={!name.trim() || issue.isPending}
        >
          签发凭证
        </Button>
        {issued && (
          <div className={styles.form}>
            <TextField className={styles.field} isReadOnly value={issued.token}>
              <Label>新签发的凭证</Label>
              <Input className={styles.input} autoComplete="off" />
            </TextField>
            <p className={styles.status}>请复制凭证。离开页面后只显示名称。</p>
            <Button className={styles.secondary} onPress={() => setIssued(undefined)}>
              关闭凭证
            </Button>
          </div>
        )}
      </Form>
      {tokens.isError && !tokens.data && (
        <p role="alert" className={styles.status}>
          无法读取投递凭证。
        </p>
      )}
      {Boolean(tokens.data?.length) && (
        <ul className={styles.records}>
          {tokens.data?.map((token) => (
            <li key={token.id}>
              <div>{token.name}</div>
              {token.revoked ? (
                <span>已撤销</span>
              ) : (
                <Button
                  className={styles.secondary}
                  isDisabled={revoke.isPending}
                  onPress={() => revoke.mutate(token.id)}
                >
                  撤销凭证
                </Button>
              )}
              {revoke.isError && revoke.variables === token.id && (
                <p role="alert" className={styles.status}>
                  无法撤销投递凭证。
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
