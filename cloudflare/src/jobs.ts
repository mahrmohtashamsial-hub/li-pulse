import { z } from "zod";
import { actorRegistry, profileSlug, selectedActors, type ActorDefinition, type ActorKey, type NormalizedActorRow } from "./actors/registry";

export interface JobEnv {
  DB: D1Database;
  APIFY_TOKEN?: string | { get(): Promise<string> };
  APIFY_WEBHOOK_SECRET?: string | { get(): Promise<string> };
  JOB_MAX_DURATION_MINUTES?: string;
}

async function readSecret(value: string | { get(): Promise<string> } | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  return typeof value === "string" ? value : await value.get();
}

type JobStatus = "QUEUED" | "RUNNING" | "COMPLETE" | "FAILED" | "STALE";
type ActorStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";
export type StoredConfig = {
  rows: Array<Record<string, string> & { linkedin_url: string }>;
  actors: ActorKey[];
  thresholds: { active: number; occasional: number; dormant: number };
  limits: Partial<Record<ActorKey, number>>;
  actorIds?: Partial<Record<ActorKey, string>>;
  costs?: Partial<Record<ActorKey, number>>;
};

const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).transform((row) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? "" : String(value)])),
);
export const createJobSchema = z.object({
  rows: z.array(rowSchema).min(1).max(100),
  actors: z.array(z.enum(["posts", "comments", "reactions"])).min(1),
  api_key: z.string().min(1).optional(),
  actor_ids: z.record(z.string(), z.string()).optional(),
  costs: z.record(z.string(), z.number().nonnegative()).optional(),
  limits: z.record(z.string(), z.number().int().positive()).optional(),
  active: z.number().int().nonnegative().default(14),
  occasional: z.number().int().positive().default(60),
  dormant: z.number().int().positive().default(180),
  turnstile_token: z.string().optional(),
});

export const webhookSchema = z.object({
  eventType: z.enum(["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"]),
  resource: z.object({ id: z.string(), status: z.string().optional(), defaultDatasetId: z.string().optional().nullable() }).passthrough(),
}).passthrough();

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function normalizeUrl(value: unknown): { slug: string; url: string } {
  if (typeof value !== "string") throw new Error("missing URL");
  const slug = profileSlug(value);
  if (!slug) throw new Error("not a personal LinkedIn profile URL");
  return { slug, url: `https://www.linkedin.com/in/${slug}` };
}

function encodeBase64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

async function retry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); }
    catch (error) {
      last = error;
      const detail = error as { retryable?: boolean; retryAfterMs?: number };
      if (detail.retryable === false || attempt + 1 >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, detail.retryAfterMs ?? (2 ** attempt * 500 + Math.random() * 300)));
    }
  }
  throw last;
}

async function apifyFetch(url: string, token?: string, init?: RequestInit): Promise<Response> {
  const target = new URL(url);
  if (token) target.searchParams.set("token", token);
  const response = await fetch(target, init);
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const error = new Error(`Apify HTTP ${response.status}`) as Error & { retryable?: boolean; retryAfterMs?: number };
    error.retryable = retryable;
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) error.retryAfterMs = Number(retryAfter) * 1000;
    throw error;
  }
  return response;
}

async function startActor(jobId: string, actor: ActorDefinition, config: StoredConfig, token: string, origin: string, env: JobEnv): Promise<void> {
  const secret = await readSecret(env.APIFY_WEBHOOK_SECRET);
  if (!secret) throw new Error("APIFY_WEBHOOK_SECRET is not configured");
  const limit = config.limits[actor.key] ?? 100;
  const webhookUrl = `${origin}/api/webhooks/apify/${encodeURIComponent(jobId)}?token=${encodeURIComponent(secret)}`;
  const webhooks = [{
    eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
    requestUrl: webhookUrl,
    payloadTemplate: "{\"eventType\":\"{{eventType}}\",\"resource\":{{resource}}}",
  }];
  const url = new URL(`https://api.apify.com/v2/acts/${encodeURIComponent(actor.actorId!)}/runs`);
  url.searchParams.set("webhooks", encodeBase64(JSON.stringify(webhooks)));
  const response = await retry(async () => {
    try { return await apifyFetch(url.toString(), token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(actor.buildInput(config.rows.map((row) => row.linkedin_url), { maxItems: limit })) }); }
    catch (error) { if (!(error as { retryable?: boolean }).retryable) throw error; throw error; }
  });
  const payload = await response.json() as { data?: { id?: string; defaultDatasetId?: string } };
  const runId = payload.data?.id;
  if (!runId) throw new Error("Apify start response did not contain a run ID");
  await env.DB.prepare("update job_actors set apify_run_id=?, dataset_id=?, status='RUNNING', started_at=?, error=null where job_id=? and actor_key=?")
    .bind(runId, payload.data?.defaultDatasetId ?? null, new Date().toISOString(), jobId, actor.key).run();
}

