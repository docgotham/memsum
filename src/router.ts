import { DmsumError } from "./errors.js";
import { normalizeVaultRelativePath } from "./paths.js";
import { configFromRelationship, normalizeHandle } from "./registry.js";
import { getCurrentTimePayload } from "./time.js";
import type { DmsumRegistry, PreferenceWriteInput, UpdateResource, WikiWriteInput } from "./types.js";
import { DmsumVault, type DmsumVaultOptions, type GrepResult } from "./vault.js";

export interface RelationshipContext {
  relationshipId?: string;
}

interface RelationshipInput extends RelationshipContext {
  participant?: string;
  rawText?: string;
  addressedParticipants?: string[];
  interactionIds?: string[];
}

interface RoutedPath {
  relationshipId: string;
  innerPath: string;
}

export class RoutedDmsumVault {
  private readonly vaults = new Map<string, DmsumVault>();

  constructor(
    readonly registry: DmsumRegistry,
    private readonly options: DmsumVaultOptions = {}
  ) {}

  async readFile(requestedPath: string, context: RelationshipContext = {}): Promise<{ path: string; content: string }> {
    const normalized = normalizeVaultRelativePath(requestedPath);
    if (!context.relationshipId && normalized === "DMSUM.md") {
      return { path: "DMSUM.md", content: routedContract(this.registry) };
    }

    const routedPath = parseRoutedPath(normalized);
    if (routedPath) {
      const result = await this.getVault(routedPath.relationshipId).readFile(routedPath.innerPath);
      return {
        ...result,
        path: `relationships/${routedPath.relationshipId}/${result.path}`
      };
    }

    const relationshipId = this.resolveRelationship(context);
    return this.getVault(relationshipId).readFile(normalized);
  }

  async listFiles(
    requestedPath = ".",
    context: RelationshipContext = {}
  ): Promise<Array<{ path: string; name: string; type: "file" | "dir" }>> {
    const normalized = normalizeVaultRelativePath(requestedPath, true);
    if (!context.relationshipId && normalized === "") {
      return [
        { path: "DMSUM.md", name: "DMSUM.md", type: "file" },
        { path: "relationships", name: "relationships", type: "dir" }
      ];
    }
    if (!context.relationshipId && normalized === "relationships") {
      return this.registry.relationships.map((relationship) => ({
        path: `relationships/${relationship.id}`,
        name: relationship.id,
        type: "dir" as const
      }));
    }

    const routedPath = parseRoutedPath(normalized);
    if (routedPath) {
      const result = await this.getVault(routedPath.relationshipId).listFiles(routedPath.innerPath);
      return result.map((entry) => ({
        ...entry,
        path: `relationships/${routedPath.relationshipId}/${entry.path}`
      }));
    }

    const relationshipId = this.resolveRelationship(context);
    return this.getVault(relationshipId).listFiles(normalized || ".");
  }

  async grep(args: {
    pattern: string;
    path?: string;
    caseSensitive?: boolean;
    maxResults?: number;
    relationshipId?: string;
  }): Promise<GrepResult[]> {
    if (args.relationshipId) {
      return this.getVault(this.resolveRelationship(args)).grep(args);
    }

    const normalizedPath = args.path ? normalizeVaultRelativePath(args.path, true) : "";
    const routedPath = parseRoutedPath(normalizedPath);
    if (routedPath) {
      const results = await this.getVault(routedPath.relationshipId).grep({
        ...args,
        path: routedPath.innerPath
      });
      return prefixGrepResults(routedPath.relationshipId, results);
    }

    const maxResults = args.maxResults ?? 100;
    const results: GrepResult[] = [];
    for (const relationship of this.registry.relationships) {
      const relationshipResults = await this.getVault(relationship.id).grep({
        ...args,
        maxResults: Math.max(1, maxResults - results.length)
      });
      results.push(...prefixGrepResults(relationship.id, relationshipResults));
      if (results.length >= maxResults) return results.slice(0, maxResults);
    }
    return results;
  }

  getCurrentTime() {
    return getCurrentTimePayload(this.registry.timezone, this.options.now?.() ?? new Date());
  }

  async commitInteraction(args: {
    participant: string;
    agent: string;
    rawText: string;
    addressedParticipants?: string[];
    resources?: UpdateResource[];
    notificationText?: string;
    claimToken?: string;
    relationshipId?: string;
  }) {
    const relationshipId = this.resolveRelationship(args);
    const addressedParticipants = this.resolveParticipantListForRelationship({
      owner: args.participant,
      relationshipId,
      values: args.addressedParticipants ?? extractHandles(args.rawText)
    });
    return this.getVault(relationshipId).commitInteraction({
      ...args,
      addressedParticipants
    });
  }

