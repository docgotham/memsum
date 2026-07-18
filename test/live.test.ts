import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

// Spec §16 live harness. Runs the hand-proven end-to-end probes — batch
// atomicity, stale rejection + retry, cross-account RLS isolation, the
// invitation lifecycle, leave/delete-account semantics, phone verification,
// activity windows, and rate limiting — against the real hosted graph.
//
// Safety model: every test runs inside a single BEGIN…ROLLBACK transaction on
// one connection, so nothing it seeds or mutates ever commits. Impersonation
// uses the same transaction-local pattern the kernel's PostgREST path
// produces: set_config('request.jwt.claims', …) plus SET LOCAL ROLE.
//
// Enable by setting DMSUM_TEST_DATABASE_URL (or putting it in the repo-root
// .env, which is gitignored) to the Supabase session-pooler URI from the
// dashboard's Connect panel. Without it the whole suite skips, so plain
// `npm test` stays green on machines and CI without database credentials.

function loadDatabaseUrl(): string | undefined {
  if (process.env.DMSUM_TEST_DATABASE_URL) return process.env.DMSUM_TEST_DATABASE_URL;
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return undefined;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^DMSUM_TEST_DATABASE_URL=(.*)$/);
    if (match) return match[1].trim().replace(/^"|"$/g, "");
  }
  return undefined;
}

const databaseUrl = loadDatabaseUrl();
const describeLive = databaseUrl ? describe : describe.skip;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// JSON payloads are embedded in SQL string literals; single quotes inside
// them (apostrophes in content, names) must be doubled.
function sqlJson(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "''");
}

const SERVICE_CLAIMS = `reset role; select set_config('request.jwt.claims', '{"role":"service_role"}', true);`;

function userClaims(userId: string): string {
  return `select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', true); set local role authenticated;`;
}