export async function startJob(jobId: string, config: StoredConfig, suppliedToken: string | undefined, origin: string, env: JobEnv): Promise<void> {
  const token = suppliedToken || await readSecret(env.APIFY_TOKEN);
  if (!token) {
    await env.DB.prepare("update jobs set status='FAILED', updated_at=?, error=? where id=?").bind(new Date().toISOString(), "An Apify token is required", jobId).run();
    return;
  }
  await env.DB.prepare("update jobs set status='RUNNING', updated_at=? where id=?").bind(new Date().toISOString(), jobId).run();
  const actors = selectedActors(config.actors, { actorIds: config.actorIds });
  await Promise.allSettled(actors.map(async (actor) => {
    try { await startActor(jobId, actor, config, token, origin, env); }
    catch (error) {
      await env.DB.prepare("update job_actors set status='FAILED', finished_at=?, error=? where job_id=? and actor_key=?")
        .bind(new Date().toISOString(), error instanceof Error ? error.message : String(error), jobId, actor.key).run();
    }
  }));
  await finalizeIfReady(jobId, env);
}

async function fetchDataset(datasetId: string, env: JobEnv): Promise<unknown[]> {
  const base = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=1&format=json`;
  try {
    const response = await apifyFetch(base);
    return await response.json() as unknown[];
  } catch (publicError) {
    const serverToken = await readSecret(env.APIFY_TOKEN);
    if (!serverToken) throw new Error(`Dataset is not publicly readable and no server APIFY_TOKEN can access it: ${publicError instanceof Error ? publicError.message : String(publicError)}`);
    const response = await apifyFetch(base, serverToken);
    return await response.json() as unknown[];
  }
}

function countWithin(values: string[] | undefined, days: number, now: number): number {
  return (values ?? []).filter((value) => { const age = Math.floor((now - new Date(value).getTime()) / 86_400_000); return age >= 0 && age <= days; }).length;
}

export function classifyTier(days: number | null, thresholds: StoredConfig["thresholds"], fullActivityCoverage: boolean): string {
  if (days === null) return fullActivityCoverage ? "INACTIVE" : "UNKNOWN";
  if (days <= thresholds.active) return "ACTIVE";
  if (days <= thresholds.occasional) return "OCCASIONAL";
  if (days <= thresholds.dormant) return "DORMANT";
  return "INACTIVE";
}

export function webhookEventKey(jobId: string, runId: string, eventType: string): string { return `${jobId}:${runId}:${eventType}`; }
export function isJobTimedOut(createdAt: string, maxMinutes: number, now = Date.now()): boolean { return now - new Date(createdAt).getTime() > maxMinutes * 60_000; }

export function mergeRows(config: StoredConfig, outputs: Partial<Record<ActorKey, ReturnType<ActorDefinition["normalizeOutput"]>>>, failedActors: ActorKey[], now = Date.now()): Array<Record<string, unknown>> {
  return config.rows.map((sourceRow) => {
    const normalized = normalizeUrl(sourceRow.linkedin_url); const fragments: Array<[ActorKey, NormalizedActorRow]> = [];
    for (const key of config.actors) { const row = outputs[key]?.rows.get(normalized.slug); if (row) fragments.push([key, row]); }
    const complete = fragments.map(([key]) => key);
    const timestamps = { posts: [] as string[], reposts: [] as string[], comments: [] as string[], reactions: [] as string[] };
    for (const [, fragment] of fragments) for (const key of Object.keys(timestamps) as Array<keyof typeof timestamps>) timestamps[key].push(...(fragment.timestamps[key] ?? []));
    const allDates = Object.values(timestamps).flat().map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime()));
    const newest = allDates.length ? new Date(Math.max(...allDates.map((date) => date.getTime()))) : null;
    const days = newest ? Math.max(0, Math.floor((now - newest.getTime()) / 86_400_000)) : null;
    const fullActivityCoverage = config.actors.every((key) => complete.includes(key));
    const tier = classifyTier(days, config.thresholds, fullActivityCoverage);
    const notes: string[] = [];
    if (failedActors.length) notes.push(`Failed actors: ${failedActors.join(", ")}`);
    const missing = config.actors.filter((key) => !complete.includes(key)); if (missing.length) notes.push(`No row returned by: ${missing.join(", ")}; missing activity is not counted as zero`);
    notes.push("Profile identity fields unavailable: no profile-details actor sample configured");
    return {
      ...sourceRow, linkedin_url: normalized.url,
      name: null, headline: null, company: null, title: null, follower_count: null,
      posts_90d: complete.includes("posts") ? countWithin(timestamps.posts, 90, now) : null,
      reposts_90d: complete.includes("posts") ? countWithin(timestamps.reposts, 90, now) : null,
      comments_90d: complete.includes("comments") ? countWithin(timestamps.comments, 90, now) : null,
      reactions_90d: complete.includes("reactions") ? countWithin(timestamps.reactions, 90, now) : null,
      total_activity_90d: Object.entries(timestamps).filter(([key]) => (key === "posts" || key === "reposts") ? complete.includes("posts") : complete.includes(key as ActorKey)).reduce((sum, [, values]) => sum + countWithin(values, 90, now), 0),
      last_activity_date: newest?.toISOString().slice(0, 10) ?? null,
      days_since_last_activity: days,
      activity_tier: tier,
      data_completeness: complete.length ? complete.join("+") : "none",
      notes: notes.join(". "),
    };
  });
}

async function mergeJob(jobId: string, env: JobEnv): Promise<void> {
  const job = await env.DB.prepare("select config_json from jobs where id=?").bind(jobId).first<{ config_json: string }>();
  if (!job) return;
  const config = JSON.parse(job.config_json) as StoredConfig;
  const actors = await env.DB.prepare("select actor_key,status,output_json,error from job_actors where job_id=?").bind(jobId).all<{ actor_key: ActorKey; status: ActorStatus; output_json: string | null; error: string | null }>();
  const outputs: Partial<Record<ActorKey, ReturnType<ActorDefinition["normalizeOutput"]>>> = {};
  const failed: ActorKey[] = [];
  for (const actor of actors.results) {
    if (actor.status === "SUCCEEDED" && actor.output_json) outputs[actor.actor_key] = actorRegistry[actor.actor_key].normalizeOutput(JSON.parse(actor.output_json) as unknown[]);
    else if (["FAILED", "TIMED_OUT"].includes(actor.status)) failed.push(actor.actor_key);
  }
  const merged = mergeRows(config, outputs, failed);
  await env.DB.batch(merged.map((row) => env.DB.prepare("insert into job_results(job_id,profile_slug,merged_json) values (?,?,?) on conflict(job_id,profile_slug) do update set merged_json=excluded.merged_json")
    .bind(jobId, normalizeUrl(row.linkedin_url).slug, JSON.stringify(row))));
}

async function finalizeIfReady(jobId: string, env: JobEnv): Promise<void> {
  const actors = await env.DB.prepare("select status from job_actors where job_id=?").bind(jobId).all<{ status: ActorStatus }>();
  if (!actors.results.length || actors.results.some((actor) => ["QUEUED", "RUNNING"].includes(actor.status))) return;
  await mergeJob(jobId, env);
  const succeeded = actors.results.filter((actor) => actor.status === "SUCCEEDED").length;
  const status: JobStatus = succeeded ? "COMPLETE" : "FAILED";
  await env.DB.prepare("update jobs set status=?,updated_at=?,error=? where id=?")
    .bind(status, new Date().toISOString(), succeeded ? null : "All selected actors failed", jobId).run();
}

async function receiveWebhook(request: Request, jobId: string, env: JobEnv): Promise<Response> {
  const url = new URL(request.url);
  const webhookSecret = await readSecret(env.APIFY_WEBHOOK_SECRET);
  if (!webhookSecret || url.searchParams.get("token") !== webhookSecret) return json({ error: "Unauthorized webhook" }, 401);
  const parsed = webhookSchema.safeParse(await request.json());
  if (!parsed.success) return json({ error: "Invalid webhook payload", details: parsed.error.issues }, 400);
  const { eventType, resource } = parsed.data;
  const inserted = await env.DB.prepare("insert or ignore into job_webhook_events(job_id,apify_run_id,event_type,received_at) values (?,?,?,?)")
    .bind(jobId, resource.id, eventType, new Date().toISOString()).run();
  if (!inserted.meta.changes) return json({ ok: true, duplicate: true });
  const actor = await env.DB.prepare("select actor_key from job_actors where job_id=? and apify_run_id=?").bind(jobId, resource.id).first<{ actor_key: ActorKey }>();
  if (!actor) return json({ error: "Run is not registered for this job" }, 404);
  if (eventType === "ACTOR.RUN.SUCCEEDED") {
    const datasetId = resource.defaultDatasetId || (await env.DB.prepare("select dataset_id from job_actors where job_id=? and actor_key=?").bind(jobId, actor.actor_key).first<{ dataset_id: string }>())?.dataset_id;
    try {
      if (!datasetId) throw new Error("Webhook did not contain a dataset ID");
      const items = await fetchDataset(datasetId, env);
      const normalized = actorRegistry[actor.actor_key].normalizeOutput(items);
      await env.DB.prepare("update job_actors set status='SUCCEEDED',dataset_id=?,item_count=?,output_json=?,finished_at=?,error=? where job_id=? and actor_key=?")
        .bind(datasetId, items.length, JSON.stringify(items), new Date().toISOString(), normalized.issues.length ? normalized.issues.join("; ").slice(0, 2000) : null, jobId, actor.actor_key).run();
    } catch (error) {
      await env.DB.prepare("update job_actors set status='FAILED',finished_at=?,error=? where job_id=? and actor_key=?")
        .bind(new Date().toISOString(), error instanceof Error ? error.message : String(error), jobId, actor.actor_key).run();
    }
  } else {
    const status = eventType === "ACTOR.RUN.TIMED_OUT" ? "TIMED_OUT" : "FAILED";
    await env.DB.prepare("update job_actors set status=?,finished_at=?,error=? where job_id=? and actor_key=?")
      .bind(status, new Date().toISOString(), eventType, jobId, actor.actor_key).run();
  }
  await mergeJob(jobId, env);
  await finalizeIfReady(jobId, env);
  return json({ ok: true });
}

async function jobResponse(jobId: string, env: JobEnv): Promise<Response> {
  const job = await env.DB.prepare("select id,status,created_at,updated_at,url_count,error from jobs where id=?").bind(jobId).first<Record<string, unknown>>();
  if (!job) return json({ error: "Job not found" }, 404);
  const actors = await env.DB.prepare("select actor_key,status,apify_run_id,item_count,error,started_at,finished_at from job_actors where job_id=? order by actor_key").bind(jobId).all<Record<string, unknown>>();
  const resultRows = await env.DB.prepare("select merged_json from job_results where job_id=? order by profile_slug").bind(jobId).all<{ merged_json: string }>();
  const results = resultRows.results.map((row) => JSON.parse(row.merged_json));
  const terminal = actors.results.filter((actor) => ["SUCCEEDED", "FAILED", "TIMED_OUT"].includes(String(actor.status))).length;
  return json({ ...job, progress: actors.results.length ? Math.round(terminal / actors.results.length * 100) : 0, per_actor_status: actors.results, results });
}

function csv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]); const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\r\n");
}

async function exportJob(jobId: string, env: JobEnv): Promise<Response> {
  const rows = await env.DB.prepare("select merged_json from job_results where job_id=? order by profile_slug").bind(jobId).all<{ merged_json: string }>();
  return new Response(csv(rows.results.map((row) => JSON.parse(row.merged_json))), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=li-pulse-${jobId}.csv` } });
}

