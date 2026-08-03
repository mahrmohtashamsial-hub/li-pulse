from __future__ import annotations

import asyncio
import io
import os
import tempfile
from pathlib import Path

import pandas as pd
import streamlit as st
from dotenv import load_dotenv

from li_pulse.config import TierConfig, load_config
from li_pulse.core import api_key_for, read_and_validate, run_pipeline

load_dotenv()
st.set_page_config(page_title="li-pulse", layout="wide")
st.title("li-pulse")
st.caption("LinkedIn activity classification through approved third-party data APIs—no browser scraping or session cookies.")
config = load_config()

with st.sidebar:
    st.header("Run settings")
    provider = st.selectbox("Provider", list(config.providers), index=list(config.providers).index(config.provider))
    concurrency = st.slider("Concurrency", 1, 20, config.workers)
    max_age = st.number_input("Cache max-age (days)", 0, 365, config.max_age_days)
    st.subheader("Tier thresholds")
    active = st.number_input("ACTIVE max days", 0, 365, config.tiers.active_max_days)
    occasional = st.number_input("OCCASIONAL max days", 1, 730, config.tiers.occasional_max_days)
    dormant = st.number_input("DORMANT max days", 2, 2000, config.tiers.dormant_max_days)
    env_key = api_key_for(config, provider)
    supplied_key = st.text_input("API key", type="password", disabled=bool(env_key), help=f"Uses {config.providers[provider].api_key_env} from .env when set")

uploaded = st.file_uploader("Upload prospects CSV", type="csv")
if uploaded:
    payload = uploaded.getvalue()
    try:
        preview = pd.read_csv(io.BytesIO(payload))
        st.subheader("Preview")
        st.dataframe(preview.head(5), use_container_width=True)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "input.csv"
            source.write_bytes(payload)
            rows, issues = read_and_validate(source)
        st.success(f"{len(rows)} valid unique URLs; {len(issues)} skipped")
        if issues:
            st.dataframe(pd.DataFrame([item.model_dump() for item in issues]), use_container_width=True)
        estimated = len(rows) * config.providers[provider].cost_per_profile_usd
        st.metric("Estimated maximum cost", f"${estimated:.2f}")
        thresholds_ok = active < occasional < dormant
        if not thresholds_ok:
            st.error("Tier thresholds must be strictly increasing.")
        key = env_key or supplied_key
        if st.button("Start", type="primary", disabled=not rows or not key or not thresholds_ok):
            config.tiers = TierConfig(active_max_days=active, occasional_max_days=occasional, dormant_max_days=dormant)
            progress_bar = st.progress(0)
            status = st.empty()
            counts = st.empty()
            with tempfile.TemporaryDirectory() as tmp:
                result_path = Path(tmp) / "activity.csv"
                def on_progress(state: object) -> None:
                    progress_bar.progress(state.completed / state.total if state.total else 1.0)
                    status.write(f"Processed {state.completed}/{state.total}: {state.latest_url}")
                    counts.write(" · ".join(f"{tier}: {state.tiers.get(tier, 0)}" for tier in ("ACTIVE", "OCCASIONAL", "DORMANT", "INACTIVE")))
                asyncio.run(run_pipeline(rows, result_path, config, provider, key, int(concurrency), int(max_age), progress=on_progress, validation_issues=issues))
                result_bytes = result_path.read_bytes()
            result = pd.read_csv(io.BytesIO(result_bytes))
            st.session_state["results"] = result
            st.session_state["csv"] = result_bytes
    except Exception as exc:
        st.error(str(exc))

if "results" in st.session_state:
    st.subheader("Results")
    result = st.session_state["results"]
    selected = st.multiselect("Filter tiers", sorted(result["activity_tier"].dropna().unique()), default=sorted(result["activity_tier"].dropna().unique()))
    shown = result[result["activity_tier"].isin(selected)].sort_values("days_since_last_activity", na_position="last")
    st.dataframe(shown, use_container_width=True)
    xlsx = io.BytesIO()
    with pd.ExcelWriter(xlsx, engine="openpyxl") as writer:
        shown.to_excel(writer, index=False, sheet_name="activity")
    col1, col2 = st.columns(2)
    col1.download_button("Download CSV", shown.to_csv(index=False).encode(), "activity.csv", "text/csv")
    col2.download_button("Download XLSX", xlsx.getvalue(), "activity.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
