from __future__ import annotations

from datetime import datetime
from typing import Any

from li_pulse.models import ActivityEvent, ProviderProfile
from li_pulse.providers.base import ProfileProvider


def _dates(values: Any) -> list[datetime] | None:
    if values is None:
        return None
    result: list[datetime] = []
    for item in values:
        value = item.get("date") if isinstance(item, dict) else item
        if value:
            result.append(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    return result


def parse_common(raw: dict[str, Any], linkedin_url: str) -> ProviderProfile:
    data = raw.get("data", raw)
    posts = _dates(data.get("posts"))
    reposts = _dates(data.get("reposts"))
    comments = _dates(data.get("comments"))
    reactions = _dates(data.get("reactions"))
    activities = []
    for kind, dates in (("post", posts), ("repost", reposts), ("comment", comments)):
        activities.extend(ActivityEvent(kind=kind, occurred_at=date) for date in dates or [])
    return ProviderProfile(
        linkedin_url=linkedin_url,
        activities=activities if any(x is not None for x in (posts, reposts, comments)) else None,
        posts=posts,
        reposts=reposts,
        comments=comments,
        reactions=reactions,
        follower_count=data.get("follower_count", data.get("followers")),
        connection_count=data.get("connection_count", data.get("connections")),
        headline=data.get("headline"),
        current_company=data.get("current_company", data.get("company")),
        current_title=data.get("current_title", data.get("title")),
    )


class ApifyProvider(ProfileProvider):
    async def fetch_raw(self, linkedin_url: str) -> dict[str, Any]:
        actor = self.config.actor_id or ""
        url = f"{self.config.base_url}/acts/{actor}/run-sync-get-dataset-items"
        response = await self.client.post(url, params={"token": self.api_key}, json={"profileUrls": [linkedin_url]})
        self.check_response(response)
        body = response.json()
        return body[0] if isinstance(body, list) and body else {}

    def parse(self, raw: dict[str, Any], linkedin_url: str) -> ProviderProfile:
        return parse_common(raw, linkedin_url)


class BrightDataProvider(ProfileProvider):
    async def fetch_raw(self, linkedin_url: str) -> dict[str, Any]:
        url = f"{self.config.base_url}/datasets/v3/scrape"
        response = await self.client.post(url, params={"dataset_id": self.config.dataset_id, "format": "json"}, headers={"Authorization": f"Bearer {self.api_key}"}, json={"url": linkedin_url})
        self.check_response(response)
        return response.json()

    def parse(self, raw: dict[str, Any], linkedin_url: str) -> ProviderProfile:
        return parse_common(raw, linkedin_url)


class ProxycurlProvider(ProfileProvider):
    async def fetch_raw(self, linkedin_url: str) -> dict[str, Any]:
        response = await self.client.get(f"{self.config.base_url}/v2/linkedin", params={"url": linkedin_url}, headers={"Authorization": f"Bearer {self.api_key}"})
        self.check_response(response)
        return response.json()

    def parse(self, raw: dict[str, Any], linkedin_url: str) -> ProviderProfile:
        return parse_common(raw, linkedin_url)


class MockProvider(ProfileProvider):
    async def fetch_raw(self, linkedin_url: str) -> dict[str, Any]:
        response = await self.client.get(f"{self.config.base_url}/profile", params={"url": linkedin_url}, headers={"Authorization": f"Bearer {self.api_key}"})
        self.check_response(response)
        return response.json()

    def parse(self, raw: dict[str, Any], linkedin_url: str) -> ProviderProfile:
        return parse_common(raw, linkedin_url)

