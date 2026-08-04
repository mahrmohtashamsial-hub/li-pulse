import { z } from "zod";

export type ActivityKind = "posts" | "reposts" | "comments" | "reactions";
export type NormalizedActorRow = {
  profileSlug: string;
  profileUrl: string;
  timestamps: Partial<Record<ActivityKind, string[]>>;
  profile?: { name?: string | null; headline?: string | null; company?: string | null; title?: string | null; followerCount?: number | null };
};
export type NormalizationResult = { rows: Map<string, NormalizedActorRow>; issues: string[] };
export type ActorRuntimeConfig = { actorIds?: Partial<Record<ActorKey, string>>; maxItems?: number };
export type ActorDefinition = {
  key: string;
  adapter: ActorKey;
  label: string;
  actorId: string | null;
  costPerResultUsd: number;
  outputSchema: z.ZodType;
  buildInput(urls: string[], config: ActorRuntimeConfig): unknown;
  normalizeOutput(items: unknown[]): NormalizationResult;
};

const nullableString = z.string().nullable().optional();
const epochObject = z.object({ timestamp: z.number(), formatted: z.string().optional(), relative: z.string().optional() }).passthrough();
const postedAt = z.object({ date: z.string(), relative: z.string(), timestamp: z.number() }).passthrough();
const errorFields = { message: z.string().optional(), errorDetails: z.string().optional() };

export const postOutputSchema = z.object({
  profile_input: z.string().optional(),
  posted_at: postedAt.optional(),
  post_type: z.enum(["regular", "repost", "quote"]).optional(),
  author: z.object({
    first_name: z.string(), last_name: z.string().optional(), headline: z.string(), username: z.string(),
    profile_url: z.string(), profile_picture: nullableString, actor_type: z.string(), company_urn: z.string().optional(),
  }).passthrough().optional(),
  timestamp: z.string().optional(),
  summary: z.object({
    totalProfiles: z.number(), successfulProfiles: z.number(), failedProfiles: z.number(), totalPostsExtracted: z.number(), failedUsernames: z.array(z.string()),
  }).passthrough().optional(),
  results: z.array(z.object({ username: z.string(), success: z.boolean(), error: z.string().optional(), postsCount: z.number(), responseStatus: z.number() }).passthrough()).optional(),
}).passthrough();

export const commentOutputSchema = z.object({
  profileUrl: z.string().optional(), source_profile: z.string().optional(), ...errorFields,
  comment_text: z.string().optional(), comment_urn: z.string().optional(),
  commenter: z.object({ name: z.string(), first_name: z.string(), last_name: z.string(), subtitle: z.string(), linkedin_url: z.string(), profile_picture: nullableString }).passthrough().optional(),
  is_pinned: z.boolean().optional(), created_at: epochObject.optional(),
  post: z.object({
    post_text: z.string(), post_url: z.string(), post_urn: z.string(),
    post_author: z.object({ name: z.string(), first_name: z.string(), last_name: z.string(), headline: z.string(), title: z.string(), linkedin_url: z.string(), profile_picture: nullableString }).passthrough(),
    created_at: epochObject,
  }).passthrough().optional(),
  comment_link: z.string().optional(), page_number: z.number().optional(),
}).passthrough();

export const reactionOutputSchema = z.object({
  profile_input: z.string().optional(), source_profile: z.string().optional(), ...errorFields,
  action: z.string().optional(), text: z.string().optional(), post_url: z.string().optional(),
  author: z.object({ firstName: z.string(), lastName: z.string(), headline: z.string(), profile_url: z.string(), profile_picture: nullableString }).passthrough().optional(),
  timestamps: postedAt.optional(), images: z.array(z.object({ url: z.string(), width: z.number(), height: z.number() }).passthrough()).optional(),
  article: z.object({ title: z.string(), url: z.string(), source: z.string() }).passthrough().nullable().optional(), page_number: z.number().optional(),
}).passthrough();

export function profileSlug(value: string): string | null {
  const trimmed = value.trim();
  const slugOnly = trimmed.match(/^[\w%.~-]+$/) ? trimmed : null;
  if (slugOnly && !slugOnly.includes(" ")) return slugOnly.toLowerCase();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    let parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length > 2 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0]) && parts[1].toLowerCase() === "in") parts = parts.slice(1);
    return parts[0]?.toLowerCase() === "in" && parts[1] ? parts[1].toLowerCase() : null;
  } catch { return null; }
}

