import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type CommitInteractionInput,
  type CommitUpdateBatchInput,
  type CreateReminderInput,
  type CreateRelationshipContextInput,
  type GetDmsumHomeInput,
  type GetDmsumInstructionsInput,
  type GetRelationshipContextInput,
  type HostedResourceSchema,
  type ListActivityInput,
  type ListRelationshipContextsInput,
  type ListPagesInput,
  type ReadPageInput,
  type ResolveContactInput,
  type SearchPagesInput
} from "./contracts.js";
import { buildHostedInstructionsPayload, hostedResolvedContactWorkflow } from "./instructions.js";
import { hostedOAuthResourceUrl, isHostedOAuthAccessToken, resolveHostedOAuthAccessToken } from "./oauth.js";
import { hostedReadPageCandidates, isSafeGraphPath, parseWikiLinks } from "./paths.js";
import { tryProcessImmediateNotificationJobs, type NotificationWorkerEnv } from "./notifications.js";
import type { HostedKernelHandler } from "./http.js";

interface HostedSupabaseEnv {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

type HostedSupabaseClient = SupabaseClient<any>;

type HostedResourceInput = HostedResourceSchema;

type ActivityKind = "interaction" | "update" | "resource" | "notification";

interface ActivityParticipant {
  participantId: string;
  displayName: string;
}

interface ActivityResource {
  title?: string;
  url?: string;
  sourceName?: string;
  note?: string;
}

interface ActivityNotification {
  status: string;
  body: string;
  sentAt?: string;
  lastError?: string;
}

interface ActivityChangedPage {
  path: string;
  title?: string;
}

interface ActivityItem {
  kind: ActivityKind;
  occurredAt: string;
  displayTime: string;
  actor?: ActivityParticipant;
  targets?: ActivityParticipant[];
  summary: string;
  text?: string;
  resources?: ActivityResource[];
  changedPages?: ActivityChangedPage[];
  notification?: ActivityNotification;
}

interface CurrentUser {
  id: string;
}

interface CurrentParticipant {
  userId: string;
  participantId: string;
  displayName: string;
}

interface HostedAuthContext {
  kind: "supabase_jwt" | "connector_token" | "oauth_access_token";
  token: string;
  resource?: string;
  userId?: string;
}

export function createSupabaseHostedKernelHandler(request: Request, env = process.env): HostedKernelHandler {
  const config = readHostedSupabaseEnv(env);
  if (!config) {
    return responseHandler(500, "Hosted Mem·Sum Supabase environment is not configured");
  }

  const auth = readBearerAuth(request.headers.get("authorization"));
  if (!auth) {
    return responseHandler(401, "Hosted Mem·Sum requests require a bearer token");
  }

  const usesServerSideToken = isConnectorToken(auth.token) || isHostedOAuthAccessToken(auth.token);
  if (usesServerSideToken && !config.serviceRoleKey) {
    return responseHandler(500, "Hosted Mem·Sum server-side tokens require SUPABASE_SERVICE_ROLE_KEY");
  }

  const apiKey = usesServerSideToken ? config.serviceRoleKey! : config.anonKey;
  const client = createClient<any>(config.url, apiKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      headers: {
        authorization: `Bearer ${apiKey}`
      }
    }
  });

  const context = new SupabaseHostedKernel(
    client,
    config,
    {
      kind: isHostedOAuthAccessToken(auth.token) ? "oauth_access_token" : isConnectorToken(auth.token) ? "connector_token" : "supabase_jwt",
      token: auth.token,
      resource: hostedOAuthResourceUrl(request)
    },
    env
  );
  return context.handler();
}

function readHostedSupabaseEnv(env: NodeJS.ProcessEnv): HostedSupabaseEnv | null {
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey, serviceRoleKey };
}

function readBearerAuth(value: string | null): { token: string } | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return null;
  return { token: match[1].trim() };
}

