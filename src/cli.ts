#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { startAuditServer } from "./audit.js";
import {
  assertConfigOutsideVault,
  createConfig,
  defaultConfigPath,
  loadConfig,
  participantsFromNames,
  saveConfig
} from "./config.js";
import { DmsumError } from "./errors.js";
import { exportHostedOkfBundle } from "./hosted/okf.js";
import { createRegistry, defaultRegistryPath, saveRegistry } from "./registry.js";
import {
  defaultLocalDataRoot,
  defaultSyncPathForRegistry,
  initializeLocalGitSync,
  resolveSync,
  runSyncDaemon,
  syncDoctor,
  syncOnce,
  syncPathForDataRoot,
  syncStatus
} from "./sync.js";
import { DmsumVault, initializeVault } from "./vault.js";
import {
  claimHostedInvitation,
  createHostedInvitation,
  issueHostedConnectorToken,
  listHostedConnectorTokens,
  listHostedInvitations,
  requestHostedLoginLink,
  revokeHostedConnectorToken,
  revokeHostedInvitation,
  runHostedSmoke,
  type HostedConnectorTokenResult,
  type HostedConnectorTokenSummary,
  type HostedInvitationSummary,
  type HostedSmokeResult
} from "./hosted/operator.js";
import type { SyncDoctorResult, SyncRunResult } from "./types.js";

interface ParsedArgs {
  command: string | undefined;
  subcommand: string | undefined;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rawRest] = argv;
  const rest = [...rawRest];
  const subcommand =
    (command === "sync" || command === "hosted") && rest[0] && !rest[0].startsWith("--") ? rest.shift() : undefined;
  const flags = new Map<string, string | true>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new DmsumError(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      index += 1;
    }
  }

  return { command, subcommand, flags };
}

function stringFlag(flags: Map<string, string | true>, key: string): string | undefined {
  const value = flags.get(key);
  if (typeof value === "string") return value;
  if (value === true) throw new DmsumError(`--${key} requires a value`);
  return undefined;
}

function boolFlag(flags: Map<string, string | true>, key: string): boolean {
  return flags.get(key) === true;
}

