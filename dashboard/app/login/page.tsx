"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase";

export default function LoginPage() {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabaseBrowser()
      .auth.getSession()
      .then(({ data }) => setSessionEmail(data.session?.user.email ?? null));
  }, []);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) {
      setError("Sign-in failed. Check your email and password.");
      return;
    }
    const { data } = await supabaseBrowser().auth.getSession();
    setSessionEmail(data.session?.user.email ?? null);
    setPassword("");
  }

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    setSessionEmail(null);
  }

  // Invite-only stays intact: the link signs in existing accounts and never
  // creates one.
  async function emailMagicLink() {
    if (!email.trim()) {
      setError("Enter your email first, then ask for the link.");
      return;
    }
    setBusy(true);
    setError(null);
    await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/sums`, shouldCreateUser: false }
    });
    setBusy(false);
    setNotice("If that address has a Mem·Sum account, a sign-in link is on its way.");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to Mem·Sum</h1>

      {sessionEmail ? (
        <div className="flex flex-col gap-4">
          <p>
            Signed in as <span className="font-medium">{sessionEmail}</span>.
          </p>
          <div className="flex gap-3">
            <Link
              className="rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85"
              href="/sums"
            >
              Your sums
            </Link>
            <Link
              className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25"
              href="/connect"
            >
              Connect your AI
            </Link>
            <button
              className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25"
              onClick={signOut}
              type="button"
            >
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={signIn}>
          {notice ? <p className="rounded-lg bg-accent-tint px-3 py-2 text-sm">{notice}</p> : null}
          {error ? (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
          ) : null}
          <label className="flex flex-col gap-2 text-sm font-medium">
            Email
            <input
              autoComplete="email"
              className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium">
            Password
            <input
              autoComplete="current-password"
              className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <button
            className="rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
            disabled={busy}
            type="submit"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="text-sm opacity-70">
            <Link className="underline" href="/reset">
              Forgot your password?
            </Link>{" "}
            ·{" "}
            <button className="underline disabled:opacity-50" disabled={busy} onClick={emailMagicLink} type="button">
              Email me a sign-in link instead
            </button>
          </p>
          <p className="text-sm opacity-60">
            No account yet? Accounts are created through invitations during the beta — open the invite link you
            were sent.
          </p>
        </form>
      )}
    </main>
  );
}
