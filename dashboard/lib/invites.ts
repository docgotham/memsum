// Invite tokens are minted in the browser and only their sha256 hash ever
// reaches the database (same discipline as the kernel and CLI). The link is
// shown once; losing it means minting a fresh one, which supersedes the old.
export function createInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `memsum_invite_${base64}`;
}

// Links are built from the serving origin so they work on localhost, the
// vercel.app domain, and memsum.ai after cutover without configuration.
export function buildInviteLink(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

export const CLAIM_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  revoked: "Revoked",
  expired: "Expired"
};
