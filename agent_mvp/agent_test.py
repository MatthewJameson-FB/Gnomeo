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


def safe_ratio(numerator: float, denominator: float) -> Optional[float]:
    if not denominator:
        return None
    return numerator / denominator


def percentile(items: List[Campaign], pct: float, key_fn) -> List[Campaign]:
    if not items:
        return []
    count = max(1, int(round(len(items) * pct)))
    return sorted(items, key=key_fn)[:count]


def build_overall_summary(campaigns: List[Campaign]) -> Dict[str, Any]:
    total_spend = sum(c.spend for c in campaigns)
    total_impressions = sum(c.impressions for c in campaigns)
    total_clicks = sum(c.clicks for c in campaigns)
    total_conversions = sum(c.conversions for c in campaigns)
    revenue_values = [c.revenue for c in campaigns if c.revenue is not None]
    total_revenue = sum(revenue_values) if revenue_values else None
    weighted_cpa = safe_ratio(total_spend, total_conversions)
    avg_cpa = weighted_cpa

    return {
        "campaign_count": len(campaigns),
        "total_spend": total_spend,
        "total_impressions": total_impressions,
        "total_clicks": total_clicks,
        "total_conversions": total_conversions,
        "overall_ctr": safe_ratio(total_clicks, total_impressions),
        "overall_cpc": safe_ratio(total_spend, total_clicks),
        "overall_cpa": weighted_cpa,
        "overall_cvr": safe_ratio(total_conversions, total_clicks),
        "total_revenue": total_revenue,
        "overall_roas": safe_ratio(total_revenue, total_spend) if total_revenue is not None else None,
        "revenue_available": total_revenue is not None,
        "avg_cpa": avg_cpa,
    }


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


def split_by_performance(campaigns: List[Campaign], summary: Dict[str, Any]) -> Dict[str, Any]:
    avg_cpa = summary.get("avg_cpa") or 0.0
    wasted = [c for c in campaigns if c.cpa is not None and avg_cpa and c.cpa > 2 * avg_cpa]
    wasted_spend = sum(c.spend for c in wasted)
    wasted_share = safe_ratio(wasted_spend, summary["total_spend"]) if summary["total_spend"] else None

    by_roas = [c for c in campaigns if c.roas is not None]
    top_10 = percentile(by_roas, 0.10, lambda c: c.roas)
    bottom_20 = sorted(by_roas, key=lambda c: c.roas)[:max(1, int(round(len(by_roas) * 0.20)))] if by_roas else []

    return {
        "wasted_campaigns": wasted,
        "wasted_spend": wasted_spend,
        "wasted_share": wasted_share,
        "top_10": sorted(top_10, key=lambda c: c.roas, reverse=True),
        "bottom_20": bottom_20,
        "avg_cpa": avg_cpa,
    }


def analyst(campaigns: List[Campaign]) -> Dict[str, Any]:
    summary = build_overall_summary(campaigns)
    ranks = rank_campaigns(campaigns)
    perf = split_by_performance(campaigns, summary)
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
    if perf["wasted_share"] is not None:
        flags.append(f"Waste signal: {perf['wasted_share']*100:.1f}% of spend sits in campaigns with CPA > 2x average")
    if perf["top_10"]:
        flags.append(f"Top 10% performers by ROAS: {label(perf['top_10'][0])} ({fmt_x(perf['top_10'][0].roas)})")
    if perf["bottom_20"]:
        flags.append(f"Bottom 20% performers by ROAS: {label(perf['bottom_20'][0])} ({fmt_x(perf['bottom_20'][0].roas)})")

    return {"summary": summary, "ranks": ranks, "performance": perf, "flags": flags, "biggest_spend": biggest_spend}