function listFlag(flags: Map<string, string | true>, key: string): string[] | undefined {
  const value = stringFlag(flags, key);
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultStateDirForConfig(configPath: string): string {
  const configDir = path.dirname(configPath);
  const extension = path.extname(configPath);
  const stem = path.basename(configPath, extension).replace(/\.config$/i, "");
  return stem === "config" ? configDir : path.join(configDir, stem);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function init(flags: Map<string, string | true>): Promise<void> {
  const configPath = path.resolve(stringFlag(flags, "config") ?? defaultConfigPath());
  const vaultRoot = path.resolve(stringFlag(flags, "vault") ?? path.join(process.cwd(), "vault"));
  const stateDir = path.resolve(stringFlag(flags, "state-dir") ?? defaultStateDirForConfig(configPath));
  const participantNames = (stringFlag(flags, "participants") ?? "Dave,Lisa")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const timezone = stringFlag(flags, "timezone") ?? "America/Los_Angeles";
  const relationshipId = stringFlag(flags, "relationship") ?? "default";
  const staleMinutes = Number(stringFlag(flags, "stale-claim-minutes") ?? "5");
  const force = boolFlag(flags, "force");

  if (participantNames.length < 2) {
    throw new DmsumError("Mem·Sum requires at least two participants in a relationship workspace");
  }
  if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
    throw new DmsumError("--stale-claim-minutes must be a positive number");
  }
  if ((await exists(configPath)) && !force) {
    throw new DmsumError(`Config already exists at ${configPath}. Use --force to overwrite it.`);
  }

  assertConfigOutsideVault(configPath, vaultRoot);

  const config = createConfig({
    relationshipId,
    vaultRoot,
    stateDir,
    timezone,
    staleClaimMs: Math.round(staleMinutes * 60 * 1000),
    participants: participantsFromNames(participantNames)
  });

  const explicitSpecPath = stringFlag(flags, "spec");
  const defaultContractPath = path.join(process.cwd(), "DMSUM.md");
  const defaultSpecPath = path.join(process.cwd(), "DM·Sum Ontology and Functional Spec (v1).md");
  const specSourcePath = explicitSpecPath
    ? path.resolve(explicitSpecPath)
    : (await exists(defaultContractPath))
      ? defaultContractPath
      : (await exists(defaultSpecPath))
      ? defaultSpecPath
      : undefined;

  await saveConfig(configPath, config);
  await initializeVault({
    config,
    specSourcePath,
    overwriteSpec: force
  });

  console.log(`Wrote config: ${configPath}`);
  console.log(`Initialized vault: ${vaultRoot}`);
}

async function initRegistry(flags: Map<string, string | true>): Promise<void> {
  const registryPath = path.resolve(stringFlag(flags, "registry") ?? defaultRegistryPath());
  const registryDir = path.dirname(registryPath);
  const relationshipsRoot = path.resolve(
    registryDir,
    stringFlag(flags, "relationships-root") ?? path.join("..", "relationships")
  );
  const stateRoot = path.resolve(registryDir, stringFlag(flags, "state-root") ?? ".");
  const owner = stringFlag(flags, "owner") ?? "Dave";
  const contacts = listFlag(flags, "contacts") ?? ["Lisa"];
  const relationshipIds = listFlag(flags, "relationship-ids");
  const timezone = stringFlag(flags, "timezone") ?? "America/Los_Angeles";
  const staleMinutes = Number(stringFlag(flags, "stale-claim-minutes") ?? "5");
  const force = boolFlag(flags, "force");

  if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
    throw new DmsumError("--stale-claim-minutes must be a positive number");
  }
  if ((await exists(registryPath)) && !force) {
    throw new DmsumError(`Registry already exists at ${registryPath}. Use --force to overwrite it.`);
  }

  const registry = createRegistry({
    ownerName: owner,
    contactSpecs: contacts,
    relationshipIds,
    relationshipsRoot,
    stateRoot,
    timezone,
    staleClaimMs: Math.round(staleMinutes * 60 * 1000)
  });
  await saveRegistry(registryPath, registry);

  const explicitSpecPath = stringFlag(flags, "spec");
  const defaultContractPath = path.join(process.cwd(), "DMSUM.md");
  const defaultSpecPath = path.join(process.cwd(), "DM·Sum Ontology and Functional Spec (v1).md");
  const specSourcePath = explicitSpecPath
    ? path.resolve(explicitSpecPath)
    : (await exists(defaultContractPath))
      ? defaultContractPath
      : (await exists(defaultSpecPath))
      ? defaultSpecPath
      : undefined;

  for (const relationship of registry.relationships) {
    await initializeVault({
      config: createConfig({
        relationshipId: relationship.id,
        vaultRoot: relationship.vaultRoot,
        stateDir: relationship.stateDir,
        timezone: relationship.timezone ?? registry.timezone,
        staleClaimMs: relationship.staleClaimMs ?? registry.staleClaimMs,
        participants: relationship.participants
      }),
      specSourcePath,
      overwriteSpec: force
    });
  }

  console.log(`Wrote registry: ${registryPath}`);
  console.log(`Initialized relationships: ${registry.relationships.map((relationship) => relationship.id).join(", ")}`);
}

async function initLocal(flags: Map<string, string | true>): Promise<void> {
  const dataRoot = path.resolve(stringFlag(flags, "data-root") ?? defaultLocalDataRoot());
  const owner = stringFlag(flags, "owner") ?? "Dave";
  const contacts = listFlag(flags, "contacts") ?? ["Lisa", "Mike"];
  const relationshipIds = listFlag(flags, "relationship-ids");
  const remotes = listFlag(flags, "remotes");
  const timezone = stringFlag(flags, "timezone") ?? "America/Los_Angeles";
  const staleMinutes = Number(stringFlag(flags, "stale-claim-minutes") ?? "5");
  const force = boolFlag(flags, "force");

  if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
    throw new DmsumError("--stale-claim-minutes must be a positive number");
  }

  const result = await initializeLocalGitSync({
    dataRoot,
    ownerName: owner,
    contactSpecs: contacts,
    relationshipIds,
    remotes,
    timezone,
    staleClaimMs: Math.round(staleMinutes * 60 * 1000),
    force,
    specSourcePath: await findDefaultSpecSource(flags)
  });

  console.log(`Wrote registry: ${result.registryPath}`);
  console.log(`Wrote sync config: ${result.syncPath}`);
  console.log(`Initialized Git-backed relationships: ${result.registry.relationships.map((relationship) => relationship.id).join(", ")}`);
}

