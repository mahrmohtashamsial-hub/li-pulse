# Actor fixture mapping

These files are verbatim Apify dataset exports from real runs. They are intentionally
not reduced so schema drift can be tested against the full observed payload.

## `posts.json`

- Join field: `profile_input` (successful post rows only).
- Timestamp: `posted_at.timestamp` (observed as epoch milliseconds).
- `post_type`: observed values are `regular`, `quote`, and `repost`.
- Mapping: `repost` increments reposts; `regular` and `quote` increment posts.
- The dataset also contains a batch summary row with `timestamp`, `summary`, and
  `results`; it has no profile join key and is not an activity row.
- Nullable/optional observed fields include `urn.share_urn`, `urn.ugcPost_urn`,
  `author.last_name`, `author.profile_picture`, `author.company_urn`, `media`,
  `media.images`, `article`, `text_annotations`, and `reshared_post`.

## `comments.json`

- Join field: `source_profile` (observed as the profile slug on successful rows).
- Timestamp: `created_at.timestamp` (observed as epoch milliseconds).
- One error row uses the display name `Matt Glass` in `profileUrl` and
  `source_profile`; it is deliberately reported as a normalization issue because a
  display name is not a safe LinkedIn join key.
- `post.images` is optional and `post.post_author.profile_picture` is sometimes
  null. Error fields (`message`, `errorDetails`) occur only on the error row.

## `reactions.json`

- Join field: `source_profile` (successful rows only).
- Timestamp: `timestamps.timestamp` (observed as epoch milliseconds).
- `article` is either an object or null; `author.profile_picture` is string or null;
  `images` may be empty.
- One error row contains only a display-name input and is deliberately reported as
  a normalization issue.

## Requested merged fields with no observed source

No supplied fixture is a profile-details dataset. Consequently there is no
sample-backed mapping for `name`, the prospect's `headline`, `company`, `title`, or
`follower_count`. Author/commenter fields describe the author of a post or comment,
which is not necessarily the target prospect, so they are not repurposed.

Actor IDs and input contracts are configured from the corresponding Apify Store
pages. Pricing is stored per adapter and remains configurable because Store prices,
discounts, and billing models can change. Each new scraper/output contract needs its
own registry adapter and fixture.
