from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from recommendation_audit import audit_recommendations


CAMPAIGNS = [
    {"campaign": "Campaign A", "campaign_group": "Campaign A", "platform": "google_ads", "spend": 1000.0, "conversions": 10, "cpa": 100.0, "roas": 1.2},
    {"campaign": "Campaign B", "campaign_group": "Campaign B", "platform": "google_ads", "spend": 2000.0, "conversions": 20, "cpa": 60.0, "roas": 2.0},
    {"campaign": "Campaign C", "campaign_group": "Campaign C", "platform": "google_ads", "spend": 3000.0, "conversions": 30, "cpa": 40.0, "roas": 2.6},
]

REQUIRED_TOP_LEVEL_KEYS = {
    "ok",
    "status",
    "user_message",
    "recommendations",
    "audit_warnings",
    "blocking_errors",
    "summary",
    "debug",
}


def make_contract(*, mode: str = "roas", confidence: str = "high", total_spend: float = 6000.0, total_conversions: int = 60, campaign_count: int = 3):
    return {
        "analysis_mode": mode,
        "confidence": confidence,
        "summary": {
            "total_spend": total_spend,
            "total_conversions": total_conversions,
            "campaign_count": campaign_count,
        },
    }


def make_analysis(*, campaigns=None, total_spend: float = 6000.0, total_conversions: int = 60):
    campaigns = campaigns or CAMPAIGNS
    total_revenue = sum(float(item.get("roas", 0.0) or 0.0) * float(item.get("spend", 0.0) or 0.0) for item in campaigns)
    return {
        "campaigns": campaigns,
        "summary": {
            "total_spend": total_spend,
            "total_conversions": total_conversions,
            "total_revenue": total_revenue,
            "campaign_count": len(campaigns),
        },
    }


def assert_contract_shape(audit: dict, name: str) -> list[str]:
    failures = []
    missing = sorted(REQUIRED_TOP_LEVEL_KEYS - set(audit))
    if missing:
        failures.append(f"{name}: missing top-level keys {missing}")
    if not audit.get("user_message"):
        failures.append(f"{name}: user_message is empty")
    summary = audit.get("summary") or {}
    debug = audit.get("debug") or {}
    for key in ("recommendation_count", "blocked_count", "warning_count", "max_budget_movement", "confidence_floor_applied"):
        if key not in summary:
            failures.append(f"{name}: summary missing {key}")
    for key in ("actions_seen", "campaigns_seen", "conflicts", "metric_threshold_checks"):
        if key not in debug:
            failures.append(f"{name}: debug missing {key}")
    return failures


def run_case(name: str, contract: dict, actions: list[dict], *, expect_statuses: set[str] | None = None, expect_ok: bool | None = None, expect_blocked: bool | None = None, assert_fn=None):
    audit = audit_recommendations(contract, {"analysis": make_analysis(), "strategy": {"actions": actions}})
    failures = assert_contract_shape(audit, name)
    if expect_statuses is not None and audit["status"] not in expect_statuses:
        failures.append(f"{name}: expected status in {sorted(expect_statuses)} got {audit['status']}")
    if expect_ok is not None and audit["ok"] != expect_ok:
        failures.append(f"{name}: expected ok={expect_ok} got {audit['ok']}")
    if expect_blocked is not None:
        has_blocked = audit["status"] == "blocked"
        if has_blocked != expect_blocked:
            failures.append(f"{name}: expected blocked={expect_blocked} got {has_blocked}")
    if assert_fn:
        failures.extend(assert_fn(audit))
    print(f"{name}: {audit['status'].upper()} | recommendations={audit['summary']['recommendation_count']} | warnings={len(audit['audit_warnings'])} | blocks={len(audit['blocking_errors'])}")
    return failures


failures: list[str] = []