def strategist(analysis: Dict[str, Any]) -> Dict[str, Any]:
    summary = analysis["summary"]
    perf = analysis["performance"]

    actions = []
    guardrails = [
        "Prefer within-platform optimization before any cross-channel budget moves.",
        "Cross-channel comparisons can be misleading because unit economics differ by platform, format, and funnel stage.",
    ]

    platforms = sorted({c.platform for c in perf["wasted_campaigns"] if c.platform})
    within_platform = None
    for platform in platforms:
        wasted_pool = [c for c in perf["wasted_campaigns"] if c.platform == platform]
        winners_pool = [c for c in perf["top_10"] if c.platform == platform]
        losers_pool = [c for c in perf["bottom_20"] if c.platform == platform]
        if wasted_pool and winners_pool and losers_pool:
            source = sorted(losers_pool, key=lambda c: c.roas or -1)[0]
            dest = sorted(winners_pool, key=lambda c: c.roas or -1, reverse=True)[0]
            if source is not dest:
                within_platform = (source, dest)
                break

    if within_platform:
        source, dest = within_platform
        move = min(source.spend * 0.15, source.spend)
        impact = max(0.0, move * max((dest.roas or 0) - (source.roas or 0), 0))
        actions.append({
            "priority": "1",
            "action": f"Reallocate {fmt_money(move)} from {label(source)} to {label(dest)}",
            "reason": f"Within-platform move keeps the comparison like-for-like and uses a bottom cohort source versus a top cohort destination.",
            "impact": fmt_money(impact),
            "risk": "If the source campaign is temporarily weak, trimming may cut future recovery.",
            "confidence": "Medium",
        })
    elif perf["wasted_campaigns"]:
        source = sorted(perf["wasted_campaigns"], key=lambda c: c.cpa or float('inf'), reverse=True)[0]
        trim = min(source.spend * 0.15, source.spend)
        impact = max(0.0, trim * max((source.cpa or 0) - (perf['avg_cpa'] or 0), 0) / max(1.0, source.cpa or 1.0))
        actions.append({
            "priority": "1",
            "action": f"Pause or trim {label(source)} by {fmt_money(trim)}",
            "reason": f"CPA is {fmt_money(source.cpa)} versus an average of {fmt_money(perf['avg_cpa'])}.",
            "impact": fmt_money(impact),
            "risk": "This assumes CPA is a good proxy for efficiency; attribution noise could mislead the cut.",
            "confidence": "High",
        })
    else:
        actions.append({
            "priority": "1",
            "action": "Hold budget steady and inspect the weakest campaigns first",
            "reason": "The dataset is too mixed to recommend a safe move without extra context.",
            "impact": "£0",
            "risk": "Noisy data makes a budget move unsafe.",
            "confidence": "Low",
        })

    if perf["wasted_campaigns"]:
        worst = sorted(perf["wasted_campaigns"], key=lambda c: c.cpa or float('inf'), reverse=True)[0]
        actions.append({
            "priority": str(len(actions) + 1),
            "action": f"Reduce {label(worst)} by {fmt_money(min(worst.spend * 0.10, worst.spend))}",
            "reason": f"That campaign is part of the {perf['wasted_share']*100:.1f}% wasted-spend bucket (CPA > 2x average).",
            "impact": fmt_money(min(worst.spend * 0.10, worst.spend) * 0.5),
            "risk": "Cutting too quickly can suppress volume before the signal is fully understood.",
            "confidence": "High",
        })

    best_cvr = max((c for c in perf["top_10"]), key=lambda c: c.cvr or -1, default=None)
    if best_cvr:
        boost = min(best_cvr.spend * 0.10, best_cvr.spend)
        actions.append({
            "priority": str(len(actions) + 1),
            "action": f"Increase {label(best_cvr)} by {fmt_money(boost)}",
            "reason": f"Best-in-class efficiency: ROAS {fmt_x(best_cvr.roas)} and CVR {fmt_rate(best_cvr.cvr)} within the top performer set.",
            "impact": fmt_money(max(0.0, boost * max((best_cvr.roas or 0) - 1.0, 0))),
            "risk": "The winner may already be near saturation, so gains may taper.",
            "confidence": "Medium",
        })

    return {"actions": actions[:3], "guardrails": guardrails}

def critic(analysis: Dict[str, Any], strategy: Dict[str, Any]) -> Dict[str, Any]:
    summary = analysis["summary"]
    perf = analysis["performance"]
    risks = [
        "Attribution quality can distort the winner/loser ranking.",
        "Budget shifts should stay measured if conversion volume is low or seasonal demand is changing.",
        "A high-CPA campaign may still be strategically valuable if it drives the right customers.",
        "Cross-channel comparisons can be misleading when platform mix, audience intent, and funnel stage differ.",
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
        "wasted_spend": perf["wasted_spend"],
        "wasted_share": perf["wasted_share"],
    }

def synthesizer(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any]) -> str:
    s = analysis["summary"]
    perf = analysis["performance"]
    decisions = strategy["actions"][:3]
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
        f"- Wasted spend (>2x avg CPA): {fmt_money(perf['wasted_spend'])}",
        f"- Wasted spend share: {fmt_rate(perf['wasted_share']) if perf['wasted_share'] is not None else 'n/a'}",
    ]
    if s.get("revenue_available"):
        lines.extend([f"- Revenue: {fmt_money(s['total_revenue'])}", f"- ROAS: {fmt_x(s['overall_roas'])}"])
    else:
        lines.append("- ROAS: n/a (revenue missing)")

    if analysis["flags"]:
        lines.extend(["", "### Key flags"])
        lines.extend(f"- {flag}" for flag in analysis["flags"])

    lines.extend(["", "## Decisions"])
    for idx, item in enumerate(decisions, 1):
        lines.append(
            f"{idx}. Decision: {item['action']}\n   Financial impact: {item.get('impact', 'n/a')}\n   Reason: {item['reason']}\n   Risk: {item.get('risk', 'n/a')}\n   Confidence: {item.get('confidence', 'Medium')}"
        )

    lines.extend(["", "## Guardrails"])
    lines.extend(f"- {item}" for item in strategy.get("guardrails", []))
    lines.extend(["", "## Critic"])
    lines.extend(f"- {risk}" for risk in critique["risks"])
    lines.extend(["", "### Missing inputs"])
    lines.extend(f"- {gap}" for gap in critique["gaps"])
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
    perf = analysis["performance"]
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
        f"- Wasted spend: {fmt_money(perf['wasted_spend'])}",
        f"- Wasted spend share: {fmt_rate(perf['wasted_share']) if perf['wasted_share'] is not None else 'n/a'}",
    ]
    if summary.get("revenue_available"):
        lines.append(f"- ROAS: {fmt_x(summary['overall_roas'])}")
    else:
        lines.append("- ROAS: n/a (revenue missing)")

    lines.extend(["", "## Output trace", "### Analyst"])
    lines.extend(f"- {flag}" for flag in analysis["flags"])
    lines.extend(["", "### Decisions"])
    for idx, item in enumerate(strategy["actions"][:3], 1):
        lines.append(f"{idx}. Decision: {item['action']} | Financial impact: {item.get('impact', 'n/a')} | Reason: {item['reason']} | Risk: {item.get('risk', 'n/a')} | Confidence: {item.get('confidence', 'Medium')}")
    lines.extend(["", "### Guardrails"])
    lines.extend(f"- {item}" for item in strategy.get("guardrails", []))
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
