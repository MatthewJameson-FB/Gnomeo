#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

from ingestion import build_ingestion_contract, ingest_campaign_export

CANONICAL_FIELDS = [
    "campaign_name",
    "spend",
    "conversions",
    "revenue",
    "clicks",
    "impressions",
    "platform",
    "campaign_type",
    "country",
    "ad_group",
    "ad_set",
    "ad",
    "keyword",
    "search_term",
    "device",
    "date",
]


def fmt_money(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return f"£{float(value):,.2f}"
    except (TypeError, ValueError):
        return str(value)


def fmt_value(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        if value.is_integer():
            return f"{int(value)}"
        return f"{value:,.2f}".rstrip("0").rstrip(".")
    return str(value)


def print_kv(title: str, pairs: Iterable[tuple[str, Any]]) -> None:
    print(title)
    for key, value in pairs:
        print(f"{key}: {value}")


def field_mapping_lines(contract: Dict[str, Any]) -> List[str]:
    field_map = contract.get("mapping", {}).get("field_map", {}) if isinstance(contract, dict) else {}
    lines = []
    for field in CANONICAL_FIELDS:
        source = field_map.get(field)
        lines.append(f"{field} <- {source or 'not found'}")
    return lines


def analysis_mode_label(contract: Dict[str, Any]) -> tuple[str, str]:
    if contract.get("status") == "fail":
        return "FAILED", "Blocking validation errors were found."

    mode = str(contract.get("analysis_mode") or "limited").lower()
    platform_confidence = str(contract.get("platform", {}).get("confidence") or "low").lower()
    mapping_confidence = str(contract.get("confidence") or "low").lower()

    if platform_confidence == "low" or mapping_confidence == "low":
        return "LIMITED", "Dataset is usable, but confidence is limited."
    if mode == "cpa":
        return "CPA", "Spend and conversions were found, but revenue was missing."
    if mode == "roas":
        return "ROAS", "Spend and revenue were found."
    return "LIMITED", "Dataset is usable, but confidence is limited."


def revenue_status(contract: Dict[str, Any]) -> str:
    summary = contract.get("summary", {}) if isinstance(contract, dict) else {}
    status = summary.get("revenue_status")
    if status in {"available", "missing", "zero", "unknown"}:
        return str(status)
    return "missing"


def clean_rows(contract: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = list(contract.get("clean_rows") or [])
    return sorted(rows, key=lambda row: float(row.get("spend") or 0.0), reverse=True)


def table_rows(contract: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    dimensions = ", ".join((contract.get("segmentation") or {}).get("dimensions_used", []) or []) or "campaign_name"
    for row in clean_rows(contract):
        rows.append(
            {
                "segment_name": row.get("campaign") or "—",
                "campaign_name": row.get("campaign") or "—",
                "spend": fmt_money(row.get("spend")),
                "conversions": fmt_value(row.get("conversions")),
                "revenue": fmt_money(row.get("revenue")),
                "CPA": fmt_money(row.get("raw_cpa")),
                "ROAS": fmt_value(row.get("raw_roas")),
                "clicks": fmt_value(row.get("clicks")),
                "impressions": fmt_value(row.get("impressions")),
                "dimensions_used": dimensions,
            }
        )
    return rows


def print_status(contract: Dict[str, Any]) -> None:
    ok = bool(contract.get("ok"))
    mode_label, mode_reason = analysis_mode_label(contract)
    print_kv(
        "INGESTION STATUS",
        [
            ("Status", contract.get("status", "fail").upper()),
            ("Decision engine", "allowed" if contract.get("decision_engine_allowed") else "blocked"),
            ("Message", contract.get("user_message") or "Validation complete."),
        ],
    )
    print()
    print_kv(
        "PLATFORM + MODE",
        [
            ("Detected platform", contract.get("platform", {}).get("detected", "unknown")),
            ("Platform confidence", contract.get("platform", {}).get("confidence", "low")),
            ("Analysis mode", mode_label),
            ("Mode reason", mode_reason),
        ],
    )
    print()

    print("FIELD MAPPING")
    for line in field_mapping_lines(contract):
        print(line)
    print()

    segmentation = contract.get("segmentation", {}) or {}
    print("SEGMENTATION")
    print(f"Strategy: {segmentation.get('strategy', 'not available')}")
    print(f"Dimensions used: {', '.join(segmentation.get('dimensions_used', []) or ['campaign_name'])}")
    print(f"Segment count: {segmentation.get('segment_count', 0)}")
    reason = segmentation.get("reason") or "campaign_name alone produced enough comparable segments."
    print(f"Reason: {reason}")
    print("Sample segment names:")
    samples = segmentation.get("sample_segments") or []
    if samples:
        for sample in samples:
            print(f"- {sample}")
    else:
        print("- none")
    print()

    summary = contract.get("summary", {}) or {}
    total_spend = summary.get("total_spend")
    total_conversions = summary.get("total_conversions")
    total_revenue = summary.get("total_revenue")
    clean_row_count = len(contract.get("clean_rows") or [])
    raw_row_count = int(summary.get("raw_row_count") or 0)
    invalid_numeric_count = None

    print("DATA SUMMARY")
    print(f"Raw rows: {raw_row_count}")
    print(f"Clean rows: {clean_row_count}")
    print("Excluded rows: not tracked")
    print(f"Total spend: {fmt_money(total_spend)}")
    print(f"Total conversions: {fmt_value(total_conversions)}")
    print(f"Total revenue: {fmt_money(total_revenue)}")
    print(f"Revenue status: {revenue_status(contract)}")
    print(f"Segments: {summary.get('segments', 0)}")
    print(f"Rows with invalid numeric values: {invalid_numeric_count if invalid_numeric_count is not None else 'not tracked'}")
    print()

    rows = table_rows(contract)
    print("NORMALIZED CLEAN ROWS")
    if len(rows) > 20:
        print(f"Showing top 20 segments by spend out of {len(rows)} total segments.")
        rows = rows[:20]
    if rows:
        headers = ["segment_name", "campaign_name", "spend", "conversions", "revenue", "CPA", "ROAS", "clicks", "impressions", "dimensions_used"]
        widths = {header: len(header) for header in headers}
        for row in rows:
            for header in headers:
                widths[header] = max(widths[header], len(str(row.get(header, "—"))))
        print(" | ".join(header.ljust(widths[header]) for header in headers))
        print("-|-".join("-" * widths[header] for header in headers))
        for row in rows:
            print(" | ".join(str(row.get(header, "—")).ljust(widths[header]) for header in headers))
    else:
        print("No clean rows available.")
    print()

    warnings = list(contract.get("warnings") or [])
    blocking = list(contract.get("blocking_errors") or [])
    print("WARNINGS")
    if warnings:
        for warning in warnings:
            print(f"- {warning}")
    else:
        print("- None")
    print()

    print("BLOCKING ERRORS")
    if blocking:
        for error in blocking:
            print(f"- {error}")
    else:
        print("- None")
    print()

    handoff = contract.get("handoff", {}) or {}
    print("DECISION ENGINE HANDOFF")
    if ok:
        print(f"analysis_mode: {handoff.get('analysis_mode', 'limited')}")
        print(f"confidence: {handoff.get('confidence', 'low')}")
        print(f"clean_rows: {handoff.get('clean_rows_count', 0)}")
        print(f"total_spend: {fmt_value(handoff.get('total_spend'))}")
        print(f"total_conversions: {fmt_value(handoff.get('total_conversions'))}")
        print(f"total_revenue: {fmt_value(handoff.get('total_revenue'))}")
        print(f"warnings: {handoff.get('warnings_count', 0)}")
        print("decision_engine_allowed: true")
        print(
            f"source_metadata: platform={contract.get('platform', {}).get('detected', 'unknown')}, "
            f"mapping_confidence={contract.get('confidence', 'low')}, segment_strategy={segmentation.get('strategy', 'not available')}"
        )
    else:
        print("decision_engine_allowed: false")
        print(f"Reason: {blocking[0] if blocking else 'Validation failed.'}")


def build_json_payload(contract: Dict[str, Any]) -> Dict[str, Any]:
    return contract


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect Gnomeo ingestion without running the decision engine.")
    parser.add_argument("csv_path", help="Path to the CSV file")
    parser.add_argument("--json", action="store_true", help="Print the inspection payload as JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    path = Path(args.csv_path).expanduser().resolve()
    result = ingest_campaign_export(path)
    contract = build_ingestion_contract(result)

    if args.json:
        print(json.dumps(build_json_payload(contract), indent=2, sort_keys=True, default=str))
        return 0 if contract.get("ok") else 1

    print_status(contract)
    return 0 if contract.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
