-- Owner-only sum rename. Names are shared canonical labels, never identity:
-- membership, invitations, and agents bind to the relationship ID, so a rename
-- changes presentation everywhere (including the group-sum SMS envelope) without
-- touching any binding. Non-members get not_found rather than owner_only so the
-- RPC does not reveal whether a relationship exists.

create or replace function public.rename_relationship(p_relationship_id uuid, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_role public.relationship_member_role;
  v_name text := nullif(trim(p_display_name), '');
begin
  if v_user_id is null then
    raise exception 'rename_relationship requires an authenticated user';
  end if;
  if v_name is null or length(v_name) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;

  select role into v_role
  from public.relationship_members
  where relationship_id = p_relationship_id and user_id = v_user_id;

  if v_role is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_role <> 'owner' then
    return jsonb_build_object('ok', false, 'reason', 'owner_only');
  end if;

  update public.relationships
  set display_name = v_name, updated_at = now()
  where id = p_relationship_id;

  return jsonb_build_object('ok', true, 'relationshipId', p_relationship_id, 'displayName', v_name);
end;
$$;

revoke all on function public.rename_relationship(uuid, text) from public, anon;
grant execute on function public.rename_relationship(uuid, text) to authenticated;
grant execute on function public.rename_relationship(uuid, text) to service_role;
