import { describe, expect, it } from "vitest";
import { classifyTier, isJobTimedOut, mergeRows, webhookEventKey, type StoredConfig } from "../src/jobs";
import type { NormalizationResult } from "../src/actors/registry";

const base: StoredConfig = {
  rows: [{ linkedin_url: "https://www.linkedin.com/in/example", lead_id: "42" }],
  actors: ["posts", "comments", "reactions"],
  thresholds: { active: 14, occasional: 60, dormant: 180 }, limits: {},
};
function output(key: "posts" | "comments" | "reactions", date: string): NormalizationResult {
  return { rows: new Map([["example", { profileSlug: "example", profileUrl: "https://www.linkedin.com/in/example", timestamps: { [key]: [date] } }]]), issues: [] };
}

describe("job merge and reliability boundaries", () => {
  it("classifies exact tier boundaries", () => {
    expect(classifyTier(14, base.thresholds, true)).toBe("ACTIVE");
    expect(classifyTier(15, base.thresholds, true)).toBe("OCCASIONAL");
    expect(classifyTier(60, base.thresholds, true)).toBe("OCCASIONAL");
    expect(classifyTier(61, base.thresholds, true)).toBe("DORMANT");
    expect(classifyTier(180, base.thresholds, true)).toBe("DORMANT");
    expect(classifyTier(181, base.thresholds, true)).toBe("INACTIVE");
    expect(classifyTier(null, base.thresholds, false)).toBe("UNKNOWN");
  });
  it("merges partial actor output without turning missing activity into zero", () => {
    const now = Date.parse("2026-08-04T00:00:00Z");
    const rows = mergeRows(base, { posts: output("posts", "2026-08-01T00:00:00Z") }, ["comments", "reactions"], now);
    expect(rows[0].activity_tier).toBe("ACTIVE");
    expect(rows[0].posts_90d).toBe(1);
    expect(rows[0].comments_90d).toBeNull();
    expect(rows[0].reactions_90d).toBeNull();
    expect(rows[0].data_completeness).toBe("posts");
    expect(rows[0].notes).toContain("missing activity is not counted as zero");
    expect(rows[0].lead_id).toBe("42");
  });
  it("uses a stable idempotency tuple for duplicate webhook deliveries", () => {
    expect(webhookEventKey("job", "run", "ACTOR.RUN.SUCCEEDED")).toBe(webhookEventKey("job", "run", "ACTOR.RUN.SUCCEEDED"));
    expect(webhookEventKey("job", "run", "ACTOR.RUN.FAILED")).not.toBe(webhookEventKey("job", "run", "ACTOR.RUN.SUCCEEDED"));
  });
  it("marks jobs beyond the configured timeout boundary", () => {
    const now = Date.parse("2026-08-04T00:31:00Z");
    expect(isJobTimedOut("2026-08-04T00:00:00Z", 30, now)).toBe(true);
    expect(isJobTimedOut("2026-08-04T00:01:00Z", 30, now)).toBe(false);
  });
});
