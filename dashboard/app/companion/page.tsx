"use client";

// The Mem·Sum Companion: a slender plain-URL window kept beside whichever AI
// the member is talking to. Instruments, not dialogue — it prepares speech
// (copy chips for @handles, #handles, ready-to-paste +dm prefixes) but never
// delivers it: no send surface exists here, by decision (2026-07-18), and the
// wiki stays read-only because agents own the writing. Works in any browser
// window; deliberately not coupled to any host ecosystem.
//
// Surface doctrine (2026-07-18): the family asks a user to manage exactly two
// standing surfaces — their chat and the Companion. Everything deeper is
// transient, singular, and user-invoked. So wiki pages read in the panel at
// slender width (master-detail), and full size is an explicit escalation into
// ONE named reader window ("memsum-reader") that every escalation reuses —
// the third window never multiplies.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { assignSumHandles } from "@/lib/handles";
import { renderWikiHtml, storedPathCandidates, wikiPageHref, type WikiPageRow } from "@/lib/wiki";
import { supabaseBrowser } from "@/lib/supabase";

interface ParticipantRow {
  id: string;
  display_name: string;
  user_id: string | null;
}

interface MembershipRow {
  relationship_id: string;
  created_at: string;
  relationships: {
    id: string;
    display_name: string;
    participants: ParticipantRow[];
  };
}

interface ContactRow {
  handle: string;
  relationship_id: string;
  display_name: string;
}

interface WikiIndexRow {
  id: string;
  path: string;
  title: string;
  updated_at: string;
}

const LIVE_WINDOW_MS = 3 * 60 * 1000;
const READER_WINDOW = "memsum-reader";

