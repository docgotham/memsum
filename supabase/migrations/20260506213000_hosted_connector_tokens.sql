-- Private-pilot connector tokens for remote MCP clients.
-- Tokens are shown once to the operator; the database stores only SHA-256 hashes.

create table if not exists public.connector_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default array['mcp'],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  unique (token_hash)
);

create index if not exists connector_tokens_owner_user_id_idx
  on public.connector_tokens (owner_user_id);

create index if not exists connector_tokens_active_hash_idx
  on public.connector_tokens (token_hash)
  where revoked_at is null;

alter table public.connector_tokens enable row level security;

drop policy if exists connector_tokens_owner_read on public.connector_tokens;
create policy connector_tokens_owner_read on public.connector_tokens
  for select using (owner_user_id = auth.uid());

drop policy if exists connector_tokens_owner_insert on public.connector_tokens;
create policy connector_tokens_owner_insert on public.connector_tokens
  for insert with check (owner_user_id = auth.uid());

drop policy if exists connector_tokens_owner_update on public.connector_tokens;
create policy connector_tokens_owner_update on public.connector_tokens
  for update using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create or replace function public.issue_connector_token(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_token_id uuid;
  v_name text := nullif(trim(payload ->> 'name'), '');
  v_token_hash text := lower(payload ->> 'tokenHash');
  v_expires_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'DM Sum issue_connector_token requires an authenticated user';
  end if;

  if v_name is null then
    raise exception 'Connector token name is required';
  end if;

  if v_token_hash is null or v_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Connector token hash must be a lowercase SHA-256 hex digest';
  end if;

  if payload ? 'expiresAt' and nullif(payload ->> 'expiresAt', '') is not null then
    v_expires_at := (payload ->> 'expiresAt')::timestamptz;
  end if;

  insert into public.connector_tokens (owner_user_id, name, token_hash, expires_at)
  values (v_user_id, v_name, v_token_hash, v_expires_at)
  returning id into v_token_id;

  return jsonb_build_object(
    'tokenId', v_token_id,
    'name', v_name,
    'expiresAt', v_expires_at
  );
end;
$$;

create or replace function public.list_connector_tokens()
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'tokenId', id,
        'name', name,
        'scopes', scopes,
        'createdAt', created_at,
        'lastUsedAt', last_used_at,
        'expiresAt', expires_at,
        'revokedAt', revoked_at
      )
      order by created_at desc
    ),
    '[]'::jsonb
  )
  from public.connector_tokens
  where owner_user_id = auth.uid();
$$;

