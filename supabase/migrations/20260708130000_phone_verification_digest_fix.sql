-- Fix a latent bug the §16 live harness caught on its first run: the phone
-- verification functions called bare digest() under `set search_path =
-- public`, but pgcrypto lives in the extensions schema on Supabase, so any
-- real verification attempt failed at runtime ("function digest(text,
-- unknown) does not exist"). The earlier zero-impact check missed it because
-- the invalid-phone path returns before hashing. Both functions are
-- re-created verbatim with extensions.digest, matching how
-- commit_update_batch_for_user already calls it.

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
  values (v_endpoint.id, encode(extensions.digest(v_code, 'sha256'), 'hex'), now() + interval '10 minutes', 0)
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
  if encode(extensions.digest(trim(p_code), 'sha256'), 'hex') <> v_code_row.code_hash then
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
