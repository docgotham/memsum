import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { participantCap, productHosts, type ProductEnv } from "./product.js";

export interface HostedAuthOptions {
  supabaseUrl?: string;
  anonKey?: string;
  accessToken?: string;
  email?: string;
  password?: string;
}

export interface HostedLoginLinkOptions {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  redirectTo?: string;
  shouldCreateUser?: boolean;
}

export interface HostedSmokeOptions extends HostedAuthOptions {
  endpoint: string;
  contactHandle: string;
  relationshipDisplayName: string;
  selfDisplayName: string;
  peerDisplayName: string;
  contactDisplayName?: string;
  agent: string;
  smokePath?: string;
  now?: Date;
  fetchFn?: typeof fetch;
}

export interface HostedConnectorTokenOptions extends HostedAuthOptions {
  name: string;
  expiresAt?: string;
}

export interface HostedConnectorTokenResult {
  token: string;
  tokenId: string;
  name: string;
  expiresAt: string | null;
}

export interface HostedConnectorTokenSummary {
  tokenId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface HostedSmokeResult {
  relationshipDisplayName: string;
  contactHandle: string;
  createdRelationship: boolean;
  smokePath: string;
  beforeVersion: number;
  afterVersion: number;
  staleRejected: boolean;
  staleChangedPaths: string[];
}

interface McpToolResult {
  content?: Array<{ text?: string }>;
  isError?: boolean;
  structuredContent?: {
    result?: unknown;
  };
}

interface JsonRpcResponse {
  error?: {
    message?: string;
  };
  result?: McpToolResult;
}

interface HostedContext {
  relationshipId: string;
  selfParticipantId: string;
  relationshipDisplayName: string;
}

export class HostedOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedOperatorError";
  }
}

export function createConnectorToken(): string {
  return `memsum_${randomBytes(32).toString("base64url")}`;
}

