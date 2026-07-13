"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MCP_URL, supabaseBrowser } from "@/lib/supabase";

// Operator-only, metadata-only. The admin_overview RPC refuses everyone not
// in the operators table, and by construction returns aggregates and account
// metadata — never sum content. If it errors, this page is simply not yours.

interface Overview {
  totals: {
    accounts: number;
    sums: number;
    pendingInvitations: number;
    waitlist: number;
    updates7d: number;
    interactions7d: number;
    smsSent7d: number;
    activeAccounts7d: number;
  };
  accounts: Array<{
    email: string;
    createdAt: string;
    lastSignInAt: string | null;
    sumsOwned: number;
    sumsMemberOf: number;
  }>;
  invitations: Array<{
    sum: string;
    participant: string | null;
    status: string;
    createdAt: string;
    acceptedAt: string | null;
    expiresAt: string | null;
  }>;
  waitlist: Array<{ email: string; createdAt: string; invitedAt: string | null }>;
  daily: Array<{ day: string; newAccounts: number; updates: number; interactions: number; smsSent: number }>;
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AdminPage() {
  const [ready, setReady] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [denied, setDenied] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setDenied(true);
      setReady(true);
      return;
    }
    const { data: result, error } = await supabase.rpc("admin_overview");
    if (error || !result) {
      setDenied(true);
    } else {
      setOverview(result as Overview);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // The kernel endpoint holds the operator gate and the service key; this
  // page only hands over the operator's own session token and the email.
  // delivery "email" sends through the mailer; "link" mints the same
  // one-time invite link without sending, for the operator to deliver by
  // hand — a mailer outage never blocks the gate.
  async function invite(email: string, delivery: "email" | "link" = "email") {
    setInviting(email);
    setInviteNotice(null);
    setInviteLink(null);
    try {
      const { data } = await supabaseBrowser().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session expired — sign in again.");
      const response = await fetch(`${new URL(MCP_URL).origin}/api/admin/invite`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ email, delivery })
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        alreadyRegistered?: boolean;
        actionLink?: string;
        error?: string;
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? "The invite did not go out.");
      }
      if (payload.alreadyRegistered) {
        setInviteNotice(`${email} already has an account — marked as invited.`);
      } else if (payload.actionLink) {
        setInviteNotice(`Invite link for ${email} — shown once, deliver it yourself:`);
        setInviteLink(payload.actionLink);
      } else {
        setInviteNotice(`Invite sent to ${email}.`);
      }
      await loadOverview();
    } catch (error) {
      setInviteNotice(error instanceof Error ? error.message : "The invite did not go out.");
    } finally {
      setInviting(null);
    }
  }

  if (!ready) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-16">
        <p className="opacity-60">Loading…</p>
      </main>
    );
  }

  if (denied || !overview) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Operator dashboard</h1>
        <p className="opacity-80">This page is for the operator.</p>
        <Link className="text-sm underline opacity-70" href="/">
          ← Back to Mem·Sum
        </Link>
      </main>
    );
  }

  const totals = overview.totals;
  const stats: Array<[string, number]> = [
    ["Accounts", totals.accounts],
    ["Sums", totals.sums],
    ["Pending invites", totals.pendingInvitations],
    ["Waitlist", totals.waitlist],
    ["Active accounts, 7d", totals.activeAccounts7d],
    ["Updates, 7d", totals.updates7d],
    ["Messages, 7d", totals.interactions7d],
    ["Texts sent, 7d", totals.smsSent7d]
  ];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Operator dashboard</h1>
        <p className="text-sm opacity-60">
          Metadata and aggregates only — this surface cannot read sum content, by construction.
        </p>
        <Link className="text-sm underline opacity-70" href="/">
          ← Back to Mem·Sum
        </Link>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div className="rounded-xl border border-black/15 p-4 dark:border-white/20" key={label}>
            <div className="text-2xl font-semibold">{value}</div>
            <div className="mt-1 text-sm opacity-60">{label}</div>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Accounts</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left opacity-60">
                <th className="py-1 pr-4 font-medium">Email</th>
                <th className="py-1 pr-4 font-medium">Created</th>
                <th className="py-1 pr-4 font-medium">Last sign-in</th>
                <th className="py-1 pr-4 font-medium">Owns</th>
                <th className="py-1 font-medium">Member of</th>
              </tr>
            </thead>
            <tbody>
              {overview.accounts.map((account) => (
                <tr className="border-t border-black/10 dark:border-white/15" key={account.email}>
                  <td className="py-1.5 pr-4">{account.email}</td>
                  <td className="py-1.5 pr-4">{shortDate(account.createdAt)}</td>
                  <td className="py-1.5 pr-4">{shortDate(account.lastSignInAt)}</td>
                  <td className="py-1.5 pr-4">{account.sumsOwned}</td>
                  <td className="py-1.5">{account.sumsMemberOf}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Invitations</h2>
        {overview.invitations.length === 0 ? (
          <p className="text-sm opacity-60">No invitations yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left opacity-60">
                  <th className="py-1 pr-4 font-medium">Sum</th>
                  <th className="py-1 pr-4 font-medium">For</th>
                  <th className="py-1 pr-4 font-medium">Status</th>
                  <th className="py-1 pr-4 font-medium">Created</th>
                  <th className="py-1 font-medium">Accepted</th>
                </tr>
              </thead>
              <tbody>
                {overview.invitations.map((invitation, index) => (
                  <tr className="border-t border-black/10 dark:border-white/15" key={index}>
                    <td className="py-1.5 pr-4">{invitation.sum}</td>
                    <td className="py-1.5 pr-4">{invitation.participant ?? "—"}</td>
                    <td className="py-1.5 pr-4">{invitation.status}</td>
                    <td className="py-1.5 pr-4">{shortDate(invitation.createdAt)}</td>
                    <td className="py-1.5">{shortDate(invitation.acceptedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Waitlist</h2>
        {inviteNotice ? (
          <div className="flex flex-col gap-2 rounded-lg bg-accent-tint px-3 py-2 text-sm">
            <p>{inviteNotice}</p>
            {inviteLink ? <code className="break-all text-xs">{inviteLink}</code> : null}
          </div>
        ) : null}
        {overview.waitlist.length === 0 ? (
          <p className="text-sm opacity-60">Nobody waiting yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left opacity-60">
                  <th className="py-1 pr-4 font-medium">Email</th>
                  <th className="py-1 pr-4 font-medium">Joined</th>
                  <th className="py-1 pr-4 font-medium">Invited</th>
                  <th className="py-1 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {overview.waitlist.map((entry) => (
                  <tr className="border-t border-black/10 dark:border-white/15" key={entry.email}>
                    <td className="py-1.5 pr-4">{entry.email}</td>
                    <td className="py-1.5 pr-4">{shortDate(entry.createdAt)}</td>
                    <td className="py-1.5 pr-4">{shortDate(entry.invitedAt)}</td>
                    <td className="py-1.5">
                      {entry.invitedAt ? (
                        <span className="opacity-50">Invited</span>
                      ) : (
                        <span className="flex flex-wrap gap-2">
                          <button
                            className="rounded-lg bg-accent px-2.5 py-1 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint disabled:opacity-60"
                            disabled={inviting !== null}
                            onClick={() => invite(entry.email)}
                            type="button"
                          >
                            {inviting === entry.email ? "Working…" : "Invite"}
                          </button>
                          <button
                            className="rounded-lg border border-black/20 px-2.5 py-1 font-medium disabled:opacity-60 dark:border-white/25"
                            disabled={inviting !== null}
                            onClick={() => invite(entry.email, "link")}
                            type="button"
                          >
                            Invite link
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Last 14 days</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left opacity-60">
                <th className="py-1 pr-4 font-medium">Day</th>
                <th className="py-1 pr-4 font-medium">New accounts</th>
                <th className="py-1 pr-4 font-medium">Updates</th>
                <th className="py-1 pr-4 font-medium">Messages</th>
                <th className="py-1 font-medium">Texts sent</th>
              </tr>
            </thead>
            <tbody>
              {overview.daily.map((day) => (
                <tr className="border-t border-black/10 dark:border-white/15" key={day.day}>
                  <td className="py-1.5 pr-4">{day.day}</td>
                  <td className="py-1.5 pr-4">{day.newAccounts}</td>
                  <td className="py-1.5 pr-4">{day.updates}</td>
                  <td className="py-1.5 pr-4">{day.interactions}</td>
                  <td className="py-1.5">{day.smsSent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
