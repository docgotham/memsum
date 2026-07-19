"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase";

interface GrantRow {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scope: string;
  authorizedAt: string;
  lastUsedAt: string | null;
  activeTokens: number;
}

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// A dynamically registered client names itself, so the name alone is not
// proof of anything. The sign-in addresses it registered are the reliable
// part — that is what we anchor the row on.
function redirectHosts(uris: string[]): string[] {
  const hosts = new Set<string>();
  for (const uri of uris) {
    try {
      const url = new URL(uri);
      hosts.add(url.protocol === "https:" || url.protocol === "http:" ? url.host : "external application");
    } catch {
      hosts.add("external application");
    }
  }
  return [...hosts];
}

export function OAuthGrants() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armedClientId, setArmedClientId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: sessionData } = await supabase.auth.getSession();
    setSignedIn(Boolean(sessionData.session));
    if (!sessionData.session) {
      setReady(true);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc("list_oauth_grants");
    if (rpcError || !Array.isArray(data)) {
      setError("Your connected apps could not be loaded.");
    } else {
      setGrants(data as GrantRow[]);
      setError(null);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(clientId: string) {
    if (busy) return;
    if (armedClientId !== clientId) {
      setArmedClientId(clientId);
      setTimeout(() => setArmedClientId((current) => (current === clientId ? null : current)), 3000);
      return;
    }
    setArmedClientId(null);
    setBusy(true);
    setError(null);
    setStatus(null);
    const { data, error: rpcError } = await supabaseBrowser().rpc("revoke_oauth_client_grants", {
      target_client_id: clientId
    });
    setBusy(false);
    const result = data as { revoked?: boolean } | null;
    if (rpcError) {
      setError("The connected app could not be revoked.");
      return;
    }
    if (result?.revoked !== true) {
      setError("That connected app is not available.");
      await load();
      return;
    }
    setStatus("Revoked. Reconnect from your chatbot to approve access again.");
    await load();
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">Chatbot clients (OAuth)</h2>
      <p className="text-sm opacity-80">
        These clients signed in with your Mem·Sum account and hold OAuth access — they can read and
        write every sum you belong to. Revoking one signs it out immediately; it has to ask for your
        consent again before it can reconnect.
      </p>

      {error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : null}
      {status ? (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400" role="status">
          {status}
        </p>
      ) : null}

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : !signedIn ? (
        <p>
          <Link className="underline" href="/login">
            Sign in
          </Link>{" "}
          to review which apps can act as you.
        </p>
      ) : grants.length === 0 ? (
        <p className="text-sm opacity-60">
          No chatbot client holds OAuth access right now. Connect one from the{" "}
          <Link className="underline" href="/connect">
            setup guides
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {grants.map((grant) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20"
              key={grant.clientId}
            >
              <span className="flex flex-col">
                <span className="font-medium">{grant.clientName}</span>
                <span className="text-sm opacity-60">Signs in via {redirectHosts(grant.redirectUris).join(", ")}</span>
                <span className="text-sm opacity-60">
                  Authorized {shortDate(grant.authorizedAt)}
                  {grant.lastUsedAt ? ` · last used ${shortDate(grant.lastUsedAt)}` : " · not used yet"}
                </span>
              </span>
              <button
                className="rounded-lg border border-black/20 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-white/25"
                disabled={busy}
                onClick={() => void revoke(grant.clientId)}
                type="button"
              >
                {armedClientId === grant.clientId ? "Really revoke?" : "Revoke access"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
