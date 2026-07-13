import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { DmsumError } from "./errors.js";
import type { DmsumConfig, Participant } from "./types.js";

const participantSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  phone: z.string().nullable(),
  notifications: z.enum(["dry-run", "off"])
});

const configSchema = z.object({
  relationshipId: z.string().min(1),
  vaultRoot: z.string().min(1),
  stateDir: z.string().min(1),
  timezone: z.string().min(1),
  staleClaimMs: z.number().int().positive(),
  participants: z.array(participantSchema).min(2)
});

export function slugifyParticipant(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new DmsumError(`Cannot derive participant id from '${name}'`);
  }
  return slug;
}

export function participantsFromNames(names: string[]): Participant[] {
  const participants = names.map((name) => ({
    id: slugifyParticipant(name),
    displayName: name.trim(),
    phone: null,
    notifications: "dry-run" as const
  }));
  const ids = new Set(participants.map((participant) => participant.id));
  if (ids.size !== participants.length) {
    throw new DmsumError("Participant names must produce unique ids");
  }
  return participants;
}

export function createConfig(args: {
  relationshipId?: string;
  vaultRoot: string;
  stateDir: string;
  timezone?: string;
  staleClaimMs?: number;
  participants: Participant[];
}): DmsumConfig {
  return {
    relationshipId: args.relationshipId ?? "default",
    vaultRoot: path.resolve(args.vaultRoot),
    stateDir: path.resolve(args.stateDir),
    timezone: args.timezone ?? "America/Los_Angeles",
    staleClaimMs: args.staleClaimMs ?? 5 * 60 * 1000,
    participants: args.participants
  };
}

export async function loadConfig(configPath: string): Promise<DmsumConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const raw = await fs.readFile(absoluteConfigPath, "utf8");
  const parsed = configSchema.parse(JSON.parse(raw));

  return {
    ...parsed,
    vaultRoot: path.resolve(configDir, parsed.vaultRoot),
    stateDir: path.resolve(configDir, parsed.stateDir)
  };
}

export async function saveConfig(configPath: string, config: DmsumConfig): Promise<void> {
  const absoluteConfigPath = path.resolve(configPath);
  await fs.mkdir(path.dirname(absoluteConfigPath), { recursive: true });
  await fs.writeFile(absoluteConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function defaultConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, ".dmsum", "config.json");
}

export function assertConfigOutsideVault(configPath: string, vaultRoot: string): void {
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(configPath));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new DmsumError("Config path must live outside the Mem·Sum vault");
  }
}
