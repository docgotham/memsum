"use client";

// A single wiki page, rendered read-only. The graph is canonical and
// agent-written; this surface only shows it and hands the raw markdown over
// on request. Rendering is markdown-it with html disabled — stored content
// can never inject markup — and unexpanded provenance tokens are stripped.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase";
import { downloadMarkdown, renderWikiHtml, storedPathCandidates, type WikiPageRow } from "@/lib/wiki";

export function WikiPageView({ relationshipId, segments }: { relationshipId: string; segments: string[] }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [page, setPage] = useState<WikiPageRow | null>(null);
  const [sumName, setSumName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: sessionData } = await supabase.auth.getSession();
    setSignedIn(Boolean(sessionData.session));
    if (!sessionData.session) {
      setReady(true);
      return;
    }
    const candidates = storedPathCandidates(segments);
    const [relationshipResult, pageResult] = await Promise.all([
      supabase.from("relationships").select("display_name").eq("id", relationshipId).maybeSingle(),
      supabase
        .from("wiki_pages")
        .select("id, path, title, content, version, updated_at")
        .eq("relationship_id", relationshipId)
        .in("path", candidates)
        .limit(1)
    ]);
    if (relationshipResult.data) setSumName((relationshipResult.data as { display_name: string }).display_name);
    if (pageResult.error) {
      setError("This page could not be loaded.");
    } else {
      const rows = (pageResult.data as WikiPageRow[]) ?? [];
      setPage(rows[0] ?? null);
      setError(null);
    }
    setReady(true);
  }, [relationshipId, segments]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{page?.title ?? "Wiki page"}</h1>
          {sumName ? (
            <p className="text-sm opacity-60">
              <Link className="underline" href={`/sums/${relationshipId}`}>
                {sumName}
              </Link>{" "}
              ·{" "}
              <Link className="underline" href={`/sums/${relationshipId}/wiki`}>
                wiki index
              </Link>
            </p>
          ) : null}
        </div>
        {page ? (
          <button
            className="shrink-0 rounded-lg border border-black/20 px-3 py-1.5 text-sm font-medium transition-colors hover:border-black/50 dark:border-white/25 dark:hover:border-white/60"
            onClick={() => downloadMarkdown(page.path.split("/").pop() ?? "page.md", page.content)}
            type="button"
          >
            Download .md
          </button>
        ) : null}
      </div>

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : !signedIn ? (
        <p>
          <Link className="underline" href="/login">
            Sign in
          </Link>{" "}
          to see this page.
        </p>
      ) : error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : !page ? (
        <p className="opacity-70">No page lives at this path in this sum.</p>
      ) : (
        <>
          <article
            className="wiki-content"
            // Safe by construction: renderWikiHtml runs markdown-it with html
            // disabled, so stored content is escaped and only renderer-generated
            // tags reach the DOM.
            dangerouslySetInnerHTML={{ __html: renderWikiHtml(page.content, relationshipId) }}
          />
          <p className="border-t border-black/10 pt-3 text-xs opacity-50 dark:border-white/15">
            Version {page.version} · updated {new Date(page.updated_at).toLocaleString()} · written by this sum's
            agents; edits happen in conversation, not here.
          </p>
        </>
      )}
    </main>
  );
}
