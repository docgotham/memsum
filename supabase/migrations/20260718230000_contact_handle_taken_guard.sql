-- A duplicate @handle at sum creation deserves a relayable answer, not a
-- raw unique-violation 500. Contacts are unique per (owner, handle) by
-- design — an @handle names a person in the owner's address book, and the
-- person, not the handle, is what spans sums (resolve_contact enumerates
-- the person's sums by linked account). So the right guidance when a
-- handle is taken: leave contactHandle off and the existing contact keeps
-- naming that person everywhere you share a sum, or pick a different
-- handle for a different person.
--
-- Both create functions are recreated with the contact insert wrapped in a
-- unique_violation handler that raises the written-to-be-relayed message
-- (P0001 surfaces as a 400 with verbatim text). Nothing else changes:
-- bodies, arguments, grants, and auth preambles are otherwise identical to
-- the previous definitions.

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
    begin
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
    exception when unique_violation then
      raise exception 'Mem·Sum contact handle % is already in your address book. Leave contactHandle off to keep using it for that person, or pick a different handle for a different person.', v_contact_handle;
    end;
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

create or replace function public.create_relationship_context_for_user(payload jsonb, target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := target_user_id;
  v_relationship_id uuid;
  v_self_participant_id uuid;
  v_peer_participant_id uuid;
  v_relationship_display_name text := nullif(trim(payload ->> 'relationshipDisplayName'), '');
  v_self_display_name text := nullif(trim(payload ->> 'selfDisplayName'), '');
  v_peer_display_name text := nullif(trim(payload ->> 'peerDisplayName'), '');
  v_contact_handle text := nullif(trim(lower(payload ->> 'contactHandle')), '');
  v_contact_display_name text := nullif(trim(payload ->> 'contactDisplayName'), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'DM Sum create_relationship_context_for_user is service-role only';
  end if;

  if v_user_id is null then
    raise exception 'target_user_id is required';
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
    begin
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
    exception when unique_violation then
      raise exception 'Mem·Sum contact handle % is already in your address book. Leave contactHandle off to keep using it for that person, or pick a different handle for a different person.', v_contact_handle;
    end;
  end if;

  return jsonb_build_object(
    'relationshipId', v_relationship_id,
    'selfParticipantId', v_self_participant_id,
    'peerParticipantId', v_peer_participant_id,
    'contactHandle', v_contact_handle
  );
end;
$$;
