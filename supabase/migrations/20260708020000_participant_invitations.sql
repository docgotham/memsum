-- Owner-delivered invitation links: the Phase 1 kernel core. An invitation binds a
-- placeholder participant to a one-time, expiring, revocable token. The inviter
-- generates the link and delivers it personally; the platform contacts no one.
-- Claiming is one transaction that binds the new user to the placeholder participant,
-- adds relationship membership, and marks the invitation accepted. The participant
-- cap is configuration, not schema: the kernel passes it per call and the RPC
-- enforces it inside the transaction while holding the relationship row lock.

-- Link invitations store only a token hash (never the raw token) and carry no
-- delivery target; the original phone/email target columns become optional so the
-- targeted-delivery path remains available later.
alter table public.invitations add column if not exists token_hash text;
alter table public.invitations add column if not exists revoked_at timestamptz;

create unique index if not exists invitations_token_hash_idx
  on public.invitations (token_hash)
  where token_hash is not null;

create index if not exists invitations_relationship_status_idx
  on public.invitations (relationship_id, status, created_at desc);

alter table public.invitations alter column target_kind drop not null;
alter table public.invitations alter column target_value_normalized drop not null;
alter table public.invitations drop constraint if exists invitations_check;
alter table public.invitations drop constraint if exists invitations_target_shape_check;
alter table public.invitations add constraint invitations_target_shape_check check (
  (target_kind is null and target_value_normalized is null)
  or (target_kind = 'phone' and target_value_normalized ~ '^\+[1-9][0-9]{1,14}$')
  or (target_kind = 'email' and target_value_normalized ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create or replace function public.create_participant_invitation(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_relationship_id uuid := nullif(payload->>'relationshipId', '')::uuid;
  v_participant_id uuid := nullif(payload->>'participantId', '')::uuid;
  v_display_name text := nullif(trim(payload->>'newParticipantDisplayName'), '');
  v_token_hash text := nullif(payload->>'tokenHash', '');
  v_expires_at timestamptz := nullif(payload->>'expiresAt', '')::timestamptz;
  v_cap integer := coalesce(nullif(payload->>'participantCap', '')::integer, 5);
  v_role public.relationship_member_role;
  v_participant_row public.participants%rowtype;
  v_participant_count integer;
  v_invitation_id uuid;
begin
  if v_user_id is null then
    raise exception 'create_participant_invitation requires an authenticated user';
  end if;
  if v_relationship_id is null then
    raise exception 'create_participant_invitation requires relationshipId';
  end if;
  if v_token_hash is null or length(v_token_hash) <> 64 then
    raise exception 'create_participant_invitation requires a sha256 tokenHash';
  end if;
  if (v_participant_id is null) = (v_display_name is null) then
    raise exception 'Provide exactly one of participantId or newParticipantDisplayName';
  end if;

  select role into v_role
  from public.relationship_members
  where relationship_id = v_relationship_id and user_id = v_user_id;

  if v_role is null then
    raise exception 'Only relationship members may create invitations';
  end if;
  if v_role <> 'owner' then
    return jsonb_build_object('ok', false, 'reason', 'owner_only');
  end if;

  -- Serialize cap checks and placeholder creation per relationship.
  perform 1 from public.relationships where id = v_relationship_id for update;

  if v_participant_id is null then
    select count(*) into v_participant_count
    from public.participants
    where relationship_id = v_relationship_id;

    if v_participant_count >= v_cap then
      return jsonb_build_object('ok', false, 'reason', 'participant_cap', 'cap', v_cap);
    end if;

    insert into public.participants (relationship_id, display_name)
    values (v_relationship_id, v_display_name)
    returning * into v_participant_row;
  else
    select * into v_participant_row
    from public.participants
    where id = v_participant_id and relationship_id = v_relationship_id;

    if v_participant_row.id is null then
      raise exception 'participantId must belong to the relationship';
    end if;
    if v_participant_row.user_id is not null then
      return jsonb_build_object('ok', false, 'reason', 'participant_already_claimed');
    end if;
  end if;

  -- One pending invitation per participant: a new link supersedes the old one.
  update public.invitations
  set status = 'revoked', revoked_at = now()
  where relationship_id = v_relationship_id
    and participant_id = v_participant_row.id
    and status = 'pending';

  insert into public.invitations (relationship_id, invited_by_user_id, participant_id, status, token_hash, expires_at)
  values (v_relationship_id, v_user_id, v_participant_row.id, 'pending', v_token_hash, v_expires_at)
  returning id into v_invitation_id;

  return jsonb_build_object(
    'ok', true,
    'invitationId', v_invitation_id,
    'participantId', v_participant_row.id,
    'participantDisplayName', v_participant_row.display_name,
    'expiresAt', v_expires_at
  );
end;
$$;

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

  select * into v_participant
  from public.participants
  where id = v_invitation.participant_id
  for update;

  -- Idempotent re-claim by the same user (double-tap on the link).
  if v_participant.user_id = v_user_id then
    update public.invitations
    set status = 'accepted', accepted_at = coalesce(accepted_at, now())
    where id = v_invitation.id;
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

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invitation public.invitations%rowtype;
  v_role public.relationship_member_role;
begin
  if v_user_id is null then
    raise exception 'revoke_invitation requires an authenticated user';
  end if;

  select * into v_invitation from public.invitations where id = p_invitation_id for update;
  if v_invitation.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select role into v_role
  from public.relationship_members
  where relationship_id = v_invitation.relationship_id and user_id = v_user_id;

  if v_role is null or v_role <> 'owner' then
    return jsonb_build_object('ok', false, 'reason', 'owner_only');
  end if;
  if v_invitation.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v_invitation.status::text);
  end if;

  update public.invitations
  set status = 'revoked', revoked_at = now()
  where id = v_invitation.id;

  return jsonb_build_object('ok', true, 'revoked', true, 'invitationId', v_invitation.id);
end;
$$;

create or replace function public.list_invitations(p_relationship_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'invitationId', i.id,
        'participantId', i.participant_id,
        'participantDisplayName', p.display_name,
        'status', i.status::text,
        'createdAt', i.created_at,
        'expiresAt', i.expires_at,
        'acceptedAt', i.accepted_at,
        'revokedAt', i.revoked_at
      )
      order by i.created_at desc
    ),
    '[]'::jsonb
  )
  from public.invitations i
  left join public.participants p on p.id = i.participant_id
  where i.relationship_id = p_relationship_id
    and public.is_relationship_member(p_relationship_id);
$$;

revoke all on function public.create_participant_invitation(jsonb) from public, anon;
revoke all on function public.claim_invitation(text) from public, anon;
revoke all on function public.revoke_invitation(uuid) from public, anon;
revoke all on function public.list_invitations(uuid) from public, anon;

grant execute on function public.create_participant_invitation(jsonb) to authenticated;
grant execute on function public.claim_invitation(text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.list_invitations(uuid) to authenticated;

grant execute on function public.create_participant_invitation(jsonb) to service_role;
grant execute on function public.claim_invitation(text) to service_role;
grant execute on function public.revoke_invitation(uuid) to service_role;
grant execute on function public.list_invitations(uuid) to service_role;
