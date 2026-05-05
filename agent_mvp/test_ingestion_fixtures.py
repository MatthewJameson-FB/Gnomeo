from __future__ import annotations

from pathlib import Path
import sys

from ingestion import build_ingestion_contract, ingest_campaign_export

ROOT = Path(__file__).resolve().parent / "fixtures"

CASES = [
    ("clean_structured.csv", True, "structured_generic", "roas"),
    ("google_raw.csv", True, "google_ads", "roas"),
    ("meta_raw.csv", True, "meta_ads", "roas"),
    ("cpa_only.csv", True, "structured_generic", "cpa"),
    ("no_signal.csv", False, "unknown", "failed"),
    ("single_campaign_fallback.csv", True, "google_ads", "roas"),
    ("currency_formatted_spend.csv", True, "structured_generic", "roas"),
    ("cost_micros.csv", True, "google_ads", "roas"),
    ("multiple_rows_same_campaign_ad_groups.csv", True, "google_ads", "roas"),
    ("single_campaign_no_dims.csv", False, "structured_generic", "failed"),
]

EXPECTED_TOTAL_SPEND = {
    "currency_formatted_spend.csv": 6700.5,
    "cost_micros.csv": 3500.0,
}

REQUIRED_TOP_LEVEL_KEYS = {
    "ok",
    "status",
    "user_message",
    "analysis_mode",
    "confidence",
    "decision_engine_allowed",
    "platform",
    "mapping",
    "segmentation",
    "summary",
    "clean_rows",
    "warnings",
    "blocking_errors",
    "handoff",
    "debug",
}

failed = []


def assert_contract_shape(contract, filename):
    missing = sorted(REQUIRED_TOP_LEVEL_KEYS - set(contract))
    if missing:
        failed.append(f"{filename}: missing contract keys {missing}")
        return

    if not contract.get("user_message"):
        failed.append(f"{filename}: user_message is empty")

    expected_allowed = bool(contract.get("ok") is True and contract.get("status") == "pass")
    if contract.get("decision_engine_allowed") != expected_allowed:
        failed.append(f"{filename}: decision_engine_allowed mismatch")


for filename, should_pass, platform, mode in CASES:
    path = ROOT / filename
    result = ingest_campaign_export(path)
    contract = build_ingestion_contract(result)

    assert_contract_shape(contract, filename)

    ok = bool(contract.get("ok"))
    status = contract.get("status")
    analysis_mode = contract.get("analysis_mode")
    clean_rows = contract.get("clean_rows") or []
    handoff = contract.get("handoff") or {}
    summary = contract.get("summary") or {}

    if should_pass:
        if not ok or status != "pass":
            failed.append(f"{filename}: expected pass but got {status}")
        if not contract.get("decision_engine_allowed"):
            failed.append(f"{filename}: decision engine should be allowed")
        if not clean_rows:
            failed.append(f"{filename}: expected clean rows")
        if handoff.get("clean_rows_count") != len(clean_rows):
            failed.append(f"{filename}: handoff.clean_rows_count mismatch")
        if contract.get("blocking_errors"):
            failed.append(f"{filename}: blocking_errors should be empty")
        if platform and contract.get("platform", {}).get("detected") != platform:
            failed.append(f"{filename}: expected platform {platform} got {contract.get('platform', {}).get('detected')}")
        if mode and analysis_mode != mode:
            failed.append(f"{filename}: expected mode {mode} got {analysis_mode}")
    else:
        if ok or status != "fail":
            failed.append(f"{filename}: expected fail but got {status}")
        if contract.get("decision_engine_allowed"):
            failed.append(f"{filename}: decision engine should be blocked")
        if analysis_mode != "failed":
            failed.append(f"{filename}: expected analysis_mode failed got {analysis_mode}")
        if not contract.get("blocking_errors"):
            failed.append(f"{filename}: expected blocking errors")
        if contract.get("user_message") == "":
            failed.append(f"{filename}: expected non-empty user_message")
        if clean_rows and filename in {"single_campaign_no_dims.csv", "no_signal.csv"}:
            failed.append(f"{filename}: expected empty clean rows on failure")
        if platform and contract.get("platform", {}).get("detected") != platform:
            failed.append(f"{filename}: expected platform {platform} got {contract.get('platform', {}).get('detected')}")

    if filename in EXPECTED_TOTAL_SPEND:
        expected = EXPECTED_TOTAL_SPEND[filename]
        actual = float(summary.get("total_spend") or 0.0)
        if abs(actual - expected) > 0.001:
            failed.append(f"{filename}: expected total spend {expected} got {actual}")

    if filename == "cpa_only.csv":
        if status != "pass" or analysis_mode != "cpa":
            failed.append(f"{filename}: expected CPA pass")
        if contract.get("summary", {}).get("revenue_status") != "missing":
            failed.append(f"{filename}: expected revenue_status missing")
        if not contract.get("warnings"):
            failed.append(f"{filename}: expected warnings")

    if filename in {"clean_structured.csv", "google_raw.csv", "meta_raw.csv", "currency_formatted_spend.csv", "cost_micros.csv", "single_campaign_fallback.csv", "multiple_rows_same_campaign_ad_groups.csv"}:
        if status != "pass":
            failed.append(f"{filename}: expected pass")
        if analysis_mode != "roas":
            failed.append(f"{filename}: expected roas mode")
        if contract.get("summary", {}).get("revenue_status") not in {"available", "zero"}:
            failed.append(f"{filename}: expected revenue to be available or zero")

    print(
        f"{filename}: {'PASS' if status == 'pass' else 'FAIL'} | platform={contract.get('platform', {}).get('detected', 'unknown')} | mode={analysis_mode} | segments={summary.get('segments', 0)}"
    )

if failed:
    print("\nFailures:", file=sys.stderr)
    for line in failed:
        print(f"- {line}", file=sys.stderr)
    raise SystemExit(1)

print("\nAll ingestion contract fixtures passed.")
