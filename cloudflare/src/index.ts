import { clearSessionCookie, handleLogin, isAuthenticated, loginPage, type SecretBinding } from "./auth";
import { handleEmailVerification } from "./email";
import { handleJobRequest, pollStaleJobs } from "./jobs";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TURNSTILE_SECRET?: SecretBinding;
  APIFY_TOKEN?: SecretBinding;
  APIFY_WEBHOOK_SECRET?: SecretBinding;
  APP_PASSWORD?: SecretBinding;
  JOB_MAX_DURATION_MINUTES?: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function verifyTurnstile(request: Request, env: Env, token: unknown): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token) return false;
  const secret = typeof env.TURNSTILE_SECRET === "string" ? env.TURNSTILE_SECRET : await env.TURNSTILE_SECRET.get();
  if (!secret) return false;
  const form = new FormData(); form.set("secret", secret); form.set("response", token); form.set("remoteip", request.headers.get("CF-Connecting-IP") || "");
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return (await response.json() as { success?: boolean }).success === true;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ status: "ok", service: "li-pulse" });
    if (url.pathname.startsWith("/api/webhooks/apify/")) {
      const response = await handleJobRequest(request, env, context, (token) => verifyTurnstile(request, env, token));
      return response ?? json({ error: "Not found" }, 404);
    }
    if (url.pathname === "/auth/login") return handleLogin(request, env, (token) => verifyTurnstile(request, env, token));
    if (url.pathname === "/auth/logout") return new Response(null, { status: 303, headers: { location: "/auth/login", "set-cookie": clearSessionCookie(), "cache-control": "no-store" } });
    if (!env.APP_PASSWORD) return json({ error: "Authentication is not configured. Add the APP_PASSWORD secret binding." }, 503);
    if (!await isAuthenticated(request, env)) return url.pathname.startsWith("/api/") ? json({ error: "Authentication required" }, 401) : loginPage(false);
    if (url.pathname === "/api/email/verify" && request.method === "POST") return handleEmailVerification(request);
    const jobResponse = await handleJobRequest(request, env, context, (token) => verifyTurnstile(request, env, token));
    if (jobResponse) return jobResponse;
    if (url.pathname === "/api/run") return json({ error: "Legacy endpoint removed; use /api/jobs" }, 410);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> { context.waitUntil(pollStaleJobs(env)); },
} satisfies ExportedHandler<Env>;
