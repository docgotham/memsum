import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DmsumError } from "./errors.js";
import { AsyncMutex } from "./mutex.js";
import { DryRunNotifier } from "./notifier.js";
import { conflictFilePath, displayPath, interactionFilePath, isWikiPath, resolveVaultPath, wikiUpdateFilePath } from "./paths.js";
import { allocateConflictId, allocateInteractionId, allocateWikiUpdateId } from "./state.js";
import { getCurrentTimePayload, getZonedTimestamp } from "./time.js";
import type {
  DmsumConfig,
  ConflictRecord,
  ConflictSummary,
  ConflictTargetKind,
  InteractionCommit,
  Participant,
  PreferenceWriteInput,
  StatusClaim,
  WikiWriteInput,
  WikiUpdateCommit,
  UpdateResource
} from "./types.js";

const wikiRoots = new Set(["wiki/entities", "wiki/topics", "wiki/concepts", "wiki/synthesis"]);

export interface DmsumVaultOptions {
  now?: () => Date;
  notifier?: DryRunNotifier;
}

export interface GrepResult {
  path: string;
  lineNumber: number;
  line: string;
}

interface PreparedWikiWrite {
  path: string;
  absolutePath: string;
  title: string;
  content: string;
  bytes: number;
  baseHash?: string;
}

interface PreparedPreferenceWrite {
  participant: Participant;
  path: string;
  absolutePath: string;
  content: string;
  bytes: number;
  baseHash?: string;
}

interface PreparedConflict {
  conflictId: string;
  conflictPath: string;
  absolutePath: string;
  record: ConflictRecord;
  bytes: number;
}

export class DmsumVault {
  private readonly mutex = new AsyncMutex();
  private readonly now: () => Date;
  private readonly notifier: DryRunNotifier;

  constructor(readonly config: DmsumConfig, options: DmsumVaultOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.notifier = options.notifier ?? new DryRunNotifier(config);
  }

