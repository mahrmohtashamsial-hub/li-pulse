from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
import respx

from li_pulse.config import AppConfig, ProviderConfig
from li_pulse.core import run_pipeline


@pytest.mark.asyncio
@respx.mock
async def test_mocked_three_profile_demo(tmp_path: Path) -> None:
    now = datetime.now(timezone.utc)
    payloads = [
        {"posts": [(now - timedelta(days=3)).isoformat()], "comments": [], "reposts": [], "headline": "Active"},
        {"posts": [(now - timedelta(days=40)).isoformat()], "comments": None, "reposts": [], "headline": "Occasional"},
        {"posts": [], "comments": [], "reposts": [], "headline": "Inactive"},
    ]
    route = respx.get("https://mock.li-pulse.test/profile").mock(side_effect=[httpx.Response(200, json=p) for p in payloads])
    cfg = AppConfig(provider="mock", providers={"mock": ProviderConfig(api_key_env="MOCK_API_KEY", base_url="https://mock.li-pulse.test", cost_per_profile_usd=0)})
    rows = [{"name": name, "linkedin_url": f"https://www.linkedin.com/in/{name.lower()}"} for name in ("Ada", "Grace", "Linus")]
    async with httpx.AsyncClient() as client:
        results = await run_pipeline(rows, tmp_path / "activity.csv", cfg, "mock", "demo", cache_dir=tmp_path / "raw", log_dir=tmp_path / "logs", client=client)
    assert route.call_count == 3
    assert {row["activity_tier"] for row in results} == {"ACTIVE", "OCCASIONAL", "INACTIVE"}
    assert (tmp_path / "activity.csv").exists()

