-- Connected apps: member-facing visibility and revocation over the OAuth
-- grant store. The oauth_* tables stay service-role-only; these two
-- security-definer functions are the only authenticated window, each scoped
-- to auth.uid(). A dynamically registered client's name is self-asserted, so
-- the registered redirect URIs travel with every grant — the dashboard
-- anchors identity on the redirect host, not the name alone.

create or replace function public.list_oauth_grants()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'clientId', g.client_id,
        'clientName', g.client_name,
        'redirectUris', to_jsonb(g.redirect_uris),
        'scope', g.scope,
        'authorizedAt', g.authorized_at,
        'lastUsedAt', g.last_used_at,
        'activeTokens', g.active_tokens
      )
      order by g.authorized_at desc
    ),
    '[]'::jsonb
  )
  from (
    select
      t.client_id,
      c.client_name,
      c.redirect_uris,
      string_agg(distinct coalesce(t.scope, 'mcp'), ' ') as scope,
      min(t.created_at) as authorized_at,
      max(t.last_used_at) as last_used_at,
      count(*)::integer as active_tokens
    from public.oauth_access_tokens t
    join public.oauth_clients c on c.client_id = t.client_id
    where t.user_id = auth.uid()
      and t.revoked_at is null
      -- "Can still act" predicate. Assumes refresh_expires_at always outlives
      -- access_expires_at (both are written together by the kernel: 30 days
      -- vs 1 hour), so nothing capable of acting is ever hidden from the list.
      and t.refresh_expires_at > now()
    group by t.client_id, c.client_name, c.redirect_uris
  ) g;
$$;

create or replace function public.revoke_oauth_client_grants(target_client_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tokens integer;
  v_codes integer;
begin
  if v_user_id is null then
    raise exception 'Mem·Sum revoke_oauth_client_grants requires an authenticated user';
  end if;

  if target_client_id is null or length(trim(target_client_id)) = 0 then
    raise exception 'Mem·Sum revoke_oauth_client_grants requires a client id';
  end if;

  -- Every unrevoked token for this member and client dies, expired rows
  -- included — no zombie-unrevoked rows survive a revocation.
  update public.oauth_access_tokens
  set revoked_at = now()
  where user_id = v_user_id
    and client_id = target_client_id
    and revoked_at is null;
  get diagnostics v_tokens = row_count;

  -- Close the in-flight window: an authorization code minted before this
  -- revoke could otherwise still be exchanged for fresh tokens after it.
  update public.oauth_authorization_codes
  set consumed_at = now()
  where user_id = v_user_id
    and client_id = target_client_id
    and consumed_at is null;
  get diagnostics v_codes = row_count;

  return jsonb_build_object(
    'revoked', v_tokens > 0,
    'revokedTokens', v_tokens,
    'closedCodes', v_codes
  );
end;
$$;

revoke execute on function public.list_oauth_grants() from public;
revoke execute on function public.revoke_oauth_client_grants(text) from public;

grant execute on function public.list_oauth_grants() to authenticated;
grant execute on function public.revoke_oauth_client_grants(text) to authenticated;
grant execute on function public.list_oauth_grants() to service_role;
grant execute on function public.revoke_oauth_client_grants(text) to service_role;
