#!/usr/bin/env python3
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from ingestion import build_ingestion_contract, ingest_campaign_export

CASES = [
    (
        "meta_ecommerce.csv",
        """Campaign name,Amount spent (GBP),Impressions,Link clicks,Results,Purchases,Purchase conversion value,ROAS (purchase conversion value)\n"""
        """Campaign A,15000,410000,8200,140,210,15400,1.03\n"""
        """Campaign B,8000,50000,1200,30,10,2500,0.40\n"""
        """Campaign C,5000,120000,3000,90,50,4200,0.84\n""",
        {
            "campaign_name": "Campaign name",
            "spend": "Amount spent (GBP)",
            "clicks": "Link clicks",
            "impressions": "Impressions",
            "conversions": "Purchases",
            "revenue": "Purchase conversion value",
        },
        "meta_ads",
        "roas",
    ),
    (
        "google_ecommerce.csv",
        """Campaign,Cost,Impr.,Clicks,Conversions,Conv. value,Value / cost\n"""
        """Brand Search,12000,180000,5400,420,46800,3.90\n"""
        """Generic Search,8000,90000,3000,180,16500,2.06\n"""
        """Nonbrand Search,5000,60000,2200,90,7200,1.44\n""",
        {
            "campaign_name": "Campaign",
            "spend": "Cost",
            "impressions": "Impr.",
            "clicks": "Clicks",
            "conversions": "Conversions",
            "revenue": "Conv. value",
        },
        "google_ads",
        "roas",
    ),
    (
        "lead_gen_cpa.csv",
        """Campaign,Amount spent,Impressions,Outbound clicks,Leads,Cost per lead\n"""
        """Lead Gen A,9000,76000,1140,38,236.84\n"""
        """Lead Gen B,6000,54000,900,24,250.00\n"""
        """Lead Gen C,4500,42000,720,18,250.00\n""",
        {
            "campaign_name": "Campaign",
            "spend": "Amount spent",
            "impressions": "Impressions",
            "clicks": "Outbound clicks",
            "conversions": "Leads",
            "revenue": None,
        },
        "unknown",
        "cpa",
    ),
]


def main() -> int:
    failures: list[str] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        for filename, csv_text, expected_mapping, expected_platform, expected_mode in CASES:
            path = root / filename
            path.write_text(csv_text, encoding="utf-8")
            result = ingest_campaign_export(path)
            contract = build_ingestion_contract(result)
            mapping = result.field_mapping

            if contract.get("status") != "pass":
                failures.append(f"{filename}: expected pass but got {contract.get('status')}")
            if contract.get("analysis_mode") != expected_mode:
                failures.append(f"{filename}: expected mode {expected_mode} got {contract.get('analysis_mode')}")
            if expected_platform != "unknown" and contract.get("platform", {}).get("detected") != expected_platform:
                failures.append(f"{filename}: expected platform {expected_platform} got {contract.get('platform', {}).get('detected')}")

            for field, expected in expected_mapping.items():
                actual = mapping.get(field)
                if actual != expected:
                    failures.append(f"{filename}: expected {field}={expected!r} got {actual!r}")

            if filename == "meta_ecommerce.csv" and mapping.get("conversions") != "Purchases":
                failures.append("meta_ecommerce.csv: conversions should prefer Purchases over Results")
            if filename == "meta_ecommerce.csv" and mapping.get("revenue") != "Purchase conversion value":
                failures.append("meta_ecommerce.csv: revenue should map to Purchase conversion value")
            if filename == "google_ecommerce.csv" and mapping.get("revenue") != "Conv. value":
                failures.append("google_ecommerce.csv: revenue should map to Conv. value")
            if filename == "lead_gen_cpa.csv" and mapping.get("revenue") is not None:
                failures.append("lead_gen_cpa.csv: revenue should remain unmapped")

            print(
                f"{filename}: {'PASS' if contract.get('status') == 'pass' else 'FAIL'} | platform={contract.get('platform', {}).get('detected', 'unknown')} | mode={contract.get('analysis_mode')}"
            )

    if failures:
        print("\nFailures:", file=sys.stderr)
        for line in failures:
            print(f"- {line}", file=sys.stderr)
        return 1

    print("\nHeader alias regression checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