create or replace function public.revoke_connector_token(target_token_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'DM Sum revoke_connector_token requires an authenticated user';
  end if;

  update public.connector_tokens
  set revoked_at = coalesce(revoked_at, now())
  where id = target_token_id
    and owner_user_id = v_user_id;

  get diagnostics v_count = row_count;

  return jsonb_build_object('revoked', v_count = 1);
end;
$$;

create or replace function public.resolve_connector_token(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token public.connector_tokens%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'DM Sum resolve_connector_token is service-role only';
  end if;

  select * into v_token
  from public.connector_tokens
  where token_hash = lower(p_token_hash)
    and revoked_at is null
    and (expires_at is null or expires_at > now());

  if v_token.id is null then
    return jsonb_build_object('ok', false);
  end if;

  update public.connector_tokens
  set last_used_at = now()
  where id = v_token.id;

  return jsonb_build_object(
    'ok', true,
    'tokenId', v_token.id,
    'userId', v_token.owner_user_id,
    'scopes', v_token.scopes
  );
end;
$$;

create or replace function public.is_relationship_member_for_user(target_relationship_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.relationship_members rm
    where rm.relationship_id = target_relationship_id
      and rm.user_id = target_user_id
  );
$$;

create or replace function public.create_relationship_context_for_user(payload jsonb, target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := target_user_id;
  v_relationship_id uuid;
  v_self_participant_id uuid;
  v_peer_participant_id uuid;
  v_relationship_display_name text := nullif(trim(payload ->> 'relationshipDisplayName'), '');
  v_self_display_name text := nullif(trim(payload ->> 'selfDisplayName'), '');
  v_peer_display_name text := nullif(trim(payload ->> 'peerDisplayName'), '');
  v_contact_handle text := nullif(trim(lower(payload ->> 'contactHandle')), '');
  v_contact_display_name text := nullif(trim(payload ->> 'contactDisplayName'), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'DM Sum create_relationship_context_for_user is service-role only';
  end if;

  if v_user_id is null then
    raise exception 'target_user_id is required';
  end if;

  if v_relationship_display_name is null then
    raise exception 'relationshipDisplayName is required';
  end if;

  if v_self_display_name is null then
    raise exception 'selfDisplayName is required';
  end if;

  if v_peer_display_name is null and v_contact_handle is not null then
    raise exception 'peerDisplayName is required when contactHandle is provided';
  end if;

  if v_contact_handle is not null and v_contact_handle !~ '^@[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'contactHandle must look like @lisa';
  end if;

  insert into public.profiles (id, display_name)
  values (v_user_id, v_self_display_name)
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  insert into public.relationships (created_by, display_name)
  values (v_user_id, v_relationship_display_name)
  returning id into v_relationship_id;

  insert into public.participants (relationship_id, user_id, display_name)
  values (v_relationship_id, v_user_id, v_self_display_name)
  returning id into v_self_participant_id;

  insert into public.relationship_members (relationship_id, user_id, participant_id, role)
  values (v_relationship_id, v_user_id, v_self_participant_id, 'owner');

  if v_peer_display_name is not null then
    insert into public.participants (relationship_id, display_name)
    values (v_relationship_id, v_peer_display_name)
    returning id into v_peer_participant_id;
  end if;

  if v_contact_handle is not null then
    insert into public.contacts (
      owner_user_id,
      handle,
      relationship_id,
      participant_id,
      display_name
    ) values (
      v_user_id,
      v_contact_handle,
      v_relationship_id,
      v_peer_participant_id,
      coalesce(v_contact_display_name, v_peer_display_name)
    );
  end if;

  return jsonb_build_object(
    'relationshipId', v_relationship_id,
    'selfParticipantId', v_self_participant_id,
    'peerParticipantId', v_peer_participant_id,
    'contactHandle', v_contact_handle
  );
end;
$$;

create or replace function public.commit_update_batch_for_user(payload jsonb, target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_user_id uuid := target_user_id;
  v_relationship_id uuid := (payload ->> 'relationshipId')::uuid;
  v_participant_id uuid := (payload ->> 'participantId')::uuid;
  v_agent text := payload ->> 'agent';
  v_actor_kind public.actor_kind := coalesce(payload ->> 'actorKind', 'participant_agent')::public.actor_kind;
  v_display_text text := payload ->> 'displayText';
  v_notification_text text := payload ->> 'notificationText';
  v_update_id uuid;
  v_item jsonb;
  v_page public.wiki_pages%rowtype;
  v_pref public.preferences%rowtype;
  v_expected_version integer;
  v_next_version integer;
  v_hash text;
  v_changed_paths text[] := '{}';
begin
  if auth.role() <> 'service_role' then
    raise exception 'DM Sum commit_update_batch_for_user is service-role only';
  end if;

  if v_actor_user_id is null then
    raise exception 'target_user_id is required';
  end if;

  if not public.is_relationship_member_for_user(v_relationship_id, v_actor_user_id) then
    raise exception 'DM Sum relationship access denied';
  end if;

  if not exists (
    select 1 from public.relationship_members rm
    where rm.relationship_id = v_relationship_id
      and rm.participant_id = v_participant_id
      and rm.user_id = v_actor_user_id
  ) then
    raise exception 'DM Sum participant does not belong to connector token owner in this relationship';
  end if;

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

revoke execute on function public.issue_connector_token(jsonb) from public;
revoke execute on function public.list_connector_tokens() from public;
revoke execute on function public.revoke_connector_token(uuid) from public;
revoke execute on function public.resolve_connector_token(text) from public;
revoke execute on function public.is_relationship_member_for_user(uuid, uuid) from public;
revoke execute on function public.create_relationship_context_for_user(jsonb, uuid) from public;
revoke execute on function public.commit_update_batch_for_user(jsonb, uuid) from public;

grant usage on schema public to authenticated;
grant select, insert, update on table public.connector_tokens to authenticated;
grant execute on function public.issue_connector_token(jsonb) to authenticated;
grant execute on function public.list_connector_tokens() to authenticated;
grant execute on function public.revoke_connector_token(uuid) to authenticated;

grant usage on schema public to service_role;
grant all on table public.connector_tokens to service_role;
grant execute on function public.resolve_connector_token(text) to service_role;
grant execute on function public.is_relationship_member_for_user(uuid, uuid) to service_role;
grant execute on function public.create_relationship_context_for_user(jsonb, uuid) to service_role;
grant execute on function public.commit_update_batch_for_user(jsonb, uuid) to service_role;
