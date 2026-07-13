-- Account deletion, composed from the leave doctrine: access ends and personal
-- account data is purged, but attributed contributions remain in sums that
-- other members keep. Three foreign keys predate that doctrine and are fixed
-- here so a plain `delete from auth.users` composes correctly:
--
--   interactions.actor_user_id   cascade -> set null  (raw interactions are the
--     communicative substrate of the shared record; they must survive their
--     author's account, attributed via participant_id like updates already are)
--   relationships.created_by     no action -> set null  (creator is provenance;
--     ownership authority lives in relationship_members)
--   notification_jobs.notification_endpoint_id  restrict -> cascade  (queue
--     plumbing dies with the endpoint; jobs are not part of the shared record)
--
-- Deletion is blocked while the user owns a sum another member has joined:
-- deleting it would destroy that member's shared record, and an ownerless
-- graph would be unreachable behind RLS. Owned sums nobody else has joined
-- are the user's own material and are deleted whole.

alter table public.interactions alter column actor_user_id drop not null;
alter table public.interactions drop constraint interactions_actor_user_id_fkey;
alter table public.interactions
  add constraint interactions_actor_user_id_fkey
  foreign key (actor_user_id) references auth.users(id) on delete set null;

alter table public.relationships alter column created_by drop not null;
alter table public.relationships drop constraint relationships_created_by_fkey;
alter table public.relationships
  add constraint relationships_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

alter table public.notification_jobs drop constraint notification_jobs_notification_endpoint_id_fkey;
alter table public.notification_jobs
  add constraint notification_jobs_notification_endpoint_id_fkey
  foreign key (notification_endpoint_id) references public.notification_endpoints(id) on delete cascade;

create or replace function public.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_blocking jsonb;
begin
  if v_user_id is null then
    raise exception 'delete_account requires an authenticated user';
  end if;

  select jsonb_agg(r.display_name order by r.display_name) into v_blocking
  from public.relationship_members rm_owner
  join public.relationships r on r.id = rm_owner.relationship_id
  where rm_owner.user_id = v_user_id
    and rm_owner.role = 'owner'
    and exists (
      select 1 from public.relationship_members rm_other
      where rm_other.relationship_id = rm_owner.relationship_id
        and rm_other.user_id <> v_user_id
    );

  if v_blocking is not null then
    return jsonb_build_object('ok', false, 'reason', 'owns_shared_sums', 'sums', v_blocking);
  end if;

  delete from public.relationships r
  using public.relationship_members rm
  where rm.relationship_id = r.id
    and rm.user_id = v_user_id
    and rm.role = 'owner';

  -- Memberships cascade (access to remaining sums ends), participants revert
  -- to re-invitable placeholders (set null) with attributed acts intact, and
  -- profile, contacts, connector tokens, notification endpoints, and OAuth
  -- grants cascade away with the auth row.
  delete from auth.users where id = v_user_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
grant execute on function public.delete_account() to service_role;