# 1) Safe recommendations
failures.extend(
    run_case(
        "safe_recommendations",
        make_contract(),
        [
            {"type": "scale", "campaign": "Campaign C", "amount": 120.0, "reason": "Strong ROAS advantage."},
            {"type": "reduce", "campaign": "Campaign A", "amount": 100.0, "reason": "Weak ROAS compared with median."},
            {"type": "reallocate", "from": "Campaign A", "to": "Campaign C", "amount": 80.0, "reason": "Move budget into the stronger campaign."},
        ],
        expect_statuses={"pass", "warning"},
        expect_ok=True,
    )
)

# 2) Duplicate campaign with compatible actions
failures.extend(
    run_case(
        "duplicate_compatible",
        make_contract(),
        [
            {"type": "reduce", "campaign": "Campaign A", "amount": 100.0, "reason": "Weak ROAS compared with median."},
            {"type": "reallocate", "from": "Campaign A", "to": "Campaign C", "amount": 80.0, "reason": "Move budget into the stronger campaign."},
        ],
        expect_statuses={"pass", "warning"},
        expect_ok=True,
    )
)

# 3) Conflicting actions on same campaign
failures.extend(
    run_case(
        "conflicting_actions",
        make_contract(),
        [
            {"type": "reallocate", "from": "Campaign A", "to": "Campaign A", "amount": 100.0, "reason": "Invalid source/destination pair."},
            {"type": "scale", "campaign": "Campaign A", "amount": 120.0, "reason": "Strong ROAS advantage."},
        ],
        expect_statuses={"blocked"},
        expect_ok=False,
        expect_blocked=True,
    )
)

# 4) Budget movement over 30%
failures.extend(
    run_case(
        "budget_cap",
        make_contract(total_spend=6000.0),
        [
            {"type": "scale", "campaign": "Campaign C", "amount": 5000.0, "reason": "Strong ROAS advantage."},
        ],
        expect_statuses={"pass", "warning"},
        expect_ok=True,
        assert_fn=lambda audit: [
            f"budget_cap: expected max movement <= 0.3 got {audit['summary']['max_budget_movement']}"
        ] if (audit["summary"]["max_budget_movement"] is not None and audit["summary"]["max_budget_movement"] > 0.30001) else [],
    )
)

# 5) Weak performance difference
failures.extend(
    run_case(
        "weak_gap_downgrade",
        make_contract(),
        [
            {"type": "scale", "campaign": "Campaign B", "amount": 500.0, "reason": "Only a slight ROAS edge."},
        ],
        expect_statuses={"warning"},
        expect_ok=True,
        assert_fn=lambda audit: [
            "weak_gap_downgrade: expected downgrade to test/monitor"
        ] if audit["recommendations"][0]["action"] not in {"test", "monitor"} else [],
    )
)

# 6) Low ingestion confidence + high recommendation confidence
low_ingestion_result = audit_recommendations(
    make_contract(confidence="low"),
    {"analysis": make_analysis(), "strategy": {"actions": [{"type": "scale", "campaign": "Campaign C", "amount": 500.0, "reason": "Strong ROAS advantage."}]}}
)
print(f"low_ingestion_confidence: {low_ingestion_result['status'].upper()} | recommendations={low_ingestion_result['summary']['recommendation_count']} | warnings={len(low_ingestion_result['audit_warnings'])} | blocks={len(low_ingestion_result['blocking_errors'])}")
failures.extend(assert_contract_shape(low_ingestion_result, "low_ingestion_confidence"))
if low_ingestion_result["recommendations"] and low_ingestion_result["recommendations"][0]["confidence"] == "high":
    failures.append(f"low_ingestion_confidence: expected confidence <= medium got {low_ingestion_result['recommendations'][0]['confidence']}")
if not low_ingestion_result["summary"]["confidence_floor_applied"]:
    failures.append("low_ingestion_confidence: expected confidence_floor_applied true")
if len([w for w in low_ingestion_result["audit_warnings"] if "low ingestion confidence" in w.lower()]) > 1:
    failures.append("low_ingestion_confidence: expected a single user-facing low-confidence warning")

