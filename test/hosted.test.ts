import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitInteractionSchema,
  commitUpdateBatchSchema,
  contactMethodSchema,
  createReminderSchema,
  createRelationshipContextSchema,
  getDmsumHomeSchema,
  getDmsumInstructionsSchema,
  listRelationshipContextsSchema,
  listActivitySchema,
  readPageSchema,
  resolveContactSchema,
  hostedToolNames
} from "../src/hosted/contracts.js";
import { handleHostedRequest, type HostedKernelHandler } from "../src/hosted/http.js";
import {
  buildHostedInstructionsPayload,
  hostedEmptyStateGuidance,
  hostedMcpInstructions,
  hostedRecommendedWorkflow,
  hostedResolvedContactWorkflow
} from "../src/hosted/instructions.js";
import {
  applyInboundSmsKeyword,
  classifyInboundSmsKeyword,
  handleTwilioInboundSmsRequest,
  inboundRequestUrl,
  isValidTwilioSignature,
  twilioRequestSignature
} from "../src/hosted/inbound-sms.js";
import { strFromU8, unzipSync } from "fflate";
import { handleHostedAdminInviteRequest, inviteRedirectTarget } from "../src/hosted/admin.js";
import { handleHostedExportRequest } from "../src/hosted/export.js";
import { buildOkfBundle, okfTypeForPath, rewriteWikiLinksForBundle } from "../src/hosted/okf.js";
import { handleHostedMcpRequest } from "../src/hosted/mcp.js";
import { handleHostedVersionRequest } from "../src/hosted/version.js";
import { handleNotificationWorkerRequest, sendTwilioMessage, tryProcessImmediateNotificationJobs } from "../src/hosted/notifications.js";
import { buildConsentHtml, handleHostedOAuthRequest, signInWithPasswordGrant } from "../src/hosted/oauth.js";
import { buildInviteLink, createConnectorToken, createInviteToken, hashConnectorToken, runHostedSmoke } from "../src/hosted/operator.js";
import { hostedReadPageCandidates, parseWikiLinks } from "../src/hosted/paths.js";
import {
  checkHostedRateLimit,
  clientIpFromHeaders,
  hostedRateLimitResponse,
  hostedRateLimitRules,
  rateLimitSubjectForToken,
  rateLimitedResponse
} from "../src/hosted/ratelimit.js";
import {
  assignSumHandles,
  buildUpdateBatchRejectionRecord,
  createSupabaseHostedKernelHandler,
  formatActivityDisplayTime,
  formatDirectMessageNotification,
  isRejectedBatchResult,
  isConnectorToken,
  sourceInteractionHasImmediateNotification,
  storageError,
  sumHandleForDisplayName,
  validateDirectMessageContent
} from "../src/hosted/supabase.js";
import { DEFAULT_PARTICIPANT_CAP, LEGACY_PRODUCT_NAME, PRODUCT_NAME, participantCap, productHosts } from "../src/hosted/product.js";

const migrationPath = path.join(process.cwd(), "supabase", "migrations", "20260506120000_hosted_mvp.sql");
const grantsMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260506194500_hosted_authenticated_grants.sql"
);
const serviceRoleGrantsMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260506200000_hosted_service_role_grants.sql"
);
const connectorTokensMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260506213000_hosted_connector_tokens.sql"
);
const oauthMigrationPath = path.join(process.cwd(), "supabase", "migrations", "20260507010000_hosted_oauth.sql");
const notificationMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260529005307_twilio_notifications.sql"
);
const activityIndexesMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260609180358_hosted_activity_indexes.sql"
);
const batchRejectionsMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260708001500_update_batch_rejections.sql"
);
const invitationsMigrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260708020000_participant_invitations.sql"
);

const relationshipScopedTables = [
  "relationships",
  "participants",
  "relationship_members",
  "contacts",
  "invitations",
  "participant_contact_methods",
  "notification_endpoints",
  "interactions",
  "updates",
  "update_sources",
  "resources",
  "wiki_pages",
  "page_revisions",
  "preferences",
  "preference_revisions",
  "attention_records"
];

const ids = {
  relationshipId: "11111111-1111-4111-8111-111111111111",
  participantId: "22222222-2222-4222-8222-222222222222",
  interactionId: "33333333-3333-4333-8333-333333333333",
  lisaParticipantId: "44444444-4444-4444-8444-444444444444"
};

async function hostedMcpPost(body: unknown): Promise<{ status: number; body: any }> {
  const response = await handleHostedMcpRequest(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer dmsum_test"
      },
      body: JSON.stringify(body)
    })
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

