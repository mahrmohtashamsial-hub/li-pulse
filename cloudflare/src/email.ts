import { z } from "zod";

export type EmailProvider = "neverbounce" | "zerobounce" | "millionverifier" | "debounce";
export type EmailStatus = "valid" | "invalid" | "risky" | "unknown";
export type EmailResult = { email: string; status: EmailStatus; reason: string };

const requestSchema = z.object({
  provider: z.enum(["neverbounce", "zerobounce", "millionverifier", "debounce"]),
  api_key: z.string().min(1),
  emails: z.array(z.string()).min(1).max(50),
  max_age_days: z.number().int().min(0).max(30).default(14),
});

export const neverBounceSchema = z.object({ status: z.string().optional(), result: z.string(), flags: z.array(z.string()).optional(), suggested_correction: z.string().optional() }).passthrough();
export const zeroBounceSchema = z.object({ address: z.string().optional(), status: z.string(), sub_status: z.string().optional().nullable() }).passthrough();
export const millionVerifierSchema = z.object({ email: z.string().optional(), result: z.string(), subresult: z.string().optional(), error: z.string().optional() }).passthrough();
export const deBounceSchema = z.object({ success: z.union([z.string(), z.number()]), debounce: z.object({ email: z.string().optional(), result: z.string(), reason: z.string().optional() }).passthrough().optional() }).passthrough();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalized(email: string, status: EmailStatus, reason: string): EmailResult { return { email, status, reason: reason || status }; }

export function normalizeNeverBounce(email: string, raw: unknown): EmailResult {
  const data = neverBounceSchema.parse(raw); const value = data.result.toLowerCase();
  const status: EmailStatus = value === "valid" ? "valid" : value === "invalid" ? "invalid" : ["catchall", "disposable"].includes(value) ? "risky" : "unknown";
  return normalized(email, status, data.flags?.join(", ") || data.suggested_correction || value);
}
export function normalizeZeroBounce(email: string, raw: unknown): EmailResult {
  const data = zeroBounceSchema.parse(raw); const value = data.status.toLowerCase();
  const status: EmailStatus = value === "valid" ? "valid" : value === "invalid" ? "invalid" : ["do_not_mail", "spamtrap", "abuse", "catch-all", "catch_all"].includes(value) ? "risky" : "unknown";
  return normalized(email, status, data.sub_status || value);
}
export function normalizeMillionVerifier(email: string, raw: unknown): EmailResult {
  const data = millionVerifierSchema.parse(raw); const value = data.result.toLowerCase();
  const status: EmailStatus = ["ok", "valid"].includes(value) ? "valid" : value === "invalid" ? "invalid" : ["catch_all", "catch-all", "disposable"].includes(value) ? "risky" : "unknown";
  return normalized(email, status, data.error || data.subresult || value);
}
export function normalizeDeBounce(email: string, raw: unknown): EmailResult {
  const data = deBounceSchema.parse(raw); if (!data.debounce) return normalized(email, "unknown", "Provider returned no verification result");
  const value = data.debounce.result.toLowerCase();
  const status: EmailStatus = value === "safe to send" ? "valid" : value === "invalid" ? "invalid" : value === "risky" ? "risky" : "unknown";
  return normalized(email, status, data.debounce.reason || value);
}

async function retryFetch(url: URL, attempts = 4): Promise<unknown> {
  let last = "Provider request failed";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (response.ok) return response.json();
    last = `Provider HTTP ${response.status}`;
    if (response.status !== 429 && response.status < 500) break;
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 2 ** attempt + Math.random() * 0.5;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
  throw new Error(last);
}

export async function verifyEmail(provider: EmailProvider, email: string, apiKey: string): Promise<EmailResult> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(clean)) return normalized(email, "unknown", "Malformed email address");
  let url: URL; let normalize: (email: string, raw: unknown) => EmailResult;
  if (provider === "neverbounce") { url = new URL("https://api.neverbounce.com/v4.2/single/check"); url.searchParams.set("key", apiKey); normalize = normalizeNeverBounce; }
  else if (provider === "zerobounce") { url = new URL("https://api.zerobounce.net/v2/validate"); url.searchParams.set("api_key", apiKey); normalize = normalizeZeroBounce; }
  else if (provider === "millionverifier") { url = new URL("https://api.millionverifier.com/api/v3/"); url.searchParams.set("api", apiKey); url.searchParams.set("timeout", "10"); normalize = normalizeMillionVerifier; }
  else { url = new URL("https://api.debounce.io/v1/"); url.searchParams.set("api", apiKey); normalize = normalizeDeBounce; }
  url.searchParams.set("email", clean);
  try { return normalize(email, await retryFetch(url)); }
  catch (error) { return normalized(email, "unknown", error instanceof Error ? error.message : String(error)); }
}

async function pooled<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await operation(items[index]); }
  }));
  return results;
}

export async function handleEmailVerification(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Invalid email verification batch", details: parsed.error.issues }, { status: 400 });
  const { provider, api_key: apiKey, emails, max_age_days: maxAgeDays } = parsed.data;
  const cache = caches.default; const results = await pooled(emails, 8, async (email) => {
    const cacheKey = new Request(`https://li-pulse-cache.invalid/email/${provider}/${encodeURIComponent(email.trim().toLowerCase())}`);
    if (maxAgeDays > 0) { const hit = await cache.match(cacheKey); if (hit) return { ...await hit.json() as EmailResult, cached: true }; }
    const result = await verifyEmail(provider, email, apiKey);
    if (result.reason !== "Malformed email address" && !result.reason.startsWith("Provider HTTP")) await cache.put(cacheKey, Response.json(result, { headers: { "cache-control": `public, max-age=${maxAgeDays * 86400}` } }));
    return { ...result, cached: false };
  });
  return Response.json({ results });
}
