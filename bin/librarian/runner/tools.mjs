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
  const global = input.scope === "global";
  const context = input.context ?? [];
  const workspaces = new Set();
  const knownDocuments = new Map(context.map(entry => [entry.documentId, entry]));
  if (input.documentId && !knownDocuments.has(input.documentId)) knownDocuments.set(input.documentId, {});
  const materials = new Map((input.materials ?? []).map(({ id, name }) => [id, { id, name }]));
  const sourceCache = new Map();
  const sources = new Map();
  const edits = new Map();
  let sourceBytes = 0;
  let targetWorkspaceId;
  let reorganization;
  let action;

  function remember(result, content) {
    if (!sources.has(result.sourceId)) {
      sourceBytes += Buffer.byteLength(content);
      if (sources.size >= 64 || sourceBytes > MAX_SOURCE_BYTES) throw new TaskError("SOURCE_LIMIT");
      sources.set(result.sourceId, result);
    }
    return result;
  }

  async function read({ documentId, outline = false, full = false }) {
    const document = knownDocuments.get(documentId);
    if (!document || (global && !document.workspaceId)) return { unavailable: true };
    const selection = context.find(entry => entry.documentId === documentId);
    const ranged = !outline && selection?.from != null && selection.to != null;
    const requestFull = Boolean(ranged && full);
    const key = JSON.stringify([documentId, outline, requestFull]);
    if (!global && sourceCache.has(key)) return sourceCache.get(key);
    let data;
    try {
      data = await client("sources", "POST", {
        documentId, outline, full: requestFull, ...(global && { workspaceId: document.workspaceId }),
      });
    } catch (error) {
      if (error.code === "not_found") {
        if (outline) return { unavailable: true };
        throw new TaskError("DOCUMENT_UNAVAILABLE");
      }
      throw error;
    }
    const { source, markdown } = data;
    const { id: sourceId, workspaceId, workspaceName, path, revision, from, to, blockId } = source;
    if (global && (source.documentId !== documentId || workspaceId !== document.workspaceId ||
      !sourceId || !workspaceName || !revision || !relativePath(path))) {
      throw new TaskError("INVALID_SOURCE");
    }
    const excerpt = requestFull && sourceCache.get(JSON.stringify([documentId, false, false]));
    if (excerpt && excerpt.revision !== revision) throw new TaskError("revision_conflict", 409);
    // Outline reads identify a sidecar. Transfers always identify the primary document.
    if (global && !outline) knownDocuments.set(documentId, { workspaceId, path });
    const result = remember({
      sourceId, documentId, path, revision, markdown,
      ...(global && { workspaceId, workspaceName }),
      ...(from == null ? {} : { from }),
      ...(to == null ? {} : { to }),
      ...(blockId == null ? {} : { blockId }),
      editable: input.mode === "edit" && (!ranged || requestFull || outline) &&
        from == null && to == null && (!global || blockId == null),
    }, markdown);
    sourceCache.set(key, result);
    return result;
  }

  await progress("正在读取任务上下文。");
  const initial = [];
  for (const documentId of knownDocuments.keys()) initial.push(await read({ documentId }));
  if (input.documentId) initial.push(await read({ documentId: input.documentId, outline: true }));

  function stage(edit, workspaceId, changed = true) {
    if (action || (targetWorkspaceId && targetWorkspaceId !== workspaceId)) throw new TaskError("MIXED_CHANGES");
    if (reorganization || edits.size >= MAX_EDITS || edits.has(edit.path)) throw new TaskError("EDIT_LIMIT");
    if (!changed) return { staged: false };
    if (Buffer.byteLength(JSON.stringify([...edits.values(), edit])) > MAX_EDIT_BYTES) {
      throw new TaskError("EDIT_LIMIT");
    }
    targetWorkspaceId = workspaceId;
    edits.set(edit.path, edit);
    return { staged: true };
  }

  const tools = [
    tool("search_workspace",
      global ? "List or search document metadata in one listed workspace. Read a document before citing it." :
        "List matching documents in the assigned Workspace. Results contain metadata only. Use an empty query to list candidates.",
      { query: { type: "string", required: true }, ...(global && { workspaceId: { type: "string", required: true } }) },
      async ({ query, workspaceId }) => {
        if (Array.from(query).length > 120) throw new TaskError("INVALID_QUERY");
        if (global && !workspaces.has(workspaceId)) return { unavailable: true };
        const params = new URLSearchParams();
        if (global) params.set("workspaceId", workspaceId);
        if (query.trim()) params.set("q", query.trim());
        const hits = await client(params.size ? "documents?" + params : "documents", "GET");
        const documents = hits.slice(0, 16).map(hit => {
          const { id, title, path, outlineEnabled } = hit;
          if (global && hit.workspaceId !== workspaceId) throw new TaskError("INVALID_SOURCE");
          knownDocuments.set(id, { workspaceId, path });
          return { id, title, path, ...(global && { workspaceId }), ...(outlineEnabled == null ? {} : { outlineEnabled }) };
        });
        return { documents };
      }),
    tool("read_document",
      "Read one known document. Set outline for an outline and full for complete Markdown when a selection exists.",
      { documentId: { type: "string", required: true }, outline: { type: "boolean" }, full: { type: "boolean" } },
      read),
  ];

  if (global) {
    tools.push(tool("list_workspaces",
      "List workspaces available to the current user. Use the returned IDs for workspace searches and actions.",
      {}, async () => {
        const rows = await client("workspaces", "GET");
        workspaces.clear();
        const items = rows.map(({ id, name, canWrite, canManage }) => {
          workspaces.add(id);
          return { id, name, canWrite, canManage };
        });
        return { workspaces: items };
      }));
  }

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

  if (global && input.mode === "edit") {
    tools.push(...globalActions(workspaces, knownDocuments, (requested) => {
      if (action || edits.size) throw new TaskError("MIXED_CHANGES");
      action = requested;
      return { staged: true };
    }));
  }

  if (input.mode === "edit") {
    tools.push(tool("submit_document_edits",
      "Stage complete revised Markdown for a previously read editable source. It is written after the turn finishes.",
      { sourceId: { type: "string", required: true }, markdown: { type: "string", required: true } },
      ({ sourceId, markdown }) => {
        const source = sources.get(sourceId);
        if (!source?.editable) throw new TaskError("UNREAD_SOURCE");
        const edit = { path: source.path, baseRevision: source.revision, markdown };
        return stage(edit, source.workspaceId, markdown !== source.markdown);
      }));
    if (global || (input.workspaceId && !input.documentId)) {
      tools.push(
        tool("create_document",
          "Stage new Markdown at a relative Workspace path. The batch can commit only if the new path is still empty.",
          { path: { type: "string", required: true }, markdown: { type: "string", required: true },
            ...(global && { workspaceId: { type: "string", required: true } }) },
          ({ path, markdown, workspaceId }) => {
            if (global && !workspaces.has(workspaceId)) throw new TaskError("UNKNOWN_WORKSPACE");
            if (!relativePath(path) || !path.endsWith(".md") || path.endsWith(".outline.md")) throw new TaskError("INVALID_PATH");
            return stage({ path, baseRevision: null, markdown }, global ? workspaceId : undefined);
          }),
      );
    }
    if (!global && input.workspaceId && !input.documentId) {
      tools.push(
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
                new Set(documentIds).size === documentIds.length && documentIds.every(id => knownDocuments.has(id))) {
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
      ...(global && { scope: "global" }), mode: input.mode, prompt: input.prompt, documentId: input.documentId, history,
      ...(materials.size ? { materials: [...materials.values()] } : {}),
      sources: initial.filter(source => !source.unavailable),
    }),
    tools,
    result(answer) {
      return {
        answer, sourceIds: [...sources.keys()], edits: [...edits.values()],
        ...(targetWorkspaceId && { targetWorkspaceId }),
        ...(reorganization && { reorganization }),
        ...(action && { action }),
      };
    },
  };
}

