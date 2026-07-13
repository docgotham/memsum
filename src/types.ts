export type NotificationMode = "dry-run" | "off";

export interface Participant {
  id: string;
  displayName: string;
  phone: string | null;
  notifications: NotificationMode;
}

export interface DmsumConfig {
  relationshipId: string;
  vaultRoot: string;
  stateDir: string;
  timezone: string;
  staleClaimMs: number;
  participants: Participant[];
}

export interface RegistryUser {
  id: string;
  displayName: string;
}

export interface RegistryContact {
  ownerId: string;
  handle: string;
  relationshipId: string;
  participantId: string;
  displayName?: string;
}

export interface RegistryRelationship {
  id: string;
  displayName?: string;
  vaultRoot: string;
  stateDir: string;
  timezone?: string;
  staleClaimMs?: number;
  participants: Participant[];
}

export interface DmsumRegistry {
  version: 1;
  timezone: string;
  staleClaimMs: number;
  defaultOwnerId: string;
  users: RegistryUser[];
  contacts: RegistryContact[];
  relationships: RegistryRelationship[];
}

export interface SyncRelationshipConfig {
  relationshipId: string;
  worktree: string;
  remote: string;
  branch: string;
}

export interface DmsumSyncConfig {
  version: 1;
  transport: "git";
  intervalSeconds: number;
  relationships: SyncRelationshipConfig[];
}

export type SyncRelationshipState = "clean" | "pending" | "synced" | "conflict" | "error";

export interface SyncRelationshipResult {
  relationshipId: string;
  status: SyncRelationshipState;
  changed: boolean;
  committed: boolean;
  pushed: boolean;
  conflictFiles: string[];
  message: string;
}

export interface SyncRunResult {
  relationships: SyncRelationshipResult[];
}

export type SyncDoctorCheckStatus = "ok" | "warn" | "error";

export interface SyncDoctorCheck {
  relationshipId?: string;
  name: string;
  status: SyncDoctorCheckStatus;
  message: string;
}

export interface SyncDoctorResult {
  checks: SyncDoctorCheck[];
}

export interface LocalState {
  nextInteractionNumber: number;
  nextWikiUpdateNumber: number;
  nextUpdateNumber?: number;
  nextConflictNumber?: number;
}

export interface StatusClaim {
  token: string;
  description: string;
  owner: string | null;
  claimedAt: string;
  refreshedAt: string;
}

export interface ResourceMetadata {
  canonicalUrl?: string;
  siteName?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
}

export interface UpdateResource {
  kind: "url" | "excerpt" | "url_with_excerpt";
  url?: string;
  title?: string;
  sourceName?: string;
  quotedText?: string;
  note?: string;
  metadata?: ResourceMetadata;
}

export interface WikiWriteInput {
  path: string;
  title: string;
  content: string;
  baseHash?: string;
}

export interface PreferenceWriteInput {
  participant: string;
  content: string;
  baseHash?: string;
}

export interface InteractionCommit {
  interactionId: string;
  timestamp: string;
  interactionPath: string;
  relationshipId: string;
  participant: Participant;
  agent: string;
  rawText: string;
  addressedParticipants: string[];
  resources: UpdateResource[];
}

export interface WikiUpdateCommit {
  updateId: string;
  timestamp: string;
  updatePath: string;
  relationshipId: string;
  participant: Participant;
  agent: string;
  tags: string[];
  attention: string[];
  interactionIds: string[];
  wikiTitles: string[];
  wikiPaths: string[];
  preferencePaths: string[];
  conflictPaths: string[];
  resources: UpdateResource[];
}

export type ConflictStatus = "open" | "resolved";
export type ConflictTargetKind = "wiki" | "preference";

export interface ConflictRecordParticipant {
  id: string;
  displayName: string;
}

export interface ConflictRecord {
  conflictId: string;
  status: ConflictStatus;
  timestamp: string;
  relationshipId: string;
  wikiUpdateId: string;
  wikiUpdatePath: string;
  targetKind: ConflictTargetKind;
  targetPath: string;
  baseHash: string;
  currentHash: string;
  proposedHash: string;
  participant: ConflictRecordParticipant;
  agent: string;
  interactionIds: string[];
  currentContent: string;
  proposedContent: string;
  resolvedAt?: string;
  resolvedBy?: {
    participant: ConflictRecordParticipant;
    agent: string;
  };
  resolutionHash?: string;
  resolutionContent?: string;
}

export interface ConflictSummary {
  conflictId: string;
  conflictPath: string;
  status: ConflictStatus;
  timestamp: string;
  relationshipId: string;
  targetKind: ConflictTargetKind;
  targetPath: string;
  baseHash: string;
  currentHash: string;
  proposedHash: string;
}

export interface NotificationRecord {
  type: "dry_run_sms";
  sourceKind: "interaction" | "wiki_update";
  sourceId: string;
  timestamp: string;
  relationshipId: string;
  participantId: string;
  participantName: string;
  agent: string;
  recipientId: string;
  recipientName: string;
  recipientPhone: string | null;
  body: string;
}
