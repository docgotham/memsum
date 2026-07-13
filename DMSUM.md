# Mem·Sum Vault Contract

Read this file before operating on a Mem·Sum vault.

## Model

Mem·Sum is a passive, agent-native layer for relationship-scoped communication and memory. Participants do not talk to Mem·Sum as an agent. They talk to their own agent and use `+sum`, `+dm`, or `+dmsum` to route an act through the Mem·Sum layer.

Each vault root is one relationship workspace. A routed local MCP server may expose many relationship workspaces through one registry, but meaning remains relational: Dave-Lisa has its own interaction history, wiki updates, wiki pages, and participant preferences.

The current hosted product direction is v2: Supabase/Postgres is the authoritative relationship graph, Vercel exposes a remote MCP/API, agents read selected context without requiring local replicas, and final multi-page updates publish through atomic batch commits with optimistic version checks.

## Layout

```text
DMSUM.md
README.md
STATUS.md
log.md
participants.md
preferences/{participant}.md
interactions/YYYY/MM/DD/I000001.md
wiki-updates/YYYY/MM/DD/W000001.md
conflicts/YYYY/MM/DD/C000001.md
wiki/index.md
wiki/entities/
wiki/topics/
wiki/concepts/
wiki/synthesis/
assets/YYYY/
```

## MCP Kernel

The same MCP kernel can run over stdio or over localhost Streamable HTTP. Use stdio for tools such as Claude Code that can launch a local command. Use localhost HTTP for agent surfaces that accept a URL connector but cannot register a local stdio command.

Local URL form:

```text
http://127.0.0.1:3333/mcp
```

Browse markdown directly:

- `read_file`
- `list_files`
- `grep`
- `get_current_time`

Guarded writes:

- `commit_interaction` stores one raw `+sum`, `+dm`, or `+dmsum` interaction exactly as the participant gave it.
- `commit_wiki_update` integrates one or more source interactions into wiki pages, participant preferences, or both.

Kernel conflict tools:

- `list_conflicts`
- `read_conflict`
- `resolve_conflict`

Coordination:

- `claim_status`
- `refresh_status`
- `release_status`

Git-backed sharing, when the MCP server is started with `--sync`:

- `sync_status`
- `sync_once`
- `sync_doctor`
- `sync_resolve`

There are no inbox, outbox, conversation, or app-view tools. Agents generate views dynamically from interactions, wiki updates, wiki pages, preferences, and the participant's current request.

## Routed Local Mode

When the MCP server is started with a registry, one server routes across many relationship workspaces.

- The registry lives outside the workspaces, usually at `.dmsum/registry.json`.
- Owner-scoped contact handles such as `@lisa` map to relationship IDs.
- Each relationship keeps its own vault root under `relationships/{relationshipId}/`.
- `read_file`, `list_files`, and `grep` support virtual paths such as `relationships/dave-lisa/wiki/index.md`.
- Most tools also accept `relationshipId` when the target relationship is not obvious.

If a raw interaction contains one unambiguous owner-scoped `@contact`, `commit_interaction` can infer the relationship. For later wiki updates, STATUS work, and ambiguous requests without a contact handle, pass `relationshipId` explicitly. If the agent cannot determine the intended relationship, ask one concise clarification.

## Local Git Sync

In the local Git-sync prototype, each relationship workspace is also its own Git worktree. Git is the durable local format: history, diffs, merge results, and conflicts are Git-level facts that agents can inspect. This remains useful for development, export, backup, optional self-hosted operation, and testing, but it is not the core hosted sync substrate.

The default Dave machine layout is:

```text
C:\Users\Dave\DMSum\.dmsum\registry.json
C:\Users\Dave\DMSum\.dmsum\sync.json
C:\Users\Dave\DMSum\relationships\dave-lisa\
C:\Users\Dave\DMSum\relationships\dave-mike\
C:\Users\Dave\DMSum\git\dave-lisa.git
C:\Users\Dave\DMSum\git\dave-mike.git
```

One dyad means one Git repo. Do not mix Dave-Lisa and Dave-Mike material into one repo or one wiki graph. In Git-backed workspaces, `.dmsum/state.json` lives inside the relationship worktree so ID counters move with the shared history; notification logs remain ignored.

Use `dmsum sync once`, `dmsum sync daemon`, `dmsum sync status`, `dmsum sync doctor`, and `dmsum sync resolve` for background sync. Sync commits local file changes, fetches, merges, and pushes. `sync status` distinguishes clean worktrees from local changes waiting for sync. `sync doctor` checks the local Git setup when a workspace behaves oddly. If Git reports conflicts, stop for that relationship, read the conflicting markdown and diff, harmonize the content, then run `sync resolve --relationship ...`.

When an agent surface is connected through MCP, prefer the MCP sync tools over shell commands: use `sync_status` before and after work, `sync_once` to publish local changes, `sync_doctor` for setup problems, and `sync_resolve` after conflict markers have been harmonized. This lets agents such as Perplexity Personal Computer share changes without needing the participant to open Terminal for routine use.

