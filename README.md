# Mem·Sum

Shared memory for the people who matter — two to five of you, each through
your own AI assistant or chatbot. A **sum** is one shared workspace for one
endeavor (a wedding shoot, a brand, the family trip); every member reaches it
through the assistant they already trust, over a standard remote MCP server.
Agents read selectively, draft privately, and publish atomic, version-checked
updates. The server keeps the record and has no opinions.

The hosted service lives at [memsum.ai](https://memsum.ai). This repository
is the whole kernel — and you are encouraged to run it yourself.

## The deal, stated plainly

The software is free (Apache-2.0). The hosted version is the same code plus
the parts that are genuinely work: hosting, backups, uptime, support, and SMS
compliance (texts require a verified toll-free number and a carrier-approved
opt-in flow — bring patience if you self-host that part). If the hosted
service ever charges, that is what it charges for. "Mem·Sum" and the dumpling
mark are trademarks; the code is yours, the name is not.

## Why the code is open

Every trust claim the product makes is structural, and structure can be read:

- **No server inference** — the kernel stores and serves; judgment happens in
  the AI clients members connect. Grep for yourself: there is no model call.
- **Isolation is row-level security**, not good manners: see
  `supabase/migrations/`, and the live test harness (`test/live.test.ts`)
  that proves cross-account invisibility against a real database.
- **The operator's admin surface cannot read sum content** — by construction,
  enforced by a test that fails if the admin migration ever references a
  content column. Operator content access (support, incidents) writes an
  audit row the sum's own members can see.
- **Public pages cannot drift from the code**: the tool catalog is pinned to
  the tool registry, the pricing page to the limits migration, by tests.
- **Everything exports** as Open Knowledge Format bundles — plain markdown,
  no lock-in — from the dashboard or the CLI.
- The deployed kernel reports the commit it was built from at `/version`.

## What's in the box

- `src/hosted/` — the remote MCP kernel (13 tools), OAuth, notifications,
  rate limiting, OKF export, served as Vercel functions from `api/`.
- `supabase/migrations/` — the entire graph: schema, RLS, RPCs, quotas.
- `dashboard/` — the Next.js dashboard (accounts, sums, invites, exports).
- `src/` (rest) + `test/vault.test.ts` — the local filesystem/Git prototype
  the hosted product grew out of; kept for development and export tooling.
- `test/` — the suite is the contract: contract tests, migration-shape
  tests, drift tests, and a live harness that runs BEGIN…ROLLBACK
  transactions against a real database (`npm run test:live`).

## Run it

```bash
npm install
npm test          # full suite; live tests skip without credentials
npm run build
```

Self-hosting the hosted kernel needs a Supabase project (apply
`supabase/migrations/` in order), a Vercel project (or any host that runs the
`api/` functions), and the environment variables named in `src/hosted/`
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; Twilio
variables only if you want SMS). The dashboard under `dashboard/` deploys the
same way with its `NEXT_PUBLIC_*` variables.

The local filesystem/Git prototype still works for development and inspection:

```bash
npm run dev:cli -- init --vault ./vault --config ./.dmsum/config.json --participants Dave,Lisa
npm run dev:mcp -- --config ./.dmsum/config.json
```

## Security

See [SECURITY.md](SECURITY.md). Please don't test against sums you are not a
member of — the hosted service is real people's data.

---

## Operating model and doctrine

Everything below is the working documentation the product grew up with — the
invocation signals, the local prototype, and the hosted architecture. It is
kept verbatim because agents read this file too, and the test suite holds
every agent-facing document to the same doctrine.

Local TypeScript/Node implementation of the Mem·Sum filesystem-backed MCP server.

Mem·Sum is a passive, agent-native layer for relationship-scoped communication and memory. A participant talks to their own agent and uses `+sum`, `+dm`, or `+dmsum` as the portable routing mark that an act should enter a shared relationship workspace.

## Current Direction

The core hosted architecture is a Supabase/Postgres relationship graph exposed through a remote MCP/API on Vercel.

As of 2026-07-07 the product is **Mem·Sum** (memsum.ai): DM·Sum and Mem·Sum are one product, relationship workspaces support 2–5 participants at launch (cap is configuration, not schema), and DM·Sum continues as the legacy dyadic instance. Planned hosts: MCP endpoint at `sum.memsum.ai`; site, dashboard, and invite links at `memsum.ai`. The domain cutover happens before public launch so the OAuth issuer never changes afterward.

