"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase";

export default function AccountPage() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingSums, setBlockingSums] = useState<string[] | null>(null);
  const [limits, setLimits] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    supabase.auth.getSession().then(async ({ data }) => {
      setEmail(data.session?.user.email ?? null);
      setReady(true);
      if (data.session) {
        const { data: limitsData } = await supabase.rpc("pilot_limits");
        if (limitsData && typeof limitsData === "object") setLimits(limitsData as Record<string, number>);
      }
    });
  }, []);

  async function deleteAccount(event: FormEvent) {
    event.preventDefault();
    if (!email || confirmInput.trim().toLowerCase() !== email.toLowerCase()) return;
    setBusy(true);
    setError(null);
    setBlockingSums(null);

    const supabase = supabaseBrowser();
    const { data } = await supabase.rpc("delete_account");
    const result = data as { ok?: boolean; reason?: string; sums?: string[] } | null;

    if (result?.ok === true) {
      await supabase.auth.signOut({ scope: "local" });
      window.location.href = "/";
      return;
    }
    setBusy(false);
    if (result?.reason === "owns_shared_sums") {
      setBlockingSums(result.sums ?? []);
      return;
    }
    setError("Your account could not be deleted. Try again, or contact us.");
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        <Link className="text-sm underline opacity-70" href="/">
          ← Back to Mem·Sum
        </Link>
      </div>

      {!ready ? (
        <p className="opacity-60">Loading…</p>
      ) : !email ? (
        <p>
          <Link className="underline" href="/login">
            Sign in
          </Link>{" "}
          to manage your account.
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Signed in as</h2>
            <p>{email}</p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Policies</h2>
            <p className="text-sm opacity-80">
              <Link className="underline" href="/terms">
                Terms of Service
              </Link>{" "}
              ·{" "}
              <Link className="underline" href="/privacy">
                Privacy Policy
              </Link>
            </p>
          </section>

          {limits ? (
            <section className="flex flex-col gap-2">
              <h2 className="font-semibold">Free beta limits</h2>
              <ul className="list-disc pl-5 text-sm opacity-80">
                <li>Up to {limits.sumsCreatedPerAccount} sums created per account.</li>
                <li>
                  Per sum, per day: {limits.updatesPerSumPerDay} updates, {limits.interactionsPerSumPerDay} messages,{" "}
                  {limits.remindersPerSumPerDay} reminders.
                </li>
                <li>
                  Up to {limits.pagesPerSum} pages per sum, {Math.round(limits.pageContentMaxBytes / 1024)} KB per page.
                </li>
              </ul>
            </section>
          ) : null}

          <section className="flex flex-col gap-3 rounded-xl border border-red-600/40 p-4">
            <h2 className="font-semibold text-red-700 dark:text-red-400">Delete your account</h2>
            <p className="text-sm opacity-80">
              Deleting your account signs you out everywhere, revokes your connector tokens and invitations,
              removes your phone number, and deletes any sum where you are the only member who has joined. In
              sums you shared with others, your access ends and your seat becomes re-invitable — but what you
              contributed stays part of the shared record, under the remaining members&apos; stewardship. This
              cannot be undone.
            </p>
            <p className="text-sm opacity-80">
              If you own a sum that someone else has joined, ask them to leave first — an owned sum with active
              members can&apos;t be deleted out from under them.
            </p>

            {blockingSums ? (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
                You still own {blockingSums.length === 1 ? "a sum" : "sums"} with other joined members:{" "}
                {blockingSums.join(", ")}. The other members must leave before your account can be deleted.
              </p>
            ) : null}
            {error ? (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>
            ) : null}

            <form className="flex flex-wrap items-end gap-3" onSubmit={deleteAccount}>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Type your email to confirm
                <input
                  autoComplete="off"
                  className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                  onChange={(event) => setConfirmInput(event.target.value)}
                  placeholder={email}
                  value={confirmInput}
                />
              </label>
              <button
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-50"
                disabled={busy || confirmInput.trim().toLowerCase() !== email.toLowerCase()}
                type="submit"
              >
                {busy ? "Deleting…" : "Delete my account"}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
