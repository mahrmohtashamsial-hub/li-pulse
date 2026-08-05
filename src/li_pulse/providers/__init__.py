from __future__ import annotations

import httpx

from li_pulse.config import ProviderConfig
from li_pulse.providers.base import ProfileProvider
from li_pulse.providers.generic import ApifyProvider, BrightDataProvider, MockProvider

PROVIDERS: dict[str, type[ProfileProvider]] = {
    "apify": ApifyProvider,
    "brightdata": BrightDataProvider,
    "mock": MockProvider,
}


def create_provider(name: str, config: ProviderConfig, api_key: str, client: httpx.AsyncClient) -> ProfileProvider:
    try:
        return PROVIDERS[name](config, api_key, client)
    except KeyError as exc:
        raise ValueError(f"unknown provider: {name}") from exc
