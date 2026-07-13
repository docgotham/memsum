import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolveSync, syncDoctor, syncOnce, syncStatus } from "./sync.js";
import type { ConflictRecord, ConflictSummary, StatusClaim, UpdateResource, WikiWriteInput, PreferenceWriteInput } from "./types.js";
import type { GrepResult } from "./vault.js";

export interface DmsumToolTarget {
  readFile(path: string, context?: { relationshipId?: string }): Promise<{ path: string; content: string; hash?: string }>;
  listFiles(
    path?: string,
    context?: { relationshipId?: string }
  ): Promise<Array<{ path: string; name: string; type: "file" | "dir" }>>;
  grep(args: {
    pattern: string;
    path?: string;
    caseSensitive?: boolean;
    maxResults?: number;
    relationshipId?: string;
  }): Promise<GrepResult[]>;
  getCurrentTime(): unknown;
  commitInteraction(args: {
    participant: string;
    agent: string;
    rawText: string;
    addressedParticipants?: string[];
    resources?: UpdateResource[];
    notificationText?: string;
    claimToken?: string;
    relationshipId?: string;
  }): Promise<unknown>;
  commitWikiUpdate(args: {
    participant: string;
    agent: string;
    tags?: string[];
    attention?: string[];
    interactionIds: string[];
    displayText: string;
    resources?: UpdateResource[];
    wikiWrites?: WikiWriteInput[];
    preferenceWrites?: PreferenceWriteInput[];
    notificationText?: string;
    claimToken?: string;
    relationshipId?: string;
  }): Promise<unknown>;
  claimStatus(description: string, owner?: string | null, context?: { relationshipId?: string }): Promise<StatusClaim>;
  releaseStatus(token: string, context?: { relationshipId?: string }): Promise<{ released: true }>;
  refreshStatus(token: string, context?: { relationshipId?: string }): Promise<StatusClaim>;
  listConflicts(args?: { relationshipId?: string; includeResolved?: boolean }): Promise<ConflictSummary[]>;
  readConflict(args: {
    conflictId: string;
    relationshipId?: string;
  }): Promise<ConflictRecord & { conflictPath: string; content: string }>;
  resolveConflict(args: {
    conflictId: string;
    participant: string;
    agent: string;
    content: string;
    relationshipId?: string;
  }): Promise<unknown>;
}

export interface DmsumMcpOptions {
  syncPath?: string;
}

const pathSchema = z.object({
  path: z.string().min(1),
  relationshipId: z.string().min(1).optional()
});

const listFilesSchema = z.object({
  path: z.string().optional(),
  relationshipId: z.string().min(1).optional()
});

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
  relationshipId: z.string().min(1).optional()
});

const resourceMetadataSchema = z.object({
  canonicalUrl: z.string().optional(),
  siteName: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional()
});

const resourceSchema = z.object({
  kind: z.enum(["url", "excerpt", "url_with_excerpt"]),
  url: z.string().optional(),
  title: z.string().optional(),
  sourceName: z.string().optional(),
  quotedText: z.string().optional(),
  note: z.string().optional(),
  metadata: resourceMetadataSchema.optional()
});

const wikiWriteSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  baseHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
});

const preferenceWriteSchema = z.object({
  participant: z.string().min(1),
  content: z.string().min(1),
  baseHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
});

const commitInteractionSchema = z.object({
  participant: z.string().min(1),
  agent: z.string().min(1),
  rawText: z.string().min(1),
  addressedParticipants: z.array(z.string().min(1)).optional(),
  resources: z.array(resourceSchema).optional(),
  notificationText: z.string().optional(),
  claimToken: z.string().optional(),
  relationshipId: z.string().min(1).optional()
});

const commitWikiUpdateSchema = z.object({
  participant: z.string().min(1),
  agent: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
  attention: z.array(z.string().min(1)).optional(),
  interactionIds: z.array(z.string().min(1)).min(1),
  displayText: z.string().min(1),
  resources: z.array(resourceSchema).optional(),
  wikiWrites: z.array(wikiWriteSchema).optional(),
  preferenceWrites: z.array(preferenceWriteSchema).optional(),
  notificationText: z.string().optional(),
  claimToken: z.string().optional(),
  relationshipId: z.string().min(1).optional()
});

const claimStatusSchema = z.object({
  description: z.string().min(1),
  owner: z.string().nullable().optional(),
  relationshipId: z.string().min(1).optional()
});

const tokenSchema = z.object({
  token: z.string().min(1),
  relationshipId: z.string().min(1).optional()
});

