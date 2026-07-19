# AGENTS.md - Mem·Sum

This is the repository-level agent entry point for Mem·Sum.

For vault operations, the operational contract is `DMSUM.md`. Read it before changing or querying a Mem·Sum vault. In the local test, read the runtime vault copy through MCP:

```text
read_file("DMSUM.md")
```

## Core Orientation

Mem·Sum is an agent-native, relationship-scoped communication and memory layer. It is not the agent. A participant writes to their own agent, usually with `+sum`, `+dm`, or `+dmsum`, and the agent routes the act through the passive Mem·Sum layer.

Identity and routing can be global. Meaning is relational. In routed local mode, one MCP server may use `.dmsum/registry.json` to route across many relationship workspaces, but each workspace still has its own raw interactions, wiki updates, wiki graph, participants, and participant-specific preferences.

The server protects structure, provenance, IDs, timestamps, paths, coordination, and dry-run notifications. Agents provide the judgment: interpreting ordinary language, choosing target wiki pages, creating supporting wiki pages, enriching resources, linking the graph, and writing useful prose.

The current product direction: a hosted Supabase/Postgres graph exposed through a remote MCP/API on Vercel. Local filesystem and Git-sync work remain useful prototype, export, backup, and development infrastructure, but they are no longer the core product sync architecture.

## Current State And Invariants (2026-07-13)

The product is live. The hosted MCP endpoint is `https://sum.memsum.ai/mcp` (the bare host
`https://sum.memsum.ai` also serves MCP); the dashboard, site, and invite links are on
`https://memsum.ai`. The legacy host `dmsum-hosted-mvp.vercel.app` keeps serving everything, so
connectors registered against it continue to work. The kernel is open source (Apache-2.0) at
https://github.com/docgotham/memsum, published as snapshots from a private operating archive.

Naming invariants — prose says Mem·Sum; these machine-facing names are frozen on purpose and
must not be renamed in a cleanup:

- MCP tool names (`get_dmsum_home`, `get_dmsum_instructions`, …) and the `+sum`/`+dm`/`+dmsum`
  invocation signals.
- Connector token prefixes: new tokens mint `memsum_`; legacy `dmsum_` tokens are accepted
  forever (tokens are stored as hashes, so validity is prefix-blind). Internal `dmsoat_` and
  `dmsum_client_` strings are machine-facing.
- `DMSUM_*` environment variable names, the `DMSUM.md` vault contract filename, local state
  under `.dmsum/`, and the `LEGACY_PRODUCT_NAME` constant (its job is to say "DM Sum").
- The MCP server identifies as `memsum-hosted`; the server card and the initialize response
  must stay in lockstep.

Applied migrations under `supabase/migrations/` are history, not source to edit. Changing
database behavior or wording means a new migration; tests that pin migration text deliberately
assert the strings that actually ran, including pre-rename "DM Sum" strings.

Test discipline: run bare `npm test` (never piped through grep — a pipe masks the exit code).
The live harness (`test/live.test.ts`) runs only when `DMSUM_TEST_DATABASE_URL` is set in the
gitignored root `.env` and rolls back everything it touches. Public pages are pinned to code by
drift tests — the tool catalog to the tool registry, the beta page's limit numbers to the limits migration (/pricing became /beta 2026-07-19: beta framing, no monetization language — a drift test pins the absence),
the privacy processor roster to the page — so page, code, and test change together in one
commit or the suite fails.

The member-facing Companion (dashboard route `/companion`) is documented in
`docs/companion.md` (surface doctrine, read-only guardrails) and
`docs/companion-pwa-install.md` (the proven installable-PWA configuration and its diagnosis
method — consult it before touching manifests, icons, or install metadata on any Sum-family
companion surface).

Connected apps (dashboard route `/connections`, family convention in the constitution's
"Connected apps — the authorization console" section, adopted 2026-07-19): one page lists
everything that can act as the member — OAuth clients and connector tokens together. The
`oauth_*` tables stay service-role-only; `list_oauth_grants()` / `revoke_oauth_client_grants()`
(migration 20260719160000) are the only authenticated window, scoped to `auth.uid()`.
Revocation invalidates that client's tokens and closes in-flight authorization codes but never
touches member data; a dynamically registered client's self-asserted name is always displayed
with its registered redirect host. The page's claims are drift-pinned. The hand-rolled OAuth
store is deliberately frozen at current capability — the trigger list for converging on
platform OAuth lives in the constitution's Roadmap B.