  async commitWikiUpdate(args: {
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
  }) {
    const relationshipId = this.resolveRelationship(args);
    const attention = this.resolveParticipantListForRelationship({
      owner: args.participant,
      relationshipId,
      values: args.attention ?? []
    });
    const preferenceWrites = args.preferenceWrites?.map((write) => ({
      ...write,
      participant: this.resolveParticipantAlias(args.participant, relationshipId, write.participant)
    }));
    return this.getVault(relationshipId).commitWikiUpdate({
      ...args,
      attention,
      preferenceWrites
    });
  }

  async claimStatus(description: string, owner: string | null = null, context: RelationshipContext = {}) {
    return this.getVault(this.resolveRelationship(context)).claimStatus(description, owner);
  }

  async releaseStatus(token: string, context: RelationshipContext = {}) {
    return this.getVault(this.resolveRelationship(context)).releaseStatus(token);
  }

  async refreshStatus(token: string, context: RelationshipContext = {}) {
    return this.getVault(this.resolveRelationship(context)).refreshStatus(token);
  }

  async listConflicts(args: { relationshipId?: string; includeResolved?: boolean } = {}) {
    if (args.relationshipId || this.registry.relationships.length === 1) {
      const relationshipId = this.resolveRelationship(args);
      return this.getVault(relationshipId).listConflicts({
        relationshipId,
        includeResolved: args.includeResolved
      });
    }

    const conflicts = [];
    for (const relationship of this.registry.relationships) {
      conflicts.push(
        ...(await this.getVault(relationship.id).listConflicts({
          relationshipId: relationship.id,
          includeResolved: args.includeResolved
        }))
      );
    }
    return conflicts;
  }

  async readConflict(args: { conflictId: string; relationshipId?: string }) {
    const relationshipId = this.resolveRelationship(args);
    return this.getVault(relationshipId).readConflict({
      ...args,
      relationshipId
    });
  }

  async resolveConflict(args: {
    conflictId: string;
    participant: string;
    agent: string;
    content: string;
    relationshipId?: string;
  }) {
    const relationshipId = this.resolveRelationship(args);
    return this.getVault(relationshipId).resolveConflict({
      ...args,
      relationshipId,
      participant: this.resolveParticipantAlias(args.participant, relationshipId, args.participant)
    });
  }

  private getVault(relationshipId: string): DmsumVault {
    const normalized = this.resolveRelationship({ relationshipId });
    const existing = this.vaults.get(normalized);
    if (existing) return existing;
    const vault = new DmsumVault(configFromRelationship(this.registry, normalized), this.options);
    this.vaults.set(normalized, vault);
    return vault;
  }

  private resolveRelationship(input: RelationshipInput): string {
    if (input.relationshipId) {
      if (!this.registry.relationships.some((relationship) => relationship.id === input.relationshipId)) {
        throw new DmsumError(`Unknown relationship: ${input.relationshipId}`);
      }
      return input.relationshipId;
    }

    if (this.registry.relationships.length === 1) {
      return this.registry.relationships[0].id;
    }

    const owner = input.participant ? this.resolveOwner(input.participant).id : this.registry.defaultOwnerId;
    const handles = [
      ...(input.rawText ? extractHandles(input.rawText) : []),
      ...(input.addressedParticipants ?? [])
    ].map(normalizeHandle);
    const contactRelationships = new Set<string>();
    for (const handle of handles) {
      const contact = this.registry.contacts.find(
        (candidate) => candidate.ownerId === owner && candidate.handle === handle
      );
      if (contact) contactRelationships.add(contact.relationshipId);
    }
    if (contactRelationships.size === 1) {
      return [...contactRelationships][0];
    }
    if (contactRelationships.size > 1) {
      throw new DmsumError("Multiple contact handles point to different relationships; pass relationshipId explicitly");
    }

    throw new DmsumError(
      "relationshipId is required when a routed Mem·Sum server cannot infer a single relationship from @contact context"
    );
  }

  private resolveOwner(participant: string) {
    const normalized = normalizeLookup(participant);
    const owner = this.registry.users.find(
      (candidate) => normalizeLookup(candidate.id) === normalized || normalizeLookup(candidate.displayName) === normalized
    );
    if (!owner) {
      throw new DmsumError(`Unknown registry user: ${participant}`);
    }
    return owner;
  }

