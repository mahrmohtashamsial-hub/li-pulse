import { describe, expect, it } from "vitest";
import posts from "./fixtures/posts.json";
import comments from "./fixtures/comments.json";
import reactions from "./fixtures/reactions.json";
import { actorRegistry, profileSlug } from "../src/actors/registry";

describe("sample-derived actor adapters", () => {
  it("normalizes profile URL variants without guessing display names", () => {
    expect(profileSlug("https://www.linkedin.com/en/in/Test-Person/?trk=x")).toBe("test-person");
    expect(profileSlug("Matt Glass")).toBeNull();
  });
  it("maps posts and reposts from the real fixture", () => {
    const result = actorRegistry.posts.normalizeOutput(posts);
    const row = result.rows.get("matt-glass-2b941a6");
    expect(row).toBeDefined();
    expect((row?.timestamps.posts?.length ?? 0) + (row?.timestamps.reposts?.length ?? 0)).toBeGreaterThan(0);
  });
  it("maps comments from created_at.timestamp and preserves the error-row issue", () => {
    const result = actorRegistry.comments.normalizeOutput(comments);
    expect(result.rows.get("matt-glass-2b941a6")?.timestamps.comments?.length).toBeGreaterThan(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it("maps reactions from timestamps.timestamp and handles nullable article/profile picture", () => {
    const result = actorRegistry.reactions.normalizeOutput(reactions);
    expect(result.rows.get("matt-glass-2b941a6")?.timestamps.reactions?.length).toBeGreaterThan(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it("uses the observed Apify input key and independent actor pricing", () => {
    expect(actorRegistry.posts.buildInput(["https://www.linkedin.com/in/example"], {})).toEqual({ usernames: ["https://www.linkedin.com/in/example"], limit: 100 });
    expect(actorRegistry.posts.costPerResultUsd).toBe(0.005);
    expect(actorRegistry.comments.costPerResultUsd).toBe(0.0012);
    expect(actorRegistry.reactions.costPerResultUsd).toBe(0.005);
  });
});
