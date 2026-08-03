from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, model_validator


class TierConfig(BaseModel):
    active_max_days: int = 14
    occasional_max_days: int = 60
    dormant_max_days: int = 180

    @model_validator(mode="after")
    def ordered(self) -> "TierConfig":
        if not (0 <= self.active_max_days < self.occasional_max_days < self.dormant_max_days):
            raise ValueError("tier thresholds must be strictly increasing")
        return self


class ProviderConfig(BaseModel):
    api_key_env: str
    base_url: str
    cost_per_profile_usd: float = Field(ge=0)
    actor_id: str | None = None
    dataset_id: str | None = None


class AppConfig(BaseModel):
    provider: str = "apify"
    workers: int = Field(default=5, ge=1, le=50)
    max_age_days: int = Field(default=14, ge=0)
    confirm_cost_above_usd: float = Field(default=10, ge=0)
    tiers: TierConfig = Field(default_factory=TierConfig)
    providers: dict[str, ProviderConfig]


def load_config(path: Path | str = "config.yaml", overrides: dict[str, Any] | None = None) -> AppConfig:
    with Path(path).open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if overrides:
        for key, value in overrides.items():
            if key.startswith("tiers."):
                data.setdefault("tiers", {})[key.split(".", 1)[1]] = value
            else:
                data[key] = value
    return AppConfig.model_validate(data)

