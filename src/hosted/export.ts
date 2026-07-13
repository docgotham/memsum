import { strToU8, zipSync } from "fflate";
import { createClient } from "@supabase/supabase-js";
import { buildOkfBundleFromData, fetchOkfExportData, type OkfProfile } from "./okf.js";
import { hostedRateLimitResponse, hostedRateLimitRules, rateLimitSubjectForToken } from "./ratelimit.js";

// The dashboard's "Export your data" button (interchange profile §6: the
// downloadable archive is transport 3 with a human on the receiving end — a
// dashboard feature, not an MCP tool). The member's own Supabase JWT is the
// only authorization: the same RLS that scopes their reads scopes the export,
// so the endpoint holds no judgment and no extra privileges. Each export
// writes an audit row under that same identity, best-effort — the audit must
// not be the outage, mirroring the rejected-batch audit.

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-expose-headers": "content-disposition"
  };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() }
  });
}

function filenameSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "sum";
}

export async function handleHostedExportRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  clientOverride?: any
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return jsonError(405, "Export requires POST");

  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return jsonError(401, "Export requires your signed-in session");
  if (token.startsWith("memsum_") || token.startsWith("dmsum_") || token.startsWith("dmsoat_")) {
    return jsonError(400, "Export runs from the dashboard with your own session, not a connector token");
  }

  const supabaseUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!clientOverride && (!supabaseUrl || !anonKey)) {
    return jsonError(500, "Hosted Mem·Sum Supabase environment is not configured");
  }

  const limited = await hostedRateLimitResponse(
    request,
    hostedRateLimitRules().exportPerCredential,
    rateLimitSubjectForToken(token),
    "export",
    env
  );
  if (limited) {
    const headers = new Headers(limited.headers);
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
    return new Response(limited.body, { status: limited.status, headers });
  }

  const body = (await request.json().catch(() => null)) as { relationshipId?: unknown; profile?: unknown } | null;
  const relationshipId = typeof body?.relationshipId === "string" ? body.relationshipId : null;
  const profile: OkfProfile = body?.profile === "archive" ? "archive" : "share";
  if (!relationshipId) return jsonError(400, "relationshipId is required");

  const client =
    clientOverride ??
    createClient<any>(supabaseUrl!, anonKey!, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { authorization: `Bearer ${token}` } }
    });

  let bundle;
  try {
    const data = await fetchOkfExportData(client, { relationshipId, profile });
    bundle = buildOkfBundleFromData(data, { profile });
  } catch (error) {
    return jsonError(404, error instanceof Error ? error.message : "Export failed");
  }

  const { error: auditError } = await client.from("export_audits").insert({
    relationship_id: relationshipId,
    user_id: (await client.auth.getUser(token)).data.user?.id ?? null,
    profile,
    page_count: bundle.files.filter((file) => file.path.startsWith("wiki/")).length
  });
  if (auditError) console.warn(`Mem·Sum export audit write failed: ${auditError.message}`);

  const zipInput: Record<string, Uint8Array> = {};
  for (const file of bundle.files) zipInput[file.path] = strToU8(file.content);
  const zipped = zipSync(zipInput);

  const filename = `memsum-${filenameSlug(bundle.relationshipDisplayName)}-${profile}-${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(new Uint8Array(zipped), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      ...corsHeaders()
    }
  });
}
