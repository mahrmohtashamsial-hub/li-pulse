from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import httpx

from li_pulse.config import ProviderConfig
from li_pulse.models import ProviderProfile


class ProviderError(RuntimeError):
    pass


class RetriableProviderError(ProviderError):
    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ProfileProvider(ABC):
    def __init__(self, config: ProviderConfig, api_key: str, client: httpx.AsyncClient) -> None:
        self.config = config
        self.api_key = api_key
        self.client = client

    @abstractmethod
    async def fetch_raw(self, linkedin_url: str) -> dict[str, Any]: ...

    @abstractmethod
    def parse(self, raw: dict[str, Any], linkedin_url: str) -> ProviderProfile: ...

    async def fetch(self, linkedin_url: str) -> ProviderProfile:
        raw = await self.fetch_raw(linkedin_url)
        profile = self.parse(raw, linkedin_url)
        profile.raw = raw
        return profile

    @staticmethod
    def check_response(response: httpx.Response) -> None:
        if response.status_code == 429 or 500 <= response.status_code < 600:
            retry = response.headers.get("Retry-After")
            try:
                retry_after = float(retry) if retry else None
            except ValueError:
                retry_after = None
            raise RetriableProviderError(f"HTTP {response.status_code}", retry_after)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ProviderError(f"HTTP {response.status_code}: {response.text[:200]}") from exc

