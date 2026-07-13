import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfig, participantsFromNames } from "../src/config.js";
import { createToolHandlers } from "../src/mcp.js";
import { createRegistry, configFromRelationship } from "../src/registry.js";
import { RoutedDmsumVault } from "../src/router.js";
import { initializeLocalGitSync, resolveSync, syncDoctor, syncOnce, syncPathForDataRoot, syncStatus } from "../src/sync.js";
import type { DmsumConfig, SyncRunResult } from "../src/types.js";
import { DmsumVault, initializeVault } from "../src/vault.js";
import { renderAuditPage } from "../src/web.js";

const fixedNow = new Date("2026-04-27T19:34:00.000Z");

interface TestHarness {
  root: string;
  config: DmsumConfig;
  vault: DmsumVault;
}

async function createHarness(now: () => Date = () => fixedNow): Promise<TestHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dmsum-"));
  const config = createConfig({
    relationshipId: "dave-lisa",
    vaultRoot: path.join(root, "relationships", "dave-lisa"),
    stateDir: path.join(root, ".dmsum", "dave-lisa"),
    timezone: "America/Los_Angeles",
    participants: participantsFromNames(["Dave", "Lisa"])
  });
  await initializeVault({ config, now });
  return {
    root,
    config,
    vault: new DmsumVault(config, { now })
  };
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function resultOf<T>(toolResult: { structuredContent?: Record<string, unknown> }): T {
  return toolResult.structuredContent?.result as T;
}

