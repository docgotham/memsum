"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { sha256Hex, supabaseBrowser } from "@/lib/supabase";

type ClaimSuccess = {
  relationshipDisplayName: string | null;
  participantDisplayName: string;
  alreadyClaimed: boolean;
};

const CLAIM_ERRORS: Record<string, string> = {
  invalid_token: "This invitation link isn't valid. Ask for a fresh link.",
  not_found: "This invitation link isn't valid. Ask for a fresh link.",
  expired: "This invitation has expired. Ask the person who invited you for a fresh link.",
  not_pending: "This invitation is no longer active. Ask the person who invited you for a fresh link.",
  no_participant: "This invitation link isn't valid. Ask for a fresh link.",
  participant_already_claimed: "This invitation was already used by a different account.",
  already_a_member: "You're already a member of this sum — connect your AI and start using it."
};

export function Claim({ token }: { token: string }) {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState<ClaimSuccess | null>(null);

  useEffect(() => {
    supabaseBrowser()
      .auth.getSession()
      .then(({ data }) => {
        setSessionEmail(data.session?.user.email ?? null);
        setReady(true);
      });
  }, []);

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const supabase = supabaseBrowser();
    if (mode === "signup") {
      // The confirmation email's link brings the new member straight back to
      // this invite, signed in and one click from claiming their seat.
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.href }
      });
      setBusy(false);
      if (signUpError) {
        setError(signUpError.message);
        return;
      }
      if (!data.session) {
        setNotice("Almost there — confirm your email from the message we just sent, then return to this invite link.");
        return;
      }
      setSessionEmail(data.session.user.email ?? email);
      setPassword("");
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) {
      setError("Sign-in failed. Check your email and password.");
      return;
    }
    const { data } = await supabase.auth.getSession();
    setSessionEmail(data.session?.user.email ?? null);
    setPassword("");
  }

  async function acceptInvitation() {
    setBusy(true);
    setError(null);
    const tokenHash = await sha256Hex(token.trim());
    const { data, error: rpcError } = await supabaseBrowser().rpc("claim_invitation", { p_token_hash: tokenHash });
    setBusy(false);

    if (rpcError) {
      setError("Something went wrong accepting this invitation. Try again in a moment.");
      return;
    }
    const result = data as {
      ok?: boolean;
      reason?: string;
      relationshipDisplayName?: string | null;
      participantDisplayName?: string;
      alreadyClaimed?: boolean;
    } | null;

    if (result?.ok === true) {
      setClaimed({
        relationshipDisplayName: result.relationshipDisplayName ?? null,
        participantDisplayName: result.participantDisplayName ?? "you",
        alreadyClaimed: result.alreadyClaimed === true
      });
      return;
    }
    setError(CLAIM_ERRORS[result?.reason ?? ""] ?? "This invitation could not be accepted.");
  }

  async function useDifferentAccount() {
    await supabaseBrowser().auth.signOut();
    setSessionEmail(null);
    setClaimed(null);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">You&apos;ve been invited to a sum</h1>
      <p className="opacity-80">
        A sum is shared memory for a relationship — each of you uses your own AI, and Mem·Sum keeps what you
        both choose to share.
      </p>

      {error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : null}
      {notice ? <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">{notice}</p> : null}

      {claimed ? (
        <div className="flex flex-col gap-4">
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2">
            {claimed.alreadyClaimed ? "You had already joined" : "You've joined"}
            {claimed.relationshipDisplayName ? (
              <>
                {" "}
                <span className="font-semibold">{claimed.relationshipDisplayName}</span>
              </>
            ) : null}{" "}
            as <span className="font-semibold">{claimed.participantDisplayName}</span>.
          </p>
          <p className="opacity-80">One step left: connect the AI you already use, and ask it what&apos;s in your sum.</p>
          <Link
            className="self-start rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85"
            href="/connect"
          >
            Connect your AI
          </Link>
        </div>
      ) : !ready ? (
        <p className="opacity-60">Loading…</p>
      ) : sessionEmail ? (
        <div className="flex flex-col gap-4">
          <p>
            Accept this invitation as <span className="font-medium">{sessionEmail}</span>?
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className="rounded-lg bg-foreground px-4 py-2 font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
              disabled={busy}
              onClick={acceptInvitation}
              type="button"
            >
              {busy ? "Accepting…" : "Accept invitation"}
            </button>
            <button
              className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25"
              onClick={useDifferentAccount}
              type="button"
            >
              Use a different account
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex gap-2 text-sm font-medium">
            <button
              className={`rounded-full px-3 py-1 ${mode === "signup" ? "bg-foreground text-background" : "border border-black/20 dark:border-white/25"}`}
              onClick={() => setMode("signup")}
              type="button"
            >
              Create account
            </button>
            <button
              className={`rounded-full px-3 py-1 ${mode === "signin" ? "bg-foreground text-background" : "border border-black/20 dark:border-white/25"}`}
              onClick={() => setMode("signin")}
              type="button"
            >
              I have an account
            </button>
          </div>
          <form className="flex flex-col gap-4" onSubmit={authenticate}>
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
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
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
              {busy ? "One moment…" : mode === "signup" ? "Create account and continue" : "Sign in and continue"}
            </button>
            {mode === "signup" ? (
              <p className="text-sm opacity-60">
                By creating an account you agree to the{" "}
                <Link className="underline" href="/terms">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link className="underline" href="/privacy">
                  Privacy Policy
                </Link>
                .
              </p>
            ) : null}
          </form>
        </div>
      )}
    </main>
  );
}
