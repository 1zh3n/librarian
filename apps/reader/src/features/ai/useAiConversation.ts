import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createConversation,
  createTurn,
  deleteConversation,
  getConversation,
  listConversations,
  listTurns,
} from "../../api/client";
import type { InfiniteData } from "@tanstack/react-query";
import type {
  AiOperation,
  ConversationScope,
  ConversationView,
  CreateTurn,
  TurnPage,
  TurnView,
} from "../../api/client";
import { operationId } from "../../api/operationId";
import { sessionQuery, workspaceKeys } from "../../api/queries";

function readSelection(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberSelection(key: string, id: string) {
  try {
    sessionStorage.setItem(key, id);
  } catch {
    // In private browsing the selected conversation can still live in React state.
  }
}

function denied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

function inScope(conversation: ConversationView, scope: ConversationScope) {
  return "scope" in scope
    ? conversation.scope === "global"
    : conversation.scope !== "global" &&
        conversation.workspaceId === scope.workspaceId &&
        conversation.documentId === (scope.documentId ?? null);
}

export function useAiConversation(
  workspace: string,
  documentId: string | undefined,
  active: boolean,
  returnTo?: { username: string; id: string },
  global = false,
) {
  const client = useQueryClient();
  const sessionResult = useQuery(sessionQuery);
  const session = sessionResult.isSuccess ? sessionResult.data : undefined;
  const scope: ConversationScope = global
    ? { scope: "global" }
    : { workspaceId: workspace, ...(documentId && { documentId }) };
  const base = useMemo(
    () =>
      global
        ? (["ai", "global", "conversations", session?.username] as const)
        : ([
            ...workspaceKeys.workspace(workspace),
            "ai",
            "conversations",
            session?.username,
            documentId ?? null,
          ] as const),
    [global, workspace, session?.username, documentId],
  );
  const listing = useInfiniteQuery({
    queryKey: base,
    queryFn: ({ signal, pageParam }) => listConversations(scope, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: active && Boolean(session && (global || workspace)),
    staleTime: 0,
  });
  const listed =
    session && !listing.isError && listing.isFetchedAfterMount
      ? (listing.data?.pages.flatMap((page) => page.items.filter((item) => inScope(item, scope))) ??
        [])
      : [];
  const key = JSON.stringify(base);
  const [selection, setSelection] = useState<{ key: string; id: string }>();
  const remembered = session ? readSelection(key) : null;
  const returned = returnTo && returnTo.username === session?.username ? returnTo.id : undefined;
  const chosen = selection?.key === key ? selection.id : (returned ?? remembered);
  useEffect(() => {
    if (returned && selection?.key !== key) rememberSelection(key, returned);
  }, [key, returned, selection]);
  const selectedId = chosen && chosen !== "recent" && chosen !== "new" ? chosen : undefined;
  const needsLookup = Boolean(selectedId && !listed.some((c) => c.id === selectedId));
  const lookup = useQuery({
    queryKey: [...base, "selected", selectedId],
    queryFn: ({ signal }) => getConversation(selectedId!, signal),
    enabled: active && Boolean(session) && !listing.isError && needsLookup,
    staleTime: 0,
    retry: false,
  });
  const lookedUp =
    needsLookup && lookup.isSuccess && lookup.isFetchedAfterMount ? lookup.data : undefined;
  const scopeMismatch = lookedUp !== undefined && !inScope(lookedUp, scope);
  const extra = !scopeMismatch ? lookedUp : undefined;
  const conversations = extra ? [extra, ...listed] : listed;
  const id =
    chosen === "recent" || chosen === "new" || !session || listing.isError
      ? undefined
      : selectedId
        ? conversations.find((item) => item.id === selectedId)?.id
        : listed[0]?.id;
  const pick = (value: string) => {
    rememberSelection(key, value);
    setSelection({ key, id: value });
    pendingTurn.current = undefined;
  };
  const turnsKey = [...base, "turns", id] as const;
  const turnsQuery = useInfiniteQuery({
    queryKey: turnsKey,
    queryFn: ({ signal, pageParam }) => listTurns(id!, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor,
    enabled: active && Boolean(id),
    staleTime: 0,
  });
  const creating = useRef(new Map<string, Promise<string>>());
  const pendingTurn = useRef<
    { conversation: string; fingerprint: string; input: CreateTurn } | undefined
  >(undefined);
  async function ensureConversation() {
    if (!session || accessDenied)
      throw new ApiError(403, "access_denied", "Conversation access unavailable");
    if (id) return id;
    const underway = creating.current.get(key);
    if (underway) return underway;
    if (selectedId) throw new ApiError(404, "not_found", "Conversation unavailable");
    const task = createConversation(scope)
      .catch(recheckAccess)
      .then((c) => {
        client.setQueryData([...base, "selected", c.id], c);
        pick(c.id);
        void client.invalidateQueries({ queryKey: base, exact: true });
        return c.id;
      });
    creating.current.set(key, task);
    try {
      return await task;
    } finally {
      creating.current.delete(key);
    }
  }
  async function recheckAccess(error: unknown): Promise<never> {
    if (denied(error)) await client.resetQueries({ queryKey: base });
    throw error;
  }
  async function send(input: Omit<CreateTurn, "clientTurnId">) {
    const conversation = await ensureConversation();
    const fingerprint = JSON.stringify(input);
    let pending = pendingTurn.current;
    if (pending?.conversation !== conversation || pending.fingerprint !== fingerprint) {
      pending = { conversation, fingerprint, input: { ...input, clientTurnId: operationId() } };
      pendingTurn.current = pending;
    }
    const turn = await createTurn(conversation, pending.input).catch(recheckAccess);
    pendingTurn.current = undefined;
    void client.invalidateQueries({ queryKey: base });
    return turn;
  }
  async function remove() {
    if (!id) return;
    await deleteConversation(id).catch(recheckAccess);
    await client.cancelQueries({ queryKey: base });
    client.removeQueries({ queryKey: [...base, "turns", id] });
    if (!global)
      client.removeQueries({
        queryKey: [...workspaceKeys.workspace(workspace), "ai", "operations", documentId ?? null],
      });
    client.removeQueries({ queryKey: [...base, "selected", id] });
    client.removeQueries({ queryKey: ["ai-materials", id] });
    client.removeQueries({ queryKey: ["ai-segment", id] });
    pick("new");
    await client.invalidateQueries({ queryKey: base, exact: true });
  }
  const accessDenied =
    scopeMismatch ||
    denied(sessionResult.error) ||
    denied(listing.error) ||
    (needsLookup && denied(lookup.error)) ||
    denied(turnsQuery.error);
  const allTurns: TurnView[] =
    id && !accessDenied && turnsQuery.isFetchedAfterMount
      ? (turnsQuery.data?.pages.flatMap((page) => page.items) ?? [])
      : [];
  const updateOperation = useCallback(
    (operation: AiOperation) => {
      if (!id || !session) return;
      client.setQueryData<InfiniteData<TurnPage>>(
        [...base, "turns", id],
        (previous) =>
          previous && {
            ...previous,
            pages: previous.pages.map((page) => ({
              ...page,
              items: page.items.map((turn) =>
                turn.operationId === operation.id ? { ...turn, operation } : turn,
              ),
            })),
          },
      );
    },
    [client, base, id, session],
  );
  const refresh = useCallback(() => {
    void client.invalidateQueries({
      queryKey: base,
    });
  }, [client, base]);
  return {
    id,
    username: session?.username,
    selection: chosen,
    accessDenied,
    conversations: accessDenied ? [] : conversations,
    listing,
    turnsQuery,
    allTurns,
    updateOperation,
    ensureConversation,
    send,
    remove,
    pick,
    refresh,
  };
}
