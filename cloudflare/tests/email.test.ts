import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeDeBounce, normalizeMillionVerifier, normalizeNeverBounce, normalizeZeroBounce, verifyEmail } from "../src/email";

afterEach(() => vi.unstubAllGlobals());

describe("email provider adapters", () => {
  it("normalizes documented provider response fields", () => {
    expect(normalizeNeverBounce("a@example.com", { status: "success", result: "catchall", flags: ["accepts_all"] })).toEqual({ email: "a@example.com", status: "risky", reason: "accepts_all" });
    expect(normalizeZeroBounce("a@example.com", { address: "a@example.com", status: "invalid", sub_status: "mailbox_not_found" }).status).toBe("invalid");
    expect(normalizeMillionVerifier("a@example.com", { result: "ok", subresult: "unknown" }).status).toBe("valid");
    expect(normalizeDeBounce("a@example.com", { success: "1", debounce: { result: "Risky", reason: "Accept-all" } })).toEqual({ email: "a@example.com", status: "risky", reason: "Accept-all" });
  });

  it("labels malformed addresses without calling a provider", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await verifyEmail("neverbounce", "not-an-email", "secret")).toEqual({ email: "not-an-email", status: "unknown", reason: "Malformed email address" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a 429 then normalizes the successful response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(Response.json({ result: "valid", flags: ["has_dns_mx"] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await verifyEmail("neverbounce", "a@example.com", "secret");
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(result.status).toBe("valid");
    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.origin + requested.pathname).toBe("https://api.neverbounce.com/v4.2/single/check");
    expect(requested.searchParams.get("key")).toBe("secret");
  });
});
