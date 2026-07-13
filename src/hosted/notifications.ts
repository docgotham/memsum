import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type NotificationSupabaseClient = SupabaseClient<any>;

export interface NotificationWorkerEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
  DMSUM_TWILIO_STATUS_CALLBACK_URL?: string;
  DMSUM_NOTIFICATION_WORKER_SECRET?: string;
  CRON_SECRET?: string;
  DMSUM_NOTIFICATION_BATCH_SIZE?: string;
  DMSUM_IMMEDIATE_NOTIFICATION_BATCH_SIZE?: string;
  DMSUM_NOTIFICATION_MAX_ATTEMPTS?: string;
  DMSUM_NOTIFICATION_DRY_RUN?: string;
  DMSUM_NOTIFICATION_ALLOW_TEST_SEND?: string;
  NODE_ENV?: string;
}

interface ClaimedNotificationJob {
  id: string;
  relationship_id: string;
  recipient_participant_id: string;
  target_value_normalized: string;
  source_kind: "interaction" | "update" | "reminder";
  source_id: string;
  body: string;
  attempt_count: number;
}

interface TwilioSendResult {
  sid: string;
  status: string;
}

export interface WorkerResult {
  ok: boolean;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  dryRun: boolean;
}

export type ImmediateNotificationDispatchResult =
  | {
      ok: true;
      skipped: false;
      worker: WorkerResult;
    }
  | {
      ok: true;
      skipped: true;
      reason: string;
    }
  | {
      ok: false;
      skipped: false;
      error: string;
    };

export async function handleNotificationWorkerRequest(
  request: Request,
  env: NotificationWorkerEnv = process.env,
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Notification worker requires GET or POST" }, 405);
  }

  const authError = validateWorkerAuth(request, env);
  if (authError) return authError;

  const config = readWorkerConfig(env);
  if ("error" in config) return jsonResponse({ ok: false, error: config.error }, 500);

  const supabase = notificationWorkerClient(config.supabaseUrl, config.serviceRoleKey);

  const result = await processDueNotificationJobs({
    supabase,
    fetchFn,
    batchSize: config.batchSize,
    maxAttempts: config.maxAttempts,
    twilio: config.twilio,
    dryRun: config.dryRun
  });

  return jsonResponse(result);
}

export async function tryProcessImmediateNotificationJobs(
  env: NotificationWorkerEnv = process.env,
  fetchFn: typeof fetch = fetch
): Promise<ImmediateNotificationDispatchResult> {
  if (env.NODE_ENV === "test" && env.DMSUM_NOTIFICATION_ALLOW_TEST_SEND !== "1") {
    return { ok: true, skipped: true, reason: "Immediate notification dispatch is disabled during tests" };
  }

  const config = readWorkerConfig(env);
  if ("error" in config) return { ok: true, skipped: true, reason: config.error };

  const supabase = notificationWorkerClient(config.supabaseUrl, config.serviceRoleKey);
  try {
    const worker = await processDueNotificationJobs({
      supabase,
      fetchFn,
      batchSize: positiveInteger(env.DMSUM_IMMEDIATE_NOTIFICATION_BATCH_SIZE, config.batchSize, 50),
      maxAttempts: config.maxAttempts,
      twilio: config.twilio,
      dryRun: config.dryRun
    });
    return { ok: true, skipped: false, worker };
  } catch (error) {
    return { ok: false, skipped: false, error: errorMessage(error) };
  }
}

export async function processDueNotificationJobs(input: {
  supabase: NotificationSupabaseClient;
  fetchFn?: typeof fetch;
  batchSize?: number;
  maxAttempts?: number;
  twilio: {
    accountSid: string;
    authUsername: string;
    authPassword: string;
    messagingServiceSid: string;
    statusCallbackUrl?: string;
  };
  dryRun?: boolean;
}): Promise<WorkerResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const batchSize = input.batchSize ?? 10;
  const maxAttempts = input.maxAttempts ?? 3;
  const workerId = `dmsum-worker-${randomUUID()}`;
  const dryRun = input.dryRun === true;

  const { data, error } = await input.supabase.rpc("claim_notification_jobs", {
    worker_id: workerId,
    batch_size: batchSize
  });

  if (error) throw new Error(`Failed to claim notification jobs: ${error.message}`);

  const jobs = (data ?? []) as ClaimedNotificationJob[];
  const result: WorkerResult = {
    ok: true,
    claimed: jobs.length,
    sent: 0,
    retried: 0,
    failed: 0,
    dryRun
  };

  for (const job of jobs) {
    try {
      const twilioResult = dryRun
        ? { sid: `dry_run_${job.id}`, status: "sent" }
        : await sendTwilioMessage(
            {
              accountSid: input.twilio.accountSid,
              authUsername: input.twilio.authUsername,
              authPassword: input.twilio.authPassword,
              messagingServiceSid: input.twilio.messagingServiceSid,
              to: job.target_value_normalized,
              body: job.body,
              statusCallbackUrl: input.twilio.statusCallbackUrl
            },
            fetchFn
          );

      await markNotificationJobSent(input.supabase, job, twilioResult);
      result.sent += 1;
    } catch (error) {
      const finalFailure = job.attempt_count >= maxAttempts;
      await markNotificationJobFailed(input.supabase, job, errorMessage(error), finalFailure);
      if (finalFailure) result.failed += 1;
      else result.retried += 1;
    }
  }

  return result;
}

