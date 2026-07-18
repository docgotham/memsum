# The Mem·Sum Companion (increments 1–2, shipped 2026-07-18)

A slender plain-URL window kept beside whichever AI the member is talking to —
chat on the left, memory on the right. The pattern is borrowed from Suminar's
companion surface and carries its guardrails:

- **Plain URL.** `/companion` works in any browser window, as the header
  pop-out (`window.open`, 440×900), or installed as a standalone PWA that
  snaps to the same slender shape (the full install configuration and its
  diagnosis method live in `docs/companion-pwa-install.md`). No
  host-ecosystem coupling — deliberately not a Claude artifact. It is the
  dashboard, kept open — not a place to live in.
- **Instruments, not dialogue.** The companion prepares speech and never
  delivers it. Chips copy ready-to-paste invocations — an `@handle` chip
  copies `+dm @handle `, the `#sum-handle` chip copies `#handle `, and each
  wiki row's `[[ ]]` chip copies `[[Page Title]] `, the graph's own
  wiki-link notation (the family grammar in one line: @ names who, # names
  where, [[...]] names what) — and the member finishes the sentence in
  their own chat, where their own agent performs the act. **Quick-send was considered and dropped (Dave,
  2026-07-18)**: a send surface would recreate a second chat and bypass the
  agent judgment the whole product routes through. A drift test pins the
  absence of forms and textareas.
- **Read-only wiki.** Agents own the writing; members see it. The viewer
  renders stored markdown with `markdown-it` and `html: false` (stored
  content is escaped, never executed), resolves `[[wiki links]]` to viewer
  routes, strips unexpanded `{{WIKI_UPDATE_*}}` provenance tokens at render
  (punch #8 remains open kernel-side), and forces `noopener noreferrer` +
  new-tab on external links. Every page offers a raw `.md` download —
  client-side from content already fetched; bundle exports remain the
  audited path.
- **Liveness is the signal.** Sums whose graph grew in the last ~3 minutes
  pin to a "Live now" strip with a dot — no selection state, reality drives
  the pinning. Refresh on focus plus 60s while visible.

## Data access

No new kernel surface. Everything reads through the Supabase browser client
under the member's own JWT and the same RLS as agent reads: `wiki_pages`
(`wiki_pages_member_access`), `relationship_members` ordered by
`created_at` ascending — the kernel's own dedupe order — `contacts`, and
recent `updates` for liveness. `#sum-handles` are derived client-side by a
byte-faithful mirror of the kernel's algorithm
(`dashboard/lib/handles.ts`); a kernel test imports both implementations and
fails if they ever diverge.

## Routes

- `/companion` — the slender shell: filterable sums list (private/shared
  grouping, live strip), then per-sum instruments (handle chips, member
  chips, wiki index; index links open pages full-size in a new window).
- `/sums/[id]/wiki` — full-size wiki index, grouped by the agent ontology
  under plain labels (plans, people/places/things, preferences, summaries).
- `/sums/[id]/wiki/[...path]` — the rendered page: title, sum breadcrumb,
  safe markdown body, version/updated footer, Download .md.

## Increment 2.5 — master-detail and the reader window (2026-07-18)

**Surface doctrine:** the family asks a user to manage exactly two standing
surfaces — their chat and the Companion. Everything deeper is transient,
singular, and user-invoked.

The three-window tension (chat + companion + full-size page) resolved by
layering rather than widening:

- **Pages read in the panel.** Clicking an index row renders the page
  in-panel at slender width (`.wiki-compact` typography — phone-width prose;
  the fix for narrow columns is type, not width), with a back row to the
  sum. Wiki-links inside a rendered page are intercepted and followed
  in-panel; external links keep new-tab + noopener. Page content refetches
  on focus, and the wiki index refetches on focus plus the 60s visible tick,
  so the panel tracks agent writes — and deletions: a removed page leaves
  the list, and one someone is reading says it may have been removed.
- **Full size is an explicit escalation into ONE reused window.** "Open
  full ↗" (and "Full index ↗") target the named browsing context
  `memsum-reader`: every escalation reuses the same window, so the third
  window never multiplies. These same-origin links deliberately omit
  `noopener` — noopener severs the named-target association that makes
  reuse work; external links in page content are unaffected.
- **Widening stays the user's dial, not the design.** Chrome remembers the
  size an installed PWA is left at; the Companion never grows into a
  reading app — slender is its identity ("panel, not app").

## Deferred (increment 3+)

- Activity/SMS tab: notification jobs with delivery states — the visible
  counterpart of the contract's "say queued, never claim delivery."
- Open Graph cards rendered from **stored resource metadata** (agents enrich
  at save time per the operating contract; the kernel still fetches
  nothing), and click-to-load external images (inlining would leak reader
  IPs to third-party hosts).
- Recency-ordered sums once usage justifies it.
