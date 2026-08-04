export type SecretBinding = string | { get(): Promise<string> };

export interface AuthEnv {
  APP_PASSWORD?: SecretBinding;
}

const COOKIE_NAME = "li_pulse_session";
const SESSION_SECONDS = 60 * 60 * 12;
const encoder = new TextEncoder();

async function readSecret(binding: SecretBinding | undefined): Promise<string | null> {
  if (!binding) return null;
  const value = typeof binding === "string" ? binding : await binding.get();
  return value?.trim() || null;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function sign(value: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function cookieValue(request: Request): string | null {
  const cookies = request.headers.get("cookie") || "";
  for (const item of cookies.split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === COOKIE_NAME) return parts.join("=");
  }
  return null;
}

export async function isAuthenticated(request: Request, env: AuthEnv, now = Date.now()): Promise<boolean> {
  const password = await readSecret(env.APP_PASSWORD);
  const session = cookieValue(request);
  if (!password || !session) return false;
  const [expiresText, signature] = session.split(".");
  const expires = Number(expiresText);
  if (!expiresText || !signature || !Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000)) return false;
  return constantTimeEqual(await sign(expiresText, password), signature);
}

export async function createSession(passwordAttempt: string, env: AuthEnv, now = Date.now()): Promise<string | null> {
  const password = await readSecret(env.APP_PASSWORD);
  if (!password || !constantTimeEqual(await digest(passwordAttempt), await digest(password))) return null;
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const value = `${expires}.${await sign(String(expires), password)}`;
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function loginPage(error = false): Response {
  const message = error ? '<p class="error">Incorrect password. Please try again.</p>' : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · li-pulse</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><style>
  :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090d;color:#f3f5f7}.card{width:min(92vw,420px);padding:36px;border:1px solid #252b35;border-radius:18px;background:#11151c;box-shadow:0 24px 70px #0008}.brand{display:flex;align-items:center;gap:12px;font-weight:750;font-size:22px}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:#c9ff45;color:#101408;font-weight:900}.muted{color:#9aa4b2;line-height:1.55;margin:20px 0 26px}label{display:block;font-size:13px;font-weight:650;margin-bottom:8px}input{width:100%;padding:13px 14px;border:1px solid #333b47;border-radius:10px;background:#090c11;color:#fff;font-size:16px}input:focus{outline:2px solid #c9ff4588;border-color:#c9ff45}.turnstile{margin-top:16px}button{width:100%;margin-top:16px;padding:13px;border:0;border-radius:10px;background:#c9ff45;color:#101408;font-size:15px;font-weight:800;cursor:pointer}.error{padding:10px 12px;border-radius:9px;background:#401b22;color:#ffb8c1;font-size:14px}</style></head><body><main class="card"><div class="brand"><span class="mark">lp</span><span>li-pulse</span></div><p class="muted">This workspace is private. Enter the team password to continue.</p>${message}<form method="post" action="/auth/login"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><div class="turnstile cf-turnstile" data-sitekey="0x4AAAAAAEF6g0z_NurCOZQA" data-theme="dark"></div><button type="submit">Sign in</button></form></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" } });
}

export async function handleLogin(request: Request, env: AuthEnv, verifyBot: (token: unknown) => Promise<boolean>): Promise<Response> {
  if (request.method === "GET") return loginPage(false);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("application/x-www-form-urlencoded") && !contentType.startsWith("multipart/form-data")) return loginPage(true);
  const form = await request.formData();
  if (!await verifyBot(form.get("cf-turnstile-response"))) return loginPage(true);
  const cookie = await createSession(String(form.get("password") || ""), env);
  if (!cookie) return loginPage(true);
  return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie, "cache-control": "no-store" } });
}
