import { describe, expect, it } from "vitest";
import { createSession, handleLogin, isAuthenticated } from "../src/auth";

const env = { APP_PASSWORD: "correct horse battery staple" };

describe("application authentication", () => {
  it("rejects an incorrect password", async () => {
    expect(await createSession("wrong", env, 1_000_000)).toBeNull();
  });

  it("creates an HttpOnly secure session and validates it", async () => {
    const cookie = await createSession("correct horse battery staple", env, 1_000_000);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const request = new Request("https://example.com", { headers: { cookie: cookie!.split(";")[0] } });
    expect(await isAuthenticated(request, env, 1_000_001)).toBe(true);
    expect(await isAuthenticated(request, env, 1_000_000 + 12 * 60 * 60 * 1000 + 1)).toBe(false);
  });

  it("redirects a successful form login without reflecting the password", async () => {
    const request = new Request("https://example.com/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "correct horse battery staple" }),
    });
    const response = await handleLogin(request, env, async () => true);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).not.toContain("correct horse battery staple");
  });
});