describe("Mem·Sum relationship workspace", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await fs.rm(harness.root, { recursive: true, force: true });
  });

  it("initializes a relationship-scoped local workspace", async () => {
    const entries = await harness.vault.listFiles(".");
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "DMSUM.md",
      "README.md",
      "STATUS.md",
      "assets",
      "interactions",
      "log.md",
      "participants.md",
      "preferences",
      "wiki",
      "wiki-updates"
    ]);
    await expect(fs.stat(path.join(harness.config.vaultRoot, "interactions", "2026", "04", "27"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(harness.config.vaultRoot, "wiki-updates", "2026", "04", "27"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(harness.config.vaultRoot, "wiki", "index.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(harness.config.vaultRoot, "preferences", "dave.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(harness.config.vaultRoot, "preferences", "lisa.md"))).resolves.toBeTruthy();
  });

  it("exposes the relationship-first MCP surface", () => {
    const handlers = createToolHandlers(harness.vault);
    expect(Object.keys(handlers).sort()).toEqual([
      "claim_status",
      "commit_interaction",
      "commit_wiki_update",
      "get_current_time",
      "grep",
      "list_conflicts",
      "list_files",
      "read_conflict",
      "read_file",
      "refresh_status",
      "release_status",
      "resolve_conflict"
    ]);
    expect(handlers).not.toHaveProperty("commit_sum_update");
    expect(handlers).not.toHaveProperty("write_file");
  });

  it("commits raw interactions with exact text and addressed notifications", async () => {
    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dm @lisa I love you.",
      addressedParticipants: ["@lisa"],
      notificationText: "🥟 Dave sent you something through DM·Sum."
    });

    expect(interaction).toMatchObject({
      interactionId: "I000001",
      timestamp: "2026-04-27 12:34",
      interactionPath: "interactions/2026/04/27/I000001.md",
      relationshipId: "dave-lisa",
      participant: { id: "dave" },
      addressedParticipants: ["lisa"],
      notifications: 1
    });

    const file = await readText(path.join(harness.config.vaultRoot, "interactions", "2026", "04", "27", "I000001.md"));
    expect(file).toContain("id: I000001");
    expect(file).toContain('relationshipId: "dave-lisa"');
    expect(file).toContain('addressedParticipants: ["lisa"]');
    expect(file).toContain("+dm @lisa I love you.");

    const notifications = (await readText(path.join(harness.config.stateDir, "notifications.jsonl")))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceKind: "interaction",
      sourceId: "I000001",
      relationshipId: "dave-lisa",
      participantId: "dave",
      recipientId: "lisa",
      body: "🥟 Dave sent you something through DM·Sum."
    });
  });

  it("stores addressed participants without notifying unless notification text is supplied", async () => {
    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum @lisa add these flight times to the trip workspace.",
      addressedParticipants: ["Lisa"]
    });

    expect(interaction).toMatchObject({
      addressedParticipants: ["lisa"],
      notifications: 0
    });
    await expect(fs.stat(path.join(harness.config.stateDir, "notifications.jsonl"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("commits wiki updates from source interactions into relationship wiki pages", async () => {
    await fs.mkdir(harness.config.stateDir, { recursive: true });
    await fs.writeFile(
      path.join(harness.config.stateDir, "state.json"),
      `${JSON.stringify({ nextInteractionNumber: 7, nextWikiUpdateNumber: 42 }, null, 2)}\n`,
      "utf8"
    );
    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dm ask @lisa if she can tolerate a 14-hour Istanbul layover."
    });

    const update = await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      tags: ["budapest-trip", "open-question"],
      attention: ["Lisa"],
      interactionIds: [interaction.interactionId],
      notificationText: "🥟 Dave updated Budapest Trip for you: 14-hour Istanbul layover?",
      displayText:
        "Dave updated Budapest Trip with a question asking whether Lisa could tolerate a 14-hour Istanbul layover if the tickets were substantially cheaper.",
      resources: [
        {
          kind: "url",
          url: "https://example.com/flights",
          title: "Example flight search"
        }
      ],
      wikiWrites: [
        {
          path: "wiki/topics/budapest-trip.md",
          title: "Budapest Trip",
          content:
            "# Budapest Trip\n\n## Open Questions\n\n- Would Lisa tolerate a 14-hour Istanbul layover if it made the flights substantially cheaper? [{{WIKI_UPDATE_ID}}]\n"
        },
        {
          path: "wiki/index.md",
          title: "Wiki Index",
          content: "# Wiki Index\n\n- [Budapest Trip](topics/budapest-trip.md) [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });

    expect(update).toMatchObject({
      updateId: "W000042",
      timestamp: "2026-04-27 12:34",
      updatePath: "wiki-updates/2026/04/27/W000042.md",
      relationshipId: "dave-lisa",
      participant: { id: "dave" },
      tags: ["budapest-trip", "open-question"],
      attention: ["lisa"],
      interactionIds: ["I000007"],
      wikiPaths: ["wiki/topics/budapest-trip.md", "wiki/index.md"],
      notifications: 1
    });

    const updateFile = await readText(path.join(harness.config.vaultRoot, "wiki-updates", "2026", "04", "27", "W000042.md"));
    expect(updateFile).toContain("id: W000042");
    expect(updateFile).toContain('relationshipId: "dave-lisa"');
    expect(updateFile).toContain('kind: "wiki_update"');
    expect(updateFile).toContain('interactionIds: ["I000007"]');
    expect(updateFile).toContain("[I000007](../../../../interactions/2026/04/27/I000007.md)");
    expect(updateFile).toContain("## Wiki Changes");
    expect(updateFile).toContain("Example flight search");

    const sum = await readText(path.join(harness.config.vaultRoot, "wiki", "topics", "budapest-trip.md"));
    expect(sum).toContain("[W000042](../../wiki-updates/2026/04/27/W000042.md)");
    expect(sum).not.toContain("{{WIKI_UPDATE_ID}}");

    const index = await readText(path.join(harness.config.vaultRoot, "wiki", "index.md"));
    expect(index).toContain("[W000042](../wiki-updates/2026/04/27/W000042.md)");

    const notifications = (await readText(path.join(harness.config.stateDir, "notifications.jsonl")))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      sourceKind: "wiki_update",
      sourceId: "W000042",
      recipientId: "lisa",
      body: "🥟 Dave updated Budapest Trip for you: 14-hour Istanbul layover?"
    });

    const state = JSON.parse(await readText(path.join(harness.config.stateDir, "state.json")));
    expect(state).toEqual({ nextInteractionNumber: 8, nextWikiUpdateNumber: 43, nextConflictNumber: 1 });
  });

  it("commits sourced preference changes without requiring a wiki write", async () => {
    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dmsum when I ask to see past interactions, show ten by default."
    });

    const update = await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      tags: ["display-preference"],
      interactionIds: [interaction.interactionId],
      displayText:
        "Dave updated a display preference saying past-interaction views should show ten items by default.",
      preferenceWrites: [
        {
          participant: "Dave",
          content:
            "# Dave Preferences\n\n## Display\n\n- When Dave asks to see past interactions, show ten items by default. [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });

    expect(update).toMatchObject({
      updateId: "W000001",
      preferencePaths: ["preferences/dave.md"],
      wikiPaths: []
    });
    expect(update.preferenceWrites).toEqual([{ path: "preferences/dave.md", bytes: expect.any(Number) }]);

    const preference = await readText(path.join(harness.config.vaultRoot, "preferences", "dave.md"));
    expect(preference).toContain("show ten items by default");
    expect(preference).toContain("[W000001](../wiki-updates/2026/04/27/W000001.md)");

    const updateFile = await readText(path.join(harness.config.vaultRoot, "wiki-updates", "2026", "04", "27", "W000001.md"));
    expect(updateFile).toContain("## Preference Changes");
    expect(updateFile).toContain("preferences/dave.md");
  });

  it("uses base hashes to preserve stale wiki writes as resolvable conflicts", async () => {
    const baselineInteraction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum create a kernel conflict baseline."
    });
    await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [baselineInteraction.interactionId],
      displayText: "Dave created the kernel conflict test page.",
      wikiWrites: [
        {
          path: "wiki/topics/kernel-conflict.md",
          title: "Kernel Conflict",
          content: "# Kernel Conflict\n\nBaseline version. [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });

    const baseline = await harness.vault.readFile("wiki/topics/kernel-conflict.md");
    const matchingInteraction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum update the conflict page from the observed baseline."
    });
    const matchingUpdate = await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [matchingInteraction.interactionId],
      displayText: "Dave updated the kernel conflict test page from a matching base hash.",
      wikiWrites: [
        {
          path: "wiki/topics/kernel-conflict.md",
          title: "Kernel Conflict",
          baseHash: baseline.hash,
          content: "# Kernel Conflict\n\nCurrent version. [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });
    expect(matchingUpdate.conflictPaths).toEqual([]);

    const staleInteraction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum add a competing edit based on the old page."
    });
    const staleUpdate = await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [staleInteraction.interactionId],
      displayText: "Dave proposed a competing kernel conflict page update.",
      wikiWrites: [
        {
          path: "wiki/topics/kernel-conflict.md",
          title: "Kernel Conflict",
          baseHash: baseline.hash,
          content: "# Kernel Conflict\n\nProposed competing version. [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });

    expect(staleUpdate).toMatchObject({
      updateId: "W000003",
      wikiPaths: [],
      conflictPaths: ["conflicts/2026/04/27/C000001.md"],
      wikiWrites: [],
      conflicts: [
        expect.objectContaining({
          conflictId: "C000001",
          status: "open",
          targetPath: "wiki/topics/kernel-conflict.md"
        })
      ]
    });

    const unchanged = await harness.vault.readFile("wiki/topics/kernel-conflict.md");
    expect(unchanged.content).toContain("Current version");
    expect(unchanged.content).not.toContain("Proposed competing version");

    const openConflicts = await harness.vault.listConflicts();
    expect(openConflicts).toEqual([
      expect.objectContaining({
        conflictId: "C000001",
        conflictPath: "conflicts/2026/04/27/C000001.md",
        status: "open",
        targetKind: "wiki",
        targetPath: "wiki/topics/kernel-conflict.md"
      })
    ]);

    const conflict = await harness.vault.readConflict({ conflictId: "C000001" });
    expect(conflict.currentContent).toContain("Current version");
    expect(conflict.proposedContent).toContain("Proposed competing version");
    expect(conflict.content).toContain("## Current Content");
    expect(conflict.content).toContain("## Proposed Content");

    const resolved = await harness.vault.resolveConflict({
      conflictId: "C000001",
      participant: "Dave",
      agent: "Dave-OpenAI",
      content: "# Kernel Conflict\n\nCurrent version.\n\nProposed competing version.\n"
    });
    expect(resolved).toMatchObject({
      conflictId: "C000001",
      conflictPath: "conflicts/2026/04/27/C000001.md",
      targetPath: "wiki/topics/kernel-conflict.md"
    });

    const harmonized = await harness.vault.readFile("wiki/topics/kernel-conflict.md");
    expect(harmonized.content).toContain("Current version");
    expect(harmonized.content).toContain("Proposed competing version");
    expect(await harness.vault.listConflicts()).toEqual([]);
    expect(await harness.vault.listConflicts({ includeResolved: true })).toEqual([
      expect.objectContaining({
        conflictId: "C000001",
        status: "resolved",
        targetPath: "wiki/topics/kernel-conflict.md"
      })
    ]);
  });

  it("migrates old state.json counters into the wiki update counter", async () => {
    await fs.writeFile(
      path.join(harness.config.stateDir, "state.json"),
      `${JSON.stringify({ nextUpdateNumber: 12 }, null, 2)}\n`,
      "utf8"
    );
    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum add a migration smoke test."
    });
    const update = await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [interaction.interactionId],
      displayText: "Dave updated the test page with a migration smoke test.",
      wikiWrites: [{ path: "wiki/topics/test.md", title: "Test", content: "# Test\n\nMigration smoke test. [{{WIKI_UPDATE_ID}}]\n" }]
    });
    expect(update.updateId).toBe("W000012");
  });

  it("rejects malformed relationship commits and protected write targets", async () => {
    await expect(harness.vault.readFile("../outside.md")).rejects.toThrow(/relative|traversal|escapes/i);
    await expect(
      harness.vault.commitInteraction({
        participant: "Unknown",
        agent: "Dave-OpenAI",
        rawText: "+dm @lisa hi"
      })
    ).rejects.toThrow(/Unknown participant/i);
    await expect(
      harness.vault.commitInteraction({
        participant: "Dave",
        agent: "Dave-OpenAI",
        rawText: ""
      })
    ).rejects.toThrow(/rawText/i);
    await expect(
      harness.vault.commitWikiUpdate({
        participant: "Dave",
        agent: "Dave-OpenAI",
        interactionIds: ["I999999"],
        displayText: "bad",
        wikiWrites: [{ path: "wiki/topics/test.md", title: "Test", content: "bad" }]
      })
    ).rejects.toThrow(/Unknown source interactionId/i);
    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum add bad paths."
    });
    await expect(
      harness.vault.commitWikiUpdate({
        participant: "Dave",
        agent: "Dave-OpenAI",
        interactionIds: [interaction.interactionId],
        displayText: "bad",
        wikiWrites: []
      })
    ).rejects.toThrow(/at least one wiki or preference write/i);
    await expect(
      harness.vault.commitWikiUpdate({
        participant: "Dave",
        agent: "Dave-OpenAI",
        interactionIds: [interaction.interactionId],
        displayText: "bad",
        wikiWrites: [{ path: "participants.md", title: "Participants", content: "bad" }]
      })
    ).rejects.toThrow(/wiki paths/i);
    await expect(
      harness.vault.commitWikiUpdate({
        participant: "Dave",
        agent: "Dave-OpenAI",
        interactionIds: [interaction.interactionId],
        displayText: "bad",
        wikiWrites: [{ path: "wiki/other/test.md", title: "Test", content: "bad" }]
      })
    ).rejects.toThrow(/wiki\/entities/i);
  });

  it("enforces STATUS.md claims while allowing the holder to continue work", async () => {
    const claim = await harness.vault.claimStatus("maintenance", "test-agent");
    await expect(
      harness.vault.commitInteraction({
        participant: "Dave",
        agent: "Dave-OpenAI",
        rawText: "+sum this should be blocked."
      })
    ).rejects.toThrow(/locked/i);

    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dmsum claim holder can write.",
      claimToken: claim.token
    });
    const update = await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [interaction.interactionId],
      displayText: "The claim holder updated the test page with a STATUS smoke test.",
      wikiWrites: [{ path: "wiki/topics/test.md", title: "Test", content: "# Test\n\nClaim holder update. [{{WIKI_UPDATE_ID}}]\n" }],
      claimToken: claim.token
    });
    expect(update.updateId).toBe("W000001");

    const refreshed = await harness.vault.refreshStatus(claim.token);
    expect(refreshed.token).toBe(claim.token);
    await expect(harness.vault.claimStatus("another update")).rejects.toThrow(/active STATUS/i);
    await expect(harness.vault.releaseStatus("wrong-token")).rejects.toThrow(/does not match/i);
    await expect(harness.vault.releaseStatus(claim.token)).resolves.toEqual({ released: true });
  });

  it("supports MCP handlers for interaction and wiki update commits", async () => {
    const handlers = createToolHandlers(harness.vault);
    const interactionResult = await handlers.commit_interaction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dm @lisa the date is the 14th.",
      addressedParticipants: ["Lisa"]
    });
    const interaction = resultOf<{ interactionId: string }>(interactionResult);

    const updateResult = await handlers.commit_wiki_update({
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [interaction.interactionId],
      displayText: "Dave updated the Joshua Tree page with the trip date.",
      wikiWrites: [
        {
          path: "wiki/topics/joshua-tree.md",
          title: "Joshua Tree",
          content: "# Joshua Tree\n\nThe date is the 14th. [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });
    const update = resultOf<{ updateId: string; wikiPaths: string[] }>(updateResult);
    expect(update).toMatchObject({
      updateId: "W000001",
      wikiPaths: ["wiki/topics/joshua-tree.md"]
    });

    const page = resultOf<{ content: string }>(await handlers.read_file({ path: "wiki/topics/joshua-tree.md" }));
    expect(page.content).toContain("[W000001]");
  });

  it("keeps removed MCP tool names out of agent-facing docs", async () => {
    const retiredTerm = ["fo", "ld"].join("");
    const forbidden = [
      "write_file",
      `record_${retiredTerm}_run`,
      `commit_${retiredTerm}`,
      "commit_sum_update",
      `${retiredTerm} backlog`,
      `${retiredTerm}References`,
      "thread/YYYY",
      "!dm" + "sum",
      "/dm" + "sum",
      "attention" + " route",
      "routed" + " attention",
      "SMS-" + "style" + " notice"
    ];
    const retiredVocabulary = new RegExp(`\\b${retiredTerm}(s|ed|ing)?\\b`, "i");
    const docs = [
      "AGENTS.md",
      "DMSUM.md",
      "CLAUDE.md",
      "README.md",
      "DM·Sum Ontology and Functional Spec (v2).md",
      "DM·Sum Ontology and Functional Spec (v1).md",
      "DM·Sum Ontology and Functional Spec (v0.4).md"
    ];

    for (const doc of docs) {
      const content = await fs.readFile(path.join(process.cwd(), doc), "utf8");
      expect(content, `${doc} should document +sum`).toContain("+sum");
      expect(content, `${doc} should document +dm`).toContain("+dm");
      expect(content, `${doc} should document +dmsum`).toContain("+dmsum");
      expect(content, `${doc} should not document the retired signal`).not.toContain("<" + "sum");
      expect(content, `${doc} should require preference-aware retrieval`).toMatch(/preference file/i);
      expect(content, `${doc} should preserve stored links when preferences require it`).toMatch(/links/i);
      expect(content, `${doc} should keep retrieval read-only by default`).toMatch(/read-only retrieval/i);
      expect(content, `${doc} should not mention retired integration vocabulary`).not.toMatch(retiredVocabulary);
      expect(content, `${doc} should require natural participant-facing language`).toMatch(
        /natural, low-friction|ordinary language/i
      );
      expect(content, `${doc} should require recognizable user objects`).toMatch(/recognizable object/i);
      expect(content, `${doc} should hide implementation details by default`).toMatch(/hide implementation details/i);
      expect(content, `${doc} should distinguish external web links from local file links`).toMatch(
        /external web links.*local markdown links|local markdown\/file links/is
      );
      expect(content, `${doc} should include current retrieval roots`).toContain("wiki-updates/");
      expect(content, `${doc} should include interactions in retrieval guidance`).toContain("interactions/");
      for (const term of forbidden) {
        expect(content, `${doc} should not mention ${term}`).not.toContain(term);
      }
    }
  });

  it("documents the routed local multi-relationship model", async () => {
    const docs = ["AGENTS.md", "DMSUM.md", "README.md", "DM·Sum Ontology and Functional Spec (v1).md"];

    for (const doc of docs) {
      const content = await fs.readFile(path.join(process.cwd(), doc), "utf8");
      expect(content, `${doc} should document the local registry`).toMatch(/registry/i);
      expect(content, `${doc} should document owner-scoped contact handles`).toMatch(/owner-scoped/i);
      expect(content, `${doc} should document explicit relationship routing`).toContain("relationshipId");
    }
  });

  it("documents the local Git sync MVP", async () => {
    const docs = ["AGENTS.md", "DMSUM.md", "README.md", "DM·Sum Ontology and Functional Spec (v1).md"];

    for (const doc of docs) {
      const content = await fs.readFile(path.join(process.cwd(), doc), "utf8");
      expect(content, `${doc} should document Git-backed relationship sync`).toMatch(/Git/i);
      expect(content, `${doc} should preserve one repo per dyad`).toMatch(/one Git repo|own Git repo|separate.*Git/i);
      expect(content, `${doc} should describe agent conflict harmonization`).toMatch(/conflict/i);
      expect(content, `${doc} should mention sync doctor`).toMatch(/sync doctor/i);
    }

    const preflight = await fs.readFile(path.join(process.cwd(), "docs", "local-git-sync-preflight.md"), "utf8");
    expect(preflight).toMatch(/Windows OpenSSH/i);
    expect(preflight).toMatch(/Lisa Mac Setup/i);
    expect(preflight).toMatch(/Mike Mac Setup/i);
    expect(preflight).toMatch(/git ls-remote/i);
    expect(preflight).toMatch(/sync doctor/i);
  });

  it("documents the hosted v2 architecture direction", async () => {
    const docs = ["AGENTS.md", "DMSUM.md", "README.md", "CLAUDE.md", "DM·Sum Ontology and Functional Spec (v2).md"];

    for (const doc of docs) {
      const content = await fs.readFile(path.join(process.cwd(), doc), "utf8");
      expect(content, `${doc} should identify Supabase/Postgres as the hosted graph store`).toMatch(
        /Supabase\/Postgres|Supabase Postgres|Postgres/i
      );
      expect(content, `${doc} should identify Vercel or remote MCP/API`).toMatch(/Vercel|remote MCP\/API/i);
      expect(content, `${doc} should document atomic batch commits`).toMatch(/atomic batch|atomic.*commit/i);
      expect(content, `${doc} should document optimistic version checks`).toMatch(/optimistic version|version checks/i);
      expect(content, `${doc} should preserve private drafting`).toMatch(/private.*draft/i);
      expect(content, `${doc} should avoid requiring full local replicas`).toMatch(/local replicas|local replica/i);
    }
  });

  it("renders the read-only audit page", async () => {
    const interaction = await harness.vault.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum add an audit renderer note."
    });
    const update = await harness.vault.commitWikiUpdate({
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [interaction.interactionId],
      displayText: "Dave updated the Audit Renderer page so the smoke test has a visible recap.",
      wikiWrites: [
        {
          path: "wiki/topics/audit-renderer.md",
          title: "Audit Renderer",
          content: "# Audit Renderer\n\nAudit renderer smoke test. [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });

    const root = await renderAuditPage(harness.config, ".");
    expect(root.status).toBe(200);
    expect(root.body).toContain("Mem·Sum Audit");
    expect(root.body).toContain("wiki-updates");

    const updatePage = await renderAuditPage(harness.config, update.updatePath);
    expect(updatePage.status).toBe(200);
    expect(updatePage.body).toContain("Audit renderer smoke test");
  });
});

describe("Mem·Sum routed local registry", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dmsum-router-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createRoutedHarness() {
    const registry = createRegistry({
      ownerName: "Dave",
      contactSpecs: ["Lisa", "lisa-work=Lisa"],
      relationshipsRoot: path.join(root, "relationships"),
      stateRoot: path.join(root, ".dmsum"),
      timezone: "America/Los_Angeles"
    });
    for (const relationship of registry.relationships) {
      await initializeVault({
        config: configFromRelationship(registry, relationship.id),
        now: () => fixedNow
      });
    }
    return {
      registry,
      router: new RoutedDmsumVault(registry, { now: () => fixedNow })
    };
  }

  it("routes owner-scoped contact handles to isolated relationship workspaces", async () => {
    const { registry, router } = await createRoutedHarness();
    const lisa = await router.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dm @lisa this belongs in the personal relationship."
    });
    const lisaWork = await router.commitInteraction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dm @lisa-work this belongs in the work relationship."
    });

    expect(lisa).toMatchObject({
      relationshipId: "dave-lisa",
      interactionPath: "interactions/2026/04/27/I000001.md",
      addressedParticipants: ["lisa"]
    });
    expect(lisaWork).toMatchObject({
      relationshipId: "dave-lisa-work",
      interactionPath: "interactions/2026/04/27/I000001.md",
      addressedParticipants: ["lisa-work"]
    });

    const personalPath = path.join(root, "relationships", "dave-lisa", "interactions", "2026", "04", "27", "I000001.md");
    const workPath = path.join(
      root,
      "relationships",
      "dave-lisa-work",
      "interactions",
      "2026",
      "04",
      "27",
      "I000001.md"
    );
    await expect(readText(personalPath)).resolves.toContain("@lisa this belongs in the personal relationship");
    await expect(readText(workPath)).resolves.toContain("@lisa-work this belongs in the work relationship");

    expect(registry.contacts.map((contact) => `${contact.ownerId}:${contact.handle}`).sort()).toEqual([
      "dave:lisa",
      "dave:lisa-work"
    ]);
  });

  it("can create peer registries that reuse the same relationship id", () => {
    const daveRegistry = createRegistry({
      ownerName: "Dave",
      contactSpecs: ["Lisa", "Mike"],
      relationshipsRoot: path.join(root, "dave", "relationships"),
      stateRoot: path.join(root, "dave", ".dmsum"),
      statePlacement: "inside-vault"
    });
    const lisaRegistry = createRegistry({
      ownerName: "Lisa",
      contactSpecs: ["Dave"],
      relationshipIds: ["dave-lisa"],
      relationshipsRoot: path.join(root, "lisa", "relationships"),
      stateRoot: path.join(root, "lisa", ".dmsum"),
      statePlacement: "inside-vault"
    });
    const mikeRegistry = createRegistry({
      ownerName: "Mike",
      contactSpecs: ["Dave"],
      relationshipIds: ["dave-mike"],
      relationshipsRoot: path.join(root, "mike", "relationships"),
      stateRoot: path.join(root, "mike", ".dmsum"),
      statePlacement: "inside-vault"
    });

    expect(daveRegistry.relationships.map((relationship) => relationship.id).sort()).toEqual([
      "dave-lisa",
      "dave-mike"
    ]);
    expect(lisaRegistry.contacts[0]).toMatchObject({
      ownerId: "lisa",
      handle: "dave",
      relationshipId: "dave-lisa"
    });
    expect(mikeRegistry.contacts[0]).toMatchObject({
      ownerId: "mike",
      handle: "dave",
      relationshipId: "dave-mike"
    });
  });

  it("requires explicit relationship context when no contact handle resolves the relationship", async () => {
    const { router } = await createRoutedHarness();
    await expect(
      router.commitInteraction({
        participant: "Dave",
        agent: "Dave-OpenAI",
        rawText: "+sum add this to the trip."
      })
    ).rejects.toThrow(/relationshipId is required/i);

    const interaction = await router.commitInteraction({
      relationshipId: "dave-lisa",
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+sum add this to the trip."
    });
    expect(interaction.relationshipId).toBe("dave-lisa");
  });

  it("routes wiki updates and virtual file reads through one MCP handler set", async () => {
    const { router } = await createRoutedHarness();
    const handlers = createToolHandlers(router);
    const interactionResult = await handlers.commit_interaction({
      participant: "Dave",
      agent: "Dave-OpenAI",
      rawText: "+dm @lisa ask whether the train sounds better."
    });
    const interaction = resultOf<{ interactionId: string; relationshipId: string }>(interactionResult);
    expect(interaction.relationshipId).toBe("dave-lisa");

    const updateResult = await handlers.commit_wiki_update({
      relationshipId: interaction.relationshipId,
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [interaction.interactionId],
      displayText: "Dave updated the trip page with a train question.",
      attention: ["@lisa"],
      wikiWrites: [
        {
          path: "wiki/topics/trip.md",
          title: "Trip",
          content: "# Trip\n\nOpen question: train or fly? [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });
    const update = resultOf<{ updateId: string; relationshipId: string; attention: string[] }>(updateResult);
    expect(update).toMatchObject({
      updateId: "W000001",
      relationshipId: "dave-lisa",
      attention: ["lisa"]
    });

    const rootListing = resultOf<Array<{ path: string }>>(await handlers.list_files({}));
    expect(rootListing.map((entry) => entry.path)).toEqual(["DMSUM.md", "relationships"]);
    const relationships = resultOf<Array<{ path: string }>>(await handlers.list_files({ path: "relationships" }));
    expect(relationships.map((entry) => entry.path).sort()).toEqual([
      "relationships/dave-lisa",
      "relationships/dave-lisa-work"
    ]);
    const trip = resultOf<{ path: string; content: string }>(
      await handlers.read_file({ path: "relationships/dave-lisa/wiki/topics/trip.md" })
    );
    expect(trip).toMatchObject({
      path: "relationships/dave-lisa/wiki/topics/trip.md"
    });
    expect(trip.content).toContain("Open question: train or fly?");
  });
});

describe("Mem·Sum local Git sync", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dmsum-sync-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("initializes Dave-Lisa and Dave-Mike as isolated Git-backed relationship workspaces", async () => {
    const result = await initializeLocalGitSync({
      dataRoot: root,
      ownerName: "Dave",
      contactSpecs: ["Lisa", "Mike"],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });

    expect(result.registryPath).toBe(path.join(root, ".dmsum", "registry.json"));
    expect(result.syncPath).toBe(path.join(root, ".dmsum", "sync.json"));
    expect(result.registry.relationships.map((relationship) => relationship.id).sort()).toEqual([
      "dave-lisa",
      "dave-mike"
    ]);

    for (const relationship of result.registry.relationships) {
      await expect(fs.stat(path.join(root, "git", `${relationship.id}.git`, "HEAD"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(relationship.vaultRoot, ".git"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(relationship.vaultRoot, ".dmsum", "state.json"))).resolves.toBeTruthy();
      expect(relationship.stateDir).toBe(path.join(relationship.vaultRoot, ".dmsum"));
    }

    await writeText(path.join(root, "relationships", "dave-lisa", "wiki", "topics", "private.md"), "# Private\n\nLisa only.\n");
    await syncOnce({ syncPath: result.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    await expect(fs.stat(path.join(root, "relationships", "dave-mike", "wiki", "topics", "private.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  }, 20000);

  it("reports pending local changes before sync and clean state after sync", async () => {
    const result = await initializeLocalGitSync({
      dataRoot: root,
      ownerName: "Dave",
      contactSpecs: ["Lisa"],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });
    await writeText(
      path.join(root, "relationships", "dave-lisa", "wiki", "topics", "pending.md"),
      "# Pending\n\nThis has not synced yet.\n"
    );

    const pending = await syncStatus({ syncPath: result.syncPath, relationshipId: "dave-lisa" });
    expect(pending.relationships[0]).toMatchObject({
      relationshipId: "dave-lisa",
      status: "pending",
      changed: true,
      message: "Local changes are waiting for sync"
    });

    await syncOnce({ syncPath: result.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    const clean = await syncStatus({ syncPath: result.syncPath, relationshipId: "dave-lisa" });
    expect(clean.relationships[0]).toMatchObject({
      relationshipId: "dave-lisa",
      status: "clean",
      changed: false,
      message: "No local file changes"
    });
  }, 20000);

  it("exposes Git sync through MCP handlers when sync config is supplied", async () => {
    const result = await initializeLocalGitSync({
      dataRoot: root,
      ownerName: "Dave",
      contactSpecs: ["Lisa"],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });
    const router = new RoutedDmsumVault(result.registry, { now: () => fixedNow });
    const handlers = createToolHandlers(router, { syncPath: result.syncPath });

    expect(Object.keys(handlers).sort()).toEqual([
      "claim_status",
      "commit_interaction",
      "commit_wiki_update",
      "get_current_time",
      "grep",
      "list_conflicts",
      "list_files",
      "read_conflict",
      "read_file",
      "refresh_status",
      "release_status",
      "resolve_conflict",
      "sync_doctor",
      "sync_once",
      "sync_resolve",
      "sync_status"
    ]);

    const interaction = resultOf<{ interactionId: string }>(
      await handlers.commit_interaction({
        relationshipId: "dave-lisa",
        participant: "Dave",
        agent: "Dave-OpenAI",
        rawText: "+sum add a sync-tool smoke test."
      })
    );
    await handlers.commit_wiki_update({
      relationshipId: "dave-lisa",
      participant: "Dave",
      agent: "Dave-OpenAI",
      interactionIds: [interaction.interactionId],
      displayText: "Dave updated the sync-tool smoke test page.",
      wikiWrites: [
        {
          path: "wiki/topics/sync-tool-smoke-test.md",
          title: "Sync Tool Smoke Test",
          content: "# Sync Tool Smoke Test\n\nThe MCP sync tools can publish a Mem·Sum update. [{{WIKI_UPDATE_ID}}]\n"
        }
      ]
    });

    const pending = resultOf<SyncRunResult>(await handlers.sync_status({ relationshipId: "dave-lisa" }));
    expect(pending.relationships[0]).toMatchObject({
      relationshipId: "dave-lisa",
      status: "pending",
      changed: true
    });

    const synced = resultOf<SyncRunResult>(await handlers.sync_once({ relationshipId: "dave-lisa" }));
    expect(synced.relationships[0]).toMatchObject({
      relationshipId: "dave-lisa",
      status: "synced",
      pushed: true
    });

    const clean = resultOf<SyncRunResult>(await handlers.sync_status({ relationshipId: "dave-lisa" }));
    expect(clean.relationships[0]).toMatchObject({
      relationshipId: "dave-lisa",
      status: "clean",
      changed: false
    });
  }, 20000);

  it("runs local sync doctor checks for a configured relationship", async () => {
    const result = await initializeLocalGitSync({
      dataRoot: root,
      ownerName: "Dave",
      contactSpecs: ["Lisa"],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });

    const doctor = await syncDoctor({ syncPath: result.syncPath, relationshipId: "dave-lisa" });
    expect(doctor.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "git", status: "ok" }),
        expect.objectContaining({ relationshipId: "dave-lisa", name: "worktree", status: "ok" }),
        expect.objectContaining({ relationshipId: "dave-lisa", name: "origin remote", status: "ok" }),
        expect.objectContaining({ relationshipId: "dave-lisa", name: "shared state", status: "ok" })
      ])
    );
  }, 20000);

  it("syncs clean changes both directions through a bare Git remote", async () => {
    const daveRoot = path.join(root, "dave");
    const lisaRoot = path.join(root, "lisa");
    const dave = await initializeLocalGitSync({
      dataRoot: daveRoot,
      ownerName: "Dave",
      contactSpecs: ["Lisa"],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });
    const remote = dave.sync.relationships[0].remote;
    const lisa = await initializeLocalGitSync({
      dataRoot: lisaRoot,
      ownerName: "Lisa",
      contactSpecs: ["Dave"],
      relationshipIds: ["dave-lisa"],
      remotes: [remote],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });

    await writeText(
      path.join(daveRoot, "relationships", "dave-lisa", "wiki", "topics", "dave-note.md"),
      "# Dave Note\n\nDave wrote this.\n"
    );
    await syncOnce({ syncPath: dave.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    await syncOnce({ syncPath: lisa.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    await expect(readText(path.join(lisaRoot, "relationships", "dave-lisa", "wiki", "topics", "dave-note.md"))).resolves.toContain(
      "Dave wrote this"
    );

    await writeText(
      path.join(lisaRoot, "relationships", "dave-lisa", "wiki", "topics", "lisa-note.md"),
      "# Lisa Note\n\nLisa wrote this.\n"
    );
    await syncOnce({ syncPath: lisa.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    await syncOnce({ syncPath: dave.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    await expect(readText(path.join(daveRoot, "relationships", "dave-lisa", "wiki", "topics", "lisa-note.md"))).resolves.toContain(
      "Lisa wrote this"
    );
  }, 20000);

  it("detects same-file wiki conflicts and lets an agent commit the harmonized resolution", async () => {
    const daveRoot = path.join(root, "dave");
    const lisaRoot = path.join(root, "lisa");
    const dave = await initializeLocalGitSync({
      dataRoot: daveRoot,
      ownerName: "Dave",
      contactSpecs: ["Lisa"],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });
    const lisa = await initializeLocalGitSync({
      dataRoot: lisaRoot,
      ownerName: "Lisa",
      contactSpecs: ["Dave"],
      relationshipIds: ["dave-lisa"],
      remotes: [dave.sync.relationships[0].remote],
      specSourcePath: path.join(process.cwd(), "DMSUM.md")
    });
    const daveFile = path.join(daveRoot, "relationships", "dave-lisa", "wiki", "topics", "conflict.md");
    const lisaFile = path.join(lisaRoot, "relationships", "dave-lisa", "wiki", "topics", "conflict.md");

    await writeText(daveFile, "# Conflict\n\nShared baseline.\n");
    await syncOnce({ syncPath: dave.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    await syncOnce({ syncPath: lisa.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });

    await writeText(daveFile, "# Conflict\n\nDave version.\n");
    await syncOnce({ syncPath: dave.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    await writeText(lisaFile, "# Conflict\n\nLisa version.\n");
    const conflict = await syncOnce({ syncPath: lisa.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    expect(conflict.relationships[0]).toMatchObject({
      relationshipId: "dave-lisa",
      status: "conflict",
      pushed: false,
      conflictFiles: ["wiki/topics/conflict.md"]
    });
    await expect(readText(lisaFile)).resolves.toContain("<<<<<<<");

    await writeText(lisaFile, "# Conflict\n\nDave version.\n\nLisa version.\n");
    const resolved = await resolveSync({ syncPath: lisa.syncPath, relationshipId: "dave-lisa", now: () => fixedNow });
    expect(resolved.relationships[0]).toMatchObject({
      relationshipId: "dave-lisa",
      status: "synced",
      pushed: true
    });

    await syncOnce({ syncPath: syncPathForDataRoot(daveRoot), relationshipId: "dave-lisa", now: () => fixedNow });
    const harmonized = await readText(daveFile);
    expect(harmonized).toContain("Dave version");
    expect(harmonized).toContain("Lisa version");
  }, 60000);
});

