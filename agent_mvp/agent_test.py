#!/usr/bin/env python3
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import List, Dict, Any

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "sample_ads_data.csv"

@dataclass
class Campaign:
    campaign: str
    platform: str
    monthly_spend_gbp: float
    impressions: int
    clicks: int
    conversions: int
    revenue_gbp: float
    notes: str

    @property
    def ctr(self) -> float:
        return self.clicks / self.impressions if self.impressions else 0.0

    @property
    def cpc(self) -> float:
        return self.monthly_spend_gbp / self.clicks if self.clicks else 0.0

    @property
    def cpa(self) -> float:
        return self.monthly_spend_gbp / self.conversions if self.conversions else float("inf")

    @property
    def roas(self) -> float:
        return self.revenue_gbp / self.monthly_spend_gbp if self.monthly_spend_gbp else 0.0

    @property
    def cvr(self) -> float:
        return self.conversions / self.clicks if self.clicks else 0.0


def load_campaigns(path: Path) -> List[Campaign]:
    campaigns: List[Campaign] = []
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            campaigns.append(
                Campaign(
                    campaign=row["campaign"],
                    platform=row["platform"],
                    monthly_spend_gbp=float(row["monthly_spend_gbp"]),
                    impressions=int(row["impressions"]),
                    clicks=int(row["clicks"]),
                    conversions=int(row["conversions"]),
                    revenue_gbp=float(row["revenue_gbp"]),
                    notes=row.get("notes", ""),
                )
            )
    return campaigns


def analyst(campaigns: List[Campaign]) -> Dict[str, Any]:
    total_spend = sum(c.monthly_spend_gbp for c in campaigns)
    total_revenue = sum(c.revenue_gbp for c in campaigns)
    total_conversions = sum(c.conversions for c in campaigns)
    total_clicks = sum(c.clicks for c in campaigns)
    total_impressions = sum(c.impressions for c in campaigns)

    best_roas = max(campaigns, key=lambda c: c.roas)
    worst_roas = min(campaigns, key=lambda c: c.roas)
    highest_spend = max(campaigns, key=lambda c: c.monthly_spend_gbp)
    highest_cpa = max(campaigns, key=lambda c: c.cpa)

    return {
        "summary": {
            "campaign_count": len(campaigns),
            "total_spend_gbp": total_spend,
            "total_revenue_gbp": total_revenue,
            "total_conversions": total_conversions,
            "overall_roas": total_revenue / total_spend if total_spend else 0.0,
            "overall_cpa": total_spend / total_conversions if total_conversions else 0.0,
            "overall_ctr": total_clicks / total_impressions if total_impressions else 0.0,
            "overall_cvr": total_conversions / total_clicks if total_clicks else 0.0,
        },
        "winners": [c for c in sorted(campaigns, key=lambda c: c.roas, reverse=True)[:2]],
        "losers": [c for c in sorted(campaigns, key=lambda c: c.roas)[:2]],
        "flags": [
            f"Best ROAS: {best_roas.campaign} ({best_roas.roas:.2f}x)",
            f"Weakest ROAS: {worst_roas.campaign} ({worst_roas.roas:.2f}x)",
            f"Highest spend: {highest_spend.campaign} (£{highest_spend.monthly_spend_gbp:,.0f})",
            f"Highest CPA: {highest_cpa.campaign} (£{highest_cpa.cpa:,.2f})",
        ],
    }


def strategist(analysis: Dict[str, Any]) -> Dict[str, Any]:
    winners = analysis["winners"]
    losers = analysis["losers"]

    actions = [
        {
            "priority": "1",
            "action": f"Shift 10–20% of budget from {losers[0].campaign} into {winners[0].campaign}",
            "reason": f"ROAS gap: {winners[0].roas:.2f}x vs {losers[0].roas:.2f}x.",
        },
        {
            "priority": "2",
            "action": f"Reduce spend on {losers[1].campaign} until CPA improves",
            "reason": f"Highest-cost inefficiency risk at £{losers[1].cpa:,.2f} CPA.",
        },
        {
            "priority": "3",
            "action": "Keep retargeting campaigns stable while testing new creative for prospecting",
            "reason": "Retargeting is usually the safest conversion layer; prospecting needs fresh inputs.",
        },
    ]

    experiments = [
        "Test 3 new hooks on the highest-spend prospecting campaign.",
        "Split branded vs non-branded search reporting.",
        "Track assisted-conversion value for video and retargeting.",
    ]

    return {"actions": actions, "experiments": experiments}


def critic(analysis: Dict[str, Any], strategy: Dict[str, Any]) -> Dict[str, Any]:
    risks = [
        "ROAS is helpful, but attribution quality can distort the winner/loser ranking.",
        "Budget shifts should be capped if conversion volume is low or seasonal demand is changing.",
        "LinkedIn may look expensive but could still be valuable for strategic accounts.",
    ]
    gaps = [
        "Need margin data to judge true profitability.",
        "Need conversion lag and attribution window details before aggressive scaling.",
        "Need creative-level breakdown to isolate why prospecting underperforms.",
    ]
    return {"risks": risks, "gaps": gaps, "recommendation": "Proceed, but with a measured test-and-learn budget shift."}


def synthesizer(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any]) -> str:
    s = analysis["summary"]
    lines = [
        "SYNTHESIZER OUTPUT",
        f"Overall ROAS: {s['overall_roas']:.2f}x | Overall CPA: £{s['overall_cpa']:.2f}",
        "",
        "Top moves:",
    ]
    for item in strategy["actions"]:
        lines.append(f"- {item['priority']}. {item['action']} — {item['reason']}")
    lines.extend([
        "",
        "Risks to respect:",
    ])
    for risk in critique["risks"]:
        lines.append(f"- {risk}")
    lines.extend([
        "",
        "Missing inputs before a bigger shift:",
    ])
    for gap in critique["gaps"]:
        lines.append(f"- {gap}")
    return "\n".join(lines)


def print_section(title: str, body: Any) -> None:
    print(f"\n=== {title} ===")
    if isinstance(body, dict):
        for key, value in body.items():
            print(f"{key}: {value}")
    elif isinstance(body, list):
        for item in body:
            print(f"- {item}")
    else:
        print(body)


def main() -> None:
    if not DATA_PATH.exists():
        raise SystemExit(f"Missing data file: {DATA_PATH}")

    campaigns = load_campaigns(DATA_PATH)
    analysis = analyst(campaigns)
    strategy = strategist(analysis)
    critique = critic(analysis, strategy)
    final = synthesizer(analysis, strategy, critique)

    print("Gnomeo agent MVP test")
    print("API mode: local mock (no remote calls)")
    print(f"Data source: {DATA_PATH.name}")
    print_section("ANALYST", analysis)
    print_section("STRATEGIST", strategy)
    print_section("CRITIC", critique)
    print("\n=== SYNTHESIZER ===")
    print(final)


if __name__ == "__main__":
    main()
