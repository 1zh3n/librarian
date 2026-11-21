import { useEffect, useState } from "react";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { offlineAvailable, offlineRequest } from "./readerOffline";
import styles from "../../routes/SnapshotRoute.module.css";

export function OfflineSnapshotControl({ id, offline }: { id: string; offline: boolean }) {
  const [saved, setSaved] = useState(offline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!offlineAvailable()) return;
    let mounted = true;
    const status = () =>
      void offlineRequest({ type: "status", id }).then(
        (value) => {
          if (mounted) setSaved(value);
        },
        () => {},
      );
    const sessionChanged = (event: MessageEvent<{ type?: string }>) => {
      if (event.data.type === "offline-identity-changed") status();
    };
    navigator.serviceWorker.addEventListener("message", sessionChanged);
    status();
    return () => {
      mounted = false;
      navigator.serviceWorker.removeEventListener("message", sessionChanged);
    };
  }, [id]);

  async function update() {
    setPending(true);
    setError(false);
    try {
      await offlineRequest({ type: saved ? "remove" : "save", id });
      setSaved(!saved);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  if (!offlineAvailable()) return null;
  return (
    <div className={styles.offline}>
      <Button
        className={styles.offlineButton}
        isDisabled={pending || (offline && !saved)}
        onPress={() => void update()}
      >
        {pending ? "正在更新离线副本…" : saved ? "移除离线副本" : "保存离线副本"}
      </Button>
      {offline ? (
        <Feedback>正在读取离线副本</Feedback>
      ) : saved ? (
        <Feedback tone="success">已保存离线副本</Feedback>
      ) : null}
      {error && <Feedback tone="error">无法更新离线副本，请检查网络或设备存储。</Feedback>}
    </div>
  );
}
