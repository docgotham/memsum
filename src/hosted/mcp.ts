import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import {
  commitInteractionSchema,
  commitUpdateBatchSchema,
  createReminderSchema,
  createRelationshipContextSchema,
  getDmsumHomeSchema,
  getDmsumInstructionsSchema,
  getRelationshipContextSchema,
  listActivitySchema,
  listRelationshipContextsSchema,
  listPagesSchema,
  readPageSchema,
  resolveContactSchema,
  searchPagesSchema
} from "./contracts.js";
import { hostedMcpInstructions } from "./instructions.js";
import { hostedMcpAuthorizationResponse } from "./oauth.js";
import {
  clientIpFromHeaders,
  hostedRateLimitResponse,
  hostedRateLimitRules,
  rateLimitSubjectForToken
} from "./ratelimit.js";
import { createSupabaseHostedKernelHandler } from "./supabase.js";
import type { HostedKernelHandler } from "./http.js";

type HostedToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { result: unknown };
  isError?: boolean;
};

const requestStore = new AsyncLocalStorage<Request>();

let transportPromise: Promise<WebStandardStreamableHTTPServerTransport> | undefined;

function toolResult(payload: unknown, isError = false): HostedToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: { result: payload },
    ...(isError ? { isError: true } : {})
  };
}

async function responsePayload(response: Response): Promise<{ payload: unknown; isError: boolean }> {
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Keep non-JSON response text for diagnostics.
  }
  return { payload, isError: response.status >= 400 };
}

function currentHandler(): HostedKernelHandler {
  const request = requestStore.getStore();
  if (!request) throw new Error("Hosted Mem·Sum MCP request context is unavailable");
  return createSupabaseHostedKernelHandler(request);
}

async function invokeHostedTool<TInput>(
  input: TInput,
  invoke: (handler: HostedKernelHandler, input: TInput) => Promise<unknown>
): Promise<HostedToolResult> {
  const result = await invoke(currentHandler(), input);
  if (result instanceof Response) {
    const parsed = await responsePayload(result);
    return toolResult(parsed.payload, parsed.isError);
  }
  return toolResult(result);
}

function createHostedMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "memsum-hosted",
      version: "0.1.0"
    },
    {
      instructions: hostedMcpInstructions
    }
  );

  server.registerResource(
    "dmsum-instructions",
    "dmsum://instructions",
    {
      title: "Mem·Sum operating instructions",
      description: "Concise operating contract for hosted Mem·Sum agents.",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: hostedMcpInstructions
        }
      ]
    })
  );

  server.registerTool(
    "get_dmsum_home",
    {
      title: "Get Mem·Sum home",
      description:
        "Call this first. Takes no arguments and returns the hosted Mem·Sum operating contract plus all relationship contexts and exact contact handles available to this authenticated connector.",
      inputSchema: getDmsumHomeSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.getDmsumHome(value))
  );

  server.registerTool(
    "get_dmsum_instructions",
    {
      title: "Get Mem·Sum instructions",
      description:
        "Returns the concise hosted Mem·Sum operating contract and relationship contexts. Optional contactHandle may be supplied only when an exact returned handle or participant-supplied handle is available.",
      inputSchema: getDmsumInstructionsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.getDmsumInstructions(value))
  );

  server.registerTool(
    "create_relationship_context",
    {
      title: "Create relationship context",
      description:
        "Create an authenticated hosted Mem·Sum relationship context only when no existing relationship/contact context fits the participant's request.",
      inputSchema: createRelationshipContextSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.createRelationshipContext(value))
  );

  server.registerTool(
    "list_relationship_contexts",
    {
      title: "List relationship contexts",
      description:
        "List hosted relationship contexts available to the authenticated user. Use this when the request lacks one clear @contact handle.",
      inputSchema: listRelationshipContextsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.listRelationshipContexts(value))
  );

  server.registerTool(
    "resolve_contact",
    {
      title: "Resolve contact",
      description:
        "Resolve an owner-scoped @contact handle returned by relationship context tools or supplied by the participant into the relationship and participant values needed for follow-up hosted graph operations.",
      inputSchema: resolveContactSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.resolveContact(value))
  );

  server.registerTool(
    "commit_interaction",
    {
      title: "Commit interaction",
      description:
        "Preserve one raw +sum, +dm, or +dmsum act. For direct +dm social acts and immediate tell/send/message requests, include addressedParticipantIds and directMessageContent to queue exactly one one-way SMS without requiring a wiki update or reminder. Mem·Sum formats the final 'From sender:' envelope; do not include it in directMessageContent.",
      inputSchema: commitInteractionSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.commitInteraction(value))
  );

  server.registerTool(
    "read_page",
    {
      title: "Read page",
      description:
        "Read one relationship-scoped hosted wiki page before drafting changes; accepts canonical paths or wiki-relative links and returns the canonical path, current content, parsed wiki links, version, and hash.",
      inputSchema: readPageSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.readPage(value))
  );

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description: "List hosted wiki pages in one relationship so an agent can choose relevant pages before reading or writing.",
      inputSchema: listPagesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.listPages(value))
  );

  server.registerTool(
    "search_pages",
    {
      title: "Search pages",
      description:
        "Search hosted wiki page content in one relationship when the likely target page is not obvious from wiki/index.md. Results include page content and parsed wiki links.",
      inputSchema: searchPagesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.searchPages(value))
  );

  server.registerTool(
    "list_activity",
    {
      title: "List activity",
      description:
        "Read recent relationship activity for a structured time window. Use this for questions about what was sent, changed, linked, or notified before falling back to wiki page search. The caller supplies ISO start/end datetimes and timezone.",
      inputSchema: listActivitySchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.listActivity(value))
  );

  server.registerTool(
    "commit_update_batch",
    {
      title: "Commit update batch",
      description:
        "Atomically publish one coherent hosted wiki/preference/resource/attention update after reading current versions. If any expected version is stale, reread changed paths, revise the private draft, and retry.",
      inputSchema: commitUpdateBatchSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.commitUpdateBatch(value))
  );

  server.registerTool(
    "create_reminder",
    {
      title: "Create reminder",
      description:
        "Schedule one SMS reminder from a preserved source interaction only when the participant explicitly asks for a reminder, follow-up, or scheduled notification with a time/date or relative delay. Do not use for immediate tell/send/message requests. Write the SMS body directly to the recipient in second person.",
      inputSchema: createReminderSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.createReminder(value))
  );

  server.registerTool(
    "get_relationship_context",
    {
      title: "Get relationship context",
      description:
        "Fetch hosted relationship participants, optional @contact details, and wiki/index.md version information before read/write work.",
      inputSchema: getRelationshipContextSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    (input) => invokeHostedTool(input, (handler, value) => handler.getRelationshipContext(value))
  );

  return server;
}

async function hostedMcpTransport(): Promise<WebStandardStreamableHTTPServerTransport> {
  if (!transportPromise) {
    transportPromise = (async () => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      await createHostedMcpServer().connect(transport);
      return transport;
    })();
  }
  return transportPromise;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id"
  );
  headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function normalizeMcpRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  const method = request.method.toUpperCase();
  const accept = headers.get("accept") ?? "";
  const acceptsJson = accept.includes("application/json");
  const acceptsEventStream = accept.includes("text/event-stream");

  if (method === "GET" && !acceptsEventStream) {
    headers.set("accept", "text/event-stream");
  }

  if (method === "POST" && (!acceptsJson || !acceptsEventStream)) {
    headers.set("accept", "application/json, text/event-stream");
  }

  return new Request(request, { headers });
}

export async function handleHostedMcpRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  const normalized = normalizeMcpRequest(request);
  const authorizationResponse = await hostedMcpAuthorizationResponse(normalized);
  if (authorizationResponse) return withCors(authorizationResponse);

  // Tool-call POSTs are the DB-hitting requests; a runaway agent loop gets a
  // structured 429 with Retry-After instead of hammering the graph. Keyed per
  // credential so one noisy client never throttles another.
  if (normalized.method === "POST") {
    const bearer = normalized.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const subject = bearer ? rateLimitSubjectForToken(bearer) : clientIpFromHeaders(normalized.headers);
    const limited = await hostedRateLimitResponse(normalized, hostedRateLimitRules().mcpPerCredential, subject, "MCP");
    if (limited) return withCors(limited);
  }

  const transport = await hostedMcpTransport();
  return requestStore.run(normalized, async () => withCors(await transport.handleRequest(normalized)));
}
