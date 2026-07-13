import { createClient } from "@supabase/supabase-js";
import { hostedRateLimitResponse, hostedRateLimitRules, rateLimitSubjectForToken } from "./ratelimit.js";

// One-click beta invites from the operator's waitlist table. Signup is
// invite-only — the dashboard's magic link refuses to create accounts and the
// claim page binds to a sum invitation — so a waitlisted stranger has no door
// until the operator opens one. This endpoint is that door: it authenticates
// the caller's own dashboard session, refuses everyone the operators table
// does not name (the same require_operator guard as admin_overview), then has
// Supabase Auth send its built-in invite email and stamps the waitlist row.
// The service key stays here in the kernel; the dashboard never holds it.
//
// GoTrue is called over plain REST rather than through supabase-js admin:
// new-style sb_secret_ keys are not JWTs, and GoTrue deployments differ on
// whether they accept one in the Authorization header (PostgREST does). So
// the invite tries with-Bearer first and falls back to apikey-only.

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type"
  };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() }
  });
}

const FALLBACK_DASHBOARD_ORIGIN = "https://memsum.ai";

export function inviteRedirectTarget(env: NodeJS.ProcessEnv = process.env): string {
  const origin = (env.MEMSUM_DASHBOARD_ORIGIN ?? FALLBACK_DASHBOARD_ORIGIN).replace(/\/+$/, "");
  return `${origin}/welcome`;
}

interface GoTrueInviteResult {
  sent: boolean;
  alreadyRegistered: boolean;
  failure?: string;
  actionLink?: string;
}

async function sendGoTrueInvite(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  redirectTo: string,
  fetchFn: typeof fetch,
  delivery: "email" | "link"
): Promise<GoTrueInviteResult> {
  // Email delivery uses GoTrue's invite endpoint (it sends through the
  // configured mailer). Link delivery uses admin/generate_link, which mints
  // the same one-time invite link WITHOUT sending anything — the operator
  // delivers it by hand, matching the product's own invitation doctrine and
  // keeping a mailer outage from blocking the gate.
  const target =
    delivery === "link"
      ? `${supabaseUrl}/auth/v1/admin/generate_link`
      : `${supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`;
  const payload =
    delivery === "link" ? { type: "invite", email, redirect_to: redirectTo } : { email };
  const headerStrategies: Array<Record<string, string>> = [
    { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`, "content-type": "application/json" },
    { apikey: serviceRoleKey, "content-type": "application/json" }
  ];

  let lastFailure = "GoTrue did not respond";
  for (const headers of headerStrategies) {
    let response: Response;
    try {
      response = await fetchFn(target, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (response.ok) {
      if (delivery === "link") {
        const body = (await response.json().catch(() => null)) as
          | {
              action_link?: string;
              hashed_token?: string;
              properties?: { action_link?: string; hashed_token?: string };
            }
          | null;
        // Prefer building our own /welcome?invite=<token_hash> link: the raw
        // GoTrue verify URL is one-time and gets consumed by omnibox
        // prefetchers and email link scanners before the human ever clicks
        // (observed live 2026-07-11). A link to our page is inert until the
        // person presses Accept, which verifies the token client-side.
        const hashedToken = body?.hashed_token ?? body?.properties?.hashed_token;
        if (hashedToken) {
          return {
            sent: true,
            alreadyRegistered: false,
            actionLink: `${redirectTo}?invite=${encodeURIComponent(hashedToken)}`
          };
        }
        const actionLink = body?.action_link ?? body?.properties?.action_link;
        if (!actionLink) return { sent: false, alreadyRegistered: false, failure: "GoTrue returned no link" };
        return { sent: true, alreadyRegistered: false, actionLink };
      }
      return { sent: true, alreadyRegistered: false };
    }

    const body = (await response.json().catch(() => null)) as { msg?: string; message?: string; error_code?: string } | null;
    const message = body?.msg ?? body?.message ?? `GoTrue returned ${response.status}`;
    if (response.status === 422 || body?.error_code === "email_exists" || /already.*(registered|exists)/i.test(message)) {
      return { sent: false, alreadyRegistered: true };
    }
    lastFailure = message;
    // Only an authorization-shaped refusal warrants trying the next header
    // strategy; anything else is a real answer.
    if (!(response.status === 401 || /bearer token/i.test(message))) break;
  }
  return { sent: false, alreadyRegistered: false, failure: lastFailure };
}

export async function handleHostedAdminInviteRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  overrides?: { operatorClient?: any; fetchFn?: typeof fetch }
): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return json(405, { ok: false, error: "Inviting requires POST" });

  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return json(401, { ok: false, error: "Inviting requires your signed-in session" });
  if (token.startsWith("memsum_") || token.startsWith("dmsum_") || token.startsWith("dmsoat_")) {
    return json(400, {
      ok: false,
      error: "Invites go out from the dashboard with your own session, not a connector token"
    });
  }

  const supabaseUrl = (env.SUPABASE_URL ?? "https://stub.supabase.test").replace(/\/+$/, "");
  const anonKey = env.SUPABASE_ANON_KEY ?? "stub-anon-key";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? "stub-service-key";
  if (!overrides && (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY)) {
    return json(500, { ok: false, error: "Hosted Mem·Sum Supabase environment is not configured" });
  }

  const body = (await request.json().catch(() => null)) as { email?: unknown; delivery?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(400, { ok: false, error: "That does not look like an email address." });
  }
  const delivery: "email" | "link" = body?.delivery === "link" ? "link" : "email";

  // The operator gate runs under the caller's own JWT: require_operator
  // raises for everyone the operators table does not name, and for tokens
  // that carry no valid session at all.
  const operatorClient =
    overrides?.operatorClient ??
    createClient<any>(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { authorization: `Bearer ${token}` } }
    });
  const { error: gateError } = await operatorClient.rpc("require_operator");
  if (gateError) return json(403, { ok: false, error: "Mem·Sum operator access required" });

  const limited = await hostedRateLimitResponse(
    request,
    hostedRateLimitRules().adminInvitePerOperator,
    rateLimitSubjectForToken(token),
    "invite",
    env
  );
  if (limited) {
    const headers = new Headers(limited.headers);
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
    return new Response(limited.body, { status: limited.status, headers });
  }

  const fetchFn = overrides?.fetchFn ?? fetch;
  const invite = await sendGoTrueInvite(supabaseUrl, serviceRoleKey, email, inviteRedirectTarget(env), fetchFn, delivery);
  if (!invite.sent && !invite.alreadyRegistered) {
    const verb = delivery === "link" ? "The invite link could not be created" : "The invite email did not go out";
    return json(502, { ok: false, error: `${verb}: ${invite.failure}` });
  }

  // Stamp the waitlist row over PostgREST, best-effort: the invite already
  // went out, so the bookkeeping must not be the failure.
  try {
    const stamp = await fetchFn(`${supabaseUrl}/rest/v1/waitlist?email=eq.${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=minimal"
      },
      body: JSON.stringify({ invited_at: new Date().toISOString() })
    });
    if (!stamp.ok) console.warn(`Mem·Sum waitlist stamp failed: ${stamp.status}`);
  } catch (error) {
    console.warn(`Mem·Sum waitlist stamp failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return json(200, {
    ok: true,
    email,
    alreadyRegistered: invite.alreadyRegistered,
    ...(invite.actionLink ? { actionLink: invite.actionLink } : {})
  });
}
