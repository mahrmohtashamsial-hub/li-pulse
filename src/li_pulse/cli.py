from __future__ import annotations

import asyncio
import csv
from collections import Counter
from pathlib import Path

import typer
from dotenv import load_dotenv
from rich.console import Console
from rich.progress import Progress
from rich.table import Table

from li_pulse.config import load_config
from li_pulse.core import api_key_for, read_and_validate, run_pipeline

app = typer.Typer(help="Classify LinkedIn profile activity without browser scraping.")
console = Console()


@app.command()
def validate(input: Path = typer.Option(..., exists=True, readable=True)) -> None:
    """Validate and normalize profile URLs; makes zero API calls."""
    rows, issues = read_and_validate(input)
    console.print(f"[green]{len(rows)} valid unique profile(s)[/green]; [yellow]{len(issues)} skipped[/yellow]")
    for issue in issues:
        console.print(f"row {issue.row_number}: {issue.reason} ({issue.linkedin_url or ''})")


@app.command("run")
def run_command(
    input: Path = typer.Option(..., exists=True, readable=True), output: Path = typer.Option(...),
    concurrency: int = typer.Option(5, min=1, max=50), max_age_days: int = typer.Option(14, min=0),
    force_refresh: bool = typer.Option(False), provider: str | None = typer.Option(None),
    config_path: Path = typer.Option(Path("config.yaml"), "--config"), yes: bool = typer.Option(False, "--yes"),
) -> None:
    """Fetch profiles and incrementally write activity classifications."""
    load_dotenv()
    config = load_config(config_path)
    provider_name = provider or config.provider
    if provider_name not in config.providers:
        raise typer.BadParameter(f"provider must be one of: {', '.join(config.providers)}")
    rows, issues = read_and_validate(input)
    cost = len(rows) * config.providers[provider_name].cost_per_profile_usd
    console.print(f"{len(rows)} unique valid profile(s), {len(issues)} skipped. Estimated maximum cost: [bold]${cost:.2f}[/bold]")
    if cost > config.confirm_cost_above_usd and not yes and not typer.confirm("Continue?"):
        raise typer.Abort()
    key = api_key_for(config, provider_name)
    if not key:
        raise typer.BadParameter(f"missing {config.providers[provider_name].api_key_env} in .env")
    with Progress() as bar:
        task = bar.add_task("Fetching", total=len(rows))
        def update(state: object) -> None:
            bar.update(task, completed=state.completed, description=f"Fetching {state.completed}/{state.total}")
        asyncio.run(run_pipeline(rows, output, config, provider_name, key, concurrency, max_age_days, force_refresh, update, validation_issues=issues))
    console.print(f"[green]Done:[/green] {output}")


@app.command()
def summary(input: Path = typer.Option(..., exists=True, readable=True)) -> None:
    """Show a tier breakdown and ACTIVE profiles."""
    with input.open(newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    counts = Counter(row.get("activity_tier", "UNKNOWN") for row in rows)
    table = Table("Tier", "Count")
    for tier in ("ACTIVE", "OCCASIONAL", "DORMANT", "INACTIVE", "UNKNOWN"):
        table.add_row(tier, str(counts[tier]))
    console.print(table)
    console.print("[bold]ACTIVE profiles[/bold]")
    for row in rows:
        if row.get("activity_tier") == "ACTIVE":
            console.print(f"- {row.get('linkedin_url')} — {row.get('activity_note', '')}")


if __name__ == "__main__":
    app()
