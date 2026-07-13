# Claude Remote MCP OAuth Pilot

Mem·Sum hosted MCP supports Claude custom connectors through OAuth 2.0 with Dynamic Client Registration.

## Connector Setup

In Claude Web:

1. Open **Settings** -> **Connectors** -> **Add custom connector**.
2. Name: `Mem·Sum Hosted Pilot (Dave)`.
3. Remote MCP server URL: `https://sum.memsum.ai/mcp` (legacy `https://dmsum-hosted-mvp.vercel.app/mcp` still accepted).
4. Leave OAuth Client ID and OAuth Client Secret blank.
5. Add the connector, then click **Connect**.
6. On the Mem·Sum authorization page, paste the private `memsum_...` connector token (legacy `dmsum_...` tokens remain valid) for the participant identity you want Claude to use.

Claude receives OAuth access and refresh tokens. The private Mem·Sum connector token is used only on the authorization page and is never stored raw.

## First Test

Enable the connector in a Claude conversation, then ask:

```text
+sum what are Lisa and I tracking right now?
```

For a write test, use an ordinary low-risk prompt after the read succeeds:

```text
+sum add a note that Dave's Claude connector successfully wrote to the hosted Mem·Sum graph.
```

## Notes

- Claude custom connectors are reached from Anthropic's cloud, so the MCP URL must be public HTTPS.
- The OAuth access token expires after one hour; the refresh token expires after thirty days.
- Perplexity's bearer-token connector path remains supported separately.