describe("Mem·Sum hosted MVP contracts", () => {
  it("defines the hosted tool surface separately from the local filesystem MCP surface", () => {
    expect(hostedToolNames).toEqual([
      "get_dmsum_home",
      "get_dmsum_instructions",
      "create_relationship_context",
      "list_relationship_contexts",
      "resolve_contact",
      "commit_interaction",
      "read_page",
      "list_pages",
      "search_pages",
      "list_activity",
      "commit_update_batch",
      "create_reminder",
      "get_relationship_context"
    ]);
  });

  it("accepts valid hosted create_relationship_context input", () => {
    expect(
      createRelationshipContextSchema.parse({
        relationshipDisplayName: "Dave-Lisa",
        selfDisplayName: "Dave",
        peerDisplayName: "Lisa",
        contactHandle: "@lisa",
        contactDisplayName: "Lisa"
      })
    ).toMatchObject({
      relationshipDisplayName: "Dave-Lisa",
      contactHandle: "@lisa"
    });
  });

  it("accepts owner-scoped hosted relationship discovery inputs", () => {
    expect(listRelationshipContextsSchema.parse({})).toEqual({});
    expect(listRelationshipContextsSchema.parse({ contactHandle: "@lisa" })).toEqual({ contactHandle: "@lisa" });
    expect(resolveContactSchema.parse({ contactHandle: "@lisa" })).toEqual({ contactHandle: "@lisa" });
    expect(getDmsumHomeSchema.parse({})).toEqual({});
    expect(getDmsumInstructionsSchema.parse({ contactHandle: "@lisa" })).toEqual({ contactHandle: "@lisa" });
    expect(getDmsumInstructionsSchema.parse({})).toEqual({});
    expect(() => resolveContactSchema.parse({ contactHandle: "Lisa" })).toThrow();
  });

  it("accepts wiki-relative read paths from index links", () => {
    expect(readPageSchema.parse({ relationshipId: ids.relationshipId, path: "wiki/topics/sonoma-weekend.md" })).toEqual({
      relationshipId: ids.relationshipId,
      path: "wiki/topics/sonoma-weekend.md"
    });
    expect(readPageSchema.parse({ relationshipId: ids.relationshipId, path: "topics/sonoma-weekend" })).toEqual({
      relationshipId: ids.relationshipId,
      path: "topics/sonoma-weekend"
    });
    expect(readPageSchema.parse({ relationshipId: ids.relationshipId, path: "[[topics/sonoma-weekend|Sonoma Weekend]]" })).toEqual({
      relationshipId: ids.relationshipId,
      path: "[[topics/sonoma-weekend|Sonoma Weekend]]"
    });
    expect(hostedReadPageCandidates("topics/sonoma-weekend")).toEqual([
      "topics/sonoma-weekend.md",
      "wiki/topics/sonoma-weekend.md"
    ]);
    expect(() => readPageSchema.parse({ relationshipId: ids.relationshipId, path: "../sonoma-weekend" })).toThrow();
  });

  it("parses hosted wiki links without adding a separate overview primitive", () => {
    expect(
      parseWikiLinks(`# Dave-Lisa

- [[topics/sonoma-weekend|Sonoma Weekend]]
- [[wiki/synthesis/hosted-smoke-test.md]]
- ![[assets/sonoma.png]]
- [[topics/sonoma-weekend#Timing Research|Timing research]]
- [[../unsafe]]
`)
    ).toEqual([
      {
        target: "topics/sonoma-weekend",
        label: "Sonoma Weekend",
        canonicalPath: "wiki/topics/sonoma-weekend.md",
        candidates: ["topics/sonoma-weekend.md", "wiki/topics/sonoma-weekend.md"]
      },
      {
        target: "wiki/synthesis/hosted-smoke-test.md",
        label: "wiki/synthesis/hosted-smoke-test.md",
        canonicalPath: "wiki/synthesis/hosted-smoke-test.md",
        candidates: ["wiki/synthesis/hosted-smoke-test.md"]
      },
      {
        target: "topics/sonoma-weekend#Timing Research",
        label: "Timing research",
        canonicalPath: "wiki/topics/sonoma-weekend.md",
        candidates: ["topics/sonoma-weekend.md", "wiki/topics/sonoma-weekend.md"],
        anchor: "Timing Research"
      }
    ]);
  });

  it("accepts valid hosted list_activity input", () => {
    expect(
      listActivitySchema.parse({
        relationshipId: ids.relationshipId,
        start: "2026-06-08T00:00:00-07:00",
        end: "2026-06-09T00:00:00-07:00",
        timezone: "America/Los_Angeles",
        actorParticipantId: ids.participantId,
        targetParticipantId: ids.lisaParticipantId
      })
    ).toMatchObject({
      relationshipId: ids.relationshipId,
      limit: 50,
      timezone: "America/Los_Angeles"
    });
  });

  it("formats activity display times with an IANA timezone", () => {
    const displayTime = formatActivityDisplayTime("2026-06-08T23:15:34.693Z", "America/Los_Angeles");
    expect(displayTime).toContain("2026");
    expect(displayTime).toMatch(/PDT|GMT-7/);
  });

  it("accepts valid hosted commit_interaction input", () => {
    expect(
      commitInteractionSchema.parse({
        relationshipId: ids.relationshipId,
        participantId: ids.participantId,
        agent: "Dave-Codex",
        rawText: "+dm @lisa I don't need to shower before the mall.",
        addressedParticipantIds: [ids.lisaParticipantId],
        directMessageContent: "I don't need to shower before the mall.",
        resources: [{ kind: "url", url: "https://example.com", title: "Example" }]
      })
    ).toMatchObject({
      relationshipId: ids.relationshipId,
      participantId: ids.participantId,
      directMessageContent: "I don't need to shower before the mall."
    });
  });

  it("formats direct SMS envelopes deterministically outside the model", () => {
    expect(formatDirectMessageNotification("Dave", "If we're not going to the mall, I'm eating ice cream. Want to join me?")).toBe(
      "From Dave: If we're not going to the mall, I'm eating ice cream. Want to join me?"
    );
    expect(formatDirectMessageNotification("Dave", "Look at these venues.", "Chelsea's Wedding")).toBe(
      "From Dave (Chelsea's Wedding): Look at these venues."
    );
    expect(formatDirectMessageNotification("Dave", "Look at these venues.", "  ")).toBe("From Dave: Look at these venues.");
    expect(validateDirectMessageContent("If we're not going to the mall, I'm eating ice cream. Want to join me?")).toBeNull();
    expect(validateDirectMessageContent("From Dave: If we're not going to the mall, I'm eating ice cream.")).toMatch(/Mem·Sum adds/);
    expect(validateDirectMessageContent("Dave's message for Lisa: the outfit looks great.")).toMatch(/message for Lisa/);
    expect(sourceInteractionHasImmediateNotification({ notification_text: "From Dave: hi" })).toBe(true);
    expect(sourceInteractionHasImmediateNotification({ notification_text: null })).toBe(false);
  });

  it("accepts valid hosted commit_update_batch input", () => {
    const parsed = commitUpdateBatchSchema.parse({
      relationshipId: ids.relationshipId,
      participantId: ids.participantId,
      agent: "Dave-Codex",
      sourceInteractionIds: [ids.interactionId],
      displayText: "Updated the Sonoma weekend.",
      readSet: [
        {
          kind: "wiki_page",
          path: "wiki/topics/sonoma-weekend.md",
          expectedVersion: 3
        },
        {
          kind: "preference",
          participantId: ids.participantId,
          expectedVersion: 1
        }
      ],
      wikiWrites: [
        {
          path: "wiki/topics/sonoma-weekend.md",
          title: "Sonoma Weekend",
          expectedVersion: 3,
          content: "# Sonoma Weekend\n\nVintage shopping and wineries.\n"
        }
      ],
      attentionParticipantIds: [ids.lisaParticipantId]
    });

    expect(parsed.wikiWrites?.[0]?.expectedVersion).toBe(3);
  });

  it("accepts valid hosted create_reminder input", () => {
    expect(
      createReminderSchema.parse({
        relationshipId: ids.relationshipId,
        participantId: ids.participantId,
        sourceInteractionId: ids.interactionId,
        recipientParticipantId: ids.participantId,
        agent: "Dave-Codex",
        body: "Reminder from Dave: don't forget your tux fitting at Tuxedos and More at 1:00 PM.",
        scheduledFor: "2026-05-29T19:00:00.000Z",
        timezone: "America/Los_Angeles"
      })
    ).toMatchObject({
      relationshipId: ids.relationshipId,
      recipientParticipantId: ids.participantId,
      body: "Reminder from Dave: don't forget your tux fitting at Tuxedos and More at 1:00 PM."
    });
  });

  it("rejects unsafe paths, malformed phones, and missing expected versions", () => {
    expect(() =>
      commitUpdateBatchSchema.parse({
        relationshipId: ids.relationshipId,
        participantId: ids.participantId,
        agent: "Dave-Codex",
        sourceInteractionIds: [ids.interactionId],
        displayText: "Bad path.",
        readSet: [],
        wikiWrites: [
          {
            path: "../wiki/topics/sonoma-weekend.md",
            title: "Sonoma Weekend",
            expectedVersion: 1,
            content: "# Sonoma Weekend\n"
          }
        ]
      })
    ).toThrow();

    expect(() =>
      commitUpdateBatchSchema.parse({
        relationshipId: ids.relationshipId,
        participantId: ids.participantId,
        agent: "Dave-Codex",
        sourceInteractionIds: [ids.interactionId],
        displayText: "Missing expected version.",
        readSet: [],
        wikiWrites: [
          {
            path: "wiki/topics/sonoma-weekend.md",
            title: "Sonoma Weekend",
            content: "# Sonoma Weekend\n"
          }
        ]
      })
    ).toThrow();

    expect(() => contactMethodSchema.parse({ kind: "phone", valueNormalized: "415-555-1212" })).toThrow();
    expect(() =>
      listActivitySchema.parse({
        relationshipId: ids.relationshipId,
        start: "2026-06-08",
        end: "2026-06-09T00:00:00-07:00",
        timezone: "America/Los_Angeles"
      })
    ).toThrow();
    expect(() =>
      listActivitySchema.parse({
        relationshipId: ids.relationshipId,
        start: "2026-06-09T00:00:00-07:00",
        end: "2026-06-08T00:00:00-07:00",
        timezone: "America/Los_Angeles"
      })
    ).toThrow(/end must be after start/);
    expect(() =>
      listActivitySchema.parse({
        relationshipId: ids.relationshipId,
        start: "2026-06-08T00:00:00-07:00",
        end: "2026-06-09T00:00:00-07:00",
        timezone: "America/Los_Angeles",
        limit: 101
      })
    ).toThrow();
    expect(() =>
      commitInteractionSchema.parse({
        relationshipId: ids.relationshipId,
        participantId: ids.participantId,
        agent: "Dave-Codex",
        rawText: "+dm @lisa hi.",
        directMessageContent: "hi."
      })
    ).toThrow(/directMessageContent requires addressedParticipantIds/);
  });

  it("validates hosted HTTP requests before dispatching to a storage adapter", async () => {
    const validRequest = new Request("https://example.com/hosted/commit_interaction", {
      method: "POST",
      body: JSON.stringify({
        relationshipId: ids.relationshipId,
        participantId: ids.participantId,
        agent: "Dave-Codex",
        rawText: "+sum remember this."
      })
    });

    const response = await handleHostedRequest(validRequest);
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Hosted Mem·Sum storage adapter is not configured"
    });

    const invalidRequest = new Request("https://example.com/hosted/commit_interaction", {
      method: "POST",
      body: JSON.stringify({
        participantId: ids.participantId,
        agent: "Dave-Codex",
        rawText: "+sum missing relationship."
      })
    });
    expect((await handleHostedRequest(invalidRequest)).status).toBe(400);
  });

  it("dispatches valid hosted HTTP requests to an injected handler", async () => {
    const handler: HostedKernelHandler = {
      getDmsumHome: async () => ({}),
      getDmsumInstructions: async () => ({}),
      createRelationshipContext: async () => ({}),
      listRelationshipContexts: async () => ({}),
      resolveContact: async () => ({}),
      commitInteraction: async (input) => ({ committed: input.rawText }),
      readPage: async () => ({}),
      listPages: async () => ({}),
      searchPages: async () => ({}),
      listActivity: async (input) => ({ activityWindow: `${input.start}/${input.end}`, limit: input.limit }),
      commitUpdateBatch: async () => ({}),
      createReminder: async () => ({}),
      getRelationshipContext: async () => ({})
    };

    const response = await handleHostedRequest(
      new Request("https://example.com/hosted/commit_interaction", {
        method: "POST",
        body: JSON.stringify({
          relationshipId: ids.relationshipId,
          participantId: ids.participantId,
          agent: "Dave-Codex",
          rawText: "+sum remember this."
        })
      }),
      handler
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        committed: "+sum remember this."
      }
    });

    const activityResponse = await handleHostedRequest(
      new Request("https://example.com/hosted/list_activity", {
        method: "POST",
        body: JSON.stringify({
          relationshipId: ids.relationshipId,
          start: "2026-06-08T00:00:00-07:00",
          end: "2026-06-09T00:00:00-07:00",
          timezone: "America/Los_Angeles"
        })
      }),
      handler
    );

    expect(activityResponse.status).toBe(200);
    await expect(activityResponse.json()).resolves.toMatchObject({
      ok: true,
      result: {
        activityWindow: "2026-06-08T00:00:00-07:00/2026-06-09T00:00:00-07:00",
        limit: 50
      }
    });
  });

  it("returns hosted operating instructions and resolved @contact context", async () => {
    const handler: HostedKernelHandler = {
      getDmsumHome: async () =>
        buildHostedInstructionsPayload({
          relationshipContexts: {
            relationships: [
              {
                relationship: {
                  id: ids.relationshipId,
                  displayName: "Dave-Lisa"
                },
                selfParticipant: {
                  id: ids.participantId,
                  displayName: "Dave"
                },
                contacts: [
                  {
                    handle: "@lisa",
                    participantId: ids.lisaParticipantId,
                    displayName: "Lisa"
                  }
                ]
              }
            ]
          }
        }),
      getDmsumInstructions: async (input) =>
        buildHostedInstructionsPayload({
          relationshipContexts: {
            relationships: [
              {
                relationship: {
                  id: ids.relationshipId,
                  displayName: "Dave-Lisa"
                },
                selfParticipant: {
                  id: ids.participantId,
                  displayName: "Dave"
                },
                contacts: [
                  {
                    handle: input.contactHandle,
                    participantId: ids.lisaParticipantId,
                    displayName: "Lisa"
                  }
                ]
              }
            ]
          },
          resolvedContext: {
            relationship: {
              id: ids.relationshipId,
              displayName: "Dave-Lisa"
            },
            selfParticipant: {
              id: ids.participantId,
              displayName: "Dave"
            },
            contact: {
              handle: input.contactHandle,
              participantId: ids.lisaParticipantId,
              displayName: "Lisa"
            },
            indexPage: {
              path: "wiki/index.md",
              title: "Index",
              version: 4
            },
            recommendedNextToolSequence: hostedResolvedContactWorkflow
          }
        }),
      createRelationshipContext: async () => ({}),
      listRelationshipContexts: async () => ({}),
      resolveContact: async () => ({}),
      commitInteraction: async () => ({}),
      readPage: async () => ({}),
      listPages: async () => ({}),
      searchPages: async () => ({}),
      listActivity: async () => ({}),
      commitUpdateBatch: async () => ({}),
      createReminder: async () => ({}),
      getRelationshipContext: async () => ({})
    };

    const response = await handleHostedRequest(
      new Request("https://example.com/hosted/get_dmsum_instructions", {
        method: "POST",
        body: JSON.stringify({ contactHandle: "@lisa" })
      }),
      handler
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        operatingContract: expect.stringContaining("+sum"),
        relationshipContexts: {
          relationships: [
            {
              relationship: { displayName: "Dave-Lisa" },
              contacts: [{ handle: "@lisa" }]
            }
          ]
        },
        resolvedContext: {
          relationship: {
            id: ids.relationshipId,
            displayName: "Dave-Lisa"
          },
          selfParticipant: {
            id: ids.participantId,
            displayName: "Dave"
          },
          contact: {
            handle: "@lisa",
            participantId: ids.lisaParticipantId
          },
          indexPage: {
            path: "wiki/index.md",
            version: 4
          },
          recommendedNextToolSequence: expect.arrayContaining([expect.stringContaining("read")])
        }
      }
    });
  });

  it("returns hosted home instructions without requiring a contact handle", async () => {
    const handler: HostedKernelHandler = {
      getDmsumHome: async () =>
        buildHostedInstructionsPayload({
          relationshipContexts: {
            relationships: [
              {
                relationship: {
                  id: ids.relationshipId,
                  displayName: "Dave-Lisa"
                },
                selfParticipant: {
                  id: ids.participantId,
                  displayName: "Lisa"
                },
                contacts: [
                  {
                    handle: "@dave",
                    participantId: ids.lisaParticipantId,
                    displayName: "Dave"
                  }
                ]
              }
            ]
          }
        }),
      getDmsumInstructions: async () => ({}),
      createRelationshipContext: async () => ({}),
      listRelationshipContexts: async () => ({}),
      resolveContact: async () => ({}),
      commitInteraction: async () => ({}),
      readPage: async () => ({}),
      listPages: async () => ({}),
      searchPages: async () => ({}),
      listActivity: async () => ({}),
      commitUpdateBatch: async () => ({}),
      createReminder: async () => ({}),
      getRelationshipContext: async () => ({})
    };

    const response = await handleHostedRequest(
      new Request("https://example.com/hosted/get_dmsum_home", {
        method: "POST",
        body: JSON.stringify({})
      }),
      handler
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        operatingContract: expect.stringContaining("get_dmsum_home"),
        relationshipContexts: {
          relationships: [
            {
              selfParticipant: { displayName: "Lisa" },
              contacts: [{ handle: "@dave" }]
            }
          ]
        }
      }
    });
  });

  it("reports missing hosted Supabase configuration as JSON", async () => {
    const response = await handleHostedRequest(
      new Request("https://example.com/hosted/read_page", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: JSON.stringify({
          relationshipId: ids.relationshipId,
          path: "wiki/index.md"
        })
      }),
      createSupabaseHostedKernelHandler(
        new Request("https://example.com/hosted/read_page", {
          headers: { authorization: "Bearer test-token" }
        }),
        {}
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Hosted Mem·Sum Supabase environment is not configured"
    });
  });

  it("requires a bearer token before using the hosted Supabase adapter", async () => {
    const response = await handleHostedRequest(
      new Request("https://example.com/hosted/read_page", {
        method: "POST",
        body: JSON.stringify({
          relationshipId: ids.relationshipId,
          path: "wiki/index.md"
        })
      }),
      createSupabaseHostedKernelHandler(new Request("https://example.com/hosted/read_page"), {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_ANON_KEY: "anon-key"
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Hosted Mem·Sum requests require a bearer token"
    });
  });

  it("requires service role configuration for hosted connector tokens", async () => {
    const response = await handleHostedRequest(
      new Request("https://example.com/hosted/read_page", {
        method: "POST",
        headers: { authorization: "Bearer dmsum_test" },
        body: JSON.stringify({
          relationshipId: ids.relationshipId,
          path: "wiki/index.md"
        })
      }),
      createSupabaseHostedKernelHandler(
        new Request("https://example.com/hosted/read_page", {
          headers: { authorization: "Bearer dmsum_test" }
        }),
        {
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_ANON_KEY: "anon-key"
        }
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Hosted Mem·Sum server-side tokens require SUPABASE_SERVICE_ROLE_KEY"
    });
  });

  it("hashes hosted connector tokens without preserving the raw bearer token", () => {
    expect(hashConnectorToken("dmsum_test")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashConnectorToken("dmsum_test")).toBe(hashConnectorToken("dmsum_test"));
    expect(hashConnectorToken("dmsum_test")).not.toContain("dmsum_test");
  });

  it("mints memsum_ connector tokens while accepting dmsum_ as the legacy prefix", async () => {
    expect(createConnectorToken()).toMatch(/^memsum_[A-Za-z0-9_-]{40,}$/);

    expect(isConnectorToken("memsum_abc")).toBe(true);
    expect(isConnectorToken("dmsum_abc")).toBe(true);
    expect(isConnectorToken("dmsoat_abc")).toBe(false);
    expect(isConnectorToken("eyJhbGciOi.jwt.looking")).toBe(false);

    const params = new URLSearchParams({ client_id: "dmsum_client_test", state: "abc123" });
    expect(buildConsentHtml(params, "Claude")).toContain('placeholder="memsum_..."');

    // The export endpoint turns away both prefixes with the same pointer.
    for (const prefix of ["memsum_", "dmsum_"]) {
      const response = await handleHostedExportRequest(
        new Request("https://x.example/api/export", {
          method: "POST",
          headers: { authorization: `Bearer ${prefix}not-a-session`, "content-type": "application/json" },
          body: JSON.stringify({ relationshipId: "rel-1" })
        }),
        {} as NodeJS.ProcessEnv
      );
      expect(response.status).toBe(400);
    }
  });

  it("exposes the hosted kernel as a remote MCP Streamable HTTP surface", async () => {
    const initialized = await hostedMcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "vitest",
          version: "1.0.0"
        }
      }
    });

    expect(initialized.status).toBe(200);
    expect(initialized.body.result.serverInfo).toMatchObject({
      name: "memsum-hosted"
    });
    expect(initialized.body.result.instructions).toContain("+sum");
    expect(initialized.body.result.instructions).toContain("@contact");
    expect(initialized.body.result.instructions).toMatch(/read before writing/i);
    expect(initialized.body.result.instructions).toMatch(/stale/i);

    const notification = await hostedMcpPost({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    });
    expect(notification.status).toBe(202);

    const tools = await hostedMcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });

    expect(tools.status).toBe(200);
    expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(hostedToolNames);
    expect(tools.body.result.tools.find((tool: { name: string }) => tool.name === "get_dmsum_home")).toBeTruthy();
    expect(tools.body.result.tools.find((tool: { name: string }) => tool.name === "get_dmsum_instructions")).toBeTruthy();
    expect(tools.body.result.tools.find((tool: { name: string }) => tool.name === "list_activity")).toBeTruthy();
  });

  it("advertises OAuth discovery when hosted MCP requests are unauthenticated", async () => {
    const response = await handleHostedMcpRequest(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
              name: "vitest",
              version: "1.0.0"
            }
          }
        })
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
    await expect(response.json()).resolves.toMatchObject({
      error: "unauthorized"
    });
  });

  it("serves OAuth protected-resource and authorization-server metadata for Claude", async () => {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key"
    };

    const protectedResource = await handleHostedOAuthRequest(
      new Request("https://example.com/.well-known/oauth-protected-resource/mcp"),
      env
    );
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource: "https://example.com/mcp",
      authorization_servers: ["https://example.com"],
      bearer_methods_supported: ["header"]
    });

    const authorizationServer = await handleHostedOAuthRequest(
      new Request("https://example.com/.well-known/oauth-authorization-server"),
      env
    );
    expect(authorizationServer.status).toBe(200);
    await expect(authorizationServer.json()).resolves.toMatchObject({
      issuer: "https://example.com",
      authorization_endpoint: "https://example.com/oauth/authorize",
      token_endpoint: "https://example.com/oauth/token",
      registration_endpoint: "https://example.com/oauth/register",
      code_challenge_methods_supported: ["S256"]
    });
  });

  it("registers hosted MCP instructions as a static resource", async () => {
    const resource = await hostedMcpPost({
      jsonrpc: "2.0",
      id: 20,
      method: "resources/read",
      params: {
        uri: "dmsum://instructions"
      }
    });

    expect(resource.status).toBe(200);
    expect(resource.body.result.contents[0]).toMatchObject({
      uri: "dmsum://instructions",
      mimeType: "text/markdown",
      text: expect.stringContaining("+sum")
    });
  });

  it("returns hosted MCP tool errors as tool results instead of breaking the protocol", async () => {
    const previousUrl = process.env.SUPABASE_URL;
    const previousKey = process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;

    try {
      const result = await hostedMcpPost({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read_page",
          arguments: {
            relationshipId: ids.relationshipId,
            path: "wiki/index.md"
          }
        }
      });

      expect(result.status).toBe(200);
      expect(result.body.result.isError).toBe(true);
      expect(result.body.result.structuredContent.result).toMatchObject({
        ok: false,
        error: "Hosted Mem·Sum Supabase environment is not configured"
      });
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = previousKey;
    }
  });

  it("runs the hosted smoke harness through remote MCP tool calls", async () => {
    const calls: string[] = [];
    let readCount = 0;
    let batchCount = 0;

    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        params: {
          name: string;
        };
      };
      const toolName = request.params.name;
      calls.push(toolName);

      let result: unknown;
      if (toolName === "list_relationship_contexts") {
        result = { relationships: [] };
      } else if (toolName === "create_relationship_context") {
        result = {
          relationshipId: ids.relationshipId,
          selfParticipantId: ids.participantId,
          peerParticipantId: ids.lisaParticipantId,
          contactHandle: "@lisa"
        };
      } else if (toolName === "read_page") {
        readCount += 1;
        result =
          readCount === 1
            ? { exists: false, path: "wiki/synthesis/hosted-smoke-test.md", version: 0 }
            : { exists: true, path: "wiki/synthesis/hosted-smoke-test.md", version: 1 };
      } else if (toolName === "commit_interaction") {
        result = { interactionId: ids.interactionId };
      } else if (toolName === "commit_update_batch") {
        batchCount += 1;
        result =
          batchCount === 1
            ? { ok: true, updateId: "55555555-5555-4555-8555-555555555555", changedPaths: [] }
            : { ok: false, reason: "stale", changedPaths: ["wiki/synthesis/hosted-smoke-test.md"] };
      } else {
        throw new Error(`Unexpected hosted smoke tool call: ${toolName}`);
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: { result }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await runHostedSmoke({
      endpoint: "https://example.com/mcp",
      accessToken: "test-token",
      contactHandle: "@lisa",
      relationshipDisplayName: "Dave-Lisa",
      selfDisplayName: "Dave",
      peerDisplayName: "Lisa",
      agent: "vitest",
      now: new Date("2026-05-06T20:00:00.000Z"),
      fetchFn
    });

    expect(result).toMatchObject({
      relationshipDisplayName: "Dave-Lisa",
      contactHandle: "@lisa",
      beforeVersion: 0,
      afterVersion: 1,
      staleRejected: true
    });
    expect(calls).toEqual([
      "list_relationship_contexts",
      "create_relationship_context",
      "read_page",
      "commit_interaction",
      "commit_update_batch",
      "commit_update_batch",
      "read_page"
    ]);
  });

  it("protects the notification worker endpoint with a bearer secret", async () => {
    const response = await handleNotificationWorkerRequest(
      new Request("https://example.com/api/notifications"),
      {
        DMSUM_NOTIFICATION_WORKER_SECRET: "worker-secret",
        NODE_ENV: "test"
      }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Notification worker request is not authorized"
    });
  });

  it("skips immediate notification dispatch during tests unless explicitly enabled", async () => {
    await expect(
      tryProcessImmediateNotificationJobs({
        NODE_ENV: "test"
      })
    ).resolves.toMatchObject({
      ok: true,
      skipped: true
    });
  });

  it("sends Twilio messages through a Messaging Service SID", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ sid: "SM11111111111111111111111111111111", status: "queued" }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const result = await sendTwilioMessage(
      {
        accountSid: "AC11111111111111111111111111111111",
        authToken: "test-auth-token",
        messagingServiceSid: "MG22222222222222222222222222222222",
        to: "+14155551212",
        body: "Mem·Sum reminder: tux fitting at 1:00 PM.",
        statusCallbackUrl: "https://example.com/twilio/status"
      },
      fetchFn
    );

    expect(result).toEqual({
      sid: "SM11111111111111111111111111111111",
      status: "queued"
    });
    expect(calls[0]?.input).toBe("https://api.twilio.com/2010-04-01/Accounts/AC11111111111111111111111111111111/Messages.json");
    expect(String(calls[0]?.init?.body)).toContain("MessagingServiceSid=MG22222222222222222222222222222222");
    expect(String(calls[0]?.init?.body)).toContain("To=%2B14155551212");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded"
    });
  });
});

