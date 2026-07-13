import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import { createRegistry, saveRegistry } from "./registry.js";
import { writeState } from "./state.js";
import type {
  DmsumRegistry,
  DmsumSyncConfig,
  SyncDoctorCheck,
  SyncDoctorResult,
  SyncRelationshipConfig,
  SyncRunResult
} from "./types.js";
import { DmsumError } from "./errors.js";
import { configFromRelationship } from "./registry.js";
import { initializeVault } from "./vault.js";

const syncRelationshipSchema = z.object({
  relationshipId: z.string().min(1),
  worktree: z.string().min(1),
  remote: z.string().min(1),
  branch: z.string().min(1).default("main")
});

const syncConfigSchema = z.object({
  version: z.literal(1),
  transport: z.literal("git"),
  intervalSeconds: z.number().int().positive().default(60),
  relationships: z.array(syncRelationshipSchema).min(1)
});

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InitializeLocalGitSyncArgs {
  dataRoot: string;
  ownerName: string;
  contactSpecs: string[];
  relationshipIds?: string[];
  remotes?: string[];
  timezone?: string;
  staleClaimMs?: number;
  force?: boolean;
  specSourcePath?: string;
}

export function defaultLocalDataRoot(homeDir = os.homedir()): string {
  return path.join(homeDir, "DMSum");
}

export function registryPathForDataRoot(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), ".dmsum", "registry.json");
}

export function syncPathForDataRoot(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), ".dmsum", "sync.json");
}

export function defaultSyncPathForRegistry(registryPath: string): string {
  return path.join(path.dirname(path.resolve(registryPath)), "sync.json");
}

export async function loadSyncConfig(syncPath: string): Promise<DmsumSyncConfig> {
  const absoluteSyncPath = path.resolve(syncPath);
  const syncDir = path.dirname(absoluteSyncPath);
  const raw = await fs.readFile(absoluteSyncPath, "utf8");
  const parsed = syncConfigSchema.parse(JSON.parse(raw));
  return {
    ...parsed,
    relationships: parsed.relationships.map((relationship) => ({
      ...relationship,
      worktree: path.resolve(syncDir, relationship.worktree)
    }))
  };
}