# 7) CPA-only high-confidence recommendation
cpa_only_confidence_cap = audit_recommendations(
    make_contract(mode="cpa", confidence="high", total_spend=4500.0, total_conversions=20),
    {"analysis": make_analysis(), "strategy": {"actions": [{"type": "scale", "campaign": "Campaign C", "amount": 400.0, "reason": "Strong CPA advantage."}]}}
)
print(f"cpa_only_confidence_cap: {cpa_only_confidence_cap['status'].upper()} | recommendations={cpa_only_confidence_cap['summary']['recommendation_count']} | warnings={len(cpa_only_confidence_cap['audit_warnings'])} | blocks={len(cpa_only_confidence_cap['blocking_errors'])}")
failures.extend(assert_contract_shape(cpa_only_confidence_cap, "cpa_only_confidence_cap"))
if cpa_only_confidence_cap["recommendations"] and cpa_only_confidence_cap["recommendations"][0]["confidence"] == "high":
    failures.append(f"cpa_only_confidence_cap: expected confidence capped got {cpa_only_confidence_cap['recommendations'][0]['confidence']}")
if not cpa_only_confidence_cap["summary"]["confidence_floor_applied"]:
    failures.append("cpa_only_confidence_cap: expected confidence_floor_applied true")
if cpa_only_confidence_cap["status"] not in {"pass", "warning"}:
    failures.append(f"cpa_only_confidence_cap: unexpected status {cpa_only_confidence_cap['status']}")
if len([w for w in cpa_only_confidence_cap["audit_warnings"] if "cpa-only mode" in w.lower()]) > 1:
    failures.append("cpa_only_confidence_cap: expected a single CPA-only warning")

# 8) Missing reason/action/campaign and rollout details
missing_action = audit_recommendations(
    make_contract(),
    {
        "analysis": make_analysis(),
        "strategy": {
            "actions": [
                {"campaign": "Campaign C", "amount": 300.0, "reason": "Has a campaign but no action."},
                {"type": "scale", "amount": 300.0, "reason": "Missing campaign."},
                {"type": "scale", "campaign": "Campaign C", "amount": 300.0},
                {"type": "monitor", "campaign": "Campaign B", "amount": 0.0, "reason": "Safe but sparse."},
            ]
        },
    },
)
print(f"missing_fields: {missing_action['status'].upper()} | blocks={len(missing_action['blocking_errors'])} | warnings={len(missing_action['audit_warnings'])}")
failures.extend(assert_contract_shape(missing_action, "missing_fields"))
if missing_action["status"] != "blocked" or not missing_action["blocking_errors"]:
    failures.append("missing_fields: expected blocked result with blocking errors")
if missing_action["recommendations"][-1].get("warnings"):
    failures.append("missing_fields: expected sparse recommendation filler notes to stay out of user-facing warnings")
if not missing_action["debug"].get("developer_warnings"):
    failures.append("missing_fields: expected developer_warnings in debug for filled optional fields")

# 9) Unknown campaign reference
unknown_campaign = audit_recommendations(
    make_contract(),
    {
        "analysis": make_analysis(),
        "strategy": {"actions": [{"type": "scale", "campaign": "Unknown Campaign", "amount": 100.0, "reason": "Should warn, not block."}]},
    },
)
print(f"unknown_campaign: {unknown_campaign['status'].upper()} | blocks={len(unknown_campaign['blocking_errors'])} | warnings={len(unknown_campaign['audit_warnings'])}")
failures.extend(assert_contract_shape(unknown_campaign, "unknown_campaign"))
if unknown_campaign["status"] == "blocked":
    failures.append("unknown_campaign: expected warning/pass, not blocked")

if failures:
    print("\nFailures:", file=sys.stderr)
    for line in failures:
        print(f"- {line}", file=sys.stderr)
    raise SystemExit(1)

print("\nAll recommendation audit checks passed.")
