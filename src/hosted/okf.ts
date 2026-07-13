import { authenticatedClient, signInHostedUser, type HostedAuthOptions } from "./operator.js";

// OKF v0.1 export, implementing the ·Sum Family OKF Interchange Profile
// (v0.1, 2026-07-07, in the katamari). OKF is emitted only at boundaries: an
// exported bundle is a projection of the graph — the curated-prose leg of the
// Provenance Triple — and the graph stays canonical. Mechanical and verbatim
// by design: no redaction rules, no restructuring; judgment belongs to agents
// and users, mechanics belong here.

export type OkfProfile = "share" | "archive";

export interface OkfPageInput {
  path: string;
  title: string | null;
  content: string;
  version: number;
  updatedAt: string;
}

export interface OkfUpdateInput {
  displayText: string | null;
  createdAt: string;
  changedPages: Array<{ path: string; title: string | null }>;
}

export interface OkfInteractionInput {
  id: string;
  rawText: string;
  agent: string;
  participantDisplayName: string | null;
  createdAt: string;
}

export interface OkfPreferenceInput {
  participantDisplayName: string;
  content: string;
  version: number;
  updatedAt: string;
}

export interface OkfBundleMeta {
  profile: OkfProfile;
  sourceSubstrate: string;
  relationshipDisplayName: string;
  exportedAt: string;
  since?: string;
}

export interface OkfBundleFile {
  path: string;
  content: string;
}

// §3.5 type vocabulary. Directory prefix decides; unknown prefixes fall back
// to Topic because OKF consumers must tolerate unknown types anyway.
export function okfTypeForPath(path: string): string {
  if (path.startsWith("wiki/topics/")) return "Topic";
  if (path.startsWith("wiki/entities/")) return "Entity";
  if (path.startsWith("wiki/concepts/")) return "Concept";
  if (path.startsWith("wiki/synthesis/")) return "Synthesis";
  if (path.startsWith("wiki/sources/")) return "Source";
  return "Topic";
}

function yamlText(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function slugForTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "page";
}

