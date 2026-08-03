from __future__ import annotations

import re
from urllib.parse import unquote, urlparse

LOCALE_RE = re.compile(r"^[a-z]{2}(?:-[a-z]{2})?$", re.IGNORECASE)


def normalize_linkedin_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing URL")
    raw = value.strip()
    if "://" not in raw:
        raw = "https://" + raw
    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    if host not in {"linkedin.com", "www.linkedin.com"}:
        raise ValueError("not a LinkedIn URL")
    segments = [unquote(part) for part in parsed.path.split("/") if part]
    if len(segments) >= 3 and LOCALE_RE.fullmatch(segments[0]) and segments[1].lower() == "in":
        segments.pop(0)
    if len(segments) < 2:
        raise ValueError("not a profile URL")
    if segments[0].lower() in {"company", "school", "showcase"}:
        raise ValueError("company page")
    if segments[0].lower() != "in":
        raise ValueError("not a personal profile URL")
    slug = segments[1].strip()
    if not slug or not re.fullmatch(r"[A-Za-z0-9_%.-]+", slug):
        raise ValueError("malformed profile slug")
    return f"https://www.linkedin.com/in/{slug}"


def profile_slug(url: str) -> str:
    return url.rstrip("/").split("/")[-1].lower()
