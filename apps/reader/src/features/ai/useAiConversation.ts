import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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

export function useAiConversation(
  workspace: string,
  documentId: string | undefined,
  active: boolean,
  returnTo?: { username: string; id: string },
) {
  const client = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const scope: ConversationScope = { workspaceId: workspace, ...(documentId && { documentId }) };
  const base = [
    ...workspaceKeys.workspace(workspace),
    "ai",
    "conversations",
    session?.username,
    documentId ?? null,
  ] as const;
  const listing = useInfiniteQuery({
    queryKey: base,
    queryFn: ({ signal, pageParam }) => listConversations(scope, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: active && Boolean(session),
  });
  const listed = listing.data?.pages.flatMap((page) => page.items) ?? [];
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
    enabled: active && needsLookup,
    retry: false,
  });
  const extra =
    needsLookup &&
    lookup.data?.workspaceId === workspace &&
    lookup.data.documentId === (documentId ?? null)
      ? lookup.data
      : undefined;
  const conversations = extra ? [extra, ...listed] : listed;
  const id =
    chosen === "recent" || chosen === "new"
      ? undefined
      : selectedId && !(needsLookup && lookup.isError)
        ? selectedId
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
  });
  const creating = useRef<Promise<string> | undefined>(undefined);
  const pendingTurn = useRef<
    { conversation: string; fingerprint: string; input: CreateTurn } | undefined
  >(undefined);
  async function ensureConversation() {
    if (id) return id;
    if (creating.current) return creating.current;
    const task = createConversation(scope).then((c) => {
      pick(c.id);
      void client.invalidateQueries({ queryKey: base, exact: true });
      return c.id;
    });
    creating.current = task;
    try {
      return await task;
    } finally {
      creating.current = undefined;
    }
  }
  async function send(input: Omit<CreateTurn, "clientTurnId">) {
    const conversation = await ensureConversation();
    const fingerprint = JSON.stringify(input);
    let pending = pendingTurn.current;
    if (pending?.conversation !== conversation || pending.fingerprint !== fingerprint) {
      pending = { conversation, fingerprint, input: { ...input, clientTurnId: operationId() } };
      pendingTurn.current = pending;
    }
    const turn = await createTurn(conversation, pending.input);
    pendingTurn.current = undefined;
    void client.invalidateQueries({ queryKey: base });
    return turn;
  }
  async function remove() {
    if (!id) return;
    await deleteConversation(id);
    await client.cancelQueries({ queryKey: base });
    client.removeQueries({ queryKey: [...base, "turns", id] });
    client.removeQueries({
      queryKey: [...workspaceKeys.workspace(workspace), "ai", "operations", documentId ?? null],
    });
    client.removeQueries({ queryKey: [...base, "selected", id] });
    client.removeQueries({ queryKey: ["ai-materials", id] });
    client.removeQueries({ queryKey: ["ai-segment", id] });
    pick("new");
    await client.invalidateQueries({ queryKey: base, exact: true });
  }
  const allTurns: TurnView[] = turnsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const updateOperation = useCallback(
    (operation: AiOperation) => {
      if (!id || !session) return;
      client.setQueryData<InfiniteData<TurnPage>>(
        [
          ...workspaceKeys.workspace(workspace),
          "ai",
          "conversations",
          session.username,
          documentId ?? null,
          "turns",
          id,
        ],
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
    [client, workspace, documentId, id, session],
  );
  const refresh = useCallback(() => {
    void client.invalidateQueries({
      queryKey: [...workspaceKeys.workspace(workspace), "ai", "conversations"],
    });
  }, [client, workspace]);
  return {
    id,
    username: session?.username,
    selection: chosen,
    conversations,
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
