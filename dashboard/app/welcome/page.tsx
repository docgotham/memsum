"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { DumplingMark } from "@/components/brand";
import { supabaseBrowser } from "@/lib/supabase";

// Where a beta invite lands. Hand-delivered invite links point here as
// /welcome?invite=<token_hash> — inert until the person presses Accept,
// which verifies the one-time token client-side. (The raw GoTrue verify URL
// gets consumed by omnibox prefetchers and email link scanners before the
// human ever clicks; observed live 2026-07-11.) Email invites still sign the
// visitor in on arrival, so with a session this page welcomes them and sets
// their first password; without one, the link has been used or expired, and
// the honest paths are sign-in or a reset email.

export default function WelcomePage() {
  const [ready, setReady] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get("invite");
    if (invite) setInviteToken(invite);
    // GoTrue reports a consumed or expired link in the URL fragment; say it
    // plainly instead of the generic no-session copy.
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (fragment.get("error_code") === "otp_expired") {
      setError("That invite link was already used or has expired — ask for a fresh one.");
    }
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

  async function acceptInvite() {
    if (!inviteToken) return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabaseBrowser().auth.verifyOtp({
      type: "invite",
      token_hash: inviteToken
    });
    setBusy(false);
    if (verifyError) {
      setError("That invite link was already used or has expired — ask for a fresh one.");
      setInviteToken(null);
      return;
    }
    setInviteToken(null);
  }

  async function setFirstPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabaseBrowser().auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError("That password could not be set. Use at least 8 characters.");
      return;
    }
    setPassword("");
    setDone(true);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-center gap-3">
        <DumplingMark size={32} />
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to the beta</h1>
      </div>

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : !sessionEmail && inviteToken ? (
        <div className="flex flex-col gap-4">
          <p className="opacity-80">
            Your spot in the beta is ready. One click claims it — the link works once, so it waits for you
            here until you press the button.
          </p>
          {error ? (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
          ) : null}
          <button
            className="w-fit rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint disabled:opacity-60"
            disabled={busy}
            onClick={() => void acceptInvite()}
            type="button"
          >
            {busy ? "Accepting…" : "Accept invite"}
          </button>
        </div>
      ) : done ? (
        <div className="flex flex-col gap-4">
          <p>
            You&apos;re in. A sum is one shared workspace for one endeavor — start one, invite the people it
            belongs to, and connect the AI assistant or chatbot you already use.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint"
              href="/sums"
            >
              Start your first sum
            </Link>
            <Link className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25" href="/connect">
              Connect your AI
            </Link>
          </div>
        </div>
      ) : sessionEmail ? (
        <form className="flex flex-col gap-4" onSubmit={setFirstPassword}>
          <p className="text-sm opacity-70">
            Your spot is open, <span className="font-medium">{sessionEmail}</span>. Choose a password and
            you&apos;re set.
          </p>
          {error ? (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
          ) : null}
          <label className="flex flex-col gap-2 text-sm font-medium">
            Password
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
            className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            {busy ? "Saving…" : "Set password and enter"}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="opacity-80">
            This invite link has already been used, or it expired. If you set a password, sign in — and if you
            never got that far, a reset email opens the door again.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint"
              href="/login"
            >
              Sign in
            </Link>
            <Link className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25" href="/reset">
              Reset password
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