async function syncCommand(subcommand: string | undefined, flags: Map<string, string | true>): Promise<void> {
  const dataRoot = stringFlag(flags, "data-root");
  const registryPath = stringFlag(flags, "registry");
  const syncPath = path.resolve(
    stringFlag(flags, "sync") ??
      (dataRoot ? syncPathForDataRoot(path.resolve(dataRoot)) : defaultSyncPathForRegistry(path.resolve(registryPath ?? defaultRegistryPath())))
  );
  const relationshipId = stringFlag(flags, "relationship");
  const interval = Number(stringFlag(flags, "interval") ?? "60");

  if (subcommand === "once") {
    printSyncResult(await syncOnce({ syncPath, relationshipId }));
    return;
  }
  if (subcommand === "status") {
    printSyncResult(await syncStatus({ syncPath, relationshipId }));
    return;
  }
  if (subcommand === "doctor") {
    printDoctorResult(await syncDoctor({ syncPath, relationshipId }));
    return;
  }
  if (subcommand === "resolve") {
    if (!relationshipId) throw new DmsumError("sync resolve requires --relationship");
    printSyncResult(await resolveSync({ syncPath, relationshipId }));
    return;
  }
  if (subcommand === "daemon") {
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new DmsumError("--interval must be a positive integer");
    }
    console.log(`Mem·Sum sync daemon using ${syncPath} every ${interval}s`);
    await runSyncDaemon({
      syncPath,
      relationshipId,
      intervalSeconds: interval,
      onResult: printSyncResult
    });
    return;
  }

  throw new DmsumError("sync requires a subcommand: once, daemon, status, doctor, or resolve");
}

