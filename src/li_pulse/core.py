from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import random
from collections import Counter
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from li_pulse.config import AppConfig
from li_pulse.models import ActivityTier, OutputMetrics, ProviderProfile, RunProgress, ValidationIssue
from li_pulse.providers import create_provider
from li_pulse.providers.base import ProviderError, RetriableProviderError
from li_pulse.urls import normalize_linkedin_url, profile_slug

OUTPUT_FIELDS = list(OutputMetrics.model_fields)


def read_and_validate(path: Path) -> tuple[list[dict[str, str]], list[ValidationIssue]]:
    valid: list[dict[str, str]] = []
    issues: list[ValidationIssue] = []
    seen: set[str] = set()
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or "linkedin_url" not in reader.fieldnames:
            raise ValueError("input CSV must contain a linkedin_url column")
        for row_number, row in enumerate(reader, start=2):
            raw = row.get("linkedin_url")
            try:
                normalized = normalize_linkedin_url(raw)
            except ValueError as exc:
                issues.append(ValidationIssue(row_number=row_number, linkedin_url=raw, reason=str(exc)))
                continue
            dedupe_key = normalized.casefold()
            if dedupe_key in seen:
                issues.append(ValidationIssue(row_number=row_number, linkedin_url=raw, reason="duplicate profile"))
                continue
            seen.add(dedupe_key)
            row["linkedin_url"] = normalized
            valid.append(row)
    return valid, issues


def classify(days: int | None, has_activity_data: bool, config: AppConfig) -> ActivityTier:
    if not has_activity_data:
        return ActivityTier.UNKNOWN
    if days is None or days > config.tiers.dormant_max_days:
        return ActivityTier.INACTIVE
    if days <= config.tiers.active_max_days:
        return ActivityTier.ACTIVE
    if days <= config.tiers.occasional_max_days:
        return ActivityTier.OCCASIONAL
    return ActivityTier.DORMANT


def _within(values: list[datetime] | None, days: int, now: datetime) -> int | None:
    if values is None:
        return None
    return sum(0 <= (now - value.astimezone(timezone.utc)).days <= days for value in values)


def build_metrics(profile: ProviderProfile, config: AppConfig, now: datetime | None = None) -> OutputMetrics:
    now = now or datetime.now(timezone.utc)
    activities = profile.activities
    newest = max((a.occurred_at for a in activities or []), default=None)
    days = max(0, (now - newest.astimezone(timezone.utc)).days) if newest else None
    p30, p90, p180 = (_within(profile.posts, n, now) for n in (30, 90, 180))
    r90 = _within(profile.reposts, 90, now)
    c90 = _within(profile.comments, 90, now)
    react90 = _within(profile.reactions, 90, now)
    available = [value for value in (p90, r90, c90, react90) if value is not None]
    total = sum(available) if available else None
    tier = classify(days, activities is not None, config)
    if tier == ActivityTier.UNKNOWN:
        note = "No activity data returned"
    elif days is None:
        note = f"No activity in last {config.tiers.dormant_max_days}d"
    else:
        parts = []
        if p30 is not None:
            parts.append(f"Posted {p30}x in last 30d")
        parts.append(f"last active {days} day{'s' if days != 1 else ''} ago")
        note = ", ".join(parts)
    return OutputMetrics(
        last_activity_date=newest.astimezone(timezone.utc).date().isoformat() if newest else None,
        days_since_last_activity=days, posts_last_30d=p30, posts_last_90d=p90,
        posts_last_180d=p180, reposts_last_90d=r90, comments_last_90d=c90,
        reactions_last_90d=react90, total_activity_last_90d=total,
        follower_count=profile.follower_count, connection_count=profile.connection_count,
        headline=profile.headline, current_company=profile.current_company,
        current_title=profile.current_title, activity_tier=tier, activity_note=note,
    )


class Cache:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, url: str) -> Path:
        return self.root / f"{profile_slug(url)}.json"

    def load(self, url: str, max_age_days: int, force: bool = False) -> dict[str, Any] | None:
        path = self.path_for(url)
        if force or not path.exists():
            return None
        age = datetime.now(timezone.utc).timestamp() - path.stat().st_mtime
        if age > max_age_days * 86400:
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, url: str, raw: dict[str, Any]) -> None:
        self.path_for(url).write_text(json.dumps(raw, indent=2, default=str), encoding="utf-8")


