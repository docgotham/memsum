-- OAuth bridge for hosted remote MCP clients such as Claude.
-- Claude receives OAuth access and refresh tokens; private DM Sum connector
-- tokens remain the user-facing pilot credential and are never stored raw.

create table if not exists public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  client_secret_hash text check (client_secret_hash is null or client_secret_hash ~ '^[a-f0-9]{64}$'),
  client_name text not null default 'OAuth client',
  redirect_uris text[] not null,
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  response_types text[] not null default array['code'],
  token_endpoint_auth_method text not null default 'client_secret_post',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (array_length(redirect_uris, 1) is not null)
);

create table if not exists public.oauth_authorization_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  resource text not null,
  scope text,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  expires_at timestamptz not null default now() + interval '5 minutes',
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.oauth_access_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  refresh_token_hash text not null unique check (refresh_token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  resource text not null,
  scope text,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists oauth_authorization_codes_client_id_idx
  on public.oauth_authorization_codes (client_id);

create index if not exists oauth_authorization_codes_user_id_idx
  on public.oauth_authorization_codes (user_id);

create index if not exists oauth_authorization_codes_expires_at_idx
  on public.oauth_authorization_codes (expires_at);

create index if not exists oauth_access_tokens_user_id_idx
  on public.oauth_access_tokens (user_id);

create index if not exists oauth_access_tokens_client_id_idx
  on public.oauth_access_tokens (client_id);

create index if not exists oauth_access_tokens_active_idx
  on public.oauth_access_tokens (token_hash, access_expires_at)
  where revoked_at is null;

alter table public.oauth_clients enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_access_tokens enable row level security;

revoke all on table public.oauth_clients from public, anon, authenticated;
revoke all on table public.oauth_authorization_codes from public, anon, authenticated;
revoke all on table public.oauth_access_tokens from public, anon, authenticated;

grant usage on schema public to service_role;
grant all on table public.oauth_clients to service_role;
grant all on table public.oauth_authorization_codes to service_role;
grant all on table public.oauth_access_tokens to service_role;