export async function createJob(request: Request, env: JobEnv, context: ExecutionContext, verify: (token: unknown) => Promise<boolean>): Promise<Response> {
  const parsed = createJobSchema.safeParse(await request.json());
  if (!parsed.success) return json({ error: "Invalid job", details: parsed.error.issues }, 400);
  if (!await verify(parsed.data.turnstile_token)) return json({ error: "Bot verification failed" }, 403);
  if (!(parsed.data.active < parsed.data.occasional && parsed.data.occasional < parsed.data.dormant)) return json({ error: "Tier thresholds must be strictly increasing" }, 400);
  const seen = new Set<string>(); const rows: StoredConfig["rows"] = []; const skipped: unknown[] = [];
  parsed.data.rows.forEach((row, index) => {
    try { const normalized = normalizeUrl(row.linkedin_url); if (seen.has(normalized.slug)) throw new Error("duplicate profile"); seen.add(normalized.slug); rows.push({ ...row, linkedin_url: normalized.url }); }
    catch (error) { skipped.push({ row_number: index + 2, linkedin_url: row.linkedin_url, reason: error instanceof Error ? error.message : String(error) }); }
  });
  if (!rows.length) return json({ error: "No valid profile URLs", skipped }, 400);
  const jobId = crypto.randomUUID(); const now = new Date().toISOString();
  const config: StoredConfig = {
    rows, actors: [...new Set(parsed.data.actors)], thresholds: { active: parsed.data.active, occasional: parsed.data.occasional, dormant: parsed.data.dormant },
    limits: (parsed.data.limits ?? {}) as Partial<Record<ActorKey, number>>, actorIds: parsed.data.actor_ids as Partial<Record<ActorKey, string>> | undefined,
    costs: parsed.data.costs as Partial<Record<ActorKey, number>> | undefined,
  };
  await env.DB.prepare("insert into jobs(id,status,created_at,updated_at,config_json,url_count,error) values (?,'QUEUED',?,?,?,?,null)")
    .bind(jobId, now, now, JSON.stringify(config), rows.length).run();
  await env.DB.batch(config.actors.map((key) => env.DB.prepare("insert into job_actors(job_id,actor_key,status) values (?,?,'QUEUED')").bind(jobId, key)));
  context.waitUntil(startJob(jobId, config, parsed.data.api_key, new URL(request.url).origin, env));
  const estimate = config.actors.reduce((sum, key) => sum + rows.length * (config.limits[key] ?? 100) * (config.costs?.[key] ?? actorRegistry[key].costPerResultUsd), 0);
  return json({ job_id: jobId, status: "QUEUED", valid_count: rows.length, skipped, estimated_max_cost_usd: Number(estimate.toFixed(4)) }, 202);
}