const syncSchema = z.object({
  relationshipId: z.string().min(1).optional()
});

const syncResolveSchema = z.object({
  relationshipId: z.string().min(1)
});

const listConflictsSchema = z.object({
  relationshipId: z.string().min(1).optional(),
  includeResolved: z.boolean().optional()
});

const readConflictSchema = z.object({
  relationshipId: z.string().min(1).optional(),
  conflictId: z.string().regex(/^C\d{6}$/i)
});

const resolveConflictSchema = z.object({
  relationshipId: z.string().min(1).optional(),
  conflictId: z.string().regex(/^C\d{6}$/i),
  participant: z.string().min(1),
  agent: z.string().min(1),
  content: z.string().min(1)
});

function toolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: { result: payload }
  };
}

type ToolResult = ReturnType<typeof toolResult>;
type ToolHandlerMap = Record<string, (input: any) => Promise<ToolResult>>;

function requireSyncPath(options?: DmsumMcpOptions): string {
  if (!options?.syncPath) {
    throw new Error("Mem·Sum sync tools require the MCP server to be launched with --sync");
  }
  return options.syncPath;
}

export function createToolHandlers(vault: DmsumToolTarget, options?: DmsumMcpOptions): ToolHandlerMap {
  const handlers: ToolHandlerMap = {
    read_file: async (input: z.infer<typeof pathSchema>) =>
      toolResult(await vault.readFile(input.path, { relationshipId: input.relationshipId })),
    list_files: async (input: z.infer<typeof listFilesSchema>) =>
      toolResult(await vault.listFiles(input.path, { relationshipId: input.relationshipId })),
    grep: async (input: z.infer<typeof grepSchema>) => toolResult(await vault.grep(input)),
    get_current_time: async () => toolResult(vault.getCurrentTime()),
    commit_interaction: async (input: z.infer<typeof commitInteractionSchema>) =>
      toolResult(await vault.commitInteraction(input)),
    commit_wiki_update: async (input: z.infer<typeof commitWikiUpdateSchema>) =>
      toolResult(await vault.commitWikiUpdate(input)),
    claim_status: async (input: z.infer<typeof claimStatusSchema>) =>
      toolResult(await vault.claimStatus(input.description, input.owner ?? null, { relationshipId: input.relationshipId })),
    release_status: async (input: z.infer<typeof tokenSchema>) =>
      toolResult(await vault.releaseStatus(input.token, { relationshipId: input.relationshipId })),
    refresh_status: async (input: z.infer<typeof tokenSchema>) =>
      toolResult(await vault.refreshStatus(input.token, { relationshipId: input.relationshipId })),
    list_conflicts: async (input: z.infer<typeof listConflictsSchema>) =>
      toolResult(await vault.listConflicts(input)),
    read_conflict: async (input: z.infer<typeof readConflictSchema>) =>
      toolResult(await vault.readConflict(input)),
    resolve_conflict: async (input: z.infer<typeof resolveConflictSchema>) =>
      toolResult(await vault.resolveConflict(input))
  };

  if (!options?.syncPath) return handlers;

  return {
    ...handlers,
    sync_status: async (input: z.infer<typeof syncSchema>): Promise<ToolResult> =>
      toolResult(await syncStatus({ syncPath: requireSyncPath(options), relationshipId: input.relationshipId })),
    sync_once: async (input: z.infer<typeof syncSchema>): Promise<ToolResult> =>
      toolResult(await syncOnce({ syncPath: requireSyncPath(options), relationshipId: input.relationshipId })),
    sync_doctor: async (input: z.infer<typeof syncSchema>): Promise<ToolResult> =>
      toolResult(await syncDoctor({ syncPath: requireSyncPath(options), relationshipId: input.relationshipId })),
    sync_resolve: async (input: z.infer<typeof syncResolveSchema>): Promise<ToolResult> =>
      toolResult(await resolveSync({ syncPath: requireSyncPath(options), relationshipId: input.relationshipId }))
  };
}

