"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createConnectorToken } from "@/lib/tokens";
import { sha256Hex, supabaseBrowser } from "@/lib/supabase";

interface TokenRow {
  tokenId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ConnectorTokens() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freshToken, setFreshToken] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: sessionData } = await supabase.auth.getSession();
    setSignedIn(Boolean(sessionData.session));
    if (!sessionData.session) {
      setReady(true);
      return;
    }
    const { data, error: rpcError } = await supabase.rpc("list_connector_tokens");
    if (rpcError || !Array.isArray(data)) {
      setError("Your connector tokens could not be loaded.");
    } else {
      setTokens(data as TokenRow[]);
      setError(null);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function issueToken(event: FormEvent) {
    event.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    setFreshToken(null);
    setCopied(false);

    const token = createConnectorToken();
    const { error: rpcError } = await supabaseBrowser().rpc("issue_connector_token", {
      payload: { name, tokenHash: await sha256Hex(token) }
    });
    setBusy(false);

    if (rpcError) {
      setError("The token could not be created.");
      return;
    }
    setFreshToken({ token, name });
    setNameInput("");
    await load();
  }

  async function revoke(tokenId: string) {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabaseBrowser().rpc("revoke_connector_token", {
      target_token_id: tokenId
    });
    setBusy(false);
    const result = data as { revoked?: boolean } | null;
    if (rpcError || result?.revoked !== true) {
      setError("The token could not be revoked.");
      return;
    }
    await load();
  }

  async function copyToken() {
    if (!freshToken) return;
    await navigator.clipboard.writeText(freshToken.token);
    setCopied(true);
  }

  const active = tokens.filter((token) => !token.revokedAt);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">Connector tokens</h2>
      <p className="text-sm opacity-80">
        A connector token is a paste-in key for clients that can&apos;t sign in with OAuth: paste it in the token
        field when connecting, or send it as an <code>Authorization: Bearer</code> header. Treat it like a
        password — it can read and write every sum you belong to. Revoking it cuts that client off immediately.
      </p>

      {error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : null}

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : !signedIn ? (
        <p>
          <Link className="underline" href="/login">
            Sign in
          </Link>{" "}
          to manage your connector tokens.
        </p>
      ) : (
        <>
          {freshToken ? (
            <div className="flex flex-col gap-3 rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-4">
              <p className="font-medium">Token “{freshToken.name}” — shown once, copy it now:</p>
              <code className="overflow-x-auto rounded-lg border border-black/15 bg-background px-3 py-2 text-sm dark:border-white/20">
                {freshToken.token}
              </code>
              <div className="flex gap-3">
                <button
                  className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85"
                  onClick={copyToken}
                  type="button"
                >
                  {copied ? "Copied ✓" : "Copy token"}
                </button>
              </div>
            </div>
          ) : null}

          {active.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {active.map((token) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20"
                  key={token.tokenId}
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{token.name}</span>
                    <span className="text-sm opacity-60">
                      Created {shortDate(token.createdAt)}
                      {token.lastUsedAt ? ` · last used ${shortDate(token.lastUsedAt)}` : " · never used"}
                    </span>
                  </span>
                  <button
                    className="rounded-lg border border-black/20 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-white/25"
                    disabled={busy}
                    onClick={() => void revoke(token.tokenId)}
                    type="button"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm opacity-60">You have no active connector tokens.</p>
          )}

          <form className="flex flex-wrap items-end gap-3" onSubmit={issueToken}>
            <label className="flex flex-col gap-2 text-sm font-medium">
              New token
              <input
                className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                onChange={(event) => setNameInput(event.target.value)}
                placeholder="What will use it, e.g. Claude Code"
                value={nameInput}
              />
            </label>
            <button
              className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
              disabled={busy || !nameInput.trim()}
              type="submit"
            >
              {busy ? "Working…" : "Create token"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