Agents read selected graph context, build a private draft iteratively, then publish coherent multi-page updates through atomic batch commits with optimistic version checks. The hosted product should not require a full local replica. Local filesystem and Git-sync work remain useful for prototype validation, exports, backups, optional self-hosted operation, and developer inspection, but Git is no longer the core product sync substrate.

The hosted MCP/API read surface includes `list_activity` for participant-facing recent-activity questions such as "what did Dave send me yesterday?", added links or resources, and notification status. It is a chronological read view over existing interactions, updates, resources, and notification jobs, not a new inbox/outbox/thread ontology.

## Quick Start

```powershell
npm install
npm run build
npm run dev:cli -- init --vault .\vault --config .\.dmsum\config.json --participants Dave,Lisa
npm run dev:mcp -- --config .\.dmsum\config.json
```

For the routed multi-relationship local mode:

```powershell
npm run dev:cli -- init-registry --owner Dave --contacts Lisa,lisa-work=Lisa --registry .\.dmsum\registry.json
npm run dev:mcp -- --registry .\.dmsum\registry.json
```

The MCP server uses stdio by default. It can also run as a localhost Streamable HTTP server for agent surfaces that accept only a remote MCP URL:

```powershell
npm run dev:mcp -- --transport http --host 127.0.0.1 --port 3333 --registry .\.dmsum\registry.json
```

That exposes the MCP endpoint at `http://127.0.0.1:3333/mcp` and a simple health check at `http://127.0.0.1:3333/health`. A single-relationship config points at one workspace. A routed registry points one MCP server at many isolated relationship workspaces under `relationships/{relationshipId}/`, with state under `.dmsum/` by default.

For the local Git-sync prototype with Dave-Lisa and Dave-Mike:

```powershell
npm run dev:cli -- init-local --data-root C:\Users\Dave\DMSum --owner Dave --contacts Lisa,Mike
npm run dev:cli -- sync daemon --data-root C:\Users\Dave\DMSum --interval 60
npm run dev:mcp -- --registry C:\Users\Dave\DMSum\.dmsum\registry.json --sync C:\Users\Dave\DMSum\.dmsum\sync.json
npm run dev:mcp -- --transport http --host 127.0.0.1 --port 3333 --registry C:\Users\Dave\DMSum\.dmsum\registry.json --sync C:\Users\Dave\DMSum\.dmsum\sync.json
```

`init-local` creates a machine-local registry, one Git-backed relationship workspace per contact, one bare Git repo per relationship under `git/`, and `.dmsum/sync.json`. For this Git-backed shape, each relationship's ID state is stored inside that relationship repo at `.dmsum/state.json` so Git can expose counter conflicts instead of hiding them in machine-local state.

For Claude Code, copy `.mcp.example.json` to `.mcp.json`, replace `<repo-root>` with the absolute path to this repository and `<data-root>` with the absolute path to the local Mem·Sum data root, then restart Claude Code from the repository directory. The real `.mcp.json` is intentionally ignored because it contains machine-specific paths.

Before testing with Lisa or Mike on another machine, follow [docs/local-git-sync-preflight.md](docs/local-git-sync-preflight.md). It covers Dave's Windows seed setup, remote URL smoke tests, peer Mac initialization, and the first real sync test.

## Kernel

Mem·Sum intentionally exposes a small guarded kernel:

- `read_file`, `list_files`, `grep`
- `get_current_time`
- `claim_status`, `refresh_status`, `release_status`
- `commit_interaction`
- `commit_wiki_update`
- `list_conflicts`, `read_conflict`, `resolve_conflict`

Agents browse markdown directly and follow `DMSUM.md`. The server protects structure, IDs, timestamps, immutable records, path boundaries, STATUS coordination, stale-write conflicts, and dry-run notifications.

## Relationship Workspace

```text
interactions/YYYY/MM/DD/I000001.md
wiki-updates/YYYY/MM/DD/W000001.md
conflicts/YYYY/MM/DD/C000001.md
wiki/index.md
wiki/entities/
wiki/topics/
wiki/concepts/
wiki/synthesis/
preferences/{participant}.md
log.md
STATUS.md
participants.md
```

Each configured relationship gets its own workspace. Dave-Lisa, Dave-Jeff, and Lisa-Velia can each have separate interactions, wiki updates, wiki pages, and participant display preferences. Shared global identity and routing can come later; the meaning-bearing graph is relationship-local.

## Local Multi-Relationship Registry

Routed local mode uses `.dmsum/registry.json` outside the relationship workspaces. The registry stores owner-scoped contact handles and maps them to isolated workspaces. For example, Dave can have both `@lisa` and `@lisa-work`; each handle points to a different relationship ID and separate wiki graph.

