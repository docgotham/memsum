-- Operator admin surface, under the doctrine: the operator sees metadata and
-- aggregates, never content — by construction. This migration deliberately
-- references no content column (no page content, no raw interaction text, no
-- notification bodies, no phone numbers); a kernel test enforces that
-- property, so admin tooling that starts reading content fails the suite.
--
-- operator_content_audits is the standing commitment behind the privacy
-- policy: if operator tooling ever touches a sum's content (support,
-- incident), it must write a row here — and members of that sum can see it.
-- If we ever look, you see that we looked.

create table if not exists public.operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.operators enable row level security;
revoke all on table public.operators from public, anon, authenticated;
grant all on table public.operators to service_role;

insert into public.operators (user_id)
values ('642b5352-1203-444d-9b03-5323eecfecc9')
on conflict (user_id) do nothing;

create or replace function public.require_operator()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (select 1 from public.operators where user_id = auth.uid()) then
    raise exception 'DM Sum operator access required';
  end if;
end;
$$;

revoke all on function public.require_operator() from public, anon;
grant execute on function public.require_operator() to authenticated;
grant execute on function public.require_operator() to service_role;

create table if not exists public.operator_content_audits (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  operator_user_id uuid references auth.users(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.operator_content_audits enable row level security;

drop policy if exists operator_content_audits_member_read on public.operator_content_audits;
create policy operator_content_audits_member_read on public.operator_content_audits
  for select using (
    exists (
      select 1 from public.relationship_members rm
      where rm.relationship_id = operator_content_audits.relationship_id
        and rm.user_id = auth.uid()
    )
  );

revoke all on table public.operator_content_audits from public, anon;
grant select on table public.operator_content_audits to authenticated;
grant all on table public.operator_content_audits to service_role;

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
    'daily', v_daily
  );
end;
$$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_overview() to service_role;
