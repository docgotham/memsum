-- Self-serve phone verification and per-sum SMS opt-in. Codes are generated
-- server-side in SQL, stored only as sha256 hashes in a service-only table, and
-- delivered through the existing notification-jobs pipeline (new 'verification'
-- source kind), so the browser never sees a code and no new secret surface or
-- HTTP endpoint exists. Delivery of real notifications continues to require
-- enabled = true AND verified_at is not null, exactly as the triggers already
-- enforce. Endpoints are participant-scoped, so opt-in is naturally per sum.

alter type public.notification_job_source_kind add value if not exists 'verification';

create table if not exists public.phone_verification_codes (
  id uuid primary key default gen_random_uuid(),
  notification_endpoint_id uuid not null references public.notification_endpoints(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  unique (notification_endpoint_id)
);

alter table public.phone_verification_codes enable row level security;
revoke all on table public.phone_verification_codes from public, anon, authenticated;
grant all on table public.phone_verification_codes to service_role;

-- Caller must be the authenticated user bound to the participant.
create or replace function public.require_own_participant(p_participant_id uuid)
returns public.participants
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_participant public.participants%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authenticated user required';
  end if;
  select * into v_participant from public.participants where id = p_participant_id;
  if v_participant.id is null or v_participant.user_id is distinct from auth.uid() then
    raise exception 'participant is not bound to the authenticated user';
  end if;
  return v_participant;
end;
$$;

create or replace function public.get_notification_settings(p_participant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_participant public.participants%rowtype;
  v_endpoint public.notification_endpoints%rowtype;
begin
  v_participant := public.require_own_participant(p_participant_id);

  select * into v_endpoint
  from public.notification_endpoints
  where participant_id = p_participant_id and kind = 'sms'
  order by created_at desc
  limit 1;

  if v_endpoint.id is null then
    return jsonb_build_object('ok', true, 'endpoint', null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'endpoint', jsonb_build_object(
      'phone', v_endpoint.value_normalized,
      'verified', v_endpoint.verified_at is not null,
      'enabled', v_endpoint.enabled
    )
  );
end;
$$;

create or replace function public.start_phone_verification(p_participant_id uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant public.participants%rowtype;
  v_endpoint public.notification_endpoints%rowtype;
  v_phone text := trim(p_phone);
  v_code text;
  v_recent timestamptz;
begin
  v_participant := public.require_own_participant(p_participant_id);

  if v_phone !~ '^\+[1-9][0-9]{1,14}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  select * into v_endpoint
  from public.notification_endpoints
  where participant_id = p_participant_id and kind = 'sms'
  order by created_at desc
  limit 1
  for update;

  if v_endpoint.id is null then
    insert into public.notification_endpoints (user_id, participant_id, relationship_id, kind, value_normalized, enabled)
    values (auth.uid(), p_participant_id, v_participant.relationship_id, 'sms', v_phone, true)
    returning * into v_endpoint;
  else
    if v_endpoint.value_normalized = v_phone and v_endpoint.verified_at is not null then
      return jsonb_build_object('ok', false, 'reason', 'already_verified');
    end if;
    update public.notification_endpoints
    set value_normalized = v_phone, verified_at = null, user_id = auth.uid()
    where id = v_endpoint.id
    returning * into v_endpoint;
  end if;

  select created_at into v_recent
  from public.phone_verification_codes
  where notification_endpoint_id = v_endpoint.id;

  if v_recent is not null and v_recent > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;

  v_code := lpad(floor(random() * 1000000)::text, 6, '0');

  insert into public.phone_verification_codes (notification_endpoint_id, code_hash, expires_at, attempt_count)
  values (v_endpoint.id, encode(digest(v_code, 'sha256'), 'hex'), now() + interval '10 minutes', 0)
  on conflict (notification_endpoint_id) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempt_count = 0,
        created_at = now();

  insert into public.notification_jobs (
    relationship_id,
    recipient_participant_id,
    notification_endpoint_id,
    target_value_normalized,
    source_kind,
    source_id,
    body,
    send_after,
    dedupe_key
  ) values (
    v_participant.relationship_id,
    p_participant_id,
    v_endpoint.id,
    v_phone,
    'verification'::public.notification_job_source_kind,
    v_endpoint.id,
    'Your Mem-Sum verification code is ' || v_code || '. It expires in 10 minutes.',
    now(),
    'verification:' || v_endpoint.id::text || ':' || gen_random_uuid()::text
  );

  return jsonb_build_object('ok', true, 'phone', v_phone);
end;
$$;

create or replace function public.confirm_phone_verification(p_participant_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant public.participants%rowtype;
  v_endpoint public.notification_endpoints%rowtype;
  v_code_row public.phone_verification_codes%rowtype;
begin
  v_participant := public.require_own_participant(p_participant_id);

  select * into v_endpoint
  from public.notification_endpoints
  where participant_id = p_participant_id and kind = 'sms'
  order by created_at desc
  limit 1
  for update;

  if v_endpoint.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_endpoint');
  end if;

  select * into v_code_row
  from public.phone_verification_codes
  where notification_endpoint_id = v_endpoint.id
  for update;

  if v_code_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_pending_code');
  end if;
  if v_code_row.expires_at <= now() then
    delete from public.phone_verification_codes where id = v_code_row.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_code_row.attempt_count >= 5 then
    delete from public.phone_verification_codes where id = v_code_row.id;
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;
  if encode(digest(trim(p_code), 'sha256'), 'hex') <> v_code_row.code_hash then
    update public.phone_verification_codes set attempt_count = attempt_count + 1 where id = v_code_row.id;
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  update public.notification_endpoints
  set verified_at = now(), enabled = true
  where id = v_endpoint.id;

  delete from public.phone_verification_codes where id = v_code_row.id;

  return jsonb_build_object('ok', true, 'phone', v_endpoint.value_normalized);
end;
$$;

create or replace function public.set_notification_enabled(p_participant_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant public.participants%rowtype;
  v_endpoint public.notification_endpoints%rowtype;
begin
  v_participant := public.require_own_participant(p_participant_id);

  select * into v_endpoint
  from public.notification_endpoints
  where participant_id = p_participant_id and kind = 'sms'
  order by created_at desc
  limit 1
  for update;

  if v_endpoint.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_endpoint');
  end if;

  update public.notification_endpoints set enabled = p_enabled where id = v_endpoint.id;

  return jsonb_build_object('ok', true, 'enabled', p_enabled);
end;
$$;

revoke all on function public.require_own_participant(uuid) from public, anon;
revoke all on function public.get_notification_settings(uuid) from public, anon;
revoke all on function public.start_phone_verification(uuid, text) from public, anon;
revoke all on function public.confirm_phone_verification(uuid, text) from public, anon;
revoke all on function public.set_notification_enabled(uuid, boolean) from public, anon;

grant execute on function public.get_notification_settings(uuid) to authenticated;
grant execute on function public.start_phone_verification(uuid, text) to authenticated;
grant execute on function public.confirm_phone_verification(uuid, text) to authenticated;
grant execute on function public.set_notification_enabled(uuid, boolean) to authenticated;

grant execute on function public.get_notification_settings(uuid) to service_role;
grant execute on function public.start_phone_verification(uuid, text) to service_role;
grant execute on function public.confirm_phone_verification(uuid, text) to service_role;
grant execute on function public.set_notification_enabled(uuid, boolean) to service_role;
