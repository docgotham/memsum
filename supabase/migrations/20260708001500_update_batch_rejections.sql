-- Rejected commit_update_batch attempts leave no graph trace by design: the batch
-- transaction rolls back atomically and list_activity shows only successes. This
-- audit table records rejections outside the transaction so operators (and a future
-- dashboard) can debug cross-vendor agent behavior. The hosted kernel writes rows
-- best-effort after a stale rejection or RPC error; a failed audit write never
-- masks the batch result, and nothing here is ever written from inside the batch
-- transaction itself.

create table if not exists public.update_batch_rejections (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  agent text not null,
  rejection_kind text not null check (rejection_kind in ('stale', 'error')),
  reason text not null,
  changed_paths jsonb not null default '[]'::jsonb,
  read_set_size integer not null default 0,
  wiki_write_paths jsonb not null default '[]'::jsonb,
  preference_write_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists update_batch_rejections_relationship_created_at_idx
  on public.update_batch_rejections (relationship_id, created_at desc);

alter table public.update_batch_rejections enable row level security;

drop policy if exists update_batch_rejections_member_select on public.update_batch_rejections;
create policy update_batch_rejections_member_select
  on public.update_batch_rejections
  for select
  using (public.is_relationship_member(relationship_id));

drop policy if exists update_batch_rejections_member_insert on public.update_batch_rejections;
create policy update_batch_rejections_member_insert
  on public.update_batch_rejections
  for insert
  with check (public.is_relationship_member(relationship_id));

-- Append-only for participants: members may record and read their relationship's
-- rejections, never rewrite or remove them. Service role keeps maintenance access.
grant select, insert on table public.update_batch_rejections to authenticated;
grant all on table public.update_batch_rejections to service_role;
