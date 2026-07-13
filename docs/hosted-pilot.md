# Hosted Pilot Notes

The hosted MVP uses Supabase Auth as the user identity boundary. The real
Dave-Lisa pilot relationship should be created by Dave's authenticated app user,
not by a temporary smoke-test user or an admin-only service role.

## Current Hosted Surfaces

- REST-style hosted operations: `https://sum.memsum.ai/hosted/{operation}`
- Remote MCP Streamable HTTP endpoint: `https://sum.memsum.ai/mcp` (the bare host
  `https://sum.memsum.ai` also serves MCP)
- Alias endpoint: `https://sum.memsum.ai/hosted/mcp`
- Legacy host: `https://dmsum-hosted-mvp.vercel.app` keeps serving all of the above;
  connectors registered against it continue to work.

All hosted write/read operations require:

```text
Authorization: Bearer <SUPABASE_AUTH_ACCESS_TOKEN>
```

The MCP endpoint can initialize and list tools without the token, but tool calls
that touch the graph require the bearer token.

For remote MCP clients that cannot manage Supabase sessions directly, the
private pilot also supports connector tokens:

```text
Authorization: Bearer memsum_...
```

Connector tokens are shown once by the operator CLI. Mem·Sum stores only a
SHA-256 hash, and Vercel resolves the token server-side before applying the
same relationship membership checks as the Supabase Auth path.

## Operator Auth And Smoke Test

The CLI includes a hosted operator path for testing the real remote surface
without exposing tokens in command history.

To request a Supabase magic-link login:

```powershell
$env:DMSUM_SUPABASE_URL = "https://qaylgtityokhmlwzisml.supabase.co"
$env:DMSUM_SUPABASE_ANON_KEY = "<anon key>"
npm run build
node dist/cli.js hosted login-link --email docgotham@gmail.com
```

To run the hosted smoke test with an existing access token:

```powershell
$env:DMSUM_HOSTED_ACCESS_TOKEN = "<Supabase Auth access token or memsum_ connector token>"
node dist/cli.js hosted smoke
```

For operator-only password smoke testing, keep the password in an environment
variable rather than passing it as a shell argument:

```powershell
$env:DMSUM_AUTH_EMAIL = "docgotham@gmail.com"
$env:DMSUM_AUTH_PASSWORD = "<temporary password>"
node dist/cli.js hosted smoke
```

The smoke test resolves or creates the `@lisa` context, writes a technical
`wiki/synthesis/hosted-smoke-test.md` page through `commit_update_batch`, then
submits a deliberately stale second write and confirms the stale batch is
rejected without overwriting the page.

To issue a private-pilot connector token:

```powershell
$env:DMSUM_AUTH_EMAIL = "docgotham@gmail.com"
$env:DMSUM_AUTH_PASSWORD = "<temporary password>"
node dist/cli.js hosted token-issue --name "Perplexity remote MCP" --expires-days 90
```

The command prints the bearer token once. Put that exact `memsum_...` value in
the remote MCP client's authorization field, then clear it from the shell when
you are done. To inspect or revoke connector tokens:

```powershell
node dist/cli.js hosted token-list
node dist/cli.js hosted token-revoke --token-id "<token id>"
```

## Create The Dave-Lisa Pilot Context

Once Dave has an actual Supabase Auth access token for the hosted Mem·Sum app,
call the MCP tool `create_relationship_context` with:

```json
{
  "relationshipDisplayName": "Dave-Lisa",
  "selfDisplayName": "Dave",
  "peerDisplayName": "Lisa",
  "contactHandle": "@lisa",
  "contactDisplayName": "Lisa"
}
```

The result returns the durable IDs needed by participant agents:

```json
{
  "relationshipId": "...",
  "selfParticipantId": "...",
  "peerParticipantId": "...",
  "contactHandle": "@lisa"
}
```

Those IDs should be kept in the user's connector/app configuration or returned
by a later relationship-selection tool. Participant-facing responses should not
show them unless the user asks for technical details.

## Why Not Admin-Seed The Real Pilot?

Smoke tests may create temporary users with admin credentials, but the real pilot
should be owned by Dave's real Supabase Auth user. That keeps Row Level Security,
relationship membership, contacts, future invitations, and future notification
endpoints aligned with the same identity model the production app will use.