function globalActions(workspaces, documents, stage) {
  const string = { type: "string", required: true };
  function workspace(id) {
    if (!workspaces.has(id)) throw new TaskError("UNKNOWN_WORKSPACE");
    return id;
  }
  function name(value) {
    if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > 120) {
      throw new TaskError("INVALID_NAME");
    }
    return value.trim();
  }
  const target = {
    action: { ...string, enum: ["move", "copy"] }, targetWorkspaceId: string, targetPath: string,
  };
  function transfer({ action, targetWorkspaceId, targetPath }, sourceWorkspaceId, sourcePath, identity) {
    workspace(sourceWorkspaceId);
    workspace(targetWorkspaceId);
    if (!["move", "copy"].includes(action) || !relativePath(sourcePath) || !relativePath(targetPath) ||
      sourceWorkspaceId === targetWorkspaceId) throw new TaskError("INVALID_TRANSFER");
    return stage({ kind: action, sourceWorkspaceId, sourcePath, targetWorkspaceId, targetPath, ...identity });
  }
  return [
    tool("transfer_document",
      "Request confirmation for a cross-workspace move or copy of a discovered document. Supply the full destination path.",
      { ...target, documentId: string },
      (args) => {
        const doc = documents.get(args.documentId);
        if (!doc?.path) throw new TaskError("INVALID_TRANSFER");
        return transfer(args, doc.workspaceId, doc.path, { documentId: args.documentId });
      }),
    tool("transfer_folder",
      "Request confirmation for a cross-workspace move or copy of a folder. Supply both listed workspace IDs and full relative folder paths.",
      { ...target, sourceWorkspaceId: string, sourcePath: string },
      (args) => transfer(args, args.sourceWorkspaceId, args.sourcePath, { sourceKind: "folder" })),
    tool("create_workspace", "Stage creation of one workspace for the current user.", { name: string },
      (args) => stage({ kind: "create_workspace", name: name(args.name) })),
    tool("rename_workspace", "Stage a new display name for a listed workspace.",
      { workspaceId: string, name: string },
      (args) => stage({ kind: "rename_workspace", workspaceId: workspace(args.workspaceId), name: name(args.name) })),
    tool("set_workspace_member", "Stage addition of a member or a change to that member’s Reader role.",
      { workspaceId: string, username: string, role: { ...string, enum: ["read", "write"] } },
      ({ workspaceId, username, role }) => {
        if (!["read", "write"].includes(role)) throw new TaskError("INVALID_ROLE");
        return stage({ kind: "set_workspace_member", workspaceId: workspace(workspaceId), username: name(username), role });
      }),
    tool("remove_workspace_member", "Stage removal of the specified workspace member.",
      { workspaceId: string, username: string },
      ({ workspaceId, username }) =>
        stage({ kind: "remove_workspace_member", workspaceId: workspace(workspaceId), username: name(username) })),
  ];
}
