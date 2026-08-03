from __future__ import annotations

import csv
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
import respx

from li_pulse.config import AppConfig, ProviderConfig
from li_pulse.core import Cache, build_metrics, fetch_with_retry, read_and_validate
from li_pulse.models import ActivityEvent, ProviderProfile
from li_pulse.providers.generic import MockProvider


def config() -> AppConfig:
    return AppConfig(providers={"mock": ProviderConfig(api_key_env="MOCK_API_KEY", base_url="https://mock.li-pulse.test", cost_per_profile_usd=0)})


def test_bad_rows_and_dedupe(tmp_path: Path) -> None:
    path = tmp_path / "in.csv"
    path.write_text("name,linkedin_url\na,linkedin.com/in/a\nb,linkedin.com/in/a/?x=1\nc,linkedin.com/company/acme\n", encoding="utf-8")
    rows, issues = read_and_validate(path)
    assert len(rows) == 1
    assert {issue.reason for issue in issues} == {"duplicate profile", "company page"}
    assert rows[0]["name"] == "a"


def test_cache_hit_and_miss(tmp_path: Path) -> None:
    cache = Cache(tmp_path)
    url = "https://www.linkedin.com/in/ada"
    assert cache.load(url, 14) is None
    cache.save(url, {"headline": "Math"})
    assert cache.load(url, 14) == {"headline": "Math"}
    old = datetime.now().timestamp() - 2 * 86400
    os.utime(cache.path_for(url), (old, old))
    assert cache.load(url, 1) is None
    assert cache.load(url, 14, force=True) is None


@pytest.mark.asyncio
@respx.mock
async def test_retry_logic_respects_retry_after() -> None:
    route = respx.get("https://mock.li-pulse.test/profile").mock(side_effect=[
        httpx.Response(429, headers={"Retry-After": "0"}),
        httpx.Response(500),
        httpx.Response(200, json={"posts": []}),
    ])
    sleeps: list[float] = []
    async def fake_sleep(value: float) -> None:
        sleeps.append(value)
    async with httpx.AsyncClient() as client:
        provider = MockProvider(config().providers["mock"], "key", client)
        result = await fetch_with_retry(provider, "https://www.linkedin.com/in/ada", sleep=fake_sleep)
    assert route.call_count == 3
    assert sleeps[0] == 0
    assert result.posts == []


def test_missing_comment_data_is_null_not_guessed() -> None:
    now = datetime.now(timezone.utc)
    profile = ProviderProfile(
        linkedin_url="https://www.linkedin.com/in/ada",
        activities=[ActivityEvent(kind="post", occurred_at=now - timedelta(days=4))],
        posts=[now - timedelta(days=4)], reposts=[], comments=None, reactions=None,
    )
    metrics = build_metrics(profile, config(), now)
    assert metrics.comments_last_90d is None
    assert metrics.reactions_last_90d is None
    assert metrics.total_activity_last_90d == 1
    assert metrics.activity_tier == "ACTIVE"

