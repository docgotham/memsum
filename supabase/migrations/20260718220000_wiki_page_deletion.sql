-- Wiki page deletion as a batch effect.
--
-- Until now the graph could only grow: commit_update_batch upserted pages
-- and nothing could remove one, so "delete the Budapest page" ended as
-- prose-retirement — a stub page that still surfaced in list_files, the
-- Companion index, and the pilot page quota. This migration adds
-- wikiDeletes to the batch payload: [{path, expectedVersion}].
--
-- Semantics, decided 2026-07-18:
--   * Hard delete. The privacy story is arithmetic — when a participant says
--     delete, the content leaves the database. page_revisions go with the
--     page via the existing FK cascade. No tombstone: a row that lingers
--     with full content would quietly betray "it's gone".
--   * Deletion is a sourced update. The batch's update row (display_text
--     prose, update_sources provenance) is the durable memory of the act,
--     so agents can answer "what happened to that page?" instead of
--     gaslighting members about content that vanished.
--   * Same concurrency contract as writes. Delete targets join the lock
--     union (FOR UPDATE when present, advisory lock when absent so a
--     concurrent creator serializes), and the version check runs under the
--     lock. Deleting a page that moved — or is already gone — is an honest
--     {ok:false, reason:"stale"} the agent rereads and retries from.
--
-- Only commit_update_batch_impl changes; both wrappers pass the payload
-- through untouched and keep their auth preambles.