  async readFile(requestedPath: string, context: { relationshipId?: string } = {}): Promise<{ path: string; content: string; hash: string }> {
    this.assertRelationshipContext(context.relationshipId);
    const resolved = resolveVaultPath(this.config.vaultRoot, requestedPath);
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) {
      throw new DmsumError(`${displayPath(resolved.relativePath)} is not a file`);
    }
    const content = await fs.readFile(resolved.absolutePath, "utf8");
    return {
      path: resolved.relativePath,
      content,
      hash: hashContent(content)
    };
  }

  async listFiles(
    requestedPath = ".",
    context: { relationshipId?: string } = {}
  ): Promise<Array<{ path: string; name: string; type: "file" | "dir" }>> {
    this.assertRelationshipContext(context.relationshipId);
    const resolved = resolveVaultPath(this.config.vaultRoot, requestedPath, true);
    const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => {
        const childPath = resolved.relativePath ? `${resolved.relativePath}/${entry.name}` : entry.name;
        return {
          path: childPath.replace(/\\/g, "/"),
          name: entry.name,
          type: entry.isDirectory() ? ("dir" as const) : ("file" as const)
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async grep(args: {
    pattern: string;
    path?: string;
    caseSensitive?: boolean;
    maxResults?: number;
    relationshipId?: string;
  }): Promise<GrepResult[]> {
    this.assertRelationshipContext(args.relationshipId);
    const maxResults = args.maxResults ?? 100;
    const flags = args.caseSensitive ? "u" : "iu";
    const regex = new RegExp(args.pattern, flags);
    const resolved = resolveVaultPath(this.config.vaultRoot, args.path ?? ".", true);
    const files = await collectMarkdownFiles(resolved.absolutePath);
    const results: GrepResult[] = [];

    for (const file of files) {
      const relativePath = path.relative(this.config.vaultRoot, file).replace(/\\/g, "/");
      const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          results.push({ path: relativePath, lineNumber: index + 1, line });
          if (results.length >= maxResults) return results;
        }
      }
    }

    return results;
  }

  getCurrentTime() {
    return getCurrentTimePayload(this.config.timezone, this.now());
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
  }): Promise<InteractionCommit & { notifications: number }> {
    this.assertRelationshipContext(args.relationshipId);
    const participant = this.resolveParticipant(args.participant);
    const agent = requiredTrimmedText(args.agent, "agent is required");
    const rawText = requiredTrimmedText(args.rawText, "rawText is required");
    const addressedParticipants = this.resolveAttention(args.addressedParticipants ?? []).map(
      (addressedParticipant) => addressedParticipant.id
    );
    const resources = normalizeResources(args.resources ?? []);

    return this.mutex.runExclusive(async () => {
      await this.ensureNoConflictingClaim(args.claimToken);
      const zoned = getZonedTimestamp(this.now(), this.config.timezone);
      const interactionId = await allocateInteractionId(this.config.stateDir);
      const interactionPath = interactionFilePath({
        year: zoned.year,
        month: zoned.month,
        day: zoned.day,
        interactionId
      });
      const interactionFile = this.formatInteractionFile({
        interactionId,
        timestamp: zoned.display,
        participant,
        agent,
        rawText,
        addressedParticipants,
        resources
      });

      const absoluteInteractionPath = path.join(this.config.vaultRoot, interactionPath);
      await fs.mkdir(path.dirname(absoluteInteractionPath), { recursive: true });
      await fs.writeFile(absoluteInteractionPath, interactionFile, { encoding: "utf8", flag: "wx" });

      const commit: InteractionCommit = {
        interactionId,
        timestamp: zoned.display,
        interactionPath,
        relationshipId: this.config.relationshipId,
        participant,
        agent,
        rawText,
        addressedParticipants,
        resources
      };
      await this.appendLog("commit_interaction", {
        interactionId,
        participant: participant.id,
        agent,
        addressedParticipants,
        target: interactionPath,
        resources: resources.length,
        ...(args.claimToken ? { claimId: claimFingerprint(args.claimToken) } : {})
      });
      const notifications = await this.notifier.notifyInteraction(commit, args.notificationText);
      return {
        ...commit,
        notifications: notifications.length
      };
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
  }): Promise<
    WikiUpdateCommit & {
      notifications: number;
      wikiWrites: Array<{ path: string; bytes: number }>;
      preferenceWrites: Array<{ path: string; bytes: number }>;
      conflicts: ConflictSummary[];
    }
  > {
    this.assertRelationshipContext(args.relationshipId);
    const participant = this.resolveParticipant(args.participant);
    const agent = requiredTrimmedText(args.agent, "agent is required");
    const displayText = requiredTrimmedText(args.displayText, "displayText is required");
    const tags = normalizeStringList(args.tags ?? [], "tag");
    const attentionParticipants = this.resolveAttention(args.attention ?? []);
    const attention = attentionParticipants.map((attentionParticipant) => attentionParticipant.id);
    const interactionIds = normalizeIdList(args.interactionIds, "interactionId", /^I\d{6}$/);
    const resources = normalizeResources(args.resources ?? []);
    const wikiWrites = args.wikiWrites ?? [];
    const preferenceWrites = args.preferenceWrites ?? [];
    if (wikiWrites.length === 0 && preferenceWrites.length === 0) {
      throw new DmsumError("commit_wiki_update requires at least one wiki or preference write");
    }

    return this.mutex.runExclusive(async () => {
      await this.ensureNoConflictingClaim(args.claimToken);
      await this.assertInteractionIdsExist(interactionIds);
      const zoned = getZonedTimestamp(this.now(), this.config.timezone);
      const updateId = await allocateWikiUpdateId(this.config.stateDir);
      const updatePath = wikiUpdateFilePath({
        year: zoned.year,
        month: zoned.month,
        day: zoned.day,
        updateId
      });
      const interactionTargets = await collectInteractionReferenceTargets(this.config.vaultRoot);
      const updateTargets = await collectProvenanceReferenceTargets(this.config.vaultRoot);
      updateTargets.set(updateId, updatePath);
      const preparedWrites = this.prepareWikiWrites(wikiWrites, {
        updateId,
        updatePath,
        updateTargets,
        author: participant.displayName,
        date: `${zoned.year}-${zoned.month}-${zoned.day}`
      });
      const preparedPreferenceWrites = this.preparePreferenceWrites(preferenceWrites, {
        updateId,
        updatePath,
        updateTargets,
        author: participant.displayName,
        date: `${zoned.year}-${zoned.month}-${zoned.day}`
      });
      const checkedWrites = await this.splitConflictingWrites({
        timestamp: zoned.display,
        year: zoned.year,
        month: zoned.month,
        day: zoned.day,
        updateId,
        updatePath,
        participant,
        agent,
        interactionIds,
        wikiWrites: preparedWrites,
        preferenceWrites: preparedPreferenceWrites
      });
      const wikiTitles = checkedWrites.wikiWrites.map((write) => write.title);
      const wikiPaths = checkedWrites.wikiWrites.map((write) => write.path);
      const preferencePaths = checkedWrites.preferenceWrites.map((write) => write.path);
      const conflictPaths = checkedWrites.conflicts.map((conflict) => conflict.conflictPath);
      const updateFile = this.formatWikiUpdateFile({
        updateId,
        updatePath,
        timestamp: zoned.display,
        participant,
        agent,
        tags,
        attention,
        interactionIds,
        interactionTargets,
        displayText,
        resources,
        wikiTitles,
        wikiPaths,
        preferencePaths,
        conflictPaths,
        wikiWrites: checkedWrites.wikiWrites,
        preferenceWrites: checkedWrites.preferenceWrites,
        conflicts: checkedWrites.conflicts
      });

      const absoluteUpdatePath = path.join(this.config.vaultRoot, updatePath);
      await fs.mkdir(path.dirname(absoluteUpdatePath), { recursive: true });
      await fs.writeFile(absoluteUpdatePath, updateFile, { encoding: "utf8", flag: "wx" });

      for (const conflict of checkedWrites.conflicts) {
        await fs.mkdir(path.dirname(conflict.absolutePath), { recursive: true });
        await fs.writeFile(conflict.absolutePath, this.formatConflictFile(conflict.record), { encoding: "utf8", flag: "wx" });
      }
      for (const write of checkedWrites.wikiWrites) {
        await fs.mkdir(path.dirname(write.absolutePath), { recursive: true });
        await fs.writeFile(write.absolutePath, write.content, "utf8");
      }
      for (const write of checkedWrites.preferenceWrites) {
        await fs.mkdir(path.dirname(write.absolutePath), { recursive: true });
        await fs.writeFile(write.absolutePath, write.content, "utf8");
      }

      const commit: WikiUpdateCommit = {
        updateId,
        timestamp: zoned.display,
        updatePath,
        relationshipId: this.config.relationshipId,
        participant,
        agent,
        tags,
        attention,
        interactionIds,
        wikiTitles,
        wikiPaths,
        preferencePaths,
        conflictPaths,
        resources
      };
      await this.appendLog("commit_wiki_update", {
        updateId,
        participant: participant.id,
        agent,
        tags,
        attention,
        interactionIds,
        target: updatePath,
        wikiPaths,
        preferencePaths,
        conflictPaths,
        resources: resources.length,
        ...(args.claimToken ? { claimId: claimFingerprint(args.claimToken) } : {})
      });
      const notifications = await this.notifier.notifyWikiUpdate(commit, args.notificationText);
      return {
        ...commit,
        notifications: notifications.length,
        wikiWrites: checkedWrites.wikiWrites.map((write) => ({ path: write.path, bytes: write.bytes })),
        preferenceWrites: checkedWrites.preferenceWrites.map((write) => ({ path: write.path, bytes: write.bytes })),
        conflicts: checkedWrites.conflicts.map((conflict) => summarizeConflict(conflict.conflictPath, conflict.record))
      };
    });
  }

  async claimStatus(
    description: string,
    owner: string | null = null,
    context: { relationshipId?: string } = {}
  ): Promise<StatusClaim> {
    this.assertRelationshipContext(context.relationshipId);
    return this.mutex.runExclusive(async () => {
      const existing = await this.readStatusClaim();
      if (existing && !this.isClaimStale(existing)) {
        throw new DmsumError(`Active STATUS claim exists: ${existing.description}`);
      }
      if (existing) {
        await this.writeNoStatus();
        await this.appendLog("cleared_stale_claim", {
          token: existing.token,
          description: existing.description
        });
      }

      const now = this.now().toISOString();
      const claim: StatusClaim = {
        token: crypto.randomUUID(),
        description,
        owner,
        claimedAt: now,
        refreshedAt: now
      };
      await this.writeStatusClaim(claim);
      await this.appendLog("claim_status", {
        token: claim.token,
        description: claim.description,
        owner: claim.owner
      });
      return claim;
    });
  }

  async releaseStatus(token: string, context: { relationshipId?: string } = {}): Promise<{ released: true }> {
    this.assertRelationshipContext(context.relationshipId);
    return this.mutex.runExclusive(async () => {
      const claim = await this.readStatusClaim();
      if (!claim) {
        throw new DmsumError("No active STATUS claim");
      }
      if (claim.token !== token) {
        throw new DmsumError("STATUS token does not match active claim");
      }
      await this.writeNoStatus();
      await this.appendLog("release_status", {
        token,
        description: claim.description
      });
      return { released: true };
    });
  }

  async refreshStatus(token: string, context: { relationshipId?: string } = {}): Promise<StatusClaim> {
    this.assertRelationshipContext(context.relationshipId);
    return this.mutex.runExclusive(async () => {
      const claim = await this.readStatusClaim();
      if (!claim) {
        throw new DmsumError("No active STATUS claim");
      }
      if (claim.token !== token) {
        throw new DmsumError("STATUS token does not match active claim");
      }
      const refreshed: StatusClaim = {
        ...claim,
        refreshedAt: this.now().toISOString()
      };
      await this.writeStatusClaim(refreshed);
      return refreshed;
    });
  }

  async listConflicts(
    args: { relationshipId?: string; includeResolved?: boolean } = {}
  ): Promise<ConflictSummary[]> {
    this.assertRelationshipContext(args.relationshipId);
    const conflicts = await this.collectConflictFiles();
    return conflicts
      .filter((conflict) => args.includeResolved || conflict.record.status === "open")
      .map((conflict) => summarizeConflict(conflict.conflictPath, conflict.record))
      .sort((a, b) => a.conflictId.localeCompare(b.conflictId));
  }

  async readConflict(args: {
    conflictId: string;
    relationshipId?: string;
  }): Promise<ConflictRecord & { conflictPath: string; content: string }> {
    this.assertRelationshipContext(args.relationshipId);
    const conflictId = normalizeConflictId(args.conflictId);
    const conflict = await this.findConflictFile(conflictId);
    return {
      ...conflict.record,
      conflictPath: conflict.conflictPath,
      content: conflict.content
    };
  }

  async resolveConflict(args: {
    conflictId: string;
    participant: string;
    agent: string;
    content: string;
    relationshipId?: string;
  }): Promise<{ conflictId: string; conflictPath: string; targetPath: string; targetHash: string; resolvedAt: string }> {
    this.assertRelationshipContext(args.relationshipId);
    const conflictId = normalizeConflictId(args.conflictId);
    const participant = this.resolveParticipant(args.participant);
    const agent = requiredTrimmedText(args.agent, "agent is required");
    const resolutionContent = ensureTrailingNewline(requiredTrimmedText(args.content, "resolution content is required"));

    return this.mutex.runExclusive(async () => {
      const conflict = await this.findConflictFile(conflictId);
      if (conflict.record.status !== "open") {
        throw new DmsumError(`Conflict ${conflictId} is already resolved`);
      }

      const target = resolveVaultPath(this.config.vaultRoot, conflict.record.targetPath);
      const currentContent = await readTextIfExists(target.absolutePath);
      const currentHash = hashContent(currentContent);
      if (currentHash !== conflict.record.currentHash) {
        throw new DmsumError(
          `Target changed since conflict ${conflictId} was recorded; read the current page before resolving`
        );
      }

      const resolvedAt = getZonedTimestamp(this.now(), this.config.timezone).display;
      const targetHash = hashContent(resolutionContent);
      const resolvedRecord: ConflictRecord = {
        ...conflict.record,
        status: "resolved",
        resolvedAt,
        resolvedBy: {
          participant: {
            id: participant.id,
            displayName: participant.displayName
          },
          agent
        },
        resolutionHash: targetHash,
        resolutionContent
      };

      await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
      await fs.writeFile(target.absolutePath, resolutionContent, "utf8");
      await fs.writeFile(conflict.absolutePath, this.formatConflictFile(resolvedRecord), "utf8");
      await this.appendLog("resolve_conflict", {
        conflictId,
        participant: participant.id,
        agent,
        conflictPath: conflict.conflictPath,
        targetPath: conflict.record.targetPath,
        targetHash
      });

      return {
        conflictId,
        conflictPath: conflict.conflictPath,
        targetPath: conflict.record.targetPath,
        targetHash,
        resolvedAt
      };
    });
  }

  private async splitConflictingWrites(args: {
    timestamp: string;
    year: string;
    month: string;
    day: string;
    updateId: string;
    updatePath: string;
    participant: Participant;
    agent: string;
    interactionIds: string[];
    wikiWrites: PreparedWikiWrite[];
    preferenceWrites: PreparedPreferenceWrite[];
  }): Promise<{
    wikiWrites: PreparedWikiWrite[];
    preferenceWrites: PreparedPreferenceWrite[];
    conflicts: PreparedConflict[];
  }> {
    const successfulWikiWrites: PreparedWikiWrite[] = [];
    const successfulPreferenceWrites: PreparedPreferenceWrite[] = [];
    const conflicts: PreparedConflict[] = [];

    for (const write of args.wikiWrites) {
      const conflict = await this.conflictForWrite({
        targetKind: "wiki",
        timestamp: args.timestamp,
        year: args.year,
        month: args.month,
        day: args.day,
        updateId: args.updateId,
        updatePath: args.updatePath,
        participant: args.participant,
        agent: args.agent,
        interactionIds: args.interactionIds,
        path: write.path,
        absolutePath: write.absolutePath,
        content: write.content,
        baseHash: write.baseHash
      });
      if (conflict) conflicts.push(conflict);
      else successfulWikiWrites.push(write);
    }

    for (const write of args.preferenceWrites) {
      const conflict = await this.conflictForWrite({
        targetKind: "preference",
        timestamp: args.timestamp,
        year: args.year,
        month: args.month,
        day: args.day,
        updateId: args.updateId,
        updatePath: args.updatePath,
        participant: args.participant,
        agent: args.agent,
        interactionIds: args.interactionIds,
        path: write.path,
        absolutePath: write.absolutePath,
        content: write.content,
        baseHash: write.baseHash
      });
      if (conflict) conflicts.push(conflict);
      else successfulPreferenceWrites.push(write);
    }

    return {
      wikiWrites: successfulWikiWrites,
      preferenceWrites: successfulPreferenceWrites,
      conflicts
    };
  }

  private async conflictForWrite(args: {
    targetKind: ConflictTargetKind;
    timestamp: string;
    year: string;
    month: string;
    day: string;
    updateId: string;
    updatePath: string;
    participant: Participant;
    agent: string;
    interactionIds: string[];
    path: string;
    absolutePath: string;
    content: string;
    baseHash?: string;
  }): Promise<PreparedConflict | null> {
    if (!args.baseHash) return null;

    const currentContent = await readTextIfExists(args.absolutePath);
    const currentHash = hashContent(currentContent);
    if (currentHash === args.baseHash) return null;

    const conflictId = await allocateConflictId(this.config.stateDir);
    const relativePath = conflictFilePath({
      year: args.year,
      month: args.month,
      day: args.day,
      conflictId
    });
    const proposedHash = hashContent(args.content);
    const record: ConflictRecord = {
      conflictId,
      status: "open",
      timestamp: args.timestamp,
      relationshipId: this.config.relationshipId,
      wikiUpdateId: args.updateId,
      wikiUpdatePath: args.updatePath,
      targetKind: args.targetKind,
      targetPath: args.path,
      baseHash: args.baseHash,
      currentHash,
      proposedHash,
      participant: {
        id: args.participant.id,
        displayName: args.participant.displayName
      },
      agent: args.agent,
      interactionIds: args.interactionIds,
      currentContent,
      proposedContent: args.content
    };
    const content = this.formatConflictFile(record);

    return {
      conflictId,
      conflictPath: relativePath,
      absolutePath: path.join(this.config.vaultRoot, relativePath),
      record,
      bytes: Buffer.byteLength(content, "utf8")
    };
  }

  private prepareWikiWrites(
    wikiWrites: WikiWriteInput[],
    reference: {
      updateId: string;
      updatePath: string;
      updateTargets: Map<string, string>;
      author: string;
      date: string;
    }
  ): PreparedWikiWrite[] {
    if (!Array.isArray(wikiWrites)) {
      throw new DmsumError("wikiWrites must be an array");
    }

    const seenPaths = new Set<string>();
    return wikiWrites.map((write) => {
      const title = requiredTrimmedText(write.title, "Wiki write title is required");
      const rawContent = requiredTrimmedText(write.content, `Wiki write content is required for ${title}`);
      const resolved = resolveVaultPath(this.config.vaultRoot, write.path);
      if (!isWikiPath(resolved.relativePath)) {
        throw new DmsumError("Wiki writes must target wiki paths");
      }
      this.assertWikiFilePath(resolved.relativePath);
      if (seenPaths.has(resolved.relativePath)) {
        throw new DmsumError(`Duplicate wiki write path: ${resolved.relativePath}`);
      }
      seenPaths.add(resolved.relativePath);
      const referenceLink = markdownLinkForWikiUpdate(resolved.relativePath, reference.updateId, reference.updatePath);
      const withPlaceholders = rawContent
        .replaceAll("{{WIKI_UPDATE_ID}}", reference.updateId)
        .replaceAll("{{WIKI_UPDATE_PATH}}", reference.updatePath)
        .replaceAll("{{WIKI_UPDATE_LINK}}", referenceLink)
        .replaceAll("{{UPDATE_ID}}", reference.updateId)
        .replaceAll("{{UPDATE_PATH}}", reference.updatePath)
        .replaceAll("{{UPDATE_LINK}}", referenceLink);
      const content = ensureWikiUpdateReferenceFooter(
        linkBareProvenanceReferences(withPlaceholders, resolved.relativePath, reference.updateTargets),
        reference.updateId,
        referenceLink,
        reference.author,
        reference.date
      );
      return {
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        title,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        baseHash: normalizeBaseHash(write.baseHash)
      };
    });
  }

  private assertRelationshipContext(relationshipId?: string): void {
    if (relationshipId && relationshipId !== this.config.relationshipId) {
      throw new DmsumError(`Unknown relationship for this vault: ${relationshipId}`);
    }
  }

  private preparePreferenceWrites(
    preferenceWrites: PreferenceWriteInput[],
    reference: {
      updateId: string;
      updatePath: string;
      updateTargets: Map<string, string>;
      author: string;
      date: string;
    }
  ): PreparedPreferenceWrite[] {
    if (!Array.isArray(preferenceWrites)) {
      throw new DmsumError("preferenceWrites must be an array");
    }

    const seenParticipants = new Set<string>();
    return preferenceWrites.map((write) => {
      const targetParticipant = this.resolveParticipant(write.participant);
      if (seenParticipants.has(targetParticipant.id)) {
        throw new DmsumError(`Duplicate preference write participant: ${targetParticipant.id}`);
      }
      seenParticipants.add(targetParticipant.id);
      const rawContent = requiredTrimmedText(
        write.content,
        `Preference write content is required for ${targetParticipant.displayName}`
      );
      const relativePath = `preferences/${targetParticipant.id}.md`;
      const resolved = resolveVaultPath(this.config.vaultRoot, relativePath);
      const referenceLink = markdownLinkForWikiUpdate(relativePath, reference.updateId, reference.updatePath);
      const withPlaceholders = rawContent
        .replaceAll("{{WIKI_UPDATE_ID}}", reference.updateId)
        .replaceAll("{{WIKI_UPDATE_PATH}}", reference.updatePath)
        .replaceAll("{{WIKI_UPDATE_LINK}}", referenceLink)
        .replaceAll("{{UPDATE_ID}}", reference.updateId)
        .replaceAll("{{UPDATE_PATH}}", reference.updatePath)
        .replaceAll("{{UPDATE_LINK}}", referenceLink);
      const content = ensureWikiUpdateReferenceFooter(
        linkBareProvenanceReferences(withPlaceholders, relativePath, reference.updateTargets),
        reference.updateId,
        referenceLink,
        reference.author,
        reference.date
      );
      return {
        participant: targetParticipant,
        path: relativePath,
        absolutePath: resolved.absolutePath,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        baseHash: normalizeBaseHash(write.baseHash)
      };
    });
  }

  private resolveParticipant(participantName: string): Participant {
    const normalized = normalizeParticipantLookup(participantName);
    const participant = this.config.participants.find(
      (candidate) =>
        normalizeParticipantLookup(candidate.id) === normalized ||
        normalizeParticipantLookup(candidate.displayName) === normalized
    );
    if (!participant) {
      throw new DmsumError(`Unknown participant: ${participantName}`);
    }
    return participant;
  }

  private resolveAttention(attentionNames: string[]): Participant[] {
    const attention = new Map<string, Participant>();
    for (const name of attentionNames) {
      const participant = this.resolveParticipant(name);
      attention.set(participant.id, participant);
    }
    return [...attention.values()];
  }

  private formatInteractionFile(args: {
    interactionId: string;
    timestamp: string;
    participant: Participant;
    agent: string;
    rawText: string;
    addressedParticipants: string[];
    resources: UpdateResource[];
  }): string {
    const lines = [
      "---",
      `id: ${args.interactionId}`,
      `timestamp: ${JSON.stringify(args.timestamp)}`,
      `relationshipId: ${JSON.stringify(this.config.relationshipId)}`,
      `participant: ${JSON.stringify(args.participant.id)}`,
      `participantName: ${JSON.stringify(args.participant.displayName)}`,
      `agent: ${JSON.stringify(args.agent)}`,
      ...(args.addressedParticipants.length > 0
        ? [`addressedParticipants: ${JSON.stringify(args.addressedParticipants)}`]
        : []),
      "---",
      "",
      "## Raw Text",
      "",
      ...fencedText(args.rawText),
      ""
    ];

    if (args.resources.length > 0) {
      lines.push("## Resources", "");
      for (const [index, resource] of args.resources.entries()) {
        lines.push(...formatResource(resource, index + 1));
      }
    }

    return ensureTrailingNewline(lines.join("\n"));
  }

  private formatWikiUpdateFile(args: {
    updateId: string;
    updatePath: string;
    timestamp: string;
    participant: Participant;
    agent: string;
    tags: string[];
    attention: string[];
    interactionIds: string[];
    interactionTargets: Map<string, string>;
    displayText: string;
    resources: UpdateResource[];
    wikiTitles: string[];
    wikiPaths: string[];
    preferencePaths: string[];
    conflictPaths: string[];
    wikiWrites: PreparedWikiWrite[];
    preferenceWrites: PreparedPreferenceWrite[];
    conflicts: PreparedConflict[];
  }): string {
    const lines = [
      "---",
      `id: ${args.updateId}`,
      `timestamp: ${JSON.stringify(args.timestamp)}`,
      `relationshipId: ${JSON.stringify(this.config.relationshipId)}`,
      `participant: ${JSON.stringify(args.participant.id)}`,
      `participantName: ${JSON.stringify(args.participant.displayName)}`,
      `agent: ${JSON.stringify(args.agent)}`,
      `kind: "wiki_update"`,
      ...(args.tags.length > 0 ? [`tags: ${JSON.stringify(args.tags)}`] : []),
      ...(args.attention.length > 0 ? [`attention: ${JSON.stringify(args.attention)}`] : []),
      `interactionIds: ${JSON.stringify(args.interactionIds)}`,
      `wikiTitles: ${JSON.stringify(args.wikiTitles)}`,
      `wikiPaths: ${JSON.stringify(args.wikiPaths)}`,
      ...(args.preferencePaths.length > 0 ? [`preferencePaths: ${JSON.stringify(args.preferencePaths)}`] : []),
      ...(args.conflictPaths.length > 0 ? [`conflictPaths: ${JSON.stringify(args.conflictPaths)}`] : []),
      "---",
      "",
      args.displayText.trimEnd(),
      ""
    ];

    lines.push("## Source Interactions", "");
    for (const interactionId of args.interactionIds) {
      const interactionPath = args.interactionTargets.get(interactionId);
      lines.push(
        `- ${
          interactionPath
            ? `[${interactionId}](${path.posix.relative(path.posix.dirname(args.updatePath), interactionPath)})`
            : interactionId
        }`
      );
    }
    lines.push("");

    if (args.wikiWrites.length > 0) {
      lines.push("## Wiki Changes", "");
      for (const [index, write] of args.wikiWrites.entries()) {
        lines.push(...formatWikiChange(write, index + 1));
      }
    }

    if (args.preferenceWrites.length > 0) {
      lines.push("## Preference Changes", "");
      for (const [index, write] of args.preferenceWrites.entries()) {
        lines.push(...formatPreferenceChange(write, index + 1));
      }
    }

    if (args.conflicts.length > 0) {
      lines.push("## Conflicts", "");
      for (const [index, conflict] of args.conflicts.entries()) {
        lines.push(...formatConflictReference(conflict, index + 1, args.updatePath));
      }
    }

    if (args.resources.length > 0) {
      lines.push("## Resources", "");
      for (const [index, resource] of args.resources.entries()) {
        lines.push(...formatResource(resource, index + 1));
      }
    }

    return ensureTrailingNewline(lines.join("\n"));
  }

  private formatConflictFile(record: ConflictRecord): string {
    const lines = [
      `# Conflict ${record.conflictId}`,
      "",
      "```json",
      JSON.stringify(record, null, 2),
      "```",
      "",
      "## Target",
      "",
      `- path: ${record.targetPath}`,
      `- kind: ${record.targetKind}`,
      `- baseHash: ${record.baseHash}`,
      `- currentHash: ${record.currentHash}`,
      `- proposedHash: ${record.proposedHash}`,
      "",
      "## Current Content",
      "",
      ...fencedMarkdown(record.currentContent),
      "",
      "## Proposed Content",
      "",
      ...fencedMarkdown(record.proposedContent),
      "",
      "## Resolution",
      ""
    ];

    if (record.status === "resolved" && record.resolutionContent) {
      lines.push(
        `Resolved at ${record.resolvedAt ?? "unknown time"}.`,
        "",
        ...fencedMarkdown(record.resolutionContent)
      );
    } else {
      lines.push("Unresolved.");
    }

    return ensureTrailingNewline(lines.join("\n"));
  }

  private async collectConflictFiles(): Promise<
    Array<{ conflictPath: string; absolutePath: string; content: string; record: ConflictRecord }>
  > {
    const conflictsRoot = path.join(this.config.vaultRoot, "conflicts");
    let files: string[];
    try {
      files = await collectMarkdownFiles(conflictsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const conflicts = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      const record = parseConflictRecord(content);
      conflicts.push({
        conflictPath: path.relative(this.config.vaultRoot, file).replace(/\\/g, "/"),
        absolutePath: file,
        content,
        record
      });
    }
    return conflicts;
  }

  private async findConflictFile(
    conflictId: string
  ): Promise<{ conflictPath: string; absolutePath: string; content: string; record: ConflictRecord }> {
    const conflicts = await this.collectConflictFiles();
    const conflict = conflicts.find((candidate) => candidate.record.conflictId === conflictId);
    if (!conflict) {
      throw new DmsumError(`Unknown conflictId: ${conflictId}`);
    }
    return conflict;
  }

  private async assertInteractionIdsExist(interactionIds: string[]): Promise<void> {
    if (interactionIds.length === 0) {
      throw new DmsumError("commit_wiki_update requires at least one source interactionId");
    }
    const interactionTargets = await collectInteractionReferenceTargets(this.config.vaultRoot);
    for (const interactionId of interactionIds) {
      if (!interactionTargets.has(interactionId)) {
        throw new DmsumError(`Unknown source interactionId: ${interactionId}`);
      }
    }
  }

  private assertWikiFilePath(relativePath: string): void {
    if (!relativePath.endsWith(".md")) {
      throw new DmsumError("Wiki writes must target markdown files");
    }
    if (relativePath === "wiki/index.md") {
      return;
    }
    const parent = path.posix.dirname(relativePath);
    if (!wikiRoots.has(parent)) {
      throw new DmsumError(
        "Wiki writes must target wiki/index.md, wiki/entities, wiki/topics, wiki/concepts, or wiki/synthesis"
      );
    }
  }

  private async ensureNoConflictingClaim(claimToken?: string): Promise<void> {
    const claim = await this.readStatusClaim();
    if (!claim) return;
    if (this.isClaimStale(claim)) {
      await this.writeNoStatus();
      await this.appendLog("cleared_stale_claim", {
        token: claim.token,
        description: claim.description
      });
      return;
    }
    if (claimToken && claim.token === claimToken) return;
    throw new DmsumError(`Mem·Sum is locked by active STATUS claim: ${claim.description}`);
  }

  private async appendLog(action: string, details: Record<string, unknown>): Promise<void> {
    const zoned = getZonedTimestamp(this.now(), this.config.timezone);
    const logPath = path.join(this.config.vaultRoot, "log.md");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const entry = [
      `## ${zoned.display} · ${action}`,
      "",
      "```json",
      JSON.stringify(details, null, 2),
      "```",
      "",
      ""
    ].join("\n");
    await fs.appendFile(logPath, entry, "utf8");
  }

  private statusPath(): string {
    return path.join(this.config.vaultRoot, "STATUS.md");
  }

  private async readStatusClaim(): Promise<StatusClaim | null> {
    const content = await fs.readFile(this.statusPath(), "utf8");
    const match = content.match(/```json\r?\n([\s\S]*?)\r?\n```/);
    if (!match) return null;
    return JSON.parse(match[1]) as StatusClaim;
  }

  private isClaimStale(claim: StatusClaim): boolean {
    return this.now().getTime() - Date.parse(claim.refreshedAt) > this.config.staleClaimMs;
  }

  private async writeStatusClaim(claim: StatusClaim): Promise<void> {
    const content = [
      "# STATUS",
      "",
      `Active claim: ${claim.description}`,
      "",
      "```json",
      JSON.stringify(claim, null, 2),
      "```",
      ""
    ].join("\n");
    await fs.writeFile(this.statusPath(), content, "utf8");
  }

  private async writeNoStatus(): Promise<void> {
    await fs.writeFile(this.statusPath(), "# STATUS\n\nNo active claim.\n", "utf8");
  }
}

export async function initializeVault(args: {
  config: DmsumConfig;
  specSourcePath?: string;
  overwriteSpec?: boolean;
  now?: () => Date;
}): Promise<void> {
  const config = args.config;
  const now = args.now ?? (() => new Date());
  const zoned = getZonedTimestamp(now(), config.timezone);

  await fs.mkdir(config.vaultRoot, { recursive: true });
  await fs.mkdir(config.stateDir, { recursive: true });
  await Promise.all([
    fs.mkdir(path.join(config.vaultRoot, "interactions", zoned.year, zoned.month, zoned.day), { recursive: true }),
    fs.mkdir(path.join(config.vaultRoot, "wiki-updates", zoned.year, zoned.month, zoned.day), { recursive: true }),
    fs.mkdir(path.join(config.vaultRoot, "wiki", "entities"), { recursive: true }),
    fs.mkdir(path.join(config.vaultRoot, "wiki", "topics"), { recursive: true }),
    fs.mkdir(path.join(config.vaultRoot, "wiki", "concepts"), { recursive: true }),
    fs.mkdir(path.join(config.vaultRoot, "wiki", "synthesis"), { recursive: true }),
    fs.mkdir(path.join(config.vaultRoot, "preferences"), { recursive: true }),
    fs.mkdir(path.join(config.vaultRoot, "assets", zoned.yearKey), { recursive: true })
  ]);

  await writeIfMissing(
    path.join(config.vaultRoot, "DMSUM.md"),
    args.specSourcePath ? await fs.readFile(args.specSourcePath, "utf8") : fallbackDmsumContract(),
    args.overwriteSpec
  );
  await writeIfMissing(path.join(config.vaultRoot, "README.md"), vaultReadme(config));
  await writeIfMissing(path.join(config.vaultRoot, "STATUS.md"), "# STATUS\n\nNo active claim.\n");
  await writeIfMissing(path.join(config.vaultRoot, "log.md"), "# log.md\n\n");
  await writeIfMissing(path.join(config.vaultRoot, "participants.md"), participantsMarkdown(config));
  await writeIfMissing(path.join(config.vaultRoot, "wiki", "index.md"), wikiIndexMarkdown());
  for (const participant of config.participants) {
    await writeIfMissing(path.join(config.vaultRoot, "preferences", `${participant.id}.md`), preferenceMarkdown(participant));
  }
}

async function writeIfMissing(filePath: string, content: string, overwrite = false): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!overwrite) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      // Missing files are created below.
    }
  }
  await fs.writeFile(filePath, content, "utf8");
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const stat = await fs.stat(root);
  if (stat.isFile()) return [root];

  const found: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectMarkdownFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(child);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

