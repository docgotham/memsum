export interface ParsedWikiLink {
  target: string;
  label: string;
  canonicalPath: string;
  candidates: string[];
  anchor?: string;
}

export function stripWikiLink(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\[\[([^|\]]+)(?:\|[^\]]+)?\]\]$/);
  return (match?.[1] ?? trimmed).trim();
}

export function isSafeGraphPath(value: string): boolean {
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return value.endsWith(".md");
}

export function isSafeGraphLocator(value: string): boolean {
  const stripped = stripWikiLink(value);
  if (!stripped || stripped.startsWith("/") || /^[A-Za-z]:/.test(stripped) || stripped.includes("\\")) return false;
  const parts = stripped.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return !stripped.endsWith("/") && !stripped.includes("[") && !stripped.includes("]");
}

export function hostedReadPageCandidates(value: string): string[] {
  const stripped = stripWikiLink(value);
  const markdownPath = stripped.endsWith(".md") ? stripped : `${stripped}.md`;
  const candidates = [markdownPath];
  if (!markdownPath.startsWith("wiki/")) candidates.push(`wiki/${markdownPath}`);
  return [...new Set(candidates)];
}

export function parseWikiLinks(content: string): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];
  const seen = new Set<string>();
  const linkPattern = /(!)?\[\[([^\]\n]+)\]\]/g;

  for (const match of content.matchAll(linkPattern)) {
    if (match[1]) continue;

    const rawBody = match[2]?.trim();
    if (!rawBody) continue;

    const [targetPart, ...labelParts] = rawBody.split("|");
    const target = targetPart.trim();
    if (!target) continue;

    const anchorIndex = target.indexOf("#");
    const pathTarget = (anchorIndex >= 0 ? target.slice(0, anchorIndex) : target).trim();
    const anchor = anchorIndex >= 0 ? target.slice(anchorIndex + 1).trim() : undefined;
    if (!pathTarget || !isSafeGraphLocator(pathTarget)) continue;

    const candidates = hostedReadPageCandidates(pathTarget);
    const canonicalPath = candidates.at(-1) ?? pathTarget;
    const key = `${canonicalPath}#${anchor ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    links.push({
      target,
      label: (labelParts.length ? labelParts.join("|").trim() : "") || target,
      canonicalPath,
      candidates,
      ...(anchor ? { anchor } : {})
    });
  }

  return links;
}
