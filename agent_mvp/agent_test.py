#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / "sample_ads_data.csv"
OUTPUT_REPORT = ROOT / "output_report.md"

COLUMN_ALIASES = {
    "campaign": ["campaign"],
    "platform": ["platform"],
    "campaign_type": ["campaign_type"],
    "industry": ["industry"],
    "country": ["country"],
    "ad_set": ["ad_set", "adset", "ad set"],
    "ad": ["ad", "creative", "ad_name"],
    "spend": ["spend", "ad_spend", "monthly_spend_gbp", "cost", "amount_spent"],
    "impressions": ["impressions"],
    "clicks": ["clicks"],
    "conversions": ["conversions", "purchases", "leads"],
    "revenue": ["revenue", "revenue_gbp", "value", "sales"],
    "ctr": ["ctr"],
    "cpc": ["cpc"],
    "cpa": ["cpa"],
    "roas": ["roas"],
}


@dataclass
class Campaign:
    campaign: str = ""
    platform: str = ""
    campaign_type: str = ""
    industry: str = ""
    country: str = ""
    ad_set: str = ""
    ad: str = ""
    spend: float = 0.0
    impressions: int = 0
    clicks: int = 0
    conversions: int = 0
    revenue: Optional[float] = None
    raw_ctr: Optional[float] = None
    raw_cpc: Optional[float] = None
    raw_cpa: Optional[float] = None
    raw_roas: Optional[float] = None
    raw: Dict[str, str] = field(default_factory=dict)

    @property
    def ctr(self) -> Optional[float]:
        if self.raw_ctr is not None:
            return self.raw_ctr
        return self.clicks / self.impressions if self.impressions else None

    @property
    def cpc(self) -> Optional[float]:
        if self.raw_cpc is not None:
            return self.raw_cpc
        return self.spend / self.clicks if self.clicks else None

    @property
    def cpa(self) -> Optional[float]:
        if self.raw_cpa is not None:
            return self.raw_cpa
        return self.spend / self.conversions if self.conversions else None

    @property
    def roas(self) -> Optional[float]:
        if self.raw_roas is not None:
            return self.raw_roas
        if self.revenue is None or not self.spend:
            return None
        return self.revenue / self.spend

    @property
    def cvr(self) -> Optional[float]:
        return self.conversions / self.clicks if self.clicks else None

    @property
    def conversion_efficiency(self) -> Optional[float]:
        if self.spend <= 0:
            return None
        return self.conversions / self.spend


def _clean_key(value: str) -> str:
    return value.strip().lower().replace(" ", "_")


def _parse_float(value: str) -> Optional[float]:
    if value is None:
        return None
    cleaned = value.strip().replace(",", "").replace("£", "").replace("$", "")
    if cleaned == "":
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _parse_int(value: str) -> int:
    parsed = _parse_float(value)
    return int(parsed) if parsed is not None else 0


def _find_column(fieldnames: List[str], aliases: List[str]) -> Optional[str]:
    normalized = {_clean_key(name): name for name in fieldnames}
    for alias in aliases:
        key = _clean_key(alias)
        if key in normalized:
            return normalized[key]
    return None


def _row_text(row: Dict[str, str], column: Optional[str]) -> str:
    if not column:
        return ""
    return (row.get(column, "") or "").strip()


