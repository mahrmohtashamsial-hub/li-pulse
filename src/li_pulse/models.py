from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ActivityTier(StrEnum):
    ACTIVE = "ACTIVE"
    OCCASIONAL = "OCCASIONAL"
    DORMANT = "DORMANT"
    INACTIVE = "INACTIVE"
    UNKNOWN = "UNKNOWN"


class ActivityEvent(BaseModel):
    kind: str
    occurred_at: datetime


class ProviderProfile(BaseModel):
    """Provider-neutral, validated response."""

    linkedin_url: str
    activities: list[ActivityEvent] | None = None
    posts: list[datetime] | None = None
    reposts: list[datetime] | None = None
    comments: list[datetime] | None = None
    reactions: list[datetime] | None = None
    follower_count: int | None = None
    connection_count: int | None = None
    headline: str | None = None
    current_company: str | None = None
    current_title: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict, exclude=True)


class OutputMetrics(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    last_activity_date: str | None = None
    days_since_last_activity: int | None = None
    posts_last_30d: int | None = None
    posts_last_90d: int | None = None
    posts_last_180d: int | None = None
    reposts_last_90d: int | None = None
    comments_last_90d: int | None = None
    reactions_last_90d: int | None = None
    total_activity_last_90d: int | None = None
    follower_count: int | None = None
    connection_count: int | None = None
    headline: str | None = None
    current_company: str | None = None
    current_title: str | None = None
    activity_tier: ActivityTier
    activity_note: str
    fetch_error: str | None = None


class ValidationIssue(BaseModel):
    row_number: int
    linkedin_url: str | None
    reason: str


class RunProgress(BaseModel):
    completed: int
    total: int
    tiers: dict[str, int]
    latest_url: str