async def fetch_with_retry(provider: Any, url: str, attempts: int = 4, sleep: Callable[[float], Any] = asyncio.sleep) -> ProviderProfile:
    for attempt in range(attempts):
        try:
            return await provider.fetch(url)
        except (RetriableProviderError, httpx.TransportError) as exc:
            if attempt == attempts - 1:
                raise
            retry_after = getattr(exc, "retry_after", None)
            delay = retry_after if retry_after is not None else (2 ** attempt + random.uniform(0, 0.5))
            await sleep(delay)
    raise RuntimeError("unreachable")


def _completed_urls(output: Path) -> set[str]:
    if not output.exists() or output.stat().st_size == 0:
        return set()
    with output.open(newline="", encoding="utf-8-sig") as handle:
        return {row["linkedin_url"] for row in csv.DictReader(handle) if row.get("linkedin_url")}


async def run_pipeline(
    rows: list[dict[str, str]], output: Path, config: AppConfig, provider_name: str,
    api_key: str, concurrency: int = 5, max_age_days: int = 14, force_refresh: bool = False,
    progress: Callable[[RunProgress], None] | None = None, cache_dir: Path = Path("data/raw"),
    log_dir: Path = Path("logs"), client: httpx.AsyncClient | None = None,
    validation_issues: list[ValidationIssue] | None = None,
) -> list[dict[str, Any]]:
    output.parent.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(f"li_pulse.{id(rows)}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = logging.FileHandler(log_dir / f"run_{datetime.now():%Y%m%d_%H%M%S}.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    for issue in validation_issues or []:
        logger.warning("row=%s url=%s status=skipped reason=%s", issue.row_number, issue.linkedin_url or "", issue.reason)
    completed = _completed_urls(output)
    pending = [row for row in rows if row["linkedin_url"] not in completed]
    if not pending:
        handler.close()
        logger.removeHandler(handler)
        return []
    fieldnames = list(rows[0]) + [field for field in OUTPUT_FIELDS if field not in rows[0]]
    write_header = not output.exists() or output.stat().st_size == 0
    cache = Cache(cache_dir)
    semaphore = asyncio.Semaphore(concurrency)
    tiers: Counter[str] = Counter()
    results: list[dict[str, Any]] = []
    owned_client = client is None
    http_client = client or httpx.AsyncClient(timeout=60)
    provider = create_provider(provider_name, config.providers[provider_name], api_key, http_client)
    lock = asyncio.Lock()

    async def process(row: dict[str, str]) -> None:
        url = row["linkedin_url"]
        try:
            async with semaphore:
                raw = cache.load(url, max_age_days, force_refresh)
                source = "cache"
                if raw is None:
                    source = "api"
                    profile = await fetch_with_retry(provider, url)
                    raw = profile.raw
                    cache.save(url, raw)
                else:
                    profile = provider.parse(raw, url)
            metrics = build_metrics(profile, config)
            logger.info("url=%s status=ok source=%s tier=%s", url, source, metrics.activity_tier)
        except Exception as exc:
            metrics = OutputMetrics(activity_tier=ActivityTier.UNKNOWN, activity_note="Fetch failed", fetch_error=str(exc)[:250])
            logger.error("url=%s status=failed error=%s", url, exc)
        result = {**row, **metrics.model_dump(mode="json")}
        async with lock:
            with output.open("a", newline="", encoding="utf-8-sig") as handle:
                writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
                nonlocal write_header
                if write_header:
                    writer.writeheader()
                    write_header = False
                writer.writerow(result)
                handle.flush()
            results.append(result)
            tiers[str(metrics.activity_tier)] += 1
            if progress:
                progress(RunProgress(completed=len(results), total=len(pending), tiers=dict(tiers), latest_url=url))

    try:
        await asyncio.gather(*(process(row) for row in pending))
    finally:
        if owned_client:
            await http_client.aclose()
        handler.close()
        logger.removeHandler(handler)
    return results


def api_key_for(config: AppConfig, provider_name: str, fallback: str | None = None) -> str:
    return os.getenv(config.providers[provider_name].api_key_env) or fallback or ""
