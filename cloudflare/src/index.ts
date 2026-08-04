interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MAX_PROFILES_PER_RUN: string;
  TURNSTILE_SECRET?: string | { get(): Promise<string> };
}

type ProviderName = "apify" | "brightdata" | "proxycurl" | "mock";
type Row = Record<string, string> & { linkedin_url: string };
type Thresholds = { active: number; occasional: number; dormant: number };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function normalizeLinkedInUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("missing URL");
  const candidate = value.includes("://") ? value.trim() : `https://${value.trim()}`;
  const url = new URL(candidate);
  if (!["linkedin.com", "www.linkedin.com"].includes(url.hostname.toLowerCase())) throw new Error("not a LinkedIn URL");
  let parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length >= 3 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0]) && parts[1].toLowerCase() === "in") parts = parts.slice(1);
  if (["company", "school", "showcase"].includes((parts[0] || "").toLowerCase())) throw new Error("company page");
  if (parts.length < 2 || parts[0].toLowerCase() !== "in" || !/^[\w%.~-]+$/.test(parts[1])) throw new Error("not a personal profile URL");
  return `https://www.linkedin.com/in/${parts[1]}`;
}

function parseDates(value: unknown): Date[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = typeof item === "object" && item !== null ? (item as Record<string, unknown>).date : item;
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? [] : [date];
  });
}

function calculateMetrics(raw: Record<string, unknown>, thresholds: Thresholds) {
  const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
  const posts = parseDates(data.posts);
  const reposts = parseDates(data.reposts);
  const comments = parseDates(data.comments);
  const reactions = parseDates(data.reactions);
  const hasActivityData = [posts, reposts, comments].some((value) => value !== null);
  const activity = [...(posts || []), ...(reposts || []), ...(comments || [])];
  const newest = activity.length ? new Date(Math.max(...activity.map((item) => item.getTime()))) : null;
  const dayMs = 86_400_000;
  const days = newest ? Math.max(0, Math.floor((Date.now() - newest.getTime()) / dayMs)) : null;
  const within = (values: Date[] | null, period: number) => values === null ? null : values.filter((date) => {
    const age = Math.floor((Date.now() - date.getTime()) / dayMs);
    return age >= 0 && age <= period;
  }).length;
  const p30 = within(posts, 30), p90 = within(posts, 90), p180 = within(posts, 180);
  const r90 = within(reposts, 90), c90 = within(comments, 90), reaction90 = within(reactions, 90);
  const available = [p90, r90, c90, reaction90].filter((value): value is number => value !== null);
  let activityTier: string;
  if (!hasActivityData) activityTier = "UNKNOWN";
  else if (days === null || days > thresholds.dormant) activityTier = "INACTIVE";
  else if (days <= thresholds.active) activityTier = "ACTIVE";
  else if (days <= thresholds.occasional) activityTier = "OCCASIONAL";
  else activityTier = "DORMANT";
  const activityNote = activityTier === "UNKNOWN"
    ? "No activity data returned"
    : days === null
      ? `No activity in last ${thresholds.dormant}d`
      : `${p30 === null ? "" : `Posted ${p30}x in last 30d, `}last active ${days} day${days === 1 ? "" : "s"} ago`;
  return {
    last_activity_date: newest?.toISOString().slice(0, 10) ?? null,
    days_since_last_activity: days,
    posts_last_30d: p30,
    posts_last_90d: p90,
    posts_last_180d: p180,
    reposts_last_90d: r90,
    comments_last_90d: c90,
    reactions_last_90d: reaction90,
    total_activity_last_90d: available.length ? available.reduce((sum, value) => sum + value, 0) : null,
    follower_count: data.follower_count ?? data.followers ?? null,
    connection_count: data.connection_count ?? data.connections ?? null,
    headline: data.headline ?? null,
    current_company: data.current_company ?? data.company ?? null,
    current_title: data.current_title ?? data.title ?? null,
    activity_tier: activityTier,
    activity_note: activityNote,
  };
}