## Vocabulary

- `+sum` means add, save, update, ask about, or retrieve shared relationship memory.
- `+dm` means a direct-feeling social act addressed to another participant.
- `+dmsum` is the explicit product-name signal for surfaces or agents that need less ambiguity.
- `@lisa` is an owner-scoped contact handle. It usually selects the relationship workspace involving that contact for the current owner.
- An **interaction** is the immutable raw `+sum`, `+dm`, or `+dmsum` turn.
- A **wiki update** is the durable integration of one or more interactions or resources into the relationship workspace.
- A **wiki page** is a relationship-scoped markdown memory surface.

Do not force wiki updates into a fixed semantic taxonomy. Use optional free-form `tags` only as lightweight handles and optional `attention` when a participant directs another known participant to notice or respond. The durable meaning belongs in the wiki page prose and graph links.

Default to one immediate wiki update per meaningful write/update interaction. A wiki update normally cites one source interaction. Cite multiple interactions only when the participant explicitly asks to update from a batch, a correction or clarification arrives before the first interaction is integrated, the agent is recovering from interrupted or pending work, or several turns clearly form one source bundle.

If the interaction repeats something already captured and adds no meaningful nuance, preserve the raw interaction but do not create a duplicate wiki update. In participant-facing chat, say briefly that it is already captured and summarize the current state. Do not mention that the restatement was saved, and do not ask whether to promote or emphasize it unless the participant's wording clearly asks for that.

## Workspace Shape

Each configured vault root is one relationship workspace:

```text
DMSUM.md
participants.md
preferences/{participant}.md
interactions/YYYY/MM/DD/I000001.md
wiki-updates/YYYY/MM/DD/W000001.md
conflicts/YYYY/MM/DD/C000001.md
wiki/index.md
wiki/{entities,topics,concepts,synthesis}/
assets/YYYY/
log.md
STATUS.md
```

Do not mix relationship meaning across workspaces. Dave-Lisa and Dave-Jeff should develop separately unless a future version explicitly supports sharing.

In routed local mode, the registry lives outside the workspaces and maps owner-scoped contact handles to relationship IDs. For example, Dave can have `@lisa` and `@lisa-work`; those handles may point to different relationship workspaces even if both display names are Lisa. Use explicit `relationshipId` when a request cannot be resolved from one unambiguous handle or current relationship context.

## Local Git Sync

For the local Git-sync prototype, treat each relationship workspace as its own Git repo. Dave-Lisa and Dave-Mike must remain separate worktrees, separate remotes, and separate histories.

Git provides the durable sync mechanics: commits, diffs, merges, and conflict markers. The transport is replaceable. The first practical transport is Git over Tailscale plus ordinary Windows OpenSSH; Iroh may later move Git material without changing the workspace contract.

Use `dmsum sync status` to distinguish a clean worktree from local changes waiting for sync. Use `dmsum sync doctor` when the local Git setup behaves oddly or a relationship workspace does not appear to sync.

When the MCP server exposes sync tools, prefer `sync_status`, `sync_once`, `sync_doctor`, and `sync_resolve` over shell commands. This matters on agent surfaces where shell writes are sandboxed but MCP tools can write through the Mem·Sum kernel. Use stdio MCP when the client can launch a local command; use the localhost HTTP transport when the client only accepts a URL connector. Use `sync_once` after a successful content update when the participant expects the change to be shared.

When sync reports a conflict, do not guess silently. Read the conflicted markdown and Git diff, preserve both participants' durable meaning, carry forward non-conflicting new pages, reconcile duplicate or overlapping pages, update index links when needed, remove conflict markers, then run `dmsum sync resolve --relationship ...`. If the conflict is a real disagreement rather than a wording collision, keep both positions and make the disagreement visible in the relevant wiki page.

## Hosted Direction

In the hosted v2 architecture, Supabase/Postgres is the authoritative relationship graph and Vercel exposes the remote MCP/API. Agents do not need full local replicas. They should read selected pages, preferences, recent updates, and relevant interactions; build a private draft iteratively; then publish one coherent batch update.

Hosted writes should use atomic Postgres transactions and optimistic version checks. A multi-page update either commits all page, preference, resource, attention, and update records together or commits none. If a page changed after the agent read it, the batch is rejected; the agent rereads the latest graph, revises its private draft, and tries again.