async function hostedCommand(subcommand: string | undefined, flags: Map<string, string | true>): Promise<void> {
  if (subcommand === "login-link") {
    const supabaseUrl = hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL");
    const anonKey = hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY");
    const email = hostedSetting(flags, "email", "DMSUM_AUTH_EMAIL");
    const redirectTo = stringFlag(flags, "redirect-to");
    const noCreateUser = boolFlag(flags, "no-create-user");

    await requestHostedLoginLink({
      supabaseUrl,
      anonKey,
      email,
      redirectTo,
      shouldCreateUser: !noCreateUser
    });

    console.log(`Sent hosted Mem·Sum login link to ${email}`);
    return;
  }

  if (subcommand === "smoke") {
    const result = await runHostedSmoke({
      endpoint: stringFlag(flags, "endpoint") ?? "https://sum.memsum.ai/mcp",
      supabaseUrl: hostedOptionalSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedOptionalSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      contactHandle: stringFlag(flags, "contact") ?? "@lisa",
      relationshipDisplayName: stringFlag(flags, "relationship-display-name") ?? "Dave-Lisa",
      selfDisplayName: stringFlag(flags, "self-display-name") ?? "Dave",
      peerDisplayName: stringFlag(flags, "peer-display-name") ?? "Lisa",
      contactDisplayName: stringFlag(flags, "contact-display-name"),
      agent: stringFlag(flags, "agent") ?? "Mem·Sum hosted smoke",
      smokePath: stringFlag(flags, "smoke-path")
    });
    printHostedSmokeResult(result);
    return;
  }

  if (subcommand === "token-issue") {
    const expiresDays = stringFlag(flags, "expires-days");
    const result = await issueHostedConnectorToken({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      name: stringFlag(flags, "name") ?? "Mem·Sum remote MCP connector",
      expiresAt: expiresDays ? expiresAtFromDays(expiresDays) : undefined
    });
    printHostedConnectorToken(result);
    return;
  }

  if (subcommand === "token-list") {
    const tokens = await listHostedConnectorTokens({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true)
    });
    printHostedConnectorTokens(tokens);
    return;
  }

  if (subcommand === "token-revoke") {
    const tokenId = stringFlag(flags, "token-id");
    if (!tokenId) throw new DmsumError("hosted token-revoke requires --token-id");
    const result = await revokeHostedConnectorToken({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      tokenId
    });
    console.log(result.revoked ? "Revoked hosted connector token" : "No matching hosted connector token was revoked");
    return;
  }

  if (subcommand === "invite-create") {
    const relationshipId = stringFlag(flags, "relationship-id");
    if (!relationshipId) throw new DmsumError("hosted invite-create requires --relationship-id");
    const participantId = stringFlag(flags, "participant-id");
    const displayName = stringFlag(flags, "display-name");
    if ((participantId ? 1 : 0) + (displayName ? 1 : 0) !== 1) {
      throw new DmsumError("hosted invite-create requires exactly one of --participant-id or --display-name");
    }
    const expiresDays = stringFlag(flags, "expires-days") ?? "14";
    const result = await createHostedInvitation({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      relationshipId,
      participantId,
      newParticipantDisplayName: displayName,
      expiresAt: expiresAtFromDays(expiresDays)
    });
    console.log("Created invitation. Deliver this link yourself; the token is shown once:");
    console.log(`  ${result.inviteLink}`);
    console.log(`  participant: ${result.participantDisplayName} (${result.participantId})`);
    console.log(`  invitation:  ${result.invitationId}`);
    console.log(`  expires:     ${result.expiresAt ?? "never"}`);
    return;
  }

  if (subcommand === "invite-list") {
    const relationshipId = stringFlag(flags, "relationship-id");
    if (!relationshipId) throw new DmsumError("hosted invite-list requires --relationship-id");
    const invitations = await listHostedInvitations({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      relationshipId
    });
    printHostedInvitations(invitations);
    return;
  }

  if (subcommand === "invite-revoke") {
    const invitationId = stringFlag(flags, "invitation-id");
    if (!invitationId) throw new DmsumError("hosted invite-revoke requires --invitation-id");
    const result = await revokeHostedInvitation({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      invitationId
    });
    console.log(
      result.revoked
        ? "Revoked hosted invitation"
        : `No pending hosted invitation was revoked${result.reason ? ` (${result.reason})` : ""}`
    );
    return;
  }

  if (subcommand === "invite-claim") {
    const token = stringFlag(flags, "token") ?? envValue(stringFlag(flags, "token-env") ?? "DMSUM_INVITE_TOKEN");
    if (!token) throw new DmsumError("hosted invite-claim requires --token or DMSUM_INVITE_TOKEN");
    const result = await claimHostedInvitation({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      token
    });
    console.log(
      result.alreadyClaimed
        ? "Invitation was already claimed by this account."
        : "Claimed hosted invitation."
    );
    console.log(`  relationship: ${result.relationshipDisplayName ?? result.relationshipId} (${result.relationshipId})`);
    console.log(`  participant:  ${result.participantDisplayName} (${result.participantId})`);
    return;
  }

  if (subcommand === "export-okf") {
    const relationshipId = stringFlag(flags, "relationship-id");
    if (!relationshipId) throw new DmsumError("hosted export-okf requires --relationship-id");
    const outDir = stringFlag(flags, "out");
    if (!outDir) throw new DmsumError("hosted export-okf requires --out DIRECTORY");
    const profileFlag = stringFlag(flags, "profile") ?? "share";
    if (profileFlag !== "share" && profileFlag !== "archive") {
      throw new DmsumError("hosted export-okf --profile must be share or archive");
    }
    const pagesFlag = stringFlag(flags, "pages");

    const result = await exportHostedOkfBundle({
      supabaseUrl: hostedSetting(flags, "supabase-url", "DMSUM_SUPABASE_URL"),
      anonKey: hostedSetting(flags, "anon-key", "DMSUM_SUPABASE_ANON_KEY"),
      accessToken: hostedOptionalSetting(flags, "access-token-env", "DMSUM_HOSTED_ACCESS_TOKEN", true),
      email: hostedOptionalSetting(flags, "email", "DMSUM_AUTH_EMAIL"),
      password: hostedOptionalSetting(flags, "password-env", "DMSUM_AUTH_PASSWORD", true),
      relationshipId,
      profile: profileFlag,
      pages: pagesFlag ? pagesFlag.split(",").map((page) => page.trim()).filter(Boolean) : undefined,
      since: stringFlag(flags, "since")
    });

    for (const file of result.files) {
      const target = path.join(outDir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, "utf8");
    }
    console.log(`Exported ${result.profile} bundle for ${result.relationshipDisplayName}`);
    console.log(`  files: ${result.files.length}`);
    console.log(`  out:   ${path.resolve(outDir)}`);
    return;
  }

  throw new DmsumError(
    "hosted requires a subcommand: login-link, smoke, token-issue, token-list, token-revoke, invite-create, invite-list, invite-revoke, invite-claim, or export-okf"
  );
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() ? value.trim() : undefined;
}

