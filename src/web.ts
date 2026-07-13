import fs from "node:fs/promises";
import MarkdownIt from "markdown-it";
import { resolveVaultPath } from "./paths.js";
import type { DmsumConfig } from "./types.js";
import { DmsumVault } from "./vault.js";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true
});

export interface AuditPage {
  status: number;
  contentType: string;
  body: string;
}

export async function renderAuditPage(config: DmsumConfig, requestedPath = "."): Promise<AuditPage> {
  const vault = new DmsumVault(config);
  const resolved = resolveVaultPath(config.vaultRoot, requestedPath, true);
  const stat = await fs.stat(resolved.absolutePath);
  if (stat.isDirectory()) {
    const files = await vault.listFiles(requestedPath);
    return htmlPage("Mem·Sum Audit", directoryHtml(files));
  }

  const file = await vault.readFile(requestedPath);
  const body = file.path.endsWith(".md")
    ? markdown.render(file.content)
    : `<pre>${escapeHtml(file.content)}</pre>`;
  return htmlPage(file.path, `<p><a href="/">Vault root</a></p>${body}`);
}

export function renderAuditError(error: unknown): AuditPage {
  return {
    status: 404,
    contentType: "text/plain; charset=utf-8",
    body: String(error)
  };
}

export function renderSetupPage(detail: string): AuditPage {
  return htmlPage(
    "Mem·Sum Audit Setup",
    `<h1>Mem·Sum Audit</h1>
<p>${escapeHtml(detail)}</p>
<p>Set <code>DMSUM_CONFIG_PATH</code> to a readable local config file, then route requests to this read-only viewer.</p>`
  );
}

function directoryHtml(files: Array<{ path: string; name: string; type: "file" | "dir" }>): string {
  const items = files
    .map((file) => {
      const label = `${escapeHtml(file.name)}${file.type === "dir" ? "/" : ""}`;
      return `<li><a href="/?path=${encodeURIComponent(file.path)}">${label}</a></li>`;
    })
    .join("");
  return `<h1>Mem·Sum Audit</h1><ul>${items}</ul>`;
}

function htmlPage(title: string, body: string): AuditPage {
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 900px; margin: 32px auto; padding: 0 20px; color: #171717; background: #fafafa; }
    h1, h2, h3 { line-height: 1.2; }
    code, pre { background: #f0f0f0; border-radius: 6px; }
    code { padding: 1px 4px; }
    pre { padding: 12px; overflow: auto; }
    a { color: #075985; }
    li { margin: 6px 0; }
  </style>
</head>
<body>
${body}
</body>
</html>`
  };
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
