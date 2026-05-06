#!/usr/bin/env python3
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCENARIO = ROOT / "free_reports" / "inbox" / "20260506_124007_scenario_1_dtc_skincare_meta_google_export.csv"


def main() -> int:
    failures: list[str] = []
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
                "--audit",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        stdout = proc.stdout
        report_text = report_md.read_text(encoding="utf-8")

    lowered = (stdout + "\n" + report_text).lower()
    if "account baseline" in lowered:
        failures.append("final report still references account baseline")
    if "campaign(s):" not in lowered:
        failures.append("final report is missing campaign lines")
    if not re.search(r"Current spend:\s*£(?!0\.00)[0-9]", report_text):
        failures.append("no decision shows current spend above £0.00")
    if "£0.00–£0.00" in report_text:
        failures.append("fake zero impact range still appears in the report")
    if "Wasted spend:" not in report_text:
        failures.append("summary is missing wasted spend")

    print("Report checks:")
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