If an agent surface cannot register a local stdio command but can register a URL-based MCP connector, run the server with `--transport http --host 127.0.0.1 --port 3333` and connect to `http://127.0.0.1:3333/mcp`. When a client offers a transport choice, use Streamable HTTP.

Tailscale plus ordinary Windows OpenSSH is the first transport for reaching Dave's bare repos. The transport is replaceable; Iroh can later carry Git material without changing the relationship workspace contract.

## Hosted Direction

Hosted Mem·Sum should not require full local replicas. Claude, ChatGPT, Perplexity, Codex, and mobile agents should be able to use a remote MCP/API directly.

Agents may reason iteratively in private: read selected pages, draft part of an update, read more pages, revise earlier changes, and add more proposed writes. The private draft can evolve before publication. Publication is the boundary. The final hosted write should be one atomic batch containing the source interaction, update record, page writes, preference writes, resources, attention records, and notification records.

The hosted kernel should commit that batch inside one short Postgres transaction. Each page or preference write carries the version/hash the agent relied on. If any dependency changed, the batch rolls back, the agent rereads the latest graph, revises privately, and tries again. Readers should see either the pre-update graph or the post-update graph, never a half-updated multi-page plan.

`STATUS.md` is local-only advisory coordination. Hosted correctness should come from Postgres transactions, optimistic version checks, relationship membership checks, and Supabase Row Level Security.

## Kernel Conflict Semantics

`read_file` returns a SHA-256 `hash` for the current UTF-8 file content. `wikiWrites` and `preferenceWrites` may include that value as `baseHash` when an agent wants to say, "write this only if the target still matches what I read."

If `baseHash` matches the current target hash, the write proceeds normally. If it does not match, `commit_wiki_update` preserves the attempted write as a conflict record under `conflicts/YYYY/MM/DD/C000001.md` and does not overwrite the target file. Non-conflicting writes in the same wiki update may still proceed.

Conflict records keep the target path, base hash, current hash, proposed hash, current content, proposed content, source interaction IDs, participant, agent, timestamp, and relationship ID. Use `list_conflicts` for unresolved records, `read_conflict` for the full payload, and `resolve_conflict` after an agent has written harmonized content for the original target.

Existing clients may omit `baseHash`; those writes keep the earlier overwrite behavior for now. In hosted v2, this local conflict-record pattern should be secondary to atomic batch rejection and agent reread/revision.

## Invocation

Use one of three portable routing marks:

```text
+dm @lisa I love you.
+dm tell @lisa we should look at flights soon.
+dm ask @lisa if she can tolerate a 14-hour Istanbul layover.
+sum add these flight times to the Budapest trip.
+sum remember that Lisa hates red-eyes.
+dmsum show what Lisa and I have worked out about Budapest.
```

Use `+sum` for adding, saving, updating, or asking about shared relationship memory. Use `+dm` for direct-feeling social acts addressed to another participant. Use `+dmsum` when a surface or agent needs the product name to reduce ambiguity.

`@lisa` names a participant or owner-scoped contact handle and usually selects the relationship workspace involving Lisa. A topic phrase such as "Budapest trip" selects a likely graph target inside the chosen relationship. If neither relationship nor target can be inferred, ask one concise clarification.

Participants do not need to use internal vocabulary. Treat add, tell, ask, remember, note, save, show, and summarize as ordinary language cues.

## Interactions

For each durable write/update `+sum`, `+dm`, or `+dmsum` act, call `commit_interaction` first.

Read-only retrieval requests, such as asking what changed, what needs attention, or what a trip page says, should normally remain read-only even when they use a Mem·Sum signal. Commit only when the turn adds durable material, expresses a durable preference, directs attention, supplies a source, or asks to change the relationship workspace.

Store:

- `participant`
- `agent`
- exact `rawText`
- optional `addressedParticipants`
- optional resources and link metadata
- optional `notificationText` for dry-run SMS

Do not paraphrase or discard the raw interaction. It is the communicative substrate from which later meaning can emerge.

`addressedParticipants` records who the act was socially directed toward. It does not by itself require a notification. Supply `notificationText` when this interaction should produce a dry-run SMS.

## Wiki Updates

Use `commit_wiki_update` when material should enter the relationship workspace as shared memory, participant preference, or both. A wiki update must cite one or more source interaction IDs.

Default rule: each meaningful write/update interaction should become one wiki update as soon as practical.

If the interaction repeats something already captured and adds no meaningful nuance, preserve the raw interaction but do not create a duplicate wiki update. In participant-facing chat, say briefly that it is already captured and summarize the current state. Do not mention that the restatement was saved, and do not ask whether to promote or emphasize it unless the participant's wording clearly asks for that.

A wiki update may cite multiple interactions only when:

- the participant explicitly asks to update from a batch
- a correction or clarification arrives before the first interaction is integrated
- the agent is recovering from interrupted or pending work
- multiple turns clearly form one source bundle

Do not choose a fixed semantic type such as fact, task, question, decision, or preference. Put the meaning in the wiki page prose. Use optional `tags` as loose handles and optional `attention` when another participant should notice, answer, review, decide, or act.