In routed mode, `commit_interaction` can infer `relationshipId` from an unambiguous `@contact` handle in `rawText`. `commit_wiki_update`, STATUS calls, and ambiguous reads should pass `relationshipId` explicitly. Read tools also support virtual paths such as `relationships/dave-lisa/wiki/index.md`.

This is the local model that the hosted Supabase/Vercel version should preserve: global identity and routing can be shared, but relationship workspaces remain separate.

## Local Git Sync

The prototype sync layer uses Git as the durable local format for history, diffs, merges, and agent-readable conflicts. Transport is modular: the first practical transport is ordinary Git over Tailscale plus Windows OpenSSH, while Iroh can later carry Git bundles or packfiles without changing Mem·Sum semantics.

Each dyad is its own Git repo. Dave-Lisa and Dave-Mike do not share workspace files, preferences, state, history, or remotes. Dave's Windows machine can host local bare repos under `C:\Users\Dave\DMSum\git\`; Lisa and Mike clone only their own relationship repo.

Useful commands:

```powershell
dmsum init-local --data-root C:\Users\Dave\DMSum --owner Dave --contacts Lisa,Mike
dmsum sync once --data-root C:\Users\Dave\DMSum
dmsum sync status --data-root C:\Users\Dave\DMSum
dmsum sync doctor --data-root C:\Users\Dave\DMSum
dmsum sync daemon --data-root C:\Users\Dave\DMSum --interval 60
dmsum sync resolve --data-root C:\Users\Dave\DMSum --relationship dave-lisa
```

Sync stages and commits local file changes, fetches from the relationship remote, merges, then pushes. `sync status` distinguishes clean worktrees from local changes waiting for sync, and `sync doctor` checks the local Git setup when something feels off. If Git reports conflicts, sync stops for that relationship and lists the conflicting files. An agent should read the conflicted markdown and Git diff, preserve both participants' durable meaning, carry forward non-conflicting new pages, reconcile overlapping pages, update index links if needed, then run `sync resolve` for that relationship.

When the MCP server is launched with `--sync PATH`, it also exposes `sync_status`, `sync_once`, `sync_doctor`, and `sync_resolve`. Agents should prefer those MCP tools over shell commands when available, especially in surfaces such as Perplexity Personal Computer where ordinary shell writes may be sandboxed. The content commit still happens through `commit_interaction` and `commit_wiki_update`; `sync_once` is the explicit publish step that commits, fetches, merges, and pushes the relationship repo.

For Perplexity or another client that accepts a URL but not a local stdio command, run the same server with `--transport http` and register `http://127.0.0.1:3333/mcp` as the MCP URL. If the client asks for a transport type, choose Streamable HTTP. Keep the bind host at `127.0.0.1` for local-only use unless you deliberately want the MCP endpoint reachable from another machine.

## Kernel Conflict Semantics

`read_file` returns the current file content plus a SHA-256 `hash`. `wikiWrites` and `preferenceWrites` can include that value as `baseHash`. When the hash still matches, the write proceeds normally. When the target changed first, `commit_wiki_update` leaves the current page alone and records the attempted write under `conflicts/YYYY/MM/DD/C000001.md`.

Agents can then call `list_conflicts`, `read_conflict`, and `resolve_conflict` to reconcile current and proposed content. This gives the MCP kernel Git-like stale-write semantics without making Git the hosted storage substrate.

For hosted v2, the preferred write-conflict model is simpler: submit a multi-page batch with expected versions, let Postgres commit all changes atomically or reject the whole batch, then have the agent reread the latest graph and revise privately before retrying. Filesystem conflict records are local prototype machinery, not the primary hosted path.

## Interaction And Wiki Update

For durable write/update `+sum`, `+dm`, or `+dmsum` acts, the agent first calls `commit_interaction`. This stores the exact raw text, participant, agent, addressed participants, optional resources, and optional dry-run notification text.

Read-only retrieval requests, such as asking what a trip says or what changed recently, should normally stay read-only. The agent commits only when the turn adds durable material, expresses a durable preference, directs attention, supplies a source, or asks to change the relationship workspace.

When the act should become shared memory, the agent calls `commit_wiki_update`. A wiki update cites one or more source interactions and writes final markdown into:

- `wiki/` for shared relationship memory
- `preferences/` for durable participant-specific display or handling preferences

The normal pipeline is one immediate wiki update per meaningful write/update interaction. Multi-interaction wiki updates are exceptional: explicit batches, corrections before integration, recovery from interrupted work, or source bundles that clearly span several turns.

If an interaction repeats something already captured and adds no meaningful nuance, the raw interaction is preserved but no duplicate wiki update is created. The participant-facing response should simply say that the material is already captured and summarize the current state.