describeLive("Mem·Sum live graph (§16 harness)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl!) ? undefined : { rejectUnauthorized: false }
    });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function q(sql: string): Promise<pg.QueryResult> {
    return client.query(sql);
  }

  async function inRollback(fn: () => Promise<void>): Promise<void> {
    await q("begin");
    try {
      await fn();
    } finally {
      await q("rollback");
    }
  }

  // Seeds an auth user plus a relationship they own (self participant, owner
  // membership, optional peer placeholder + contact) through the same
  // service-role RPC the kernel uses.
  async function seedUserWithRelationship(input: {
    displayName: string;
    relationshipName: string;
    peerDisplayName?: string;
    contactHandle?: string;
  }): Promise<{ userId: string; relationshipId: string; selfParticipantId: string; peerParticipantId: string | null }> {
    const userId = randomUUID();
    await q(`insert into auth.users (id, email) values ('${userId}', 'live-test-${randomUUID()}@example.com');`);
    await q(SERVICE_CLAIMS);
    const payload = {
      relationshipDisplayName: input.relationshipName,
      selfDisplayName: input.displayName,
      ...(input.peerDisplayName ? { peerDisplayName: input.peerDisplayName } : {}),
      ...(input.contactHandle ? { contactHandle: input.contactHandle } : {})
    };
    const result = await q(
      `select public.create_relationship_context_for_user('${sqlJson(payload)}'::jsonb, '${userId}') as r;`
    );
    const r = result.rows[0].r;
    return {
      userId,
      relationshipId: r.relationshipId,
      selfParticipantId: r.selfParticipantId,
      peerParticipantId: r.peerParticipantId ?? null
    };
  }

  function batchPayload(
    relationshipId: string,
    participantId: string,
    wikiWrites: Array<{ path: string; title: string; content: string; expectedVersion: number }>
  ): string {
    return sqlJson({
      relationshipId,
      participantId,
      agent: "live-harness",
      displayText: "live harness batch",
      wikiWrites
    });
  }

  it("rejects a batch atomically when any write is stale, then accepts the reread retry", async () => {
    await inRollback(async () => {
      const dave = await seedUserWithRelationship({ displayName: "HarnessDave", relationshipName: "Harness Sum" });

      // Two writes, second stale: nothing may land.
      const mixed = await q(
        `select public.commit_update_batch_for_user('${batchPayload(dave.relationshipId, dave.selfParticipantId, [
          { path: "wiki/topics/alpha.md", title: "Alpha", content: "# Alpha", expectedVersion: 0 },
          { path: "wiki/topics/beta.md", title: "Beta", content: "# Beta", expectedVersion: 7 }
        ])}'::jsonb, '${dave.userId}') as r;`
      );
      expect(mixed.rows[0].r.ok).toBe(false);
      expect(mixed.rows[0].r.reason).toBe("stale");
      expect(mixed.rows[0].r.changedPaths).toContain("wiki/topics/beta.md");
      const afterMixed = await q(
        `select count(*)::int as pages from public.wiki_pages where relationship_id = '${dave.relationshipId}';`
      );
      expect(afterMixed.rows[0].pages).toBe(0);

      // Clean create, then a stale rewrite, then the correct retry.
      const first = await q(
        `select public.commit_update_batch_for_user('${batchPayload(dave.relationshipId, dave.selfParticipantId, [
          { path: "wiki/topics/alpha.md", title: "Alpha", content: "# Alpha v1", expectedVersion: 0 }
        ])}'::jsonb, '${dave.userId}') as r;`
      );
      expect(first.rows[0].r.ok).toBe(true);

      const stale = await q(
        `select public.commit_update_batch_for_user('${batchPayload(dave.relationshipId, dave.selfParticipantId, [
          { path: "wiki/topics/alpha.md", title: "Alpha", content: "# Alpha stale", expectedVersion: 0 }
        ])}'::jsonb, '${dave.userId}') as r;`
      );
      expect(stale.rows[0].r).toMatchObject({ ok: false, reason: "stale", changedPaths: ["wiki/topics/alpha.md"] });

      const retry = await q(
        `select public.commit_update_batch_for_user('${batchPayload(dave.relationshipId, dave.selfParticipantId, [
          { path: "wiki/topics/alpha.md", title: "Alpha", content: "# Alpha v2", expectedVersion: 1 }
        ])}'::jsonb, '${dave.userId}') as r;`
      );
      expect(retry.rows[0].r.ok).toBe(true);

      const state = await q(
        `select
           (select version from public.wiki_pages where relationship_id = '${dave.relationshipId}' and path = 'wiki/topics/alpha.md') as version,
           (select count(*)::int from public.page_revisions where relationship_id = '${dave.relationshipId}') as revisions,
           (select count(*)::int from public.updates where relationship_id = '${dave.relationshipId}') as updates;`
      );
      expect(state.rows[0]).toMatchObject({ version: 2, revisions: 2, updates: 2 });
    });
  }, 30000);

  it("deletes a page for real — stale-guarded, revisions cascaded, the act recorded as an update", async () => {
    await inRollback(async () => {
      const dave = await seedUserWithRelationship({ displayName: "HarnessDave", relationshipName: "Deletion Sum" });

      // Seed an index and a topic page in one batch.
      const seeded = await q(
        `select public.commit_update_batch_for_user('${batchPayload(dave.relationshipId, dave.selfParticipantId, [
          { path: "wiki/index.md", title: "Index", content: "# Index\n\n- [[Budapest]]", expectedVersion: 0 },
          { path: "wiki/topics/budapest.md", title: "Budapest", content: "# Budapest\n\nTrip planning.", expectedVersion: 0 }
        ])}'::jsonb, '${dave.userId}') as r;`
      );
      expect(seeded.rows[0].r.ok).toBe(true);

      // A stale delete (wrong version) is rejected and the page survives.
      const staleDelete = await q(
        `select public.commit_update_batch_for_user('${sqlJson({
          relationshipId: dave.relationshipId,
          participantId: dave.selfParticipantId,
          agent: "live-harness",
          displayText: "stale delete attempt",
          wikiDeletes: [{ path: "wiki/topics/budapest.md", expectedVersion: 7 }]
        })}'::jsonb, '${dave.userId}') as r;`
      );
      expect(staleDelete.rows[0].r).toMatchObject({ ok: false, reason: "stale", changedPaths: ["wiki/topics/budapest.md"] });

      // Deleting a page that does not exist is stale too — the world moved,
      // never silent success.
      const absentDelete = await q(
        `select public.commit_update_batch_for_user('${sqlJson({
          relationshipId: dave.relationshipId,
          participantId: dave.selfParticipantId,
          agent: "live-harness",
          displayText: "delete of a page that is not there",
          wikiDeletes: [{ path: "wiki/topics/never-existed.md", expectedVersion: 1 }]
        })}'::jsonb, '${dave.userId}') as r;`
      );
      expect(absentDelete.rows[0].r).toMatchObject({ ok: false, reason: "stale", changedPaths: ["wiki/topics/never-existed.md"] });

      // The real thing: delete the page and unlink the index in ONE batch.
      const deletion = await q(
        `select public.commit_update_batch_for_user('${sqlJson({
          relationshipId: dave.relationshipId,
          participantId: dave.selfParticipantId,
          agent: "live-harness",
          displayText: "Removed the Budapest page — trip cancelled.",
          wikiWrites: [{ path: "wiki/index.md", title: "Index", content: "# Index\n", expectedVersion: 1 }],
          wikiDeletes: [{ path: "wiki/topics/budapest.md", expectedVersion: 1 }]
        })}'::jsonb, '${dave.userId}') as r;`
      );
      expect(deletion.rows[0].r.ok).toBe(true);

      // Gone means gone: no page row, no revisions for it (cascade), while
      // the index kept its history and the deletion is a durable update.
      const state = await q(
        `select
           (select count(*)::int from public.wiki_pages where relationship_id = '${dave.relationshipId}' and path = 'wiki/topics/budapest.md') as page_rows,
           (select count(*)::int from public.page_revisions pr where pr.relationship_id = '${dave.relationshipId}' and pr.title = 'Budapest') as budapest_revisions,
           (select version from public.wiki_pages where relationship_id = '${dave.relationshipId}' and path = 'wiki/index.md') as index_version,
           (select count(*)::int from public.updates where relationship_id = '${dave.relationshipId}' and display_text = 'Removed the Budapest page — trip cancelled.') as deletion_updates;`
      );
      expect(state.rows[0]).toMatchObject({ page_rows: 0, budapest_revisions: 0, index_version: 2, deletion_updates: 1 });

      // Deleting it again is stale — honest, not idempotent.
      const repeat = await q(
        `select public.commit_update_batch_for_user('${sqlJson({
          relationshipId: dave.relationshipId,
          participantId: dave.selfParticipantId,
          agent: "live-harness",
          displayText: "delete it twice",
          wikiDeletes: [{ path: "wiki/topics/budapest.md", expectedVersion: 1 }]
        })}'::jsonb, '${dave.userId}') as r;`
      );
      expect(repeat.rows[0].r).toMatchObject({ ok: false, reason: "stale", changedPaths: ["wiki/topics/budapest.md"] });
    });
  }, 30000);

  it("isolates accounts under RLS: relationships, pages, and contacts are invisible across owners", async () => {
    await inRollback(async () => {
      const a = await seedUserWithRelationship({
        displayName: "HarnessA",
        relationshipName: "A Private Sum",
        peerDisplayName: "PeerOfA",
        contactHandle: "@peer-of-a"
      });
      const b = await seedUserWithRelationship({ displayName: "HarnessB", relationshipName: "B Private Sum" });
      await q(
        `select public.commit_update_batch_for_user('${batchPayload(a.relationshipId, a.selfParticipantId, [
          { path: "wiki/index.md", title: "Index", content: "# A's index", expectedVersion: 0 }
        ])}'::jsonb, '${a.userId}') as r;`
      );

      await q(userClaims(a.userId));
      const asA = await q(
        `select
           (select count(*)::int from public.relationships) as rels,
           (select count(*)::int from public.relationships where id = '${b.relationshipId}') as sees_b,
           (select count(*)::int from public.wiki_pages) as pages,
           (select count(*)::int from public.contacts where handle = '@peer-of-a') as own_contact;`
      );
      expect(asA.rows[0]).toMatchObject({ rels: 1, sees_b: 0, pages: 1, own_contact: 1 });

      await q(SERVICE_CLAIMS);
      await q(userClaims(b.userId));
      const asB = await q(
        `select
           (select count(*)::int from public.relationships where id = '${a.relationshipId}') as sees_a,
           (select count(*)::int from public.wiki_pages) as pages,
           (select count(*)::int from public.contacts) as contacts;`
      );
      expect(asB.rows[0]).toMatchObject({ sees_a: 0, pages: 0, contacts: 0 });
    });
  }, 30000);

  it("runs the invitation lifecycle: owner-only create, claim binds, re-claim is idempotent, revoke sticks, cap holds", async () => {
    await inRollback(async () => {
      const owner = await seedUserWithRelationship({
        displayName: "HarnessOwner",
        relationshipName: "Invite Sum",
        peerDisplayName: "Placeholder One"
      });
      const token = `memsum_invite_live_${randomUUID()}`;

      await q(userClaims(owner.userId));
      const created = await q(
        `select public.create_participant_invitation('${sqlJson({
          relationshipId: owner.relationshipId,
          participantId: owner.peerParticipantId,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        })}'::jsonb) as r;`
      );
      expect(created.rows[0].r.ok).toBe(true);

      // A fresh user claims it and gets bound to the placeholder.
      await q(SERVICE_CLAIMS);
      const claimerId = randomUUID();
      await q(`insert into auth.users (id, email) values ('${claimerId}', 'live-test-${randomUUID()}@example.com');`);
      await q(userClaims(claimerId));
      const claimed = await q(`select public.claim_invitation('${sha256Hex(token)}') as r;`);
      expect(claimed.rows[0].r.ok).toBe(true);
      const reclaimed = await q(`select public.claim_invitation('${sha256Hex(token)}') as r;`);
      expect(reclaimed.rows[0].r.ok).toBe(true);
      expect(reclaimed.rows[0].r.alreadyClaimed).toBe(true);

      await q(SERVICE_CLAIMS);
      const binding = await q(
        `select user_id from public.participants where id = '${owner.peerParticipantId}';`
      );
      expect(binding.rows[0].user_id).toBe(claimerId);

      // Revoked invitations cannot be claimed.
      const revokeToken = `memsum_invite_live_${randomUUID()}`;
      await q(userClaims(owner.userId));
      const second = await q(
        `select public.create_participant_invitation('${sqlJson({
          relationshipId: owner.relationshipId,
          newParticipantDisplayName: "Placeholder Two",
          tokenHash: sha256Hex(revokeToken),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        })}'::jsonb) as r;`
      );
      expect(second.rows[0].r.ok).toBe(true);
      await q(`select public.revoke_invitation('${second.rows[0].r.invitationId}') as r;`);
      await q(SERVICE_CLAIMS);
      const strangerId = randomUUID();
      await q(`insert into auth.users (id, email) values ('${strangerId}', 'live-test-${randomUUID()}@example.com');`);
      await q(userClaims(strangerId));
      const claimRevoked = await q(`select public.claim_invitation('${sha256Hex(revokeToken)}') as r;`);
      expect(claimRevoked.rows[0].r).toMatchObject({ ok: false, reason: "not_pending" });

      // Cap: fill to five participants, then a sixth is refused inside the txn.
      await q(SERVICE_CLAIMS);
      await q(
        `insert into public.participants (relationship_id, display_name)
         values ('${owner.relationshipId}', 'Filler Four'), ('${owner.relationshipId}', 'Filler Five');`
      );
      await q(userClaims(owner.userId));
      const overCap = await q(
        `select public.create_participant_invitation('${sqlJson({
          relationshipId: owner.relationshipId,
          newParticipantDisplayName: "One Too Many",
          tokenHash: sha256Hex(`memsum_invite_live_${randomUUID()}`),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        })}'::jsonb) as r;`
      );
      expect(overCap.rows[0].r).toMatchObject({ ok: false, reason: "participant_cap" });
    });
  }, 30000);

  it("keeps the shared record when a member leaves or deletes their account, and blocks owners with joined members", async () => {
    await inRollback(async () => {
      // T owns a solo sum; T is also a joined member of U's sum with an
      // authored interaction. Deleting T razes the solo sum, preserves U's
      // sum with T's interaction intact, and reverts T's seat to a
      // placeholder — the doctrine proven by hand on 2026-07-08.
      const u = await seedUserWithRelationship({
        displayName: "HarnessU",
        relationshipName: "U Shared",
        peerDisplayName: "T Seat"
      });
      const t = await seedUserWithRelationship({ displayName: "HarnessT", relationshipName: "T Solo" });
      await q(SERVICE_CLAIMS);
      await q(
        `update public.participants set user_id = '${t.userId}' where id = '${u.peerParticipantId}';
         insert into public.relationship_members (relationship_id, user_id, participant_id, role)
         values ('${u.relationshipId}', '${t.userId}', '${u.peerParticipantId}', 'member');`
      );
      const interactionId = randomUUID();
      await q(
        `insert into public.interactions (id, relationship_id, participant_id, actor_user_id, agent, raw_text)
         values ('${interactionId}', '${u.relationshipId}', '${u.peerParticipantId}', '${t.userId}', 'T-Agent', '+sum remember this');`
      );

      // U owns a sum T has joined, so U's deletion is blocked.
      await q(userClaims(u.userId));
      const blocked = await q(`select public.delete_account() as r;`);
      expect(blocked.rows[0].r).toMatchObject({ ok: false, reason: "owns_shared_sums" });
      expect(blocked.rows[0].r.sums).toContain("U Shared");

      // The owner cannot leave either.
      const ownerLeave = await q(`select public.leave_relationship('${u.relationshipId}') as r;`);
      expect(ownerLeave.rows[0].r).toMatchObject({ ok: false, reason: "owner_cannot_leave" });

      // T's own deletion goes through.
      await q(SERVICE_CLAIMS);
      await q(userClaims(t.userId));
      const deleted = await q(`select public.delete_account() as r;`);
      expect(deleted.rows[0].r).toMatchObject({ ok: true });

      await q(SERVICE_CLAIMS);
      const after = await q(
        `select
           (select count(*)::int from auth.users where id = '${t.userId}') as t_user,
           (select count(*)::int from public.relationships where id = '${t.relationshipId}') as t_solo,
           (select count(*)::int from public.relationships where id = '${u.relationshipId}') as u_shared,
           (select (user_id is null)::bool from public.participants where id = '${u.peerParticipantId}') as seat_reverted,
           (select (actor_user_id is null and raw_text = '+sum remember this')::bool from public.interactions where id = '${interactionId}') as interaction_kept,
           (select count(*)::int from public.relationship_members where user_id = '${t.userId}') as t_memberships;`
      );
      expect(after.rows[0]).toMatchObject({
        t_user: 0,
        t_solo: 0,
        u_shared: 1,
        seat_reverted: true,
        interaction_kept: true,
        t_memberships: 0
      });
    });
  }, 30000);

  it("verifies phones with hashed server-side codes and refuses other users' settings", async () => {
    await inRollback(async () => {
      const dave = await seedUserWithRelationship({ displayName: "HarnessDave", relationshipName: "Phone Sum" });

      await q(userClaims(dave.userId));
      const invalid = await q(`select public.start_phone_verification('${dave.selfParticipantId}', 'banana') as r;`);
      expect(invalid.rows[0].r).toMatchObject({ ok: false, reason: "invalid_phone" });

      const started = await q(`select public.start_phone_verification('${dave.selfParticipantId}', '+15005550006') as r;`);
      expect(started.rows[0].r.ok).toBe(true);

      const tooSoon = await q(`select public.start_phone_verification('${dave.selfParticipantId}', '+15005550006') as r;`);
      expect(tooSoon.rows[0].r).toMatchObject({ ok: false, reason: "too_soon" });

      // The code never leaves the database; plant a known hash to test confirm.
      await q(SERVICE_CLAIMS);
      const plumbing = await q(
        `select
           (select count(*)::int from public.phone_verification_codes c
              join public.notification_endpoints ne on ne.id = c.notification_endpoint_id
              where ne.participant_id = '${dave.selfParticipantId}') as code_rows,
           (select count(*)::int from public.notification_jobs
              where recipient_participant_id = '${dave.selfParticipantId}' and source_kind = 'verification') as jobs;`
      );
      expect(plumbing.rows[0]).toMatchObject({ code_rows: 1, jobs: 1 });
      await q(
        `update public.phone_verification_codes set code_hash = '${sha256Hex("123456")}'
         where notification_endpoint_id in (
           select id from public.notification_endpoints where participant_id = '${dave.selfParticipantId}' and kind = 'sms'
         );`
      );

      await q(userClaims(dave.userId));
      const wrong = await q(`select public.confirm_phone_verification('${dave.selfParticipantId}', '999999') as r;`);
      expect(wrong.rows[0].r).toMatchObject({ ok: false, reason: "invalid_code" });
      const confirmed = await q(`select public.confirm_phone_verification('${dave.selfParticipantId}', '123456') as r;`);
      expect(confirmed.rows[0].r.ok).toBe(true);
      const again = await q(`select public.confirm_phone_verification('${dave.selfParticipantId}', '123456') as r;`);
      expect(again.rows[0].r).toMatchObject({ ok: false, reason: "no_pending_code" });

      const settings = await q(`select public.get_notification_settings('${dave.selfParticipantId}') as r;`);
      expect(settings.rows[0].r.endpoint).toMatchObject({ phone: "+15005550006", verified: true, enabled: true });

      // Another authenticated user is refused.
      await q(SERVICE_CLAIMS);
      const other = await seedUserWithRelationship({ displayName: "HarnessOther", relationshipName: "Other Sum" });
      await q(userClaims(other.userId));
      await expect(q(`select public.get_notification_settings('${dave.selfParticipantId}');`)).rejects.toThrow(
        /not bound to the authenticated user/
      );
    });
  }, 30000);

  it("bounds activity queries to the requested window under the member's own role", async () => {
    await inRollback(async () => {
      const dave = await seedUserWithRelationship({ displayName: "HarnessDave", relationshipName: "Window Sum" });
      for (const [pagePath, day] of [
        ["wiki/topics/one.md", "2026-07-01"],
        ["wiki/topics/two.md", "2026-07-03"]
      ] as const) {
        const result = await q(
          `select public.commit_update_batch_for_user('${batchPayload(dave.relationshipId, dave.selfParticipantId, [
            { path: pagePath, title: pagePath, content: `# ${pagePath}`, expectedVersion: 0 }
          ])}'::jsonb, '${dave.userId}') as r;`
        );
        await q(
          `update public.updates set created_at = '${day}T12:00:00Z' where id = '${result.rows[0].r.updateId}';`
        );
      }

      await q(userClaims(dave.userId));
      const window = await q(
        `select count(*)::int as hits from public.updates
         where relationship_id = '${dave.relationshipId}'
           and created_at >= '2026-07-01T00:00:00Z' and created_at < '2026-07-02T00:00:00Z';`
      );
      expect(window.rows[0].hits).toBe(1);
      const all = await q(`select count(*)::int as hits from public.updates where relationship_id = '${dave.relationshipId}';`);
      expect(all.rows[0].hits).toBe(2);
    });
  }, 30000);

  it("holds the pilot limits: sum count, page size, daily update volume, message size", async () => {
    await inRollback(async () => {
      const dave = await seedUserWithRelationship({ displayName: "HarnessDave", relationshipName: "Limit Sum 1" });
      for (let i = 2; i <= 10; i += 1) {
        await q(
          `select public.create_relationship_context_for_user('${sqlJson({
            relationshipDisplayName: `Limit Sum ${i}`,
            selfDisplayName: "HarnessDave"
          })}'::jsonb, '${dave.userId}');`
        );
      }

      await q("savepoint probe");
      await expect(
        q(
          `select public.create_relationship_context_for_user('${sqlJson({
            relationshipDisplayName: "Limit Sum 11",
            selfDisplayName: "HarnessDave"
          })}'::jsonb, '${dave.userId}');`
        )
      ).rejects.toThrow(/pilot limit: the free beta allows 10 sums/);
      await q("rollback to savepoint probe");

      await q("savepoint probe");
      await expect(
        q(
          `select public.commit_update_batch_for_user('${batchPayload(dave.relationshipId, dave.selfParticipantId, [
            { path: "wiki/topics/big.md", title: "Big", content: "x".repeat(262145), expectedVersion: 0 }
          ])}'::jsonb, '${dave.userId}');`
        )
      ).rejects.toThrow(/pilot limit: a wiki page may hold up to 262144 bytes/);
      await q("rollback to savepoint probe");

      await q(
        `insert into public.updates (relationship_id, participant_id, actor_user_id, actor_kind, agent, display_text)
         select '${dave.relationshipId}', '${dave.selfParticipantId}', '${dave.userId}', 'participant_agent', 'harness', 'seed ' || g
         from generate_series(1, 200) g;`
      );
      await q("savepoint probe");
      await expect(
        q(
          `insert into public.updates (relationship_id, participant_id, actor_user_id, actor_kind, agent, display_text)
           values ('${dave.relationshipId}', '${dave.selfParticipantId}', '${dave.userId}', 'participant_agent', 'harness', 'one too many');`
        )
      ).rejects.toThrow(/pilot limit: the free beta allows 200 updates per sum per day/);
      await q("rollback to savepoint probe");

      await q("savepoint probe");
      await expect(
        q(
          `insert into public.interactions (relationship_id, participant_id, actor_user_id, agent, raw_text)
           values ('${dave.relationshipId}', '${dave.selfParticipantId}', '${dave.userId}', 'harness', '${"y".repeat(65537)}');`
        )
      ).rejects.toThrow(/pilot limit: an interaction may hold up to 65536 bytes/);
      await q("rollback to savepoint probe");
    });
  }, 60000);

  it("enforces rate-limit counters for the service role only", async () => {
    await inRollback(async () => {
      await q(SERVICE_CLAIMS);
      const key = `probe:harness-${randomUUID()}`;
      const decisions: Array<{ allowed: boolean; retryAfterSeconds: number }> = [];
      for (let i = 0; i < 4; i += 1) {
        const result = await q(`select public.check_rate_limit('${key}', 3, 60) as r;`);
        decisions.push(result.rows[0].r);
      }
      expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);
      expect(decisions[3].retryAfterSeconds).toBeGreaterThan(0);

      const dave = await seedUserWithRelationship({ displayName: "HarnessDave", relationshipName: "Limit Sum" });
      await q(userClaims(dave.userId));
      await expect(q(`select public.check_rate_limit('${key}', 3, 60);`)).rejects.toThrow(/permission denied/);
    });
  }, 30000);

  it("takes waitlist joins: normalizes, dedupes silently, refuses junk, and is anon-executable", async () => {
    await inRollback(async () => {
      await q(SERVICE_CLAIMS);
      const first = await q(`select public.join_waitlist('  Harness.Probe@Example.COM ') as r;`);
      expect(first.rows[0].r).toEqual({ ok: true });
      // The duplicate gets the same answer — callers cannot probe the list.
      const again = await q(`select public.join_waitlist('harness.probe@example.com') as r;`);
      expect(again.rows[0].r).toEqual({ ok: true });
      const count = await q(
        `select count(*)::int as n from public.waitlist where email = 'harness.probe@example.com';`
      );
      expect(count.rows[0].n).toBe(1);

      await q("savepoint probe");
      await expect(q(`select public.join_waitlist('not-an-email');`)).rejects.toThrow(
        /does not look like an email address/
      );
      await q("rollback to savepoint probe");

      const grants = await q(
        `select has_function_privilege('anon', 'public.join_waitlist(text)', 'execute') as fn,
                has_table_privilege('anon', 'public.waitlist', 'select') as tbl;`
      );
      expect(grants.rows[0].fn).toBe(true);
      expect(grants.rows[0].tbl).toBe(false);
    });
  }, 30000);

  it("serializes concurrent batches: one winner, one honest stale, never a silent overwrite", async () => {
    // Contention requires COMMITTED transactions racing on two real
    // connections, so this test cleans up with explicit deletes instead of
    // the usual rollback. Round 0 is the create-create race (advisory lock
    // path); later rounds race updates at the same expectedVersion.
    const second = new pg.Client({
      connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl!) ? undefined : { rejectUnauthorized: false }
    });
    await second.connect();
    const userId = randomUUID();
    let relationshipId: string | null = null;
    const scripted = async (conn: pg.Client, sql: string) => {
      const results = (await conn.query(sql)) as unknown as pg.QueryResult[] | pg.QueryResult;
      const list = Array.isArray(results) ? results : [results];
      return list.find((r) => r.rows?.[0]?.r !== undefined)?.rows[0].r;
    };
    try {
      await q(`insert into auth.users (id, email) values ('${userId}', 'live-race-${randomUUID()}@example.com');`);
      const seed = await scripted(
        client,
        `begin; ${SERVICE_CLAIMS} select public.create_relationship_context_for_user('${sqlJson({
          relationshipDisplayName: "Race Sum",
          selfDisplayName: "Racer"
        })}'::jsonb, '${userId}') as r; commit;`
      );
      relationshipId = seed.relationshipId;
      const participantId = seed.selfParticipantId;
      const path = "wiki/topics/contended.md";

      let expected = 0;
      let lastWinnerContent = "";
      const rounds = 10;
      for (let round = 0; round < rounds; round += 1) {
        const script = (who: string) => {
          const payload = sqlJson({
            relationshipId,
            participantId,
            agent: "race-harness",
            displayText: `round ${round} by ${who}`,
            wikiWrites: [
              {
                path,
                title: "Contended",
                content: `# Contended\n\nround ${round} written by ${who}`,
                expectedVersion: expected
              }
            ]
          });
          return `begin; ${SERVICE_CLAIMS} select public.commit_update_batch_for_user('${payload}'::jsonb, '${userId}') as r; commit;`;
        };
        const [a, b] = await Promise.all([scripted(client, script("A")), scripted(second, script("B"))]);
        const oks = [a, b].filter((r) => r?.ok === true);
        const losers = [a, b].filter((r) => r?.ok === false);
        // The invariant the migration exists for: never two winners from the
        // same expectedVersion, and the loser is told plainly why.
        expect(oks).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0].reason).toBe("stale");
        expect(losers[0].changedPaths).toContain(path);
        lastWinnerContent = a?.ok === true ? `round ${round} written by A` : `round ${round} written by B`;
        expected += 1;
      }

      const finalPage = await q(
        `select version, content, (select count(*)::int from public.page_revisions pr where pr.page_id = wp.id) as revisions
         from public.wiki_pages wp where relationship_id = '${relationshipId}' and path = '${path}';`
      );
      expect(finalPage.rows[0].version).toBe(rounds);
      expect(finalPage.rows[0].revisions).toBe(rounds);
      expect(finalPage.rows[0].content).toContain(lastWinnerContent);
    } finally {
      if (relationshipId) await q(`delete from public.relationships where id = '${relationshipId}';`);
      await q(`delete from auth.users where id = '${userId}';`);
      await second.end();
    }
  }, 90000);

  it("fans out attention notifications: one job per opted-in recipient, none for the unverified", async () => {
    await inRollback(async () => {
      const dave = await seedUserWithRelationship({
        displayName: "HarnessDave",
        relationshipName: "Fanout Sum",
        peerDisplayName: "HarnessLisa",
        contactHandle: "@harness-lisa"
      });
      // Third participant: an invite-style placeholder, so the sum has three
      // people and two possible attention targets.
      const third = await q(
        `insert into public.participants (relationship_id, display_name) values ('${dave.relationshipId}', 'HarnessMike') returning id;`
      );
      const mikeId = third.rows[0].id;

      // Lisa and Mike are opted in with verified endpoints; Dave (sender) has
      // none. A fourth condition hides inside Mike's row later: disable his
      // endpoint and the job must not queue.
      await q(
        `insert into public.notification_endpoints (relationship_id, participant_id, kind, provider, value_normalized, enabled, verified_at)
         values
           ('${dave.relationshipId}', '${dave.peerParticipantId}', 'sms', 'twilio', '+16155550101', true, now()),
           ('${dave.relationshipId}', '${mikeId}', 'sms', 'twilio', '+16155550102', true, now());`
      );

      const payload = sqlJson({
        relationshipId: dave.relationshipId,
        participantId: dave.selfParticipantId,
        agent: "live-harness",
        displayText: "fanout probe",
        wikiWrites: [
          { path: "wiki/topics/fanout.md", title: "Fanout", content: "# Fanout probe", expectedVersion: 0 }
        ],
        attentionParticipantIds: [dave.peerParticipantId, mikeId],
        notificationText: "Fanout probe: please look at the fanout page"
      });
      await q(`select public.commit_update_batch_for_user('${payload}'::jsonb, '${dave.userId}');`);

      const jobs = await q(
        `select recipient_participant_id, body from public.notification_jobs
         where relationship_id = '${dave.relationshipId}' order by recipient_participant_id;`
      );
      expect(jobs.rows).toHaveLength(2);
      const recipients = jobs.rows.map((row) => row.recipient_participant_id).sort();
      expect(recipients).toEqual([dave.peerParticipantId, mikeId].sort());
      for (const row of jobs.rows) expect(row.body).toMatch(/Fanout probe/);

      // Opt-out honored at queue time: with Mike's endpoint disabled, a second
      // update fans out to Lisa alone.
      await q(`update public.notification_endpoints set enabled = false where participant_id = '${mikeId}';`);
      const secondPayload = sqlJson({
        relationshipId: dave.relationshipId,
        participantId: dave.selfParticipantId,
        agent: "live-harness",
        displayText: "fanout probe two",
        wikiWrites: [
          { path: "wiki/topics/fanout.md", title: "Fanout", content: "# Fanout probe v2", expectedVersion: 1 }
        ],
        attentionParticipantIds: [dave.peerParticipantId, mikeId],
        notificationText: "Second fanout probe"
      });
      await q(`select public.commit_update_batch_for_user('${secondPayload}'::jsonb, '${dave.userId}');`);
      const secondJobs = await q(
        `select recipient_participant_id from public.notification_jobs
         where relationship_id = '${dave.relationshipId}' and body like 'Second fanout%';`
      );
      expect(secondJobs.rows).toHaveLength(1);
      expect(secondJobs.rows[0].recipient_participant_id).toBe(dave.peerParticipantId);
    });
  }, 30000);
});
