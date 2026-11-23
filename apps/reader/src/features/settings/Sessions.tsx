import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import type { AccountSession } from "../../api/client";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Feedback } from "../../ui/Feedback";
import styles from "../workspace/Management.module.css";

const sessionsKey = ["sessions"] as const;
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(seconds: number) {
  return dateFormat.format(new Date(seconds * 1000));
}

function sessionLabel(session: AccountSession) {
  const provider = session.provider ?? "密码登录";
  return session.current ? `当前设备 · ${provider}` : provider;
}

export function Sessions() {
  const client = useQueryClient();
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: ({ signal }) => api.listAccountSessions(signal),
  });
  const [revoke, setRevoke] = useState<AccountSession | null>(null);
  const [revokeOthers, setRevokeOthers] = useState(false);
  const [notice, setNotice] = useState("");
  const [dialogError, setDialogError] = useState("");

  const revokeOne = useMutation({
    mutationFn: (id: string) => api.revokeAccountSession(id),
    onSuccess: async () => {
      setRevoke(null);
      setDialogError("");
      setNotice("已撤销该设备");
      await client.invalidateQueries({ queryKey: sessionsKey });
    },
    onError: () => setDialogError("无法撤销该设备，请重试。"),
  });
  const revokeAll = useMutation({
    mutationFn: () => api.revokeOtherAccountSessions(),
    onSuccess: async (result) => {
      setRevokeOthers(false);
      setDialogError("");
      setNotice(`已撤销 ${result.revoked} 个其他设备`);
      await client.invalidateQueries({ queryKey: sessionsKey });
    },
    onError: () => setDialogError("无法撤销其他设备，请重试。"),
  });

  const hasOther = sessions.data?.sessions.some((session) => !session.current) ?? false;

  return (
    <section aria-label="登录设备" className={styles.section}>
      <h2>登录设备</h2>
      <p className={styles.status}>这些浏览器会话可以访问你的账号。撤销后，该设备需要重新登录。</p>
      {sessions.isPending && <Feedback className={styles.status}>正在读取登录设备…</Feedback>}
      {sessions.isError && (
        <Feedback tone="error" className={styles.status}>
          无法读取登录设备。
        </Feedback>
      )}
      {sessions.data && sessions.data.sessions.length === 0 && (
        <p className={styles.empty}>没有可显示的登录设备。</p>
      )}
      {sessions.data && sessions.data.sessions.length > 0 && (
        <ul aria-label="登录设备列表" className={styles.records}>
          {sessions.data.sessions.map((session) => (
            <li key={session.id}>
              <strong>
                {sessionLabel(session)}
                {session.shared ? " · 共享设备" : ""}
              </strong>
              <span>创建于 {formatDate(session.createdAt)}</span>
              <span>有效至 {formatDate(session.expiresAt)}</span>
              {!session.current && (
                <Button
                  variant="outline"
                  className={styles.formAction}
                  onPress={() => {
                    setDialogError("");
                    setRevoke(session);
                  }}
                >
                  撤销
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <Feedback tone="success" className={styles.status}>
          {notice}
        </Feedback>
      )}
      {hasOther && (
        <Button
          variant="outline"
          className={styles.formAction}
          onPress={() => {
            setDialogError("");
            setRevokeOthers(true);
          }}
        >
          撤销其他设备
        </Button>
      )}
      {revoke && (
        <ConfirmDialog
          title="撤销登录设备"
          confirmLabel="撤销"
          destructive
          busy={revokeOne.isPending}
          error={dialogError || undefined}
          onCancel={() => setRevoke(null)}
          onConfirm={() => revokeOne.mutate(revoke.id)}
        >
          撤销后，该设备需要重新登录。
        </ConfirmDialog>
      )}
      {revokeOthers && (
        <ConfirmDialog
          title="撤销其他设备"
          confirmLabel="撤销其他设备"
          destructive
          busy={revokeAll.isPending}
          error={dialogError || undefined}
          onCancel={() => setRevokeOthers(false)}
          onConfirm={() => revokeAll.mutate()}
        >
          除当前设备外，其他登录设备都需要重新登录。
        </ConfirmDialog>
      )}
    </section>
  );
}
