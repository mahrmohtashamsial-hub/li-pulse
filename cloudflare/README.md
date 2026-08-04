# li-pulse on Cloudflare

The hosted edition uses a Cloudflare Worker, static assets, D1, Turnstile, Apify
webhooks, and a two-minute Cron fallback. It launches one batch run for every
selected actor, not one run per LinkedIn profile.

## Job API

- `POST /api/jobs` validates rows, creates the D1 job, and returns HTTP 202.
- `POST /api/webhooks/apify/:job_id` processes terminal Apify events idempotently.
- `GET /api/jobs/:job_id` returns status, progress, actor statuses, and partial rows.
- `GET /api/jobs/:job_id/export?format=csv` exports currently merged rows.
- The scheduled handler polls running jobs every two minutes and marks jobs stale
  after `JOB_MAX_DURATION_MINUTES` (30 by default).

A job completes when all selected actors reach a terminal state. One failed actor
does not fail the job. Missing actor data is represented by null metrics,
`data_completeness`, and `notes`; it is never silently converted to zero activity.

## Actor registry

`src/actors/registry.ts` contains one adapter per observed output contract. The
current adapters are:

| Key | Actor | Input | Default limit | Price used for estimate |
| --- | --- | --- | ---: | ---: |
| posts | `apimaestro~linkedin-batch-profile-posts-scraper` | `usernames` | 100/profile | $0.005/result |
| comments | `apimaestro~linkedin-profile-comments` | `usernames` | 100/profile | $0.0012/result* |
| reactions | `apimaestro~linkedin-profile-reactions` | `usernames` | 100/profile | $0.005/result |

\* The configured comments price was supplied for the target account. The public
Store page showed a different price during implementation, so pricing remains
editable and should be reviewed before each run.

To add an actor, add one registry entry containing its actor ID, exact input builder,
sample-derived Zod output schema, normalizer, and per-result cost. Add a verbatim
dataset export under `tests/fixtures/` and a fixture-backed test. The orchestrator
requires no changes. An actor with a new output shape cannot safely reuse another
adapter merely because it provides similar data.

The web UI accepts one to ten independent Actor instances. Operators can add,
disable, or replace Actor URLs, including multiple Actors using the same activity
adapter. Actor Store URLs, console URLs, `owner/actor`, and `owner~actor` are
accepted. Limits and cost per 1,000 results are editable per instance. The chosen
actor must match its selected fixture-backed output adapter. A completely different
output shape still requires a new real fixture and adapter; li-pulse intentionally
does not guess JSON field names.

No supplied fixture contains profile details, so `name`, `headline`, `company`,
`title`, and `follower_count` remain null with an explicit note. Add a profile actor
only after saving and mapping a real output fixture.

## Secrets

Copy `.dev.vars.example` to `.dev.vars` for local development. Never commit it.

Production secrets:

```bash
wrangler secret put APP_PASSWORD
wrangler secret put APIFY_TOKEN
wrangler secret put APIFY_WEBHOOK_SECRET
```

`APP_PASSWORD` protects the complete web interface and every API route except the
public health check and the independently authenticated Apify webhook. Use a long,
unique team password. Successful logins receive a signed, HttpOnly, Secure,
SameSite=Strict cookie that expires after 12 hours; changing `APP_PASSWORD`
immediately invalidates existing sessions. The login form is protected by the
existing Turnstile binding. If `APP_PASSWORD` is missing, the Worker fails closed
with HTTP 503 instead of exposing the application.

Keep the existing `TURNSTILE_SECRET` binding. `APIFY_WEBHOOK_SECRET` should be a
long random value. It authenticates single-use webhook URLs and is not an Apify API
token.

The browser can supply a BYOK Apify token. It is used only while launching runs and
is never persisted. Webhook processing subsequently reads the run dataset without
credentials, then falls back to the server `APIFY_TOKEN`. A private dataset created
with a BYOK token that the server account cannot access will be reported as an actor
failure; the customer token is not stored to work around that restriction.

## Local development

```bash
pnpm install
pnpm db:local
pnpm dev
```

Apify must reach the webhook endpoint, so expose the local Worker with a tunnel such
as Cloudflare Quick Tunnel and submit jobs through that public origin. Turnstile
test keys should be used locally.

Run checks:

```bash
pnpm typecheck
pnpm test
```

## Production deployment

Apply migrations before deploying code that uses the new tables:

```bash
pnpm db:remote
pnpm deploy
```

With Git-connected Workers, apply the migration manually first, then push the code;
Cloudflare will deploy from `main`. Confirm the Cron trigger appears under Worker
triggers after deployment.
