import MarkdownIt from "markdown-it";

// Read-only wiki rendering for the dashboard and Companion. The graph stays
// canonical and agent-written; this module only projects stored markdown into
// safe HTML. html is disabled so raw HTML in page content is escaped, never
// executed — the renderer emits only its own generated tags.
export interface WikiPageRow {
  id: string;
  path: string;
  title: string;
  content: string;
  version: number;
  updated_at: string;
}

// Unexpanded provenance template tokens are a local-kernel contract
// convention the hosted kernel does not expand (ROADMAP stranger-test punch
// #8). Until that decision lands, the viewer strips any literal tokens so
// participants never see template braces.
const PROVENANCE_TOKENS = /\{\{WIKI_UPDATE_(?:ID|PATH|LINK)\}\}/g;

// Stored page paths live under wiki/ (e.g. wiki/topics/budapest-trip.md).
// Viewer URLs drop that constant prefix: /sums/{id}/wiki/topics/budapest-trip.md
export function wikiPageHref(relationshipId: string, storedPath: string): string {
  const trimmed = storedPath.replace(/^wiki\//, "");
  return `/sums/${relationshipId}/wiki/${trimmed.split("/").map(encodeURIComponent).join("/")}`;
}

// The reverse mapping for the catch-all route: URL segments back to the
// stored-path candidates to query, most likely first.
export function storedPathCandidates(segments: string[]): string[] {
  const joined = segments.map((segment) => decodeURIComponent(segment)).join("/");
  return joined.startsWith("wiki/") ? [joined] : [`wiki/${joined}`, joined];
}

// [[wiki links]] resolve before markdown rendering: path-shaped targets become
// ordinary links into the viewer; anything else (titles, audit handles)
// renders as emphasized text rather than a dead link.
function resolveWikiLinks(markdown: string, relationshipId: string): string {
  return markdown.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_match, rawTarget: string, rawAlias?: string) => {
    const target = rawTarget.trim();
    const alias = (rawAlias ?? target).trim();
    if (/^[^\s]+\.md$/i.test(target)) {
      return `[${alias}](${wikiPageHref(relationshipId, target)})`;
    }
    return `*${alias}*`;
  });
}

const md = new MarkdownIt({ html: false, linkify: true });

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderWikiHtml(content: string, relationshipId: string): string {
  const cleaned = content.replace(/\r\n/g, "\n").replace(PROVENANCE_TOKENS, "");
  return md.render(resolveWikiLinks(cleaned, relationshipId));
}

// Client-side download of the raw page markdown — a read of content already
// in hand, not a new kernel surface. Bundle exports remain the audited path.
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
