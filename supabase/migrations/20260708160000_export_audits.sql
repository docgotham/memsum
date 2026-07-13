-- Audit trail for data exports (interchange profile §6: the downloadable
-- archive carries an audit-log entry per export). Every member of a sum can
-- see who exported it and when — provenance, not permission. Inserts happen
-- under the exporting user's own RLS so the actor recorded is the actor
-- authenticated; the row outlives the account (user_id nulls on deletion)
-- because the other members' record of the export is theirs to keep.

create table if not exists public.export_audits (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references public.relationships(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  profile text not null check (profile in ('share', 'archive')),
  page_count integer not null check (page_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists export_audits_relationship_created_at_idx
  on public.export_audits (relationship_id, created_at desc);

alter table public.export_audits enable row level security;

drop policy if exists export_audits_member_read on public.export_audits;
create policy export_audits_member_read on public.export_audits
  for select using (
    exists (
      select 1 from public.relationship_members rm
      where rm.relationship_id = export_audits.relationship_id
        and rm.user_id = auth.uid()
    )
  );

drop policy if exists export_audits_member_insert on public.export_audits;
create policy export_audits_member_insert on public.export_audits
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.relationship_members rm
      where rm.relationship_id = export_audits.relationship_id
        and rm.user_id = auth.uid()
    )
  );

revoke all on table public.export_audits from public, anon;
grant select, insert on table public.export_audits to authenticated;
grant all on table public.export_audits to service_role;
