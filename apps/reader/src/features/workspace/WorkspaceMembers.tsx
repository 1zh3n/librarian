import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Feedback } from "../../ui/Feedback";
import { Form, Field, Select } from "../../ui/Forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { WorkspaceMember } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import styles from "./Management.module.css";

const roles = [
  { value: "read", label: "阅读" },
  { value: "write", label: "编辑" },
] as const;
type Role = WorkspaceMember["role"];

export function WorkspaceMembers({ workspace }: { workspace: string }) {
  const client = useQueryClient();
  const key = [...workspaceKeys.workspace(workspace), "members"];
  const members = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.listWorkspaceMembers(workspace, signal),
  });
  const [draft, setDraft] = useState<{ username: string; role: Role }>({
    username: "",
    role: "read",
  });
  const [removing, setRemoving] = useState<WorkspaceMember>();
  const name = draft.username.trim();
  const existing = members.data?.find((member) => member.username === name);
  const changed = Boolean(name) && !existing?.isOwner && existing?.role !== draft.role;
  const mutation = useMutation({
    mutationFn: ({ name, next }: { name: string; next: Role | null }) =>
      next === null
        ? api.removeWorkspaceMember(workspace, name)
        : api.setWorkspaceMember(workspace, name, { role: next }),
    onSuccess: async (result, submitted) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData(key, result);
      setDraft((latest) =>
        latest.username.trim() === submitted.name &&
        (submitted.next === null || latest.role === submitted.next)
          ? { username: "", role: "read" }
          : latest,
      );
    },
  });
  const memberError =
    mutation.error instanceof ApiError && mutation.error.status === 404
      ? "账号不可用，或该成员已移除。"
      : "无法更新成员权限，请检查后重试。";
  return (
    <section aria-label="空间成员" className={styles.section}>
      <h3>空间成员</h3>
      {members.isError && (
        <Feedback tone="error" className={styles.status}>
          无法读取成员。
        </Feedback>
      )}
      {members.isPending && <Feedback className={styles.status}>正在加载成员…</Feedback>}
      {members.data && (
        <>
          <Form
            aria-label="设置成员权限"
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (!mutation.isPending && changed) {
                mutation.mutate({ name, next: draft.role });
              }
            }}
          >
            <div className={styles.fields}>
              <Field
                label="成员用户名"
                value={draft.username}
                onChange={(username) => setDraft({ ...draft, username })}
                required
              />
              <Select
                label="权限"
                value={draft.role}
                entries={roles}
                onChange={(role) => setDraft({ ...draft, role })}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              className={styles.formAction}
              loading={mutation.isPending && mutation.variables.next !== null}
              isDisabled={!changed || mutation.isPending}
            >
              {mutation.isPending && mutation.variables.next !== null
                ? "正在保存成员…"
                : "保存成员"}
            </Button>
          </Form>
          {mutation.isError && (
            <Feedback tone="error" className={styles.status}>
              {memberError}
            </Feedback>
          )}
          {mutation.isSuccess && !name && (
            <Feedback tone="success" className={styles.status}>
              {mutation.variables.next === null ? "已移除成员" : "成员权限已保存"}
            </Feedback>
          )}
          {members.data.length === 0 && <p className={styles.empty}>暂无成员。</p>}
          {members.data.length > 0 && (
            <ul aria-label="成员列表" className={styles.records}>
              {members.data.map((member) => (
                <li key={member.username}>
                  <strong>{member.username}</strong>
                  <p className={styles.address}>
                    {member.isOwner ? "创建者" : member.role === "read" ? "阅读" : "编辑"}
                  </p>
                  {!member.isOwner && (
                    <div className={styles.actions}>
                      <Button
                        variant="outline"
                        className={styles.formAction}
                        isDisabled={mutation.isPending}
                        onPress={() => {
                          mutation.reset();
                          setDraft({ username: member.username, role: member.role });
                        }}
                      >
                        编辑权限
                      </Button>
                      <Button
                        variant="outline"
                        className={styles.formAction}
                        isDisabled={mutation.isPending}
                        onPress={() => {
                          mutation.reset();
                          setRemoving(member);
                        }}
                      >
                        {mutation.isPending &&
                        mutation.variables.next === null &&
                        mutation.variables.name === member.username
                          ? "正在移除…"
                          : "移除成员"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {removing && (
        <ConfirmDialog
          title="移除成员"
          confirmLabel="移除成员"
          destructive
          busy={mutation.isPending}
          error={
            mutation.isError && mutation.variables?.name === removing.username
              ? memberError
              : undefined
          }
          onCancel={() => {
            mutation.reset();
            setRemoving(undefined);
          }}
          onConfirm={() =>
            mutation.mutate(
              { name: removing.username, next: null },
              { onSuccess: () => setRemoving(undefined) },
            )
          }
        >
          移除「{removing.username}
          」后，该账号将无法继续访问这个空间。空间内的文档和版本不会被删除。
        </ConfirmDialog>
      )}
    </section>
  );
}
