# Perplexity Remote MCP Pilot

This is the sequential manual test for the hosted Mem·Sum MCP surface.

## Connector Setup

Use Perplexity's custom remote MCP connector form.

- Endpoint: `https://sum.memsum.ai/mcp` (legacy `https://dmsum-hosted-mvp.vercel.app/mcp` still accepted)
- Transport: Streamable HTTP
- Authentication: bearer token
- Token: use the current private Dave connector token (`memsum_...`; legacy `dmsum_...` remains valid). Do not paste it into chat transcripts or docs.

If Perplexity asks for an auth type, choose bearer token or no-OAuth bearer/header auth. Do not use OAuth for this pilot.

## Test 1: Handshake And Instructions

After saving the connector, ask Perplexity:

```text
+sum call get_dmsum_home first, then tell me what relationship contexts are available.
```

Expected behavior:

- It should use the hosted MCP connector.
- It should discover or call `get_dmsum_home`.
- It should mention ordinary Mem·Sum operating guidance in natural language.
- It should not expose bearer tokens, storage mechanics, internal table names, or unnecessary IDs in the participant-facing answer.

## Test 2: Read-Only Retrieval

Ask:

```text
+sum what are Lisa and I tracking right now?
```

Expected behavior:

- It should resolve `@lisa` or otherwise select the Dave-Lisa hosted relationship context.
- It should read `wiki/index.md` and relevant pages.
- It should answer in ordinary participant-facing language.
- It should stay read-only unless the prompt adds new durable material.

## Test 3: Low-Risk Write

Ask:

```text
+sum @lisa connector test: add a note to the Hosted Smoke Test page that Perplexity reached the hosted graph. Keep it on the hosted smoke-test page, not the Sonoma page.
```

Expected behavior:

- It should call `get_dmsum_instructions` with `@lisa` or otherwise resolve `@lisa`.
- It should read the index and the hosted smoke-test page.
- It should call `commit_interaction` with the raw prompt.
- It should call `commit_update_batch` with the smoke-test page write and the expected page version.
- If the page is stale, it should reread the changed path, revise the private draft, and retry instead of overwriting from the stale view.

## Stop Conditions

Stop and report the exact symptom if:

- Perplexity cannot save the connector.
- The connector cannot handshake with the endpoint.
- `tools/list` does not include `get_dmsum_home`.
- The read-only prompt tries to write.
- The write prompt updates a page other than the hosted smoke-test page.
- A stale write error appears and the agent does not reread before retrying.

## Observed Platform Friction

Perplexity may require explicit human approval for each MCP write-capable tool call, including the raw interaction write and the final batch update. This is platform permission UX, not a Mem·Sum kernel failure. It means a realistic write can involve multiple approvals even when the agent is behaving correctly.

For the hosted MVP, treat this as an adapter-surface constraint:

- keep read-only flows useful on their own,
- keep write flows as small and coherent as possible,
- expect some platforms to require manual approval for each write operation,
- do not design the kernel around automatic approval being available everywhere.