export async function saveSyncConfig(syncPath: string, config: DmsumSyncConfig): Promise<void> {
  const absoluteSyncPath = path.resolve(syncPath);
  syncConfigSchema.parse(config);
  await fs.mkdir(path.dirname(absoluteSyncPath), { recursive: true });
  await fs.writeFile(absoluteSyncPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function initializeLocalGitSync(args: InitializeLocalGitSyncArgs): Promise<{
  registryPath: string;
  syncPath: string;
  registry: DmsumRegistry;
  sync: DmsumSyncConfig;
}> {
  const dataRoot = path.resolve(args.dataRoot);
  const registryPath = registryPathForDataRoot(dataRoot);
  const syncPath = syncPathForDataRoot(dataRoot);
  const relationshipsRoot = path.join(dataRoot, "relationships");
  const gitRoot = path.join(dataRoot, "git");
  const remotes = args.remotes ?? [];
  if (remotes.length > 0 && remotes.length !== args.contactSpecs.length) {
    throw new DmsumError("--remotes must provide one remote per contact when supplied");
  }
  if (!args.force && ((await fileExists(registryPath)) || (await fileExists(syncPath)))) {
    throw new DmsumError(`Local Mem·Sum setup already exists under ${dataRoot}. Use --force to overwrite configs.`);
  }

  const registry = createRegistry({
    ownerName: args.ownerName,
    contactSpecs: args.contactSpecs,
    relationshipIds: args.relationshipIds,
    relationshipsRoot,
    stateRoot: path.join(dataRoot, ".dmsum"),
    statePlacement: "inside-vault",
    timezone: args.timezone,
    staleClaimMs: args.staleClaimMs
  });
  await saveRegistry(registryPath, registry);

  const syncRelationships: SyncRelationshipConfig[] = [];
  for (const [index, relationship] of registry.relationships.entries()) {
    const remote = remotes[index] ?? path.join(gitRoot, `${relationship.id}.git`);
    if (remotes[index]) {
      await ensureClonedWorktree({
        worktree: relationship.vaultRoot,
        remote,
        branch: "main"
      });
      if (!(await fileExists(path.join(relationship.vaultRoot, "DMSUM.md")))) {
        await initializeVault({
          config: configFromRelationship(registry, relationship.id),
          specSourcePath: args.specSourcePath,
          overwriteSpec: args.force
        });
      }
    } else {
      await initializeVault({
        config: configFromRelationship(registry, relationship.id),
        specSourcePath: args.specSourcePath,
        overwriteSpec: args.force
      });
      await ensureInitialSyncedState(relationship.stateDir);
      await ensureRelationshipGitignore(relationship.vaultRoot);
      await ensureBareRepo(remote, "main");
      await ensureGitWorktree({
        worktree: relationship.vaultRoot,
        remote,
        branch: "main"
      });
      await commitIfNeeded(relationship.vaultRoot, `Initialize Mem·Sum relationship ${relationship.id}`);
      await git(relationship.vaultRoot, ["push", "-u", "origin", "main"]);
      await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    }

    syncRelationships.push({
      relationshipId: relationship.id,
      worktree: relationship.vaultRoot,
      remote,
      branch: "main"
    });
  }

  const sync: DmsumSyncConfig = {
    version: 1,
    transport: "git",
    intervalSeconds: 60,
    relationships: syncRelationships
  };
  await saveSyncConfig(syncPath, sync);
  return { registryPath, syncPath, registry, sync };
}

export async function syncOnce(args: {
  syncPath: string;
  relationshipId?: string;
  now?: () => Date;
}): Promise<SyncRunResult> {
  const sync = await loadSyncConfig(args.syncPath);
  const relationships = selectRelationships(sync, args.relationshipId);
  const results = [];
  for (const relationship of relationships) {
    results.push(await syncRelationship(relationship, args.now ?? (() => new Date())));
  }
  return { relationships: results };
}

export async function syncStatus(args: { syncPath: string; relationshipId?: string }): Promise<SyncRunResult> {
  const sync = await loadSyncConfig(args.syncPath);
  const relationships = selectRelationships(sync, args.relationshipId);
  const results = [];
  for (const relationship of relationships) {
    const conflictFiles = await getUnmergedFiles(relationship.worktree);
    const status = await git(relationship.worktree, ["status", "--porcelain=v1", "--branch"]);
    const changed = status.stdout
      .split(/\r?\n/)
      .some((line) => line.trim() && !line.startsWith("##"));
    results.push({
      relationshipId: relationship.relationshipId,
      status: conflictFiles.length > 0 ? ("conflict" as const) : changed ? ("pending" as const) : ("clean" as const),
      changed,
      committed: false,
      pushed: false,
      conflictFiles,
      message:
        conflictFiles.length > 0
          ? "Unresolved Git conflicts"
          : changed
          ? "Local changes are waiting for sync"
          : "No local file changes"
    });
  }
  return { relationships: results };
}

export async function syncDoctor(args: { syncPath: string; relationshipId?: string }): Promise<SyncDoctorResult> {
  const checks: SyncDoctorCheck[] = [];
  const gitVersion = await safeGit(process.cwd(), ["--version"]);
  checks.push({
    name: "git",
    status: gitVersion.code === 0 ? "ok" : "error",
    message: gitVersion.code === 0 ? gitVersion.stdout.trim() : gitVersion.stderr.trim() || "Git is unavailable"
  });

  const syncPath = path.resolve(args.syncPath);
  try {
    await fs.access(syncPath);
    checks.push({ name: "sync config", status: "ok", message: syncPath });
  } catch {
    checks.push({ name: "sync config", status: "error", message: `Cannot read ${syncPath}` });
    return { checks };
  }

  let sync: DmsumSyncConfig;
  try {
    sync = await loadSyncConfig(syncPath);
    checks.push({
      name: "sync config shape",
      status: "ok",
      message: `${sync.relationships.length} configured relationship${sync.relationships.length === 1 ? "" : "s"}`
    });
  } catch (error) {
    checks.push({ name: "sync config shape", status: "error", message: String(error) });
    return { checks };
  }

  let relationships: SyncRelationshipConfig[];
  try {
    relationships = selectRelationships(sync, args.relationshipId);
  } catch (error) {
    checks.push({ name: "relationship selection", status: "error", message: String(error) });
    return { checks };
  }

  for (const relationship of relationships) {
    await addRelationshipDoctorChecks(relationship, checks);
  }
  return { checks };
}

export async function resolveSync(args: {
  syncPath: string;
  relationshipId: string;
  now?: () => Date;
}): Promise<SyncRunResult> {
  const sync = await loadSyncConfig(args.syncPath);
  const [relationship] = selectRelationships(sync, args.relationshipId);
  await git(relationship.worktree, ["add", "-A"]);
  const conflictFiles = await getUnmergedFilesSafe(relationship.worktree);
  if (conflictFiles.length > 0) {
    return {
      relationships: [
        {
          relationshipId: relationship.relationshipId,
          status: "conflict",
          changed: true,
          committed: false,
          pushed: false,
          conflictFiles,
          message: "Conflicts are still unresolved"
        }
      ]
    };
  }
  const committed = await commitIfNeeded(
    relationship.worktree,
    `Resolve Mem·Sum sync conflict for ${relationship.relationshipId}`
  );
  const push = await git(relationship.worktree, ["push", "origin", relationship.branch], true);
  return {
    relationships: [
      {
        relationshipId: relationship.relationshipId,
        status: push.code === 0 ? "synced" : "error",
        changed: committed,
        committed,
        pushed: push.code === 0,
        conflictFiles: [],
        message: push.code === 0 ? "Resolution committed and pushed" : push.stderr.trim()
      }
    ]
  };
}

export async function runSyncDaemon(args: {
  syncPath: string;
  relationshipId?: string;
  intervalSeconds: number;
  onResult?: (result: SyncRunResult) => void;
}): Promise<void> {
  while (true) {
    const result = await syncOnce({ syncPath: args.syncPath, relationshipId: args.relationshipId });
    args.onResult?.(result);
    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

async function syncRelationship(
  relationship: SyncRelationshipConfig,
  now: () => Date
): Promise<SyncRunResult["relationships"][number]> {
  await ensureGitWorktree(relationship);
  let conflictFiles = await getUnmergedFiles(relationship.worktree);
  if (conflictFiles.length > 0) {
    return conflictResult(relationship.relationshipId, conflictFiles, "Repository already has unresolved conflicts");
  }

  const committed = await commitIfNeeded(
    relationship.worktree,
    `Sync Mem·Sum ${relationship.relationshipId} ${formatDateForCommit(now())}`
  );
  const fetch = await git(relationship.worktree, ["fetch", "origin", relationship.branch], true);
  if (fetch.code !== 0) {
    return errorResult(relationship.relationshipId, fetch.stderr.trim() || fetch.stdout.trim());
  }

  const merge = await git(relationship.worktree, ["merge", "--no-edit", `origin/${relationship.branch}`], true);
  if (merge.code !== 0) {
    conflictFiles = await getUnmergedFiles(relationship.worktree);
    if (conflictFiles.length > 0) {
      return conflictResult(relationship.relationshipId, conflictFiles, merge.stderr.trim() || merge.stdout.trim());
    }
    return errorResult(relationship.relationshipId, merge.stderr.trim() || merge.stdout.trim());
  }

  const push = await git(relationship.worktree, ["push", "origin", relationship.branch], true);
  if (push.code !== 0) {
    return errorResult(relationship.relationshipId, push.stderr.trim() || push.stdout.trim());
  }

  return {
    relationshipId: relationship.relationshipId,
    status: "synced",
    changed: committed || merge.stdout.includes("Merge made"),
    committed,
    pushed: true,
    conflictFiles: [],
    message: "Synced"
  };
}

async function ensureClonedWorktree(args: { worktree: string; remote: string; branch: string }): Promise<void> {
  if (await fileExists(path.join(args.worktree, ".git"))) {
    await ensureGitWorktree(args);
    return;
  }
  if (await directoryHasEntries(args.worktree)) {
    throw new DmsumError(`Worktree already exists and is not a Git repo: ${args.worktree}`);
  }
  await fs.mkdir(path.dirname(args.worktree), { recursive: true });
  const clone = await git(process.cwd(), ["clone", "--branch", args.branch, args.remote, args.worktree], true);
  if (clone.code !== 0) {
    const fallback = await git(process.cwd(), ["clone", args.remote, args.worktree], true);
    if (fallback.code !== 0) {
      throw new DmsumError(fallback.stderr.trim() || clone.stderr.trim() || "git clone failed");
    }
  }
}

async function ensureBareRepo(remote: string, branch: string): Promise<void> {
  if (await fileExists(path.join(remote, "HEAD"))) {
    const bare = await git(remote, ["rev-parse", "--is-bare-repository"], true);
    if (bare.stdout.trim() !== "true") {
      throw new DmsumError(`Remote exists but is not a bare Git repository: ${remote}`);
    }
    return;
  }
  if (await directoryHasEntries(remote)) {
    throw new DmsumError(`Remote directory exists and is not empty: ${remote}`);
  }
  await fs.mkdir(path.dirname(remote), { recursive: true });
  await git(process.cwd(), ["init", "--bare", remote]);
  await git(remote, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
}

async function ensureGitWorktree(args: { worktree: string; remote: string; branch: string }): Promise<void> {
  await fs.mkdir(args.worktree, { recursive: true });
  if (!(await fileExists(path.join(args.worktree, ".git")))) {
    await git(process.cwd(), ["init", args.worktree]);
    await git(args.worktree, ["checkout", "-B", args.branch]);
  }
  const currentRemote = await git(args.worktree, ["remote", "get-url", "origin"], true);
  if (currentRemote.code === 0) {
    await git(args.worktree, ["remote", "set-url", "origin", args.remote]);
  } else {
    await git(args.worktree, ["remote", "add", "origin", args.remote]);
  }
}

async function commitIfNeeded(worktree: string, message: string): Promise<boolean> {
  await git(worktree, ["add", "-A"]);
  const status = await git(worktree, ["status", "--porcelain"]);
  if (!status.stdout.trim()) return false;
  await git(worktree, [
    "-c",
    "user.name=Mem·Sum",
    "-c",
    "user.email=dmsum@example.invalid",
    "commit",
    "-m",
    message
  ]);
  return true;
}

async function ensureInitialSyncedState(stateDir: string): Promise<void> {
  const statePath = path.join(stateDir, "state.json");
  if (await fileExists(statePath)) return;
  await writeState(stateDir, {
    nextInteractionNumber: 1,
    nextWikiUpdateNumber: 1
  });
}

async function ensureRelationshipGitignore(worktree: string): Promise<void> {
  const gitignorePath = path.join(worktree, ".gitignore");
  const line = ".dmsum/notifications.jsonl";
  if (!(await fileExists(gitignorePath))) {
    await fs.writeFile(gitignorePath, `${line}\n`, "utf8");
    return;
  }
  const content = await fs.readFile(gitignorePath, "utf8");
  if (!content.split(/\r?\n/).includes(line)) {
    await fs.appendFile(gitignorePath, `${content.endsWith("\n") ? "" : "\n"}${line}\n`, "utf8");
  }
}

async function getUnmergedFiles(worktree: string): Promise<string[]> {
  const result = await git(worktree, ["diff", "--name-only", "--diff-filter=U"], true);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getUnmergedFilesSafe(worktree: string): Promise<string[]> {
  const result = await safeGit(worktree, ["diff", "--name-only", "--diff-filter=U"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function addRelationshipDoctorChecks(
  relationship: SyncRelationshipConfig,
  checks: SyncDoctorCheck[]
): Promise<void> {
  const relationshipId = relationship.relationshipId;
  const gitDir = path.join(relationship.worktree, ".git");
  checks.push({
    relationshipId,
    name: "worktree",
    status: (await fileExists(gitDir)) ? "ok" : "error",
    message: relationship.worktree
  });

  const inWorktree = await safeGit(relationship.worktree, ["rev-parse", "--is-inside-work-tree"]);
  checks.push({
    relationshipId,
    name: "git worktree",
    status: inWorktree.stdout.trim() === "true" ? "ok" : "error",
    message:
      inWorktree.stdout.trim() === "true"
        ? "Git worktree is valid"
        : inWorktree.stderr.trim() || "Not a Git worktree"
  });

  const remote = await safeGit(relationship.worktree, ["remote", "get-url", "origin"]);
  const remoteUrl = remote.stdout.trim();
  checks.push({
    relationshipId,
    name: "origin remote",
    status: remote.code !== 0 ? "error" : remoteUrl === relationship.remote ? "ok" : "warn",
    message:
      remote.code !== 0
        ? remote.stderr.trim() || "origin remote is not configured"
        : remoteUrl === relationship.remote
        ? remoteUrl
        : `Configured as ${remoteUrl}; sync.json expects ${relationship.remote}`
  });

  const branch = await safeGit(relationship.worktree, ["branch", "--show-current"]);
  const currentBranch = branch.stdout.trim();
  checks.push({
    relationshipId,
    name: "branch",
    status: branch.code !== 0 ? "error" : currentBranch === relationship.branch ? "ok" : "warn",
    message:
      branch.code !== 0
        ? branch.stderr.trim() || "Cannot read current branch"
        : currentBranch === relationship.branch
        ? currentBranch
        : `Currently on ${currentBranch || "(detached)"}; sync.json expects ${relationship.branch}`
  });

  checks.push({
    relationshipId,
    name: "contract",
    status: (await fileExists(path.join(relationship.worktree, "DMSUM.md"))) ? "ok" : "error",
    message: "DMSUM.md"
  });
  checks.push({
    relationshipId,
    name: "shared state",
    status: (await fileExists(path.join(relationship.worktree, ".dmsum", "state.json"))) ? "ok" : "error",
    message: ".dmsum/state.json"
  });

  const conflictFiles = await getUnmergedFiles(relationship.worktree);
  if (conflictFiles.length > 0) {
    checks.push({
      relationshipId,
      name: "status",
      status: "warn",
      message: `Unresolved conflicts: ${conflictFiles.join(", ")}`
    });
    return;
  }

  const status = await safeGit(relationship.worktree, ["status", "--porcelain=v1"]);
  const changed = status.stdout
    .split(/\r?\n/)
    .some((line) => line.trim());
  checks.push({
    relationshipId,
    name: "status",
    status: status.code !== 0 ? "error" : changed ? "warn" : "ok",
    message:
      status.code !== 0
        ? status.stderr.trim() || "Cannot read Git status"
        : changed
        ? "Local changes are waiting for sync"
        : "No local file changes"
  });
}

function selectRelationships(sync: DmsumSyncConfig, relationshipId?: string): SyncRelationshipConfig[] {
  if (!relationshipId) return sync.relationships;
  const relationship = sync.relationships.find((candidate) => candidate.relationshipId === relationshipId);
  if (!relationship) {
    throw new DmsumError(`Unknown sync relationship: ${relationshipId}`);
  }
  return [relationship];
}

function conflictResult(
  relationshipId: string,
  conflictFiles: string[],
  message: string
): SyncRunResult["relationships"][number] {
  return {
    relationshipId,
    status: "conflict",
    changed: true,
    committed: false,
    pushed: false,
    conflictFiles,
    message
  };
}

function errorResult(relationshipId: string, message: string): SyncRunResult["relationships"][number] {
  return {
    relationshipId,
    status: "error",
    changed: false,
    committed: false,
    pushed: false,
    conflictFiles: [],
    message
  };
}

function formatDateForCommit(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasEntries(directoryPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(directoryPath);
    return entries.length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<GitResult> {
  const result = await runGit(cwd, args);
  if (result.code !== 0 && !allowFailure) {
    throw new DmsumError(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result;
}

async function safeGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    return await git(cwd, args, true);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: String(error)
    };
  }
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}
