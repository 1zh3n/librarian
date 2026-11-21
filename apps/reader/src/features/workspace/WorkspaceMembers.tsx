import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { WorkspaceMember } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, Form } from "../../ui/primitives";
import { Choice, Field } from "./ManagementFields";
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
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("read");
  const mutation = useMutation({
    mutationFn: ({ name, next }: { name: string; next: Role | null }) =>
      next === null
        ? api.removeWorkspaceMember(workspace, name)
        : api.setWorkspaceMember(workspace, name, { role: next }),
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData(key, result);
      setUsername("");
      setRole("read");
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
        <p role="alert" className={styles.status}>
          无法读取成员。
        </p>
      )}
      {members.isPending && <output className={styles.status}>正在加载成员…</output>}
      {members.data && (
        <>
          <Form
            aria-label="设置成员权限"
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (!mutation.isPending && username.trim()) {
                mutation.mutate({ name: username.trim(), next: role });
              }
            }}
          >
            <div className={styles.fields}>
              <Field label="成员用户名" value={username} onChange={setUsername} required />
              <Choice label="权限" value={role} entries={roles} onChange={setRole} />
            </div>
            <Button
              type="submit"
              className={styles.primary}
              isDisabled={!username.trim() || mutation.isPending}
            >
              {mutation.isPending && mutation.variables.next !== null
                ? "正在保存成员…"
                : "保存成员"}
            </Button>
          </Form>
          {mutation.isError && (
            <p role="alert" className={styles.status}>
              {memberError}
            </p>
          )}
          {mutation.isSuccess && (
            <output className={styles.status}>
              {mutation.variables.next === null ? "已移除成员" : "成员权限已保存"}
            </output>
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
                        className={styles.secondary}
                        isDisabled={mutation.isPending}
                        onPress={() => {
                          mutation.reset();
                          setUsername(member.username);
                          setRole(member.role);
                        }}
                      >
                        编辑权限
                      </Button>
                      <Button
                        className={styles.secondary}
                        isDisabled={mutation.isPending}
                        onPress={() => mutation.mutate({ name: member.username, next: null })}
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
    </section>
  );
}