def load_campaigns(path: Path) -> List[Campaign]:
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        fieldnames = reader.fieldnames or []

        columns = {
            logical: _find_column(fieldnames, aliases)
            for logical, aliases in COLUMN_ALIASES.items()
        }

        grouped: Dict[str, Campaign] = {}
        for row in reader:
            platform = _row_text(row, columns["platform"])
            campaign_type = _row_text(row, columns["campaign_type"])
            industry = _row_text(row, columns["industry"])
            country = _row_text(row, columns["country"])
            campaign_name = _row_text(row, columns["campaign"]) or " | ".join([platform, campaign_type, industry, country])

            entry = Campaign(
                campaign=campaign_name,
                platform=platform,
                campaign_type=campaign_type,
                industry=industry,
                country=country,
                ad_set=_row_text(row, columns["ad_set"]),
                ad=_row_text(row, columns["ad"]),
                spend=_parse_float(row.get(columns["spend"], "0") if columns["spend"] else "0") or 0.0,
                impressions=_parse_int(row.get(columns["impressions"], "0") if columns["impressions"] else "0"),
                clicks=_parse_int(row.get(columns["clicks"], "0") if columns["clicks"] else "0"),
                conversions=_parse_int(row.get(columns["conversions"], "0") if columns["conversions"] else "0"),
                revenue=_parse_float(row.get(columns["revenue"], "") if columns["revenue"] else ""),
                raw_ctr=_parse_float(row.get(columns["ctr"], "") if columns["ctr"] else ""),
                raw_cpc=_parse_float(row.get(columns["cpc"], "") if columns["cpc"] else ""),
                raw_cpa=_parse_float(row.get(columns["cpa"], "") if columns["cpa"] else ""),
                raw_roas=_parse_float(row.get(columns["roas"], "") if columns["roas"] else ""),
                raw=row,
            )

            existing = grouped.get(campaign_name)
            if existing is None:
                grouped[campaign_name] = entry
            else:
                existing.spend += entry.spend
                existing.impressions += entry.impressions
                existing.clicks += entry.clicks
                existing.conversions += entry.conversions
                if entry.revenue is not None:
                    existing.revenue = (existing.revenue or 0.0) + entry.revenue
                if not existing.platform:
                    existing.platform = entry.platform
                if not existing.campaign_type:
                    existing.campaign_type = entry.campaign_type
                if not existing.industry:
                    existing.industry = entry.industry
                if not existing.country:
                    existing.country = entry.country
                if not existing.ad_set:
                    existing.ad_set = entry.ad_set
                if not existing.ad:
                    existing.ad = entry.ad
                existing.raw.update({k: v for k, v in row.items() if v is not None})

        return list(grouped.values())


def label(c: Campaign) -> str:
    return c.campaign or "Unnamed row"


