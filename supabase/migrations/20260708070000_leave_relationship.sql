-- Member leave: access ends, the graph persists. Deleting the membership row is
-- what revokes access (RLS keys on relationship_members); nulling the participant
-- binding reverts them to a re-invitable placeholder while their display name and
-- every attributed act remain in the shared record. The owner cannot leave while
-- The owner cannot leave at all at launch — an owner leaving while alone would
-- orphan the graph behind RLS forever; the sole remaining member's exit is full
-- deletion, a separate future operation. Non-members get not_found so the RPC
-- does not reveal whether a relationship exists.

create or replace function public.leave_relationship(p_relationship_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_membership public.relationship_members%rowtype;
  v_participant_display_name text;
begin
  if v_user_id is null then
    raise exception 'leave_relationship requires an authenticated user';
  end if;

  select * into v_membership
  from public.relationship_members
  where relationship_id = p_relationship_id and user_id = v_user_id
  for update;

  if v_membership.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_membership.role = 'owner' then
    return jsonb_build_object('ok', false, 'reason', 'owner_cannot_leave');
  end if;

  select display_name into v_participant_display_name
  from public.participants
  where id = v_membership.participant_id;

  update public.participants
  set user_id = null, updated_at = now()
  where id = v_membership.participant_id;

  delete from public.relationship_members where id = v_membership.id;

  return jsonb_build_object(
    'ok', true,
    'relationshipId', p_relationship_id,
    'participantDisplayName', v_participant_display_name
  );
end;
$$;

revoke all on function public.leave_relationship(uuid) from public, anon;
grant execute on function public.leave_relationship(uuid) to authenticated;
grant execute on function public.leave_relationship(uuid) to service_role;