export default function CompanionPage() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<MembershipRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [latestUpdateAt, setLatestUpdateAt] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"sums" | "sum">("sums");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pages, setPages] = useState<WikiIndexRow[] | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [openTarget, setOpenTarget] = useState<string[] | null>(null);
  const [pageRow, setPageRow] = useState<WikiPageRow | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageMissing, setPageMissing] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

  // Launched as an installed standalone app, Chrome opens at a default window
  // size rather than the slender pop-out shape. Snap it to the instrument-
  // panel width — being slender beside a chat is the companion's whole
  // identity. This fires ONLY in the installed app (display-mode: standalone);
  // a browser tab and the header pop-out (already sized by window.open, and
  // reported as display-mode: browser) are left untouched. resizeTo is
  // best-effort — permitted for app windows, quietly ignored where it isn't.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(display-mode: standalone)").matches) return;
    try {
      window.resizeTo(440, 900);
    } catch {
      /* app-window resize refused; leave the window as launched */
    }
  }, []);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: sessionData } = await supabase.auth.getSession();
    setSignedIn(Boolean(sessionData.session));
    setUserId(sessionData.session?.user.id ?? null);
    if (!sessionData.session) {
      setReady(true);
      return;
    }
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const [membershipResult, contactResult, activityResult] = await Promise.all([
      supabase
        .from("relationship_members")
        .select("relationship_id, created_at, relationships!inner(id, display_name, participants(id, display_name, user_id))")
        .eq("user_id", sessionData.session.user.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("contacts")
        .select("handle, relationship_id, display_name")
        .eq("owner_user_id", sessionData.session.user.id)
        .order("handle", { ascending: true }),
      supabase
        .from("updates")
        .select("relationship_id, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200)
    ]);
    if (!membershipResult.error && Array.isArray(membershipResult.data)) {
      setMemberships(membershipResult.data as unknown as MembershipRow[]);
    }
    if (!contactResult.error && Array.isArray(contactResult.data)) {
      setContacts(contactResult.data as ContactRow[]);
    }
    if (!activityResult.error && Array.isArray(activityResult.data)) {
      const latest: Record<string, string> = {};
      for (const row of activityResult.data as Array<{ relationship_id: string; created_at: string }>) {
        if (!latest[row.relationship_id]) latest[row.relationship_id] = row.created_at;
      }
      setLatestUpdateAt(latest);
    }
    setReady(true);
  }, []);

  // Refresh on focus and every 60s while visible — enough for the live strip
  // to track reality without a standing firehose.
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [load]);

  // Deliberately does NOT clear the current list first: background refreshes
  // (focus, 60s tick) swap the rows in place with no loading flash. selectSum
  // clears before calling so switching sums still reads as a fresh load.
  const loadPages = useCallback(async (relationshipId: string) => {
    setPagesError(null);
    const { data, error } = await supabaseBrowser()
      .from("wiki_pages")
      .select("id, path, title, updated_at")
      .eq("relationship_id", relationshipId)
      .order("path", { ascending: true });
    if (error) {
      setPagesError("The wiki index could not be loaded.");
      return;
    }
    const rows = (data as WikiIndexRow[]) ?? [];
    rows.sort((a, b) => (a.path === "wiki/index.md" ? -1 : b.path === "wiki/index.md" ? 1 : a.path.localeCompare(b.path)));
    setPages(rows);
  }, []);

  // The wiki index tracks reality the same way the rest of the panel does:
  // pages appear when agents write them and vanish when a deletion batch
  // removes them. Without this, a deleted page haunts the list until the
  // member re-enters the sum.
  useEffect(() => {
    if (!selectedId) return;
    const refresh = () => void loadPages(selectedId);
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
    };
  }, [selectedId, loadPages]);

  // In-panel page reading (master-detail): openTarget is the page's URL
  // segments; the same candidates logic as the full viewer resolves them to a
  // stored path. Refetches on focus so the panel tracks agent writes.
  const loadPage = useCallback(async () => {
    if (!selectedId || !openTarget) return;
    setPageError(null);
    const { data, error } = await supabaseBrowser()
      .from("wiki_pages")
      .select("id, path, title, content, version, updated_at")
      .eq("relationship_id", selectedId)
      .in("path", storedPathCandidates(openTarget))
      .limit(1);
    if (error) {
      setPageError("This page could not be loaded.");
      return;
    }
    const row = ((data as WikiPageRow[]) ?? [])[0] ?? null;
    setPageRow(row);
    // Loaded-but-absent is a real state, not eternal loading: pages can be
    // deleted (a user-directed batch effect), and the focus refetch lands
    // here when the page someone was reading gets removed.
    setPageMissing(!row);
  }, [selectedId, openTarget]);

  useEffect(() => {
    if (!openTarget) return;
    void loadPage();
    const onFocus = () => void loadPage();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [openTarget, loadPage]);

  function selectSum(relationshipId: string) {
    setSelectedId(relationshipId);
    setTab("sum");
    setOpenTarget(null);
    setPageRow(null);
    setPageMissing(false);
    setPages(null);
    void loadPages(relationshipId);
  }

  function openInPanel(storedPath: string) {
    setPageRow(null);
    setPageMissing(false);
    setOpenTarget(storedPath.replace(/^wiki\//, "").split("/").filter(Boolean));
  }

  function closePanelPage() {
    setOpenTarget(null);
    setPageRow(null);
    setPageError(null);
    setPageMissing(false);
  }

  // Wiki-links inside a rendered page keep the reading in the panel: internal
  // viewer hrefs are intercepted and opened in place; external links keep
  // their new-tab/noopener behavior from the renderer.
  function onArticleClick(event: React.MouseEvent<HTMLElement>) {
    if (!selectedId) return;
    const anchor = (event.target as HTMLElement).closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    const prefix = `/sums/${selectedId}/wiki/`;
    if (!href.startsWith(prefix)) return;
    event.preventDefault();
    setPageRow(null);
    setOpenTarget(href.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent));
  }

  function copy(key: string, text: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedKey(null), 1200);
    });
  }

  const handles = assignSumHandles(memberships.map((m) => m.relationships.display_name));
  const handleByRelationship = new Map(memberships.map((m, index) => [m.relationship_id, handles[index]]));
  const now = Date.now();
  const isLive = (relationshipId: string) => {
    const at = latestUpdateAt[relationshipId];
    return Boolean(at && now - new Date(at).getTime() < LIVE_WINDOW_MS);
  };

  const filtered = memberships.filter((m) => {
    if (!filter.trim()) return true;
    const needle = filter.trim().toLowerCase();
    const handle = handleByRelationship.get(m.relationship_id) ?? "";
    return m.relationships.display_name.toLowerCase().includes(needle) || handle.includes(needle);
  });
  const liveSums = filtered.filter((m) => isLive(m.relationship_id));
  const privateSums = filtered.filter((m) => m.relationships.participants.length === 1);
  const sharedSums = filtered.filter((m) => m.relationships.participants.length > 1);
  const selected = memberships.find((m) => m.relationship_id === selectedId) ?? null;
  const selectedHandle = selectedId ? handleByRelationship.get(selectedId) : undefined;
  const selectedContacts = contacts.filter((contact) => contact.relationship_id === selectedId);

  const chip =
    "inline-flex items-center gap-1 rounded-full border border-black/20 px-3 py-1 text-sm transition-colors hover:border-black/50 dark:border-white/25 dark:hover:border-white/60";

  // A page citation travels fully qualified: [[Title]] #sum-handle. The chip
  // knows which sum it came from, so the paste stays unambiguous even when
  // two sums hold same-titled pages. Sum trails the title deliberately —
  // "delete [[Our Cats]] #dave-lisa" keeps the verb's object unambiguous,
  // where a leading #handle could read as an act against the sum itself.
  const pageCitation = (title: string) => `[[${title}]]${selectedHandle ? ` ${selectedHandle}` : ""} `;

  function sumRow(m: MembershipRow) {
    const handle = handleByRelationship.get(m.relationship_id);
    return (
      <li key={m.relationship_id}>
        <button
          className="flex w-full items-baseline justify-between gap-2 rounded-lg border border-black/10 px-3 py-2 text-left transition-colors hover:border-black/40 dark:border-white/15 dark:hover:border-white/50"
          onClick={() => selectSum(m.relationship_id)}
          type="button"
        >
          <span className="flex items-baseline gap-2 truncate">
            {isLive(m.relationship_id) ? <span aria-label="live" className="inline-block h-2 w-2 shrink-0 rounded-full bg-green-500" /> : null}
            <span className="truncate font-medium">{m.relationships.display_name}</span>
          </span>
          <span className="shrink-0 text-xs opacity-50">{handle}</span>
        </button>
      </li>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-4 px-4 py-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">🥟 Companion</h1>
        <a className="text-xs underline opacity-60" href="/sums" rel="noopener" target="_blank">
          Dashboard ↗
        </a>
      </div>

      {!ready ? (
        <p className="text-sm opacity-60">Loading…</p>
      ) : !signedIn ? (
        <p className="text-sm">
          <Link className="underline" href="/login">
            Sign in
          </Link>{" "}
          to open your instruments.
        </p>
      ) : (
        <>
          <div className="flex gap-1 rounded-lg bg-black/5 p-1 text-sm dark:bg-white/10">
            <button
              className={`flex-1 rounded-md px-3 py-1 font-medium ${tab === "sums" ? "bg-background shadow-sm" : "opacity-60"}`}
              onClick={() => setTab("sums")}
              type="button"
            >
              Sums
            </button>
            <button
              className={`flex-1 rounded-md px-3 py-1 font-medium ${tab === "sum" ? "bg-background shadow-sm" : "opacity-60"} disabled:opacity-30`}
              disabled={!selected}
              onClick={() => selected && setTab("sum")}
              type="button"
            >
              {selected ? selected.relationships.display_name : "Sum"}
            </button>
          </div>

          {tab === "sums" ? (
            <div className="flex flex-col gap-4">
              <input
                className="rounded-lg border border-black/20 bg-transparent px-3 py-2 text-sm dark:border-white/25"
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter sums…"
                value={filter}
              />
              {liveSums.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h2 className="text-xs font-medium uppercase tracking-wide opacity-50">Live now</h2>
                  <ul className="flex flex-col gap-2">{liveSums.map(sumRow)}</ul>
                </section>
              ) : null}
              {privateSums.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h2 className="text-xs font-medium uppercase tracking-wide opacity-50">Private — just you</h2>
                  <ul className="flex flex-col gap-2">{privateSums.map(sumRow)}</ul>
                </section>
              ) : null}
              {sharedSums.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h2 className="text-xs font-medium uppercase tracking-wide opacity-50">Shared</h2>
                  <ul className="flex flex-col gap-2">{sharedSums.map(sumRow)}</ul>
                </section>
              ) : null}
              {memberships.length === 0 ? <p className="text-sm opacity-60">No sums yet — start one from the dashboard.</p> : null}
            </div>
          ) : selected && openTarget ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <button
                  aria-label={`Back to ${selected.relationships.display_name}`}
                  className="rounded-md px-2 py-1 text-sm opacity-70 transition-opacity hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                  onClick={closePanelPage}
                  type="button"
                >
                  ← {selected.relationships.display_name}
                </button>
                {pageRow && selectedId ? (
                  <a
                    className="shrink-0 text-xs underline opacity-60 hover:opacity-100"
                    href={wikiPageHref(selectedId, pageRow.path)}
                    target={READER_WINDOW}
                    title="Open full size — reuses one reader window rather than piling up tabs"
                  >
                    Open full ↗
                  </a>
                ) : null}
              </div>
              {pageError ? <p className="text-sm text-red-700 dark:text-red-400">{pageError}</p> : null}
              {!pageRow && !pageError && pageMissing ? (
                <p className="text-sm opacity-70">
                  This page isn't in the sum anymore — it may have been removed. Ask your agent what happened to it;
                  removals stay on the record.
                </p>
              ) : null}
              {!pageRow && !pageError && !pageMissing ? <p className="text-sm opacity-60">Loading…</p> : null}
              {pageRow ? (
                <>
                  <h2 className="text-base font-semibold tracking-tight">{pageRow.title}</h2>
                  {/* The self-labeling exemplar: the full citation as a real
                      chip, in the one place with room for it. The index rows
                      compress to [[ ]]; seeing this once is what makes that
                      compression legible. */}
                  <div>
                    <button
                      className={chip}
                      onClick={() => copy(`page:${pageRow.path}`, pageCitation(pageRow.title))}
                      title={`Copy ${pageCitation(pageRow.title).trim()} — cites this page in any chat`}
                      type="button"
                    >
                      {copiedKey === `page:${pageRow.path}` ? "Copied" : pageCitation(pageRow.title).trim()}
                    </button>
                  </div>
                  <article
                    className="wiki-content wiki-compact"
                    // Safe by construction: renderWikiHtml runs markdown-it with
                    // html disabled — stored content is escaped, never executed.
                    dangerouslySetInnerHTML={{ __html: renderWikiHtml(pageRow.content, selectedId ?? "") }}
                    onClick={onArticleClick}
                  />
                  <p className="border-t border-black/10 pt-2 text-xs opacity-50 dark:border-white/15">
                    v{pageRow.version} · {new Date(pageRow.updated_at).toLocaleString()}
                  </p>
                </>
              ) : null}
            </div>
          ) : selected ? (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  {selectedHandle ? (
                    <button
                      className={chip}
                      onClick={() => copy("sum-handle", `${selectedHandle} `)}
                      title={`Copy ${selectedHandle} — names this sum in any chat`}
                      type="button"
                    >
                      {copiedKey === "sum-handle" ? "Copied" : selectedHandle}
                    </button>
                  ) : null}
                  {selected.relationships.participants.length === 1 ? (
                    <span className="text-xs opacity-50">Just you</span>
                  ) : null}
                </div>
                {selectedContacts.length > 0 || selected.relationships.participants.some((p) => p.user_id !== userId) ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedContacts.map((contact) => (
                      <button
                        className={chip}
                        key={contact.handle}
                        onClick={() => copy(contact.handle, `+dm ${contact.handle} `)}
                        title={`Copy "+dm ${contact.handle} " — paste into your chat and finish the sentence`}
                        type="button"
                      >
                        {copiedKey === contact.handle ? "Copied" : contact.handle}
                      </button>
                    ))}
                    {selected.relationships.participants
                      .filter((p) => p.user_id !== userId)
                      .filter((p) => !selectedContacts.some((c) => c.display_name === p.display_name))
                      .map((p) => (
                        <button
                          className={chip}
                          key={p.id}
                          onClick={() => copy(p.id, p.display_name)}
                          title={`Copy "${p.display_name}"`}
                          type="button"
                        >
                          {copiedKey === p.id ? "Copied" : p.display_name}
                        </button>
                      ))}
                  </div>
                ) : null}
              </section>

              <section className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-xs font-medium uppercase tracking-wide opacity-50">Wiki</h2>
                  {selectedId ? (
                    <a
                      className="text-xs underline opacity-60"
                      href={`/sums/${selectedId}/wiki`}
                      target={READER_WINDOW}
                      title="Open the full index — reuses one reader window"
                    >
                      Full index ↗
                    </a>
                  ) : null}
                </div>
                {pagesError ? <p className="text-sm text-red-700 dark:text-red-400">{pagesError}</p> : null}
                {pages === null && !pagesError ? <p className="text-sm opacity-60">Loading…</p> : null}
                {pages !== null && pages.length === 0 ? (
                  <p className="text-sm opacity-60">Nothing woven yet — this sum's graph is waiting for its first page.</p>
                ) : null}
                {pages !== null && pages.length > 0 ? (
                  <ul className="flex flex-col">
                    {pages.map((page) => (
                      <li className="flex items-baseline gap-1" key={page.id}>
                        <button
                          className="flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                          onClick={() => openInPanel(page.path)}
                          type="button"
                        >
                          <span className="truncate">{page.title}</span>
                          <span className="shrink-0 text-xs opacity-40">{page.path.replace(/^wiki\//, "").replace(/\.md$/, "")}</span>
                        </button>
                        {/* The third instrument: @ names who, # names where, [[...]]
                            names what. Copies the page citation in the graph's own
                            wiki-link notation — title verbatim, no slug to derive. */}
                        <button
                          className="shrink-0 rounded-full border border-black/20 px-2 py-0.5 font-mono text-xs opacity-70 transition-colors hover:border-black/50 hover:opacity-100 dark:border-white/25 dark:hover:border-white/60"
                          onClick={() => copy(`page:${page.path}`, pageCitation(page.title))}
                          title={`Copy ${pageCitation(page.title).trim()} — cites this page in any chat`}
                          type="button"
                        >
                          {copiedKey === `page:${page.path}` ? "Copied" : "[[ ]]"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <p className="border-t border-black/10 pt-3 text-xs opacity-50 dark:border-white/15">
                Read-only instruments. Your agent does the writing — copy a chip and speak in your own chat. # names the
                sum, @ a member, [[ ]] a page.
              </p>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