export function actorIdFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]+(?:~|\/)[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed.replace("/", "~");
  try {
    const url = new URL(trimmed);
    if (!/(^|\.)apify\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.hostname.toLowerCase() === "console.apify.com" && parts[0] === "actors" && parts[1]) return parts[1];
    if (parts.length >= 2 && !["store", "actors"].includes(parts[0])) return `${parts[0]}~${parts[1]}`;
    if (parts[0] === "store" && parts.length >= 3) return `${parts[1]}~${parts[2]}`;
    return null;
  } catch { return null; }
}

function isoFromEpoch(value: number): string {
  return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
}

function normalize<T>(items: unknown[], schema: z.ZodType<T>, source: (item: T) => string | undefined, activity: (item: T) => Partial<Record<ActivityKind, string[]>>): NormalizationResult {
  const rows = new Map<string, NormalizedActorRow>(); const issues: string[] = [];
  items.forEach((raw, index) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) { issues.push(`item ${index}: output schema mismatch`); return; }
    const sourceValue = source(parsed.data); const slug = sourceValue ? profileSlug(sourceValue) : null;
    if (!slug) { issues.push(`item ${index}: no normalizable profile URL/slug`); return; }
    const current = rows.get(slug) ?? { profileSlug: slug, profileUrl: `https://www.linkedin.com/in/${slug}`, timestamps: {} };
    const next = activity(parsed.data);
    for (const [kind, values] of Object.entries(next) as [ActivityKind, string[]][]) current.timestamps[kind] = [...(current.timestamps[kind] ?? []), ...values];
    rows.set(slug, current);
  });
  return { rows, issues };
}

export type ActorKey = "posts" | "comments" | "reactions";
export const actorRegistry: Record<ActorKey, ActorDefinition> = {
  posts: {
    key: "posts", adapter: "posts", label: "Posts & reposts", actorId: "apimaestro~linkedin-batch-profile-posts-scraper", costPerResultUsd: 0.005,
    outputSchema: postOutputSchema,
    buildInput: (urls, config) => ({ usernames: urls, limit: Math.min(100, config.maxItems ?? 100) }),
    normalizeOutput: (items) => normalize(items, postOutputSchema, (item) => item.profile_input, (item) => {
      if (!item.posted_at || !item.post_type) return {};
      const kind: ActivityKind = item.post_type === "repost" ? "reposts" : "posts";
      return { [kind]: [isoFromEpoch(item.posted_at.timestamp)] };
    }),
  },
  comments: {
    key: "comments", adapter: "comments", label: "Comments given", actorId: "apimaestro~linkedin-profile-comments", costPerResultUsd: 0.0012,
    outputSchema: commentOutputSchema,
    buildInput: (urls, config) => ({ usernames: urls.slice(0, 100), limit: Math.min(3000, config.maxItems ?? 100) }),
    normalizeOutput: (items) => normalize(items, commentOutputSchema, (item) => item.source_profile, (item) => item.created_at ? { comments: [isoFromEpoch(item.created_at.timestamp)] } : {}),
  },
  reactions: {
    key: "reactions", adapter: "reactions", label: "Reactions given", actorId: "apimaestro~linkedin-profile-reactions", costPerResultUsd: 0.005,
    outputSchema: reactionOutputSchema,
    buildInput: (urls, config) => ({ usernames: urls.slice(0, 100), limit: Math.min(100, config.maxItems ?? 100) }),
    normalizeOutput: (items) => normalize(items, reactionOutputSchema, (item) => item.source_profile, (item) => item.timestamps ? { reactions: [isoFromEpoch(item.timestamps.timestamp)] } : {}),
  },
};

export function selectedActors(keys: string[], config: ActorRuntimeConfig): ActorDefinition[] {
  return keys.map((key) => {
    if (!(key in actorRegistry)) throw new Error(`Unknown actor adapter: ${key}`);
    const base = actorRegistry[key as ActorKey];
    const requested = config.actorIds?.[key as ActorKey];
    const actorId = requested ? actorIdFromInput(requested) : base.actorId;
    if (!actorId) throw new Error(`Actor ID required for ${base.key}; it was not present in the supplied dataset sample`);
    return { ...base, actorId };
  });
}

export type ActorSelection = { key: string; adapter: ActorKey; actorId: string; label: string; maxItems: number; costPerResultUsd: number };

export function configuredActors(selections: ActorSelection[]): ActorDefinition[] {
  return selections.map((selection) => {
    const base = actorRegistry[selection.adapter];
    const actorId = actorIdFromInput(selection.actorId);
    if (!actorId) throw new Error(`Invalid Apify Actor URL or ID for ${selection.label}`);
    return { ...base, key: selection.key, adapter: selection.adapter, label: selection.label, actorId, costPerResultUsd: selection.costPerResultUsd };
  });
}