create or replace function public.commit_update_batch_impl(payload jsonb, v_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_relationship_id uuid := (payload ->> 'relationshipId')::uuid;
  v_participant_id uuid := (payload ->> 'participantId')::uuid;
  v_agent text := payload ->> 'agent';
  v_actor_kind public.actor_kind := coalesce(payload ->> 'actorKind', 'participant_agent')::public.actor_kind;
  v_display_text text := payload ->> 'displayText';
  v_notification_text text := payload ->> 'notificationText';
  v_update_id uuid;
  v_item jsonb;
  v_lock record;
  v_page public.wiki_pages%rowtype;
  v_pref public.preferences%rowtype;
  v_expected_version integer;
  v_next_version integer;
  v_hash text;
  v_changed_paths text[] := '{}';
begin
  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'sourceInteractionIds', '[]'::jsonb))
  loop
    if not exists (
      select 1 from public.interactions i
      where i.id = (v_item #>> '{}')::uuid
        and i.relationship_id = v_relationship_id
    ) then
      raise exception 'DM Sum source interaction is not in this relationship: %', v_item #>> '{}';
    end if;
  end loop;

  -- Lock phase: every page and preference this batch reads, writes, or
  -- deletes, in one global sort order. Existing rows get FOR UPDATE; absent
  -- rows get an advisory lock keyed on the would-be identity so concurrent
  -- creators serialize instead of racing the unique index.
  for v_lock in
    select kind, key from (
      select 'wiki'::text as kind, x ->> 'path' as key
      from jsonb_array_elements(coalesce(payload -> 'readSet', '[]'::jsonb)) x
      where x ->> 'kind' = 'wiki_page'
      union
      select 'wiki', x ->> 'path'
      from jsonb_array_elements(coalesce(payload -> 'wikiWrites', '[]'::jsonb)) x
      union
      select 'wiki', x ->> 'path'
      from jsonb_array_elements(coalesce(payload -> 'wikiDeletes', '[]'::jsonb)) x
      union
      select 'pref', x ->> 'participantId'
      from jsonb_array_elements(coalesce(payload -> 'readSet', '[]'::jsonb)) x
      where x ->> 'kind' = 'preference'
      union
      select 'pref', x ->> 'participantId'
      from jsonb_array_elements(coalesce(payload -> 'preferenceWrites', '[]'::jsonb)) x
    ) keys
    where key is not null
    order by kind, key
  loop
    if v_lock.kind = 'wiki' then
      perform 1 from public.wiki_pages
      where relationship_id = v_relationship_id and path = v_lock.key
      for update;
      if not found then
        perform pg_advisory_xact_lock(hashtextextended(v_relationship_id::text || '|wiki|' || v_lock.key, 0));
      end if;
    else
      perform 1 from public.preferences
      where relationship_id = v_relationship_id and participant_id = (v_lock.key)::uuid
      for update;
      if not found then
        perform pg_advisory_xact_lock(hashtextextended(v_relationship_id::text || '|pref|' || v_lock.key, 0));
      end if;
    end if;
  end loop;

  -- Check phase: identical to the original checks, now running under the
  -- locks taken above.
  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'readSet', '[]'::jsonb))
  loop
    v_expected_version := (v_item ->> 'expectedVersion')::integer;
    if v_item ->> 'kind' = 'wiki_page' then
      select * into v_page
      from public.wiki_pages
      where relationship_id = v_relationship_id and path = v_item ->> 'path';

      if (v_page.id is null and v_expected_version <> 0)
        or (v_page.id is not null and v_page.version <> v_expected_version) then
        v_changed_paths := array_append(v_changed_paths, v_item ->> 'path');
      end if;
    elsif v_item ->> 'kind' = 'preference' then
      select * into v_pref
      from public.preferences
      where relationship_id = v_relationship_id and participant_id = (v_item ->> 'participantId')::uuid;

      if (v_pref.id is null and v_expected_version <> 0)
        or (v_pref.id is not null and v_pref.version <> v_expected_version) then
        v_changed_paths := array_append(v_changed_paths, 'preferences/' || (v_item ->> 'participantId'));
      end if;
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'wikiWrites', '[]'::jsonb))
  loop
    v_expected_version := (v_item ->> 'expectedVersion')::integer;
    select * into v_page
    from public.wiki_pages
    where relationship_id = v_relationship_id and path = v_item ->> 'path';

    if (v_page.id is null and v_expected_version <> 0)
      or (v_page.id is not null and v_page.version <> v_expected_version) then
      v_changed_paths := array_append(v_changed_paths, v_item ->> 'path');
    end if;
  end loop;

  -- A delete needs the page present at exactly the version the agent read.
  -- Absent counts as stale, not success: if the page is already gone the
  -- world moved since the agent's read, and it should reread before
  -- deciding the deletion still makes sense.
  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'wikiDeletes', '[]'::jsonb))
  loop
    v_expected_version := (v_item ->> 'expectedVersion')::integer;
    select * into v_page
    from public.wiki_pages
    where relationship_id = v_relationship_id and path = v_item ->> 'path';

    if v_page.id is null or v_page.version <> v_expected_version then
      v_changed_paths := array_append(v_changed_paths, v_item ->> 'path');
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'preferenceWrites', '[]'::jsonb))
  loop
    v_expected_version := (v_item ->> 'expectedVersion')::integer;
    select * into v_pref
    from public.preferences
    where relationship_id = v_relationship_id and participant_id = (v_item ->> 'participantId')::uuid;

    if (v_pref.id is null and v_expected_version <> 0)
      or (v_pref.id is not null and v_pref.version <> v_expected_version) then
      v_changed_paths := array_append(v_changed_paths, 'preferences/' || (v_item ->> 'participantId'));
    end if;
  end loop;

  if array_length(v_changed_paths, 1) is not null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'stale',
      'changedPaths', (
        select jsonb_agg(distinct path_value)
        from unnest(v_changed_paths) as path_value
      )
    );
  end if;

  insert into public.updates (
    relationship_id,
    participant_id,
    actor_user_id,
    actor_kind,
    agent,
    display_text,
    notification_text
  ) values (
    v_relationship_id,
    v_participant_id,
    v_actor_user_id,
    v_actor_kind,
    v_agent,
    v_display_text,
    v_notification_text
  )
  returning id into v_update_id;

  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'sourceInteractionIds', '[]'::jsonb))
  loop
    insert into public.update_sources (relationship_id, update_id, interaction_id)
    values (v_relationship_id, v_update_id, (v_item #>> '{}')::uuid);
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'wikiWrites', '[]'::jsonb))
  loop
    v_hash := encode(extensions.digest(convert_to(v_item ->> 'content', 'UTF8'), 'sha256'), 'hex');
    select * into v_page
    from public.wiki_pages
    where relationship_id = v_relationship_id and path = v_item ->> 'path'
    for update;

    if v_page.id is null then
      insert into public.wiki_pages (relationship_id, path, title, content, content_hash, version)
      values (v_relationship_id, v_item ->> 'path', v_item ->> 'title', v_item ->> 'content', v_hash, 1)
      returning * into v_page;
      v_next_version := 1;
    else
      v_next_version := v_page.version + 1;
      update public.wiki_pages
      set title = v_item ->> 'title',
          content = v_item ->> 'content',
          content_hash = v_hash,
          version = v_next_version,
          updated_at = now()
      where id = v_page.id
      returning * into v_page;
    end if;

    insert into public.page_revisions (relationship_id, page_id, update_id, version, title, content, content_hash)
    values (v_relationship_id, v_page.id, v_update_id, v_next_version, v_item ->> 'title', v_item ->> 'content', v_hash);
  end loop;

  -- Delete phase: checked under lock above, so the row is present at the
  -- expected version. The row goes for real — page_revisions follow via FK
  -- cascade — and the update row inserted above is what remains of the act.
  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'wikiDeletes', '[]'::jsonb))
  loop
    delete from public.wiki_pages
    where relationship_id = v_relationship_id and path = v_item ->> 'path';
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'preferenceWrites', '[]'::jsonb))
  loop
    v_hash := encode(extensions.digest(convert_to(v_item ->> 'content', 'UTF8'), 'sha256'), 'hex');
    select * into v_pref
    from public.preferences
    where relationship_id = v_relationship_id and participant_id = (v_item ->> 'participantId')::uuid
    for update;

    if v_pref.id is null then
      insert into public.preferences (relationship_id, participant_id, content, content_hash, version)
      values (v_relationship_id, (v_item ->> 'participantId')::uuid, v_item ->> 'content', v_hash, 1)
      returning * into v_pref;
      v_next_version := 1;
    else
      v_next_version := v_pref.version + 1;
      update public.preferences
      set content = v_item ->> 'content',
          content_hash = v_hash,
          version = v_next_version,
          updated_at = now()
      where id = v_pref.id
      returning * into v_pref;
    end if;

    insert into public.preference_revisions (relationship_id, preference_id, update_id, version, content, content_hash)
    values (v_relationship_id, v_pref.id, v_update_id, v_next_version, v_item ->> 'content', v_hash);
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'resources', '[]'::jsonb))
  loop
    insert into public.resources (
      relationship_id,
      update_id,
      kind,
      url,
      title,
      source_name,
      quoted_text,
      note,
      metadata
    ) values (
      v_relationship_id,
      v_update_id,
      (v_item ->> 'kind')::public.resource_kind,
      v_item ->> 'url',
      v_item ->> 'title',
      v_item ->> 'sourceName',
      v_item ->> 'quotedText',
      v_item ->> 'note',
      coalesce(v_item -> 'metadata', '{}'::jsonb)
    );
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(payload -> 'attentionParticipantIds', '[]'::jsonb))
  loop
    insert into public.attention_records (relationship_id, update_id, from_participant_id, target_participant_id)
    values (v_relationship_id, v_update_id, v_participant_id, (v_item #>> '{}')::uuid);
  end loop;

  return jsonb_build_object(
    'ok', true,
    'updateId', v_update_id,
    'changedPaths', '[]'::jsonb
  );
end;
$$;

revoke all on function public.commit_update_batch_impl(jsonb, uuid) from public, anon, authenticated;