def fmt_money(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"£{value:,.2f}"


def fmt_rate(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.2f}%"


def fmt_x(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2f}x"


def build_overall_summary(campaigns: List[Campaign]) -> Dict[str, Any]:
    total_spend = sum(c.spend for c in campaigns)
    total_impressions = sum(c.impressions for c in campaigns)
    total_clicks = sum(c.clicks for c in campaigns)
    total_conversions = sum(c.conversions for c in campaigns)
    revenue_values = [c.revenue for c in campaigns if c.revenue is not None]
    total_revenue = sum(revenue_values) if revenue_values else None

    summary: Dict[str, Any] = {
        "campaign_count": len(campaigns),
        "total_spend": total_spend,
        "total_impressions": total_impressions,
        "total_clicks": total_clicks,
        "total_conversions": total_conversions,
        "overall_ctr": total_clicks / total_impressions if total_impressions else None,
        "overall_cpc": total_spend / total_clicks if total_clicks else None,
        "overall_cpa": total_spend / total_conversions if total_conversions else None,
        "overall_cvr": total_conversions / total_clicks if total_clicks else None,
        "total_revenue": total_revenue,
        "overall_roas": (total_revenue / total_spend) if (total_revenue is not None and total_spend) else None,
        "revenue_available": total_revenue is not None,
    }
    return summary


def rank_campaigns(campaigns: List[Campaign]) -> Dict[str, List[Campaign]]:
    def safe_roas(c: Campaign) -> float:
        return c.roas if c.roas is not None else -1.0

    def safe_cpa(c: Campaign) -> float:
        return c.cpa if c.cpa is not None else float("inf")

    def safe_cvr(c: Campaign) -> float:
        return c.cvr if c.cvr is not None else -1.0

    return {
        "best_roas": sorted([c for c in campaigns if c.roas is not None], key=safe_roas, reverse=True)[:3],
        "worst_roas": sorted([c for c in campaigns if c.roas is not None], key=safe_roas)[:3],
        "best_cpa": sorted([c for c in campaigns if c.cpa is not None], key=safe_cpa)[:3],
        "worst_cpa": sorted([c for c in campaigns if c.cpa is not None], key=safe_cpa, reverse=True)[:3],
        "best_cvr": sorted([c for c in campaigns if c.cvr is not None], key=safe_cvr, reverse=True)[:3],
    }


def analyst(campaigns: List[Campaign]) -> Dict[str, Any]:
    summary = build_overall_summary(campaigns)
    ranks = rank_campaigns(campaigns)
    biggest_spend = sorted(campaigns, key=lambda c: c.spend, reverse=True)[:3]

    flags = []
    if ranks["best_roas"]:
        flags.append(f"Best ROAS: {label(ranks['best_roas'][0])} ({fmt_x(ranks['best_roas'][0].roas)})")
    if ranks["worst_roas"]:
        flags.append(f"Weakest ROAS: {label(ranks['worst_roas'][0])} ({fmt_x(ranks['worst_roas'][0].roas)})")
    if ranks["worst_cpa"]:
        flags.append(f"Highest CPA: {label(ranks['worst_cpa'][0])} ({fmt_money(ranks['worst_cpa'][0].cpa)})")
    if biggest_spend:
        flags.append(f"Highest spend: {label(biggest_spend[0])} ({fmt_money(biggest_spend[0].spend)})")

    return {"summary": summary, "ranks": ranks, "flags": flags, "biggest_spend": biggest_spend}


def strategist(analysis: Dict[str, Any]) -> Dict[str, Any]:
    ranks = analysis["ranks"]
    biggest_spend = analysis["biggest_spend"]

    top_spend = biggest_spend[0] if biggest_spend else None
    best_roas = ranks["best_roas"][0] if ranks["best_roas"] else None
    worst_cpa = ranks["worst_cpa"][0] if ranks["worst_cpa"] else None
    best_cvr = ranks["best_cvr"][0] if ranks["best_cvr"] else None

    actions = []
    if top_spend and best_roas and top_spend is not best_roas:
        actions.append({
            "priority": "1",
            "action": f"Shift 10–20% of budget from {label(top_spend)} into {label(best_roas)}",
            "reason": f"Higher return signal: {fmt_x(best_roas.roas)} vs {fmt_x(top_spend.roas)}.",
        })
    if worst_cpa and worst_cpa.cpa is not None:
        actions.append({
            "priority": str(len(actions) + 1),
            "action": f"Reduce spend on {label(worst_cpa)} until CPA improves",
            "reason": f"Current CPA is {fmt_money(worst_cpa.cpa)}.",
        })
    if best_cvr:
        actions.append({
            "priority": str(len(actions) + 1),
            "action": f"Use {label(best_cvr)} as the conversion-efficiency benchmark",
            "reason": f"Best CVR in the dataset: {fmt_rate(best_cvr.cvr)}.",
        })

    if not actions:
        actions = [{
            "priority": "1",
            "action": "Prioritize the strongest conversion-efficiency campaigns",
            "reason": "The dataset is too small or incomplete for a more aggressive recommendation.",
        }]

    experiments = [
        "Test 3 new hooks on the highest-spend prospecting campaign.",
        "Split branded vs non-branded search reporting.",
        "Track assisted-conversion value for retargeting and video.",
    ]

    return {"actions": actions, "experiments": experiments}


def critic(analysis: Dict[str, Any], strategy: Dict[str, Any]) -> Dict[str, Any]:
    summary = analysis["summary"]
    risks = [
        "Attribution quality can distort the winner/loser ranking.",
        "Budget shifts should stay measured if conversion volume is low or seasonal demand is changing.",
        "A high-CPA campaign may still be strategically valuable if it drives the right customers.",
    ]
    if not summary.get("revenue_available"):
        risks.insert(0, "Revenue is missing, so ROAS cannot be used for this file.")

    gaps = [
        "Need margin data to judge true profitability.",
        "Need conversion lag and attribution window details before aggressive scaling.",
        "Need creative-level breakdown to isolate why some campaigns underperform.",
    ]
    if not summary.get("revenue_available"):
        gaps.append("Need revenue data to compare campaigns by ROAS.")

    return {
        "risks": risks,
        "gaps": gaps,
        "recommendation": "Proceed with a measured test-and-learn budget shift.",
    }


def synthesizer(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any]) -> str:
    s = analysis["summary"]
    lines = [
        "# Gnomeo Agent MVP Report",
        "",
        "## Analyst",
        f"- Campaigns analyzed: {s['campaign_count']}",
        f"- Total spend: {fmt_money(s['total_spend'])}",
        f"- Total impressions: {s['total_impressions']:,.0f}",
        f"- Total clicks: {s['total_clicks']:,.0f}",
        f"- Total conversions: {s['total_conversions']:,.0f}",
        f"- CTR: {fmt_rate(s['overall_ctr'])}",
        f"- CPC: {fmt_money(s['overall_cpc'])}",
        f"- CPA: {fmt_money(s['overall_cpa'])}",
        f"- CVR: {fmt_rate(s['overall_cvr'])}",
    ]
    if s.get("revenue_available"):
        lines.extend([
            f"- Revenue: {fmt_money(s['total_revenue'])}",
            f"- ROAS: {fmt_x(s['overall_roas'])}",
        ])
    else:
        lines.append("- ROAS: n/a (revenue missing)")

    if analysis["flags"]:
        lines.extend(["", "### Key flags"])
        lines.extend(f"- {flag}" for flag in analysis["flags"])

    lines.extend(["", "## Strategist", "### Top actions"])
    for item in strategy["actions"]:
        lines.append(f"- {item['priority']}. {item['action']} — {item['reason']}")

    lines.extend(["", "### Experiments"])
    lines.extend(f"- {item}" for item in strategy["experiments"])

    lines.extend(["", "## Critic", "### Risks"])
    lines.extend(f"- {risk}" for risk in critique["risks"])
    lines.extend(["", "### Gaps"])
    lines.extend(f"- {gap}" for gap in critique["gaps"])

    lines.extend(["", "## Final synthesis", critique["recommendation"]])
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


