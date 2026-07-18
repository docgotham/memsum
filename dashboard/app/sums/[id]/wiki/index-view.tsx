"use client";

// Read-only index of a sum's wiki graph. Agents write the graph; members see
// it. Grouping follows the agent-facing ontology (topics, entities, concepts,
// synthesis) without exposing it as jargon — the section labels speak plainly.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase";
import { wikiPageHref, type WikiPageRow } from "@/lib/wiki";

type IndexRow = Pick<WikiPageRow, "id" | "path" | "title" | "updated_at">;

const SECTIONS: Array<{ prefix: string; label: string }> = [
  { prefix: "wiki/topics/", label: "Plans and projects" },
  { prefix: "wiki/entities/", label: "People, places, things" },
  { prefix: "wiki/concepts/", label: "Preferences and principles" },
  { prefix: "wiki/synthesis/", label: "Summaries" }
];

export function WikiIndex({ relationshipId }: { relationshipId: string }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [sumName, setSumName] = useState<string | null>(null);
  const [pages, setPages] = useState<IndexRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: sessionData } = await supabase.auth.getSession();
    setSignedIn(Boolean(sessionData.session));
    if (!sessionData.session) {
      setReady(true);
      return;
    }
    const [relationshipResult, pagesResult] = await Promise.all([
      supabase.from("relationships").select("display_name").eq("id", relationshipId).maybeSingle(),
      supabase
        .from("wiki_pages")
        .select("id, path, title, updated_at")
        .eq("relationship_id", relationshipId)
        .order("path", { ascending: true })
    ]);
    if (relationshipResult.data) setSumName((relationshipResult.data as { display_name: string }).display_name);
    if (pagesResult.error) {
      setError("The wiki could not be loaded.");
    } else {
      setPages((pagesResult.data as IndexRow[]) ?? []);
    }
    setReady(true);
  }, [relationshipId]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const indexPage = pages.find((page) => page.path === "wiki/index.md");
  const sectioned = SECTIONS.map((section) => ({
    ...section,
    rows: pages.filter((page) => page.path.startsWith(section.prefix))
  }));
  const claimed = new Set([
    ...(indexPage ? [indexPage.id] : []),
    ...sectioned.flatMap((section) => section.rows.map((row) => row.id))
  ]);
  const other = pages.filter((page) => !claimed.has(page.id));

  const renderRows = (rows: IndexRow[]) => (
    <ul className="flex flex-col gap-1">
      {rows.map((page) => (
        <li key={page.id}>
          <Link
            className="flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            href={wikiPageHref(relationshipId, page.path)}
          >
            <span className="font-medium">{page.title}</span>
            <span className="shrink-0 text-xs opacity-40">
              {new Date(page.updated_at).toLocaleDateString()}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{sumName ? `${sumName} — wiki` : "Wiki"}</h1>
        <Link className="text-sm underline opacity-70" href={`/sums/${relationshipId}`}>
          Back to the sum
        </Link>
      </div>

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : !signedIn ? (
        <p>
          <Link className="underline" href="/login">
            Sign in
          </Link>{" "}
          to see this sum.
        </p>
      ) : error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : pages.length === 0 ? (
        <p className="opacity-70">Nothing woven yet. Pages appear here as your agents integrate what you save.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {indexPage ? renderRows([indexPage]) : null}
          {sectioned.map((section) =>
            section.rows.length > 0 ? (
              <section className="flex flex-col gap-2" key={section.prefix}>
                <h2 className="text-sm font-medium uppercase tracking-wide opacity-50">{section.label}</h2>
                {renderRows(section.rows)}
              </section>
            ) : null
          )}
          {other.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wide opacity-50">More</h2>
              {renderRows(other)}
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