function printHostedInvitations(invitations: HostedInvitationSummary[]): void {
  if (invitations.length === 0) {
    console.log("No hosted invitations for this relationship.");
    return;
  }
  for (const invitation of invitations) {
    const participant = invitation.participantDisplayName ?? invitation.participantId ?? "(participant removed)";
    console.log(`${invitation.status.padEnd(8)} ${participant} — invitation ${invitation.invitationId}`);
    console.log(`  created: ${invitation.createdAt}`);
    if (invitation.expiresAt) console.log(`  expires: ${invitation.expiresAt}`);
    if (invitation.acceptedAt) console.log(`  accepted: ${invitation.acceptedAt}`);
    if (invitation.revokedAt) console.log(`  revoked: ${invitation.revokedAt}`);
  }
}

function hostedSetting(flags: Map<string, string | true>, key: string, envName: string): string {
  const value = hostedOptionalSetting(flags, key, envName);
  if (!value) throw new DmsumError(`Provide --${key} or set ${envName}`);
  return value;
}

function hostedOptionalSetting(
  flags: Map<string, string | true>,
  key: string,
  envName: string,
  keyNamesEnvVar = false
): string | undefined {
  const explicit = stringFlag(flags, key);
  if (explicit) return keyNamesEnvVar ? process.env[explicit] : explicit;
  return process.env[envName];
}

function expiresAtFromDays(value: string): string {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) throw new DmsumError("--expires-days must be a positive number");
  return new Date(Date.now() + Math.round(days * 24 * 60 * 60 * 1000)).toISOString();
}

async function audit(flags: Map<string, string | true>): Promise<void> {
  const configPath = path.resolve(stringFlag(flags, "config") ?? defaultConfigPath());
  const port = Number(stringFlag(flags, "port") ?? "8787");
  if (!Number.isInteger(port) || port <= 0) {
    throw new DmsumError("--port must be a positive integer");
  }
  const config = await loadConfig(configPath);
  await startAuditServer(config, port);
  console.log(`Mem·Sum audit renderer listening at http://localhost:${port}`);
}