  private resolveParticipantListForRelationship(args: {
    owner: string;
    relationshipId: string;
    values: string[];
  }): string[] {
    const normalized = new Set<string>();
    for (const value of args.values) {
      normalized.add(this.resolveParticipantAlias(args.owner, args.relationshipId, value));
    }
    return [...normalized];
  }

  private resolveParticipantAlias(owner: string, relationshipId: string, value: string): string {
    const relationship = this.registry.relationships.find((candidate) => candidate.id === relationshipId);
    if (!relationship) throw new DmsumError(`Unknown relationship: ${relationshipId}`);
    const normalizedValue = normalizeLookup(value);
    const participant = relationship.participants.find(
      (candidate) =>
        normalizeLookup(candidate.id) === normalizedValue ||
        normalizeLookup(candidate.displayName) === normalizedValue
    );
    if (participant) return participant.id;

    const ownerId = this.resolveOwner(owner).id;
    const handle = normalizeHandle(value);
    const contact = this.registry.contacts.find(
      (candidate) =>
        candidate.ownerId === ownerId && candidate.handle === handle && candidate.relationshipId === relationshipId
    );
    if (contact) return contact.participantId;

    return value;
  }
}

function parseRoutedPath(normalizedPath: string): RoutedPath | null {
  if (!normalizedPath.startsWith("relationships/")) return null;
  const [, relationshipId, ...rest] = normalizedPath.split("/");
  if (!relationshipId) return null;
  return {
    relationshipId,
    innerPath: rest.length > 0 ? rest.join("/") : "."
  };
}

function prefixGrepResults(relationshipId: string, results: GrepResult[]): GrepResult[] {
  return results.map((result) => ({
    ...result,
    path: `relationships/${relationshipId}/${result.path}`
  }));
}

function extractHandles(rawText: string): string[] {
  const handles = new Set<string>();
  for (const match of rawText.matchAll(/(^|[\s([{])@([a-zA-Z0-9][a-zA-Z0-9_-]*)\b/g)) {
    handles.add(normalizeHandle(match[2]));
  }
  return [...handles];
}

function normalizeLookup(value: string): string {
  return value
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function routedContract(registry: DmsumRegistry): string {
  const relationships = registry.relationships
    .map((relationship) => `- ${relationship.id}${relationship.displayName ? `: ${relationship.displayName}` : ""}`)
    .join("\n");
  const contacts = registry.contacts
    .map(
      (contact) =>
        `- ${contact.ownerId}: @${contact.handle} -> ${contact.relationshipId}/${contact.participantId}`
    )
    .join("\n");
  return [
    "# DMSUM.md",
    "",
    "Mem·Sum routed local contract.",
    "",
    "- This MCP server routes across multiple relationship workspaces.",
    "- Use +sum, +dm, or +dmsum as invocation signals in ordinary agent chat.",
    "- Owner-scoped contact handles such as @lisa select a relationship when they are unambiguous.",
    "- Pass relationshipId explicitly on read, search, STATUS, and wiki-update calls when the relationship is not obvious.",
    "- read_file, list_files, and grep also support virtual paths under relationships/{relationshipId}/.",
    "- Each relationship workspace keeps its own interactions/, wiki-updates/, wiki/, preferences/, log.md, state, and notifications.",
    "- Each relationship workspace also keeps its own conflicts/ records when a baseHash-protected write finds that the target changed first.",
    "- Use list_conflicts, read_conflict, and resolve_conflict to inspect and harmonize those stale writes.",
    "- In Git-backed local mode, each relationship workspace is also its own Git worktree; sync status reports local pending changes and sync doctor checks setup health.",
    "- Git conflicts should be inspected and harmonized by an agent before sync resolve. Preserve both participants' durable meaning, carry forward non-conflicting new pages, reconcile overlapping pages, and update index links when needed.",
    "- Preserve the participant's exact wording with commit_interaction before integrating durable write/update acts with commit_wiki_update. Read-only retrieval should normally stay read-only.",
    "- Do not share wiki pages or participant preferences across relationships unless the participant explicitly reintroduces that material.",
    "- Hide internal IDs, paths, timestamps, storage mechanics, and MCP details from participant-facing answers unless asked.",
    "",
    "## Relationships",
    "",
    relationships || "- none",
    "",
    "## Contacts",
    "",
    contacts || "- none",
    ""
  ].join("\n");
}
