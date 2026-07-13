"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase";

// One page, two states. Without a session it requests a recovery email whose
// link points back here; the recovery link signs the visitor in on arrival
// (PKCE exchange happens during page load), so with a session this same page
// is where the new password gets set.

export default function ResetPage() {
  const [ready, setReady] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = supabaseBrowser();
    supabase.auth.getSession().then(({ data }) => {
      setSessionEmail(data.session?.user.email ?? null);
      setReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setSessionEmail(session?.user.email ?? null);
      setReady(true);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: resetError } = await supabaseBrowser().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset`
    });
    setBusy(false);
    // Stay silent about whether the account exists — but a mailer rate limit
    // is not an enumeration signal, and hiding it strands people at an empty
    // inbox. Say it plainly.
    if (resetError && (resetError.status === 429 || /rate limit/i.test(resetError.message))) {
      setError("Our mailer is briefly rate-limited. Nothing went out — wait a few minutes and try again.");
      return;
    }
    setNotice("If that address has a Mem·Sum account, a reset link is on its way. The link brings you back here.");
  }

  async function setNewPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabaseBrowser().auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(
        updateError.message.includes("different from the old")
          ? "That's already your password — pick a new one."
          : "That password could not be set. Use at least 8 characters."
      );
      return;
    }
    setPassword("");
    setDone(true);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : done ? (
        <div className="flex flex-col gap-4">
          <p>Your password is set.</p>
          <Link
            className="w-fit rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85"
            href="/sums"
          >
            Your sums
          </Link>
        </div>
      ) : sessionEmail ? (
        <form className="flex flex-col gap-4" onSubmit={setNewPassword}>
          <p className="text-sm opacity-70">
            Setting a new password for <span className="font-medium">{sessionEmail}</span>.
          </p>
          {error ? (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
          ) : null}
          <label className="flex flex-col gap-2 text-sm font-medium">
            New password
            <input
              autoComplete="new-password"
              className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
              minLength={8}
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
            {busy ? "Saving…" : "Set new password"}
          </button>
        </form>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={requestReset}>
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
          <button
            className="rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
            disabled={busy}
            type="submit"
          >
            {busy ? "Sending…" : "Email me a reset link"}
          </button>
          <p className="text-sm opacity-60">
            Remembered it after all?{" "}
            <Link className="underline" href="/login">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </main>
  );
}