async function update(flags: Map<string, string | true>): Promise<void> {
  const configPath = path.resolve(stringFlag(flags, "config") ?? defaultConfigPath());
  const participant = stringFlag(flags, "participant");
  const agent = stringFlag(flags, "agent");
  const tags = listFlag(flags, "tags");
  const attention = listFlag(flags, "attention");
  const rawText = stringFlag(flags, "raw");
  const displayText = stringFlag(flags, "display");
  const wikiPath = stringFlag(flags, "wiki-path");
  const wikiTitle = stringFlag(flags, "wiki-title");
  const wikiContent = stringFlag(flags, "wiki-content");
  const preferenceParticipant = stringFlag(flags, "preference-participant");
  const preferenceContent = stringFlag(flags, "preference-content");

  if (!participant) throw new DmsumError("--participant is required");
  if (!agent) throw new DmsumError("--agent is required");
  if (!displayText) throw new DmsumError("--display is required");
  const hasWikiWrite = Boolean(wikiPath || wikiTitle || wikiContent);
  const hasPreferenceWrite = Boolean(preferenceParticipant || preferenceContent);
  if (!hasWikiWrite && !hasPreferenceWrite) {
    throw new DmsumError("Provide either --wiki-* flags or --preference-* flags");
  }
  if (hasWikiWrite && (!wikiPath || !wikiTitle || !wikiContent)) {
    throw new DmsumError("--wiki-path, --wiki-title, and --wiki-content are required together");
  }
  if (hasPreferenceWrite && (!preferenceParticipant || !preferenceContent)) {
    throw new DmsumError("--preference-participant and --preference-content are required together");
  }

  const config = await loadConfig(configPath);
  const vault = new DmsumVault(config);
  const interaction = await vault.commitInteraction({
    participant,
    agent,
    rawText: rawText ?? displayText,
    addressedParticipants: attention
  });
  await vault.commitWikiUpdate({
    participant,
    agent,
    tags,
    attention,
    interactionIds: [interaction.interactionId],
    displayText,
    wikiWrites: hasWikiWrite ? [{ path: wikiPath!, title: wikiTitle!, content: wikiContent! }] : undefined,
    preferenceWrites: hasPreferenceWrite
      ? [{ participant: preferenceParticipant!, content: preferenceContent! }]
      : undefined
  });

  console.log(displayText);
}

async function findDefaultSpecSource(flags: Map<string, string | true>): Promise<string | undefined> {
  const explicitSpecPath = stringFlag(flags, "spec");
  const defaultContractPath = path.join(process.cwd(), "DMSUM.md");
  const defaultSpecPath = path.join(process.cwd(), "DM·Sum Ontology and Functional Spec (v1).md");
  return explicitSpecPath
    ? path.resolve(explicitSpecPath)
    : (await exists(defaultContractPath))
      ? defaultContractPath
      : (await exists(defaultSpecPath))
      ? defaultSpecPath
      : undefined;
}

function printSyncResult(result: SyncRunResult): void {
  for (const relationship of result.relationships) {
    console.log(`${relationship.relationshipId}: ${relationship.status} - ${relationship.message}`);
    if (relationship.conflictFiles.length > 0) {
      console.log(`  conflicts: ${relationship.conflictFiles.join(", ")}`);
    }
  }
}

function printDoctorResult(result: SyncDoctorResult): void {
  for (const check of result.checks) {
    const prefix = check.relationshipId ? `${check.relationshipId} ` : "";
    console.log(`${check.status.toUpperCase()} ${prefix}${check.name}: ${check.message}`);
  }
}

function printHostedSmokeResult(result: HostedSmokeResult): void {
  console.log(`${result.relationshipDisplayName} ${result.contactHandle}: hosted smoke OK`);
  console.log(`  smoke page: ${result.smokePath}`);
  console.log(`  version: ${result.beforeVersion} -> ${result.afterVersion}`);
  console.log(`  stale rejection: ${result.staleRejected ? "ok" : "failed"}`);
  if (result.createdRelationship) {
    console.log("  relationship context: created");
  }
}

function printHostedConnectorToken(result: HostedConnectorTokenResult): void {
  console.log(`Issued hosted connector token: ${result.name}`);
  console.log(`  token id: ${result.tokenId}`);
  console.log(`  expires: ${result.expiresAt ?? "never"}`);
  console.log(`  bearer token: ${result.token}`);
  console.log("Store this token in the remote MCP client now. It cannot be shown again.");
}