describe("Mem·Sum hosted Supabase schema", () => {
  it("creates the required hosted graph tables", async () => {
    const migration = await fs.readFile(migrationPath, "utf8");
    for (const table of ["profiles", "profile_contact_methods", ...relationshipScopedTables]) {
      expect(migration, `missing ${table}`).toMatch(new RegExp(`create table if not exists public\\.${table}\\b`, "i"));
    }
    const connectorMigration = await fs.readFile(connectorTokensMigrationPath, "utf8");
    expect(connectorMigration).toMatch(/create table if not exists public\.connector_tokens\b/i);
  });

  it("enables RLS on every hosted table that stores relationship or identity data", async () => {
    const migration = await fs.readFile(migrationPath, "utf8");
    for (const table of ["profiles", "profile_contact_methods", ...relationshipScopedTables]) {
      expect(migration, `${table} must enable RLS`).toMatch(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`, "i")
      );
    }
    const connectorMigration = await fs.readFile(connectorTokensMigrationPath, "utf8");
    expect(connectorMigration).toMatch(/alter table public\.connector_tokens enable row level security/i);
  });

  it("uses relationship membership policies instead of broad authenticated access", async () => {
    const migration = await fs.readFile(migrationPath, "utf8");
    expect(migration).toMatch(/auth\.uid\(\)/);
    expect(migration).toMatch(/relationship_members/);
    expect(migration).toMatch(/is_relationship_member/);
    expect(migration).not.toMatch(/using\s*\(\s*true\s*\)/i);
  });

  it("grants authenticated API access only underneath RLS and RPC checks", async () => {
    const migration = await fs.readFile(grantsMigrationPath, "utf8");
    expect(migration).toMatch(/grant usage on schema public to authenticated/);
    expect(migration).toMatch(/grant select, insert, update on table[\s\S]*public\.relationship_members[\s\S]*to authenticated/);
    expect(migration).toMatch(/grant execute on function public\.create_relationship_context\(jsonb\) to authenticated/);
    expect(migration).toMatch(/grant execute on function public\.commit_update_batch\(jsonb\) to authenticated/);
    expect(migration).not.toMatch(/grant\s+delete/i);
  });

  it("grants service-role maintenance access without weakening authenticated access", async () => {
    const migration = await fs.readFile(serviceRoleGrantsMigrationPath, "utf8");
    expect(migration).toMatch(/grant usage on schema public to service_role/);
    expect(migration).toMatch(/grant all on table[\s\S]*public\.relationships[\s\S]*to service_role/);
    expect(migration).toMatch(/grant execute on function public\.create_relationship_context\(jsonb\) to service_role/);
    expect(migration).toMatch(/grant execute on function public\.commit_update_batch\(jsonb\) to service_role/);
    expect(migration).not.toMatch(/to authenticated/);
  });

  it("models phone numbers as first-class normalized contact and notification channels", async () => {
    const migration = await fs.readFile(migrationPath, "utf8");
    expect(migration).toMatch(/primary_phone/);
    expect(migration).toMatch(/profile_contact_methods/);
    expect(migration).toMatch(/participant_contact_methods/);
    expect(migration).toMatch(/notification_endpoints/);
    expect(migration).toMatch(/twilio/);
    expect(migration).toMatch(/\^\\\+\[1-9\]\[0-9\]\{1,14\}\$/);
  });

  it("defines commit_update_batch as the atomic stale-rejection primitive", async () => {
    const migration = await fs.readFile(migrationPath, "utf8");
    expect(migration).toMatch(/function public\.commit_update_batch/);
    expect(migration).toMatch(/changedPaths/);
    expect(migration).toMatch(/expectedVersion/);
    expect(migration).toMatch(/wikiWrites/);
    expect(migration).toMatch(/preferenceWrites/);
    expect(migration).toMatch(/page_revisions/);
    expect(migration).toMatch(/preference_revisions/);
    expect(migration).toMatch(/return jsonb_build_object\(\s*'ok', false,\s*'reason', 'stale'/);
  });

  it("defines create_relationship_context as the authenticated bootstrap primitive", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260506193000_hosted_relationship_bootstrap.sql"),
      "utf8"
    );
    expect(migration).toMatch(/function public\.create_relationship_context/);
    expect(migration).toMatch(/auth\.uid\(\)/);
    expect(migration).toMatch(/relationship_members/);
    expect(migration).toMatch(/contactHandle/);
    expect(migration).toMatch(/grant execute on function public\.create_relationship_context\(jsonb\) to authenticated/);
  });

  it("keeps the future workspace-agent actor explicit but outside the MVP runtime", async () => {
    const migration = await fs.readFile(migrationPath, "utf8");
    expect(migration).toMatch(/actor_kind as enum \('participant_agent', 'workspace_agent'\)/);
    expect(migration).toMatch(/actor_kind public\.actor_kind not null default 'participant_agent'/);
  });

  it("stores private-pilot connector tokens as hashes with service-only resolution", async () => {
    const migration = await fs.readFile(connectorTokensMigrationPath, "utf8");
    expect(migration).toMatch(/public\.connector_tokens/);
    expect(migration).toMatch(/token_hash text not null/);
    expect(migration).toMatch(/unique \(token_hash\)/);
    expect(migration).toMatch(/function public\.issue_connector_token/);
    expect(migration).toMatch(/function public\.resolve_connector_token/);
    expect(migration).toMatch(/auth\.role\(\) <> 'service_role'/);
    expect(migration).toMatch(/grant execute on function public\.resolve_connector_token\(text\) to service_role/);
    expect(migration).not.toMatch(/grant execute on function public\.resolve_connector_token\(text\) to authenticated/);
  });

  it("stores OAuth clients and tokens in service-only RLS tables", async () => {
    const migration = await fs.readFile(oauthMigrationPath, "utf8");
    for (const table of ["oauth_clients", "oauth_authorization_codes", "oauth_access_tokens"]) {
      expect(migration, `missing ${table}`).toMatch(new RegExp(`create table if not exists public\\.${table}\\b`, "i"));
      expect(migration, `${table} must enable RLS`).toMatch(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`, "i")
      );
    }
    expect(migration).toMatch(/client_secret_hash text/);
    expect(migration).toMatch(/code_challenge_method text not null default 'S256'/);
    expect(migration).toMatch(/refresh_token_hash text not null unique/);
    expect(migration).toMatch(/grant all on table public\.oauth_clients to service_role/);
    expect(migration).toMatch(/revoke all on table public\.oauth_access_tokens from public, anon, authenticated/);
    expect(migration).not.toMatch(/grant .*oauth_access_tokens.* to authenticated/i);
  });

  it("adds service-only RPCs for connector-token hosted graph writes", async () => {
    const migration = await fs.readFile(connectorTokensMigrationPath, "utf8");
    expect(migration).toMatch(/function public\.create_relationship_context_for_user/);
    expect(migration).toMatch(/function public\.commit_update_batch_for_user/);
    expect(migration).toMatch(/is_relationship_member_for_user/);
    expect(migration).toMatch(/grant execute on function public\.commit_update_batch_for_user\(jsonb, uuid\) to service_role/);
    expect(migration).not.toMatch(/grant execute on function public\.commit_update_batch_for_user\(jsonb, uuid\) to authenticated/);
  });

  it("adds durable Twilio notification jobs and reminders", async () => {
    const migration = await fs.readFile(notificationMigrationPath, "utf8");
    expect(migration).toMatch(/create table if not exists public\.notification_jobs\b/i);
    expect(migration).toMatch(/create table if not exists public\.reminders\b/i);
    expect(migration).toMatch(/create trigger interactions_queue_notification_jobs/i);
    expect(migration).toMatch(/create trigger attention_records_queue_notification_jobs/i);
    expect(migration).toMatch(/create trigger reminders_queue_notification_job/i);
    expect(migration).toMatch(/function public\.claim_notification_jobs/);
    expect(migration).toMatch(/provider text not null default 'twilio'/);
    expect(migration).toMatch(/endpoint\.verified_at is not null/);
    expect(migration).toMatch(/grant execute on function public\.claim_notification_jobs\(text, integer\) to service_role/);
  });

  it("adds activity read indexes without adding app-view tables", async () => {
    const migration = await fs.readFile(activityIndexesMigrationPath, "utf8");
    for (const indexName of [
      "interactions_relationship_created_at_idx",
      "updates_relationship_created_at_idx",
      "resources_relationship_created_at_idx",
      "resources_interaction_idx",
      "resources_update_idx",
      "update_sources_update_idx",
      "page_revisions_update_idx",
      "notification_jobs_source_idx"
    ]) {
      expect(migration).toContain(indexName);
    }
    expect(migration).not.toMatch(/create table/i);
    expect(migration).not.toMatch(/inbox|outbox|thread/i);
  });

  it("keeps a one-minute cron fallback for notification delivery", async () => {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    expect(config.crons).toContainEqual({
      path: "/api/notifications",
      schedule: "* * * * *"
    });
  });

  it("records rejected update batches in an append-only RLS audit table", async () => {
    const migration = await fs.readFile(batchRejectionsMigrationPath, "utf8");
    expect(migration).toMatch(/create table if not exists public\.update_batch_rejections\b/i);
    expect(migration).toMatch(/alter table public\.update_batch_rejections\s+enable row level security/i);
    expect(migration).toMatch(/is_relationship_member\(relationship_id\)/);
    expect(migration).toMatch(/rejection_kind text not null check \(rejection_kind in \('stale', 'error'\)\)/);
    expect(migration).toMatch(/changed_paths jsonb not null default '\[\]'::jsonb/);
    expect(migration).toMatch(/update_batch_rejections_relationship_created_at_idx/);
    expect(migration).toMatch(/grant select, insert on table public\.update_batch_rejections to authenticated/);
    expect(migration).toMatch(/grant all on table public\.update_batch_rejections to service_role/);
    expect(migration).not.toMatch(/grant\s+(all|update|delete)[^;]*to authenticated/i);
    expect(migration).not.toMatch(/create trigger/i);
  });

  it("accepts +memsum and native connector invocation as Mem·Sum signals", () => {
    expect(hostedMcpInstructions).toMatch(/\+sum, \+dm, \+memsum, and \+dmsum/);
    expect(hostedMcpInstructions).toMatch(/invoked you natively as this connector/);
    expect(hostedMcpInstructions).toMatch(/even without a \+ prefix/);
    expect(hostedMcpInstructions).toMatch(/🥟 is Mem·Sum's brand mark/);
    expect(hostedMcpInstructions).toMatch(/never replaces plain words/);
  });

  it("derives #sum-handles as labels that select a place deterministically", () => {
    expect(sumHandleForDisplayName("Chelsea's Wedding")).toBe("#chelseas-wedding");
    expect(sumHandleForDisplayName("Dave-Lisa")).toBe("#dave-lisa");
    expect(sumHandleForDisplayName("Café Trip · 2027!!")).toBe("#cafe-trip-2027");
    expect(sumHandleForDisplayName("   ")).toBe("#sum");
    expect(sumHandleForDisplayName("x".repeat(200))).toHaveLength(65);

    expect(assignSumHandles(["Chelsea's Wedding", "Budapest", "Chelseas Wedding"])).toEqual([
      "#chelseas-wedding",
      "#budapest",
      "#chelseas-wedding-2"
    ]);

    expect(hostedMcpInstructions).toMatch(/#handle names a sum/);
    expect(hostedMcpInstructions).toMatch(/deterministically selects that sum/);
    expect(hostedMcpInstructions).toMatch(/labels, never identity/);
    expect(hostedMcpInstructions).toMatch(/explicit #handle, then the unique sum shared with that person, then the topic phrase/);
  });

  it("documents immediate +dm SMS notification behavior in hosted instructions", () => {
    expect(hostedMcpInstructions).toMatch(/list_activity/);
    expect(hostedMcpInstructions).toMatch(/recent activity/);
    expect(hostedMcpInstructions).toMatch(/\+dm @lisa hi/);
    expect(hostedMcpInstructions).toMatch(/directMessageContent/);
    expect(hostedMcpInstructions).toMatch(/one-way SMS/);
    expect(hostedMcpInstructions).toMatch(/From Dave/);
    expect(hostedMcpInstructions).toMatch(/outfit looks great/);
    expect(hostedMcpInstructions).toMatch(/addressee-label/);
    expect(hostedMcpInstructions).toMatch(/Dave's message for Lisa/);
    expect(hostedMcpInstructions).toMatch(/Message from Dave for Lisa/);
    expect(hostedMcpInstructions).toMatch(/Dave wants to remind Lisa/);
    expect(hostedMcpInstructions).toMatch(/not the only SMS path/);
    expect(hostedMcpInstructions).toMatch(/fully resolved ISO 8601 datetime with a UTC offset/);
    expect(hostedMcpInstructions).toMatch(/natural-language or offsetless times are rejected/);
    expect(hostedMcpInstructions).toMatch(/do not claim final delivery/);
    expect(hostedMcpInstructions).toMatch(/more than two participants/);
    expect(hostedMcpInstructions).toMatch(/adds the sum's display name to the From envelope/);
    expect(hostedRecommendedWorkflow.join("\n")).toMatch(/direct \+dm social acts/);
    expect(hostedRecommendedWorkflow.join("\n")).toMatch(/exactly one one-way SMS/);
    expect(hostedRecommendedWorkflow.join("\n")).toMatch(/Mem·Sum adds the From sender envelope/);
    expect(hostedRecommendedWorkflow.join("\n")).toMatch(/for Lisa/);
    expect(hostedRecommendedWorkflow.join("\n")).toMatch(/never use create_reminder for an immediate tell\/send\/message request/);
    expect(hostedResolvedContactWorkflow.join("\n")).toMatch(/skip commit_update_batch/);
    expect(hostedResolvedContactWorkflow.join("\n")).toMatch(/skip commit_update_batch and create_reminder/);
    expect(hostedRecommendedWorkflow.join("\n")).toMatch(/list_activity/);
    expect(hostedResolvedContactWorkflow.join("\n")).toMatch(/list_activity/);
    expect(hostedMcpInstructions).not.toMatch(/inbox|outbox|thread/i);
  });
});

describe("Mem·Sum Phase 0 hardening", () => {
  it("centralizes product naming, participant cap, and host configuration", () => {
    expect(PRODUCT_NAME).toBe("Mem·Sum");
    expect(LEGACY_PRODUCT_NAME).toBe("DM Sum");
    expect(DEFAULT_PARTICIPANT_CAP).toBe(5);
    expect(participantCap({})).toBe(5);
    expect(participantCap({ MEMSUM_PARTICIPANT_CAP: "8" })).toBe(8);
    expect(participantCap({ MEMSUM_PARTICIPANT_CAP: "1" })).toBe(2);
    expect(participantCap({ MEMSUM_PARTICIPANT_CAP: "not-a-number" })).toBe(5);
    expect(productHosts({})).toEqual({ siteUrl: "https://memsum.ai", mcpUrl: "https://sum.memsum.ai" });
    expect(
      productHosts({ MEMSUM_SITE_URL: "https://staging.memsum.ai/", MEMSUM_MCP_URL: "https://sum-staging.memsum.ai" })
    ).toEqual({
      siteUrl: "https://staging.memsum.ai",
      mcpUrl: "https://sum-staging.memsum.ai"
    });
  });

  it("classifies rejected batch results without treating successes as rejections", () => {
    expect(isRejectedBatchResult({ ok: false, reason: "stale", changedPaths: ["wiki/index.md"] })).toBe(true);
    expect(isRejectedBatchResult({ ok: false })).toBe(true);
    expect(isRejectedBatchResult({ ok: true, updateId: "55555555-5555-4555-8555-555555555555" })).toBe(false);
    expect(isRejectedBatchResult(null)).toBe(false);
    expect(isRejectedBatchResult("stale")).toBe(false);
  });

  it("shapes rejection audit records from the attempted batch", () => {
    const parsed = commitUpdateBatchSchema.parse({
      relationshipId: ids.relationshipId,
      participantId: ids.participantId,
      agent: "Dave-Codex",
      sourceInteractionIds: [ids.interactionId],
      displayText: "Updated the Sonoma weekend.",
      readSet: [
        { kind: "wiki_page", path: "wiki/index.md", expectedVersion: 6 },
        { kind: "wiki_page", path: "wiki/topics/sonoma-weekend.md", expectedVersion: 3 }
      ],
      wikiWrites: [
        {
          path: "wiki/topics/sonoma-weekend.md",
          title: "Sonoma Weekend",
          expectedVersion: 3,
          content: "# Sonoma Weekend\n"
        }
      ]
    });

    const record = buildUpdateBatchRejectionRecord(parsed, "stale", "stale", ["wiki/topics/sonoma-weekend.md", 42]);
    expect(record).toEqual({
      relationship_id: ids.relationshipId,
      participant_id: ids.participantId,
      agent: "Dave-Codex",
      rejection_kind: "stale",
      reason: "stale",
      changed_paths: ["wiki/topics/sonoma-weekend.md"],
      read_set_size: 2,
      wiki_write_paths: ["wiki/topics/sonoma-weekend.md"],
      preference_write_count: 0
    });

    const long = buildUpdateBatchRejectionRecord(parsed, "error", `${"x".repeat(3000)}  `, undefined);
    expect(long.rejection_kind).toBe("error");
    expect(long.reason).toHaveLength(2000);
    expect(long.changed_paths).toEqual([]);

    const blank = buildUpdateBatchRejectionRecord(parsed, "error", "   ", null);
    expect(blank.reason).toBe("rejected");
  });
});

describe("Mem·Sum invitations kernel", () => {
  it("generates one-time invite tokens and owner-deliverable links from product hosts", () => {
    const token = createInviteToken();
    expect(token).toMatch(/^memsum_invite_[A-Za-z0-9_-]{40,}$/);
    expect(createInviteToken()).not.toBe(token);
    expect(hashConnectorToken(token)).toMatch(/^[a-f0-9]{64}$/);

    expect(buildInviteLink(token)).toBe(`https://memsum.ai/invite/${token}`);
    expect(buildInviteLink(token, { MEMSUM_SITE_URL: "https://staging.memsum.ai/" })).toBe(
      `https://staging.memsum.ai/invite/${token}`
    );
  });

  it("defines link invitations with hashed one-time tokens and optional delivery targets", async () => {
    const migration = await fs.readFile(invitationsMigrationPath, "utf8");
    expect(migration).toMatch(/alter table public\.invitations add column if not exists token_hash text/);
    expect(migration).toMatch(/invitations_token_hash_idx/);
    expect(migration).toMatch(/alter table public\.invitations alter column target_kind drop not null/);
    expect(migration).toMatch(/target_kind is null and target_value_normalized is null/);
    expect(migration).not.toMatch(/token text\b/);
  });

  it("defines the claim transaction as bind-participant plus membership plus acceptance", async () => {
    const migration = await fs.readFile(invitationsMigrationPath, "utf8");
    expect(migration).toMatch(/function public\.claim_invitation\(p_token_hash text\)/);
    expect(migration).toMatch(/security definer/);
    expect(migration).toMatch(/auth\.uid\(\)/);
    expect(migration).toMatch(/for update/);
    expect(migration).toMatch(/set user_id = v_user_id/);
    expect(migration).toMatch(/insert into public\.relationship_members \(relationship_id, user_id, participant_id, role\)/);
    expect(migration).toMatch(/'accepted'/);
    expect(migration).toMatch(/'reason', 'expired'/);
    expect(migration).toMatch(/'reason', 'already_a_member'/);
    expect(migration).toMatch(/'reason', 'participant_already_claimed'/);
    expect(migration).toMatch(/alreadyClaimed/);
  });

  it("enforces owner-only invites and the configured participant cap inside the transaction", async () => {
    const migration = await fs.readFile(invitationsMigrationPath, "utf8");
    expect(migration).toMatch(/function public\.create_participant_invitation\(payload jsonb\)/);
    expect(migration).toMatch(/'reason', 'owner_only'/);
    expect(migration).toMatch(/participantCap/);
    expect(migration).toMatch(/v_participant_count >= v_cap/);
    expect(migration).toMatch(/'reason', 'participant_cap'/);
    expect(migration).toMatch(/perform 1 from public\.relationships where id = v_relationship_id for update/);
    expect(migration).toMatch(/set status = 'revoked', revoked_at = now\(\)/);
    expect(migration).toMatch(/function public\.revoke_invitation\(p_invitation_id uuid\)/);
    expect(migration).toMatch(/function public\.list_invitations\(p_relationship_id uuid\)/);
    expect(migration).toMatch(/is_relationship_member\(p_relationship_id\)/);
  });

  it("hashes verification codes through extensions.digest, which the live harness proved reachable", async () => {
    // The original migration called bare digest() under search_path=public;
    // pgcrypto lives in the extensions schema on Supabase, so real
    // verification attempts failed at runtime. Caught by test/live.test.ts
    // on its first run, 2026-07-08.
    const fix = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708130000_phone_verification_digest_fix.sql"),
      "utf8"
    );
    expect(fix).toMatch(/encode\(extensions\.digest\(v_code, 'sha256'\), 'hex'\)/);
    expect(fix).toMatch(/encode\(extensions\.digest\(trim\(p_code\), 'sha256'\), 'hex'\)/);
    expect(fix).not.toMatch(/encode\(digest\(/);
  });

  it("verifies phones with server-generated hashed codes over the existing job pipeline", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708090000_phone_verification.sql"),
      "utf8"
    );
    expect(migration).toMatch(/alter type public\.notification_job_source_kind add value if not exists 'verification'/);
    expect(migration).toMatch(/create table if not exists public\.phone_verification_codes/);
    expect(migration).toMatch(/revoke all on table public\.phone_verification_codes from public, anon, authenticated/);
    expect(migration).toMatch(/function public\.start_phone_verification\(p_participant_id uuid, p_phone text\)/);
    expect(migration).toMatch(/function public\.confirm_phone_verification\(p_participant_id uuid, p_code text\)/);
    expect(migration).toMatch(/function public\.set_notification_enabled\(p_participant_id uuid, p_enabled boolean\)/);
    expect(migration).toMatch(/encode\(digest\(v_code, 'sha256'\), 'hex'\)/);
    expect(migration).toMatch(/interval '60 seconds'/);
    expect(migration).toMatch(/interval '10 minutes'/);
    expect(migration).toMatch(/attempt_count >= 5/);
    expect(migration).toMatch(/insert into public\.notification_jobs/);
    expect(migration).toMatch(/'verification'::public\.notification_job_source_kind/);
    expect(migration).not.toMatch(/'code', v_code/);
    expect(migration).toMatch(/set verified_at = now\(\), enabled = true/);
  });

  it("lets members leave while the graph and their attribution persist", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708070000_leave_relationship.sql"),
      "utf8"
    );
    expect(migration).toMatch(/function public\.leave_relationship\(p_relationship_id uuid\)/);
    expect(migration).toMatch(/security definer/);
    expect(migration).toMatch(/'reason', 'owner_cannot_leave'/);
    expect(migration).toMatch(/'reason', 'not_found'/);
    expect(migration).toMatch(/set user_id = null, updated_at = now\(\)/);
    expect(migration).toMatch(/delete from public\.relationship_members where id = v_membership\.id/);
    expect(migration).not.toMatch(/delete from public\.(relationships|participants|interactions|wiki_pages)/);
    expect(migration).toMatch(/revoke all on function public\.leave_relationship\(uuid\) from public, anon/);
    expect(migration).toMatch(/grant execute on function public\.leave_relationship\(uuid\) to authenticated/);
  });

  it("deletes accounts while shared records survive their author", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708110000_delete_account.sql"),
      "utf8"
    );
    expect(migration).toMatch(/alter table public\.interactions alter column actor_user_id drop not null/);
    expect(migration).toMatch(/foreign key \(actor_user_id\) references auth\.users\(id\) on delete set null/);
    expect(migration).toMatch(/foreign key \(created_by\) references auth\.users\(id\) on delete set null/);
    expect(migration).toMatch(
      /foreign key \(notification_endpoint_id\) references public\.notification_endpoints\(id\) on delete cascade/
    );
    expect(migration).toMatch(/function public\.delete_account\(\)/);
    expect(migration).toMatch(/security definer/);
    expect(migration).toMatch(/'reason', 'owns_shared_sums'/);
    expect(migration.indexOf("owns_shared_sums")).toBeLessThan(migration.indexOf("delete from public.relationships"));
    expect(migration).toMatch(/delete from auth\.users where id = v_user_id/);
    expect(migration).toMatch(/revoke all on function public\.delete_account\(\) from public, anon/);
    expect(migration).toMatch(/grant execute on function public\.delete_account\(\) to authenticated/);
  });

  it("renames sums through an owner-only RPC that never touches identity", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708060000_rename_relationship.sql"),
      "utf8"
    );
    expect(migration).toMatch(/function public\.rename_relationship\(p_relationship_id uuid, p_display_name text\)/);
    expect(migration).toMatch(/security definer/);
    expect(migration).toMatch(/'reason', 'owner_only'/);
    expect(migration).toMatch(/'reason', 'not_found'/);
    expect(migration).toMatch(/'reason', 'invalid_name'/);
    expect(migration).toMatch(/update public\.relationships\s+set display_name = v_name, updated_at = now\(\)/);
    expect(migration).toMatch(/revoke all on function public\.rename_relationship\(uuid, text\) from public, anon/);
    expect(migration).toMatch(/grant execute on function public\.rename_relationship\(uuid, text\) to authenticated/);
    expect(migration).not.toMatch(/delete/i);
  });

  it("keeps same-user re-claims idempotent ahead of the pending-status check", async () => {
    const fixMigration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708040000_claim_invitation_idempotency.sql"),
      "utf8"
    );
    expect(fixMigration).toMatch(/create or replace function public\.claim_invitation\(p_token_hash text\)/);
    const idempotentIndex = fixMigration.indexOf("alreadyClaimed");
    const notPendingIndex = fixMigration.indexOf("'reason', 'not_pending'");
    expect(idempotentIndex).toBeGreaterThan(-1);
    expect(notPendingIndex).toBeGreaterThan(-1);
    expect(idempotentIndex).toBeLessThan(notPendingIndex);
  });

  it("grants invitation RPCs to authenticated users and revokes anonymous execution", async () => {
    const migration = await fs.readFile(invitationsMigrationPath, "utf8");
    for (const signature of [
      "create_participant_invitation\\(jsonb\\)",
      "claim_invitation\\(text\\)",
      "revoke_invitation\\(uuid\\)",
      "list_invitations\\(uuid\\)"
    ]) {
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${signature} from public, anon`));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${signature} to authenticated`));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${signature} to service_role`));
    }
  });
});

describe("Mem·Sum discovery and onboarding surfaces", () => {
  it("serves an origin-derived MCP server card without requiring Supabase configuration", async () => {
    const response = await handleHostedOAuthRequest(
      new Request("https://example.com/.well-known/mcp/server-card.json"),
      {}
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "memsum-hosted",
        homepage: "https://example.com"
      },
      transport: {
        type: "streamable-http",
        endpoint: "https://example.com/mcp"
      },
      capabilities: {
        tools: true,
        resources: true,
        prompts: false
      },
      authentication: {
        type: "oauth2",
        authorizationEndpoint: "https://example.com/oauth/authorize",
        tokenEndpoint: "https://example.com/oauth/token",
        registrationEndpoint: "https://example.com/oauth/register"
      }
    });
  });

  it("routes the server card path through the oauth function in vercel.json", async () => {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), "vercel.json"), "utf8")) as {
      rewrites?: Array<{ source?: string; destination?: string }>;
    };
    expect(config.rewrites).toContainEqual({
      source: "/.well-known/mcp/:path*",
      destination: "/api/oauth"
    });
  });

  it("labels every hosted tool with safety annotations", async () => {
    const tools = await hostedMcpPost({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/list",
      params: {}
    });

    expect(tools.status).toBe(200);
    const byName = new Map<string, { annotations?: Record<string, unknown> }>(
      tools.body.result.tools.map((tool: { name: string }) => [tool.name, tool])
    );

    for (const name of hostedToolNames) {
      const annotations = byName.get(name)?.annotations;
      expect(annotations, `${name} must carry safety annotations`).toBeTruthy();
      expect(typeof annotations?.readOnlyHint, `${name} must declare readOnlyHint`).toBe("boolean");
    }

    expect(byName.get("read_page")?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(byName.get("list_activity")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get("commit_update_batch")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    });
    expect(byName.get("commit_interaction")?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.get("create_reminder")?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(byName.get("create_relationship_context")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false
    });
  });

  it("renders a dual-method consent page with sign-in primary and token fallback", () => {
    const params = new URLSearchParams({ client_id: "dmsum_client_test", state: "abc123" });
    const html = buildConsentHtml(params, 'ChatGPT<script>alert("x")</script>', {
      error: "Sign-in failed. Check your email and password, or use a connector token instead.",
      email: "lisa@example.com"
    });

    expect(html).toContain('name="auth_method" value="password"');
    expect(html).toContain('name="auth_method" value="connector_token"');
    expect(html).toContain('name="email"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('name="connector_token"');
    expect(html).toContain('value="lisa@example.com"');
    expect(html).toContain('name="state" value="abc123"');
    expect(html).toContain("Sign-in failed.");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("ChatGPT&lt;script&gt;");
    // Password errors keep the token section collapsed; token errors open it.
    expect(html).not.toContain("<details open>");
    expect(buildConsentHtml(params, "Claude", { error: "That connector token was not accepted." })).toContain("<details open>");
  });

  it("signs consent-page users in through the Supabase password grant", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const okFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ access_token: "jwt", user: { id: ids.participantId } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    await expect(
      signInWithPasswordGrant({
        supabaseUrl: "https://example.supabase.co",
        apiKey: "service-key",
        email: "lisa@example.com",
        password: "correct horse",
        fetchFn: okFetch
      })
    ).resolves.toBe(ids.participantId);

    expect(calls[0]?.input).toBe("https://example.supabase.co/auth/v1/token?grant_type=password");
    expect(calls[0]?.init?.headers).toMatchObject({ apikey: "service-key" });
    expect(String(calls[0]?.init?.body)).toContain('"email":"lisa@example.com"');

    const rejectedFetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    await expect(
      signInWithPasswordGrant({
        supabaseUrl: "https://example.supabase.co",
        apiKey: "service-key",
        email: "lisa@example.com",
        password: "wrong",
        fetchFn: rejectedFetch
      })
    ).resolves.toBeNull();

    const malformedFetch = (async () => new Response(JSON.stringify({ access_token: "jwt" }), { status: 200 })) as typeof fetch;
    await expect(
      signInWithPasswordGrant({
        supabaseUrl: "https://example.supabase.co",
        apiKey: "service-key",
        email: "lisa@example.com",
        password: "correct horse",
        fetchFn: malformedFetch
      })
    ).resolves.toBeNull();
  });

  it("guides fresh accounts to their first sum through an in-chat empty state", () => {
    const emptyPayload = buildHostedInstructionsPayload({ relationshipContexts: { relationships: [] } });
    expect(emptyPayload.emptyStateGuidance).toBe(hostedEmptyStateGuidance);
    expect(emptyPayload.emptyStateGuidance).toMatch(/create_relationship_context/);
    // Private-first onboarding (Phase 3): the empty state offers "just for
    // them" before assuming a second person.
    expect(emptyPayload.emptyStateGuidance).toMatch(/just for them or shared/);
    expect(emptyPayload.emptyStateGuidance).toMatch(/useful from the first minute/);

    const populatedPayload = buildHostedInstructionsPayload({
      relationshipContexts: { relationships: [{ relationship: { id: ids.relationshipId } }] }
    });
    expect(populatedPayload.emptyStateGuidance).toBeUndefined();

    expect(buildHostedInstructionsPayload().emptyStateGuidance).toBeUndefined();
  });
});

describe("Mem·Sum rate limiting", () => {
  it("counts fixed windows in a self-resetting service-only counter", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708120000_rate_limits.sql"),
      "utf8"
    );
    expect(migration).toMatch(/create table if not exists public\.rate_limit_counters/);
    expect(migration).toMatch(/key text primary key/);
    expect(migration).toMatch(/when c\.window_start = excluded\.window_start then c\.hits \+ 1 else 1/);
    expect(migration).toMatch(/auth\.role\(\) <> 'service_role'/);
    expect(migration).toMatch(/'retryAfterSeconds'/);
    // The browser must never consult limits: authenticated is revoked too,
    // unlike ordinary participant-facing RPCs.
    expect(migration).toMatch(
      /revoke all on function public\.check_rate_limit\(text, integer, integer\) from public, anon, authenticated/
    );
    expect(migration).not.toMatch(/grant execute on function public\.check_rate_limit[^;]*to authenticated/);
  });

  it("keys clients by first-hop IP and credentials by hash prefix", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");

    const subject = rateLimitSubjectForToken("dmsum_secret-token");
    expect(subject).toMatch(/^[a-f0-9]{16}$/);
    expect(subject).toBe(rateLimitSubjectForToken("dmsum_secret-token"));
    expect(subject).not.toContain("dmsum");
  });

  it("relays counter decisions and fails open when the counter is unreachable", async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const blockedFetch = (async (url: any, init: any) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ allowed: false, remaining: 0, retryAfterSeconds: 42 }), { status: 200 });
    }) as typeof fetch;

    const rule = { name: "mcp", maxHits: 120, windowSeconds: 60 };
    const env = { supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-key", fetchFn: blockedFetch };
    const decision = await checkHostedRateLimit(env, rule, "abc123");
    expect(decision).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    expect(requests[0].url).toBe("https://example.supabase.co/rest/v1/rpc/check_rate_limit");
    expect(requests[0].body).toEqual({ p_key: "mcp:abc123", p_max_hits: 120, p_window_seconds: 60 });

    const failingFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(checkHostedRateLimit({ ...env, fetchFn: failingFetch }, rule, "abc123")).resolves.toMatchObject({
      allowed: true
    });

    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(checkHostedRateLimit({ ...env, fetchFn: throwingFetch }, rule, "abc123")).resolves.toMatchObject({
      allowed: true
    });
  });

  it("rejects with a structured 429 an agent can relay, and skips limiting without env", async () => {
    const response = rateLimitedResponse({ allowed: false, remaining: 0, retryAfterSeconds: 42 }, "MCP");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    const body = await response.json();
    expect(body.error).toBe("rate_limited");
    expect(body.error_description).toMatch(/Retry in 42 seconds/);
    expect(body.retryAfterSeconds).toBe(42);

    const rules = hostedRateLimitRules();
    expect(rules.mcpPerCredential.windowSeconds).toBe(60);
    await expect(
      hostedRateLimitResponse(new Request("https://sum.memsum.ai/mcp", { method: "POST" }), rules.mcpPerCredential, "abc", "MCP", {})
    ).resolves.toBeNull();
  });
});

describe("Mem·Sum inbound STOP/START reflection", () => {
  function recordingSupabase(rows: Array<{ id: string }>) {
    const calls: any[] = [];
    return {
      calls,
      from(table: string) {
        const chain = {
          update(payload: any) {
            calls.push({ table, payload, filters: [] as Array<[string, string]> });
            return chain;
          },
          eq(column: string, value: string) {
            calls[calls.length - 1].filters.push([column, value]);
            return chain;
          },
          select() {
            return Promise.resolve({ data: rows, error: null });
          }
        };
        return chain;
      }
    };
  }

  function signedInboundRequest(params: Record<string, string>, token: string, urlOverride?: string): Request {
    const url = urlOverride ?? "https://dmsum-hosted-mvp.vercel.app/api/twilio";
    return new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioRequestSignature(token, url, params)
      },
      body: new URLSearchParams(params).toString()
    });
  }

  it("classifies exact opt keywords and leaves conversation alone", () => {
    expect(classifyInboundSmsKeyword("STOP")).toBe("stop");
    expect(classifyInboundSmsKeyword("  stop ")).toBe("stop");
    expect(classifyInboundSmsKeyword("Unsubscribe")).toBe("stop");
    expect(classifyInboundSmsKeyword("QUIT")).toBe("stop");
    expect(classifyInboundSmsKeyword("START")).toBe("start");
    expect(classifyInboundSmsKeyword("yes")).toBe("start");
    expect(classifyInboundSmsKeyword("UNSTOP")).toBe("start");
    expect(classifyInboundSmsKeyword("stop it please")).toBeNull();
    expect(classifyInboundSmsKeyword("")).toBeNull();
  });

  it("validates Twilio signatures over the reconstructed external URL", () => {
    const token = "test-auth-token";
    const url = "https://dmsum-hosted-mvp.vercel.app/api/twilio";
    const params = { From: "+16155550100", Body: "STOP", MessageSid: "SM123" };
    const signature = twilioRequestSignature(token, url, params);
    expect(isValidTwilioSignature(token, url, params, signature)).toBe(true);
    expect(isValidTwilioSignature(token, url, { ...params, Body: "START" }, signature)).toBe(false);
    expect(isValidTwilioSignature(token, url, params, null)).toBe(false);
    expect(isValidTwilioSignature(token, url, params, "forged")).toBe(false);

    const forwarded = new Request("http://127.0.0.1:3000/api/twilio", {
      method: "POST",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "sum.memsum.ai" }
    });
    expect(inboundRequestUrl(forwarded)).toBe("https://sum.memsum.ai/api/twilio");
  });

  it("flips every endpoint bearing the phone, since carrier opt-out is global per number", async () => {
    const supabase = recordingSupabase([{ id: "a" }, { id: "b" }]);
    const stopped = await applyInboundSmsKeyword({ supabase, phone: "+16155550100", action: "stop" });
    expect(stopped.updatedEndpoints).toBe(2);
    expect(supabase.calls[0].table).toBe("notification_endpoints");
    expect(supabase.calls[0].payload).toEqual({ enabled: false });
    expect(supabase.calls[0].filters).toEqual([
      ["kind", "sms"],
      ["value_normalized", "+16155550100"]
    ]);

    await applyInboundSmsKeyword({ supabase, phone: "+16155550100", action: "start" });
    expect(supabase.calls[1].payload).toEqual({ enabled: true });
  });

  it("mutates nothing without a valid signature and answers keywords with empty TwiML", async () => {
    const token = "test-auth-token";
    const env = { TWILIO_AUTH_TOKEN: token } as NodeJS.ProcessEnv;

    const get = await handleTwilioInboundSmsRequest(new Request("https://x.example/api/twilio"), env, recordingSupabase([]));
    expect(get.status).toBe(405);

    const unconfigured = await handleTwilioInboundSmsRequest(
      signedInboundRequest({ From: "+16155550100", Body: "STOP" }, token),
      {} as NodeJS.ProcessEnv,
      recordingSupabase([])
    );
    expect(unconfigured.status).toBe(503);

    const forged = signedInboundRequest({ From: "+16155550100", Body: "STOP" }, "wrong-token");
    const rejected = await handleTwilioInboundSmsRequest(forged, env, recordingSupabase([]));
    expect(rejected.status).toBe(403);

    const supabase = recordingSupabase([{ id: "a" }]);
    const accepted = await handleTwilioInboundSmsRequest(
      signedInboundRequest({ From: "+16155550100", Body: "STOP" }, token),
      env,
      supabase
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("content-type")).toBe("text/xml");
    await expect(accepted.text()).resolves.toContain("<Response/>");
    expect(supabase.calls).toHaveLength(1);

    const conversational = recordingSupabase([]);
    const ignored = await handleTwilioInboundSmsRequest(
      signedInboundRequest({ From: "+16155550100", Body: "see you at noon" }, token),
      env,
      conversational
    );
    expect(ignored.status).toBe(200);
    expect(conversational.calls).toHaveLength(0);
  });
});

describe("Mem·Sum structured rejections", () => {
  it("classifies storage failures: intentional guards relay verbatim, infrastructure gets a plain prefix", () => {
    const guard = storageError({ message: "Mem·Sum relationship access denied", code: "P0001" }) as Error & {
      status: number;
    };
    expect(guard.status).toBe(400);
    expect(guard.message).toBe("Mem·Sum relationship access denied");

    const infra = storageError({
      message: 'duplicate key value violates unique constraint "wiki_pages_pkey"',
      code: "23505"
    }) as Error & { status: number };
    expect(infra.status).toBe(500);
    expect(infra.message).toMatch(/^Mem·Sum storage error: /);

    const codeless = storageError({ message: "fetch failed" }) as Error & { status: number };
    expect(codeless.status).toBe(500);
  });

  it("keeps the rejection-reason inventory deliberate: new reasons must be registered here", async () => {
    const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
    const files = await fs.readdir(migrationsDir);
    const found = new Set<string>();
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      for (const match of sql.matchAll(/'reason', '([a-z_]+)'/g)) {
        found.add(match[1]);
      }
    }
    // Every reason an agent can receive from the graph, reviewed for
    // legibility 2026-07-08. Adding a reason means adding it here — that
    // moment is the legibility review.
    const registered = [
      "already_a_member",
      "already_verified",
      "expired",
      "invalid_code",
      "invalid_name",
      "invalid_phone",
      "invalid_token",
      "no_endpoint",
      "no_participant",
      "no_pending_code",
      "not_found",
      "not_pending",
      "owner_cannot_leave",
      "owner_only",
      "owns_shared_sums",
      "participant_already_claimed",
      "participant_cap",
      "stale",
      "too_many_attempts",
      "too_soon"
    ];
    expect([...found].sort()).toEqual(registered);
  });

  it("tells agents to relay structured rejections in plain language", () => {
    expect(hostedMcpInstructions).toMatch(/stable snake_case reason/);
    expect(hostedMcpInstructions).toMatch(/changedPaths, sums, or retryAfterSeconds/);
    expect(hostedMcpInstructions).toMatch(/plain language, not raw tokens/);
    expect(hostedMcpInstructions).toMatch(/rate_limited after waiting retryAfterSeconds/);
  });

  it("enforces hardcoded, visible pilot limits at the storage layer", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708150000_pilot_limits.sql"),
      "utf8"
    );
    expect(migration).toMatch(/function public\.pilot_limits\(\)/);
    expect(migration).toMatch(/'sumsCreatedPerAccount', 10/);
    expect(migration).toMatch(/'updatesPerSumPerDay', 200/);
    expect(migration).toMatch(/'interactionsPerSumPerDay', 500/);
    expect(migration).toMatch(/'remindersPerSumPerDay', 50/);
    expect(migration).toMatch(/'pagesPerSum', 500/);
    expect(migration).toMatch(/'pageContentMaxBytes', 262144/);
    // The dashboard reads the same numbers users are held to.
    expect(migration).toMatch(/grant execute on function public\.pilot_limits\(\) to authenticated/);
    // One trigger per guarded table, so every write path is covered uniformly.
    for (const table of ["relationships", "updates", "interactions", "reminders", "wiki_pages", "preferences"]) {
      expect(migration).toMatch(new RegExp(`create trigger ${table}_pilot_limit`));
    }
    // Rejections raise with plain-language messages the storageError
    // classifier relays verbatim.
    expect(migration).toMatch(/raise exception 'DM Sum pilot limit: the free beta allows % sums created per account'/);
    expect(migration).toMatch(/raise exception 'DM Sum pilot limit: a wiki page may hold up to % bytes'/);

    expect(hostedMcpInstructions).toMatch(/pilot limits/);
    expect(hostedMcpInstructions).toMatch(/names the limit and the number in plain language/);
  });
});

describe("Mem·Sum OKF interchange (profile v0.1)", () => {
  const pages = [
    {
      path: "wiki/index.md",
      title: "Index",
      content: "# Index\n\n- [[wiki/topics/budapest.md|Budapest Trip]]\n- [[Lisa]]\n",
      version: 3,
      updatedAt: "2026-07-08T01:00:00Z"
    },
    {
      path: "wiki/topics/budapest.md",
      title: "Budapest Trip",
      content: "# Budapest Trip\n\nSee [[wiki/entities/lisa.md]] and [[Chain Bridge]] and [[concepts/red-eyes]].\n",
      version: 5,
      updatedAt: "2026-07-07T20:00:00Z"
    },
    {
      path: "wiki/entities/lisa.md",
      title: "Lisa",
      content: "# Lisa\n\nHates red-eyes.\n",
      version: 2,
      updatedAt: "2026-07-06T10:00:00Z"
    }
  ];
  const meta = {
    profile: "share" as const,
    sourceSubstrate: "Mem·Sum hosted graph",
    relationshipDisplayName: "Dave-Lisa",
    exportedAt: "2026-07-08T12:00:00Z"
  };
  const updates = [
    {
      displayText: "Added flight options to the Budapest trip",
      createdAt: "2026-07-07T20:00:00Z",
      changedPages: [{ path: "wiki/topics/budapest.md", title: "Budapest Trip" }]
    },
    {
      displayText: "Captured Lisa's red-eye rule",
      createdAt: "2026-07-06T10:00:00Z",
      changedPages: [{ path: "wiki/entities/lisa.md", title: "Lisa" }]
    }
  ];

  it("maps directory prefixes to the §3.5 type vocabulary", () => {
    expect(okfTypeForPath("wiki/topics/budapest.md")).toBe("Topic");
    expect(okfTypeForPath("wiki/entities/lisa.md")).toBe("Entity");
    expect(okfTypeForPath("wiki/concepts/red-eyes.md")).toBe("Concept");
    expect(okfTypeForPath("wiki/synthesis/year-one.md")).toBe("Synthesis");
    expect(okfTypeForPath("wiki/sources/article.md")).toBe("Source");
    expect(okfTypeForPath("wiki/index.md")).toBe("Topic");
  });

  it("rewrites wiki links bundle-absolute and leaves out-of-scope links honestly broken", () => {
    const rewritten = rewriteWikiLinksForBundle(pages[1].content, pages);
    expect(rewritten).toContain("[wiki/entities/lisa.md](/wiki/entities/lisa.md)");
    // Title with no in-scope target: rewritten to the path it would have had.
    expect(rewritten).toContain("[Chain Bridge](/wiki/topics/chain-bridge.md)");
    // Path-shaped target outside scope keeps its would-be path.
    expect(rewritten).toContain("[concepts/red-eyes](/wiki/concepts/red-eyes.md)");
    // Title and alias resolution against in-scope pages.
    const indexRewritten = rewriteWikiLinksForBundle(pages[0].content, pages);
    expect(indexRewritten).toContain("[Budapest Trip](/wiki/topics/budapest.md)");
    expect(indexRewritten).toContain("[Lisa](/wiki/entities/lisa.md)");
  });

  it("produces a conformant golden bundle: every markdown file typed, reserved files shaped", () => {
    const files = buildOkfBundle({ meta, pages, updates });
    const paths = files.map((file) => file.path);
    expect(paths).toEqual(["index.md", "log.md", "wiki/index.md", "wiki/topics/budapest.md", "wiki/entities/lisa.md"]);

    for (const file of files) {
      expect(file.content.startsWith("---\n")).toBe(true);
      expect(file.content).toMatch(/\ntype: [A-Za-z]+/);
    }

    const root = files[0].content;
    expect(root).toContain('okf_version: "0.1"');
    expect(root).toContain("profile: share");
    expect(root).toContain('relationship: "Dave-Lisa"');
    expect(root).toContain('  - path: "/wiki/topics/budapest.md"\n    version: 5');
    expect(root).toContain("remains canonical");

    const log = files[1].content;
    expect(log.indexOf("## 2026-07-07")).toBeLessThan(log.indexOf("## 2026-07-06"));
    expect(log).toContain("- **Added flight options to the Budapest trip** — [Budapest Trip](/wiki/topics/budapest.md)");

    const budapest = files[3].content;
    expect(budapest).toContain("type: Topic");
    expect(budapest).toContain('title: "Budapest Trip"');
    expect(budapest).toContain('timestamp: "2026-07-07T20:00:00Z"');
    expect(budapest).toContain("# Budapest Trip");
  });

  it("keeps the ledger out of share bundles and in archive bundles", () => {
    const interactions = [
      {
        id: "11111111-2222-4333-8444-555555555555",
        rawText: "+sum remember that Lisa hates red-eyes",
        agent: "Dave-OpenAI",
        participantDisplayName: "Dave",
        createdAt: "2026-07-06T10:00:00Z"
      }
    ];
    const preferences = [
      { participantDisplayName: "Dave", content: "# Dave Preferences\n\nTen items by default.", version: 1, updatedAt: "2026-07-01T00:00:00Z" }
    ];

    const share = buildOkfBundle({ meta, pages, updates, interactions, preferences });
    expect(share.some((file) => file.path.startsWith("interactions/"))).toBe(false);
    expect(share.some((file) => file.path.startsWith("preferences/"))).toBe(false);

    const archive = buildOkfBundle({ meta: { ...meta, profile: "archive" }, pages, updates, interactions, preferences });
    const interaction = archive.find((file) => file.path === "interactions/11111111-2222-4333-8444-555555555555.md");
    expect(interaction?.content).toContain("type: Interaction");
    expect(interaction?.content).toContain("+sum remember that Lisa hates red-eyes");
    expect(interaction?.content).toContain("— Dave via Dave-OpenAI");
    const preference = archive.find((file) => file.path === "preferences/dave.md");
    expect(preference?.content).toContain("type: Preference");
    expect(preference?.content).toContain("Ten items by default.");
  });

  it("narrows the log with --since without touching page selection", () => {
    const sinceMeta = { ...meta, since: "2026-07-07" };
    const files = buildOkfBundle({ meta: sinceMeta, pages, updates });
    const log = files[1].content;
    expect(log).toContain("Added flight options");
    expect(log).not.toContain("red-eye rule");
    expect(files.map((file) => file.path)).toContain("wiki/entities/lisa.md");
  });
});

describe("Mem·Sum export-your-data endpoint", () => {
  function stubExportClient(rows: {
    relationship?: { id: string; display_name: string } | null;
    pages?: any[];
    interactions?: any[];
    preferences?: any[];
  }) {
    const audits: any[] = [];
    function tableResult(table: string) {
      if (table === "relationships") return { data: rows.relationship ?? null, error: null };
      if (table === "wiki_pages") return { data: rows.pages ?? [], error: null };
      if (table === "updates") return { data: [], error: null };
      if (table === "interactions") return { data: rows.interactions ?? [], error: null };
      if (table === "preferences") return { data: rows.preferences ?? [], error: null };
      return { data: null, error: null };
    }
    return {
      audits,
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from(table: string) {
        const result = tableResult(table);
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          maybeSingle: async () => result,
          insert: async (payload: any) => {
            audits.push({ table, payload });
            return { error: null };
          },
          then: (resolve: any) => resolve(result)
        };
        return chain;
      }
    };
  }

  function exportRequest(body: unknown, token = "supabase-jwt-example"): Request {
    return new Request("https://dmsum-hosted-mvp.vercel.app/api/export", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  const relationship = { id: "rel-1", display_name: "Dave-Lisa" };
  const pageRows = [
    { path: "wiki/index.md", title: "Index", content: "# Index", version: 1, updated_at: "2026-07-08T00:00:00Z" }
  ];

  it("audits every export where all members can see it", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708160000_export_audits.sql"),
      "utf8"
    );
    expect(migration).toMatch(/create table if not exists public\.export_audits/);
    expect(migration).toMatch(/profile in \('share', 'archive'\)/);
    expect(migration).toMatch(/export_audits_member_read/);
    expect(migration).toMatch(/export_audits_member_insert/);
    expect(migration).toMatch(/user_id = auth\.uid\(\)/);
    expect(migration).toMatch(/references auth\.users\(id\) on delete set null/);
  });

  it("answers preflight, refuses non-POST, and demands the member's own session", async () => {
    const preflight = await handleHostedExportRequest(
      new Request("https://x.example/api/export", { method: "OPTIONS" }),
      {} as NodeJS.ProcessEnv
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const get = await handleHostedExportRequest(new Request("https://x.example/api/export"), {} as NodeJS.ProcessEnv);
    expect(get.status).toBe(405);

    const anonymous = await handleHostedExportRequest(
      new Request("https://x.example/api/export", { method: "POST" }),
      {} as NodeJS.ProcessEnv
    );
    expect(anonymous.status).toBe(401);

    const connector = await handleHostedExportRequest(exportRequest({ relationshipId: "rel-1" }, "dmsum_abc"), {} as NodeJS.ProcessEnv);
    expect(connector.status).toBe(400);
    await expect(connector.json()).resolves.toMatchObject({ error: expect.stringContaining("connector token") });
  });

  it("zips a share bundle under the member's RLS and writes the audit row", async () => {
    const client = stubExportClient({ relationship, pages: pageRows });
    const response = await handleHostedExportRequest(exportRequest({ relationshipId: "rel-1" }), {} as NodeJS.ProcessEnv, client);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/memsum-dave-lisa-share-\d{4}-\d{2}-\d{2}\.zip/);
    expect(response.headers.get("access-control-expose-headers")).toContain("content-disposition");

    const unzipped = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(unzipped).sort()).toEqual(["index.md", "log.md", "wiki/index.md"]);
    expect(strFromU8(unzipped["index.md"])).toContain('okf_version: "0.1"');

    expect(client.audits).toEqual([
      {
        table: "export_audits",
        payload: { relationship_id: "rel-1", user_id: "user-1", profile: "share", page_count: 1 }
      }
    ]);
  });

  it("includes the ledger in archive bundles and 404s inaccessible sums", async () => {
    const client = stubExportClient({
      relationship,
      pages: pageRows,
      interactions: [
        {
          id: "abc",
          raw_text: "+sum hello",
          agent: "Dave-OpenAI",
          created_at: "2026-07-08T00:00:00Z",
          participants: { display_name: "Dave" }
        }
      ]
    });
    const response = await handleHostedExportRequest(
      exportRequest({ relationshipId: "rel-1", profile: "archive" }),
      {} as NodeJS.ProcessEnv,
      client
    );
    const unzipped = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(unzipped)).toContain("interactions/abc.md");

    const denied = await handleHostedExportRequest(
      exportRequest({ relationshipId: "rel-2" }),
      {} as NodeJS.ProcessEnv,
      stubExportClient({ relationship: null })
    );
    expect(denied.status).toBe(404);
  });
});

describe("Mem·Sum public tool catalog", () => {
  it("lists every kernel tool exactly once with its safety labels", async () => {
    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "tools", "page.tsx"), "utf8");

    expect(hostedToolNames).toHaveLength(13);
    for (const name of hostedToolNames) {
      const occurrences = page.match(new RegExp(`tool: "${name}"`, "g")) ?? [];
      expect(occurrences, `catalog entry for ${name}`).toHaveLength(1);
    }

    // The three tools annotated openWorldHint (they can queue SMS) are the
    // only ones allowed to wear the text chip.
    expect(page.match(/sms: true/g) ?? []).toHaveLength(3);
    for (const name of ["commit_interaction", "commit_update_batch", "create_reminder"]) {
      expect(page).toMatch(new RegExp(`tool: "${name}"[\\s\\S]{0,400}sms: true`));
    }

    expect(page).toMatch(/Read-only/);
    expect(page).toMatch(/Writes to the sum/);
    expect(page).toMatch(/May send a text/);
    expect(page).toMatch(/isolation is enforced by the database/);
  });

  it("keeps the public pricing page telling the database's truth about limits", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708150000_pilot_limits.sql"),
      "utf8"
    );
    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "pricing", "page.tsx"), "utf8");

    function limit(key: string): number {
      const match = migration.match(new RegExp(`'${key}', (\\d+)`));
      expect(match, `pilot_limits key ${key}`).not.toBeNull();
      return Number(match![1]);
    }

    expect(page).toContain(`${limit("sumsCreatedPerAccount")} sums created per account`);
    expect(page).toContain(`${limit("updatesPerSumPerDay")} updates`);
    expect(page).toContain(`${limit("interactionsPerSumPerDay")} messages`);
    expect(page).toContain(`${limit("remindersPerSumPerDay")} reminders`);
    expect(page).toContain(`${limit("pagesPerSum")} pages per sum`);
    expect(page).toContain(`${Math.round(limit("pageContentMaxBytes") / 1024)} KB per page`);
    expect(page).toContain(`2–${DEFAULT_PARTICIPANT_CAP} people`);
    expect(page).toMatch(/Free while Mem·Sum is in beta/);
  });

  it("keeps a setup guide for every supported client on the connect page", async () => {
    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "connect", "page.tsx"), "utf8");
    for (const client of ["Claude", "ChatGPT", "Claude Code", "Cursor", "Perplexity", "Any other MCP client"]) {
      expect(page, `guide for ${client}`).toContain(`<h2 className="font-semibold">${client}</h2>`);
    }
    expect(page).toContain("claude mcp add --transport http memsum");
    expect(page).toContain("sum.memsum.ai/mcp");
    expect(page).toMatch(/Authorization: Bearer/);
    expect(page).toMatch(/read-only/);
  });

  it("gives sign-in its recovery paths: password reset, magic link, and confirmation return", async () => {
    const login = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "login", "page.tsx"), "utf8");
    expect(login).toContain('href="/reset"');
    expect(login).toContain("signInWithOtp");
    // Invite-only survives the magic link: it never creates an account.
    expect(login).toContain("shouldCreateUser: false");

    const reset = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "reset", "page.tsx"), "utf8");
    expect(reset).toContain("resetPasswordForEmail");
    expect(reset).toContain("updateUser");
    expect(reset).toContain("window.location.origin}/reset");
    // A mailer rate limit is not an enumeration signal; the page must say it
    // plainly instead of pretending the email went out (found live 2026-07-08).
    expect(reset).toContain("briefly rate-limited");
    expect(reset).toMatch(/resetError\.status === 429/);

    const claim = await fs.readFile(
      path.join(process.cwd(), "dashboard", "app", "invite", "[token]", "claim.tsx"),
      "utf8"
    );
    expect(claim).toContain("emailRedirectTo: window.location.href");
    expect(claim).toContain("confirm your email");
  });
});

describe("Mem·Sum operator admin", () => {
  it("shows the operator metadata and aggregates behind an operators-table guard", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708170000_admin_overview.sql"),
      "utf8"
    );
    expect(migration).toMatch(/create table if not exists public\.operators/);
    expect(migration).toMatch(/'642b5352-1203-444d-9b03-5323eecfecc9'/);
    expect(migration).toMatch(/function public\.require_operator\(\)/);
    expect(migration).toMatch(/'DM Sum operator access required'/);
    expect(migration).toMatch(/function public\.admin_overview\(\)/);
    expect(migration).toMatch(/perform public\.require_operator\(\)/);
    // The standing commitment: operator content access writes an audit row
    // that the sum's own members can read.
    expect(migration).toMatch(/create table if not exists public\.operator_content_audits/);
    expect(migration).toMatch(/operator_content_audits_member_read/);
  });

  it("is content-blind by construction: the admin surface references no content column or table", async () => {
    // Scan every migration that defines or redefines admin_overview, so a
    // future redefinition cannot quietly start reading content.
    const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
    const adminMigrations: string[] = [];
    for (const file of await fs.readdir(migrationsDir)) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      if (sql.includes("admin_overview")) adminMigrations.push(sql);
    }
    expect(adminMigrations.length).toBeGreaterThanOrEqual(2);
    for (const migration of adminMigrations) {
      expect(migration).not.toMatch(/\b(raw_text|display_text|notification_text|quoted_text|value_normalized)\b/);
      expect(migration).not.toMatch(/\b(wiki_pages|page_revisions)\b/);
      expect(migration).not.toMatch(/\bpublic\.preferences\b/);
    }

    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "admin", "page.tsx"), "utf8");
    expect(page).toContain('rpc("admin_overview")');
    expect(page).toContain("This page is for the operator");
    expect(page).toContain("cannot read sum content, by construction");
  });

  it("states the operator-access and no-tracker commitments on the privacy page", async () => {
    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "privacy", "page.tsx"), "utf8");
    expect(page).toMatch(/cannot read sum content/);
    expect(page).toMatch(/If we ever look, you see that\s+we looked/);
    expect(page).toMatch(/no end-to-end\s+encryption, deliberately/);
    expect(page).toMatch(/no analytics scripts/);
    expect(page).toMatch(/aggregate count/);
    // The processor list is a trust commitment: every service that handles
    // member data is named. Resend joined 2026-07-08 (auth email delivery);
    // ImprovMX joined 2026-07-13 (hello@ reply forwarding).
    for (const processor of ["Supabase", "Vercel", "Twilio", "Resend", "ImprovMX"]) {
      expect(page).toContain(processor);
    }
  });
});

describe("Mem·Sum beta waitlist and site shell", () => {
  it("takes waitlist signups through one anon-callable, non-enumerating, capped function", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708180000_waitlist.sql"),
      "utf8"
    );
    expect(migration).toMatch(/create table if not exists public\.waitlist/);
    expect(migration).toMatch(/alter table public\.waitlist enable row level security/);
    expect(migration).toContain("revoke all on table public.waitlist from public, anon, authenticated;");
    // Server-side validation, silent dedupe (the same answer for new and
    // known addresses, so anonymous callers cannot probe the list), and a
    // hard cap so an unauthenticated form cannot balloon the table.
    expect(migration).toContain("[^@[:space:]]+@[^@[:space:]]+");
    expect(migration).toContain("on conflict (email) do nothing");
    expect(migration).toContain(">= 10000");
    expect(migration).toContain("jsonb_build_object('ok', true)");
    expect(migration).toContain("grant execute on function public.join_waitlist(text) to anon;");
  });

  it("offers the waitlist from the splash page and stores only what it says", async () => {
    const home = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "page.tsx"), "utf8");
    expect(home).toContain("<WaitlistForm />");
    expect(home).toMatch(/Leave your email and we&apos;ll send one as the beta widens/);
    expect(home).toMatch(/That address and the\s+date you joined are all we keep/);

    const form = await fs.readFile(
      path.join(process.cwd(), "dashboard", "components", "waitlist-form.tsx"),
      "utf8"
    );
    expect(form).toContain('rpc("join_waitlist"');
    expect(form).toContain('type="email"');
    expect(form).toContain("You&apos;re on the list");

    const privacy = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "privacy", "page.tsx"), "utf8");
    expect(privacy).toMatch(/join the beta\s+waitlist/);
    expect(privacy).toMatch(/only to send you an\s+invite/);
    // The export promise stays current: self-serve from the sum's page, not
    // fulfilled by hand as it was earlier in the beta.
    expect(privacy).toMatch(/Exports\s+are self-serve/);
    expect(privacy).not.toMatch(/fulfilled by hand/);
  });

  it("keeps every page in the shared shell with header and footer", async () => {
    const layout = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "layout.tsx"), "utf8");
    expect(layout).toContain("<SiteHeader />");
    expect(layout).toContain("<SiteFooter />");

    const header = await fs.readFile(
      path.join(process.cwd(), "dashboard", "components", "site-header.tsx"),
      "utf8"
    );
    for (const href of ['href="/"', 'href="/tools"', 'href="/pricing"', 'href="/connect"', 'href="/login"', 'href="/sums"']) {
      expect(header).toContain(href);
    }
    // The header persists across client-side navigations, so it must track
    // session changes live, not just at mount (stranger-test find #7).
    expect(header).toContain("onAuthStateChange");

    const footer = await fs.readFile(
      path.join(process.cwd(), "dashboard", "components", "site-footer.tsx"),
      "utf8"
    );
    for (const href of ['href="/tools"', 'href="/pricing"', 'href="/open"', 'href="/connect"', 'href="/account"', 'href="/terms"', 'href="/privacy"']) {
      expect(footer).toContain(href);
    }
  });

  it("turns a waitlist row into a beta invite only for the operator, via the kernel", async () => {
    function stubOverrides(options?: { operator?: boolean; invite?: Array<{ status: number; body?: unknown }> }) {
      const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
      let inviteIndex = 0;
      const inviteResponses = options?.invite ?? [{ status: 200, body: {} }];
      const operatorClient = {
        rpc: async (name: string) => {
          expect(name).toBe("require_operator");
          return options?.operator === false
            ? { error: { message: "DM Sum operator access required" } }
            : { error: null };
        }
      };
      const fetchFn = (async (input: any, init?: any) => {
        const url = String(input);
        requests.push({
          url,
          headers: { ...((init?.headers as Record<string, string>) ?? {}) },
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null
        });
        if (url.includes("/auth/v1/invite")) {
          const spec = inviteResponses[Math.min(inviteIndex, inviteResponses.length - 1)];
          inviteIndex += 1;
          return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const invites = () => requests.filter((entry) => entry.url.includes("/auth/v1/invite"));
      const stamps = () => requests.filter((entry) => entry.url.includes("/rest/v1/waitlist"));
      return { requests, invites, stamps, overrides: { operatorClient, fetchFn } };
    }
    const post = (body: unknown, token = "session-jwt") =>
      new Request("https://kernel.test/api/admin/invite", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    // Method, auth, and credential-kind refusals.
    expect((await handleHostedAdminInviteRequest(new Request("https://kernel.test/api/admin/invite", { method: "OPTIONS" }), {}, stubOverrides().overrides)).status).toBe(204);
    expect((await handleHostedAdminInviteRequest(new Request("https://kernel.test/api/admin/invite"), {}, stubOverrides().overrides)).status).toBe(405);
    expect((await handleHostedAdminInviteRequest(new Request("https://kernel.test/api/admin/invite", { method: "POST" }), {}, stubOverrides().overrides)).status).toBe(401);
    const connector = await handleHostedAdminInviteRequest(post({ email: "a@b.co" }, "memsum_abc123"), {}, stubOverrides().overrides);
    expect(connector.status).toBe(400);
    expect((await connector.json()).error).toMatch(/not a connector token/);

    const junk = await handleHostedAdminInviteRequest(post({ email: "not-an-email" }), {}, stubOverrides().overrides);
    expect(junk.status).toBe(400);
    expect((await junk.json()).error).toMatch(/does not look like an email address/);

    // The operators-table gate refuses everyone else before any email is sent.
    const outsider = stubOverrides({ operator: false });
    const refused = await handleHostedAdminInviteRequest(post({ email: "a@b.co" }), {}, outsider.overrides);
    expect(refused.status).toBe(403);
    expect(outsider.invites()).toHaveLength(0);

    // Happy path: normalized email, welcome redirect, waitlist stamped.
    const happy = stubOverrides();
    const ok = await handleHostedAdminInviteRequest(post({ email: "  New.Tester@Example.COM " }), {}, happy.overrides);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, email: "new.tester@example.com", alreadyRegistered: false });
    expect(happy.invites()).toHaveLength(1);
    expect(happy.invites()[0].url).toContain(
      `redirect_to=${encodeURIComponent("https://memsum.ai/welcome")}`
    );
    expect(happy.invites()[0].body).toEqual({ email: "new.tester@example.com" });
    expect(happy.stamps()).toHaveLength(1);
    expect(happy.stamps()[0].url).toContain("waitlist?email=eq.new.tester%40example.com");
    expect(inviteRedirectTarget({ MEMSUM_DASHBOARD_ORIGIN: "https://memsum.ai/" } as NodeJS.ProcessEnv)).toBe("https://memsum.ai/welcome");

    // sb_secret_ keys are not JWTs; when GoTrue refuses the Bearer form, the
    // invite retries once with apikey-only (the failure seen live 2026-07-08).
    const fallback = stubOverrides({
      invite: [{ status: 401, body: { msg: "This endpoint requires a valid Bearer token" } }, { status: 200, body: {} }]
    });
    const retried = await handleHostedAdminInviteRequest(post({ email: "a@b.co" }), {}, fallback.overrides);
    expect(retried.status).toBe(200);
    expect(fallback.invites()).toHaveLength(2);
    expect(fallback.invites()[0].headers.authorization).toMatch(/^Bearer /);
    expect(fallback.invites()[1].headers.authorization).toBeUndefined();

    // Someone already in: same 200, flagged, still stamped so the queue clears.
    const known = stubOverrides({
      invite: [{ status: 422, body: { msg: "A user with this email address has already been registered" } }]
    });
    const already = await handleHostedAdminInviteRequest(post({ email: "a@b.co" }), {}, known.overrides);
    expect(already.status).toBe(200);
    expect(await already.json()).toMatchObject({ ok: true, alreadyRegistered: true });
    expect(known.stamps()).toHaveLength(1);

    // A real mailer failure is a 502, no header-strategy retry, and the row
    // stays uninvited.
    const down = stubOverrides({ invite: [{ status: 500, body: { msg: "smtp down" } }] });
    const failed = await handleHostedAdminInviteRequest(post({ email: "a@b.co" }), {}, down.overrides);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toMatch(/smtp down/);
    expect(down.invites()).toHaveLength(1);
    expect(down.stamps()).toHaveLength(0);

    // The rule that keeps a runaway script from draining the auth mailer.
    expect(hostedRateLimitRules().adminInvitePerOperator).toMatchObject({ name: "admin-invite", windowSeconds: 3600 });
  });

  it("mints a hand-deliverable invite link when delivery is 'link' — no email sent", async () => {
    function stubLinkOverrides(response: { status: number; body?: unknown }) {
      const requests: Array<{ url: string; body: unknown }> = [];
      const operatorClient = { rpc: async () => ({ error: null }) };
      const fetchFn = (async (input: any, init?: any) => {
        const url = String(input);
        requests.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
        if (url.includes("/auth/v1/admin/generate_link")) {
          return new Response(JSON.stringify(response.body ?? {}), { status: response.status });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      return { requests, overrides: { operatorClient, fetchFn } };
    }
    const post = (body: unknown) =>
      new Request("https://kernel.test/api/admin/invite", {
        method: "POST",
        headers: { authorization: "Bearer session-jwt", "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    // Happy path: generate_link is called (never /invite), and the returned
    // link points at OUR /welcome page with the token hash inert in the
    // query — raw GoTrue verify URLs get eaten by omnibox prefetchers and
    // link scanners before a human clicks (observed live 2026-07-11). The
    // waitlist row still gets stamped.
    const happy = stubLinkOverrides({
      status: 200,
      body: {
        hashed_token: "hashtok123",
        action_link: "https://qaylgtityokhmlwzisml.supabase.co/auth/v1/verify?token=pkce_abc&type=invite&redirect_to=x"
      }
    });
    const ok = await handleHostedAdminInviteRequest(post({ email: "new@example.com", delivery: "link" }), {}, happy.overrides);
    expect(ok.status).toBe(200);
    const payload = await ok.json();
    expect(payload.actionLink).toBe("https://memsum.ai/welcome?invite=hashtok123");
    expect(happy.requests.some((r) => r.url.includes("/auth/v1/admin/generate_link"))).toBe(true);
    expect(happy.requests.some((r) => r.url.includes("/auth/v1/invite?"))).toBe(false);
    expect(happy.requests.some((r) => r.url.includes("/rest/v1/waitlist"))).toBe(true);
    expect(happy.requests.find((r) => r.url.includes("generate_link"))?.body).toMatchObject({
      type: "invite",
      email: "new@example.com"
    });

    // Without a hashed token (older GoTrue shapes), fall back to the raw
    // link, nested or flat.
    const nested = stubLinkOverrides({ status: 200, body: { properties: { action_link: "https://x/verify?type=invite" } } });
    const nestedOk = await handleHostedAdminInviteRequest(post({ email: "new@example.com", delivery: "link" }), {}, nested.overrides);
    expect((await nestedOk.json()).actionLink).toContain("type=invite");

    // Failure is honest and the row stays uninvited.
    const down = stubLinkOverrides({ status: 500, body: { msg: "boom" } });
    const failed = await handleHostedAdminInviteRequest(post({ email: "new@example.com", delivery: "link" }), {}, down.overrides);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toMatch(/invite link could not be created/);
    expect(down.requests.some((r) => r.url.includes("/rest/v1/waitlist"))).toBe(false);

    // The admin page offers both deliveries and shows the link once.
    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "admin", "page.tsx"), "utf8");
    expect(page).toContain('invite(entry.email, "link")');
    expect(page).toMatch(/shown once, deliver it yourself/);
    expect(page).toContain("{inviteLink}");
  });

  it("wires the invite button on the admin page and lands invitees on /welcome", async () => {
    const wrapper = await fs.readFile(path.join(process.cwd(), "api", "admin", "invite.js"), "utf8");
    expect(wrapper).toContain("dist/hosted/admin.js");

    const admin = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "admin", "page.tsx"), "utf8");
    expect(admin).toContain("/api/admin/invite");
    expect(admin).toContain('invite(entry.email)');
    expect(admin).toMatch(/already has an account — marked as invited/);

    const welcome = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "welcome", "page.tsx"), "utf8");
    expect(welcome).toContain("Welcome to the beta");
    expect(welcome).toContain("updateUser({ password })");
    // Hand-delivered links land inert and verify only on the Accept click —
    // prefetch-proof — and a consumed link is reported honestly.
    expect(welcome).toContain('params.get("invite")');
    expect(welcome).toContain("Accept invite");
    expect(welcome).toMatch(/verifyOtp\(\{\s*type: "invite"/);
    expect(welcome).toContain("otp_expired");
    expect(welcome).toMatch(/already used or has expired/);
    // The no-session state points at sign-in and reset, never at signup —
    // account creation stays operator- and invitation-gated.
    expect(welcome).toContain('href="/login"');
    expect(welcome).toContain('href="/reset"');
    expect(welcome).not.toMatch(/signUp/);
  });

  it("shows the operator the waitlist, metadata-only", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260708180000_waitlist.sql"),
      "utf8"
    );
    expect(migration).toContain("'waitlist', (select count(*) from public.waitlist)");
    expect(migration).toContain("'waitlist', v_waitlist");

    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "admin", "page.tsx"), "utf8");
    expect(page).toContain('["Waitlist", totals.waitlist]');
    expect(page).toContain("Nobody waiting yet.");
  });
});

describe("Mem·Sum private sums (Phase 3: just you)", () => {
  it("makes private sums first-class in the operating contract", () => {
    // A sum of one is the unit of privacy; social machinery goes quiet there.
    expect(hostedMcpInstructions).toMatch(/Private sums:/);
    expect(hostedMcpInstructions).toMatch(/personal memory workspace, first-class/);
    expect(hostedMcpInstructions).toMatch(/never ask about addressedParticipants, attention, or notificationText/);
    expect(hostedMcpInstructions).toMatch(/write freely/);
    expect(hostedMcpInstructions).toMatch(/gently say there is nobody else here/);
    // Weaving is continuous — the no-roll doctrine, pinned.
    expect(hostedMcpInstructions).toMatch(/Weaving is continuous/);
    expect(hostedMcpInstructions).toMatch(/no batch step, no separate roll/);
    // Transcribe-through provenance: text travels, files do not, honesty always.
    expect(hostedMcpInstructions).toMatch(/Files never travel through this connector; text does/);
    expect(hostedMcpInstructions).toMatch(/as read by your agent, not the original file/);
    expect(hostedMcpInstructions).toMatch(/Never present a transcription as the original/);
    expect(hostedMcpInstructions).toMatch(/save its link as a url resource/);
    // The empty state offers the private sum as a first option.
    expect(hostedEmptyStateGuidance).toMatch(/private sum — just the participant — is first-class/);
    expect(hostedEmptyStateGuidance).toMatch(/only relationshipDisplayName and selfDisplayName/);
  });

  it("tells the single-user story on the site: start alone, no app, no second subscription", async () => {
    const home = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "page.tsx"), "utf8");
    // The hero and first card go 1..N without surrendering the shared story.
    expect(home).toMatch(/private to just you, or shared by up to five people/);
    expect(home).toMatch(/the first one can be just you/);
    // The tagline's echo carries the private-sum pitch.
    expect(home).toMatch(/The first person who matters is you/);
    expect(home).toMatch(/exportable as plain markdown any time/);
    expect(home).toMatch(/privacy here is just arithmetic: a sum of one/);
    // The category differentiator: no app, no second AI subscription,
    // many assistants against one memory.
    expect(home).toMatch(/There is no Mem·Sum app/);
    expect(home).toMatch(/Your AI is the app/);
    expect(home).toMatch(/no second\s+subscription so a notes app can think/);
    expect(home).toMatch(/as many assistants as you like/);

    const pricing = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "pricing", "page.tsx"), "utf8");
    expect(pricing).toMatch(/sums for just you or for up to five people/);

    const layout = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "layout.tsx"), "utf8");
    expect(layout).toMatch(/private to just you, or shared by up to five people/);
  });

  it("frames private sums on the dashboard: grouping, starter card, 1..N create form", async () => {
    const sums = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "sums", "page.tsx"), "utf8");
    expect(sums).toMatch(/Private — just you/);
    expect(sums).toMatch(/"Just you"/);
    expect(sums).toMatch(/Start your private sum/);
    expect(sums).toMatch(/Start my private sum/);
    expect(sums).toMatch(/Their name \(optional\)/);
    expect(sums).toMatch(/Contact handle \(optional\)/);
    expect(sums).toMatch(/Leave both blank to make this sum private/);
    // The one invalid shape: a peer name without a handle or vice versa.
    expect(sums).toMatch(/or leave both blank for a private sum/);

    const detail = await fs.readFile(
      path.join(process.cwd(), "dashboard", "app", "sums", "[id]", "detail.tsx"),
      "utf8"
    );
    // The consent sentence at the moment of truth, plus the copy-out steer.
    expect(detail).toMatch(/Inviting someone shows them everything\s+already in this sum/);
    expect(detail).toMatch(/copy pages into a shared one/);
  });
});

describe("Mem·Sum concurrent-edit safety", () => {
  it("locks before it checks: the batch core takes row and advisory locks ahead of version checks", async () => {
    const migration = await fs.readFile(
      path.join(process.cwd(), "supabase", "migrations", "20260711230000_batch_lock_before_check.sql"),
      "utf8"
    );
    // One shared core, locked union of readSet and write targets, sorted to
    // prevent deadlocks; advisory locks serialize would-be creators.
    expect(migration).toMatch(/function public\.commit_update_batch_impl/);
    expect(migration).toMatch(/order by kind, key/);
    expect(migration).toMatch(/for update;/);
    expect(migration).toMatch(/pg_advisory_xact_lock\(hashtextextended/);
    // The lock phase precedes the first version check.
    expect(migration.indexOf("pg_advisory_xact_lock")).toBeLessThan(migration.indexOf("'stale'"));
    // The impl is reachable only through the two authenticated wrappers.
    expect(migration).toMatch(/revoke all on function public\.commit_update_batch_impl/);
    expect(migration).toMatch(/return public\.commit_update_batch_impl\(payload, auth\.uid\(\)\)/);
    expect(migration).toMatch(/return public\.commit_update_batch_impl\(payload, v_actor_user_id\)/);
  });
});

describe("Mem·Sum open kernel pre-flight", () => {
  it("carries the Apache-2.0 license, trademark notice, and security policy", async () => {
    const license = await fs.readFile(path.join(process.cwd(), "LICENSE"), "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");

    const notice = await fs.readFile(path.join(process.cwd(), "NOTICE"), "utf8");
    expect(notice).toContain("Copyright 2026 Dave Gilbert");
    expect(notice).toMatch(/trademarks/);
    expect(notice).toMatch(/the name is not|not present your service as Mem·Sum/);

    const security = await fs.readFile(path.join(process.cwd(), "SECURITY.md"), "utf8");
    expect(security).toContain("docgotham@gmail.com");
    expect(security).toMatch(/sums you are not a\s+member of/);
  });

  it("makes the trust claims in the README match properties the suite enforces", async () => {
    const readme = await fs.readFile(path.join(process.cwd(), "README.md"), "utf8");
    expect(readme).toMatch(/encouraged to run it yourself/);
    expect(readme).toMatch(/The software is free \(Apache-2\.0\)/);
    expect(readme).toMatch(/no model call/);
    expect(readme).toMatch(/row-level security/);
    expect(readme).toMatch(/cannot read sum content/);
    expect(readme).toMatch(/`\/version`/);
    expect(readme).toMatch(/the code is yours, the name\s+is not/);
  });

  it("reports the running commit at /version", async () => {
    const response = handleHostedVersionRequest({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_GIT_COMMIT_REF: "main",
      MEMSUM_SOURCE_URL: "https://github.com/example/memsum"
    } as NodeJS.ProcessEnv);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      name: "memsum-kernel",
      commit: "abc123",
      ref: "main",
      source: "https://github.com/example/memsum",
      license: "Apache-2.0"
    });

    const bare = await handleHostedVersionRequest({} as NodeJS.ProcessEnv).json();
    expect(bare).toMatchObject({ ok: true, commit: null, source: null });
  });

  it("states the run-it-yourself philosophy on the pricing page", async () => {
    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "pricing", "page.tsx"), "utf8");
    expect(page).toMatch(/Run it yourself/);
    expect(page).toMatch(/is open source under Apache-2\.0/);
    expect(page).toMatch(/genuinely encourage you to run your own/);
    expect(page).toMatch(/SMS\s+compliance/);
    expect(page).toContain('href="/open"');
  });

  it("explains the license, the approach, and build-your-own on the /open page", async () => {
    const page = await fs.readFile(path.join(process.cwd(), "dashboard", "app", "open", "page.tsx"), "utf8");
    // Same pinned phrase as the pricing page, so the cutover copy flip
    // ("goes" -> "is") sweeps both pages together.
    expect(page).toMatch(/is open source under Apache-2\.0/);
    expect(page).toMatch(/Apache-2\.0: use it, change it, self-host it/);
    expect(page).toMatch(/patent grant/);
    expect(page).toMatch(/not Mem·Sum/);
    // The approach: checkable trust, thin kernel, no server inference.
    expect(page).toMatch(/trust should be checkable/);
    expect(page).toMatch(/no\s+model calls/);
    expect(page).toMatch(/\/version/);
    // Dave's ask: encourage people to build their own wiki graphs on sums.
    expect(page).toMatch(/Build your own wiki graphs/);
    expect(page).toMatch(/shared wiki graph/);
    // Honest pre-flip repository state: env-driven link, no hardcoded URL.
    expect(page).toContain("NEXT_PUBLIC_SOURCE_URL");
    expect(page).toMatch(/opens with the launch/);
    expect(page).not.toMatch(/github\.com/);
  });
});