async function collectProvenanceReferenceTargets(vaultRoot: string): Promise<Map<string, string>> {
  const roots = ["wiki-updates"];
  const targets = new Map<string, string>();
  for (const root of roots) {
    const absoluteRoot = path.join(vaultRoot, root);
    try {
      const files = await collectMarkdownFiles(absoluteRoot);
      for (const file of files) {
        const basename = path.basename(file, ".md");
        if (/^[WFU]\d{6}$/.test(basename)) {
          targets.set(basename, path.relative(vaultRoot, file).replace(/\\/g, "/"));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return targets;
}

async function collectInteractionReferenceTargets(vaultRoot: string): Promise<Map<string, string>> {
  const interactionsRoot = path.join(vaultRoot, "interactions");
  try {
    const files = await collectMarkdownFiles(interactionsRoot);
    const targets = new Map<string, string>();
    for (const file of files) {
      const basename = path.basename(file, ".md");
      if (/^I\d{6}$/.test(basename)) {
        targets.set(basename, path.relative(vaultRoot, file).replace(/\\/g, "/"));
      }
    }
    return targets;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}


function normalizeStringList(values: string[], label: string): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const trimmed = optionalTrimmedText(value);
    if (!trimmed) {
      throw new DmsumError(`Invalid empty ${label}`);
    }
    normalized.add(trimmed);
  }
  return [...normalized];
}

function normalizeIdList(values: string[] | undefined, label: string, pattern: RegExp): string[] {
  if (!values || values.length === 0) {
    throw new DmsumError(`At least one ${label} is required`);
  }
  const normalized = normalizeStringList(values, label);
  for (const value of normalized) {
    if (!pattern.test(value)) {
      throw new DmsumError(`Invalid ${label}: ${value}`);
    }
  }
  return normalized;
}

function normalizeResources(resources: UpdateResource[]): UpdateResource[] {
  return resources.map((resource, index) => {
    if (!["url", "excerpt", "url_with_excerpt"].includes(resource.kind)) {
      throw new DmsumError(`Invalid resource kind at index ${index}`);
    }
    const normalized: UpdateResource = {
      kind: resource.kind,
      url: optionalTrimmedText(resource.url) ?? undefined,
      title: optionalTrimmedText(resource.title) ?? undefined,
      sourceName: optionalTrimmedText(resource.sourceName) ?? undefined,
      quotedText: optionalTrimmedText(resource.quotedText) ?? undefined,
      note: optionalTrimmedText(resource.note) ?? undefined,
      metadata: normalizeMetadata(resource.metadata)
    };
    if ((normalized.kind === "url" || normalized.kind === "url_with_excerpt") && !normalized.url) {
      throw new DmsumError(`Resource at index ${index} requires a url`);
    }
    if ((normalized.kind === "excerpt" || normalized.kind === "url_with_excerpt") && !normalized.quotedText) {
      throw new DmsumError(`Resource at index ${index} requires quotedText`);
    }
    return normalized;
  });
}

function normalizeMetadata(metadata: UpdateResource["metadata"]): UpdateResource["metadata"] {
  if (!metadata) return undefined;
  const normalized = {
    canonicalUrl: optionalTrimmedText(metadata.canonicalUrl) ?? undefined,
    siteName: optionalTrimmedText(metadata.siteName) ?? undefined,
    title: optionalTrimmedText(metadata.title) ?? undefined,
    description: optionalTrimmedText(metadata.description) ?? undefined,
    imageUrl: optionalTrimmedText(metadata.imageUrl) ?? undefined
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

function formatResource(resource: UpdateResource, index: number): string[] {
  const label = resource.title ?? resource.sourceName ?? resource.url ?? `Resource ${index}`;
  const lines = [`### ${index}. ${label}`, "", `- kind: ${resource.kind}`];
  if (resource.url) lines.push(`- url: ${resource.url}`);
  if (resource.title) lines.push(`- title: ${resource.title}`);
  if (resource.sourceName) lines.push(`- sourceName: ${resource.sourceName}`);
  if (resource.note) lines.push(`- note: ${resource.note}`);
  if (resource.metadata) {
    lines.push("- metadata:");
    if (resource.metadata.canonicalUrl) lines.push(`  - canonicalUrl: ${resource.metadata.canonicalUrl}`);
    if (resource.metadata.siteName) lines.push(`  - siteName: ${resource.metadata.siteName}`);
    if (resource.metadata.title) lines.push(`  - title: ${resource.metadata.title}`);
    if (resource.metadata.description) lines.push(`  - description: ${resource.metadata.description}`);
    if (resource.metadata.imageUrl) lines.push(`  - imageUrl: ${resource.metadata.imageUrl}`);
  }
  if (resource.quotedText) {
    lines.push("", "#### Quoted Text", "", "```text", resource.quotedText.trimEnd(), "```");
  }
  lines.push("");
  return lines;
}

function formatWikiChange(write: PreparedWikiWrite, index: number): string[] {
  return [
    `### ${index}. ${write.title}`,
    "",
    `- path: ${write.path}`,
    `- bytes: ${write.bytes}`,
    "",
    "#### Written Content",
    "",
    ...fencedMarkdown(write.content),
    ""
  ];
}

function formatPreferenceChange(write: PreparedPreferenceWrite, index: number): string[] {
  return [
    `### ${index}. ${write.participant.displayName}`,
    "",
    `- path: ${write.path}`,
    `- bytes: ${write.bytes}`,
    "",
    "#### Written Content",
    "",
    ...fencedMarkdown(write.content),
    ""
  ];
}

function formatConflictReference(conflict: PreparedConflict, index: number, updatePath: string): string[] {
  const relativeConflictPath = path.posix.relative(path.posix.dirname(updatePath), conflict.conflictPath);
  return [
    `### ${index}. ${conflict.record.conflictId}`,
    "",
    `- path: [${conflict.record.conflictId}](${relativeConflictPath})`,
    `- target: ${conflict.record.targetPath}`,
    `- kind: ${conflict.record.targetKind}`,
    `- baseHash: ${conflict.record.baseHash}`,
    `- currentHash: ${conflict.record.currentHash}`,
    `- proposedHash: ${conflict.record.proposedHash}`,
    `- bytes: ${conflict.bytes}`,
    ""
  ];
}

function summarizeConflict(conflictPath: string, record: ConflictRecord): ConflictSummary {
  return {
    conflictId: record.conflictId,
    conflictPath,
    status: record.status,
    timestamp: record.timestamp,
    relationshipId: record.relationshipId,
    targetKind: record.targetKind,
    targetPath: record.targetPath,
    baseHash: record.baseHash,
    currentHash: record.currentHash,
    proposedHash: record.proposedHash
  };
}

function parseConflictRecord(content: string): ConflictRecord {
  const match = content.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  if (!match) {
    throw new DmsumError("Conflict file is missing its JSON record");
  }
  return JSON.parse(match[1]) as ConflictRecord;
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function normalizeBaseHash(hash: string | undefined): string | undefined {
  const trimmed = optionalTrimmedText(hash);
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new DmsumError("baseHash must be a SHA-256 hex digest");
  }
  return normalized;
}

function normalizeConflictId(conflictId: string): string {
  const normalized = requiredTrimmedText(conflictId, "conflictId is required").toUpperCase();
  if (!/^C\d{6}$/.test(normalized)) {
    throw new DmsumError(`Invalid conflictId: ${conflictId}`);
  }
  return normalized;
}

function fencedMarkdown(content: string): string[] {
  const fenceLength = Math.max(3, ...[...content.matchAll(/`+/g)].map((match) => match[0].length + 1));
  const fence = "`".repeat(fenceLength);
  return [fence + "markdown", content.trimEnd(), fence];
}

function fencedText(content: string): string[] {
  const fenceLength = Math.max(3, ...[...content.matchAll(/`+/g)].map((match) => match[0].length + 1));
  const fence = "`".repeat(fenceLength);
  return [fence + "text", content.trimEnd(), fence];
}

function requiredTrimmedText(value: string | undefined, detail: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new DmsumError(detail);
  return trimmed;
}

function optionalTrimmedText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function linkBareProvenanceReferences(content: string, sumPath: string, updateTargets: Map<string, string>): string {
  return content.replace(/(?<!\[)\[([WFU]\d{6})\](?!\()/g, (fullMatch, id: string) => {
    const target = updateTargets.get(id);
    if (!target) return fullMatch;
    return markdownLinkForWikiUpdate(sumPath, id, target);
  });
}

function markdownLinkForWikiUpdate(sumPath: string, updateId: string, updatePath: string): string {
  const fromDir = path.posix.dirname(sumPath);
  const relativeTarget = path.posix.relative(fromDir, updatePath);
  return `[${updateId}](${relativeTarget})`;
}

function hasWikiUpdateReference(content: string, updateId: string): boolean {
  return new RegExp(`\\[${updateId}\\](?:\\(|\\b)`).test(content);
}

function ensureWikiUpdateReferenceFooter(
  content: string,
  updateId: string,
  referenceLink: string,
  author: string,
  date: string
): string {
  if (hasWikiUpdateReference(content, updateId)) return ensureTrailingNewline(content);
  const referenceLine = `- ${referenceLink} | wiki update | ${author} | ${date} - provenance for this wiki update`;
  return ensureTrailingNewline(appendReferenceLine(content.trimEnd(), referenceLine));
}

function appendReferenceLine(content: string, referenceLine: string): string {
  const referencesMatch = /^## References\s*$/m.exec(content);
  if (!referencesMatch) {
    return `${content}\n\n## References\n\n${referenceLine}`;
  }

  const insertionStart = referencesMatch.index + referencesMatch[0].length;
  const afterReferences = content.slice(insertionStart);
  const nextHeadingMatch = /\n## (?!#)/.exec(afterReferences);
  if (!nextHeadingMatch) {
    return `${content}\n${referenceLine}`;
  }

  const insertionIndex = insertionStart + nextHeadingMatch.index;
  return `${content.slice(0, insertionIndex)}\n${referenceLine}\n${content.slice(insertionIndex)}`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function normalizeParticipantLookup(input: string): string {
  return input
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function claimFingerprint(token: string | undefined): string | null {
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function participantsMarkdown(config: DmsumConfig): string {
  const lines = [
    "# Participants",
    "",
    `Timezone: ${config.timezone}`,
    "",
    ...config.participants.flatMap((participant) => [
      `## ${participant.displayName}`,
      "",
      `- id: ${participant.id}`,
      `- phone: ${participant.phone ?? ""}`,
      `- notifications: ${participant.notifications}`,
      ""
    ])
  ];
  return lines.join("\n");
}

function vaultReadme(config: DmsumConfig): string {
  return [
    "# Mem·Sum Vault",
    "",
    "This vault is the shared markdown state for one Mem·Sum relationship workspace.",
    "",
    `Relationship: ${config.relationshipId}`,
    `Timezone: ${config.timezone}`,
    "",
    "Agents must read DMSUM.md before operating on this vault.",
    ""
  ].join("\n");
}

function wikiIndexMarkdown(): string {
  return [
    "# Wiki Index",
    "",
    "This is the agent-maintained map of the relationship wiki.",
    "",
    "Agents update this index during wiki updates when pages are created, renamed, substantially updated, or connected.",
    ""
  ].join("\n");
}

function preferenceMarkdown(participant: Participant): string {
  return [
    `# ${participant.displayName} Preferences`,
    "",
    "Relationship-scoped display and interaction preferences for this participant.",
    "",
    "Agents may update this file when the participant explicitly states how they want Mem·Sum information shown or handled in this relationship.",
    ""
  ].join("\n");
}

function fallbackDmsumContract(): string {
  return [
    "# DMSUM.md",
    "",
    "Mem·Sum local contract.",
    "",
    "- The vault is markdown state. Browse it directly with read_file, list_files, and grep.",
    "- Use +sum, +dm, or +dmsum as invocation signals in ordinary agent chat.",
    "- The relationship wiki lives under wiki/.",
    "- Interactions are immutable raw records under interactions/YYYY/MM/DD/.",
    "- Wiki updates are immutable relationship integrations under wiki-updates/YYYY/MM/DD/.",
    "- Stale write conflicts are durable records under conflicts/YYYY/MM/DD/.",
    "- Use commit_interaction for each durable raw +sum, +dm, or +dmsum write/update turn and commit_wiki_update for wiki page or preference integration. Read-only retrieval should normally stay read-only.",
    "- read_file returns a SHA-256 hash. Agents may include it as baseHash on wikiWrites or preferenceWrites; if the target has changed, the attempted write becomes a conflict record instead of overwriting current content.",
    "- Use list_conflicts, read_conflict, and resolve_conflict to inspect unresolved stale writes and write harmonized content back to the original target.",
    "- The server assigns IDs and timestamps, writes immutable records, writes wiki and preference files, logs commits, and emits dry-run notifications.",
    "- Optional tags are free-form handles; optional attention marks known participants whose notice or response is requested.",
    "- In Git-backed local workspaces, each relationship is its own Git repo; Git provides history, diffs, merges, and conflict markers.",
    "- sync status distinguishes clean worktrees from local changes waiting for sync; sync doctor checks the local Git setup when a workspace behaves oddly.",
    "- If sync reports a conflict, inspect the conflicted markdown and Git diff, preserve both participants' durable meaning, carry forward non-conflicting new pages, reconcile overlapping pages, update index links when needed, then run sync resolve for that relationship.",
    "- Do not force wiki updates into a fixed semantic taxonomy. Put the meaning in the wiki prose.",
    "- Default to one immediate wiki update per meaningful write/update interaction. Multi-interaction wiki updates are only for explicit batches, corrections before updating, interrupted-work recovery, or source bundles.",
    "- If an interaction repeats something already captured and adds no meaningful nuance, preserve the raw interaction but do not create a duplicate wiki update; tell the participant briefly that it is already captured, do not mention that the restatement was saved, and do not ask whether to promote it unless the participant clearly asks.",
    "- Participant-facing replies should be natural, low-friction, and grounded in the participant's recognizable object: a trip, collection, saved source, instructions, open question, or whatever name the participant is already using.",
    "- Say what changed or what matters now, and keep it concise unless the participant asks for detail.",
    "- Hide implementation details by default. Do not show internal IDs, paths, timestamps, audit/provenance links, MCP tool names, storage mechanics, raw metadata, or local markdown/file links unless the participant asks for sources, files, technical context, or the exact audit trail.",
    "- External web links are different from local markdown links. Include useful external links when they help the participant act on the current request, and always honor participant preferences about showing original links.",
    "- The dumpling emoji is an optional lightweight brand mark when the surface supports it. Small labels and simple separators may be used when they improve scanability, but the answer must still make sense without them.",
    "- Provenance links and References entries may contain wiki update IDs, but ordinary wiki prose should remain human-readable.",
    "- Agents choose target wiki pages, preference writes, and final prose; the server only enforces shape and guardrails.",
    "- Treat send, tell, ask, add, note, and remember as natural-language cues, not server-side categories.",
    "- Agents read wiki/index.md before wiki updates and grow the wiki proactively when durable supporting pages are useful.",
    "- Create or update supporting wiki pages for reusable entities, places, animals, organizations, accounts, vendors, resources, preferences, procedures, open questions, or concepts.",
    "- Update wiki/index.md in the same wiki update when creating a page, substantially changing one, or adding an important graph connection.",
    "- Cite wiki update provenance inline with linked footnote-style references; [{{WIKI_UPDATE_ID}}] and {{WIKI_UPDATE_LINK}} are supported in wiki and preference writes.",
    "- Use ordinary markdown links between wiki pages, with optional Connections sections when several related pages need a compact home.",
    "- User-facing checks show recent wiki update recaps only unless the participant asks for sources or technical details.",
    "- Ground ordinary participant-facing retrieval in DMSUM.md, the current participant preference file, wiki/, wiki-updates/, and relevant interactions/; older experimental runtime locations outside those roots are audit or historical material unless the participant asks for technical or historical context.",
    "- displayText is a wiki update recap stored inside the internal Wiki Update file: who changed what, which page changed, and how the new material fits.",
    "- An unqualified update check means all wiki updates from the current relationship date, not unread state.",
    "- If requested material is already captured and adds no new nuance, agents should not create reaffirmation wiki updates.",
    "- Before showing, summarizing, recapping, revisiting, or explaining saved material, read the current participant's preference file if it exists and apply those preferences before generic presentation rules.",
    "- Participant preferences override generic presentation guidance. If a participant has asked to see links when original saved material contains links, include the relevant stored links in recaps of that material.",
    "- PDFs, docs, decks, spreadsheets, printable handouts, and similar exports are derivative artifacts created by capable agents from wiki pages; they do not replace the relationship wiki.",
    ""
  ].join("\n");
}
