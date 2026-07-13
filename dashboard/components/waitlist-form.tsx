"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase";

// The beta waitlist capture. join_waitlist is the database's one
// anonymous-callable write: it stores a normalized email and a timestamp,
// answers the same way for new and already-listed addresses, and validates
// server-side — so this form stays honest even if the client checks are
// bypassed.

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || state === "sending") return;
    setState("sending");
    setMessage(null);
    const { error } = await supabaseBrowser().rpc("join_waitlist", { p_email: trimmed });
    if (error) {
      setState("error");
      setMessage(error.message);
    } else {
      setState("done");
    }
  }

  if (state === "done") {
    return (
      <p className="rounded-lg bg-accent-gold/25 px-3 py-2 text-sm font-medium">
        You&apos;re on the list — we&apos;ll email {email.trim().toLowerCase()} when a spot opens.
      </p>
    );
  }

  return (
    <form className="flex flex-wrap gap-2" onSubmit={submit}>
      <input
        aria-label="Email address"
        autoComplete="email"
        className="min-w-0 flex-1 rounded-lg border border-black/20 bg-transparent px-3 py-2 outline-none focus:border-accent dark:border-white/25"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        required
        type="email"
        value={email}
      />
      <button
        className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint disabled:opacity-60"
        disabled={state === "sending"}
        type="submit"
      >
        {state === "sending" ? "Joining…" : "Join the waitlist"}
      </button>
      {state === "error" && message ? <p className="w-full text-sm text-accent-deep">{message}</p> : null}
    </form>
  );
}
