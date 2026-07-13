-- Pilot limits: hardcoded, visible, free-beta resource quotas. Rate limiting
-- (request frequency) already guards the doors; these guard the volume — one
-- account cannot hoard sums, flood a graph with updates, or grow pages
-- without bound. Enforced as BEFORE INSERT/UPDATE triggers so every write
-- path is covered uniformly: dashboard-direct under RLS, invoker RPCs, and
-- the service-role kernel functions (service role bypasses RLS, never
-- triggers). Rejections raise P0001 with a plain-language message naming the
-- limit and the number, which the kernel's storageError classifier already
-- relays verbatim as a client-actionable 400.

create or replace function public.pilot_limits()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'sumsCreatedPerAccount', 10,
    'updatesPerSumPerDay', 200,
    'interactionsPerSumPerDay', 500,
    'remindersPerSumPerDay', 50,
    'pagesPerSum', 500,
    'pageContentMaxBytes', 262144,
    'interactionTextMaxBytes', 65536,
    'preferenceContentMaxBytes', 65536
  );
$$;

revoke all on function public.pilot_limits() from public, anon;
grant execute on function public.pilot_limits() to authenticated;
grant execute on function public.pilot_limits() to service_role;

create or replace function public.enforce_relationship_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := (public.pilot_limits() ->> 'sumsCreatedPerAccount')::integer;
begin
  if new.created_by is not null
    and (select count(*) from public.relationships where created_by = new.created_by) >= v_limit then
    raise exception 'DM Sum pilot limit: the free beta allows % sums created per account', v_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists relationships_pilot_limit on public.relationships;
create trigger relationships_pilot_limit
  before insert on public.relationships
  for each row execute function public.enforce_relationship_pilot_limit();

create or replace function public.enforce_update_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := (public.pilot_limits() ->> 'updatesPerSumPerDay')::integer;
begin
  if (select count(*) from public.updates
      where relationship_id = new.relationship_id
        and created_at > now() - interval '24 hours') >= v_limit then
    raise exception 'DM Sum pilot limit: the free beta allows % updates per sum per day', v_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists updates_pilot_limit on public.updates;
create trigger updates_pilot_limit
  before insert on public.updates
  for each row execute function public.enforce_update_pilot_limit();

create or replace function public.enforce_interaction_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count_limit integer := (public.pilot_limits() ->> 'interactionsPerSumPerDay')::integer;
  v_bytes_limit integer := (public.pilot_limits() ->> 'interactionTextMaxBytes')::integer;
begin
  if octet_length(new.raw_text) > v_bytes_limit then
    raise exception 'DM Sum pilot limit: an interaction may hold up to % bytes of raw text', v_bytes_limit;
  end if;
  if (select count(*) from public.interactions
      where relationship_id = new.relationship_id
        and created_at > now() - interval '24 hours') >= v_count_limit then
    raise exception 'DM Sum pilot limit: the free beta allows % interactions per sum per day', v_count_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists interactions_pilot_limit on public.interactions;
create trigger interactions_pilot_limit
  before insert on public.interactions
  for each row execute function public.enforce_interaction_pilot_limit();

create or replace function public.enforce_wiki_page_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pages_limit integer := (public.pilot_limits() ->> 'pagesPerSum')::integer;
  v_bytes_limit integer := (public.pilot_limits() ->> 'pageContentMaxBytes')::integer;
begin
  if octet_length(new.content) > v_bytes_limit then
    raise exception 'DM Sum pilot limit: a wiki page may hold up to % bytes', v_bytes_limit;
  end if;
  if tg_op = 'INSERT'
    and (select count(*) from public.wiki_pages where relationship_id = new.relationship_id) >= v_pages_limit then
    raise exception 'DM Sum pilot limit: the free beta allows % wiki pages per sum', v_pages_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists wiki_pages_pilot_limit on public.wiki_pages;
create trigger wiki_pages_pilot_limit
  before insert or update on public.wiki_pages
  for each row execute function public.enforce_wiki_page_pilot_limit();

create or replace function public.enforce_reminder_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := (public.pilot_limits() ->> 'remindersPerSumPerDay')::integer;
begin
  if (select count(*) from public.reminders
      where relationship_id = new.relationship_id
        and created_at > now() - interval '24 hours') >= v_limit then
    raise exception 'DM Sum pilot limit: the free beta allows % reminders per sum per day', v_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists reminders_pilot_limit on public.reminders;
create trigger reminders_pilot_limit
  before insert on public.reminders
  for each row execute function public.enforce_reminder_pilot_limit();

create or replace function public.enforce_preference_pilot_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bytes_limit integer := (public.pilot_limits() ->> 'preferenceContentMaxBytes')::integer;
begin
  if octet_length(new.content) > v_bytes_limit then
    raise exception 'DM Sum pilot limit: a preference file may hold up to % bytes', v_bytes_limit;
  end if;
  return new;
end;
$$;

drop trigger if exists preferences_pilot_limit on public.preferences;
create trigger preferences_pilot_limit
  before insert or update on public.preferences
  for each row execute function public.enforce_preference_pilot_limit();