export async function handleJobRequest(request: Request, env: JobEnv, context: ExecutionContext, verify: (token: unknown) => Promise<boolean>): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/jobs" && request.method === "POST") return createJob(request, env, context, verify);
  const webhook = url.pathname.match(/^\/api\/webhooks\/apify\/([^/]+)$/); if (webhook && request.method === "POST") return receiveWebhook(request, decodeURIComponent(webhook[1]), env);
  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(\/export)?$/);
  if (match && request.method === "GET") return match[2] ? exportJob(decodeURIComponent(match[1]), env) : jobResponse(decodeURIComponent(match[1]), env);
  return null;
}

async function pollActor(jobId: string, runId: string, env: JobEnv): Promise<void> {
  try {
    const response = await apifyFetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`, await readSecret(env.APIFY_TOKEN));
    const payload = await response.json() as { data?: { status?: string; defaultDatasetId?: string } };
    const status = payload.data?.status;
    if (!status || ["READY", "RUNNING"].includes(status)) return;
    const eventType = status === "SUCCEEDED" ? "ACTOR.RUN.SUCCEEDED" : status === "TIMED-OUT" ? "ACTOR.RUN.TIMED_OUT" : "ACTOR.RUN.FAILED";
    const synthetic = new Request(`https://internal/api/webhooks/apify/${jobId}?token=${encodeURIComponent(await readSecret(env.APIFY_WEBHOOK_SECRET) ?? "")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventType, resource: { id: runId, status, defaultDatasetId: payload.data?.defaultDatasetId } }) });
    await receiveWebhook(synthetic, jobId, env);
  } catch { /* retried by the next scheduled event */ }
}

export async function pollStaleJobs(env: JobEnv): Promise<void> {
  const now = Date.now(); const maxMinutes = Number(env.JOB_MAX_DURATION_MINUTES || 30);
  const jobs = await env.DB.prepare("select id,created_at from jobs where status in ('QUEUED','RUNNING')").all<{ id: string; created_at: string }>();
  for (const job of jobs.results) {
    if (isJobTimedOut(job.created_at, maxMinutes, now)) {
      await env.DB.prepare("update job_actors set status='TIMED_OUT',finished_at=?,error='Job maximum duration exceeded' where job_id=? and status in ('QUEUED','RUNNING')").bind(new Date().toISOString(), job.id).run();
      await mergeJob(job.id, env);
      await env.DB.prepare("update jobs set status='STALE',updated_at=?,error='Job maximum duration exceeded' where id=?").bind(new Date().toISOString(), job.id).run();
      continue;
    }
    const actors = await env.DB.prepare("select apify_run_id from job_actors where job_id=? and status='RUNNING' and apify_run_id is not null").bind(job.id).all<{ apify_run_id: string }>();
    await Promise.allSettled(actors.results.map((actor) => pollActor(job.id, actor.apify_run_id, env)));
  }
}