// §3.1: wiki links become bundle-absolute markdown links. In-scope targets
// resolve by exact path (with or without the wiki/ prefix or .md suffix) or
// by title, case-insensitively. Out-of-scope targets are rewritten to the
// path they would have had and left broken — inert provenance is still
// honest provenance, and red links stay broken by design.
export function rewriteWikiLinksForBundle(content: string, pages: OkfPageInput[]): string {
  const byPath = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const page of pages) {
    const bundlePath = `/${page.path}`;
    byPath.set(page.path.toLowerCase(), bundlePath);
    byPath.set(page.path.toLowerCase().replace(/\.md$/, ""), bundlePath);
    byPath.set(page.path.toLowerCase().replace(/^wiki\//, ""), bundlePath);
    byPath.set(page.path.toLowerCase().replace(/^wiki\//, "").replace(/\.md$/, ""), bundlePath);
    if (page.title) byTitle.set(page.title.toLowerCase(), bundlePath);
  }

  return content.replace(/\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g, (_match, target: string, alias?: string) => {
    const trimmed = target.trim();
    const label = (alias ?? trimmed).trim();
    const resolved = byPath.get(trimmed.toLowerCase()) ?? byTitle.get(trimmed.toLowerCase());
    if (resolved) return `[${label}](${resolved})`;
    if (trimmed.includes("/")) {
      const normalized = trimmed.replace(/^\/+/, "").replace(/\.md$/, "");
      const prefixed = normalized.startsWith("wiki/") ? normalized : `wiki/${normalized}`;
      return `[${label}](/${prefixed}.md)`;
    }
    return `[${label}](/wiki/topics/${slugForTitle(trimmed)}.md)`;
  });
}

// §3.2: hosted pages are natively frontmatter-free; the exporter synthesizes
// conformant frontmatter from stored metadata.
export function synthesizeOkfFrontmatter(page: OkfPageInput): string {
  const lines = [`type: ${okfTypeForPath(page.path)}`];
  if (page.title) lines.push(`title: ${yamlText(page.title)}`);
  lines.push(`timestamp: ${yamlText(page.updatedAt)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

// §3.3: log.md generated from wiki-update records — date-grouped, newest
// first, entries linking their changed pages. The displayText stream already
// leads with its verb.
export function buildOkfLog(updates: OkfUpdateInput[], meta: OkfBundleMeta): string {
  const inWindow = meta.since ? updates.filter((update) => update.createdAt >= meta.since!) : updates;
  const sorted = [...inWindow].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const byDate = new Map<string, OkfUpdateInput[]>();
  for (const update of sorted) {
    const day = update.createdAt.slice(0, 10);
    const existing = byDate.get(day) ?? [];
    existing.push(update);
    byDate.set(day, existing);
  }

  const sections: string[] = [];
  for (const [day, entries] of byDate) {
    const lines = entries.map((update) => {
      const text = (update.displayText ?? "Update").trim().replace(/\s+/g, " ");
      const links = update.changedPages
        .map((page) => `[${page.title ?? page.path}](/${page.path})`)
        .join(", ");
      return links ? `- **${text}** — ${links}` : `- **${text}**`;
    });
    sections.push(`## ${day}\n\n${lines.join("\n")}`);
  }

  const header = `---\ntype: Log\ntitle: ${yamlText(`${meta.relationshipDisplayName} log`)}\ntimestamp: ${yamlText(meta.exportedAt)}\n---\n\n# Log\n\n`;
  return header + (sections.length ? `${sections.join("\n\n")}\n` : "No updates in the exported window.\n");
}

// §5: the bundle-root index.md declares okf_version and the bundle metadata,
// including the versions of the pages included, and says when the bundle
// derives from a jointly-authored substrate — as provenance, not permission.
export function buildOkfBundleIndex(meta: OkfBundleMeta, pages: OkfPageInput[]): string {
  const frontmatter = [
    `okf_version: "0.1"`,
    `type: Synthesis`,
    `title: ${yamlText(`${meta.relationshipDisplayName} (${meta.profile} bundle)`)}`,
    `profile: ${meta.profile}`,
    `source_substrate: ${yamlText(meta.sourceSubstrate)}`,
    `relationship: ${yamlText(meta.relationshipDisplayName)}`,
    `exported: ${yamlText(meta.exportedAt)}`,
    ...(meta.since ? [`since: ${yamlText(meta.since)}`] : []),
    `pages:`,
    ...pages.map((page) => `  - path: ${yamlText(`/${page.path}`)}\n    version: ${page.version}`)
  ].join("\n");

  const listing = pages.map((page) => `- [${page.title ?? page.path}](/${page.path})`).join("\n");
  const provenance = `This bundle is a projection of the jointly authored sum "${meta.relationshipDisplayName}"; the graph it derives from remains canonical.`;

  return `---\n${frontmatter}\n---\n\n# ${meta.relationshipDisplayName}\n\n${provenance}\n\n${listing}\n\n[Log](/log.md)\n`;
}

function interactionFile(interaction: OkfInteractionInput): OkfBundleFile {
  const attribution = interaction.participantDisplayName
    ? `${interaction.participantDisplayName} via ${interaction.agent}`
    : interaction.agent;
  const content =
    `---\ntype: Interaction\ntitle: ${yamlText(`Interaction ${interaction.id}`)}\ntimestamp: ${yamlText(interaction.createdAt)}\n---\n\n` +
    `${interaction.rawText}\n\n— ${attribution}, ${interaction.createdAt}\n`;
  return { path: `interactions/${interaction.id}.md`, content };
}

function preferenceFile(preference: OkfPreferenceInput): OkfBundleFile {
  const content =
    `---\ntype: Preference\ntitle: ${yamlText(`${preference.participantDisplayName} preferences`)}\ntimestamp: ${yamlText(preference.updatedAt)}\n---\n\n` +
    `${preference.content}\n`;
  return { path: `preferences/${slugForTitle(preference.participantDisplayName)}.md`, content };
}

export function buildOkfBundle(input: {
  meta: OkfBundleMeta;
  pages: OkfPageInput[];
  updates: OkfUpdateInput[];
  interactions?: OkfInteractionInput[];
  preferences?: OkfPreferenceInput[];
}): OkfBundleFile[] {
  const files: OkfBundleFile[] = [
    { path: "index.md", content: buildOkfBundleIndex(input.meta, input.pages) },
    { path: "log.md", content: buildOkfLog(input.updates, input.meta) },
    ...input.pages.map((page) => ({
      path: page.path,
      content: synthesizeOkfFrontmatter(page) + rewriteWikiLinksForBundle(page.content, input.pages)
    }))
  ];

  if (input.meta.profile === "archive") {
    files.push(...(input.interactions ?? []).map(interactionFile));
    files.push(...(input.preferences ?? []).map(preferenceFile));
  }

  return files;
}

export interface HostedOkfExportOptions extends HostedAuthOptions {
  relationshipId: string;
  pages?: string[];
  profile?: OkfProfile;
  since?: string;
  now?: Date;
}

export interface HostedOkfExportResult {
  relationshipDisplayName: string;
  profile: OkfProfile;
  files: OkfBundleFile[];
}

export interface OkfExportSelection {
  relationshipId: string;
  pages?: string[];
  profile?: OkfProfile;
}

export interface OkfExportData {
  relationshipDisplayName: string;
  pages: OkfPageInput[];
  updates: OkfUpdateInput[];
  interactions?: OkfInteractionInput[];
  preferences?: OkfPreferenceInput[];
}

// Reads everything a bundle needs through the given client, so the caller's
// authorization is the export's authorization: the CLI passes an operator
// session, the dashboard endpoint passes the member's own JWT, and RLS scopes
// both identically.
export async function fetchOkfExportData(client: any, options: OkfExportSelection): Promise<OkfExportData> {
  const profile: OkfProfile = options.profile ?? "share";

  const { data: relationship, error: relationshipError } = await client
    .from("relationships")
    .select("id, display_name")
    .eq("id", options.relationshipId)
    .maybeSingle();
  if (relationshipError) throw new Error(relationshipError.message);
  if (!relationship) throw new Error("Relationship not found or not accessible with these credentials");

  let pagesQuery = client
    .from("wiki_pages")
    .select("path, title, content, version, updated_at")
    .eq("relationship_id", options.relationshipId)
    .order("path", { ascending: true });
  if (options.pages?.length) pagesQuery = pagesQuery.in("path", options.pages);
  const { data: pageRows, error: pagesError } = await pagesQuery;
  if (pagesError) throw new Error(pagesError.message);

  const pages: OkfPageInput[] = (pageRows ?? []).map((row: any) => ({
    path: row.path,
    title: row.title,
    content: row.content,
    version: row.version,
    updatedAt: row.updated_at
  }));
  const pagePaths = new Set(pages.map((page) => page.path));

  const { data: updateRows, error: updatesError } = await client
    .from("updates")
    .select("id, display_text, created_at, page_revisions(version, wiki_pages(path, title))")
    .eq("relationship_id", options.relationshipId)
    .order("created_at", { ascending: false });
  if (updatesError) throw new Error(updatesError.message);

  const updates: OkfUpdateInput[] = (updateRows ?? [])
    .map((row: any) => ({
      displayText: row.display_text,
      createdAt: row.created_at,
      changedPages: (row.page_revisions ?? [])
        .map((revision: any) => revision.wiki_pages)
        .filter((page: any) => page && pagePaths.has(page.path))
        .map((page: any) => ({ path: page.path, title: page.title }))
    }))
    .filter((update: OkfUpdateInput) => !options.pages?.length || update.changedPages.length > 0);

  let interactions: OkfInteractionInput[] | undefined;
  let preferences: OkfPreferenceInput[] | undefined;
  if (profile === "archive") {
    const [interactionsResult, preferencesResult] = await Promise.all([
      client
        .from("interactions")
        .select("id, raw_text, agent, created_at, participants(display_name)")
        .eq("relationship_id", options.relationshipId)
        .order("created_at", { ascending: true }),
      client
        .from("preferences")
        .select("content, version, updated_at, participants(display_name)")
        .eq("relationship_id", options.relationshipId)
    ]);
    if (interactionsResult.error) throw new Error(interactionsResult.error.message);
    if (preferencesResult.error) throw new Error(preferencesResult.error.message);
    interactions = (interactionsResult.data ?? []).map((row: any) => ({
      id: row.id,
      rawText: row.raw_text,
      agent: row.agent,
      participantDisplayName: row.participants?.display_name ?? null,
      createdAt: row.created_at
    }));
    preferences = (preferencesResult.data ?? []).map((row: any) => ({
      participantDisplayName: row.participants?.display_name ?? "participant",
      content: row.content,
      version: row.version,
      updatedAt: row.updated_at
    }));
  }

  return { relationshipDisplayName: relationship.display_name, pages, updates, interactions, preferences };
}

export function buildOkfBundleFromData(
  data: OkfExportData,
  options: { profile?: OkfProfile; since?: string; now?: Date }
): HostedOkfExportResult {
  const profile: OkfProfile = options.profile ?? "share";
  const meta: OkfBundleMeta = {
    profile,
    sourceSubstrate: "Mem·Sum hosted graph",
    relationshipDisplayName: data.relationshipDisplayName,
    exportedAt: (options.now ?? new Date()).toISOString(),
    ...(options.since ? { since: options.since } : {})
  };
  return {
    relationshipDisplayName: data.relationshipDisplayName,
    profile,
    files: buildOkfBundle({
      meta,
      pages: data.pages,
      updates: data.updates,
      interactions: data.interactions,
      preferences: data.preferences
    })
  };
}

// §8: selection is an explicit page list; agents compute the list and pass
// paths. Without --pages the whole wiki/ layer exports.
export async function exportHostedOkfBundle(options: HostedOkfExportOptions): Promise<HostedOkfExportResult> {
  if (!options.supabaseUrl) throw new Error("Missing Supabase URL");
  if (!options.anonKey) throw new Error("Missing Supabase anon key");
  const accessToken = await signInHostedUser(options);
  const client = authenticatedClient(options.supabaseUrl, options.anonKey, accessToken);
  const data = await fetchOkfExportData(client, {
    relationshipId: options.relationshipId,
    pages: options.pages,
    profile: options.profile
  });
  return buildOkfBundleFromData(data, { profile: options.profile, since: options.since, now: options.now });
}