export function hashConnectorToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function requestHostedLoginLink(options: HostedLoginLinkOptions): Promise<void> {
  const supabase = createClient(options.supabaseUrl, options.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { error } = await supabase.auth.signInWithOtp({
    email: options.email,
    options: {
      emailRedirectTo: options.redirectTo,
      shouldCreateUser: options.shouldCreateUser ?? true
    }
  });

  if (error) throw new HostedOperatorError(error.message);
}

export async function signInHostedUser(options: HostedAuthOptions): Promise<string> {
  if (options.accessToken) return options.accessToken;
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");
  if (!options.email) throw new HostedOperatorError("Missing Supabase Auth email");
  if (!options.password) throw new HostedOperatorError("Missing Supabase Auth password");

  const supabase = createClient(options.supabaseUrl, options.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { data, error } = await supabase.auth.signInWithPassword({
    email: options.email,
    password: options.password
  });

  if (error) throw new HostedOperatorError(error.message);
  if (!data.session?.access_token) throw new HostedOperatorError("Supabase Auth did not return an access token");
  return data.session.access_token;
}

export async function issueHostedConnectorToken(options: HostedConnectorTokenOptions): Promise<HostedConnectorTokenResult> {
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");

  const accessToken = await signInHostedUser(options);
  const connectorToken = createConnectorToken();
  const supabase = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const { data, error } = await supabase.rpc("issue_connector_token", {
    payload: {
      name: options.name,
      tokenHash: hashConnectorToken(connectorToken),
      expiresAt: options.expiresAt
    }
  });

  if (error) throw new HostedOperatorError(error.message);
  const result = asRecord(data);
  return {
    token: connectorToken,
    tokenId: stringValue(result.tokenId, "issue_connector_token.tokenId"),
    name: stringValue(result.name, "issue_connector_token.name"),
    expiresAt: typeof result.expiresAt === "string" ? result.expiresAt : null
  };
}

export async function listHostedConnectorTokens(options: HostedAuthOptions): Promise<HostedConnectorTokenSummary[]> {
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");

  const accessToken = await signInHostedUser(options);
  const supabase = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const { data, error } = await supabase.rpc("list_connector_tokens");
  if (error) throw new HostedOperatorError(error.message);

  return arrayValue(data, "list_connector_tokens").map((item) => {
    const token = asRecord(item);
    return {
      tokenId: stringValue(token.tokenId, "connector token id"),
      name: stringValue(token.name, "connector token name"),
      createdAt: stringValue(token.createdAt, "connector token createdAt"),
      lastUsedAt: nullableStringValue(token.lastUsedAt, "connector token lastUsedAt"),
      expiresAt: nullableStringValue(token.expiresAt, "connector token expiresAt"),
      revokedAt: nullableStringValue(token.revokedAt, "connector token revokedAt")
    };
  });
}

export async function revokeHostedConnectorToken(
  options: HostedAuthOptions & { tokenId: string }
): Promise<{ revoked: boolean }> {
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");

  const accessToken = await signInHostedUser(options);
  const supabase = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const { data, error } = await supabase.rpc("revoke_connector_token", { target_token_id: options.tokenId });
  if (error) throw new HostedOperatorError(error.message);
  const result = asRecord(data);
  return { revoked: result.revoked === true };
}

export interface HostedInvitationCreateOptions extends HostedAuthOptions {
  relationshipId: string;
  participantId?: string;
  newParticipantDisplayName?: string;
  expiresAt?: string;
  productEnv?: ProductEnv;
}

export interface HostedInvitationCreateResult {
  token: string;
  inviteLink: string;
  invitationId: string;
  participantId: string;
  participantDisplayName: string;
  expiresAt: string | null;
}

export interface HostedInvitationSummary {
  invitationId: string;
  participantId: string | null;
  participantDisplayName: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface HostedInvitationClaimResult {
  relationshipId: string;
  relationshipDisplayName: string | null;
  participantId: string;
  participantDisplayName: string;
  alreadyClaimed: boolean;
}

export function createInviteToken(): string {
  return `memsum_invite_${randomBytes(32).toString("base64url")}`;
}

export function buildInviteLink(token: string, productEnv?: ProductEnv): string {
  return `${productHosts(productEnv).siteUrl}/invite/${token}`;
}

export async function createHostedInvitation(options: HostedInvitationCreateOptions): Promise<HostedInvitationCreateResult> {
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");
  if ((options.participantId ? 1 : 0) + (options.newParticipantDisplayName ? 1 : 0) !== 1) {
    throw new HostedOperatorError("Provide exactly one of participantId or newParticipantDisplayName");
  }

  const accessToken = await signInHostedUser(options);
  const inviteToken = createInviteToken();
  const supabase = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const { data, error } = await supabase.rpc("create_participant_invitation", {
    payload: {
      relationshipId: options.relationshipId,
      ...(options.participantId ? { participantId: options.participantId } : {}),
      ...(options.newParticipantDisplayName ? { newParticipantDisplayName: options.newParticipantDisplayName } : {}),
      tokenHash: hashConnectorToken(inviteToken),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      participantCap: participantCap(options.productEnv)
    }
  });

  if (error) throw new HostedOperatorError(error.message);
  const result = asRecord(data);
  if (result.ok !== true) {
    throw new HostedOperatorError(
      `Invitation was not created: ${typeof result.reason === "string" ? result.reason : "unknown reason"}`
    );
  }

  return {
    token: inviteToken,
    inviteLink: buildInviteLink(inviteToken, options.productEnv),
    invitationId: stringValue(result.invitationId, "create_participant_invitation.invitationId"),
    participantId: stringValue(result.participantId, "create_participant_invitation.participantId"),
    participantDisplayName: stringValue(result.participantDisplayName, "create_participant_invitation.participantDisplayName"),
    expiresAt: typeof result.expiresAt === "string" ? result.expiresAt : null
  };
}

export async function listHostedInvitations(
  options: HostedAuthOptions & { relationshipId: string }
): Promise<HostedInvitationSummary[]> {
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");

  const accessToken = await signInHostedUser(options);
  const supabase = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const { data, error } = await supabase.rpc("list_invitations", { p_relationship_id: options.relationshipId });
  if (error) throw new HostedOperatorError(error.message);

  return arrayValue(data, "list_invitations").map((item) => {
    const invitation = asRecord(item);
    return {
      invitationId: stringValue(invitation.invitationId, "invitation id"),
      participantId: nullableStringValue(invitation.participantId, "invitation participantId"),
      participantDisplayName: nullableStringValue(invitation.participantDisplayName, "invitation participantDisplayName"),
      status: stringValue(invitation.status, "invitation status"),
      createdAt: stringValue(invitation.createdAt, "invitation createdAt"),
      expiresAt: nullableStringValue(invitation.expiresAt, "invitation expiresAt"),
      acceptedAt: nullableStringValue(invitation.acceptedAt, "invitation acceptedAt"),
      revokedAt: nullableStringValue(invitation.revokedAt, "invitation revokedAt")
    };
  });
}

export async function revokeHostedInvitation(
  options: HostedAuthOptions & { invitationId: string }
): Promise<{ revoked: boolean; reason?: string }> {
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");

  const accessToken = await signInHostedUser(options);
  const supabase = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const { data, error } = await supabase.rpc("revoke_invitation", { p_invitation_id: options.invitationId });
  if (error) throw new HostedOperatorError(error.message);
  const result = asRecord(data);
  if (result.ok !== true) {
    return { revoked: false, reason: typeof result.reason === "string" ? result.reason : "unknown reason" };
  }
  return { revoked: result.revoked === true };
}

export async function claimHostedInvitation(
  options: HostedAuthOptions & { token: string }
): Promise<HostedInvitationClaimResult> {
  if (!options.supabaseUrl) throw new HostedOperatorError("Missing Supabase URL");
  if (!options.anonKey) throw new HostedOperatorError("Missing Supabase anon key");
  const inviteToken = options.token.trim();
  if (!inviteToken) throw new HostedOperatorError("Missing invitation token");

  const accessToken = await signInHostedUser(options);
  const supabase = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const { data, error } = await supabase.rpc("claim_invitation", { p_token_hash: hashConnectorToken(inviteToken) });
  if (error) throw new HostedOperatorError(error.message);
  const result = asRecord(data);
  if (result.ok !== true) {
    throw new HostedOperatorError(
      `Invitation claim failed: ${typeof result.reason === "string" ? result.reason : "unknown reason"}`
    );
  }

  return {
    relationshipId: stringValue(result.relationshipId, "claim_invitation.relationshipId"),
    relationshipDisplayName:
      typeof result.relationshipDisplayName === "string" ? result.relationshipDisplayName : null,
    participantId: stringValue(result.participantId, "claim_invitation.participantId"),
    participantDisplayName: stringValue(result.participantDisplayName, "claim_invitation.participantDisplayName"),
    alreadyClaimed: result.alreadyClaimed === true
  };
}

export async function runHostedSmoke(options: HostedSmokeOptions): Promise<HostedSmokeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const accessToken = await signInHostedUser(options);
  const smokePath = options.smokePath ?? "wiki/synthesis/hosted-smoke-test.md";
  const now = options.now ?? new Date();
  const createdRelationship = { value: false };

  const context = await resolveOrCreateContext(options, accessToken, fetchFn, createdRelationship);
  const beforePage = asRecord(
    await callHostedMcpTool(options.endpoint, accessToken, "read_page", {
      relationshipId: context.relationshipId,
      path: smokePath
    }, fetchFn)
  );
  const beforeVersion = numberValue(beforePage.version, "read_page.version");

  const interaction = asRecord(
    await callHostedMcpTool(options.endpoint, accessToken, "commit_interaction", {
      relationshipId: context.relationshipId,
      participantId: context.selfParticipantId,
      agent: options.agent,
      rawText: "+sum hosted smoke test: verify remote MCP read, write, and stale-version rejection."
    }, fetchFn)
  );
  const interactionId = stringValue(interaction.interactionId, "commit_interaction.interactionId");
  const content = smokeContent({
    relationshipDisplayName: context.relationshipDisplayName,
    contactHandle: options.contactHandle,
    smokePath,
    timestamp: now.toISOString(),
    beforeVersion
  });

  const writeResult = asRecord(
    await callHostedMcpTool(options.endpoint, accessToken, "commit_update_batch", {
      relationshipId: context.relationshipId,
      participantId: context.selfParticipantId,
      actorKind: "participant_agent",
      agent: options.agent,
      sourceInteractionIds: [interactionId],
      displayText: "Verified the hosted remote MCP path with a smoke-test page update.",
      readSet: [
        {
          kind: "wiki_page",
          path: smokePath,
          expectedVersion: beforeVersion
        }
      ],
      wikiWrites: [
        {
          path: smokePath,
          title: "Hosted Smoke Test",
          expectedVersion: beforeVersion,
          content
        }
      ]
    }, fetchFn)
  );

  if (writeResult.ok !== true) throw new HostedOperatorError("Hosted smoke write did not commit");

  const staleResult = asRecord(
    await callHostedMcpTool(options.endpoint, accessToken, "commit_update_batch", {
      relationshipId: context.relationshipId,
      participantId: context.selfParticipantId,
      actorKind: "participant_agent",
      agent: options.agent,
      sourceInteractionIds: [interactionId],
      displayText: "This stale hosted smoke update should be rejected.",
      readSet: [
        {
          kind: "wiki_page",
          path: smokePath,
          expectedVersion: beforeVersion
        }
      ],
      wikiWrites: [
        {
          path: smokePath,
          title: "Hosted Smoke Test",
          expectedVersion: beforeVersion,
          content: `${content}\n\nThis stale write should not appear in the committed page.\n`
        }
      ]
    }, fetchFn)
  );

  const staleChangedPaths = stringArrayValue(staleResult.changedPaths, "commit_update_batch.changedPaths");
  const afterPage = asRecord(
    await callHostedMcpTool(options.endpoint, accessToken, "read_page", {
      relationshipId: context.relationshipId,
      path: smokePath
    }, fetchFn)
  );
  const afterVersion = numberValue(afterPage.version, "read_page.version");
  const staleRejected =
    staleResult.ok === false && staleResult.reason === "stale" && staleChangedPaths.includes(smokePath);

  if (!staleRejected) throw new HostedOperatorError("Hosted smoke stale write was not rejected");
  if (afterVersion !== beforeVersion + 1) {
    throw new HostedOperatorError(`Hosted smoke page version expected ${beforeVersion + 1}, got ${afterVersion}`);
  }

  return {
    relationshipDisplayName: context.relationshipDisplayName,
    contactHandle: options.contactHandle,
    createdRelationship: createdRelationship.value,
    smokePath,
    beforeVersion,
    afterVersion,
    staleRejected,
    staleChangedPaths
  };
}

async function resolveOrCreateContext(
  options: HostedSmokeOptions,
  accessToken: string,
  fetchFn: typeof fetch,
  createdRelationship: { value: boolean }
): Promise<HostedContext> {
  const contexts = asRecord(
    await callHostedMcpTool(options.endpoint, accessToken, "list_relationship_contexts", {
      contactHandle: options.contactHandle
    }, fetchFn)
  );
  const relationships = arrayValue(contexts.relationships, "list_relationship_contexts.relationships");
  if (relationships.length > 0) {
    return contextFromListEntry(asRecord(relationships[0]));
  }

  const created = asRecord(
    await callHostedMcpTool(options.endpoint, accessToken, "create_relationship_context", {
      relationshipDisplayName: options.relationshipDisplayName,
      selfDisplayName: options.selfDisplayName,
      peerDisplayName: options.peerDisplayName,
      contactHandle: options.contactHandle,
      contactDisplayName: options.contactDisplayName ?? options.peerDisplayName
    }, fetchFn)
  );
  createdRelationship.value = true;
  return {
    relationshipId: stringValue(created.relationshipId, "create_relationship_context.relationshipId"),
    selfParticipantId: stringValue(created.selfParticipantId, "create_relationship_context.selfParticipantId"),
    relationshipDisplayName: options.relationshipDisplayName
  };
}

async function callHostedMcpTool(
  endpoint: string,
  accessToken: string,
  name: string,
  args: unknown,
  fetchFn: typeof fetch
): Promise<unknown> {
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    })
  });

  const text = await response.text();
  let payload: JsonRpcResponse;
  try {
    payload = JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new HostedOperatorError(`Hosted MCP ${name} returned non-JSON status ${response.status}`);
  }

  if (payload.error) throw new HostedOperatorError(payload.error.message ?? `Hosted MCP ${name} failed`);
  if (payload.result?.isError) {
    const message = payload.result.content?.[0]?.text ?? `Hosted MCP ${name} returned a tool error`;
    throw new HostedOperatorError(message);
  }
  return payload.result?.structuredContent?.result;
}

