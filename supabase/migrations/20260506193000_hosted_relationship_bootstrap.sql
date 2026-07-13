-- Authenticated bootstrap for creating a first relationship context.
-- The function creates one relationship, the caller's participant/member row,
-- and an optional peer participant/contact handle in one transaction.

create or replace function public.create_relationship_context(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_relationship_id uuid;
  v_self_participant_id uuid;
  v_peer_participant_id uuid;
  v_relationship_display_name text := nullif(trim(payload ->> 'relationshipDisplayName'), '');
  v_self_display_name text := nullif(trim(payload ->> 'selfDisplayName'), '');
  v_peer_display_name text := nullif(trim(payload ->> 'peerDisplayName'), '');
  v_contact_handle text := nullif(trim(lower(payload ->> 'contactHandle')), '');
  v_contact_display_name text := nullif(trim(payload ->> 'contactDisplayName'), '');
begin
  if v_user_id is null then
    raise exception 'DM Sum create_relationship_context requires an authenticated user';
  end if;

  if v_relationship_display_name is null then
    raise exception 'relationshipDisplayName is required';
  end if;

  if v_self_display_name is null then
    raise exception 'selfDisplayName is required';
  end if;

  if v_peer_display_name is null and v_contact_handle is not null then
    raise exception 'peerDisplayName is required when contactHandle is provided';
  end if;

  if v_contact_handle is not null and v_contact_handle !~ '^@[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'contactHandle must look like @lisa';
  end if;

  insert into public.profiles (id, display_name)
  values (v_user_id, v_self_display_name)
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  insert into public.relationships (created_by, display_name)
  values (v_user_id, v_relationship_display_name)
  returning id into v_relationship_id;

  insert into public.participants (relationship_id, user_id, display_name)
  values (v_relationship_id, v_user_id, v_self_display_name)
  returning id into v_self_participant_id;

  insert into public.relationship_members (relationship_id, user_id, participant_id, role)
  values (v_relationship_id, v_user_id, v_self_participant_id, 'owner');

  if v_peer_display_name is not null then
    insert into public.participants (relationship_id, display_name)
    values (v_relationship_id, v_peer_display_name)
    returning id into v_peer_participant_id;
  end if;

  if v_contact_handle is not null then
    insert into public.contacts (
      owner_user_id,
      handle,
      relationship_id,
      participant_id,
      display_name
    ) values (
      v_user_id,
      v_contact_handle,
      v_relationship_id,
      v_peer_participant_id,
      coalesce(v_contact_display_name, v_peer_display_name)
    );
  end if;

  return jsonb_build_object(
    'relationshipId', v_relationship_id,
    'selfParticipantId', v_self_participant_id,
    'peerParticipantId', v_peer_participant_id,
    'contactHandle', v_contact_handle
  );
end;
$$;

revoke execute on function public.create_relationship_context(jsonb) from public;
grant execute on function public.create_relationship_context(jsonb) to authenticated;