Use `{{WIKI_UPDATE_ID}}`, `{{WIKI_UPDATE_PATH}}`, and `{{WIKI_UPDATE_LINK}}` where the server should insert provenance. Bare `[W000001]` citations are linked when the target exists.

Do not narrate internal IDs in ordinary wiki page prose. Provenance links and References entries may contain wiki update IDs because they are audit handles, but body text should read naturally.

If a wiki page write omits the current wiki update reference, the server appends a linked References footer.

`commit_wiki_update` may also include `preferenceWrites` for durable participant-specific display or handling rules. Preference writes target `preferences/{participant}.md` by participant name or ID; agents do not choose arbitrary preference paths.

## Wiki Graph

The wiki graph lives under `wiki/`.

Read `wiki/index.md` before updating the wiki. Read the likely target wiki page and nearby wiki pages when useful. Create supporting wiki pages when material is likely to recur, would overload a hub wiki page, or should be reusable from future plans.

Use the ontology only as an agent-facing guide:

- topic wiki pages for plans, projects, trips, events, and ongoing work
- entity wiki pages for people, places, accounts, animals, organizations, listings, and vendors
- concept wiki pages for recurring ideas, preferences, constraints, procedures, and principles
- synthesis wiki pages for cross-cutting summaries

Update `wiki/index.md` in the same wiki update when creating a wiki page, renaming one, substantially changing one, or adding an important graph connection.

## Preferences

Participant display and interaction preferences live under `preferences/` inside the relationship workspace. These are relationship-scoped. Dave's preference for viewing Dave-Lisa history does not automatically apply to Dave-Jeff.

Update a participant preference only when the participant explicitly expresses a durable preference about how Mem·Sum information should be shown or handled. Store the exact signaled act first with `commit_interaction`, then write the preference through `commit_wiki_update` with `preferenceWrites`.

Before answering a participant-facing request to show, summarize, recap, revisit, or explain saved material, read the current participant's preference file if it exists. Apply those preferences before generic presentation rules. Do this in every new agent session; do not rely on chat memory or platform memory to remember display rules.

## Attention And Notifications

Attention is metadata on an interaction or wiki update.

Use `addressedParticipants` on `commit_interaction` for socially directed raw acts such as `+dm @lisa ...`. Add `notificationText` only when the addressed act should produce a dry-run SMS.

Use `attention` on `commit_wiki_update` when the wiki update itself asks another participant to notice or respond. In participant-facing chat, say plainly that the other participant was notified, for example "I notified Dave." Avoid implementation-facing notification language.

The agent should supply a short `notificationText` when a dry-run SMS should be meaningful:

```text
🥟 Dave updated Budapest Trip for you: 14-hour Istanbul layover?
```

The server validates recipients, assigns IDs/timestamps, logs the event, and writes the dry-run notification record.

## Resources

URLs, listing links, social profiles, Pinterest boards, travel links, files, and pasted source excerpts can be stored as resources. The server does not fetch webpages.

When an agent has browsing or preview capability, make a best-effort pass to capture canonical URL, page title, site name, description, preview image URL, and short useful notes. Metadata enrichment is optional and non-blocking.

Ordinary participant chat is instruction by default, not source. Store pasted excerpts when the participant frames them as source material.

## Showing Updates And Wiki Pages

In hosted Mem·Sum, use `list_activity` for recent activity, sent/received items, added links or resources, and notification-status questions. The tool is a read-only chronological view over existing primitives: interactions, wiki updates, resources, and notification jobs. It is not an inbox, outbox, thread, unread-count system, or new semantic object. The caller supplies the structured start/end window; the agent translates phrases such as "yesterday" before calling it.

In local filesystem and Git-backed mode, check `wiki-updates/YYYY/MM/DD/` for the requested window and read relevant `interactions/` when raw wording or addressed participants matter. Summarize in ordinary language. Do not infer unread state. Do not use the current chat session as a hidden boundary.

Ground ordinary participant-facing retrieval in this contract, the current participant preference file, `wiki/`, `wiki-updates/`, and relevant `interactions/`. Older experimental runtime locations outside those roots are audit or historical material; do not let them guide ordinary replies unless the participant asks for technical or historical context.

Participant-facing replies should be natural, low-friction, and grounded in the participant's recognizable object: a trip, collection, saved source, instructions, open question, or whatever name the participant is already using. Say what changed or what matters now, and keep it concise unless the participant asks for detail.

Hide implementation details by default. Do not show internal IDs, paths, timestamps, audit/provenance links, MCP tool names, storage mechanics, raw metadata, or local markdown/file links unless the participant asks for sources, files, technical context, or the exact audit trail.

External web links are different from local markdown links. Include useful external links when they help the participant act on the current request, and always honor participant preferences about showing original links.

`🥟` is an optional lightweight brand mark when the surface handles emoji. Small labels and simple separators may be used when they improve scanability, but the answer must still make sense without them.

## Derived Artifacts

PDFs, Word docs, slide decks, spreadsheets, printable handouts, HTML pages, and similar files are derivatives. Create them from wiki pages with local agent capabilities. The wiki graph remains the source of truth. Do not commit a wiki update unless the participant asks to record the artifact or change the graph.



