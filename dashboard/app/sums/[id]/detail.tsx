"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { buildInviteLink, CLAIM_STATUS_LABELS, createInviteToken } from "@/lib/invites";
import { MCP_URL, sha256Hex, supabaseBrowser } from "@/lib/supabase";

interface ParticipantRow {
  id: string;
  display_name: string;
  user_id: string | null;
}

interface RelationshipRow {
  id: string;
  display_name: string;
  participants: ParticipantRow[];
}

interface InvitationRow {
  invitationId: string;
  participantId: string | null;
  participantDisplayName: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
}

const CREATE_ERRORS: Record<string, string> = {
  owner_only: "Only the sum's owner can create invitations.",
  participant_cap: "This sum is at its participant limit.",
  participant_already_claimed: "That participant has already joined."
};

export function SumDetail({ relationshipId }: { relationshipId: string }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<RelationshipRow | null>(null);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freshInvite, setFreshInvite] = useState<{ link: string; participantName: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [notif, setNotif] = useState<{ phone: string; verified: boolean; enabled: boolean } | null | undefined>(undefined);
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [notifNotice, setNotifNotice] = useState<string | null>(null);
  const [changingNumber, setChangingNumber] = useState(false);
  const [exporting, setExporting] = useState<"share" | "archive" | null>(null);

  const myParticipantId = relationship?.participants.find((participant) => participant.user_id === userId)?.id ?? null;

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: sessionData } = await supabase.auth.getSession();
    setSignedIn(Boolean(sessionData.session));
    setUserId(sessionData.session?.user.id ?? null);
    if (!sessionData.session) {
      setReady(true);
      return;
    }

    const [relationshipResult, invitationsResult] = await Promise.all([
      supabase
        .from("relationships")
        .select("id, display_name, participants(id, display_name, user_id)")
        .eq("id", relationshipId)
        .maybeSingle(),
      supabase.rpc("list_invitations", { p_relationship_id: relationshipId })
    ]);

    if (relationshipResult.error || !relationshipResult.data) {
      setError("This sum could not be loaded.");
    } else {
      setRelationship(relationshipResult.data as RelationshipRow);
      setError(null);
    }
    if (!invitationsResult.error && Array.isArray(invitationsResult.data)) {
      setInvitations(invitationsResult.data as InvitationRow[]);
    }
    setReady(true);
  }, [relationshipId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createInvite(input: { participantId?: string; newParticipantDisplayName?: string; name: string }) {
    setBusy(true);
    setError(null);
    setFreshInvite(null);
    setCopied(false);

    const token = createInviteToken();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error: rpcError } = await supabaseBrowser().rpc("create_participant_invitation", {
      payload: {
        relationshipId,
        ...(input.participantId ? { participantId: input.participantId } : {}),
        ...(input.newParticipantDisplayName ? { newParticipantDisplayName: input.newParticipantDisplayName } : {}),
        tokenHash: await sha256Hex(token),
        expiresAt
      }
    });
    setBusy(false);

    const result = data as { ok?: boolean; reason?: string; participantDisplayName?: string } | null;
    if (rpcError || result?.ok !== true) {
      setError(CREATE_ERRORS[result?.reason ?? ""] ?? "The invitation could not be created.");
      return;
    }
    setFreshInvite({ link: buildInviteLink(token), participantName: result.participantDisplayName ?? input.name });
    setNewName("");
    await load();
  }

  async function inviteNewParticipant(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    await createInvite({ newParticipantDisplayName: name, name });
  }

  async function revoke(invitationId: string) {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabaseBrowser().rpc("revoke_invitation", { p_invitation_id: invitationId });
    setBusy(false);
    const result = data as { ok?: boolean; reason?: string } | null;
    if (rpcError || result?.ok !== true) {
      setError(result?.reason === "owner_only" ? "Only the sum's owner can revoke invitations." : "The invitation could not be revoked.");
      return;
    }
    await load();
  }

  async function exportBundle(profile: "share" | "archive") {
    setExporting(profile);
    setError(null);
    const { data: sessionData } = await supabaseBrowser().auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setExporting(null);
      setError("Sign in again to export.");
      return;
    }
    try {
      const response = await fetch(`${new URL(MCP_URL).origin}/api/export`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ relationshipId, profile })
      });
      if (!response.ok) {
        setError("The export could not be produced. Try again shortly.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "memsum-export.zip";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("The export could not be produced. Try again shortly.");
    } finally {
      setExporting(null);
    }
  }

  async function copyLink() {
    if (!freshInvite) return;
    await navigator.clipboard.writeText(freshInvite.link);
    setCopied(true);
  }

  useEffect(() => {
    if (!myParticipantId) return;
    supabaseBrowser()
      .rpc("get_notification_settings", { p_participant_id: myParticipantId })
      .then(({ data }) => {
        const result = data as { ok?: boolean; endpoint?: { phone: string; verified: boolean; enabled: boolean } | null } | null;
        if (result?.ok === true) setNotif(result.endpoint ?? null);
      });
  }, [myParticipantId]);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    if (!myParticipantId) return;
    setBusy(true);
    setNotifNotice(null);
    const { data } = await supabaseBrowser().rpc("start_phone_verification", {
      p_participant_id: myParticipantId,
      p_phone: phoneInput.trim()
    });
    setBusy(false);
    const result = data as { ok?: boolean; reason?: string } | null;
    if (result?.ok === true) {
      setCodeSent(true);
      setNotifNotice("Code on its way — it usually arrives within a minute.");
      return;
    }
    setNotifNotice(
      result?.reason === "invalid_phone"
        ? "Use international format, like +14085551212."
        : result?.reason === "too_soon"
          ? "A code was just sent — give it a minute, then try again."
          : result?.reason === "already_verified"
            ? "That number is already verified."
            : "The code could not be sent. Try again in a moment."
    );
  }

  async function confirmCode(event: FormEvent) {
    event.preventDefault();
    if (!myParticipantId) return;
    setBusy(true);
    setNotifNotice(null);
    const { data } = await supabaseBrowser().rpc("confirm_phone_verification", {
      p_participant_id: myParticipantId,
      p_code: codeInput.trim()
    });
    setBusy(false);
    const result = data as { ok?: boolean; reason?: string; phone?: string } | null;
    if (result?.ok === true) {
      setNotif({ phone: result.phone ?? phoneInput.trim(), verified: true, enabled: true });
      setCodeSent(false);
      setCodeInput("");
      setChangingNumber(false);
      setNotifNotice("Verified — you'll get a text when someone pings you in this sum.");
      return;
    }
    setNotifNotice(
      result?.reason === "invalid_code"
        ? "That code didn't match. Check the text and try again."
        : result?.reason === "expired"
          ? "That code expired. Send a fresh one."
          : result?.reason === "too_many_attempts"
            ? "Too many tries. Send a fresh code."
            : "No code is pending — send one first."
    );
  }

  async function toggleEnabled() {
    if (!myParticipantId || !notif) return;
    const next = !notif.enabled;
    const { data } = await supabaseBrowser().rpc("set_notification_enabled", {
      p_participant_id: myParticipantId,
      p_enabled: next
    });
    const result = data as { ok?: boolean } | null;
    if (result?.ok === true) setNotif({ ...notif, enabled: next });
  }

  async function leaveSum() {
    if (!window.confirm("Leave this sum? Your access ends; the sum stays with the remaining members.")) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabaseBrowser().rpc("leave_relationship", {
      p_relationship_id: relationshipId
    });
    setBusy(false);
    const result = data as { ok?: boolean; reason?: string } | null;
    if (rpcError || result?.ok !== true) {
      setError(
        result?.reason === "owner_cannot_leave"
          ? "The owner can't leave a sum. Deleting a sum entirely is coming later."
          : "Leaving did not go through. Try again in a moment."
      );
      return;
    }
    window.location.href = "/sums";
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    const name = renameValue.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabaseBrowser().rpc("rename_relationship", {
      p_relationship_id: relationshipId,
      p_display_name: name
    });
    setBusy(false);
    const result = data as { ok?: boolean; reason?: string } | null;
    if (rpcError || result?.ok !== true) {
      setError(result?.reason === "owner_only" ? "Only the sum's owner can rename it." : "The sum could not be renamed.");
      return;
    }
    setRenaming(false);
    await load();
  }

  const pendingByParticipant = new Set(
    invitations.filter((invitation) => invitation.status === "pending").map((invitation) => invitation.participantId)
  );

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <div className="flex items-baseline justify-between gap-4">
        {renaming ? (
          <form className="flex flex-1 flex-wrap items-center gap-2" onSubmit={submitRename}>
            <input
              autoFocus
              className="flex-1 rounded-lg border border-black/20 px-3 py-2 text-lg font-semibold dark:border-white/25"
              maxLength={120}
              onChange={(event) => setRenameValue(event.target.value)}
              required
              value={renameValue}
            />
            <button
              className="rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              Save
            </button>
            <button
              className="rounded-lg border border-black/20 px-3 py-2 text-sm font-medium dark:border-white/25"
              onClick={() => setRenaming(false)}
              type="button"
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{relationship?.display_name ?? "Sum"}</h1>
            {relationship ? (
              <button
                className="text-sm underline opacity-60 hover:opacity-100"
                onClick={() => {
                  setRenameValue(relationship.display_name);
                  setRenaming(true);
                }}
                type="button"
              >
                Rename
              </button>
            ) : null}
          </div>
        )}
        <Link className="text-sm underline opacity-70" href="/sums">
          ← Your sums
        </Link>
      </div>

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
          to manage this sum.
        </p>
      ) : relationship ? (
        <>
          {freshInvite ? (
            <div className="flex flex-col gap-3 rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-4">
              <p className="font-medium">
                Invite link for {freshInvite.participantName} — shown once, deliver it yourself:
              </p>
              <code className="overflow-x-auto rounded-lg border border-black/15 bg-background px-3 py-2 text-sm dark:border-white/20">
                {freshInvite.link}
              </code>
              <div className="flex gap-3">
                <button
                  className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85"
                  onClick={copyLink}
                  type="button"
                >
                  {copied ? "Copied ✓" : "Copy link"}
                </button>
              </div>
            </div>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">Participants</h2>
            <ul className="flex flex-col gap-2">
              {relationship.participants.map((participant) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/15 px-4 py-3 dark:border-white/20"
                  key={participant.id}
                >
                  <span className="font-medium">
                    {participant.display_name}
                    {participant.user_id === userId ? <span className="opacity-60"> (you)</span> : null}
                  </span>
                  {participant.user_id ? (
                    <span className="text-sm text-emerald-700 dark:text-emerald-400">Joined</span>
                  ) : pendingByParticipant.has(participant.id) ? (
                    <span className="text-sm opacity-60">Invite pending</span>
                  ) : (
                    <button
                      className="rounded-lg border border-black/20 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-white/25"
                      disabled={busy}
                      onClick={() => void createInvite({ participantId: participant.id, name: participant.display_name })}
                      type="button"
                    >
                      Create invite link
                    </button>
                  )}
                </li>
              ))}
            </ul>

            <form className="flex flex-wrap items-end gap-3" onSubmit={inviteNewParticipant}>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Invite someone new
                <input
                  className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Their name"
                  value={newName}
                />
              </label>
              <button
                className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
                disabled={busy || !newName.trim()}
                type="submit"
              >
                {busy ? "Working…" : "Create invite link"}
              </button>
            </form>
            <p className="text-sm opacity-60">
              Invitations are links you deliver yourself — Mem·Sum contacts no one. A new link for the same person
              replaces the old one. Sums hold up to five participants. Inviting someone shows them everything
              already in this sum — to share only part of it, keep this sum yours and copy pages into a shared one
              instead.
            </p>
          </section>

          {invitations.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="font-semibold">Invitations</h2>
              <ul className="flex flex-col gap-2">
                {invitations.map((invitation) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/15 px-4 py-3 text-sm dark:border-white/20"
                    key={invitation.invitationId}
                  >
                    <span>
                      <span className="font-medium">{invitation.participantDisplayName ?? "Unknown participant"}</span>{" "}
                      <span className="opacity-60">· {CLAIM_STATUS_LABELS[invitation.status] ?? invitation.status}</span>
                      {invitation.expiresAt && invitation.status === "pending" ? (
                        <span className="opacity-60"> · expires {new Date(invitation.expiresAt).toLocaleDateString()}</span>
                      ) : null}
                    </span>
                    {invitation.status === "pending" ? (
                      <button
                        className="rounded-lg border border-black/20 px-3 py-1.5 font-medium disabled:opacity-50 dark:border-white/25"
                        disabled={busy}
                        onClick={() => void revoke(invitation.invitationId)}
                        type="button"
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-sm opacity-60">
            Once someone joins, they connect their own AI from the{" "}
            <Link className="underline" href="/connect">
              Connect your AI
            </Link>{" "}
            page.
          </p>

          {myParticipantId ? (
            <section className="flex flex-col gap-3">
              <h2 className="font-semibold">Notifications</h2>
              {notifNotice ? <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">{notifNotice}</p> : null}
              {notif === undefined ? (
                <p className="text-sm opacity-60">Loading…</p>
              ) : notif?.verified && !changingNumber ? (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input checked={notif.enabled} onChange={() => void toggleEnabled()} type="checkbox" />
                    Text me at {notif.phone} when someone pings me in this sum
                  </label>
                  <button
                    className="self-start text-sm underline opacity-60 hover:opacity-100"
                    onClick={() => {
                      setChangingNumber(true);
                      setPhoneInput("");
                      setCodeSent(false);
                    }}
                    type="button"
                  >
                    Change number
                  </button>
                </div>
              ) : codeSent ? (
                <form className="flex flex-wrap items-end gap-3" onSubmit={confirmCode}>
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    Enter the 6-digit code
                    <input
                      autoComplete="one-time-code"
                      className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                      inputMode="numeric"
                      maxLength={6}
                      onChange={(event) => setCodeInput(event.target.value)}
                      pattern="[0-9]{6}"
                      required
                      value={codeInput}
                    />
                  </label>
                  <button
                    className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
                    disabled={busy}
                    type="submit"
                  >
                    Verify
                  </button>
                  <button className="text-sm underline opacity-60" onClick={sendCode} type="button">
                    Resend code
                  </button>
                </form>
              ) : (
                <form className="flex flex-wrap items-end gap-3" onSubmit={sendCode}>
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    Your mobile number
                    <input
                      autoComplete="tel"
                      className="rounded-lg border border-black/20 px-3 py-2 font-normal dark:border-white/25"
                      onChange={(event) => setPhoneInput(event.target.value)}
                      placeholder="+14085551212"
                      required
                      type="tel"
                      value={phoneInput}
                    />
                  </label>
                  <button
                    className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
                    disabled={busy}
                    type="submit"
                  >
                    Text me a code
                  </button>
                  <p className="w-full text-sm opacity-60">
                    Verify once and you can get texts when someone in this sum pings you. Reply STOP any time.
                  </p>
                </form>
              )}
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">Export your data</h2>
            <p className="text-sm opacity-80">
              Download this sum as an open-format (OKF) bundle — plain markdown that works anywhere, no lock-in.
              The share bundle is the wiki; the full archive adds every raw message and preference file. Exports
              are visible to the other members.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                className="rounded-lg border border-black/20 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/25"
                disabled={exporting !== null}
                onClick={() => void exportBundle("share")}
                type="button"
              >
                {exporting === "share" ? "Preparing…" : "Download share bundle (.zip)"}
              </button>
              <button
                className="rounded-lg border border-black/20 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/25"
                disabled={exporting !== null}
                onClick={() => void exportBundle("archive")}
                type="button"
              >
                {exporting === "archive" ? "Preparing…" : "Download full archive (.zip)"}
              </button>
            </div>
          </section>

          <div className="border-t border-black/10 pt-6 dark:border-white/15">
            <button
              className="rounded-lg border border-red-700/40 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50 dark:border-red-400/40 dark:text-red-400"
              disabled={busy}
              onClick={() => void leaveSum()}
              type="button"
            >
              Leave this sum
            </button>
            <p className="mt-2 text-sm opacity-60">
              Leaving ends your access. The sum and everything you contributed stay with the remaining members, and
              you can rejoin later with a fresh invitation.
            </p>
          </div>
        </>
      ) : null}
    </main>
  );
}
