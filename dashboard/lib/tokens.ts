// Connector tokens are minted in the browser and only their sha256 hash ever
// reaches the database (same discipline as invite tokens and the kernel CLI).
// The token is shown once; a lost token is replaced by issuing a new one and
// revoking the old. The kernel recognizes memsum_ (current) and dmsum_
// (legacy) prefixes on Authorization headers; old tokens keep working.
export function createConnectorToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `memsum_${base64}`;
}
