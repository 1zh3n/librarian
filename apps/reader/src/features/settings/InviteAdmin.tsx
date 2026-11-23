import { Button } from "../../ui/Button";
import { CopyButton } from "../../ui/CopyButton";
import { Feedback } from "../../ui/Feedback";
import { Checkbox, Field, Form, Select } from "../../ui/Forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { CreatedInvite } from "../../api/client";
import { workspacesQuery } from "../../api/queries";
import styles from "../workspace/Management.module.css";

const roles = [
  { value: "write", label: "可编辑" },
  { value: "read", label: "只读" },
] as const;

function inviteStatus(invite: { revoked: boolean; acceptedAt: number | null; expiresAt: number }) {
  if (invite.revoked) return "已撤销";
  if (invite.acceptedAt != null) return "已接受";
  if (invite.expiresAt * 1_000 <= Date.now()) return "已过期";
  return "待接受";
}

function date(seconds: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(seconds * 1_000));
}

export function InviteAdmin() {
  const client = useQueryClient();
  const workspaces = useQuery(workspacesQuery);
  const invites = useQuery({
    queryKey: ["invites"],
    queryFn: ({ signal }) => api.listInvites(signal),
  });
  const [username, setUsername] = useState("");
  const [admin, setAdmin] = useState(false);
  const [role, setRole] = useState<"read" | "write">("write");
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState("7");
  const [created, setCreated] = useState<CreatedInvite>();
  const [error, setError] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createInvite({
        username: username.trim(),
        admin,
        role,
        workspaceIds: selected,
        expiresInDays: Number(days),
      }),
    onSuccess: async (invite) => {
      setCreated(invite);
      setUsername("");
      setSelected([]);
      setError("");
      await client.invalidateQueries({ queryKey: ["invites"] });
    },
    onError: (failure) => {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? "这个用户名已经被使用。"
          : "无法创建邀请，请检查用户名和范围。",
      );
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["invites"] });
    },
    onError: () => setError("无法撤销邀请，请重试。"),
  });

  const link = created ? new URL(created.url, window.location.origin).toString() : "";

  return (
    <>
      <Form
        className={styles.form}
        aria-label="邀请新成员"
        onSubmit={(event) => {
          event.preventDefault();
          if (!username.trim() || create.isPending) return;
          create.mutate();
        }}
      >
        <div className={styles.fields}>
          <Field
            label="用户名"
            value={username}
            onChange={setUsername}
            required
            className={styles.field}
            inputClassName={styles.input}
          />
          <Select label="空间角色" value={role} entries={roles} onChange={setRole} />
          <Field
            label="有效期（天）"
            type="number"
            min={1}
            max={30}
            value={days}
            onChange={setDays}
            className={styles.field}
            inputClassName={styles.input}
          />
        </div>
        <Checkbox checked={admin} onChange={setAdmin}>
          设为服务器管理员
        </Checkbox>
        <fieldset className={styles.fieldset}>
          <legend>可加入的空间</legend>
          {(workspaces.data ?? []).map((workspace) => (
            <Checkbox
              key={workspace.id}
              checked={selected.includes(workspace.id)}
              onChange={(checked) =>
                setSelected((current) =>
                  checked
                    ? [...current, workspace.id]
                    : current.filter((id) => id !== workspace.id),
                )
              }
            >
              {workspace.name}
            </Checkbox>
          ))}
        </fieldset>
        {error && (
          <Feedback tone="error" className={styles.status}>
            {error}
          </Feedback>
        )}
        <Button type="submit" variant="primary" loading={create.isPending}>
          {create.isPending ? "正在创建…" : "创建邀请"}
        </Button>
      </Form>
      {created && (
        <Feedback tone="success" className={styles.status}>
          <span>
            邀请链接只显示一次：
            <code className={styles.address}>{link}</code>
          </span>
          <CopyButton text={link} label="复制邀请链接" />
        </Feedback>
      )}
      <div className={styles.result}>
        <h3>待处理和最近的邀请</h3>
        {invites.isError && (
          <Feedback tone="error" className={styles.status}>
            无法读取邀请列表。
          </Feedback>
        )}
        {invites.data && invites.data.length === 0 && <p className={styles.empty}>还没有邀请。</p>}
        {invites.data && invites.data.length > 0 && (
          <ul className={styles.records} aria-label="邀请列表">
            {invites.data.map((invite) => (
              <li key={invite.id}>
                <strong>{invite.username}</strong>
                <p className={styles.address}>
                  {invite.admin ? "管理员" : "成员"} · {invite.role === "write" ? "可编辑" : "只读"}{" "}
                  · {inviteStatus(invite)} · {date(invite.expiresAt)}
                  {invite.workspaces.length > 0 &&
                    ` · ${invite.workspaces.map((workspace) => workspace.name).join("、")}`}
                </p>
                {inviteStatus(invite) === "待接受" && (
                  <Button
                    variant="outline"
                    size="sm"
                    isDisabled={revoke.isPending}
                    onPress={() => revoke.mutate(invite.id)}
                  >
                    撤销邀请
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
