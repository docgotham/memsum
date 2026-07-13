import {
  type CommitInteractionInput,
  type CommitUpdateBatchInput,
  type CreateReminderInput,
  type CreateRelationshipContextInput,
  type GetDmsumHomeInput,
  type GetDmsumInstructionsInput,
  type GetRelationshipContextInput,
  type HostedToolName,
  type ListActivityInput,
  type ListRelationshipContextsInput,
  type ListPagesInput,
  type ReadPageInput,
  type ResolveContactInput,
  type SearchPagesInput,
  hostedOperationSchemas,
  hostedToolNames
} from "./contracts.js";

export interface HostedKernelHandler {
  getDmsumHome(input: GetDmsumHomeInput): Promise<unknown>;
  getDmsumInstructions(input: GetDmsumInstructionsInput): Promise<unknown>;
  createRelationshipContext(input: CreateRelationshipContextInput): Promise<unknown>;
  listRelationshipContexts(input: ListRelationshipContextsInput): Promise<unknown>;
  resolveContact(input: ResolveContactInput): Promise<unknown>;
  commitInteraction(input: CommitInteractionInput): Promise<unknown>;
  readPage(input: ReadPageInput): Promise<unknown>;
  listPages(input: ListPagesInput): Promise<unknown>;
  searchPages(input: SearchPagesInput): Promise<unknown>;
  listActivity(input: ListActivityInput): Promise<unknown>;
  commitUpdateBatch(input: CommitUpdateBatchInput): Promise<unknown>;
  createReminder(input: CreateReminderInput): Promise<unknown>;
  getRelationshipContext(input: GetRelationshipContextInput): Promise<unknown>;
}

type HandlerMethodName =
  | "getDmsumHome"
  | "getDmsumInstructions"
  | "commitInteraction"
  | "createRelationshipContext"
  | "listRelationshipContexts"
  | "resolveContact"
  | "readPage"
  | "listPages"
  | "searchPages"
  | "listActivity"
  | "commitUpdateBatch"
  | "createReminder"
  | "getRelationshipContext";

const operationToMethod: Record<HostedToolName, HandlerMethodName> = {
  get_dmsum_home: "getDmsumHome",
  get_dmsum_instructions: "getDmsumInstructions",
  create_relationship_context: "createRelationshipContext",
  list_relationship_contexts: "listRelationshipContexts",
  resolve_contact: "resolveContact",
  commit_interaction: "commitInteraction",
  read_page: "readPage",
  list_pages: "listPages",
  search_pages: "searchPages",
  list_activity: "listActivity",
  commit_update_batch: "commitUpdateBatch",
  create_reminder: "createReminder",
  get_relationship_context: "getRelationshipContext"
};

export function missingHostedKernelHandler(): HostedKernelHandler {
  const missing = async () => {
    return jsonResponse(
      {
        ok: false,
        error: "Hosted Mem·Sum storage adapter is not configured"
      },
      501
    );
  };

  return {
    getDmsumHome: missing,
    getDmsumInstructions: missing,
    createRelationshipContext: missing,
    listRelationshipContexts: missing,
    resolveContact: missing,
    commitInteraction: missing,
    readPage: missing,
    listPages: missing,
    searchPages: missing,
    listActivity: missing,
    commitUpdateBatch: missing,
    createReminder: missing,
    getRelationshipContext: missing
  };
}

export async function handleHostedRequest(
  request: Request,
  handler: HostedKernelHandler = missingHostedKernelHandler()
): Promise<Response> {
  const url = new URL(request.url);
  const operation = hostedOperationFromPath(url.pathname);

  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

  if (operation === "health" && request.method === "GET") {
    return jsonResponse({ ok: true, name: "memsum-hosted", tools: hostedToolNames });
  }

  if (!operation || operation === "health") {
    return jsonResponse({ ok: false, error: "Unknown hosted Mem·Sum operation" }, 404);
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Hosted Mem·Sum operations require POST" }, 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Expected JSON request body" }, 400);
  }

  const parsed = hostedOperationSchemas[operation].safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      {
        ok: false,
        error: "Invalid hosted Mem·Sum request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      },
      400
    );
  }

  let result: unknown;
  try {
    result = await handler[operationToMethod[operation]](parsed.data as never);
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Hosted Mem·Sum operation failed"
      },
      500
    );
  }

  if (result instanceof Response) return withCors(result);
  return jsonResponse({ ok: true, result });
}

function hostedOperationFromPath(pathname: string): HostedToolName | "health" | null {
  const parts = pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  if (last === "health") return "health";
  if (hostedToolNames.includes(last as HostedToolName)) return last as HostedToolName;
  return null;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    })
  );
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
