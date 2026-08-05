# li-pulse

`li-pulse` helps BDR teams decide whether LinkedIn is a worthwhile outreach channel for each prospect. It fetches profile/activity data through a third-party provider API, never through browser automation, LinkedIn cookies, or a LinkedIn session.

## What it does

- Validates and canonicalizes personal LinkedIn URLs, removes locale prefixes/query strings/trailing slashes, rejects company pages, and deduplicates before any API request.
- Fetches concurrently with a configurable semaphore (default 5), retries 429/5xx responses up to four attempts with jittered exponential backoff, and honors numeric `Retry-After` headers.
- Caches provider JSON under `data/raw/`, incrementally appends output, resumes completed output rows, and logs every attempted profile under `logs/`.
- Preserves every input CSV column and adds activity metrics, match-check fields, a configurable tier, and a scan-friendly note.
- Keeps unknown provider fields genuinely unknown: missing comment/reaction data stays blank rather than being inferred.

## Setup

Python 3.11+ is required.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
copy .env.example .env  # use cp on macOS/Linux
```

Put the selected provider key in `.env`. The file is gitignored. Configure the selected provider, per-profile price, confirmation threshold, and tiers in `config.yaml`.

Provider signup/documentation:

- [Apify LinkedIn actors](https://apify.com/store?search=linkedin%20profile) — actor pricing varies; set the actor ID and its effective per-profile price in `config.yaml`.
- [Bright Data LinkedIn datasets](https://brightdata.com/products/datasets/linkedin) — plan/dataset pricing varies; set your dataset ID and effective per-profile price.

The shipped `$0.01` values are placeholders for estimation, not vendor quotes. Confirm current vendor pricing and update `cost_per_profile_usd` before a production run. Provider response shapes/actor schemas can differ; the swappable adapters live in `src/li_pulse/providers/`, and their neutral contract is `ProviderProfile`.

## CLI

```bash
li-pulse validate --input prospects.csv
li-pulse run --input prospects.csv --output activity.csv --concurrency 5
li-pulse run --input prospects.csv --output activity.csv --max-age-days 14 --force-refresh
li-pulse summary --input activity.csv
```

`validate` makes zero API calls. `run` displays estimated maximum cost and asks for confirmation above `confirm_cost_above_usd`; use `--yes` for an intentional noninteractive run. Re-running against the same output skips URLs already written.

Tiers come solely from `config.yaml`: ACTIVE through 14 days, OCCASIONAL through 60, DORMANT through 180, INACTIVE beyond 180 (including an explicitly returned empty activity list), and UNKNOWN for failed fetches or absent activity data.

## Streamlit UI

```bash
streamlit run app.py
```

## Cloudflare hosted edition

The `cloudflare/` directory contains the public, zero-budget hosted edition using Workers Static Assets and D1. It uses a BYOK model so provider credentials are used for one run and never stored. See `cloudflare/README.md` for deployment commands.

Upload a CSV, inspect validation results and estimated cost, tune provider/concurrency/cache/tier settings, then start. Results can be filtered/sorted and downloaded as CSV or XLSX. The provider key is read from `.env`; when absent, a masked sidebar field appears.

## Mocked demo and tests

The demo uses `httpx.MockTransport`, makes no network calls, and produces three representative classifications:

```bash
python scripts/demo.py
pytest
```

Input is `examples/prospects.csv`; output is `examples/demo_activity.csv`. Tests use `respx` and cover normalization, bad/company/duplicate rows, retry behavior, cache hit/miss/override, missing comment/reaction data, and the three-profile pipeline.

## Output fields

Alongside all original columns: `last_activity_date`, `days_since_last_activity`, post counts for 30/90/180 days, repost/comment/reaction counts, available activity total, follower/connection counts, headline/company/title, `activity_tier`, `activity_note`, and `fetch_error`. A blank count means the provider did not expose that activity type.
