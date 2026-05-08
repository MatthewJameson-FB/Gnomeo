#!/usr/bin/env python3
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "agent_mvp"))
from ingestion import ingest_campaign_export  # noqa: E402
from agent_test import Campaign, analyst, label, run_profile_interpreter, strategist_initial  # noqa: E402

SCENARIO = ROOT / "agent_mvp" / "fixtures" / "waste_heavy_ecommerce.csv"


def _campaigns(path: Path) -> list[Campaign]:
    ingestion = ingest_campaign_export(path)
    if not ingestion.valid:
        raise RuntimeError(f"Ingestion failed: {[issue.message for issue in ingestion.issues]}")
    return [Campaign(**{k: v for k, v in record.items() if k != "campaign_group"}) for record in ingestion.records]


def main() -> int:
    failures: list[str] = []

    campaigns = _campaigns(SCENARIO)
    profile = run_profile_interpreter(campaigns, SimpleNamespace(business_stage="balanced", objective="efficient growth", acceptable_cpa=None, acceptable_roas=None))
    analysis = analyst(campaigns, profile)
    strategy = strategist_initial(analysis, {})
    actions = strategy.get("actions", [])

    pause_or_reduce = [a for a in actions if a.get("type") in {"pause", "reduce", "reallocate"}]
    scale_actions = [a for a in actions if a.get("type") == "scale"]
    if not pause_or_reduce:
        failures.append("strategist_initial did not produce a pause/reduce/reallocate candidate")
    if not scale_actions:
        failures.append("strategist_initial did not produce a scale candidate")
    if pause_or_reduce and scale_actions:
        loser = pause_or_reduce[0].get("campaign") or pause_or_reduce[0].get("campaign_or_segment") or pause_or_reduce[0].get("from")
        winner = scale_actions[0].get("campaign") or scale_actions[0].get("campaign_or_segment") or scale_actions[0].get("to")
        if loser == winner:
            failures.append(f"strategist_initial picked the same campaign for winner and loser: {loser}")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        report_md = tmp / "report.md"
        report_html = tmp / "report.html"
        proc = subprocess.run(
            [
                sys.executable,
                str(ROOT / "agent_mvp" / "agent_test.py"),
                str(SCENARIO),
                "--output-report",
                str(report_md),
                "--output-html",
                str(report_html),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        stdout = proc.stdout
        report_text = report_md.read_text(encoding="utf-8")
        report_html_text = report_html.read_text(encoding="utf-8")

    lowered = (stdout + "\n" + report_text + "\n" + report_html_text).lower()
    if "account baseline" in lowered:
        failures.append("final report still references account baseline")
    for campaign_name in ["meta prospecting broad uk", "google brand search"]:
        if campaign_name not in lowered:
            failures.append(f"final report is missing expected campaign name: {campaign_name}")
    for heading in ["Executive Summary", "Account Snapshot", "Top Priorities", "Key Decisions", "Signal Notes / Conservative Calls", "Data Quality & Caveats"]:
        if heading.lower() not in lowered:
            failures.append(f"final report is missing {heading}")
    if "reason:" not in lowered:
        failures.append("final report is missing decision rationales")
    if "confidence:" not in lowered:
        failures.append("final report is missing signal/confidence labels")
    if "audit safeguards reduced" not in lowered and "signal quality was not strong enough" not in lowered:
        failures.append("final report is missing conservative notes")
    spend_values = [float(value) for value in re.findall(r"Current spend:\s*([0-9]+(?:\.[0-9]+)?)", report_text)]
    if not spend_values or not any(value > 0 for value in spend_values):
        failures.append("no decision shows current spend above £0.00")
    if "£0.00–£0.00" in report_text or "£0.00–£0.00" in report_html_text:
        failures.append("fake zero impact range still appears in the report")
    if "wasted spend" not in lowered:
        failures.append("summary is missing wasted spend")

    print("Pre-audit strategist actions:")
    for action in actions:
        print(action)

    print("\nReport checks:")
    print(report_text)

    if failures:
        print("\nFailures:", file=sys.stderr)
        for line in failures:
            print(f"- {line}", file=sys.stderr)
        return 1

    print("\nCampaign recommendation regression passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
