import { Feedback } from "../../ui/Feedback";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../api/client";
import type { DocumentSummary } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import styles from "./DocumentPage.module.css";

function ReferenceList({ title, items }: { title: string; items: readonly DocumentSummary[] }) {
  return (
    <div>
      <h2 className={styles.referenceHeading}>{title}</h2>
      {items.length === 0 ? (
        <p className={styles.referenceNotice}>暂无</p>
      ) : (
        <ul className={styles.referenceList}>
          {items.map((item) => (
            <li key={item.id}>
              <Link
                to="/workspaces/$workspaceId/documents/$documentId"
                params={{ workspaceId: item.workspaceId, documentId: item.id }}
                title={item.path}
              >
                {item.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DocumentReferencesPanel({
  workspace,
  document,
}: {
  workspace: string;
  document: string;
}) {
  const references = useQuery({
    queryKey: [...workspaceKeys.references(workspace), document],
    queryFn: ({ signal }) => api.getDocumentReferences(document, signal),
  });
  return (
    <section className={styles.metadata} aria-label="文档引用">
      {references.isPending ? (
        <Feedback tone="status" className={styles.referenceNotice}>
          正在查找引用…
        </Feedback>
      ) : references.isError ? (
        <Feedback className={styles.referenceNotice} tone="error">
          无法读取引用
        </Feedback>
      ) : (
        <>
          <ReferenceList title="本篇引用" items={references.data.outgoing} />
          <ReferenceList title="引用本篇" items={references.data.backlinks} />
          {references.data.partial && <p className={styles.referenceNotice}>仅显示已检索的引用</p>}
        </>
      )}
    </section>
  );
}
