import { PRODUCT_NAME } from "./product.js";

// Discovery document for MCP clients, served at /.well-known/mcp/server-card.json.
// Every URL derives from the serving origin, so the card is correct on the pilot
// vercel.app host today and on sum.memsum.ai after the domain cutover with no
// configuration change. serverInfo.name must stay in lockstep with the MCP
// initialize response ("memsum-hosted" until the cutover branding pass).
export function buildMcpServerCard(origin: string): Record<string, unknown> {
  return {
    version: "1.0.0",
    protocolVersion: "2024-11-05",
    serverInfo: {
      name: "memsum-hosted",
      version: "0.1.0",
      title: PRODUCT_NAME,
      description:
        "Relationship-scoped shared memory for two to five people, each through their own AI client. Agents read selectively, draft privately, and publish atomic multi-page updates; the server performs no inference.",
      homepage: origin
    },
    transport: {
      type: "streamable-http",
      endpoint: `${origin}/mcp`
    },
    capabilities: {
      tools: true,
      resources: true,
      prompts: false
    },
    authentication: {
      type: "oauth2",
      authorizationEndpoint: `${origin}/oauth/authorize`,
      tokenEndpoint: `${origin}/oauth/token`,
      registrationEndpoint: `${origin}/oauth/register`,
      protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource/mcp`
    }
  };
}
