import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { createConfig, slugifyParticipant } from "./config.js";
import { DmsumError } from "./errors.js";
import type {
  DmsumConfig,
  DmsumRegistry,
  Participant,
  RegistryContact,
  RegistryRelationship,
  RegistryUser
} from "./types.js";

const participantSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  phone: z.string().nullable(),
  notifications: z.enum(["dry-run", "off"])
});

const userSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1)
});

const contactSchema = z.object({
  ownerId: z.string().min(1),
  handle: z.string().min(1),
  relationshipId: z.string().min(1),
  participantId: z.string().min(1),
  displayName: z.string().min(1).optional()
});

const relationshipSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  vaultRoot: z.string().min(1),
  stateDir: z.string().min(1),
  timezone: z.string().min(1).optional(),
  staleClaimMs: z.number().int().positive().optional(),
  participants: z.array(participantSchema).min(2)
});

const registrySchema = z.object({
  version: z.literal(1),
  timezone: z.string().min(1).default("America/Los_Angeles"),
  staleClaimMs: z.number().int().positive().default(5 * 60 * 1000),
  defaultOwnerId: z.string().min(1),
  users: z.array(userSchema).min(1),
  contacts: z.array(contactSchema),
  relationships: z.array(relationshipSchema).min(1)
});

interface ParsedContactSpec {
  handle: string;
  displayName: string;
}

export function defaultRegistryPath(cwd = process.cwd()): string {
  return path.join(cwd, ".dmsum", "registry.json");
}

export function normalizeHandle(handle: string): string {
  const normalized = handle
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new DmsumError(`Invalid empty contact handle: ${handle}`);
  }
  return normalized;
}

export async function loadRegistry(registryPath: string): Promise<DmsumRegistry> {
  const absoluteRegistryPath = path.resolve(registryPath);
  const registryDir = path.dirname(absoluteRegistryPath);
  const raw = await fs.readFile(absoluteRegistryPath, "utf8");
  const parsed = registrySchema.parse(JSON.parse(raw));
  const registry: DmsumRegistry = {
    ...parsed,
    relationships: parsed.relationships.map((relationship) => ({
      ...relationship,
      vaultRoot: path.resolve(registryDir, relationship.vaultRoot),
      stateDir: path.resolve(registryDir, relationship.stateDir)
    }))
  };
  validateRegistry(registry);
  return registry;
}

