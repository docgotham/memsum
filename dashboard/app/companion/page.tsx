"use client";

// The Mem·Sum Companion: a slender plain-URL window kept beside whichever AI
// the member is talking to. Instruments, not dialogue — it prepares speech
// (copy chips for @handles, #handles, ready-to-paste +dm prefixes) but never
// delivers it: no send surface exists here, by decision (2026-07-18), and the
// wiki stays read-only because agents own the writing. Works in any browser
// window; deliberately not coupled to any host ecosystem.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { assignSumHandles } from "@/lib/handles";
import { wikiPageHref } from "@/lib/wiki";
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

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

  const loadPages = useCallback(async (relationshipId: string) => {
    setPages(null);
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

  function selectSum(relationshipId: string) {
    setSelectedId(relationshipId);
    setTab("sum");
    void loadPages(relationshipId);
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
                    <a className="text-xs underline opacity-60" href={`/sums/${selectedId}/wiki`} rel="noopener" target="_blank">
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
                      <li key={page.id}>
                        <a
                          className="flex items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                          href={selectedId ? wikiPageHref(selectedId, page.path) : "#"}
                          rel="noopener"
                          target="_blank"
                        >
                          <span className="truncate">{page.title}</span>
                          <span className="shrink-0 text-xs opacity-40">{page.path.replace(/^wiki\//, "").replace(/\.md$/, "")}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <p className="border-t border-black/10 pt-3 text-xs opacity-50 dark:border-white/15">
                Read-only instruments. Your agent does the writing — copy a chip and speak in your own chat.
              </p>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