function printHostedConnectorTokens(tokens: HostedConnectorTokenSummary[]): void {
  if (tokens.length === 0) {
    console.log("No hosted connector tokens found");
    return;
  }
  for (const token of tokens) {
    const state = token.revokedAt ? "revoked" : "active";
    console.log(`${token.tokenId} ${state} ${token.name}`);
    console.log(`  created: ${token.createdAt}`);
    console.log(`  last used: ${token.lastUsedAt ?? "never"}`);
    console.log(`  expires: ${token.expiresAt ?? "never"}`);
  }
}

function usage(): string {
  return `Usage:
  dmsum init [--vault PATH] [--config PATH] [--participants Dave,Lisa] [--timezone America/Los_Angeles] [--force]
  dmsum init-registry [--registry PATH] [--owner Dave] [--contacts Lisa,lisa-work=Lisa] [--relationship-ids dave-lisa,dave-lisa-work] [--relationships-root PATH] [--state-root PATH] [--timezone America/Los_Angeles] [--force]
  dmsum init-local [--data-root C:\\Users\\Dave\\DMSum] [--owner Dave] [--contacts Lisa,Mike] [--relationship-ids dave-lisa,dave-mike] [--remotes REMOTE1,REMOTE2] [--force]
  dmsum sync once [--registry PATH | --data-root PATH | --sync PATH] [--relationship dave-lisa]
  dmsum sync daemon [--registry PATH | --data-root PATH | --sync PATH] [--relationship dave-lisa] [--interval 60]
  dmsum sync status [--registry PATH | --data-root PATH | --sync PATH] [--relationship dave-lisa]
  dmsum sync doctor [--registry PATH | --data-root PATH | --sync PATH] [--relationship dave-lisa]
  dmsum sync resolve --relationship dave-lisa [--registry PATH | --data-root PATH | --sync PATH]
  dmsum hosted login-link --email docgotham@gmail.com [--supabase-url URL] [--anon-key KEY] [--redirect-to URL] [--no-create-user]
  dmsum hosted smoke [--endpoint URL] [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN] [--contact @lisa]
  dmsum hosted token-issue --name "Perplexity remote MCP" [--expires-days 90] [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]
  dmsum hosted token-list [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]
  dmsum hosted token-revoke --token-id TOKEN_ID [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]
  dmsum hosted invite-create --relationship-id UUID (--participant-id UUID | --display-name "Mom") [--expires-days 14] [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]
  dmsum hosted invite-list --relationship-id UUID [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]
  dmsum hosted invite-revoke --invitation-id UUID [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]
  dmsum hosted invite-claim [--token memsum_invite_...] [--token-env DMSUM_INVITE_TOKEN] [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]  (authenticates as the claiming user)
  dmsum hosted export-okf --relationship-id UUID --out DIR [--pages wiki/topics/a.md,wiki/topics/b.md] [--profile share|archive] [--since 2026-07-01] [--supabase-url URL] [--anon-key KEY] [--email EMAIL] [--password-env DMSUM_AUTH_PASSWORD | --access-token-env DMSUM_HOSTED_ACCESS_TOKEN]
  dmsum update --participant Dave --agent Dave-OpenAI [--raw "+sum ..."] [--tags tag-a,tag-b] [--attention Lisa] --display "..." [--wiki-path wiki/topics/example.md --wiki-title "Example" --wiki-content "# Example..."] [--preference-participant Dave --preference-content "# Dave Preferences..."]
  dmsum audit [--config PATH] [--port 8787]
`;
}

async function main(): Promise<void> {
  const { command, subcommand, flags } = parseArgs(process.argv.slice(2));
  if (command === "init") {
    await init(flags);
    return;
  }
  if (command === "init-registry") {
    await initRegistry(flags);
    return;
  }
  if (command === "init-local") {
    await initLocal(flags);
    return;
  }
  if (command === "sync") {
    await syncCommand(subcommand, flags);
    return;
  }
  if (command === "hosted") {
    await hostedCommand(subcommand, flags);
    return;
  }
  if (command === "audit") {
    await audit(flags);
    return;
  }
  if (command === "update") {
    await update(flags);
    return;
  }
  console.log(usage());
  if (command) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