export async function sendTwilioMessage(
  input: {
    accountSid: string;
    authUsername?: string;
    authPassword?: string;
    authToken?: string;
    messagingServiceSid: string;
    to: string;
    body: string;
    statusCallbackUrl?: string;
  },
  fetchFn: typeof fetch = fetch
): Promise<TwilioSendResult> {
  const form = new URLSearchParams({
    To: input.to,
    MessagingServiceSid: input.messagingServiceSid,
    Body: input.body
  });
  if (input.statusCallbackUrl) form.set("StatusCallback", input.statusCallbackUrl);

  const response = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${input.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${input.authUsername ?? input.accountSid}:${input.authPassword ?? input.authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : `Twilio send failed with status ${response.status}`;
    throw new Error(message);
  }

  if (typeof payload.sid !== "string") throw new Error("Twilio response did not include a message SID");
  return {
    sid: payload.sid,
    status: typeof payload.status === "string" ? payload.status : "queued"
  };
}

async function markNotificationJobSent(
  supabase: NotificationSupabaseClient,
  job: ClaimedNotificationJob,
  twilioResult: TwilioSendResult
): Promise<void> {
  const sentAt = new Date().toISOString();
  const { error } = await supabase
    .from("notification_jobs")
    .update({
      status: "sent",
      provider_message_sid: twilioResult.sid,
      sent_at: sentAt,
      locked_at: null,
      locked_by: null,
      last_error: null
    })
    .eq("id", job.id);

  if (error) throw new Error(`Failed to mark notification job sent: ${error.message}`);

  if (job.source_kind === "reminder") {
    await supabase
      .from("reminders")
      .update({
        status: "sent",
        sent_at: sentAt
      })
      .eq("id", job.source_id);
  }
}

async function markNotificationJobFailed(
  supabase: NotificationSupabaseClient,
  job: ClaimedNotificationJob,
  message: string,
  finalFailure: boolean
): Promise<void> {
  const retryDelayMinutes = Math.min(60, Math.max(5, job.attempt_count * 5));
  const nextSendAfter = new Date(Date.now() + retryDelayMinutes * 60_000).toISOString();
  const update: Record<string, unknown> = {
    status: finalFailure ? "failed" : "pending",
    locked_at: null,
    locked_by: null,
    last_error: message
  };
  if (!finalFailure) update.send_after = nextSendAfter;

  const { error } = await supabase
    .from("notification_jobs")
    .update(update)
    .eq("id", job.id);

  if (error) throw new Error(`Failed to mark notification job failed: ${error.message}`);

  if (finalFailure && job.source_kind === "reminder") {
    await supabase
      .from("reminders")
      .update({
        status: "failed"
      })
      .eq("id", job.source_id);
  }
}

function validateWorkerAuth(request: Request, env: NotificationWorkerEnv): Response | null {
  const secret = env.DMSUM_NOTIFICATION_WORKER_SECRET ?? env.CRON_SECRET;
  if (!secret) {
    if (env.NODE_ENV === "test") return null;
    return jsonResponse({ ok: false, error: "Notification worker secret is not configured" }, 500);
  }

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return jsonResponse({ ok: false, error: "Notification worker request is not authorized" }, 401);
  }

  return null;
}

function readWorkerConfig(env: NotificationWorkerEnv):
  | {
      supabaseUrl: string;
      serviceRoleKey: string;
      batchSize: number;
      maxAttempts: number;
      dryRun: boolean;
      twilio: {
        accountSid: string;
        authUsername: string;
        authPassword: string;
        messagingServiceSid: string;
        statusCallbackUrl?: string;
      };
    }
  | { error: string } {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: "Supabase service-role environment is not configured" };
  }

  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_MESSAGING_SERVICE_SID) {
    return { error: "Twilio notification environment is not configured" };
  }

  const apiKeyAuth =
    env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET
      ? {
          username: env.TWILIO_API_KEY_SID,
          password: env.TWILIO_API_KEY_SECRET
        }
      : null;
  const accountTokenAuth = env.TWILIO_AUTH_TOKEN
    ? {
        username: env.TWILIO_ACCOUNT_SID,
        password: env.TWILIO_AUTH_TOKEN
      }
    : null;
  const twilioAuth = apiKeyAuth ?? accountTokenAuth;

  if (!twilioAuth) {
    return { error: "Twilio notification environment is not configured" };
  }

  return {
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    batchSize: positiveInteger(env.DMSUM_NOTIFICATION_BATCH_SIZE, 10, 50),
    maxAttempts: positiveInteger(env.DMSUM_NOTIFICATION_MAX_ATTEMPTS, 3, 10),
    dryRun: env.DMSUM_NOTIFICATION_DRY_RUN === "1",
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authUsername: twilioAuth.username,
      authPassword: twilioAuth.password,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      statusCallbackUrl: env.DMSUM_TWILIO_STATUS_CALLBACK_URL
    }
  };
}

function notificationWorkerClient(supabaseUrl: string, serviceRoleKey: string): NotificationSupabaseClient {
  return createClient<any>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      headers: {
        authorization: `Bearer ${serviceRoleKey}`
      }
    }
  });
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Notification delivery failed";
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
