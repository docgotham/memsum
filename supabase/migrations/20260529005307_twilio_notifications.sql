do $$ begin
  create type public.notification_job_source_kind as enum ('interaction', 'update', 'reminder');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.notification_job_status as enum ('pending', 'sending', 'sent', 'failed', 'cancelled', 'suppressed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.reminder_status as enum ('scheduled', 'sent', 'cancelled', 'failed');
exception when duplicate_object then null;
end $$;

create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  recipient_participant_id uuid not null references public.participants(id) on delete cascade,
  notification_endpoint_id uuid not null references public.notification_endpoints(id) on delete restrict,
  target_value_normalized text not null check (target_value_normalized ~ '^\+[1-9][0-9]{1,14}$'),
  source_kind public.notification_job_source_kind not null,
  source_id uuid not null,
  body text not null check (length(trim(body)) > 0),
  provider text not null default 'twilio',
  status public.notification_job_status not null default 'pending',
  send_after timestamptz not null default now(),
  provider_message_sid text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text not null unique,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_jobs_due_idx
  on public.notification_jobs (status, send_after, created_at)
  where status = 'pending';

create index if not exists notification_jobs_relationship_idx
  on public.notification_jobs (relationship_id, created_at desc);

create index if not exists notification_jobs_provider_message_sid_idx
  on public.notification_jobs (provider_message_sid)
  where provider_message_sid is not null;

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  created_by_participant_id uuid not null references public.participants(id) on delete cascade,
  recipient_participant_id uuid not null references public.participants(id) on delete cascade,
  source_interaction_id uuid not null references public.interactions(id) on delete cascade,
  body text not null check (length(trim(body)) > 0),
  remind_at timestamptz not null,
  timezone text not null,
  status public.reminder_status not null default 'scheduled',
  notification_job_id uuid references public.notification_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  cancelled_at timestamptz,
  check (recipient_participant_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

create index if not exists reminders_relationship_idx
  on public.reminders (relationship_id, remind_at);

alter table public.notification_jobs enable row level security;
alter table public.reminders enable row level security;

drop policy if exists notification_jobs_member_access on public.notification_jobs;
create policy notification_jobs_member_access on public.notification_jobs
  for select using (public.is_relationship_member(relationship_id));

drop policy if exists notification_jobs_member_insert on public.notification_jobs;
create policy notification_jobs_member_insert on public.notification_jobs
  for insert with check (public.is_relationship_member(relationship_id));

drop policy if exists reminders_member_access on public.reminders;
create policy reminders_member_access on public.reminders
  for select using (public.is_relationship_member(relationship_id));

drop policy if exists reminders_member_insert on public.reminders;
create policy reminders_member_insert on public.reminders
  for insert with check (public.is_relationship_member(relationship_id));

drop policy if exists reminders_member_update on public.reminders;
create policy reminders_member_update on public.reminders
  for update using (public.is_relationship_member(relationship_id))
  with check (public.is_relationship_member(relationship_id));

create or replace function public.touch_notification_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists notification_jobs_touch_updated_at on public.notification_jobs;
create trigger notification_jobs_touch_updated_at
before update on public.notification_jobs
for each row execute function public.touch_notification_updated_at();

drop trigger if exists reminders_touch_updated_at on public.reminders;
create trigger reminders_touch_updated_at
before update on public.reminders
for each row execute function public.touch_notification_updated_at();

create or replace function public.queue_interaction_notification_jobs()
returns trigger
language plpgsql
as $$
begin
  if new.notification_text is null or length(trim(new.notification_text)) = 0 then
    return new;
  end if;

  insert into public.notification_jobs (
    relationship_id,
    recipient_participant_id,
    notification_endpoint_id,
    target_value_normalized,
    source_kind,
    source_id,
    body,
    send_after,
    dedupe_key
  )
  select
    new.relationship_id,
    endpoint.participant_id,
    endpoint.id,
    endpoint.value_normalized,
    'interaction'::public.notification_job_source_kind,
    new.id,
    trim(new.notification_text),
    now(),
    'interaction:' || new.id::text || ':' || endpoint.participant_id::text || ':' || endpoint.id::text
  from unnest(new.addressed_participant_ids) as addressed(participant_id)
  join public.notification_endpoints endpoint
    on endpoint.relationship_id = new.relationship_id
   and endpoint.participant_id = addressed.participant_id
   and endpoint.kind = 'sms'
   and endpoint.provider = 'twilio'
   and endpoint.enabled = true
   and endpoint.verified_at is not null
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

drop trigger if exists interactions_queue_notification_jobs on public.interactions;
create trigger interactions_queue_notification_jobs
after insert on public.interactions
for each row execute function public.queue_interaction_notification_jobs();

create or replace function public.queue_update_attention_notification_jobs()
returns trigger
language plpgsql
as $$
declare
  source_update public.updates%rowtype;
begin
  select * into source_update
  from public.updates
  where id = new.update_id;

  if source_update.notification_text is null or length(trim(source_update.notification_text)) = 0 then
    return new;
  end if;

  insert into public.notification_jobs (
    relationship_id,
    recipient_participant_id,
    notification_endpoint_id,
    target_value_normalized,
    source_kind,
    source_id,
    body,
    send_after,
    dedupe_key
  )
  select
    new.relationship_id,
    endpoint.participant_id,
    endpoint.id,
    endpoint.value_normalized,
    'update'::public.notification_job_source_kind,
    new.update_id,
    trim(source_update.notification_text),
    now(),
    'update:' || new.update_id::text || ':' || endpoint.participant_id::text || ':' || endpoint.id::text
  from public.notification_endpoints endpoint
  where endpoint.relationship_id = new.relationship_id
    and endpoint.participant_id = new.target_participant_id
    and endpoint.kind = 'sms'
    and endpoint.provider = 'twilio'
    and endpoint.enabled = true
    and endpoint.verified_at is not null
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

drop trigger if exists attention_records_queue_notification_jobs on public.attention_records;
create trigger attention_records_queue_notification_jobs
after insert on public.attention_records
for each row execute function public.queue_update_attention_notification_jobs();

create or replace function public.queue_reminder_notification_job()
returns trigger
language plpgsql
as $$
declare
  inserted_job_id uuid;
begin
  if new.status <> 'scheduled' then
    return new;
  end if;

  with inserted as (
    insert into public.notification_jobs (
      relationship_id,
      recipient_participant_id,
      notification_endpoint_id,
      target_value_normalized,
      source_kind,
      source_id,
      body,
      send_after,
      dedupe_key
    )
    select
      new.relationship_id,
      endpoint.participant_id,
      endpoint.id,
      endpoint.value_normalized,
      'reminder'::public.notification_job_source_kind,
      new.id,
      trim(new.body),
      new.remind_at,
      'reminder:' || new.id::text || ':' || endpoint.participant_id::text || ':' || endpoint.id::text
    from public.notification_endpoints endpoint
    where endpoint.relationship_id = new.relationship_id
      and endpoint.participant_id = new.recipient_participant_id
      and endpoint.kind = 'sms'
      and endpoint.provider = 'twilio'
      and endpoint.enabled = true
      and endpoint.verified_at is not null
    on conflict (dedupe_key) do nothing
    returning id
  )
  select inserted.id into inserted_job_id
  from inserted
  limit 1;

  if inserted_job_id is not null then
    update public.reminders
    set notification_job_id = inserted_job_id
    where id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists reminders_queue_notification_job on public.reminders;
create trigger reminders_queue_notification_job
after insert on public.reminders
for each row execute function public.queue_reminder_notification_job();

create or replace function public.claim_notification_jobs(worker_id text, batch_size integer default 10)
returns table (
  id uuid,
  relationship_id uuid,
  recipient_participant_id uuid,
  target_value_normalized text,
  source_kind public.notification_job_source_kind,
  source_id uuid,
  body text,
  attempt_count integer
)
language plpgsql
as $$
begin
  if coalesce(batch_size, 0) < 1 or batch_size > 50 then
    raise exception 'batch_size must be between 1 and 50';
  end if;

  return query
  update public.notification_jobs job
  set
    status = 'sending',
    locked_at = now(),
    locked_by = worker_id,
    attempt_count = job.attempt_count + 1,
    updated_at = now()
  where job.id in (
    select due.id
    from public.notification_jobs due
    where due.status = 'pending'
      and due.send_after <= now()
    order by due.send_after asc, due.created_at asc
    limit batch_size
    for update skip locked
  )
  returning
    job.id,
    job.relationship_id,
    job.recipient_participant_id,
    job.target_value_normalized,
    job.source_kind,
    job.source_id,
    job.body,
    job.attempt_count;
end;
$$;

grant select, insert on table public.notification_jobs to authenticated;
grant select, insert, update on table public.reminders to authenticated;
grant all on table public.notification_jobs to service_role;
grant all on table public.reminders to service_role;
grant execute on function public.claim_notification_jobs(text, integer) to service_role;
