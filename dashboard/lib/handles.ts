// Mirror of the kernel's sum-handle derivation (src/hosted/supabase.ts).
// Handles are derived at read time, never stored — labels, not identity — so
// the dashboard must reproduce the kernel's algorithm exactly, including the
// dedupe order: the member's full listing ordered by
// relationship_members.created_at ascending. A kernel test pins the two
// implementations to identical output; change them together or not at all.
export function sumHandleForDisplayName(displayName: string): string {
  const slug = displayName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return `#${slug || "sum"}`;
}

// Deduplicates within one member's set of sums, in listing order: the first
// bearer of a name keeps the bare handle, later ones get -2, -3, and so on.
export function assignSumHandles(displayNames: string[]): string[] {
  const seen = new Map<string, number>();
  return displayNames.map((name) => {
    const base = sumHandleForDisplayName(name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}