def build_report_text(source: Path, analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], final: str) -> str:
    summary = analysis["summary"]
    lines = [
        f"Source file: `{source.name}`",
        "",
        final,
        "",
        "---",
        "",
        "## Quick summary",
        f"- Campaigns: {summary['campaign_count']}",
        f"- Spend: {fmt_money(summary['total_spend'])}",
        f"- CTR: {fmt_rate(summary['overall_ctr'])}",
        f"- CPC: {fmt_money(summary['overall_cpc'])}",
        f"- CPA: {fmt_money(summary['overall_cpa'])}",
        f"- CVR: {fmt_rate(summary['overall_cvr'])}",
    ]
    if summary.get("revenue_available"):
        lines.extend([f"- ROAS: {fmt_x(summary['overall_roas'])}"])
    else:
        lines.extend(["- ROAS: n/a (revenue missing)"])

    lines.extend(["", "## Output trace", "### Analyst"])
    lines.extend(f"- {flag}" for flag in analysis["flags"])
    lines.extend(["", "### Strategist"])
    for item in strategy["actions"]:
        lines.append(f"- {item['priority']}. {item['action']} — {item['reason']}")
    lines.extend(["", "### Critic"])
    lines.extend(f"- {risk}" for risk in critique["risks"])
    lines.extend(["", "### Missing inputs"])
    lines.extend(f"- {gap}" for gap in critique["gaps"])
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Gnomeo agent MVP workflow.")
    parser.add_argument("csv_path", nargs="?", default=str(DEFAULT_INPUT), help="Path to a CSV file")
    args = parser.parse_args()

    source = Path(args.csv_path).expanduser().resolve()
    if not source.exists():
        raise SystemExit(f"Missing data file: {source}")

    campaigns = load_campaigns(source)
    analysis = analyst(campaigns)
    strategy = strategist(analysis)
    critique = critic(analysis, strategy)
    final = synthesizer(analysis, strategy, critique)
    report = build_report_text(source, analysis, strategy, critique, final)

    OUTPUT_REPORT.write_text(report, encoding="utf-8")

    print("Gnomeo agent MVP test")
    print("API mode: local mock (no remote calls)")
    print(f"Data source: {source}")
    print(f"Report written: {OUTPUT_REPORT}")
    print_section("ANALYST", analysis)
    print_section("STRATEGIST", strategy)
    print_section("CRITIC", critique)
    print("\n=== SYNTHESIZER ===")
    print(final)


if __name__ == "__main__":
    main()