`STATUS.md` is local-only advisory coordination. Hosted correctness belongs to database transactions, version checks, relationship membership checks, and Row Level Security.

## Kernel Conflicts

For MCP writes, `wikiWrites` and `preferenceWrites` may include `baseHash`, the SHA-256 hash returned by `read_file`. If a target has changed since that hash, `commit_wiki_update` does not overwrite it. The current content and proposed content are preserved as a conflict record under `conflicts/YYYY/MM/DD/`.

Use `list_conflicts` to see unresolved kernel conflicts, `read_conflict` to inspect the current and proposed content, and `resolve_conflict` to write harmonized markdown back to the original target. This is local prototype conflict machinery. Hosted Mem·Sum should prefer transaction-backed stale batch rejection, reread, private revision, and atomic retry.

## Agent Behavior

Treat `+sum`, `+dm`, and `+dmsum` as explicit invocation signals. For durable write/update acts, preserve the participant's exact wording in `commit_interaction` before updating the wiki. Read-only retrieval requests should normally stay read-only; commit only when the turn adds durable material, expresses a durable preference, directs attention, supplies a source, or asks to change the relationship workspace. In routed mode, let `commit_interaction` infer the relationship only when the raw interaction contains one unambiguous owner-scoped `@contact`; otherwise pass `relationshipId` explicitly or ask one concise clarification. Use `commit_wiki_update` as soon as practical to integrate durable raw interactions into the relationship wiki graph, participant preference files, or both.

Interpret natural language flexibly. `tell`, `ask`, `remember`, `add`, `note`, `save`, and `show` are ordinary participant language, not server-side categories.

Before a wiki update, read `wiki/index.md`, read the likely target wiki page, and check nearby wiki pages when the interaction introduces a reusable entity, place, animal, organization, account, vendor, resource, recurring preference, procedure, open question, or concept.

Create supporting wiki pages when material is likely to recur, would overload a hub wiki page, or should be reusable from future plans. Ask the participant only when the intended meaning, sensitivity, or graph placement is genuinely ambiguous.

When a new supporting wiki page is created or a connection becomes important, update `wiki/index.md` in the same wiki update.

If a participant states a durable display or handling preference, update `preferences/{participant}.md` with `preferenceWrites`. Preferences are relationship-scoped; do not assume a display rule from one relationship workspace automatically applies to another.

Before answering a participant-facing request to show, summarize, recap, revisit, or explain saved material, read the current participant's preference file if it exists. Apply those preferences before generic presentation rules. Do this in every new agent session; do not rely on chat memory or platform memory to remember display rules.

Ground ordinary participant-facing retrieval in the current vault contract, the current participant preference file, `wiki/`, `wiki-updates/`, and relevant `interactions/`. Older experimental runtime locations outside those roots are audit or historical material; do not let them guide ordinary replies unless the participant asks for technical or historical context.

## Presentation Style

Participant-facing chat should be natural, low-friction, and grounded in the participant's recognizable object: the trip, the cat instructions, the Lisa-isms collection, the saved source, the open question, or whatever name the participant is already using. Say what changed or what matters now. Keep it concise unless the participant asks for detail.

Hide implementation details by default. Do not show internal IDs, paths, timestamps, audit/provenance links, MCP tool names, storage mechanics, or local markdown/file links unless the participant asks for sources, files, technical context, or the exact audit trail. External web links are different: include them when they are useful action handles for the current request or when participant preferences call for them.

Participant preferences override this generic presentation guidance. Before showing, summarizing, recapping, revisiting, or explaining saved material, read the current participant's preference file if it exists.

`🥟` is an optional lightweight brand mark when the surface handles emoji. Small labels are also optional. The answer must still make sense without emoji or labels.

Keep wiki graph markdown plain, durable, and factual unless the participant asks for a styled artifact. Provenance links and References entries may contain audit handles, but ordinary body prose should remain human-readable.

## Showing The Graph

When a participant asks for the shape of the wiki graph, answer with a human-purpose map rather than a raw directory listing. Read `wiki/index.md`, then enough linked wiki pages to write one-line descriptions and infer practical groupings.

Include local markdown/file links only when the participant asks to inspect files or asks for technical/source detail. Do not expose raw ontology categories unless asked for technical structure. Do not show internal interaction IDs, wiki update IDs, paths, timestamps, or audit links by default.

## Editing Rule

Use `apply_patch` for repository edits. Do not alter generated or runtime vault state unless the task explicitly concerns the local test vault.