There is no fixed server-side taxonomy for questions, tasks, decisions, or preferences. Agents put the meaning in wiki page prose, add optional free-form `tags`, and use optional `attention` when another participant should notice, answer, review, decide, or act.

## User Model

Users can say things like:

```text
+dm @lisa I love you.
+dm tell @lisa we should look at flights soon.
+dm ask @lisa if she can tolerate a 14-hour Istanbul layover.
+sum add these flight times to the Budapest trip.
+sum remember that Lisa hates red-eyes.
+dmsum show what Lisa and I have worked out about Budapest.
```

`+sum` is for adding, saving, updating, or asking about shared relationship memory. `+dm` is for direct-feeling social acts addressed to another participant. `+dmsum` is the explicit product-name signal when a surface or agent needs less ambiguity. `@lisa` names a participant and usually selects the relationship workspace involving Lisa. Users can speak in ordinary language; agents still do the judgment work: choose the right relationship workspace, choose or create wiki pages, decide when a wiki update should notify another participant, and present useful summaries.

## Wiki Graph

The wiki graph lives under `wiki/`.

Agents read `wiki/index.md`, then the likely target wiki pages, before wiki updates. They create supporting wiki pages when material is likely to recur, would overload a hub wiki page, or should be reusable from future plans. The ontology is an internal guide:

- topic wiki pages for plans, projects, trips, events, and ongoing work
- entity wiki pages for people, places, accounts, animals, organizations, listings, and vendors
- concept wiki pages for recurring preferences, procedures, constraints, and principles
- synthesis wiki pages for cross-cutting summaries

Participants hear ordinary language: trips, notes, instructions, addresses, questions, plans, people, and preferences. Directory names are implementation details unless requested.

## Preferences

Participant preferences live in `preferences/{participant}.md` inside the relationship workspace. They are sourced by interactions and written through `commit_wiki_update` with `preferenceWrites`.

Example: if Dave says `+sum when I ask to see older activity, show ten items by default`, the agent stores the exact interaction and may update `preferences/dave.md`. That preference applies to this relationship workspace unless another workspace records a similar rule.

Agents should read the current participant's preference file before answering requests to show, summarize, recap, revisit, or explain saved material. Preference files are part of the retrieval path and override generic presentation guidance, including link display defaults.

Ordinary participant-facing retrieval should be grounded in the current contract, the current participant preference file, `wiki/`, `wiki-updates/`, and relevant `interactions/`. In hosted mode, use `list_activity` first for recent activity, sent/received items, added links/resources, and notification-status questions, then fall back to page reads or search when the question needs synthesized graph content. Older experimental runtime locations outside those roots are audit or historical material; they should not guide ordinary replies unless the participant asks for technical or historical context.

## Resources

URLs, listing links, social profiles, Pinterest boards, travel links, files, and pasted source excerpts can be stored as resources. The server does not fetch webpages in the local MVP. Agents may add link metadata when they can obtain it cheaply, but failures should not block the wiki update.

Ordinary participant chat is instruction by default, not source. External documents, URLs, files, and explicitly source-like pasted excerpts are source.

## Presentation

Participant-facing replies should be natural, low-friction, and grounded in the participant's recognizable object: a trip, collection, saved source, instructions, open question, or whatever name the participant is already using. Say what changed or what matters now, and keep it concise unless the participant asks for detail.

Hide implementation details by default. Do not show internal IDs, file paths, timestamps, audit/provenance links, MCP tool names, storage mechanics, raw metadata, or local markdown/file links unless the participant asks for sources, files, technical context, or the exact audit trail.

External web links are different from local markdown links. Include useful external links when they help the participant act on the current request, and always honor participant preferences about showing original links.

`🥟` is an optional lightweight brand mark when the surface handles emoji. Small labels and simple separators may be used when they improve scanability, but the answer must still make sense without them.

The same boundary applies inside wiki page prose. Provenance links and References entries can contain audit handles, but body text should remain human-readable.

## Derived Artifacts

Wiki pages can be used as source material for PDFs, Word docs, PowerPoint decks, spreadsheets, printable handouts, HTML pages, CSVs, or other local artifacts. Generated artifacts are derivatives; the wiki graph remains canonical.

The read-only audit renderer can run locally with `dmsum audit`. Hosted storage, authentication, permissions, and real notification delivery are the next product track. The prior cloudless Git/Tailscale path remains available as local prototype infrastructure, but the cloud MVP should use Supabase/Postgres, Vercel, remote MCP/API tools, and atomic batch commits.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
