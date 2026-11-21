import { TaskError } from "./wire.mjs";

export const MAX_SOURCE_BYTES = 256 * 1024;

export async function prepareChat(input, client, progress) {
  if (!["chat", "edit"].includes(input?.mode)) throw new TaskError("INVALID_TASK");
  const known = new Set(input.context.map(({ documentId }) => documentId));
  if (input.documentId) known.add(input.documentId);
  const sourceCache = new Map();
  const sources = new Map();
  const edits = new Map();
  let sourceBytes = 0;


  async function read({ documentId, outline = false, full = false }) {
    if (!known.has(documentId)) return { unavailable: true };
    const context = input.context.find((entry) => entry.documentId === documentId);
    const ranged = !outline && context?.from != null && context.to != null;
    const requestFull = Boolean(ranged && full);
    const key = JSON.stringify([documentId, outline, requestFull]);
    if (sourceCache.has(key)) return sourceCache.get(key);
    let data;
    try {
      data = await client("sources", "POST", { documentId, outline, full: requestFull });
    } catch (error) {
      if (outline && error.code === "not_found") return { unavailable: true };
      throw error;
    }
    const { source, markdown } = data;
    const excerpt = requestFull && sourceCache.get(JSON.stringify([documentId, false, false]));
    if (excerpt && excerpt.revision !== source.revision)
      throw new TaskError("revision_conflict", 409);
    sourceBytes += Buffer.byteLength(markdown);
    if (sources.size >= 60 || sourceBytes > MAX_SOURCE_BYTES) throw new TaskError("SOURCE_LIMIT");
    const { id: sourceId, path, revision, from, to, blockId } = source;
    const result = {
      sourceId,
      documentId,
      path,
      revision,
      markdown,
      ...(from == null ? {} : { from }),
      ...(to == null ? {} : { to }),
      ...(blockId == null ? {} : { blockId }),
      editable: input.mode === "edit" && (!ranged || requestFull || outline) && from == null && to == null,
    };
    sources.set(sourceId, result);
    sourceCache.set(key, result);
    return result;
  }

  await progress( "正在读取任务上下文。");
  const initial = [];
  for (const documentId of known) initial.push(await read({ documentId }));
  if (input.documentId) initial.push(await read({ documentId: input.documentId, outline: true }));

  function tool(name, description, parameters, execute) {
    return { name, description, parameters, execute };
  }

  const tools = [
    tool(
      "search_workspace",
      "List matching documents in the assigned Workspace. Results contain metadata only. Use an empty query to list candidates.",
      { query: { type: "string", required: true } },
      async ({ query }) => {
        if (Array.from(query).length > 120) throw new TaskError("INVALID_QUERY");
        const trimmed = query.trim();
        const hits = await client(
          trimmed ? `documents?${new URLSearchParams({ q: trimmed })}` : "documents",
          "GET",
        );
        const documents = hits.slice(0, 16).map(({ id, title, path, outlineEnabled }) => {
          known.add(id);
          return { id, title, path, outlineEnabled };
        });
        return { documents };
      },
    ),
    tool(
      "read_document",
      "Read one known document. Set outline for an outline and full for complete Markdown when a selection exists.",
      {
        documentId: { type: "string", required: true },
        outline: { type: "boolean" },
        full: { type: "boolean" },
      },
      read,
    ),
  ];
  if (input.mode === "edit") {
    tools.push(
      tool(
        "submit_document_edits",
        "Stage complete revised Markdown for one previously read editable source. Use each source only once; it is written only after this turn finishes.",
        {
          sourceId: { type: "string", required: true },
          markdown: { type: "string", required: true },
        },
        ({ sourceId, markdown }) => {
          const source = sources.get(sourceId);
          if (!source?.editable) throw new TaskError("UNREAD_SOURCE");
          if (edits.size >= 32 || edits.has(source.path)) throw new TaskError("EDIT_LIMIT");
          const edit = { path: source.path, baseRevision: source.revision, markdown };
          if (Buffer.byteLength(JSON.stringify([...edits.values(), edit])) > 2 * 1024 * 1024) {
            throw new TaskError("EDIT_LIMIT");
          }
          edits.set(source.path, edit);
          return { staged: markdown !== source.markdown };
        },
      ),
    );
  }

  const history = (input.history ?? []).slice(-12).map(({ prompt, answer }) => {
    if (typeof prompt !== "string" || typeof answer !== "string") throw new TaskError("INVALID_HISTORY");
    return { prompt, answer };
  });
  return {
    prompt: JSON.stringify({
      mode: input.mode, prompt: input.prompt, documentId: input.documentId,
      history, sources: initial.filter((source) => !source.unavailable),
    }),
    tools,
    result(answer) {
      const changes = [...edits.values()].filter((edit) => {
        const source = [...sources.values()].find(s => s.path === edit.path && s.editable);
        return edit.markdown !== source.markdown;
      });
      return { answer, sourceIds: [...sources.keys()], edits: changes };
    },
  };
}
