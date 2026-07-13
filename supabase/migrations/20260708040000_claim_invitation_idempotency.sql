-- Fix found by the live two-account E2E test: the same-user idempotency branch in
-- claim_invitation was ordered after the pending-status check, so a double-tap on an
-- already-claimed link returned not_pending instead of succeeding quietly. Reorder:
-- once the invitation's participant is bound to the caller, re-claiming any link for
-- that participant returns ok/alreadyClaimed regardless of invitation status.

create or replace function public.claim_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invitation public.invitations%rowtype;
  v_participant public.participants%rowtype;
  v_relationship_display_name text;
begin
  if v_user_id is null then
    raise exception 'claim_invitation requires an authenticated user';
  end if;
  if p_token_hash is null or length(p_token_hash) <> 64 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_token');
  end if;

  select * into v_invitation
  from public.invitations
  where token_hash = p_token_hash
  for update;

  if v_invitation.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_invitation.participant_id is not null then
    select * into v_participant
    from public.participants
    where id = v_invitation.participant_id
    for update;
  end if;

  -- Idempotent re-claim first (double-tap on the link): if this invitation's
  -- participant is already bound to the caller, succeed quietly regardless of the
  -- invitation's current status.
  if v_participant.user_id is not null and v_participant.user_id = v_user_id then
    update public.invitations
    set status = 'accepted', accepted_at = coalesce(accepted_at, now())
    where id = v_invitation.id and status in ('pending', 'accepted');
    select display_name into v_relationship_display_name from public.relationships where id = v_invitation.relationship_id;
    return jsonb_build_object(
      'ok', true,
      'alreadyClaimed', true,
      'relationshipId', v_invitation.relationship_id,
      'relationshipDisplayName', v_relationship_display_name,
      'participantId', v_participant.id,
      'participantDisplayName', v_participant.display_name
    );
  end if;

  if v_invitation.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v_invitation.status::text);
  end if;
  if v_invitation.expires_at is not null and v_invitation.expires_at <= now() then
    update public.invitations set status = 'expired' where id = v_invitation.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_invitation.participant_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_participant');
  end if;
  if v_participant.user_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'participant_already_claimed');
  end if;
  if exists (
    select 1 from public.relationship_members
    where relationship_id = v_invitation.relationship_id and user_id = v_user_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'already_a_member');
  end if;

  update public.participants
  set user_id = v_user_id, updated_at = now()
  where id = v_participant.id;

  insert into public.relationship_members (relationship_id, user_id, participant_id, role)
  values (v_invitation.relationship_id, v_user_id, v_participant.id, 'member');

  update public.invitations
  set status = 'accepted', accepted_at = now()
  where id = v_invitation.id;

  select display_name into v_relationship_display_name from public.relationships where id = v_invitation.relationship_id;

  return jsonb_build_object(
    'ok', true,
    'relationshipId', v_invitation.relationship_id,
    'relationshipDisplayName', v_relationship_display_name,
    'participantId', v_participant.id,
    'participantDisplayName', v_participant.display_name
  );
end;
$$;
