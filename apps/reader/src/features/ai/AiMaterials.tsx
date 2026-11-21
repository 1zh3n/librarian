import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  listAiMaterials,
  readAiMaterialSegment,
  removeAiMaterial,
  uploadAiMaterial,
} from "../../api/client";
import type { AiMaterialSource, AiMaterialView } from "../../api/client";
import { Button, Checkbox, FilePicker } from "../../ui/primitives";
import styles from "./AiMaterials.module.css";

const materialKey = (id?: string) => ["ai-materials", id] as const;
const errors: Record<string, string> = {
  invalid_file: "文件损坏，请选择可打开的原件重新上传。",
  no_text: "未找到文本层，请上传含文字的文件。",
  encrypted_pdf: "PDF 已加密，请上传解密后的副本。",
  unsupported_type: "请选择 Markdown、TXT、DOCX 或含文本层的 PDF。",
  type_mismatch: "文件内容与扩展名不符，请检查文件格式。",
  file_too_large: "单个文件最多 10 MiB，请拆分后上传。",
  extraction_limit: "可提取的文字超过上限，请拆分文件。",
  expansion_limit: "DOCX 展开内容过大，请拆分文件。",
  parse_timeout: "解析超时，请重试或拆分文件。",
};

function explanation(code?: string) {
  return (code && errors[code]) || "解析未完成，请重新上传。";
}

function useMaterials(id?: string) {
  return useQuery({
    queryKey: materialKey(id),
    queryFn: ({ signal }) => listAiMaterials(id!, signal),
    enabled: Boolean(id),
    refetchInterval: ({ state }) => {
      if (!state.data?.length) return false;
      if (state.data.some((m) => m.status === "parsing")) return 500;
      return Math.max(
        1000,
        Math.min(60_000, ...state.data.map((m) => m.expiresAt * 1000 - Date.now())),
      );
    },
  });
}

type Props = {
  conversationId?: string | undefined;
  ensureConversation: () => Promise<string>;
  selected: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onPendingChange?: (pending: boolean) => void;
};

function selectionError(count: number, size: number) {
  if (count > 5) return "每轮最多使用 5 份材料。";
  if (size > 25 * 1024 * 1024) return "每轮材料合计最多 25 MiB，请分批使用。";
  return "";
}