function contextFromListEntry(entry: Record<string, unknown>): HostedContext {
  const relationship = asRecord(entry.relationship);
  const selfParticipant = asRecord(entry.selfParticipant);
  return {
    relationshipId: stringValue(relationship.id, "relationship.id"),
    selfParticipantId: stringValue(selfParticipant.id, "selfParticipant.id"),
    relationshipDisplayName: stringValue(relationship.displayName, "relationship.displayName")
  };
}

function smokeContent(input: {
  relationshipDisplayName: string;
  contactHandle: string;
  smokePath: string;
  timestamp: string;
  beforeVersion: number;
}): string {
  return `# Hosted Smoke Test

This page is a technical smoke-test surface for the hosted Mem·Sum pilot.

- Relationship: ${input.relationshipDisplayName}
- Contact handle: ${input.contactHandle}
- Smoke path: ${input.smokePath}
- Last verified at: ${input.timestamp}
- Previous version: ${input.beforeVersion}

The smoke test verifies remote MCP authentication, contact resolution, an atomic batch write, and stale-version rejection.
`;
}

export function authenticatedClient(supabaseUrl: string, anonKey: string, accessToken: string) {
  return createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostedOperatorError("Expected hosted MCP result object");
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new HostedOperatorError(`Expected ${label} array`);
  return value;
}

function stringArrayValue(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HostedOperatorError(`Expected ${label} string array`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HostedOperatorError(`Expected ${label} string`);
  return value;
}

function nullableStringValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new HostedOperatorError(`Expected ${label} string or null`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HostedOperatorError(`Expected ${label} number`);
  return value;
}