export async function saveRegistry(registryPath: string, registry: DmsumRegistry): Promise<void> {
  const absoluteRegistryPath = path.resolve(registryPath);
  validateRegistry(registry);
  await fs.mkdir(path.dirname(absoluteRegistryPath), { recursive: true });
  await fs.writeFile(absoluteRegistryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function configFromRelationship(registry: DmsumRegistry, relationshipId: string): DmsumConfig {
  const relationship = registry.relationships.find((candidate) => candidate.id === relationshipId);
  if (!relationship) {
    throw new DmsumError(`Unknown relationship: ${relationshipId}`);
  }
  return createConfig({
    relationshipId: relationship.id,
    vaultRoot: relationship.vaultRoot,
    stateDir: relationship.stateDir,
    timezone: relationship.timezone ?? registry.timezone,
    staleClaimMs: relationship.staleClaimMs ?? registry.staleClaimMs,
    participants: relationship.participants
  });
}

export function createRegistry(args: {
  ownerName: string;
  contactSpecs: string[];
  relationshipsRoot: string;
  stateRoot: string;
  relationshipIds?: string[];
  statePlacement?: "external" | "inside-vault";
  timezone?: string;
  staleClaimMs?: number;
}): DmsumRegistry {
  const ownerId = slugifyParticipant(args.ownerName);
  const owner: RegistryUser = {
    id: ownerId,
    displayName: args.ownerName.trim()
  };
  const contacts = args.contactSpecs.map(parseContactSpec);
  if (contacts.length === 0) {
    throw new DmsumError("At least one contact is required for a routed registry");
  }
  if (args.relationshipIds && args.relationshipIds.length !== contacts.length) {
    throw new DmsumError("--relationship-ids must provide one relationship id per contact");
  }

  const registryContacts: RegistryContact[] = [];
  const relationships: RegistryRelationship[] = [];
  for (const [index, contact] of contacts.entries()) {
    const relationshipId = args.relationshipIds?.[index]?.trim() || `${ownerId}-${contact.handle}`;
    if (!relationshipId) {
      throw new DmsumError(`Invalid empty relationship id for @${contact.handle}`);
    }
    const vaultRoot = path.join(args.relationshipsRoot, relationshipId);
    const contactParticipant: Participant = {
      id: contact.handle,
      displayName: contact.displayName,
      phone: null,
      notifications: "dry-run"
    };
    const ownerParticipant: Participant = {
      id: ownerId,
      displayName: owner.displayName,
      phone: null,
      notifications: "dry-run"
    };
    registryContacts.push({
      ownerId,
      handle: contact.handle,
      displayName: contact.displayName,
      relationshipId,
      participantId: contactParticipant.id
    });
    relationships.push({
      id: relationshipId,
      displayName: `${owner.displayName} / ${contact.displayName}`,
      vaultRoot,
      stateDir:
        args.statePlacement === "inside-vault"
          ? path.join(vaultRoot, ".dmsum")
          : path.join(args.stateRoot, "relationships", relationshipId),
      participants: [ownerParticipant, contactParticipant]
    });
  }

  const registry: DmsumRegistry = {
    version: 1,
    timezone: args.timezone ?? "America/Los_Angeles",
    staleClaimMs: args.staleClaimMs ?? 5 * 60 * 1000,
    defaultOwnerId: ownerId,
    users: [owner],
    contacts: registryContacts,
    relationships
  };
  validateRegistry(registry);
  return registry;
}

export function validateRegistry(registry: DmsumRegistry): void {
  const usersById = uniqueBy(registry.users, (user) => user.id, "user id");
  if (!usersById.has(registry.defaultOwnerId)) {
    throw new DmsumError(`Unknown defaultOwnerId: ${registry.defaultOwnerId}`);
  }
  const relationshipsById = uniqueBy(registry.relationships, (relationship) => relationship.id, "relationship id");
  for (const relationship of registry.relationships) {
    const participantIds = uniqueBy(relationship.participants, (participant) => participant.id, "participant id");
    for (const participant of relationship.participants) {
      if (!participantIds.has(participant.id)) {
        throw new DmsumError(`Invalid participant in relationship ${relationship.id}: ${participant.id}`);
      }
    }
  }

  const contactKeys = new Set<string>();
  for (const contact of registry.contacts) {
    const handle = normalizeHandle(contact.handle);
    if (handle !== contact.handle) {
      throw new DmsumError(`Contact handle must already be normalized: ${contact.handle}`);
    }
    if (!usersById.has(contact.ownerId)) {
      throw new DmsumError(`Unknown contact owner: ${contact.ownerId}`);
    }
    const key = `${contact.ownerId}:${contact.handle}`;
    if (contactKeys.has(key)) {
      throw new DmsumError(`Duplicate contact handle for ${contact.ownerId}: @${contact.handle}`);
    }
    contactKeys.add(key);
    const relationship = relationshipsById.get(contact.relationshipId);
    if (!relationship) {
      throw new DmsumError(`Unknown contact relationship: ${contact.relationshipId}`);
    }
    const participant = relationship.participants.find((candidate) => candidate.id === contact.participantId);
    if (!participant) {
      throw new DmsumError(`Contact @${contact.handle} points at an unknown participant: ${contact.participantId}`);
    }
  }
}

function parseContactSpec(spec: string): ParsedContactSpec {
  const [left, ...rest] = spec.split("=");
  const displayName = (rest.length > 0 ? rest.join("=") : left).trim();
  const handle = normalizeHandle(rest.length > 0 ? left : slugifyParticipant(displayName));
  if (!displayName) {
    throw new DmsumError(`Invalid contact spec: ${spec}`);
  }
  return { handle, displayName };
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string, label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (map.has(key)) {
      throw new DmsumError(`Duplicate ${label}: ${key}`);
    }
    map.set(key, item);
  }
  return map;
}
