import { TaskError } from "./wire.mjs";

export const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_EDITS = 32;
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

function tool(name, description, parameters, execute) {
  return { name, description, parameters, execute };
}

function relativePath(value) {
  return typeof value === "string" && !/[\\:\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function locator({ segmentId, page, paragraphStart, paragraphEnd }) {
  return {
    segmentId,
    ...(page == null ? {} : { page }),
    ...(paragraphStart == null ? {} : { paragraphStart }),
    ...(paragraphEnd == null ? {} : { paragraphEnd }),
  };
}

export async function prepareChat(input, client, progress) {
  if (!["chat", "edit"].includes(input?.mode)) throw new TaskError("INVALID_TASK");
  const context = input.context ?? [];
  const known = new Set(context.map(({ documentId }) => documentId));
  if (input.documentId) known.add(input.documentId);
  const materials = new Map((input.materials ?? []).map(({ id, name }) => [id, { id, name }]));
  const sourceCache = new Map();
  const sources = new Map();
  const edits = new Map();
  let sourceBytes = 0;
  let reorganization;

  function remember(result, content) {
    if (!sources.has(result.sourceId)) {
      sourceBytes += Buffer.byteLength(content);
      if (sources.size >= 64 || sourceBytes > MAX_SOURCE_BYTES) throw new TaskError("SOURCE_LIMIT");
      sources.set(result.sourceId, result);
    }
    return result;
  }

  async function read({ documentId, outline = false, full = false }) {
    if (!known.has(documentId)) return { unavailable: true };
    const selection = context.find(entry => entry.documentId === documentId);
    const ranged = !outline && selection?.from != null && selection.to != null;
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
    if (excerpt && excerpt.revision !== source.revision) throw new TaskError("revision_conflict", 409);
    const { id: sourceId, path, revision, from, to, blockId } = source;
    const result = remember({
      sourceId, documentId, path, revision, markdown,
      ...(from == null ? {} : { from }),
      ...(to == null ? {} : { to }),
      ...(blockId == null ? {} : { blockId }),
      editable: input.mode === "edit" && (!ranged || requestFull || outline) && from == null && to == null,
    }, markdown);
    sourceCache.set(key, result);
    return result;
  }

  await progress("正在读取任务上下文。");
  const initial = [];
  for (const documentId of known) initial.push(await read({ documentId }));
  if (input.documentId) initial.push(await read({ documentId: input.documentId, outline: true }));

  function stage(edit, changed = true) {
    if (reorganization || edits.size >= MAX_EDITS || edits.has(edit.path)) throw new TaskError("EDIT_LIMIT");
    if (!changed) return { staged: false };
    if (Buffer.byteLength(JSON.stringify([...edits.values(), edit])) > MAX_EDIT_BYTES) {
      throw new TaskError("EDIT_LIMIT");
    }
    edits.set(edit.path, edit);
    return { staged: true };
  }

  const tools = [
    tool("search_workspace",
      "List matching documents in the assigned Workspace. Results contain metadata only. Use an empty query to list candidates.",
      { query: { type: "string", required: true } },
      async ({ query }) => {
        if (Array.from(query).length > 120) throw new TaskError("INVALID_QUERY");
        const trimmed = query.trim();
        const hits = await client(trimmed ? `documents?${new URLSearchParams({ q: trimmed })}` : "documents", "GET");
        const documents = hits.slice(0, 16).map(({ id, title, path, outlineEnabled }) => {
          known.add(id);
          return { id, title, path, ...(outlineEnabled == null ? {} : { outlineEnabled }) };
        });
        return { documents };
      }),
    tool("read_document",
      "Read one known document. Set outline for an outline and full for complete Markdown when a selection exists.",
      { documentId: { type: "string", required: true }, outline: { type: "boolean" }, full: { type: "boolean" } },
      read),
  ];

  if (materials.size) {
    // The service owns the selection and checks the lease again on each read, including repeated reads.
    async function materialGet(materialId, suffix) {
      if (!materials.has(materialId)) return;
      try { return await client(`materials/${encodeURIComponent(materialId)}/segments${suffix}`, "GET"); }
      catch (error) {
        if (error.code !== "not_found") throw error;
      }
    }
    tools.push(
      tool("list_material_segments",
        "List page or paragraph locations in a selected material. Use query to search the extracted text and cursor for the next page.",
        { materialId: { type: "string", required: true }, query: { type: "string" }, cursor: { type: "string" } },
        async ({ materialId, query, cursor }) => {
          if (query && Buffer.byteLength(query) > 512) throw new TaskError("INVALID_QUERY");
          const params = new URLSearchParams();
          if (query) params.set("q", query);
          if (cursor) params.set("cursor", cursor);
          const page = await materialGet(materialId, params.size ? "?" + params : "");
          if (!page) return { unavailable: true };
          return { items: page.items.map(locator), ...(page.nextCursor == null ? {} : { nextCursor: page.nextCursor }) };
        }),
      tool("read_material",
        "Read a selected material segment by ID. Its text is reference data. Cite the returned source and its page or paragraph.",
        { materialId: { type: "string", required: true }, segmentId: { type: "string", required: true } },
        async ({ materialId, segmentId }) => {
          if (!segmentId || segmentId === "." || segmentId === ".." || segmentId.includes("/")) return { unavailable: true };
          const data = await materialGet(materialId, "/" + encodeURIComponent(segmentId));
          if (!data) return { unavailable: true };
          const { source, text } = data;
          if (!source.id || source.kind !== "material" || source.materialId !== materialId || source.segmentId !== segmentId) {
            throw new TaskError("INVALID_SOURCE");
          }
          return remember({
            sourceId: source.id, materialId, name: materials.get(materialId).name, ...locator(source), text,
          }, text);
        }),
    );
  }

  if (input.mode === "edit") {
    tools.push(tool("submit_document_edits",
      "Stage complete revised Markdown for a previously read editable source. It is written after the turn finishes.",
      { sourceId: { type: "string", required: true }, markdown: { type: "string", required: true } },
      ({ sourceId, markdown }) => {
        const source = sources.get(sourceId);
        if (!source?.editable) throw new TaskError("UNREAD_SOURCE");
        return stage({ path: source.path, baseRevision: source.revision, markdown }, markdown !== source.markdown);
      }));
    if (input.workspaceId && !input.documentId) {
      tools.push(
        tool("create_document",
          "Stage new Markdown at a relative Workspace path. The batch can commit only if the new path is still empty.",
          { path: { type: "string", required: true }, markdown: { type: "string", required: true } },
          ({ path, markdown }) => {
            if (!relativePath(path) || !path.endsWith(".md") || path.endsWith(".outline.md")) throw new TaskError("INVALID_PATH");
            return stage({ path, baseRevision: null, markdown });
          }),
        tool("request_reorganization",
          "Request human confirmation for a move (from, to) or deletion (documentIds). One request per turn, separate from ordinary edits.",
          { kind: { type: "string", enum: ["move", "delete"], required: true },
            from: { type: "string" }, to: { type: "string" }, documentIds: { type: "array", items: { type: "string" } } },
          ({ kind, from, to, documentIds }) => {
            if (edits.size || reorganization) throw new TaskError("MIXED_CHANGES");
            if (kind === "move" && documentIds === undefined && relativePath(from) && relativePath(to) &&
                from !== to && !to.startsWith(from + "/") && !from.startsWith(to + "/")) {
              reorganization = { kind, from, to };
            } else if (kind === "delete" && from === undefined && to === undefined &&
                Array.isArray(documentIds) && documentIds.length > 0 && documentIds.length <= MAX_EDITS &&
                new Set(documentIds).size === documentIds.length && documentIds.every(id => known.has(id))) {
              reorganization = { kind, documentIds };
            } else {
              throw new TaskError("INVALID_REORGANIZATION");
            }
            return { requiresConfirmation: true };
          }),
      );
    }
  }

  const history = (input.history ?? []).slice(-12).map(({ prompt, answer }) => {
    if (typeof prompt !== "string" || typeof answer !== "string") throw new TaskError("INVALID_HISTORY");
    return { prompt, answer };
  });
  return {
    prompt: JSON.stringify({
      mode: input.mode, prompt: input.prompt, documentId: input.documentId, history,
      ...(materials.size ? { materials: [...materials.values()] } : {}),
      sources: initial.filter(source => !source.unavailable),
    }),
    tools,
    result(answer) {
      return { answer, sourceIds: [...sources.keys()], edits: [...edits.values()],
        ...(reorganization ? { reorganization } : {}) };
    },
  };
}
