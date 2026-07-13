// Central product configuration for the hosted kernel. The product is Mem·Sum
// (memsum.ai); DM Sum remains the legacy dyadic instance and the compatibility
// name in existing tool/instruction surfaces until the domain cutover. Participant
// cap is configuration, not schema: raising it later must never require a migration.

export const PRODUCT_NAME = "Mem·Sum";
export const LEGACY_PRODUCT_NAME = "DM Sum";

export const DEFAULT_PARTICIPANT_CAP = 5;
const MIN_PARTICIPANT_CAP = 2;

export interface ProductEnv {
  MEMSUM_PARTICIPANT_CAP?: string;
  MEMSUM_SITE_URL?: string;
  MEMSUM_MCP_URL?: string;
}

export function participantCap(env: ProductEnv = process.env as ProductEnv): number {
  const raw = env.MEMSUM_PARTICIPANT_CAP?.trim();
  if (!raw) return DEFAULT_PARTICIPANT_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PARTICIPANT_CAP;
  return Math.max(MIN_PARTICIPANT_CAP, parsed);
}

export interface ProductHosts {
  siteUrl: string;
  mcpUrl: string;
}

export function productHosts(env: ProductEnv = process.env as ProductEnv): ProductHosts {
  return {
    siteUrl: normalizeBaseUrl(env.MEMSUM_SITE_URL) ?? "https://memsum.ai",
    mcpUrl: normalizeBaseUrl(env.MEMSUM_MCP_URL) ?? "https://sum.memsum.ai"
  };
}

function normalizeBaseUrl(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}
