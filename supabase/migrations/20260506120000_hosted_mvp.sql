-- DM Sum hosted MVP foundation.
-- Supabase Auth provides auth.users and auth.uid().

create extension if not exists pgcrypto;

do $$ begin
  create type public.contact_method_kind as enum ('email', 'phone');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.relationship_member_role as enum ('owner', 'member');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.actor_kind as enum ('participant_agent', 'workspace_agent');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.resource_kind as enum ('url', 'excerpt', 'url_with_excerpt', 'file');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.notification_endpoint_kind as enum ('sms');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.attention_status as enum ('open', 'done', 'dismissed');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  primary_email text,
  primary_phone text check (primary_phone is null or primary_phone ~ '^\+[1-9][0-9]{1,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_contact_methods (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind public.contact_method_kind not null,
  value_normalized text not null,
  verified_at timestamptz,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  check (
    (kind = 'phone' and value_normalized ~ '^\+[1-9][0-9]{1,14}$')
    or (kind = 'email' and value_normalized ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  ),
  unique (kind, value_normalized)
);

create table if not exists public.relationships (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists participants_one_user_per_relationship_idx
  on public.participants (relationship_id, user_id)
  where user_id is not null;

create table if not exists public.relationship_members (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  role public.relationship_member_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (relationship_id, user_id),
  unique (participant_id)
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  handle text not null check (handle ~ '^@[a-z0-9][a-z0-9_-]{0,63}$'),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  unique (owner_user_id, handle)
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  invited_by_user_id uuid not null references auth.users(id) on delete cascade,
  target_kind public.contact_method_kind not null,
  target_value_normalized text not null,
  participant_id uuid references public.participants(id) on delete set null,
  status public.invitation_status not null default 'pending',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  check (
    (target_kind = 'phone' and target_value_normalized ~ '^\+[1-9][0-9]{1,14}$')
    or (target_kind = 'email' and target_value_normalized ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  )
);

create table if not exists public.participant_contact_methods (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  kind public.contact_method_kind not null,
  value_normalized text not null,
  verified_at timestamptz,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  check (
    (kind = 'phone' and value_normalized ~ '^\+[1-9][0-9]{1,14}$')
    or (kind = 'email' and value_normalized ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  )
);

create table if not exists public.notification_endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  participant_id uuid references public.participants(id) on delete cascade,
  relationship_id uuid references public.relationships(id) on delete cascade,
  kind public.notification_endpoint_kind not null,
  value_normalized text not null check (value_normalized ~ '^\+[1-9][0-9]{1,14}$'),
  provider text not null default 'twilio',
  enabled boolean not null default true,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (user_id is not null or participant_id is not null)
);

create table if not exists public.interactions (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  agent text not null,
  raw_text text not null,
  addressed_participant_ids uuid[] not null default '{}',
  notification_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.updates (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_kind public.actor_kind not null default 'participant_agent',
  agent text not null,
  display_text text not null,
  notification_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.update_sources (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  update_id uuid not null references public.updates(id) on delete cascade,
  interaction_id uuid not null references public.interactions(id) on delete restrict,
  unique (update_id, interaction_id)
);

create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  interaction_id uuid references public.interactions(id) on delete cascade,
  update_id uuid references public.updates(id) on delete cascade,
  kind public.resource_kind not null,
  url text,
  title text,
  source_name text,
  quoted_text text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (interaction_id is not null or update_id is not null)
);

create table if not exists public.wiki_pages (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  path text not null check (path !~ '(^/|^[A-Za-z]:|\\|\.\.|//)' and path ~ '\.md$'),
  title text not null,
  content text not null default '',
  content_hash text not null default encode(extensions.digest(convert_to('', 'UTF8'), 'sha256'), 'hex'),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (relationship_id, path)
);

create table if not exists public.page_revisions (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  page_id uuid not null references public.wiki_pages(id) on delete cascade,
  update_id uuid not null references public.updates(id) on delete cascade,
  version integer not null check (version >= 1),
  title text not null,
  content text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (page_id, version)
);

create table if not exists public.preferences (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  content text not null default '',
  content_hash text not null default encode(extensions.digest(convert_to('', 'UTF8'), 'sha256'), 'hex'),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (relationship_id, participant_id)
);

create table if not exists public.preference_revisions (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  preference_id uuid not null references public.preferences(id) on delete cascade,
  update_id uuid not null references public.updates(id) on delete cascade,
  version integer not null check (version >= 1),
  content text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (preference_id, version)
);

create table if not exists public.attention_records (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  update_id uuid not null references public.updates(id) on delete cascade,
  from_participant_id uuid not null references public.participants(id) on delete cascade,
  target_participant_id uuid not null references public.participants(id) on delete cascade,
  status public.attention_status not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create or replace function public.is_relationship_member(target_relationship_id uuid)
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
      and rm.user_id = auth.uid()
  );
$$;

create or replace function public.can_access_participant(target_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.participants p
    where p.id = target_participant_id
      and public.is_relationship_member(p.relationship_id)
  );
$$;

alter table public.profiles enable row level security;
alter table public.profile_contact_methods enable row level security;
alter table public.relationships enable row level security;
alter table public.participants enable row level security;
alter table public.relationship_members enable row level security;
alter table public.contacts enable row level security;
alter table public.invitations enable row level security;
alter table public.participant_contact_methods enable row level security;
alter table public.notification_endpoints enable row level security;
alter table public.interactions enable row level security;
alter table public.updates enable row level security;
alter table public.update_sources enable row level security;
alter table public.resources enable row level security;
alter table public.wiki_pages enable row level security;
alter table public.page_revisions enable row level security;
alter table public.preferences enable row level security;
alter table public.preference_revisions enable row level security;
alter table public.attention_records enable row level security;

drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_self_insert on public.profiles;
create policy profiles_self_insert on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profile_contact_methods_self on public.profile_contact_methods;
create policy profile_contact_methods_self on public.profile_contact_methods
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

drop policy if exists relationships_member_read on public.relationships;
create policy relationships_member_read on public.relationships
  for select using (public.is_relationship_member(id));

drop policy if exists relationships_creator_insert on public.relationships;
create policy relationships_creator_insert on public.relationships
  for insert with check (created_by = auth.uid());

drop policy if exists participants_member_access on public.participants;
create policy participants_member_access on public.participants
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists relationship_members_member_read on public.relationship_members;
create policy relationship_members_member_read on public.relationship_members
  for select using (public.is_relationship_member(relationship_id));

drop policy if exists contacts_owner_access on public.contacts;
create policy contacts_owner_access on public.contacts
  for all using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

drop policy if exists invitations_member_access on public.invitations;
create policy invitations_member_access on public.invitations
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists participant_contact_methods_member_access on public.participant_contact_methods;
create policy participant_contact_methods_member_access on public.participant_contact_methods
  for all using (public.can_access_participant(participant_id)) with check (public.can_access_participant(participant_id));

drop policy if exists notification_endpoints_member_access on public.notification_endpoints;
create policy notification_endpoints_member_access on public.notification_endpoints
  for all using (
    user_id = auth.uid()
    or (relationship_id is not null and public.is_relationship_member(relationship_id))
    or (participant_id is not null and public.can_access_participant(participant_id))
  ) with check (
    user_id = auth.uid()
    or (relationship_id is not null and public.is_relationship_member(relationship_id))
    or (participant_id is not null and public.can_access_participant(participant_id))
  );

drop policy if exists interactions_member_access on public.interactions;
create policy interactions_member_access on public.interactions
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists updates_member_access on public.updates;
create policy updates_member_access on public.updates
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists update_sources_member_access on public.update_sources;
create policy update_sources_member_access on public.update_sources
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists resources_member_access on public.resources;
create policy resources_member_access on public.resources
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists wiki_pages_member_access on public.wiki_pages;
create policy wiki_pages_member_access on public.wiki_pages
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists page_revisions_member_access on public.page_revisions;
create policy page_revisions_member_access on public.page_revisions
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists preferences_member_access on public.preferences;
create policy preferences_member_access on public.preferences
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists preference_revisions_member_access on public.preference_revisions;
create policy preference_revisions_member_access on public.preference_revisions
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

drop policy if exists attention_records_member_access on public.attention_records;
create policy attention_records_member_access on public.attention_records
  for all using (public.is_relationship_member(relationship_id)) with check (public.is_relationship_member(relationship_id));

create or replace function public.commit_update_batch(payload jsonb)
returns jsonb
language plpgsql
security invoker
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
  v_page public.wiki_pages%rowtype;
  v_pref public.preferences%rowtype;
  v_expected_version integer;
  v_next_version integer;
  v_hash text;
  v_changed_paths text[] := '{}';
begin
  if auth.uid() is null then
    raise exception 'DM Sum commit_update_batch requires an authenticated user';
  end if;

  if not public.is_relationship_member(v_relationship_id) then
    raise exception 'DM Sum relationship access denied';
  end if;

  if not exists (
    select 1 from public.relationship_members rm
    where rm.relationship_id = v_relationship_id
      and rm.participant_id = v_participant_id
      and rm.user_id = auth.uid()
  ) then
    raise exception 'DM Sum participant does not belong to authenticated user in this relationship';
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
    auth.uid(),
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