async function providerRequest(provider: ProviderName, linkedinUrl: string, apiKey: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (provider === "mock") {
    const slug = linkedinUrl.split("/").filter(Boolean).at(-1)?.toLowerCase() || "";
    const age = slug.startsWith("inactive") ? 999 : slug.startsWith("occasional") ? 40 : slug.startsWith("active") ? 3 : 999;
    return { posts: age <= 180 ? [new Date(Date.now() - age * 86_400_000).toISOString()] : [], reposts: [], comments: [], headline: "Mock profile" };
  }
  if (!apiKey) throw new Error("Provider API key is required");
  let url: string;
  let init: RequestInit;
  if (provider === "apify") {
    const actor = String(body.actor_id || "dev_fusion~linkedin-profile-scraper");
    url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(apiKey)}`;
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileUrls: [linkedinUrl] }) };
  } else if (provider === "brightdata") {
    const dataset = String(body.dataset_id || "");
    if (!dataset) throw new Error("Bright Data dataset ID is required");
    url = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(dataset)}&format=json`;
    init = { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ url: linkedinUrl }) };
  } else {
    url = `https://nubela.co/proxycurl/api/v2/linkedin?url=${encodeURIComponent(linkedinUrl)}`;
    init = { headers: { authorization: `Bearer ${apiKey}` } };
  }
  let message = "Provider request failed";
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, init);
    if (response.ok) {
      const result: unknown = await response.json();
      return (Array.isArray(result) ? result[0] : result || {}) as Record<string, unknown>;
    }
    message = `Provider HTTP ${response.status}`;
    if (response.status !== 429 && response.status < 500) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000 + Math.random() * 500));
  }
  throw new Error(message);
}

async function verifyTurnstile(request: Request, env: Env, token: unknown): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token) return false;
  const secret = typeof env.TURNSTILE_SECRET === "string"
    ? env.TURNSTILE_SECRET
    : await env.TURNSTILE_SECRET.get();
  if (!secret) return false;
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  form.set("remoteip", request.headers.get("CF-Connecting-IP") || "");
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const result = await response.json() as { success?: boolean };
  return result.success === true;
}

async function run(request: Request, env: Env): Promise<Response> {
  const body = await request.json<Record<string, unknown>>();
  if (!await verifyTurnstile(request, env, body.turnstile_token)) return json({ error: "Bot verification failed" }, 403);
  const inputRows = Array.isArray(body.rows) ? body.rows as Row[] : [];
  const maximum = Math.min(100, Math.max(1, Number(env.MAX_PROFILES_PER_RUN || 100)));
  if (inputRows.length > maximum) return json({ error: `Maximum ${maximum} profiles per run` }, 413);
  const provider = String(body.provider || "mock") as ProviderName;
  if (!["apify", "brightdata", "proxycurl", "mock"].includes(provider)) return json({ error: "Unsupported provider" }, 400);
  const thresholds = { active: Number(body.active ?? 14), occasional: Number(body.occasional ?? 60), dormant: Number(body.dormant ?? 180) };
  if (!(thresholds.active < thresholds.occasional && thresholds.occasional < thresholds.dormant)) return json({ error: "Tier thresholds must be strictly increasing" }, 400);
  const maxAgeDays = Math.max(0, Number(body.max_age_days ?? 14));
  const valid: Row[] = [], skipped: Array<Record<string, unknown>> = [], seen = new Set<string>();
  inputRows.forEach((row, index) => {
    try {
      const normalized = normalizeLinkedInUrl(row.linkedin_url);
      const key = normalized.toLowerCase();
      if (seen.has(key)) throw new Error("duplicate profile");
      seen.add(key);
      valid.push({ ...row, linkedin_url: normalized });
    } catch (error) {
      skipped.push({ row_number: index + 2, linkedin_url: row.linkedin_url, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  const results: Array<Record<string, unknown>> = [];
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  for (const row of valid) {
    try {
      let raw: Record<string, unknown> | null = null;
      if (!body.force_refresh) {
        const cached = await env.DB.prepare("select raw_json from profile_cache where provider = ? and linkedin_url = ? and fetched_at >= ?")
          .bind(provider, row.linkedin_url, cutoff).first<{ raw_json: string }>();
        if (cached) raw = JSON.parse(cached.raw_json) as Record<string, unknown>;
      }
      if (!raw) {
        raw = await providerRequest(provider, row.linkedin_url, String(body.api_key || ""), body);
        await env.DB.prepare("insert into profile_cache(provider, linkedin_url, fetched_at, raw_json) values (?, ?, ?, ?) on conflict(provider, linkedin_url) do update set fetched_at = excluded.fetched_at, raw_json = excluded.raw_json")
          .bind(provider, row.linkedin_url, new Date().toISOString(), JSON.stringify(raw)).run();
      }
      results.push({ ...row, ...calculateMetrics(raw, thresholds), fetch_error: null });
    } catch (error) {
      results.push({ ...row, activity_tier: "UNKNOWN", activity_note: "Fetch failed", fetch_error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = results.filter((row) => row.activity_tier === "UNKNOWN").length;
  await env.DB.prepare("insert into run_audit(id, created_at, profile_count, provider, succeeded, failed) values (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), new Date().toISOString(), valid.length, provider, valid.length - failed, failed).run();
  return json({ results, skipped, valid_count: valid.length });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ status: "ok", service: "li-pulse" });
    if (url.pathname === "/api/run" && request.method === "POST") return run(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
