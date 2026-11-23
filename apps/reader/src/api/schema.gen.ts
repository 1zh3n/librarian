// Generated from api/librarian.openapi.json. Run npm run api:generate -w @librarian/reader.

export interface paths {
  "/accounts": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAccounts"];
    put?: never;
    post: operations["createAccount"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/accounts/{username}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: operations["updateAccount"];
    trace?: never;
  };
  "/accounts/{username}/password": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["replaceAccountPassword"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/accounts/{username}/sessions/revoke": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["revokeAccountSessions"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/password": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["changeOwnPassword"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/members": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listWorkspaceMembers"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/members/{username}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["setWorkspaceMember"];
    post?: never;
    delete: operations["removeWorkspaceMember"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getSession"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/logout": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["logoutSession"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/backup": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getBackupSettings"];
    put: operations["saveBackupSettings"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/backup/jobs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startBackupJob"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/backup/jobs/{job}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getBackupJob"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications/targets": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPublicationTargets"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPublications"];
    put?: never;
    post: operations["createPublication"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications/{publication}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getPublication"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications/{publication}/confirm": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["confirmPublication"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["health"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listWorkspaces"];
    put?: never;
    post: operations["createWorkspace"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/documents": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    get: operations["listDocuments"];
    put?: never;
    post: operations["createDocument"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get: operations["getDocument"];
    put: operations["saveDocument"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/search": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    get: operations["searchDocuments"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/references": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get: operations["getDocumentReferences"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/outline": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get: operations["getOutline"];
    put: operations["saveOutline"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/revisions": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get: operations["getDocumentHistory"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/revisions/{commit}/diff": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
        commit: string;
      };
      cookie?: never;
    };
    get: operations["getVersionDiff"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/restore": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["restoreDocument"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/devices/{device}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device: string;
      };
      cookie?: never;
    };
    get: operations["getDevicePreferences"];
    put: operations["saveDevicePreferences"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAiOperations"];
    put?: never;
    post: operations["createAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getAiOperation"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["replayAiEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/confirm": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["confirmAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/undo": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["undoAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["claimAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["readAiSource"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/result": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["finishAiOperation"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/diff": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["diffAiOperationFile"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/documents": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["discoverAiDocuments"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["reportAiRunnerEvent"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/renew": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["renewAiLease"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/fail": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["failAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: operations["updateWorkspace"];
    trace?: never;
  };
  "/workspaces/{workspace}/rename": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["renameWorkspacePaths"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/deliveries": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listWorkspaceDeliveries"];
    put?: never;
    post: operations["deliverWorkspaceFiles"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/delivery-tokens": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listDeliveryTokens"];
    put?: never;
    post: operations["issueDeliveryToken"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/delivery-tokens/{token}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["revokeDeliveryToken"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/assets/{path}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["readWorkspaceAttachment"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/snapshots": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listSnapshots"];
    put?: never;
    post: operations["createSnapshot"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/snapshots/{snapshot}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getReaderSnapshot"];
    put?: never;
    post?: never;
    delete: operations["revokeSnapshot"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/snapshots/{snapshot}/assets/{path}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["readSnapshotAttachment"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/discover": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["discoverAiModels"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getAiSettings"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/connections": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["createAiConnection"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/connections/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["removeAiConnection"];
    options?: never;
    head?: never;
    patch: operations["updateAiConnection"];
    trace?: never;
  };
  "/ai/settings/preference": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["setAiPreference"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/default": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["setAiDefault"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/global-enabled": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["setAiGlobalEnabled"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/managed-activation": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["activateManagedAi"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/connections/{id}/probe": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startAiProbe"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/settings/probes/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    get: operations["getAiProbe"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Use scope=global for account-wide conversations. For a scoped conversation supply workspaceId and optionally documentId. */
    get: operations["listConversations"];
    put?: never;
    post: operations["createConversation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations/{conversationId}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    get: operations["getConversation"];
    put?: never;
    post?: never;
    delete: operations["deleteConversation"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations/{conversationId}/turns": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    get: operations["listTurns"];
    put?: never;
    post: operations["createTurn"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations/{conversationId}/turns/{turnId}/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
        turnId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["cancelTurn"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations/{conversationId}/materials": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    get: operations["listAiMaterials"];
    put?: never;
    post: operations["uploadAiMaterial"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations/{conversationId}/materials/{materialId}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
        materialId: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["removeAiMaterial"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations/{conversationId}/materials/{materialId}/segments": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
        materialId: string;
      };
      cookie?: never;
    };
    get: operations["listAiMaterialSegments"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/conversations/{conversationId}/materials/{materialId}/segments/{segmentId}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
        materialId: string;
        segmentId: string;
      };
      cookie?: never;
    };
    get: operations["readAiMaterialSegment"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/heartbeat": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["heartbeatManagedRunner"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["claimManagedTask"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/documents": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Global claims require workspaceId. Scoped claims remain bound to their original workspace. */
    get: operations["discoverAiDocumentsV2"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["readAiSourceV2"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["reportAiRunnerEventV2"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/renew": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["renewAiLeaseV2"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/fail": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["failAiOperationV2"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/result": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["finishAiOperationV2"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/provider": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    get: operations["getManagedProvider"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/materials/{materialId}/segments": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
        materialId: string;
      };
      cookie?: never;
    };
    get: operations["findLeasedMaterialSegments"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/materials/{materialId}/segments/{segmentId}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
        materialId: string;
        segmentId: string;
      };
      cookie?: never;
    };
    get: operations["readLeasedMaterialSegment"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{id}/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["cancelAiConfirmation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/imports": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Import a group of files into a workspace directory */
    post: operations["importWorkspaceFiles"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/imports/{operationId}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        operationId: string;
      };
      cookie?: never;
    };
    /** Read the original account’s workspace import receipt */
    get: operations["getWorkspaceImport"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/folders": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listWorkspaceFolders"];
    put?: never;
    post: operations["createWorkspaceFolder"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/file-actions/preview": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["previewWorkspaceFileAction"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/file-actions/apply": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["applyWorkspaceFileAction"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/file-actions/undo": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["undoWorkspaceFileAction"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/file-actions/deleted": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description List restorable deletions by the current account in this managed workspace, most recent first. Requires write access. */
    get: operations["listDeletedWorkspaceFileActions"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/v2/claims/{lease}/workspaces": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAiWorkspacesV2"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/mcp/settings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getMcpSettings"];
    put: operations["updateMcpSettings"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/mcp/grants": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listMcpGrants"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/mcp/grants/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["revokeMcpGrant"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/assets": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["uploadWorkspaceAsset"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/sessions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAccountSessions"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/sessions/revoke-others": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["revokeOtherAccountSessions"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/sessions/{session}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["revokeAccountSession"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/totp": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getTotpStatus"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/totp/start": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startTotp"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/totp/verify": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["verifyTotp"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/totp/disable": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["disableTotp"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/step-up": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["stepUp"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/accounts/{username}/totp/reset": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["resetTotp"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/invites": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listInvites"];
    put?: never;
    post: operations["createInvite"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/invites/{token}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getInvite"];
    put?: never;
    post?: never;
    delete: operations["revokeInvite"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/invites/{token}/accept": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["acceptInvite"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/audit": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAudit"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/audit.csv": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["exportAudit"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    AccountSummary: {
      username: string;
      isAdmin: boolean;
      disabled: boolean;
    };
    CreateAccount: {
      username: string;
      /** Format: password */
      password: string;
    };
    UpdateAccount: {
      disabled: boolean;
    };
    ReplaceAccountPassword: {
      /** Format: password */
      password: string;
    };
    ChangeOwnPassword: {
      /** Format: password */
      currentPassword: string;
      /** Format: password */
      password: string;
    };
    WorkspaceMember: {
      username: string;
      isOwner: boolean;
      /** @enum {string} */
      role: "read" | "write";
    };
    SetWorkspaceMember: {
      /** @enum {string} */
      role: "read" | "write";
    };
    BrowserSession: {
      username: string;
      cacheId: string;
      isAdmin: boolean;
    };
    ConfiguredTarget: {
      id: string;
      label: string;
    };
    BackupTargetSummary: {
      id: string;
      label: string;
      /** @enum {string} */
      kind: "github" | "git" | "local";
      repositoryLabel: string | null;
      branch: string;
    };
    SaveBackupSettings: {
      targetId: string | null;
      /** @enum {string} */
      mode: "grouped" | "each-operation";
    };
    BackupSettings: {
      targets: components["schemas"]["BackupTargetSummary"][];
      targetId: string | null;
      /** @description A previously selected deployment target has been removed or changed. */
      targetNeedsSelection: boolean;
      /** @enum {string} */
      mode: "grouped" | "each-operation";
      lastJob: components["schemas"]["BackupJob"] | null;
    };
    BackupJob: {
      id: string;
      workspaceId: string;
      /** @enum {string} */
      status: "queued" | "succeeded" | "failed";
      sourceCommitId: string;
      commitId: string | null;
      message: string | null;
    };
    CreatePublication: {
      workspaceId: string;
      targetId: string;
      commitId: string;
      documentIds: string[];
      /** Format: uuid */
      operationId: string;
      /** @default false */
      confirm: boolean;
      /** @description Short-lived step-up token when TOTP is enabled. */
      stepUpToken?: string;
    };
    Publication: {
      /** Format: uuid */
      id: string;
      workspaceId: string;
      targetId: string;
      documentIds: string[];
      /** @enum {string} */
      status: "pending" | "published" | "failed";
      sourceCommitId: string;
      publishedCommitId: string | null;
      url: string | null;
      message: string | null;
    };
    Workspace: {
      id: string;
      spaceId: string;
      name: string;
      /** @enum {string} */
      origin: "native" | "delivery";
      /** @enum {string} */
      retention: "persistent" | "temporary";
      /** @enum {string} */
      revisionMode: "managed" | "repository" | "disabled";
      defaults: {
        outlineEnabled: boolean;
      };
      canWrite: boolean;
      expiresAt: number | null;
      canManage: boolean;
      /** @enum {string} */
      securityLevel: "public" | "internal" | "confidential" | "secret";
      capabilities: {
        externalAi: boolean;
        externalMcp: boolean;
        anonymousShare: boolean;
        publication: boolean;
        offline: boolean;
        remoteBackup: boolean;
      };
    };
    DocumentSummary: {
      id: string;
      workspaceId: string;
      path: string;
      title: string;
      outlineEnabled: boolean;
    };
    DocumentReferences: {
      outgoing: components["schemas"]["DocumentSummary"][];
      backlinks: components["schemas"]["DocumentSummary"][];
      /** @description A scan or result limit may have omitted some references. */
      partial: boolean;
    };
    DocumentSnapshot: {
      document: components["schemas"]["DocumentSummary"];
      markdown: string;
      revision: string;
      documentId: components["schemas"]["DocumentMemberLink"]["documentId"];
      path: components["schemas"]["DocumentMemberLink"]["path"];
      readerPath: components["schemas"]["DocumentMemberLink"]["readerPath"];
      readerUrl: components["schemas"]["DocumentMemberLink"]["readerUrl"];
      readerUrlError?: components["schemas"]["DocumentMemberLink"]["readerUrlError"];
    };
    WriteMarkdown: {
      markdown: string;
      baseRevision: string;
    };
    CreateDocument: {
      path: string;
      markdown: string;
      baseRevision: null;
    };
    ApiError: {
      code: string;
      message: string;
      /** @description Content policy rule that blocked the request. */
      ruleId?: string;
      /** @description Seconds to wait before retrying a rate-limited request. */
      retryAfter?: number;
      currentRevision?: string;
    };
    SearchHit: {
      document: components["schemas"]["DocumentSummary"];
      excerpt: string;
    };
    OutlineSnapshot: {
      markdown: string;
      revision: string | null;
    };
    SaveOutline: {
      markdown: string;
      baseRevision: string | null;
    };
    RevisionEntry: {
      commitId: string;
      timestamp: number;
      author: string;
      message: string;
      added: number;
      removed: number;
    };
    DocumentHistory: {
      /** @enum {string} */
      mode: "managed" | "repository";
      revisions: components["schemas"]["RevisionEntry"][];
      uncommitted: boolean;
      more: boolean;
    };
    VersionDiff: {
      commitId: string;
      diff: string;
      markdown: string | null;
    };
    RestoreRevision: {
      commitId: string;
      baseRevision: string;
    };
    RestoredDocument: {
      commitId: string;
      snapshot: components["schemas"]["DocumentSnapshot"];
    };
    DevicePreferences: {
      /** @enum {string} */
      theme: "system" | "light" | "dark";
      /** @enum {string} */
      font: "serif" | "sans";
      /** @enum {string} */
      layout: "reading" | "writing" | "research" | "review" | "custom";
      fontSize: number;
      lineHeight: number;
      measure: number;
      navigation: boolean | null;
      sidebarWidth: number;
      toolsWidth: number;
      eink: boolean;
      reduceMotion: boolean;
      focusKey: string;
    };
    /** @enum {string} */
    AiMode: "chat" | "edit";
    AiContext: {
      documentId: string;
      revision?: string | null;
      from?: number;
      to?: number;
      blockId?: string | null;
    };
    AiTask: {
      workspaceId: string;
      documentId?: string | null;
      mode: components["schemas"]["AiMode"];
      prompt: string;
      context?: components["schemas"]["AiContext"][];
    };
    AiSourceReference: {
      id: string;
      documentId: string;
      path: string;
      revision: string;
      blockId?: string;
      from?: number;
      to?: number;
      workspaceId?: string;
      workspaceName?: string;
    };
    MutationFileChange: {
      path: string;
      beforeRevision: string | null;
      revision: string | null;
    };
    MutationReceipt: {
      operationId: string;
      workspaceId: string;
      commitId: string;
      changes: components["schemas"]["MutationFileChange"][];
    };
    AiConfirmation: {
      id: string;
      paths: string[];
      plan?: components["schemas"]["AiReorganizationPlan"];
      transfer?: components["schemas"]["AiTransferPreview"];
    };
    AiOperation: {
      id: string;
      documentId: string | null;
      mode: components["schemas"]["AiMode"];
      /** @enum {string} */
      status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "conflict"
        | "needs_confirmation"
        | "canceled";
      answer: string | null;
      sources: (
        | components["schemas"]["AiSourceReference"]
        | components["schemas"]["AiMaterialSource"]
      )[];
      commitId: string | null;
      confirmation: components["schemas"]["AiConfirmation"] | null;
      undoCommitId: string | null;
      changes: components["schemas"]["MutationFileChange"][];
      writeResult?: components["schemas"]["AiWriteResult"];
      selection?: components["schemas"]["ModelSelection"];
      /** @description Destination of an ordinary global document write. */
      targetWorkspaceId?: string;
      workspaceManagement?: components["schemas"]["AiWorkspaceManagementReceipt"];
      transferResult?: components["schemas"]["AiTransferReceipt"];
    } & (
      | {
          workspaceId: string;
          scope?: never;
        }
      | {
          /** @enum {string} */
          scope: "global";
          workspaceId?: never;
          documentId?: null;
        }
    );
    AiClaim: {
      operationId: string;
      leaseId: string;
      expiresAt: number;
      input: components["schemas"]["AiTask"];
    };
    AiSourceRequest: {
      documentId: string;
      outline?: boolean;
      full?: boolean;
    };
    AiSourceData: {
      source: components["schemas"]["AiSourceReference"];
      markdown: string;
    };
    AiFileEdit: {
      path: string;
      baseRevision: string | null;
      markdown: string | null;
    };
    AiRunnerResult: {
      answer: string;
      sourceIds?: string[];
      edits?: components["schemas"]["AiFileEdit"][];
    };
    AiConfirmRequest: {
      confirmationId: string;
    };
    AiOperationDiff: {
      commitId: string;
      path: string;
      diff: string;
    };
    AiRunnerEvent: {
      executorSeq: number;
      /** @enum {string} */
      kind: "progress" | "text_delta";
      text: string;
    };
    AiEventReceipt: {
      sequence: number;
    };
    AiLeaseRenewal: {
      expiresAt: number;
    };
    AiRunnerFailure: {
      text: string;
    };
    CreateWorkspace: {
      name: string;
      /** @enum {string} */
      origin?: "native" | "delivery";
      /** @enum {string} */
      retention?: "persistent" | "temporary";
      expiresAt?: number | null;
      /** @enum {string} */
      securityLevel?: "public" | "internal" | "confidential" | "secret";
    };
    UpdateWorkspace: {
      name?: string;
      /** @enum {string} */
      retention?: "persistent" | "temporary";
      expiresAt?: number | null;
      /** @enum {string} */
      securityLevel?: "public" | "internal" | "confidential" | "secret";
      /** @description Set to true to lower the workspace security level. */
      confirmSecurityDowngrade?: boolean;
      /** @description Short-lived step-up token required when the account has TOTP enabled. */
      stepUpToken?: string;
    };
    RenameWorkspacePaths: {
      operationId: string;
      from: string;
      to: string;
      /** @description Stable ID of the selected document. If it no longer occupies the source path in this workspace, the server returns 409 rename_source_changed. Omit for path-based operations, including directory moves. */
      expectedDocumentId?: string;
    };
    DeliveryManifest: {
      deliveryId: string;
      sourceName: string;
      version?: string | null;
      /** Format: date-time */
      generatedAt?: string | null;
    };
    DeliveryFile: {
      path: string;
      contentBase64: string;
    };
    DeliveryRequest:
      | {
          manifest: components["schemas"]["DeliveryManifest"];
          files: components["schemas"]["DeliveryFile"][];
        }
      | {
          manifest: components["schemas"]["DeliveryManifest"];
          archiveBase64: string;
        };
    DeliveryReceipt: {
      deliveryId: string;
      workspaceId: string;
      operationId: string;
      commitId: string;
      manifest: components["schemas"]["DeliveryManifest"];
      changes: components["schemas"]["MutationFileChange"][];
    };
    DeliveryToken: {
      id: string;
      name: string;
      revoked: boolean;
      deliveryId: string | null;
      expiresAt: number | null;
    };
    NewDeliveryToken: {
      name: string;
      deliveryId: string;
    };
    IssuedDeliveryToken: {
      id: string;
      name: string;
      revoked: boolean;
      token: string;
      deliveryId: string | null;
      expiresAt: number | null;
    };
    CreateSnapshot: {
      /** @enum {string} */
      kind: "current" | "release";
      /** @enum {string} */
      audience?: "members" | "share";
      documentIds: string[];
      attachmentPaths?: string[];
      expiresAt?: number | null;
      commitId?: string | null;
      /** @description Short-lived step-up token for an anonymous share when TOTP is enabled. */
      stepUpToken?: string;
    };
    SnapshotLink: {
      id: string;
      url: string;
    };
    SnapshotLinkSummary: {
      id: string;
      url: string;
      /** @enum {string} */
      kind: "current" | "release";
      /** @enum {string} */
      audience: "members" | "share";
      expiresAt: number | null;
      commitId: string | null;
      documentCount: number;
    };
    SnapshotDocumentSummary: {
      id: string;
      path: string;
      title: string;
    };
    SnapshotDocument: {
      id: string;
      path: string;
      title: string;
      markdown: string;
      revision: string;
    };
    ReaderSnapshot: {
      id: string;
      workspaceId: string;
      /** @enum {string} */
      kind: "current" | "release";
      /** @enum {string} */
      audience: "members" | "share";
      expiresAt: number | null;
      commitId: string | null;
      documents: components["schemas"]["SnapshotDocumentSummary"][];
      document: components["schemas"]["SnapshotDocument"];
      attachmentPaths: string[];
    };
    AiDiscoveryInput:
      | components["schemas"]["DraftAiDiscovery"]
      | {
          connectionId: string;
        };
    DiscoveredModel: {
      id: string;
      name?: string;
      inputModalities?: string[];
      outputModalities?: string[];
      effort?: {
        supportedLevels: string[];
        defaultLevel?: string;
      };
      contextWindow?: number;
      maxOutputTokens?: number;
    };
    AiDiscovery: {
      discoveryId: string;
      /**
       * Format: int64
       * @description Unix timestamp in seconds
       */
      fetchedAt: number;
      models: components["schemas"]["DiscoveredModel"][];
    };
    DraftAiDiscovery: {
      /** @enum {string} */
      provider: "deepseek";
      /** Format: uri */
      baseUrl: string;
      /** Format: password */
      apiKey: string;
    };
    ThinkingSelection:
      | {
          /** @enum {string} */
          mode: "provider_default" | "off";
        }
      | {
          /** @enum {string} */
          mode: "effort";
          level: string;
        };
    ModelSelection: {
      connectionId: string;
      modelId: string;
      thinking: components["schemas"]["ThinkingSelection"];
    };
    AiConnection: {
      id: string;
      label: string;
      /** @enum {string} */
      provider: "deepseek";
      version: number;
      enabled: boolean;
      models: components["schemas"]["DiscoveredModel"][];
      fetchedAt: number;
      baseUrl?: string;
      hasApiKey?: boolean;
      credentialAvailable?: boolean;
    };
    AiSettingsView: {
      settingsVersion: number;
      globalEnabled: boolean;
      /** @enum {string} */
      dispatchMode: "legacy" | "managed";
      runnerOnline: boolean;
      connections: components["schemas"]["AiConnection"][];
      defaultSelection: components["schemas"]["ModelSelection"] | null;
      preference: components["schemas"]["ModelSelection"] | null;
      effectiveSelection: components["schemas"]["ModelSelection"] | null;
      fallbackReason: string | null;
    };
    CreateAiConnection: {
      label: string;
      /** @enum {string} */
      provider: "deepseek";
      baseUrl: string;
      discoveryId: string;
      keyChange: {
        /** @enum {string} */
        kind: "replace";
        /** Format: password */
        apiKey: string;
      };
    };
    UpdateAiConnection: {
      expectedVersion: number;
      label?: string;
      /** @enum {string} */
      provider?: "deepseek";
      baseUrl?: string;
      discoveryId?: string;
      keyChange?:
        | {
            /** @enum {string} */
            kind: "replace";
            /** Format: password */
            apiKey: string;
          }
        | {
            /** @enum {string} */
            kind: "keep" | "clear";
          };
      enabled?: boolean;
    };
    ManagedActivation: {
      activationId: string;
      expectedSettingsVersion: number;
      selection: components["schemas"]["ModelSelection"];
    };
    AiProbeInput: {
      modelId: string;
      thinking: components["schemas"]["ThinkingSelection"];
    };
    AiProbe: {
      id: string;
      status: string;
      errorCode?: string | null;
    };
    ConversationScope:
      | {
          workspaceId: string;
          documentId?: string | null;
        }
      | {
          /** @enum {string} */
          scope: "global";
        };
    ConversationView: {
      id: string;
      documentId: string | null;
      createdAt: number;
      updatedAt: number;
      /** @description First currently visible prompt, shortened for history. Absent on older servers. */
      title?: string | null;
    } & (
      | {
          workspaceId: string;
          scope?: never;
        }
      | {
          /** @enum {string} */
          scope: "global";
          workspaceId?: never;
          documentId?: null;
        }
    );
    CreateTurn: {
      clientTurnId: string;
      /** @enum {string} */
      mode: "chat" | "edit";
      prompt: string;
      context?: components["schemas"]["AiContext"][];
      retryOfTurnId?: string;
      materialIds?: string[];
    };
    TurnView: {
      id: string;
      conversationId: string;
      clientTurnId: string;
      operationId: string;
      prompt: string;
      retryOfTurnId: string | null;
      createdAt: number;
      historyTruncated: boolean;
      operation: components["schemas"]["AiOperation"];
    };
    TurnPage: {
      items: components["schemas"]["TurnView"][];
      nextCursor?: string;
    };
    ConversationPage: {
      items: components["schemas"]["ConversationView"][];
      nextCursor?: string;
    };
    AiMaterialView: {
      id: string;
      name: string;
      status: string;
      size: number;
      expiresAt: number;
      errorCode?: string;
    };
    AiSegmentLocation: {
      segmentId: string;
      page?: number;
      paragraphStart?: number;
      paragraphEnd?: number;
    };
    AiMaterialSegment: {
      segmentId: string;
      page?: number;
      paragraphStart?: number;
      paragraphEnd?: number;
      text: string;
    };
    AiMaterialSource: {
      id: string;
      /** @enum {string} */
      kind: "material";
      conversationId: string;
      materialId: string;
      name: string;
      segmentId: string;
      page?: number;
      paragraphStart?: number;
      paragraphEnd?: number;
    };
    AiLeasedSelection: {
      maxOutputTokens?: number;
      modelId: string;
      thinking: components["schemas"]["ThinkingSelection"];
    };
    AiClaimInput: components["schemas"]["AiOperationInput"] & {
      history?: {
        prompt: string;
        answer: string;
      }[];
      historyTruncated?: boolean;
      materials?: {
        id: string;
        name: string;
      }[];
    };
    AiManagedClaim:
      | {
          leaseId: string;
          operationId: string;
          expiresAt: number;
          selection: components["schemas"]["AiLeasedSelection"];
          /** @enum {string} */
          taskKind: "chat";
          input: components["schemas"]["AiClaimInput"];
        }
      | {
          leaseId: string;
          operationId: string;
          expiresAt: number;
          selection: components["schemas"]["AiLeasedSelection"];
          /** @enum {string} */
          taskKind: "probe";
        };
    AiReorganizationRequest:
      | {
          /** @enum {string} */
          kind: "move";
          from: string;
          to: string;
        }
      | {
          /** @enum {string} */
          kind: "delete";
          documentIds: string[];
        };
    AiReorganizationPlan: {
      request: components["schemas"]["AiReorganizationRequest"];
      changes: components["schemas"]["MutationFileChange"][];
      pathLinks: {
        from: string;
        to: string;
      }[];
      partialLinks: boolean;
    };
    AiWriteResult: {
      created: number;
      updated: number;
      documents: {
        documentId: string;
        path: string;
        readerPath: string;
      }[];
    };
    AiManagedEdit:
      | {
          path: string;
          baseRevision: string | null;
          markdown: string | null;
        }
      | {
          documentId: string;
          baseRevision: string;
          markdown: string | null;
        };
    AiManagedResult: {
      answer: string;
      sourceIds?: string[];
    } & (
      | {
          edits?: components["schemas"]["AiManagedEdit"][];
          reorganization?: components["schemas"]["AiReorganizationRequest"];
          targetWorkspaceId?: never;
          action?: never;
        }
      | {
          targetWorkspaceId: string;
          edits: components["schemas"]["AiManagedEdit"][];
          action?: never;
          reorganization?: never;
        }
      | {
          action:
            | components["schemas"]["AiTransferAction"]
            | components["schemas"]["AiWorkspaceManagementAction"];
          /** @constant */
          edits?: never[];
          targetWorkspaceId?: never;
          reorganization?: never;
        }
    );
    DocumentMemberLink: {
      /** @description Stable member document ID. */
      documentId: string;
      /** @description Actual path in the workspace. */
      path: string;
      /** @description Relative member Reader route. */
      readerPath: string;
      /**
       * Format: uri
       * @description Absolute member link derived from the configured publicReaderUrl, or null.
       */
      readerUrl: string | null;
      /**
       * @description Returned when the public Reader base URL is unset.
       * @enum {string}
       */
      readerUrlError?: "reader_url_unavailable";
    };
    WorkspaceImportUpdate: {
      /** @description File path relative to targetDirectory. */
      path: string;
      baseRevision: string;
    };
    WorkspaceImportFile: {
      path: string;
      contentBase64: string;
    };
    /** @description Create a file group or unpack one ZIP archive. Reuse the operation ID for identical retries. Replacing a file requires a matching update revision. */
    WorkspaceImportRequest:
      | {
          /** Format: uuid */
          operationId: string;
          /** @description Relative workspace directory. Use an empty string for the workspace root. */
          targetDirectory: string;
          updates?: components["schemas"]["WorkspaceImportUpdate"][];
          files: components["schemas"]["WorkspaceImportFile"][];
          archiveBase64?: never;
        }
      | {
          /** Format: uuid */
          operationId: string;
          /** @description Relative workspace directory. Use an empty string for the workspace root. */
          targetDirectory: string;
          updates?: components["schemas"]["WorkspaceImportUpdate"][];
          /** @description ZIP archive containing workspace-relative files. */
          archiveBase64: string;
          files?: never;
        };
    WorkspaceImportReceipt: components["schemas"]["MutationReceipt"] & {
      documents: components["schemas"]["DocumentMemberLink"][];
    };
    WorkspaceFolders: {
      folders: string[];
      /** @description Current folder identity by relative path. Use it when acting on a selected folder. */
      identities: {
        [key: string]: string;
      };
    };
    WorkspaceFolder: {
      path: string;
    };
    FileActionRequest: {
      /** @enum {string} */
      action: "move" | "copy" | "delete";
      sourcePath: string;
      /** @enum {string} */
      sourceKind: "document" | "folder";
      /** @description Stable ID for a document row. */
      expectedDocumentId?: string;
      targetWorkspace?: string;
      /** @description Final workspace-relative file or folder path for a move or copy. */
      targetPath?: string;
      /** @description Opaque source identity captured from the folder listing. A replaced source is a conflict. */
      expectedFolderId?: string;
    };
    FileActionApply: components["schemas"]["FileActionRequest"] & {
      token: string;
      /** Format: uuid */
      operationId: string;
    };
    FileActionUndo: {
      /**
       * Format: uuid
       * @description Original deletion operation.
       */
      operationId: string;
      /** @description Full workspace-relative destination to restore into. Omit to restore at the original path. */
      targetPath?: string;
    };
    FileActionPreview: {
      token: string;
      fileCount: number;
      access: components["schemas"]["FileActionAccessChanges"];
    };
    FileActionResult: {
      /** Format: uuid */
      operationId: string;
      workspaceId: string;
      path: string;
      documentId?: string;
      undoable: boolean;
    };
    DeletedFileAction: {
      /** Format: uuid */
      operationId: string;
      path: string;
      /** @enum {string} */
      sourceKind: "document" | "folder";
      fileCount: number;
    };
    DeletedFileActions: {
      items: components["schemas"]["DeletedFileAction"][];
    };
    AiLeasedWorkspace: {
      id: string;
      name: string;
      canWrite: boolean;
      canManage: boolean;
    };
    AiManagedSourceRequest: components["schemas"]["AiSourceRequest"] & {
      workspaceId?: string;
    };
    FileActionAccessChanges: {
      gainedRead: number;
      gainedWrite: number;
      lost: number;
      upgraded: number;
      downgraded: number;
    };
    AiWorkspaceManagementAction:
      | {
          /** @enum {string} */
          kind: "create_workspace";
          name: string;
        }
      | {
          /** @enum {string} */
          kind: "rename_workspace";
          workspaceId: string;
          name: string;
        }
      | {
          /** @enum {string} */
          kind: "set_workspace_member";
          workspaceId: string;
          username: string;
          /** @enum {string} */
          role: "read" | "write";
        }
      | {
          /** @enum {string} */
          kind: "remove_workspace_member";
          workspaceId: string;
          username: string;
        };
    AiWorkspaceManagementReceipt:
      | {
          /** @enum {string} */
          kind: "create_workspace";
          workspaceId: string;
          name: string;
        }
      | {
          /** @enum {string} */
          kind: "rename_workspace";
          workspaceId: string;
          name: string;
        }
      | {
          /** @enum {string} */
          kind: "set_workspace_member";
          workspaceId: string;
          name: string;
          username: string;
          /** @enum {string} */
          role: "read" | "write";
        }
      | {
          /** @enum {string} */
          kind: "remove_workspace_member";
          workspaceId: string;
          name: string;
          username: string;
        };
    AiTransferAction:
      | {
          /** @enum {string} */
          kind: "move" | "copy";
          sourceWorkspaceId: string;
          sourcePath: string;
          targetWorkspaceId: string;
          targetPath: string;
          documentId: string;
          /** @enum {string} */
          sourceKind?: "document";
        }
      | {
          /** @enum {string} */
          kind: "move" | "copy";
          sourceWorkspaceId: string;
          sourcePath: string;
          targetWorkspaceId: string;
          targetPath: string;
          /** @enum {string} */
          sourceKind: "folder";
        };
    AiTransferPreview: {
      /** @enum {string} */
      kind: "move" | "copy";
      sourceWorkspaceId: string;
      sourcePath: string;
      targetWorkspaceId: string;
      targetPath: string;
      /** @enum {string} */
      sourceKind: "document" | "folder";
      sourceWorkspaceName: string;
      targetWorkspaceName: string;
      fileCount: number;
      access: components["schemas"]["FileActionAccessChanges"];
      documentId?: string;
    };
    AiTransferReceipt: {
      /** @enum {string} */
      kind: "move" | "copy";
      workspaceId: string;
      workspaceName: string;
      path: string;
      documentId?: string;
    };
    AiGlobalTask: {
      documentId?: null;
      mode: components["schemas"]["AiMode"];
      prompt: string;
      context?: components["schemas"]["AiContext"][];
      /** @enum {string} */
      scope: "global";
    };
    AiOperationInput: components["schemas"]["AiTask"] | components["schemas"]["AiGlobalTask"];
    McpSettings: {
      enabled: boolean;
      available: boolean;
      disabledByEnv: boolean;
      /** Format: uri */
      endpoint: string;
      /** Format: uri */
      publicReaderUrl: string | null;
      publicReaderUrlError: string | null;
    };
    UpdateMcpSettings: {
      enabled: boolean;
    };
    McpGrant: {
      id: string;
      clientName: string;
      /** @enum {string} */
      clientKind: "cimd" | "dcr";
      spaces: components["schemas"]["McpGrantSpace"][];
      scope: string;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      lastUsedAt: string | null;
    };
    McpGrantSpace: {
      id: string;
      name: string;
    };
    AssetUpload: {
      path: string;
      assetPath: string;
      assetUrl: string | null;
      assetUrlError?: string | null;
      revision: string;
      contentType: string;
      width: number;
      height: number;
      size: number;
      /** Format: uuid */
      operationId: string;
      commitId: string;
    };
    ConfirmPublication: {
      /** @description Short-lived step-up token when TOTP is enabled. */
      stepUpToken?: string;
    };
    AccountSession: {
      id: string;
      provider: string | null;
      createdAt: number;
      expiresAt: number;
      shared: boolean;
      current: boolean;
    };
    AccountSessionList: {
      sessions: components["schemas"]["AccountSession"][];
    };
    RevokedSessions: {
      revoked: number;
    };
    TotpStatus: {
      enabled: boolean;
      recoveryRemaining: number;
    };
    TotpStart: {
      secret: string;
      uri: string;
    };
    TotpVerify: {
      secret: string;
      code: string;
    };
    TotpEnabled: {
      recoveryCodes: string[];
    };
    TotpDisable: {
      code: string;
    };
    StepUpInput: {
      code: string;
    };
    StepUpToken: {
      token: string;
      expiresIn: number;
    };
    InviteWorkspace: {
      id: string;
      name: string;
    };
    InviteSummary: {
      id: string;
      username: string;
      admin: boolean;
      /** @enum {string} */
      role: "read" | "write";
      workspaceIds: string[];
      workspaces: components["schemas"]["InviteWorkspace"][];
      createdBy: string;
      createdAt: number;
      expiresAt: number;
      acceptedAt: number | null;
      revoked: boolean;
    };
    InvitePreview: {
      username: string;
      admin: boolean;
      expiresAt: number;
      workspaces: components["schemas"]["InviteWorkspace"][];
    };
    CreateInvite: {
      username: string;
      /** @default false */
      admin: boolean;
      /** @enum {string} */
      role: "read" | "write";
      /** @default [] */
      workspaceIds: string[];
      /** @default 0 */
      expiresInDays: number;
    };
    CreatedInvite: {
      id: string;
      username: string;
      token: string;
      url: string;
      expiresAt: number;
    };
    AcceptInvite: {
      password: string;
      totpSecret: string;
      code: string;
    };
    AcceptedInvite: {
      recoveryCodes: string[];
    };
    AuditEvent: {
      id: number;
      at: number;
      actor: string | null;
      workspaceId: string | null;
      action: string;
      target: string | null;
      /** @enum {string} */
      result: "ok" | "denied";
      ruleId: string | null;
      requestId: string | null;
      metadata: {
        [key: string]: unknown;
      } | null;
    };
    AuditList: {
      events: components["schemas"]["AuditEvent"][];
      nextBefore: number | null;
    };
  };
  responses: {
    /** @description Sign-in required */
    Ai401: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        "application/json": components["schemas"]["ApiError"];
      };
    };
    /** @description The current account lacks permission for this action */
    Ai403: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        "application/json": components["schemas"]["ApiError"];
      };
    };
    /** @description The resource is missing or inaccessible under current permissions */
    Ai404: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        "application/json": components["schemas"]["ApiError"];
      };
    };
  };
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  listAccounts: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AccountSummary"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createAccount: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateAccount"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AccountSummary"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  updateAccount: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        username: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateAccount"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AccountSummary"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  replaceAccountPassword: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        username: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ReplaceAccountPassword"];
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeAccountSessions: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        username: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  changeOwnPassword: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ChangeOwnPassword"];
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listWorkspaceMembers: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceMember"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  setWorkspaceMember: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        username: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SetWorkspaceMember"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceMember"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  removeWorkspaceMember: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        username: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceMember"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BrowserSession"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  logoutSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getBackupSettings: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupSettings"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveBackupSettings: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SaveBackupSettings"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupSettings"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  startBackupJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          /** Format: uuid */
          operationId: string;
        };
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupJob"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getBackupJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        job: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupJob"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listPublicationTargets: {
    parameters: {
      query: {
        workspaceId: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            targets: components["schemas"]["ConfiguredTarget"][];
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listPublications: {
    parameters: {
      query: {
        workspaceId: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            publications: components["schemas"]["Publication"][];
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createPublication: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreatePublication"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getPublication: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        publication: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  confirmPublication: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        publication: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ConfirmPublication"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @enum {string} */
            status: "ok";
            version: string;
          };
        };
      };
    };
  };
  listWorkspaces: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Workspace"][];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateWorkspace"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Workspace"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listDocuments: {
    parameters: {
      query?: {
        after?: string;
        limit?: number;
      };
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSummary"][];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateDocument"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WriteMarkdown"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  searchDocuments: {
    parameters: {
      query: {
        q: string;
      };
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Up to twenty matching documents in this workspace */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SearchHit"][];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Superseded search */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Search is busy */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getDocumentReferences: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Document links and backlinks in the current Workspace */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentReferences"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getOutline: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Outline Markdown and content revision, null before creation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OutlineSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveOutline: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SaveOutline"];
      };
    };
    responses: {
      /** @description Outline Markdown and content revision, null before creation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OutlineSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getDocumentHistory: {
    parameters: {
      query?: {
        before?: string;
        limit?: number;
      };
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Version history for this document */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentHistory"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getVersionDiff: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
        commit: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Diff and original Markdown for the selected version */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["VersionDiff"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  restoreDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RestoreRevision"];
      };
    };
    responses: {
      /** @description Restored Markdown and new Git commit */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RestoredDocument"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getDevicePreferences: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Effective device preferences */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DevicePreferences"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveDevicePreferences: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DevicePreferences"];
      };
    };
    responses: {
      /** @description Saved device preferences */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DevicePreferences"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listAiOperations: {
    parameters: {
      query?: {
        scope?: "global";
        workspaceId?: string;
        documentId?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Current account's recent operations in the requested context */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"][];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiOperationInput"];
      };
    };
    responses: {
      /** @description Operation registered */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Current operation state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  replayAiEvents: {
    parameters: {
      query?: never;
      header?: {
        "Last-Event-ID"?: string;
      };
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Finite stream of durable events after the supplied cursor */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "text/event-stream": string;
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  confirmAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiConfirmRequest"];
      };
    };
    responses: {
      /** @description Confirmed operation state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  undoAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description New reverse version */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["MutationReceipt"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  claimAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Leased operation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiClaim"];
        };
      };
      /** @description No queued operation */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readAiSource: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiSourceRequest"];
      };
    };
    responses: {
      /** @description Authorized source snapshot */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiSourceData"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  finishAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiRunnerResult"];
      };
    };
    responses: {
      /** @description Operation result or confirmation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  diffAiOperationFile: {
    parameters: {
      query: {
        path: string;
      };
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Git diff for a file affected by this operation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperationDiff"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  discoverAiDocuments: {
    parameters: {
      query?: {
        q?: string;
      };
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Accessible document metadata in this task's workspace */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSummary"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  reportAiRunnerEvent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiRunnerEvent"];
      };
    };
    responses: {
      /** @description Durable event sequence */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiEventReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  renewAiLease: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description New execution lease expiration */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiLeaseRenewal"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  failAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiRunnerFailure"];
      };
    };
    responses: {
      /** @description Failed operation state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  updateWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateWorkspace"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Workspace"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  renameWorkspacePaths: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RenameWorkspacePaths"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["MutationReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listWorkspaceDeliveries: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DeliveryReceipt"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  deliverWorkspaceFiles: {
    parameters: {
      query?: {
        deliveryId?: string;
        sourceName?: string;
        version?: string;
        generatedAt?: string;
      };
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DeliveryRequest"];
        "application/zip": string;
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DeliveryReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listDeliveryTokens: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DeliveryToken"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  issueDeliveryToken: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["NewDeliveryToken"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["IssuedDeliveryToken"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeDeliveryToken: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        token: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readWorkspaceAttachment: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        path: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Original attachment bytes */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listSnapshots: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SnapshotLinkSummary"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createSnapshot: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateSnapshot"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SnapshotLink"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getReaderSnapshot: {
    parameters: {
      query?: {
        documentId?: string;
      };
      header?: never;
      path: {
        snapshot: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ReaderSnapshot"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeSnapshot: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        snapshot: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readSnapshotAttachment: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        snapshot: string;
        path: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Original attachment bytes */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  discoverAiModels: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiDiscoveryInput"];
      };
    };
    responses: {
      /** @description Discovered model catalog and a short-lived discovery ticket */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiDiscovery"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getAiSettings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiSettingsView"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createAiConnection: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateAiConnection"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            id: string;
            version: number;
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  removeAiConnection: {
    parameters: {
      query: {
        expectedVersion: number;
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  updateAiConnection: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateAiConnection"];
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  setAiPreference: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          selection: components["schemas"]["ModelSelection"] | null;
        };
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  setAiDefault: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          selection: components["schemas"]["ModelSelection"];
        };
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  setAiGlobalEnabled: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          enabled: boolean;
        };
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  activateManagedAi: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ManagedActivation"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            activationId: string;
            /** @enum {string} */
            dispatchMode: "managed";
            settingsVersion: number;
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  startAiProbe: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiProbeInput"];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiProbe"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getAiProbe: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiProbe"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listConversations: {
    parameters: {
      query?: {
        scope?: "global";
        workspaceId?: string;
        documentId?: string;
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ConversationPage"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createConversation: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ConversationScope"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ConversationView"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getConversation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ConversationView"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  deleteConversation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listTurns: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["TurnPage"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createTurn: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateTurn"];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["TurnView"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  cancelTurn: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
        turnId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["TurnView"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listAiMaterials: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiMaterialView"][];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  uploadAiMaterial: {
    parameters: {
      query: {
        name: string;
      };
      header?: never;
      path: {
        conversationId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "text/plain": string;
        "text/markdown": string;
        "application/pdf": string;
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": string;
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiMaterialView"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  removeAiMaterial: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
        materialId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listAiMaterialSegments: {
    parameters: {
      query?: {
        cursor?: string;
        q?: string;
      };
      header?: never;
      path: {
        conversationId: string;
        materialId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            items: components["schemas"]["AiSegmentLocation"][];
            nextCursor?: string;
          };
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readAiMaterialSegment: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        conversationId: string;
        materialId: string;
        segmentId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiMaterialSegment"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  heartbeatManagedRunner: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": Record<string, never>;
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  claimManagedTask: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": Record<string, never>;
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiManagedClaim"];
        };
      };
      /** @description No queued task */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  discoverAiDocumentsV2: {
    parameters: {
      query?: {
        q?: string;
        workspaceId?: string;
      };
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Accessible document metadata in this task's workspace */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSummary"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readAiSourceV2: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiManagedSourceRequest"];
      };
    };
    responses: {
      /** @description Authorized source snapshot */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiSourceData"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  reportAiRunnerEventV2: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiRunnerEvent"];
      };
    };
    responses: {
      /** @description Durable event sequence */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiEventReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  renewAiLeaseV2: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description New execution lease expiration */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiLeaseRenewal"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  failAiOperationV2: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json":
          | components["schemas"]["AiRunnerFailure"]
          | {
              text: string;
              /** @enum {string} */
              code: "authentication" | "rate_limit" | "timeout" | "incompatible" | "unavailable";
            };
      };
    };
    responses: {
      /** @description Failed operation state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  finishAiOperationV2: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json":
          | components["schemas"]["AiManagedResult"]
          | {
              /** @constant */
              ok: true;
            };
      };
    };
    responses: {
      /** @description Operation result or confirmation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getManagedProvider: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          "Cache-Control"?: "no-store";
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            messagesUrl: string;
            apiKey: string;
            pinnedIp: string;
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  findLeasedMaterialSegments: {
    parameters: {
      query?: {
        cursor?: string;
        q?: string;
      };
      header?: never;
      path: {
        lease: string;
        materialId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            items: components["schemas"]["AiSegmentLocation"][];
            nextCursor?: string;
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readLeasedMaterialSegment: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
        materialId: string;
        segmentId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            source: components["schemas"]["AiMaterialSource"];
            text: string;
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  cancelAiConfirmation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiConfirmRequest"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      401: components["responses"]["Ai401"];
      403: components["responses"]["Ai403"];
      404: components["responses"]["Ai404"];
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  importWorkspaceFiles: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WorkspaceImportRequest"];
      };
    };
    responses: {
      /** @description Committed import receipt, including member links for its documents. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceImportReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getWorkspaceImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        operationId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Previously committed import. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceImportReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listWorkspaceFolders: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceFolders"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createWorkspaceFolder: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WorkspaceFolder"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceFolder"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  previewWorkspaceFileAction: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["FileActionRequest"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["FileActionPreview"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  applyWorkspaceFileAction: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["FileActionApply"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["FileActionResult"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  undoWorkspaceFileAction: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["FileActionUndo"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["FileActionResult"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listDeletedWorkspaceFileActions: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Restorable deletions */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DeletedFileActions"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listAiWorkspacesV2: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Workspaces currently accessible to the account for this global task */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiLeasedWorkspace"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getMcpSettings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["McpSettings"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  updateMcpSettings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateMcpSettings"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["McpSettings"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listMcpGrants: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["McpGrant"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeMcpGrant: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  uploadWorkspaceAsset: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "multipart/form-data": {
          /** Format: binary */
          file: string;
          /** Format: uuid */
          operationId: string;
          targetDirectory: string;
          fileName: string;
          /**
           * @default rename
           * @enum {string}
           */
          conflictPolicy?: "rename" | "reject";
          baseRevision?: string | null;
        };
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AssetUpload"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listAccountSessions: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AccountSessionList"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeOtherAccountSessions: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RevokedSessions"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeAccountSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        session: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getTotpStatus: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["TotpStatus"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  startTotp: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["TotpStart"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  verifyTotp: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["TotpVerify"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["TotpEnabled"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  disableTotp: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["TotpDisable"];
      };
    };
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  stepUp: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StepUpInput"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["StepUpToken"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  resetTotp: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        username: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listInvites: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["InviteSummary"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createInvite: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateInvite"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreatedInvite"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getInvite: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description One-time invite token. */
        token: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["InvitePreview"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeInvite: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        /** @description Invite id (the id field), not the one-time token. */
        token: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  acceptInvite: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        token: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AcceptInvite"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AcceptedInvite"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listAudit: {
    parameters: {
      query?: {
        workspaceId?: string;
        actor?: string;
        action?: string;
        result?: "ok" | "denied";
        before?: number;
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AuditList"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  exportAudit: {
    parameters: {
      query?: {
        workspaceId?: string;
        actor?: string;
        action?: string;
        result?: "ok" | "denied";
        before?: number;
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description CSV export */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "text/csv": string;
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
}