export function AiMaterials({
  conversationId,
  ensureConversation,
  selected,
  onSelectionChange,
  onPendingChange,
}: Props) {
  const client = useQueryClient();
  const list = useMaterials(conversationId);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(false);
  const [error, setError] = useState("");
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(() => new Map());
  const handled = useRef(new Set<string>());
  const activeId = useRef(conversationId);
  useEffect(() => {
    activeId.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (!list.data || !conversationId) return;
    const ready = new Set(list.data.filter((m) => m.status === "ready").map((m) => m.id));
    const next = selected.filter((id) => ready.has(id));
    for (const m of list.data) {
      if (
        pending.get(m.id) !== conversationId ||
        m.status === "parsing" ||
        handled.current.has(m.id)
      )
        continue;
      handled.current.add(m.id);
      if (m.status === "ready" && !next.includes(m.id)) next.push(m.id);
    }
    if (next.length !== selected.length || next.some((id, index) => id !== selected[index]))
      onSelectionChange(next);
  }, [conversationId, list.data, selected, onSelectionChange, pending]);

  const busy =
    uploading || Boolean(list.data?.some((m) => m.status === "parsing" && pending.has(m.id)));
  useEffect(() => {
    onPendingChange?.(busy);
  }, [busy, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  function total(ids: readonly string[]) {
    return (list.data ?? []).reduce((n, m) => n + (ids.includes(m.id) ? m.size : 0), 0);
  }
  function toggle(id: string, checked: boolean) {
    const next = checked ? [...selected, id] : selected.filter((item) => item !== id);
    const message = selectionError(next.length, total(next));
    setError(message);
    if (!message) onSelectionChange(next);
  }

  async function upload(files: File[]) {
    setNotice(true);
    const message = files.some((f) => !/\.(txt|md|pdf|docx)$/iu.test(f.name))
      ? errors.unsupported_type
      : files.some((f) => f.size > 10 * 1024 * 1024)
        ? errors.file_too_large
        : selectionError(
            selected.length + files.length,
            total(selected) + files.reduce((n, f) => n + f.size, 0),
          );
    setError(message || "");
    setRetryFiles([]);
    if (message) return;
    setPending(new Map());
    handled.current.clear();
    setUploading(true);
    let i = 0;
    try {
      const id = conversationId ?? (await ensureConversation());
      for (; i < files.length; i++) {
        if (activeId.current && activeId.current !== id) return;
        const file = files[i]!;
        const m = await uploadAiMaterial(id, file);
        setPending((previous) => new Map(previous).set(m.id, id));
        await client.cancelQueries({ queryKey: materialKey(id) });
        client.setQueryData<AiMaterialView[]>(materialKey(id), (previous) => [
          ...(previous ?? []).filter((v) => v.id !== m.id),
          m,
        ]);
      }
      await client.invalidateQueries({ queryKey: materialKey(id) });
    } catch (err) {
      setError(err instanceof ApiError ? explanation(err.code) : "上传中断，请重试。");
      setRetryFiles(files.slice(i));
    } finally {
      setUploading(false);
    }
  }

  async function remove(m: AiMaterialView) {
    if (!conversationId) return;
    try {
      await removeAiMaterial(conversationId, m.id);
      setPending((previous) => {
        const next = new Map(previous);
        next.delete(m.id);
        return next;
      });
      await client.cancelQueries({ queryKey: materialKey(conversationId) });
      client.setQueryData<AiMaterialView[]>(
        materialKey(conversationId),
        (previous) => previous?.filter((v) => v.id !== m.id) ?? [],
      );
      client.removeQueries({ queryKey: ["ai-segment", conversationId, m.id] });
      setError("");
    } catch {
      setError("移除失败，请重试。");
    }
  }

  return (
    <section className={styles.materials} aria-label="参考材料">
      <FilePicker files={[]} disabled={busy} onChange={(files) => void upload(files)} />
      {(notice || Boolean(selected.length)) && (
        <p className={styles.hint}>本轮选中材料的实际读取片段会发送给管理员配置的模型供应商。</p>
      )}
      {uploading && <output>正在上传材料…</output>}
      {list.isError && (
        <p role="alert">
          材料列表读取失败。
          <Button type="button" onPress={() => void list.refetch()}>
            重试
          </Button>
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          {retryFiles.length > 0 && (
            <Button type="button" onPress={() => void upload(retryFiles)}>
              重试上传
            </Button>
          )}
        </p>
      )}
      {Boolean(list.data?.length) && (
        <ul className={styles.list}>
          {list.data!.map((m) => (
            <li key={m.id} className={styles.row}>
              <div className={styles.detail}>
                <Checkbox
                  className={styles.check}
                  aria-label={`本轮使用 ${m.name}`}
                  isSelected={selected.includes(m.id)}
                  isDisabled={m.status !== "ready" || busy}
                  onChange={(checked) => toggle(m.id, checked)}
                >
                  <span className={styles.mark} aria-hidden="true" />
                  <span>{m.name}</span>
                </Checkbox>
                <output className={styles.hint}>
                  {m.size < 1024 ? `${m.size} B` : `${Math.ceil(m.size / 1024)} KiB`} ·{" "}
                  {m.status === "ready"
                    ? "就绪"
                    : m.status === "parsing"
                      ? "正在解析…"
                      : explanation(m.errorCode)}
                </output>
              </div>
              <Button
                className={styles.remove}
                type="button"
                aria-label={`移除 ${m.name}`}
                onPress={() => void remove(m)}
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function MaterialCitation({
  conversationId,
  source,
}: {
  conversationId: string;
  source: AiMaterialSource;
}) {
  const list = useMaterials(conversationId);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useId();
  const available =
    source.conversationId === conversationId &&
    (!list.data || list.data.some((m) => m.id === source.materialId && m.status === "ready"));
  const query = useQuery({
    queryKey: ["ai-segment", conversationId, source.materialId, source.segmentId],
    queryFn: ({ signal }) =>
      readAiMaterialSegment(conversationId, source.materialId, source.segmentId, signal),
    enabled: open && available,
    retry: false,
    gcTime: 0,
  });
  const location =
    source.page !== undefined
      ? `第 ${source.page} 页`
      : source.paragraphStart === source.paragraphEnd
        ? `第 ${source.paragraphStart} 段`
        : `第 ${source.paragraphStart}–${source.paragraphEnd} 段`;
  const label = `${source.name} · ${location}`;
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  if (!available || (query.error instanceof ApiError && query.error.status === 404))
    return <span>{label}（材料已失效）</span>;
  return (
    <div className={styles.citation}>
      <Button
        ref={trigger}
        type="button"
        aria-controls={panel}
        aria-expanded={open}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") {
            event.stopPropagation();
            close();
          }
        }}
        onPress={() => (open ? close() : setOpen(true))}
      >
        {label}
      </Button>
      {open && (
        <section id={panel} aria-label={label}>
          {query.isFetching ? (
            <output>正在读取原文…</output>
          ) : query.isError ? (
            <p role="alert">
              片段读取失败。
              <Button type="button" onPress={() => void query.refetch()}>
                重试
              </Button>
            </p>
          ) : (
            <blockquote>{query.data?.text}</blockquote>
          )}
          <Button type="button" onPress={close}>
            收起原文
          </Button>
        </section>
      )}
    </div>
  );
}
