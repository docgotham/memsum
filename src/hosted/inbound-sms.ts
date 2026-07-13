import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// STOP/START reflection. Twilio's mandatory toll-free opt-out handling already
// blocks delivery and sends the compliance replies at the carrier layer; this
// endpoint exists so our notification_endpoints mirror that truth and agents,
// settings pages, and activity views never claim a deliverable state that
// isn't. Carrier opt-out is global per phone number, so a STOP flips every
// endpoint bearing that number across all sums and participants — per-sum
// muting is the dashboard toggle, not STOP. The handler mutates state only
// after validating X-Twilio-Signature, and fails closed when the auth token
// is not configured.

export type InboundSmsAction = "stop" | "start";

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);

// Exact-message match, like Twilio's own opt-out handling: "stop it please"
// is conversation, not an opt-out.
export function classifyInboundSmsKeyword(body: string): InboundSmsAction | null {
  const normalized = body.trim().toUpperCase();
  if (STOP_KEYWORDS.has(normalized)) return "stop";
  if (START_KEYWORDS.has(normalized)) return "start";
  return null;
}

export function twilioRequestSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((key) => key + params[key]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function isValidTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioRequestSignature(authToken, url, params), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// Twilio signs the URL it posted to; behind Vercel the function must
// reconstruct that external URL from forwarded headers.
export function inboundRequestUrl(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

interface InboundSmsSupabaseClient {
  from(table: string): any;
}

export async function applyInboundSmsKeyword(input: {
  supabase: InboundSmsSupabaseClient;
  phone: string;
  action: InboundSmsAction;
}): Promise<{ updatedEndpoints: number }> {
  const { data, error } = await input.supabase
    .from("notification_endpoints")
    .update({ enabled: input.action === "start" })
    .eq("kind", "sms")
    .eq("value_normalized", input.phone)
    .select("id");
  if (error) throw new Error(`Mem·Sum inbound opt-${input.action} update failed: ${error.message}`);
  return { updatedEndpoints: Array.isArray(data) ? data.length : 0 };
}

function twimlNoReply(): Response {
  // Twilio's own opt-out handling composes the compliance reply; an empty
  // TwiML document tells it we have nothing to add.
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    status: 200,
    headers: { "content-type": "text/xml" }
  });
}

export async function handleTwilioInboundSmsRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  supabaseOverride?: InboundSmsSupabaseClient
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Twilio inbound webhook requires POST" }), {
      status: 405,
      headers: { "content-type": "application/json" }
    });
  }

  const authToken = env.TWILIO_AUTH_TOKEN;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!authToken || (!supabaseOverride && (!supabaseUrl || !serviceRoleKey))) {
    return new Response(JSON.stringify({ ok: false, error: "Twilio inbound webhook is not configured" }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  }

  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  const url = inboundRequestUrl(request);
  if (!isValidTwilioSignature(authToken, url, params, request.headers.get("x-twilio-signature"))) {
    return new Response(JSON.stringify({ ok: false, error: "Twilio signature validation failed" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }

  const phone = params.From ?? "";
  const action = classifyInboundSmsKeyword(params.Body ?? "");
  if (!phone || !action) return twimlNoReply();

  const supabase =
    supabaseOverride ??
    createClient<any>(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { headers: { authorization: `Bearer ${serviceRoleKey}` } }
    });

  const result = await applyInboundSmsKeyword({ supabase, phone, action });
  console.log(`Mem·Sum inbound ${action.toUpperCase()} from ${phone}: ${result.updatedEndpoints} endpoint(s) updated`);
  return twimlNoReply();
}