export function createDmsumMcpServer(vault: DmsumToolTarget, options?: DmsumMcpOptions): McpServer {
  const server = new McpServer({
    name: "memsum",
    version: "0.4.0"
  });
  const handlers = createToolHandlers(vault, options);

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a markdown file from a Mem·Sum relationship workspace. In routed mode, pass relationshipId or use relationships/{relationshipId}/ paths.",
      inputSchema: pathSchema
    },
    handlers.read_file
  );
  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List files or directories under a Mem·Sum relationship workspace. In routed mode, omit path to see virtual relationship roots or pass relationshipId.",
      inputSchema: listFilesSchema
    },
    handlers.list_files
  );
  server.registerTool(
    "grep",
    {
      title: "Search vault",
      description: "Search markdown files in one relationship workspace or, in routed mode, across relationship workspaces.",
      inputSchema: grepSchema
    },
    handlers.grep
  );
  server.registerTool(
    "get_current_time",
    {
      title: "Get current time",
      description: "Return the server-authoritative current time in the relationship timezone."
    },
    handlers.get_current_time
  );
  server.registerTool(
    "commit_interaction",
    {
      title: "Commit interaction",
      description:
        "Commit one durable raw +sum, +dm, or +dmsum write/update interaction into a relationship workspace. Read-only retrieval requests normally do not need an interaction commit. In routed mode, relationshipId may be inferred from an owner-scoped @contact handle or supplied explicitly. The server assigns an interaction ID and timestamp, preserves the participant's wording, stores optional resources, logs the commit, and may emit dry-run notifications for addressed participants.",
      inputSchema: commitInteractionSchema
    },
    handlers.commit_interaction
  );
  server.registerTool(
    "commit_wiki_update",
    {
      title: "Commit wiki update",
      description:
        "Commit a Mem·Sum wiki update that integrates one or more source interactions into a relationship workspace. In routed mode, pass relationshipId explicitly unless the server has only one relationship. The agent chooses target wiki pages and optional participant preference files, then supplies final markdown writes. Writes may include baseHash; if a target has changed, the server preserves the attempted write as a conflict record instead of overwriting current content.",
      inputSchema: commitWikiUpdateSchema
    },
    handlers.commit_wiki_update
  );
  server.registerTool(
    "claim_status",
    {
      title: "Claim STATUS",
      description: "Claim STATUS.md before multi-file maintenance work.",
      inputSchema: claimStatusSchema
    },
    handlers.claim_status
  );
  server.registerTool(
    "release_status",
    {
      title: "Release STATUS",
      description: "Release an active STATUS.md claim.",
      inputSchema: tokenSchema
    },
    handlers.release_status
  );
  server.registerTool(
    "refresh_status",
    {
      title: "Refresh STATUS",
      description: "Refresh an active STATUS.md claim.",
      inputSchema: tokenSchema
    },
    handlers.refresh_status
  );
  server.registerTool(
    "list_conflicts",
    {
      title: "List conflicts",
      description:
        "List unresolved Mem·Sum kernel conflicts for a relationship workspace. Pass includeResolved to include resolved audit records.",
      inputSchema: listConflictsSchema
    },
    handlers.list_conflicts
  );
  server.registerTool(
    "read_conflict",
    {
      title: "Read conflict",
      description:
        "Read a Mem·Sum kernel conflict record, including the current target content and the proposed content that was not written.",
      inputSchema: readConflictSchema
    },
    handlers.read_conflict
  );
  server.registerTool(
    "resolve_conflict",
    {
      title: "Resolve conflict",
      description:
        "Resolve a Mem·Sum kernel conflict by writing harmonized markdown to the original target and marking the conflict record resolved.",
      inputSchema: resolveConflictSchema
    },
    handlers.resolve_conflict
  );

  if (options?.syncPath) {
    server.registerTool(
      "sync_status",
      {
        title: "Sync status",
        description:
          "Report Git sync state for one configured Mem·Sum relationship workspace, or all configured relationships when relationshipId is omitted.",
        inputSchema: syncSchema
      },
      handlers.sync_status
    );
    server.registerTool(
      "sync_once",
      {
        title: "Sync once",
        description:
          "Commit local Mem·Sum file changes, fetch, merge, and push one configured relationship workspace. If a Git conflict occurs, the result lists the conflicted files and does not push.",
        inputSchema: syncSchema
      },
      handlers.sync_once
    );
    server.registerTool(
      "sync_doctor",
      {
        title: "Sync doctor",
        description: "Check Git sync prerequisites and current setup for a Mem·Sum relationship workspace.",
        inputSchema: syncSchema
      },
      handlers.sync_doctor
    );
    server.registerTool(
      "sync_resolve",
      {
        title: "Resolve sync",
        description:
          "After an agent has harmonized Git conflict markers in markdown files, commit and push the resolved relationship workspace.",
        inputSchema: syncResolveSchema
      },
      handlers.sync_resolve
    );
  }

  return server;
}
