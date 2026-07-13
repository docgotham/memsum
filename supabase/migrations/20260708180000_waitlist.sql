-- Beta waitlist: the public site's one anonymous write. The table is
-- service-only; the definer function is the whole surface. It stores a
-- normalized email and a timestamp, nothing else. It answers identically for
-- new and already-known addresses (an anonymous caller cannot probe which
-- emails are on the list), and it refuses to grow past a hard cap so an
-- unauthenticated form cannot balloon the database.
--
-- This migration also re-creates admin_overview to surface the waitlist to
-- the operator. The content-blindness doctrine still holds: waitlist emails
-- are volunteered contact info, and no sum-content column or table is
-- referenced anywhere in this file. The kernel test that enforces that
-- property scans every migration defining admin_overview, including this one.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  invited_at timestamptz
);

alter table public.waitlist enable row level security;
revoke all on table public.waitlist from public, anon, authenticated;
grant all on table public.waitlist to service_role;

create or replace function public.join_waitlist(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  v_email := lower(btrim(coalesce(p_email, '')));
  if length(v_email) < 6 or length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That does not look like an email address.';
  end if;
  if (select count(*) from public.waitlist) >= 10000 then
    raise exception 'The waitlist is full right now. Please try again later.';
  end if;
  insert into public.waitlist (email) values (v_email)
  on conflict (email) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.join_waitlist(text) from public;
grant execute on function public.join_waitlist(text) to anon;
grant execute on function public.join_waitlist(text) to authenticated;
grant execute on function public.join_waitlist(text) to service_role;

-- admin_overview, superseding 20260708170000: identical shape plus a
-- 'waitlist' total and a waitlist listing (email, joined, invited).
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_accounts jsonb;
  v_invitations jsonb;
  v_waitlist jsonb;
  v_daily jsonb;
  v_totals jsonb;
begin
  perform public.require_operator();

  select coalesce(jsonb_agg(account order by account -> 'createdAt' desc), '[]'::jsonb) into v_accounts
  from (
    select jsonb_build_object(
      'email', u.email,
      'createdAt', u.created_at,
      'lastSignInAt', u.last_sign_in_at,
      'sumsOwned', (select count(*) from public.relationship_members rm where rm.user_id = u.id and rm.role = 'owner'),
      'sumsMemberOf', (select count(*) from public.relationship_members rm where rm.user_id = u.id)
    ) as account
    from auth.users u
  ) accounts;

  select coalesce(jsonb_agg(invitation order by invitation -> 'createdAt' desc), '[]'::jsonb) into v_invitations
  from (
    select jsonb_build_object(
      'sum', r.display_name,
      'participant', p.display_name,
      'status', i.status,
      'createdAt', i.created_at,
      'acceptedAt', i.accepted_at,
      'expiresAt', i.expires_at
    ) as invitation
    from public.invitations i
    join public.relationships r on r.id = i.relationship_id
    left join public.participants p on p.id = i.participant_id
  ) invitations;

  select coalesce(jsonb_agg(entry order by entry -> 'createdAt' desc), '[]'::jsonb) into v_waitlist
  from (
    select jsonb_build_object(
      'email', w.email,
      'createdAt', w.created_at,
      'invitedAt', w.invited_at
    ) as entry
    from public.waitlist w
  ) waitlist_entries;

  select coalesce(jsonb_agg(day_row order by day_row -> 'day' desc), '[]'::jsonb) into v_daily
  from (
    select jsonb_build_object(
      'day', to_char(d.day, 'YYYY-MM-DD'),
      'newAccounts', (select count(*) from auth.users u where u.created_at::date = d.day),
      'updates', (select count(*) from public.updates x where x.created_at::date = d.day),
      'interactions', (select count(*) from public.interactions x where x.created_at::date = d.day),
      'smsSent', (select count(*) from public.notification_jobs j where j.status = 'sent' and j.sent_at::date = d.day)
    ) as day_row
    from (select generate_series(current_date - interval '13 days', current_date, interval '1 day')::date as day) d
  ) daily;

  select jsonb_build_object(
    'accounts', (select count(*) from auth.users),
    'sums', (select count(*) from public.relationships),
    'pendingInvitations', (select count(*) from public.invitations where status = 'pending'),
    'waitlist', (select count(*) from public.waitlist),
    'updates7d', (select count(*) from public.updates where created_at > now() - interval '7 days'),
    'interactions7d', (select count(*) from public.interactions where created_at > now() - interval '7 days'),
    'smsSent7d', (select count(*) from public.notification_jobs where status = 'sent' and sent_at > now() - interval '7 days'),
    'activeAccounts7d', (
      select count(distinct actor_user_id) from (
        select actor_user_id from public.updates where created_at > now() - interval '7 days' and actor_user_id is not null
        union
        select actor_user_id from public.interactions where created_at > now() - interval '7 days' and actor_user_id is not null
      ) actors
    )
  ) into v_totals;

  return jsonb_build_object(
    'totals', v_totals,
    'accounts', v_accounts,
    'invitations', v_invitations,
    'waitlist', v_waitlist,
    'daily', v_daily
  );
end;
$$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_overview() to service_role;
