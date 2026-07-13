"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase";

interface ParticipantRow {
  id: string;
  display_name: string;
  user_id: string | null;
}

interface RelationshipRow {
  id: string;
  display_name: string;
  created_at: string;
  participants: ParticipantRow[];
}

export default function SumsPage() {
  const [ready, setReady] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<RelationshipRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [relationshipName, setRelationshipName] = useState("");
  const [selfName, setSelfName] = useState("");
  const [peerName, setPeerName] = useState("");
  const [handle, setHandle] = useState("");
  const [starterName, setStarterName] = useState("");
  const [starterBusy, setStarterBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: sessionData } = await supabase.auth.getSession();
    setSessionEmail(sessionData.session?.user.email ?? null);
    setUserId(sessionData.session?.user.id ?? null);
    if (!sessionData.session) {
      setReady(true);
      return;
    }
    const { data, error: queryError } = await supabase
      .from("relationships")
      .select("id, display_name, created_at, participants(id, display_name, user_id)")
      .order("created_at", { ascending: true });
    if (queryError) {
      setError("Your sums could not be loaded. Try again in a moment.");
    } else {
      const rows = (data as RelationshipRow[]) ?? [];
      setRelationships(rows);
      const myId = sessionData.session.user.id;
      const knownName = rows.flatMap((row) => row.participants).find((p) => p.user_id === myId)?.display_name;
      if (knownName) setStarterName((current) => current || knownName);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A sum with only you in it is private — the peer fields are optional, and
  // leaving both blank creates one. Giving one without the other is the only
  // invalid shape.
  async function createSum(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const peer = peerName.trim();
    const rawHandle = handle.trim();
    if ((peer && !rawHandle) || (rawHandle && !peer)) {
      setError("Give both their name and a handle — or leave both blank for a private sum.");
      return;
    }
    setBusy(true);
    const normalizedHandle = rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`;
    const { data, error: rpcError } = await supabaseBrowser().rpc("create_relationship_context", {
      payload: {
        relationshipDisplayName: relationshipName.trim(),
        selfDisplayName: selfName.trim(),
        ...(peer
          ? {
              peerDisplayName: peer,
              contactHandle: normalizedHandle.toLowerCase(),
              contactDisplayName: peer
            }
          : {})
      }
    });
    setBusy(false);
    const result = data as { relationshipId?: string } | null;
    if (rpcError || !result?.relationshipId) {
      setError(rpcError?.message ?? "The sum could not be created.");
      return;
    }
    setCreating(false);
    setRelationshipName("");
    setSelfName("");
    setPeerName("");
    setHandle("");
    await load();
  }

  async function startPrivateSum(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setStarterBusy(true);
    const { data, error: rpcError } = await supabaseBrowser().rpc("create_relationship_context", {
      payload: { relationshipDisplayName: "Private", selfDisplayName: starterName.trim() }
    });
    setStarterBusy(false);
    const result = data as { relationshipId?: string } | null;
    if (rpcError || !result?.relationshipId) {
      setError(rpcError?.message ?? "The sum could not be created.");
      return;
    }
    await load();
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Your sums</h1>
        <Link className="text-sm underline opacity-70" href="/">
          Mem·Sum
        </Link>
      </div>

      {error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : null}

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : !sessionEmail ? (
        <p>
          <Link className="underline" href="/login">
            Sign in
          </Link>{" "}
          to see your sums.
        </p>
      ) : (
        <>
          {relationships.length === 0 ? (
            <p className="opacity-70">
              No sums yet. A sum is useful from the first minute — private for just you, or shared with the
              people an endeavor belongs to.
            </p>
          ) : (
            (() => {
              const privateSums = relationships.filter((r) => r.participants.length === 1);
              const sharedSums = relationships.filter((r) => r.participants.length > 1);
              const renderList = (rows: RelationshipRow[]) => (
                <ul className="flex flex-col gap-3">
                  {rows.map((relationship) => (
                    <li key={relationship.id}>
                      <Link
                        className="flex items-baseline justify-between gap-4 rounded-xl border border-black/15 px-4 py-3 transition-colors hover:border-black/40 dark:border-white/20 dark:hover:border-white/50"
                        href={`/sums/${relationship.id}`}
                      >
                        <span className="font-medium">{relationship.display_name}</span>
                        <span className="text-sm opacity-60">
                          {relationship.participants.length === 1
                            ? "Just you"
                            : `${relationship.participants.length} people`}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              );
              return (
                <div className="flex flex-col gap-6">
                  {privateSums.length > 0 ? (
                    <section className="flex flex-col gap-3">
                      <h2 className="text-sm font-medium uppercase tracking-wide opacity-50">Private — just you</h2>
                      {renderList(privateSums)}
                    </section>
                  ) : null}
                  {sharedSums.length > 0 ? (
                    <section className="flex flex-col gap-3">
                      {privateSums.length > 0 ? (
                        <h2 className="text-sm font-medium uppercase tracking-wide opacity-50">Shared</h2>
                      ) : null}
                      {renderList(sharedSums)}
                    </section>
                  ) : null}
                </div>
              );
            })()
          )}

          {relationships.every((r) => r.participants.length > 1) ? (
            <form
              className="flex flex-col gap-3 rounded-xl bg-accent-tint p-5"
              onSubmit={startPrivateSum}
            >
              <h2 className="font-semibold">Start your private sum</h2>
              <p className="text-sm opacity-80">
                Just you. A place your assistant keeps your own standing memory — house details, plans,
                anything worth not losing — private until the day you choose to share any of it.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Your name
                  <input
                    className="rounded-lg border border-black/20 bg-transparent px-3 py-2 font-normal dark:border-white/25"
                    onChange={(event) => setStarterName(event.target.value)}
                    required
                    value={starterName}
                  />
                </label>
                <button
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint disabled:opacity-60"
                  disabled={starterBusy}
                  type="submit"
                >
                  {starterBusy ? "Starting…" : "Start my private sum"}
                </button>
              </div>
            </form>
          ) : null}

          {creating ? (
            <form className="flex flex-col gap-4 rounded-xl border border-black/15 p-4 dark:border-white/20" onSubmit={createSum}>
              <h2 className="font-semibold">New sum</h2>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Sum name
                <input
                  className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                  onChange={(event) => setRelationshipName(event.target.value)}
                  placeholder="Dave-Mom"
                  required
                  value={relationshipName}
                />
              </label>
              <div className="flex flex-col gap-4 sm:flex-row">
                <label className="flex flex-1 flex-col gap-2 text-sm font-medium">
                  Your name
                  <input
                    className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                    onChange={(event) => setSelfName(event.target.value)}
                    required
                    value={selfName}
                  />
                </label>
                <label className="flex flex-1 flex-col gap-2 text-sm font-medium">
                  Their name (optional)
                  <input
                    className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                    onChange={(event) => setPeerName(event.target.value)}
                    value={peerName}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Contact handle (optional)
                <input
                  className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                  onChange={(event) => setHandle(event.target.value)}
                  pattern="@?[a-z0-9][a-z0-9_-]{0,63}"
                  placeholder="@mom"
                  title="Lowercase letters, numbers, hyphens, underscores"
                  value={handle}
                />
              </label>
              <p className="text-sm opacity-60">
                Leave both blank to make this sum private — just you. You can always invite people later.
              </p>
              <div className="flex gap-3">
                <button
                  className="rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? "Creating…" : "Create sum"}
                </button>
                <button
                  className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25"
                  onClick={() => setCreating(false)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              className="self-start rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85"
              onClick={() => setCreating(true)}
              type="button"
            >
              New sum
            </button>
          )}
        </>
      )}
    </main>
  );
}
