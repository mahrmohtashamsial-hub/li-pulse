"""Run the three-profile demo with an in-process mocked provider (zero network calls)."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from li_pulse.config import AppConfig, ProviderConfig
from li_pulse.core import read_and_validate, run_pipeline


async def main() -> None:
    now = datetime.now(timezone.utc)
    fixtures = {
        "ada-lovelace": {"posts": [(now - timedelta(days=3)).isoformat()], "reposts": [], "comments": [], "headline": "Mathematician", "company": "Analytical Engines"},
        "grace-hopper": {"posts": [(now - timedelta(days=40)).isoformat()], "reposts": [], "comments": None, "headline": "Computer pioneer", "company": "US Navy"},
        "linustorvalds": {"posts": [], "reposts": [], "comments": [], "headline": "Software engineer", "company": "Linux Foundation"},
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        slug = str(request.url.params["url"]).rstrip("/").split("/")[-1]
        return httpx.Response(200, json=fixtures[slug])

    config = AppConfig(provider="mock", providers={
        "mock": ProviderConfig(api_key_env="MOCK_API_KEY", base_url="https://mock.li-pulse.test", cost_per_profile_usd=0)
    })
    rows, _ = read_and_validate(Path("examples/prospects.csv"))
    output = Path("examples/demo_activity.csv")
    output.unlink(missing_ok=True)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        results = await run_pipeline(rows, output, config, "mock", "demo", force_refresh=True, client=client)
    print(f"Wrote {len(results)} rows to {output}")
    for row in results:
        print(f"{row['name']}: {row['activity_tier']} — {row['activity_note']}")


if __name__ == "__main__":
    asyncio.run(main())