export function isConnectorToken(token: string): boolean {
  return token.startsWith("memsum_") || token.startsWith("dmsum_");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function responseHandler(status: number, error: string): HostedKernelHandler {
  const respond = async () => jsonResponse({ ok: false, error }, status);
  return {
    getDmsumHome: respond,
    getDmsumInstructions: respond,
    createRelationshipContext: respond,
    listRelationshipContexts: respond,
    resolveContact: respond,
    commitInteraction: respond,
    readPage: respond,
    listPages: respond,
    searchPages: respond,
    listActivity: respond,
    commitUpdateBatch: respond,
    createReminder: respond,
    getRelationshipContext: respond
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function mapResource(input: HostedResourceInput, relationshipId: string, owner: { interactionId?: string; updateId?: string }) {
  return {
    relationship_id: relationshipId,
    interaction_id: owner.interactionId ?? null,
    update_id: owner.updateId ?? null,
    kind: input.kind,
    url: input.url ?? null,
    title: input.title ?? null,
    source_name: input.sourceName ?? null,
    quoted_text: input.quotedText ?? null,
    note: input.note ?? null,
    metadata: input.metadata ?? {}
  };
}

function validatePrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  if (prefix.startsWith("/") || /^[A-Za-z]:/.test(prefix) || prefix.includes("\\") || prefix.includes("..")) {
    throw new HostedSupabaseError(400, "Invalid hosted graph prefix");
  }
  return prefix;
}

function ilikePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

class HostedSupabaseError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// Classifies PostgREST failures for the agent. SQLSTATE P0001 is `raise
// exception` — an intentional kernel guard whose message was written to be
// relayed, so it keeps its text and gets a client-actionable status. Anything
// else is infrastructure: keep the diagnostic but prefix it so an agent can
// say "storage error" in plain language instead of relaying raw Postgres.
export function storageError(error: { message: string; code?: string | null }): Error {
  if (error.code === "P0001") return new HostedSupabaseError(400, error.message);
  return new HostedSupabaseError(500, `Mem·Sum storage error: ${error.message}`);
}

// Sum handles are the deterministic place-selector of the addressing grammar
// (+ is the app, @ is a person, # is a place). They are derived from the
// sum's display name at read time and never stored — names are labels, not
// identity — so a rename re-derives the handle on the next read.
export function sumHandleForDisplayName(displayName: string): string {
  const slug = displayName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return `#${slug || "sum"}`;
}

// Deduplicates within one member's set of sums, in listing order: the first
// bearer of a name keeps the bare handle, later ones get -2, -3, and so on.
export function assignSumHandles(displayNames: string[]): string[] {
  const seen = new Map<string, number>();
  return displayNames.map((name) => {
    const base = sumHandleForDisplayName(name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

export function formatActivityDisplayTime(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(value));
  } catch {
    throw new HostedSupabaseError(400, "timezone must be a valid IANA timezone");
  }
}

function compactActivityText(value: string | null | undefined, maxLength = 180): string {
  const compacted = (value ?? "").replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 1).trimEnd()}...`;
}

function definedActivityResource(resource: any): ActivityResource {
  return {
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.url ? { url: resource.url } : {}),
    ...(resource.source_name ? { sourceName: resource.source_name } : {}),
    ...(resource.note ? { note: resource.note } : {})
  };
}

function uniqueParticipants(ids: Array<string | null | undefined>, participantById: Map<string, ActivityParticipant>): ActivityParticipant[] {
  const seen = new Set<string>();
  const participants: ActivityParticipant[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    const participant = participantById.get(id);
    if (!participant) continue;
    seen.add(id);
    participants.push(participant);
  }
  return participants;
}

function activityItemMatchesTarget(item: ActivityItem, targetParticipantId: string | undefined): boolean {
  if (!targetParticipantId) return true;
  return Boolean(item.targets?.some((target) => target.participantId === targetParticipantId));
}

// The envelope names the sum when it has more than two participants, so a
// recipient who shares several sums with the sender knows which room the
// message came from. Dyad envelopes stay bare.
export function formatDirectMessageNotification(
  senderDisplayName: string,
  directMessageContent: string,
  sumDisplayName?: string
): string {
  const sumLabel = sumDisplayName?.trim() ? ` (${sumDisplayName.trim()})` : "";
  return `From ${senderDisplayName.trim()}${sumLabel}: ${directMessageContent.trim()}`;
}

export function validateDirectMessageContent(directMessageContent: string): string | null {
  const trimmed = directMessageContent.trim();
  if (!trimmed) return "directMessageContent must not be empty";
  if (/^(from|message from|reminder from)\s+[^:]{1,80}:/i.test(trimmed)) {
    return "directMessageContent must contain only the sender-voice message body; Mem·Sum adds the From sender prefix";
  }
  if (/^.+?'s message for [^:]{1,80}:/i.test(trimmed) || /^message from [^:]{1,80} for [^:]{1,80}:/i.test(trimmed)) {
    return "directMessageContent must not include recipient-label wording like 'message for Lisa'";
  }
  return null;
}

export function sourceInteractionHasImmediateNotification(sourceInteraction: { notification_text?: string | null }): boolean {
  return Boolean(sourceInteraction.notification_text?.trim());
}

function notificationTextForInteraction(
  input: CommitInteractionInput,
  senderDisplayName: string,
  sumDisplayName?: string
): string | null {
  if (input.directMessageContent) {
    const validationError = validateDirectMessageContent(input.directMessageContent);
    if (validationError) throw new HostedSupabaseError(400, validationError);
    return formatDirectMessageNotification(senderDisplayName, input.directMessageContent, sumDisplayName);
  }

  if (input.notificationText?.trim()) {
    throw new HostedSupabaseError(
      400,
      "Use directMessageContent for immediate DM SMS notifications; Mem·Sum formats the final From sender envelope"
    );
  }

  return null;
}

export interface UpdateBatchRejectionRecord {
  relationship_id: string;
  participant_id: string;
  agent: string;
  rejection_kind: "stale" | "error";
  reason: string;
  changed_paths: string[];
  read_set_size: number;
  wiki_write_paths: string[];
  preference_write_count: number;
}

const REJECTION_REASON_MAX_LENGTH = 2000;
const REJECTION_PATHS_MAX = 100;

export function isRejectedBatchResult(data: unknown): data is { ok: false; reason?: unknown; changedPaths?: unknown } {
  return typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === false;
}

export function buildUpdateBatchRejectionRecord(
  input: CommitUpdateBatchInput,
  kind: "stale" | "error",
  reason: string,
  changedPaths: unknown
): UpdateBatchRejectionRecord {
  const paths = Array.isArray(changedPaths)
    ? changedPaths.filter((path): path is string => typeof path === "string").slice(0, REJECTION_PATHS_MAX)
    : [];
  return {
    relationship_id: input.relationshipId,
    participant_id: input.participantId,
    agent: input.agent,
    rejection_kind: kind,
    reason: reason.trim().slice(0, REJECTION_REASON_MAX_LENGTH) || "rejected",
    changed_paths: paths,
    read_set_size: input.readSet.length,
    wiki_write_paths: (input.wikiWrites ?? []).map((write) => write.path).slice(0, REJECTION_PATHS_MAX),
    preference_write_count: input.preferenceWrites?.length ?? 0
  };
}

class SupabaseHostedKernel {
  private userPromise: Promise<CurrentUser> | undefined;

  constructor(
    private readonly client: HostedSupabaseClient,
    private readonly config: HostedSupabaseEnv,
    private readonly auth: HostedAuthContext,
    private readonly env: NotificationWorkerEnv = process.env
  ) {}

  handler(): HostedKernelHandler {
    return {
      getDmsumHome: (input) => this.safe(() => this.getDmsumHome(input)),
      getDmsumInstructions: (input) => this.safe(() => this.getDmsumInstructions(input)),
      commitInteraction: (input) => this.safe(() => this.commitInteraction(input)),
      createRelationshipContext: (input) => this.safe(() => this.createRelationshipContext(input)),
      listRelationshipContexts: (input) => this.safe(() => this.listRelationshipContexts(input)),
      resolveContact: (input) => this.safe(() => this.resolveContact(input)),
      readPage: (input) => this.safe(() => this.readPage(input)),
      listPages: (input) => this.safe(() => this.listPages(input)),
      searchPages: (input) => this.safe(() => this.searchPages(input)),
      listActivity: (input) => this.safe(() => this.listActivity(input)),
      commitUpdateBatch: (input) => this.safe(() => this.commitUpdateBatch(input)),
      createReminder: (input) => this.safe(() => this.createReminder(input)),
      getRelationshipContext: (input) => this.safe(() => this.getRelationshipContext(input))
    };
  }

  private async safe<T>(operation: () => Promise<T>): Promise<T | Response> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HostedSupabaseError) {
        return jsonResponse({ ok: false, error: error.message }, error.status);
      }
      throw error;
    }
  }

  private async loadCurrentUser(): Promise<CurrentUser> {
    if (this.userPromise) return this.userPromise;
    this.userPromise = this.fetchCurrentUser();
    return this.userPromise;
  }

  private async fetchCurrentUser(): Promise<CurrentUser> {
    if (this.auth.kind === "connector_token") {
      const { data, error } = await this.client.rpc("resolve_connector_token", { p_token_hash: tokenHash(this.auth.token) });
      if (error) throw new HostedSupabaseError(401, "Hosted Mem·Sum connector token is not valid");
      if (!data || data.ok !== true || typeof data.userId !== "string") {
        throw new HostedSupabaseError(401, "Hosted Mem·Sum connector token is not valid");
      }
      return { id: data.userId };
    }

    if (this.auth.kind === "oauth_access_token") {
      const user = await resolveHostedOAuthAccessToken(this.client, this.auth.token, this.auth.resource ?? "");
      if (!user) throw new HostedSupabaseError(401, "Hosted Mem·Sum OAuth access token is not valid");
      return user;
    }

    const response = await fetch(`${this.config.url}/auth/v1/user`, {
      headers: {
        apikey: this.config.anonKey,
        authorization: `Bearer ${this.auth.token}`
      }
    });

    if (!response.ok) {
      throw new HostedSupabaseError(401, "Hosted Mem·Sum bearer token is not valid");
    }

    const user = (await response.json()) as { id?: unknown };
    if (typeof user.id !== "string") {
      throw new HostedSupabaseError(401, "Hosted Mem·Sum bearer token is not valid");
    }

    return { id: user.id };
  }

  private async requireParticipantMembership(relationshipId: string, participantId: string): Promise<CurrentParticipant> {
    const user = await this.loadCurrentUser();
    const { data, error } = await this.client
      .from("relationship_members")
      .select("id, participants!inner(id, display_name)")
      .eq("relationship_id", relationshipId)
      .eq("participant_id", participantId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw storageError(error);
    if (!data) throw new HostedSupabaseError(403, "Participant does not belong to the authenticated user");
    const participant = (data as any).participants;
    if (!participant || typeof participant.display_name !== "string") {
      throw new HostedSupabaseError(500, "Participant display name is unavailable");
    }
    return {
      userId: user.id,
      participantId,
      displayName: participant.display_name
    };
  }

  private async requireRelationshipMembership(relationshipId: string): Promise<CurrentUser> {
    const user = await this.loadCurrentUser();
    const { data, error } = await this.client
      .from("relationship_members")
      .select("id")
      .eq("relationship_id", relationshipId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw storageError(error);
    if (!data) throw new HostedSupabaseError(403, "Authenticated user does not belong to this relationship");
    return user;
  }

  // Best-effort lookup for the group-sum SMS envelope: returns the sum's display
  // name only when the relationship has more than two participants. Failures
  // return undefined rather than blocking the commit.
  private async groupSumDisplayName(relationshipId: string): Promise<string | undefined> {
    const { data, error } = await this.client
      .from("relationships")
      .select("display_name, participants(id)")
      .eq("id", relationshipId)
      .maybeSingle();
    if (error || !data) return undefined;
    const row = data as { display_name?: unknown; participants?: unknown };
    const participantCount = Array.isArray(row.participants) ? row.participants.length : 0;
    return participantCount > 2 && typeof row.display_name === "string" && row.display_name.trim()
      ? row.display_name
      : undefined;
  }

  private async commitInteraction(input: CommitInteractionInput): Promise<unknown> {
    const participant = await this.requireParticipantMembership(input.relationshipId, input.participantId);
    const sumDisplayName = input.directMessageContent ? await this.groupSumDisplayName(input.relationshipId) : undefined;
    const notificationText = notificationTextForInteraction(input, participant.displayName, sumDisplayName);
    const { data, error } = await this.client
      .from("interactions")
      .insert({
        relationship_id: input.relationshipId,
        participant_id: input.participantId,
        actor_user_id: participant.userId,
        agent: input.agent,
        raw_text: input.rawText,
        addressed_participant_ids: input.addressedParticipantIds ?? [],
        notification_text: notificationText
      })
      .select("id, created_at")
      .single();

    if (error) throw storageError(error);

    if (input.resources?.length) {
      const { error: resourceError } = await this.client
        .from("resources")
        .insert(input.resources.map((resource) => mapResource(resource, input.relationshipId, { interactionId: data.id })));
      if (resourceError) throw storageError(resourceError);
    }

    if (notificationText) {
      await this.tryDispatchImmediateNotifications();
    }

    return {
      interactionId: data.id,
      createdAt: data.created_at,
      notificationQueued: Boolean(notificationText)
    };
  }

  private async tryDispatchImmediateNotifications(): Promise<void> {
    const result = await tryProcessImmediateNotificationJobs(this.env);
    if (!result.ok) {
      console.warn(`Immediate Mem·Sum notification dispatch failed: ${result.error}`);
    }
  }

  private async getDmsumHome(_input: GetDmsumHomeInput): Promise<unknown> {
    const relationshipContexts = await this.listRelationshipContexts({});
    return buildHostedInstructionsPayload({ relationshipContexts });
  }

  private async getDmsumInstructions(input: GetDmsumInstructionsInput): Promise<unknown> {
    const relationshipContexts = await this.listRelationshipContexts({});

    if (!input.contactHandle) {
      return buildHostedInstructionsPayload({ relationshipContexts });
    }

    let resolvedResult: unknown;
    try {
      resolvedResult = await this.resolveContact({ contactHandle: input.contactHandle });
    } catch (error) {
      if (!(error instanceof HostedSupabaseError) || error.status !== 404) throw error;
      return buildHostedInstructionsPayload({
        relationshipContexts,
        resolvedContext: {
          unresolvedContactHandle: input.contactHandle,
          note: "That contact handle is not available for this authenticated connector. Use the exact handles returned in relationshipContexts."
        }
      });
    }

    const resolved = resolvedResult as any;
    const relationshipId = resolved?.relationship?.id;
    if (typeof relationshipId !== "string") {
      throw new HostedSupabaseError(500, "Resolved hosted Mem·Sum contact did not include a relationship ID");
    }

    const relationshipContext = (await this.getRelationshipContext({
      relationshipId,
      contactHandle: input.contactHandle
    })) as any;

    return buildHostedInstructionsPayload({
      relationshipContexts,
      resolvedContext: {
        relationship: {
          id: resolved.relationship.id,
          displayName: resolved.relationship.displayName
        },
        selfParticipant: {
          id: resolved.selfParticipant.id,
          displayName: resolved.selfParticipant.displayName
        },
        contact: {
          handle: resolved.contact.handle,
          participantId: resolved.contact.participantId,
          displayName: resolved.contact.displayName
        },
        indexPage: relationshipContext?.indexPage
          ? {
              path: relationshipContext.indexPage.path,
              title: relationshipContext.indexPage.title,
              version: relationshipContext.indexPage.version
            }
          : null,
        recommendedNextToolSequence: hostedResolvedContactWorkflow
      }
    });
  }

  private async createRelationshipContext(input: CreateRelationshipContextInput): Promise<unknown> {
    const user = await this.loadCurrentUser();
    const rpcName = this.auth.kind === "connector_token" || this.auth.kind === "oauth_access_token" ? "create_relationship_context_for_user" : "create_relationship_context";
    const rpcArgs =
      this.auth.kind === "connector_token" || this.auth.kind === "oauth_access_token" ? { payload: input, target_user_id: user.id } : { payload: input };
    const { data, error } = await this.client.rpc(rpcName, rpcArgs);

    if (error) throw storageError(error);
    return data;
  }

  private async listRelationshipContexts(input: ListRelationshipContextsInput): Promise<unknown> {
    const user = await this.loadCurrentUser();
    const { data: memberships, error: membershipError } = await this.client
      .from("relationship_members")
      .select(
        "relationship_id, participant_id, role, relationships!inner(id, display_name, created_at, updated_at), participants!inner(id, user_id, display_name)"
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (membershipError) throw storageError(membershipError);

    let contactsQuery = this.client
      .from("contacts")
      .select("handle, relationship_id, participant_id, display_name")
      .eq("owner_user_id", user.id)
      .order("handle", { ascending: true });

    if (input.contactHandle) contactsQuery = contactsQuery.eq("handle", input.contactHandle);

    const { data: contacts, error: contactError } = await contactsQuery;
    if (contactError) throw storageError(contactError);

    const contactsByRelationship = new Map<string, any[]>();
    for (const contact of contacts ?? []) {
      const existing = contactsByRelationship.get(contact.relationship_id) ?? [];
      existing.push({
        handle: contact.handle,
        participantId: contact.participant_id,
        displayName: contact.display_name
      });
      contactsByRelationship.set(contact.relationship_id, existing);
    }

    // Handles are deduplicated over the member's full listing before any
    // contact filtering, so #handle-2 stays #handle-2 in every view.
    const allMemberships = memberships ?? [];
    const sumHandles = assignSumHandles(allMemberships.map((membership: any) => membership.relationships.display_name));
    const handleByRelationship = new Map<string, string>(
      allMemberships.map((membership: any, index: number) => [membership.relationship_id, sumHandles[index]])
    );

    return {
      relationships: allMemberships
        .filter((membership) => !input.contactHandle || contactsByRelationship.has(membership.relationship_id))
        .map((membership: any) => ({
          relationship: {
            id: membership.relationships.id,
            displayName: membership.relationships.display_name,
            sumHandle: handleByRelationship.get(membership.relationship_id),
            createdAt: membership.relationships.created_at,
            updatedAt: membership.relationships.updated_at
          },
          selfParticipant: {
            id: membership.participants.id,
            userId: membership.participants.user_id,
            displayName: membership.participants.display_name
          },
          role: membership.role,
          contacts: contactsByRelationship.get(membership.relationship_id) ?? []
        }))
    };
  }

  private async resolveContact(input: ResolveContactInput): Promise<unknown> {
    const user = await this.loadCurrentUser();
    const { data: contact, error: contactError } = await this.client
      .from("contacts")
      .select("handle, relationship_id, participant_id, display_name")
      .eq("owner_user_id", user.id)
      .eq("handle", input.contactHandle)
      .maybeSingle();

    if (contactError) throw storageError(contactError);
    if (!contact) throw new HostedSupabaseError(404, `No hosted Mem·Sum contact found for ${input.contactHandle}`);

    const { data: membership, error: membershipError } = await this.client
      .from("relationship_members")
      .select(
        "relationship_id, participant_id, role, relationships!inner(id, display_name, created_at, updated_at), participants!inner(id, user_id, display_name)"
      )
      .eq("relationship_id", contact.relationship_id)
      .eq("user_id", user.id)
      .single();

    if (membershipError) throw storageError(membershipError);

    return {
      contact: {
        handle: contact.handle,
        participantId: contact.participant_id,
        displayName: contact.display_name
      },
      relationship: {
        id: (membership as any).relationships.id,
        displayName: (membership as any).relationships.display_name,
        createdAt: (membership as any).relationships.created_at,
        updatedAt: (membership as any).relationships.updated_at
      },
      selfParticipant: {
        id: (membership as any).participants.id,
        userId: (membership as any).participants.user_id,
        displayName: (membership as any).participants.display_name
      },
      role: (membership as any).role
    };
  }

  private async readPage(input: ReadPageInput): Promise<unknown> {
    await this.requireRelationshipMembership(input.relationshipId);
    const candidatePaths = hostedReadPageCandidates(input.path);
    const { data, error } = await this.client
      .from("wiki_pages")
      .select("path, title, content, content_hash, version, updated_at")
      .eq("relationship_id", input.relationshipId)
      .in("path", candidatePaths);

    if (error) throw storageError(error);
    const pageByPath = new Map((data ?? []).map((page) => [page.path, page]));
    const page = candidatePaths.map((path) => pageByPath.get(path)).find(Boolean);

    if (!data) {
      return {
        exists: false,
        path: candidatePaths.at(-1) ?? input.path,
        version: 0,
        triedPaths: candidatePaths
      };
    }

    if (!page) {
      return {
        exists: false,
        path: candidatePaths.at(-1) ?? input.path,
        version: 0,
        triedPaths: candidatePaths
      };
    }

    return {
      exists: true,
      path: page.path,
      title: page.title,
      content: page.content,
      links: parseWikiLinks(page.content),
      contentHash: page.content_hash,
      version: page.version,
      updatedAt: page.updated_at
    };
  }

  private async listPages(input: ListPagesInput): Promise<unknown> {
    await this.requireRelationshipMembership(input.relationshipId);
    const prefix = validatePrefix(input.prefix);
    let query = this.client
      .from("wiki_pages")
      .select("path, title, content_hash, version, updated_at")
      .eq("relationship_id", input.relationshipId)
      .order("path", { ascending: true });

    if (prefix) query = query.like("path", `${prefix}%`);

    const { data, error } = await query;
    if (error) throw storageError(error);

    return {
      pages: (data ?? []).map((page) => ({
        path: page.path,
        title: page.title,
        contentHash: page.content_hash,
        version: page.version,
        updatedAt: page.updated_at
      }))
    };
  }

  private async searchPages(input: SearchPagesInput): Promise<unknown> {
    await this.requireRelationshipMembership(input.relationshipId);
    const { data, error } = await this.client
      .from("wiki_pages")
      .select("path, title, content, content_hash, version, updated_at")
      .eq("relationship_id", input.relationshipId)
      .ilike("content", ilikePattern(input.query))
      .limit(input.limit ?? 20);

    if (error) throw storageError(error);

    return {
      pages: (data ?? []).map((page) => ({
        path: page.path,
        title: page.title,
        content: page.content,
        links: parseWikiLinks(page.content),
        contentHash: page.content_hash,
        version: page.version,
        updatedAt: page.updated_at
      }))
    };
  }

  private async listActivity(input: ListActivityInput): Promise<unknown> {
    await this.requireRelationshipMembership(input.relationshipId);
    formatActivityDisplayTime(input.start, input.timezone);

    const scanLimit = Math.min(Math.max(input.limit * 5, 100), 500);
    const { data: participants, error: participantsError } = await this.client
      .from("participants")
      .select("id, display_name")
      .eq("relationship_id", input.relationshipId);

    if (participantsError) throw storageError(participantsError);

    const participantById = new Map<string, ActivityParticipant>(
      (participants ?? []).map((participant) => [
        participant.id,
        {
          participantId: participant.id,
          displayName: participant.display_name
        }
      ])
    );

    if (input.actorParticipantId && !participantById.has(input.actorParticipantId)) {
      throw new HostedSupabaseError(400, "actorParticipantId must belong to the relationship");
    }
    if (input.targetParticipantId && !participantById.has(input.targetParticipantId)) {
      throw new HostedSupabaseError(400, "targetParticipantId must belong to the relationship");
    }

    let interactionQuery = this.client
      .from("interactions")
      .select("id, participant_id, raw_text, addressed_participant_ids, created_at")
      .eq("relationship_id", input.relationshipId)
      .gte("created_at", input.start)
      .lt("created_at", input.end)
      .order("created_at", { ascending: false })
      .limit(scanLimit);

    if (input.actorParticipantId) interactionQuery = interactionQuery.eq("participant_id", input.actorParticipantId);

    let updateQuery = this.client
      .from("updates")
      .select("id, participant_id, display_text, created_at")
      .eq("relationship_id", input.relationshipId)
      .gte("created_at", input.start)
      .lt("created_at", input.end)
      .order("created_at", { ascending: false })
      .limit(scanLimit);

    if (input.actorParticipantId) updateQuery = updateQuery.eq("participant_id", input.actorParticipantId);

    const [interactionsResult, updatesResult] = await Promise.all([interactionQuery, updateQuery]);
    if (interactionsResult.error) throw storageError(interactionsResult.error);
    if (updatesResult.error) throw storageError(updatesResult.error);

    const interactions = interactionsResult.data ?? [];
    const updates = updatesResult.data ?? [];
    const interactionById = new Map(interactions.map((interaction) => [interaction.id, interaction]));
    const updateById = new Map(updates.map((update) => [update.id, update]));
    const interactionIds = [...interactionById.keys()];
    const updateIds = [...updateById.keys()];

    const resourceQueries = [
      this.client
        .from("resources")
        .select("id, interaction_id, update_id, url, title, source_name, note, created_at")
        .eq("relationship_id", input.relationshipId)
        .gte("created_at", input.start)
        .lt("created_at", input.end)
        .order("created_at", { ascending: false })
        .limit(scanLimit)
    ];
    if (interactionIds.length) {
      resourceQueries.push(
        this.client
          .from("resources")
          .select("id, interaction_id, update_id, url, title, source_name, note, created_at")
          .eq("relationship_id", input.relationshipId)
          .in("interaction_id", interactionIds)
          .limit(scanLimit)
      );
    }
    if (updateIds.length) {
      resourceQueries.push(
        this.client
          .from("resources")
          .select("id, interaction_id, update_id, url, title, source_name, note, created_at")
          .eq("relationship_id", input.relationshipId)
          .in("update_id", updateIds)
          .limit(scanLimit)
      );
    }

    const sourceIds = [...new Set([...interactionIds, ...updateIds])];
    const notificationQueries = [
      this.client
        .from("notification_jobs")
        .select("id, recipient_participant_id, source_kind, source_id, body, status, sent_at, last_error, created_at")
        .eq("relationship_id", input.relationshipId)
        .gte("created_at", input.start)
        .lt("created_at", input.end)
        .order("created_at", { ascending: false })
        .limit(scanLimit)
    ];
    if (sourceIds.length) {
      notificationQueries.push(
        this.client
          .from("notification_jobs")
          .select("id, recipient_participant_id, source_kind, source_id, body, status, sent_at, last_error, created_at")
          .eq("relationship_id", input.relationshipId)
          .in("source_id", sourceIds)
          .limit(scanLimit)
      );
    }

    const pageRevisionQuery = updateIds.length
      ? this.client
          .from("page_revisions")
          .select("update_id, page_id, title")
          .eq("relationship_id", input.relationshipId)
          .in("update_id", updateIds)
      : Promise.resolve({ data: [], error: null });

    const attentionQuery = updateIds.length
      ? this.client
          .from("attention_records")
          .select("update_id, target_participant_id")
          .eq("relationship_id", input.relationshipId)
          .in("update_id", updateIds)
      : Promise.resolve({ data: [], error: null });

    const [resourceResults, notificationResults, pageRevisionResult, attentionResult] = await Promise.all([
      Promise.all(resourceQueries),
      Promise.all(notificationQueries),
      pageRevisionQuery,
      attentionQuery
    ]);

    const resourceRowsById = new Map<string, any>();
    for (const result of resourceResults) {
      if (result.error) throw storageError(result.error);
      for (const resource of result.data ?? []) resourceRowsById.set(resource.id, resource);
    }

    const notificationRowsById = new Map<string, any>();
    for (const result of notificationResults) {
      if (result.error) throw storageError(result.error);
      for (const notification of result.data ?? []) notificationRowsById.set(notification.id, notification);
    }

    if (pageRevisionResult.error) throw storageError(pageRevisionResult.error);
    if (attentionResult.error) throw storageError(attentionResult.error);

    const pageIds = [...new Set((pageRevisionResult.data ?? []).map((revision: any) => revision.page_id).filter(Boolean))];
    const pageById = new Map<string, any>();
    if (pageIds.length) {
      const { data: pages, error: pagesError } = await this.client
        .from("wiki_pages")
        .select("id, path, title")
        .eq("relationship_id", input.relationshipId)
        .in("id", pageIds);
      if (pagesError) throw storageError(pagesError);
      for (const page of pages ?? []) pageById.set(page.id, page);
    }

    const resourcesByInteraction = new Map<string, ActivityResource[]>();
    const resourcesByUpdate = new Map<string, ActivityResource[]>();
    const standaloneResources: any[] = [];
    for (const resource of resourceRowsById.values()) {
      if (resource.interaction_id && interactionById.has(resource.interaction_id)) {
        resourcesByInteraction.set(resource.interaction_id, [
          ...(resourcesByInteraction.get(resource.interaction_id) ?? []),
          definedActivityResource(resource)
        ]);
      } else if (resource.update_id && updateById.has(resource.update_id)) {
        resourcesByUpdate.set(resource.update_id, [...(resourcesByUpdate.get(resource.update_id) ?? []), definedActivityResource(resource)]);
      } else {
        standaloneResources.push(resource);
      }
    }

    const notificationsBySource = new Map<string, any[]>();
    for (const notification of notificationRowsById.values()) {
      const key = `${notification.source_kind}:${notification.source_id}`;
      notificationsBySource.set(key, [...(notificationsBySource.get(key) ?? []), notification]);
    }
    for (const notifications of notificationsBySource.values()) {
      notifications.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    }

    const notificationFor = (sourceKind: "interaction" | "update", sourceId: string): ActivityNotification | undefined => {
      const notifications = notificationsBySource.get(`${sourceKind}:${sourceId}`) ?? [];
      const selected =
        (input.targetParticipantId
          ? notifications.find((notification) => notification.recipient_participant_id === input.targetParticipantId)
          : undefined) ?? notifications[0];
      if (!selected) return undefined;
      return {
        status: selected.status,
        body: selected.body,
        ...(selected.sent_at ? { sentAt: selected.sent_at } : {}),
        ...(selected.last_error ? { lastError: selected.last_error } : {})
      };
    };

    const notificationTargetIdsFor = (sourceKind: "interaction" | "update", sourceId: string): string[] =>
      (notificationsBySource.get(`${sourceKind}:${sourceId}`) ?? []).map((notification) => notification.recipient_participant_id);

    const changedPagesByUpdate = new Map<string, ActivityChangedPage[]>();
    for (const revision of pageRevisionResult.data ?? []) {
      const page = pageById.get((revision as any).page_id);
      if (!page?.path) continue;
      const changedPages = changedPagesByUpdate.get((revision as any).update_id) ?? [];
      if (!changedPages.some((changedPage) => changedPage.path === page.path)) {
        changedPages.push({
          path: page.path,
          ...(page.title || (revision as any).title ? { title: page.title ?? (revision as any).title } : {})
        });
      }
      changedPagesByUpdate.set((revision as any).update_id, changedPages);
    }

    const attentionTargetsByUpdate = new Map<string, string[]>();
    for (const attention of attentionResult.data ?? []) {
      attentionTargetsByUpdate.set((attention as any).update_id, [
        ...(attentionTargetsByUpdate.get((attention as any).update_id) ?? []),
        (attention as any).target_participant_id
      ]);
    }

    const items: ActivityItem[] = [];
    for (const interaction of interactions) {
      const actor = participantById.get(interaction.participant_id);
      const targets = uniqueParticipants(
        [...((interaction.addressed_participant_ids as string[] | null) ?? []), ...notificationTargetIdsFor("interaction", interaction.id)],
        participantById
      );
      const notification = notificationFor("interaction", interaction.id);
      const targetLabel = targets.length ? ` to ${targets.map((target) => target.displayName).join(", ")}` : "";
      const summary = notification
        ? `${actor?.displayName ?? "Someone"} sent${targetLabel}: ${compactActivityText(notification.body)}`
        : `${actor?.displayName ?? "Someone"} saved an interaction: ${compactActivityText(interaction.raw_text)}`;
      const item: ActivityItem = {
        kind: "interaction",
        occurredAt: interaction.created_at,
        displayTime: formatActivityDisplayTime(interaction.created_at, input.timezone),
        ...(actor ? { actor } : {}),
        ...(targets.length ? { targets } : {}),
        summary,
        text: interaction.raw_text,
        ...(resourcesByInteraction.get(interaction.id)?.length ? { resources: resourcesByInteraction.get(interaction.id) } : {}),
        ...(notification ? { notification } : {})
      };
      if (activityItemMatchesTarget(item, input.targetParticipantId)) items.push(item);
    }

    for (const update of updates) {
      const actor = participantById.get(update.participant_id);
      const targets = uniqueParticipants(
        [...(attentionTargetsByUpdate.get(update.id) ?? []), ...notificationTargetIdsFor("update", update.id)],
        participantById
      );
      const notification = notificationFor("update", update.id);
      const item: ActivityItem = {
        kind: "update",
        occurredAt: update.created_at,
        displayTime: formatActivityDisplayTime(update.created_at, input.timezone),
        ...(actor ? { actor } : {}),
        ...(targets.length ? { targets } : {}),
        summary: `${actor?.displayName ?? "Someone"} updated the shared graph: ${compactActivityText(update.display_text)}`,
        text: update.display_text,
        ...(resourcesByUpdate.get(update.id)?.length ? { resources: resourcesByUpdate.get(update.id) } : {}),
        ...(changedPagesByUpdate.get(update.id)?.length ? { changedPages: changedPagesByUpdate.get(update.id) } : {}),
        ...(notification ? { notification } : {})
      };
      if (activityItemMatchesTarget(item, input.targetParticipantId)) items.push(item);
    }

    if (!input.actorParticipantId && !input.targetParticipantId) {
      for (const resource of standaloneResources) {
        const activityResource = definedActivityResource(resource);
        items.push({
          kind: "resource",
          occurredAt: resource.created_at,
          displayTime: formatActivityDisplayTime(resource.created_at, input.timezone),
          summary: `Resource added: ${compactActivityText(activityResource.title ?? activityResource.url ?? activityResource.sourceName ?? "untitled resource")}`,
          resources: [activityResource]
        });
      }
    }

    const representedNotificationKeys = new Set([
      ...interactionIds.map((id) => `interaction:${id}`),
      ...updateIds.map((id) => `update:${id}`)
    ]);
    for (const notification of notificationRowsById.values()) {
      const key = `${notification.source_kind}:${notification.source_id}`;
      if (representedNotificationKeys.has(key)) continue;
      if (input.actorParticipantId) continue;
      const targets = uniqueParticipants([notification.recipient_participant_id], participantById);
      const item: ActivityItem = {
        kind: "notification",
        occurredAt: notification.created_at,
        displayTime: formatActivityDisplayTime(notification.created_at, input.timezone),
        ...(targets.length ? { targets } : {}),
        summary: `Notification ${notification.status}${targets.length ? ` to ${targets.map((target) => target.displayName).join(", ")}` : ""}: ${compactActivityText(notification.body)}`,
        notification: {
          status: notification.status,
          body: notification.body,
          ...(notification.sent_at ? { sentAt: notification.sent_at } : {}),
          ...(notification.last_error ? { lastError: notification.last_error } : {})
        }
      };
      if (activityItemMatchesTarget(item, input.targetParticipantId)) items.push(item);
    }

    items.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.summary.localeCompare(b.summary));

    return {
      items: items.slice(0, input.limit)
    };
  }

  private async commitUpdateBatch(input: CommitUpdateBatchInput): Promise<unknown> {
    const participant = await this.requireParticipantMembership(input.relationshipId, input.participantId);
    const rpcName = this.auth.kind === "connector_token" || this.auth.kind === "oauth_access_token" ? "commit_update_batch_for_user" : "commit_update_batch";
    const rpcArgs =
      this.auth.kind === "connector_token" || this.auth.kind === "oauth_access_token" ? { payload: input, target_user_id: participant.userId } : { payload: input };
    const { data, error } = await this.client.rpc(rpcName, rpcArgs);

    if (error) {
      await this.recordUpdateBatchRejection(buildUpdateBatchRejectionRecord(input, "error", error.message, []));
      throw storageError(error);
    }

    if (isRejectedBatchResult(data)) {
      const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason : "rejected";
      await this.recordUpdateBatchRejection(
        buildUpdateBatchRejectionRecord(input, reason === "stale" ? "stale" : "error", reason, data.changedPaths)
      );
    }

    return data;
  }

  // Rejected batches roll back atomically and are invisible in list_activity, so this
  // audit row is the only durable trace. Best-effort by design: a failed audit write
  // must never mask or alter the batch result the agent is waiting on.
  private async recordUpdateBatchRejection(record: UpdateBatchRejectionRecord): Promise<void> {
    try {
      const { error } = await this.client.from("update_batch_rejections").insert(record);
      if (error) console.warn(`Hosted update batch rejection was not recorded: ${error.message}`);
    } catch (error) {
      console.warn(`Hosted update batch rejection was not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createReminder(input: CreateReminderInput): Promise<unknown> {
    await this.requireParticipantMembership(input.relationshipId, input.participantId);

    const scheduledFor = new Date(input.scheduledFor);
    if (!Number.isFinite(scheduledFor.getTime())) {
      throw new HostedSupabaseError(400, "Reminder scheduledFor must be a valid timestamp");
    }

    const { data: sourceInteraction, error: interactionError } = await this.client
      .from("interactions")
      .select("id, notification_text")
      .eq("id", input.sourceInteractionId)
      .eq("relationship_id", input.relationshipId)
      .eq("participant_id", input.participantId)
      .maybeSingle();

    if (interactionError) throw storageError(interactionError);
    if (!sourceInteraction) {
      throw new HostedSupabaseError(400, "Reminder sourceInteractionId must belong to the creating participant and relationship");
    }
    if (sourceInteractionHasImmediateNotification(sourceInteraction)) {
      throw new HostedSupabaseError(
        400,
        "Reminder sourceInteractionId already queued an immediate SMS notification; do not also create a reminder for the same direct message"
      );
    }

    const { data: recipient, error: recipientError } = await this.client
      .from("participants")
      .select("id")
      .eq("id", input.recipientParticipantId)
      .eq("relationship_id", input.relationshipId)
      .maybeSingle();

    if (recipientError) throw storageError(recipientError);
    if (!recipient) throw new HostedSupabaseError(400, "Reminder recipientParticipantId must belong to the relationship");

    const { data, error } = await this.client
      .from("reminders")
      .insert({
        relationship_id: input.relationshipId,
        created_by_participant_id: input.participantId,
        recipient_participant_id: input.recipientParticipantId,
        source_interaction_id: input.sourceInteractionId,
        body: input.body,
        remind_at: scheduledFor.toISOString(),
        timezone: input.timezone,
        status: "scheduled"
      })
      .select("id, remind_at, status, notification_job_id, created_at")
      .single();

    if (error) throw storageError(error);

    return {
      reminderId: data.id,
      scheduledFor: data.remind_at,
      status: data.status,
      notificationJobId: data.notification_job_id,
      createdAt: data.created_at
    };
  }

  private async getRelationshipContext(input: GetRelationshipContextInput): Promise<unknown> {
    const user = await this.requireRelationshipMembership(input.relationshipId);
    const { data: relationship, error: relationshipError } = await this.client
      .from("relationships")
      .select("id, display_name, created_at, updated_at")
      .eq("id", input.relationshipId)
      .single();

    if (relationshipError) throw storageError(relationshipError);

    const { data: participants, error: participantsError } = await this.client
      .from("participants")
      .select("id, user_id, display_name")
      .eq("relationship_id", input.relationshipId)
      .order("display_name", { ascending: true });

    if (participantsError) throw storageError(participantsError);

    let contact = null;
    if (input.contactHandle) {
      const { data: contactData, error: contactError } = await this.client
        .from("contacts")
        .select("handle, relationship_id, participant_id, display_name")
        .eq("owner_user_id", user.id)
        .eq("handle", input.contactHandle)
        .eq("relationship_id", input.relationshipId)
        .maybeSingle();

      if (contactError) throw storageError(contactError);
      contact = contactData;
    }

    const indexPath = "wiki/index.md";
    if (!isSafeGraphPath(indexPath)) throw new HostedSupabaseError(500, "Internal graph path validation failed");

    const { data: indexPage, error: indexError } = await this.client
      .from("wiki_pages")
      .select("path, title, content_hash, version, updated_at")
      .eq("relationship_id", input.relationshipId)
      .eq("path", indexPath)
      .maybeSingle();

    if (indexError) throw storageError(indexError);

    return {
      relationship: {
        id: relationship.id,
        displayName: relationship.display_name,
        createdAt: relationship.created_at,
        updatedAt: relationship.updated_at
      },
      participants: (participants ?? []).map((participant) => ({
        id: participant.id,
        userId: participant.user_id,
        displayName: participant.display_name
      })),
      contact: contact
        ? {
            handle: contact.handle,
            participantId: contact.participant_id,
            displayName: contact.display_name
          }
        : null,
      indexPage: indexPage
        ? {
            path: indexPage.path,
            title: indexPage.title,
            contentHash: indexPage.content_hash,
            version: indexPage.version,
            updatedAt: indexPage.updated_at
          }
        : null
    };
  }
}
