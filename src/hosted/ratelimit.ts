import { createHash } from "node:crypto";

// Fixed-window rate limiting in front of the MCP and OAuth surfaces. Counters
// live in Postgres (public.check_rate_limit, service-role only) so limits hold
// across serverless instances. Every rejection is structured and legible — an
// agent or a person always learns the reason and exactly when to retry. The
// limiter fails open: if the counter is unreachable or the environment is not
// configured, requests pass, because rate limiting must never be the outage.

export interface RateLimitRule {
  name: string;
  maxHits: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchFn?: typeof fetch;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function hostedRateLimitRules() {
  return {
    // A runaway agent loop, not a chatty conversation, is the target.
    mcpPerCredential: {
      name: "mcp",
      maxHits: envInt("MEMSUM_RATE_MCP_PER_MINUTE", 120),
      windowSeconds: 60
    },
    // Credential stuffing and token guessing on the consent form.
    oauthAuthorizePerIp: {
      name: "oauth-authorize",
      maxHits: envInt("MEMSUM_RATE_OAUTH_AUTHORIZE_PER_10_MINUTES", 20),
      windowSeconds: 600
    },
    // Code/refresh exchange churn.
    oauthTokenPerIp: {
      name: "oauth-token",
      maxHits: envInt("MEMSUM_RATE_OAUTH_TOKEN_PER_10_MINUTES", 60),
      windowSeconds: 600
    },
    // Unauthenticated client registration writes rows.
    oauthRegisterPerIp: {
      name: "oauth-register",
      maxHits: envInt("MEMSUM_RATE_OAUTH_REGISTER_PER_10_MINUTES", 10),
      windowSeconds: 600
    },
    // Bundle exports read whole graphs and zip them.
    exportPerCredential: {
      name: "export",
      maxHits: envInt("MEMSUM_RATE_EXPORTS_PER_HOUR", 6),
      windowSeconds: 3600
    },
    // Operator beta invites send email; keep a runaway script from draining
    // the auth mailer.
    adminInvitePerOperator: {
      name: "admin-invite",
      maxHits: envInt("MEMSUM_RATE_ADMIN_INVITES_PER_HOUR", 20),
      windowSeconds: 3600
    }
  } satisfies Record<string, RateLimitRule>;
}

// First hop of x-forwarded-for is the client on Vercel; requests that carry
// neither header (local dev, tests) share one bucket rather than skipping.
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  return real || "unknown";
}

// Credentials are keyed by hash prefix so the counter table never stores a
// usable bearer token and needs no per-request user lookup.
export function rateLimitSubjectForToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

export async function checkHostedRateLimit(
  env: RateLimitEnv,
  rule: RateLimitRule,
  subject: string
): Promise<RateLimitDecision> {
  const fetchFn = env.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${env.supabaseUrl}/rest/v1/rpc/check_rate_limit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.serviceRoleKey,
        authorization: `Bearer ${env.serviceRoleKey}`
      },
      body: JSON.stringify({
        p_key: `${rule.name}:${subject}`,
        p_max_hits: rule.maxHits,
        p_window_seconds: rule.windowSeconds
      })
    });
    if (!response.ok) {
      console.warn(`Mem·Sum rate limit check failed (${response.status}); allowing request`);
      return { allowed: true, remaining: rule.maxHits, retryAfterSeconds: 0 };
    }
    const payload = (await response.json().catch(() => null)) as {
      allowed?: unknown;
      remaining?: unknown;
      retryAfterSeconds?: unknown;
    } | null;
    if (!payload || typeof payload.allowed !== "boolean") {
      console.warn("Mem·Sum rate limit check returned an unexpected payload; allowing request");
      return { allowed: true, remaining: rule.maxHits, retryAfterSeconds: 0 };
    }
    return {
      allowed: payload.allowed,
      remaining: typeof payload.remaining === "number" ? payload.remaining : 0,
      retryAfterSeconds: typeof payload.retryAfterSeconds === "number" ? payload.retryAfterSeconds : 0
    };
  } catch (error) {
    console.warn(`Mem·Sum rate limit check failed (${error instanceof Error ? error.message : "error"}); allowing request`);
    return { allowed: true, remaining: rule.maxHits, retryAfterSeconds: 0 };
  }
}

export function rateLimitedResponse(decision: RateLimitDecision, surface: string): Response {
  const retryAfter = Math.max(1, decision.retryAfterSeconds);
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      error_description: `Too many ${surface} requests. Retry in ${retryAfter} seconds.`,
      retryAfterSeconds: retryAfter
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter)
      }
    }
  );
}

// Convenience wrapper for request handlers: null means proceed. Fails open
// when the Supabase env is absent (local dev, unit tests).
export async function hostedRateLimitResponse(
  request: Request,
  rule: RateLimitRule,
  subject: string,
  surface: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Response | null> {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;

  const decision = await checkHostedRateLimit({ supabaseUrl, serviceRoleKey }, rule, subject);
  if (decision.allowed) return null;
  return rateLimitedResponse(decision, surface);
}
