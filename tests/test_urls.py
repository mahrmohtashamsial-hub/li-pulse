import pytest

from li_pulse.urls import normalize_linkedin_url


def test_normalizes_query_slash_and_locale() -> None:
    assert normalize_linkedin_url("linkedin.com/en-us/in/Ada-Lovelace/?trk=foo") == "https://www.linkedin.com/in/Ada-Lovelace"


@pytest.mark.parametrize("url", ["https://linkedin.com/company/openai", "nope", "https://example.com/in/person"])
def test_rejects_bad_rows(url: str) -> None:
    with pytest.raises(ValueError):
        normalize_linkedin_url(url)

