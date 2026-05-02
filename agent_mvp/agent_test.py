#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / "sample_ads_data.csv"
OUTPUT_REPORT = ROOT / "output_report.md"
OUTPUT_HTML = ROOT / "output_report.html"

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
    def campaign_group(self) -> str:
        if "|" in self.campaign:
            return self.campaign.split("|")[0].strip() or self.campaign.strip()
        return self.campaign.strip() or self.platform.strip() or "Unassigned"

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


@dataclass
class BusinessProfile:
    stage: str = "balanced"
    objective: str = "efficient growth"
    acceptable_cpa: Optional[float] = None
    acceptable_roas: Optional[float] = None


@dataclass
class Thresholds:
    acceptable_cpa: float
    acceptable_roas: Optional[float]
    cpa_floor: float
    roas_floor: Optional[float]
    source: str


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
            campaign_name = _row_text(row, columns["campaign"]) or " | ".join(
                [part for part in [platform, campaign_type, industry, country] if part]
            )

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


def build_overall_summary(campaigns: List[Campaign]) -> Dict[str, Any]:
    total_spend = sum(c.spend for c in campaigns)
    total_impressions = sum(c.impressions for c in campaigns)
    total_clicks = sum(c.clicks for c in campaigns)
    total_conversions = sum(c.conversions for c in campaigns)
    revenue_values = [c.revenue for c in campaigns if c.revenue is not None]
    total_revenue = sum(revenue_values) if revenue_values else None

    return {
        "campaign_count": len(campaigns),
        "total_spend": total_spend,
        "total_impressions": total_impressions,
        "total_clicks": total_clicks,
        "total_conversions": total_conversions,
        "overall_ctr": safe_ratio(total_clicks, total_impressions),
        "overall_cpc": safe_ratio(total_spend, total_clicks),
        "overall_cpa": safe_ratio(total_spend, total_conversions),
        "overall_cvr": safe_ratio(total_conversions, total_clicks),
        "total_revenue": total_revenue,
        "overall_roas": safe_ratio(total_revenue, total_spend) if total_revenue is not None else None,
        "revenue_available": total_revenue is not None,
    }


def campaign_group_summary(campaigns: List[Campaign]) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[Campaign]] = {}
    for campaign in campaigns:
        grouped.setdefault(campaign.campaign_group, []).append(campaign)

    segments: List[Dict[str, Any]] = []
    for group_name, items in grouped.items():
        spend = sum(c.spend for c in items)
        impressions = sum(c.impressions for c in items)
        clicks = sum(c.clicks for c in items)
        conversions = sum(c.conversions for c in items)
        revenue_values = [c.revenue for c in items if c.revenue is not None]
        revenue = sum(revenue_values) if revenue_values else None
        segments.append(
            {
                "campaign_group": group_name,
                "campaigns": len(items),
                "spend": spend,
                "impressions": impressions,
                "clicks": clicks,
                "conversions": conversions,
                "cpa": safe_ratio(spend, conversions),
                "roas": safe_ratio(revenue, spend) if revenue is not None else None,
                "ctr": safe_ratio(clicks, impressions),
                "cvr": safe_ratio(conversions, clicks),
            }
        )
    return sorted(segments, key=lambda row: row["spend"], reverse=True)


def profile_interpreter(campaigns: List[Campaign], args: argparse.Namespace) -> Dict[str, Any]:
    summary = build_overall_summary(campaigns)
    base_cpa = summary["overall_cpa"] or median([c.cpa for c in campaigns if c.cpa is not None] or [1.0])
    base_roas = summary["overall_roas"]

    profile = BusinessProfile(
        stage=args.business_stage,
        objective=args.objective,
        acceptable_cpa=args.acceptable_cpa,
        acceptable_roas=args.acceptable_roas,
    )

    if profile.acceptable_cpa is not None:
        acceptable_cpa = profile.acceptable_cpa
        source = "CLI override"
    else:
        stage = profile.stage.lower()
        if stage == "defensive":
            acceptable_cpa = base_cpa * 0.90
        elif stage == "growth":
            acceptable_cpa = base_cpa * 1.10
        else:
            acceptable_cpa = base_cpa * 1.00
        source = f"profile stage: {profile.stage}"

    if profile.acceptable_roas is not None:
        acceptable_roas = profile.acceptable_roas
        roas_source = "CLI override"
    elif base_roas is not None:
        stage = profile.stage.lower()
        if stage == "defensive":
            acceptable_roas = max(2.0, base_roas * 1.10)
        elif stage == "growth":
            acceptable_roas = max(1.8, base_roas * 0.95)
        else:
            acceptable_roas = max(1.9, base_roas * 1.00)
        roas_source = f"profile stage: {profile.stage}"
    else:
        acceptable_roas = None
        roas_source = "revenue unavailable"

    return {
        "profile": {
            "stage": profile.stage,
            "objective": profile.objective,
        },
        "thresholds": Thresholds(
            acceptable_cpa=acceptable_cpa,
            acceptable_roas=acceptable_roas,
            cpa_floor=base_cpa,
            roas_floor=base_roas,
            source=source,
        ),
        "roas_source": roas_source,
    }


def percentile(items: List[Campaign], pct: float, key_fn) -> List[Campaign]:
    if not items:
        return []
    count = max(1, int(round(len(items) * pct)))
    return sorted(items, key=key_fn)[:count]


def top_percent(items: List[Campaign], pct: float, key_fn) -> List[Campaign]:
    if not items:
        return []
    count = max(1, int(round(len(items) * pct)))
    return sorted(items, key=key_fn, reverse=True)[:count]


def split_by_performance(campaigns: List[Campaign], thresholds: Thresholds, summary: Dict[str, Any]) -> Dict[str, Any]:
    profiled_cpa = thresholds.acceptable_cpa or summary["overall_cpa"] or 0.0
    wasted = [c for c in campaigns if c.cpa is not None and profiled_cpa and c.cpa > 2 * profiled_cpa]
    wasted_spend = sum(c.spend for c in wasted)
    wasted_share = safe_ratio(wasted_spend, summary["total_spend"]) if summary["total_spend"] else None

    roas_ready = [c for c in campaigns if c.roas is not None]
    top_10 = top_percent(roas_ready, 0.10, lambda c: c.roas or -1.0)
    bottom_20 = percentile(roas_ready, 0.20, lambda c: c.roas or -1.0)

    return {
        "wasted_campaigns": wasted,
        "wasted_spend": wasted_spend,
        "wasted_share": wasted_share,
        "top_10": sorted(top_10, key=lambda c: c.roas or -1.0, reverse=True),
        "bottom_20": bottom_20,
    }


# -----------------------------
# Layer 1: PROFILE INTERPRETER
# -----------------------------

def run_profile_interpreter(campaigns: List[Campaign], args: argparse.Namespace) -> Dict[str, Any]:
    return profile_interpreter(campaigns, args)


# -----------------------------
# Layer 2: ANALYST
# -----------------------------

def analyst(campaigns: List[Campaign], context: Dict[str, Any]) -> Dict[str, Any]:
    summary = build_overall_summary(campaigns)
    thresholds: Thresholds = context["thresholds"]
    performance = split_by_performance(campaigns, thresholds, summary)
    group_segments = campaign_group_summary(campaigns)

    insights = []
    if summary["overall_cpa"] is not None:
        insights.append(f"Blended CPA: {fmt_money(summary['overall_cpa'])}")
    if summary["overall_roas"] is not None:
        insights.append(f"Blended ROAS: {fmt_x(summary['overall_roas'])}")
    insights.append(f"Acceptable CPA threshold: {fmt_money(thresholds.acceptable_cpa)}")
    if thresholds.acceptable_roas is not None:
        insights.append(f"Acceptable ROAS threshold: {fmt_x(thresholds.acceptable_roas)}")
    if performance["wasted_share"] is not None:
        insights.append(f"Wasted spend: {fmt_money(performance['wasted_spend'])} ({performance['wasted_share'] * 100:.1f}%)")

    return {
        "profile": context["profile"],
        "campaigns": campaigns,
        "summary": summary,
        "thresholds": thresholds,
        "segments": group_segments,
        "performance": performance,
        "insights": insights,
    }


# -----------------------------
# Layer 3: STRATEGIST (initial pass)
# -----------------------------

def strategist_initial(analysis: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    campaigns = analysis["campaigns"]
    thresholds: Thresholds = analysis["thresholds"]
    perf = analysis["performance"]

    all_campaigns = sorted(campaigns, key=lambda c: c.spend, reverse=True)

    def meets_scale_gate(c: Campaign) -> bool:
        cpa_ok = c.cpa is not None and c.cpa <= thresholds.acceptable_cpa
        roas_ok = thresholds.acceptable_roas is None or (c.roas is not None and c.roas >= thresholds.acceptable_roas)
        return cpa_ok and roas_ok

    winners = [c for c in all_campaigns if meets_scale_gate(c)]
    if not winners:
        winners = [c for c in sorted(perf["top_10"], key=lambda c: (c.roas or -1.0, c.spend), reverse=True)]

    losers = [c for c in all_campaigns if c.cpa is not None and c.cpa > thresholds.acceptable_cpa]
    if not losers:
        losers = [c for c in sorted(perf["bottom_20"], key=lambda c: (c.roas or 0.0, c.spend))]

    by_platform: Dict[str, List[Campaign]] = {}
    for campaign in all_campaigns:
        by_platform.setdefault(campaign.platform or "Unassigned", []).append(campaign)

    source = None
    destination = None
    for platform, items in by_platform.items():
        weak = sorted([c for c in items if c in losers], key=lambda c: (c.cpa or float("inf"), c.roas or -1.0), reverse=True)
        strong = sorted([c for c in items if c in winners], key=lambda c: (c.roas or -1.0, -(c.cpa or 0.0)), reverse=True)
        if weak and strong and weak[0] is not strong[0]:
            source = weak[0]
            destination = strong[0]
            break

    if source is None and losers:
        source = sorted(losers, key=lambda c: (c.cpa or float("inf"), c.spend), reverse=True)[0]
    if destination is None and winners:
        destination = sorted(winners, key=lambda c: (c.roas or -1.0, c.spend), reverse=True)[0]

    actions: List[Dict[str, Any]] = []

    if source and destination and source is not destination:
        move = round(min(source.spend * 0.20, max(source.spend, 1.0)), 2)
        actions.append(
            {
                "type": "reallocate",
                "from": label(source),
                "to": label(destination),
                "amount": move,
                "action": f"Move {fmt_money(move)} from {label(source)} to {label(destination)}",
                "reason": "Shifts spend from the weaker campaign into the stronger one while staying within the same platform where possible.",
                "confidence": "Medium",
            }
        )

    if losers:
        pause_target = sorted(losers, key=lambda c: (c.cpa or float("inf"), c.spend), reverse=True)[0]
        cut = round(min(max(pause_target.spend * 0.25, 0.0), pause_target.spend), 2)
        actions.append(
            {
                "type": "pause",
                "campaign": label(pause_target),
                "amount": cut,
                "action": f"Pause or cut {label(pause_target)} by {fmt_money(cut)}",
                "reason": "This campaign sits above the acceptable CPA threshold and should give up budget first.",
                "confidence": "High",
            }
        )

    if winners:
        scale_target = sorted(winners, key=lambda c: (c.roas or -1.0, -(c.cpa or 0.0), c.spend), reverse=True)[0]
        boost = round(min(max(scale_target.spend * 0.15, 0.0), scale_target.spend * 0.5), 2)
        actions.append(
            {
                "type": "scale",
                "campaign": label(scale_target),
                "amount": boost,
                "action": f"Scale {label(scale_target)} by {fmt_money(boost)}",
                "reason": "This campaign clears the profile threshold on CPA and ROAS, so it is the best candidate for extra budget.",
                "confidence": "Medium",
            }
        )

    while len(actions) < 3:
        actions.append(
            {
                "type": "hold",
                "action": "Hold budget and monitor the current mix",
                "amount": 0.0,
                "reason": "There is not enough clean signal to justify another move.",
                "confidence": "Low",
            }
        )

    base_confidence = "Low" if len(winners) == 0 or len(losers) == 0 else ("High" if len(winners) >= 2 and len(losers) >= 1 else "Medium")
    return {"actions": actions[:3], "confidence": base_confidence}


# -----------------------------
# Layer 3b: STRATEGIST (refinement pass)
# -----------------------------

def strategist_refinement(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    refined_actions: List[Dict[str, Any]] = []
    critique_map = {item["action"]: item for item in critique["critiques"]}
    low_confidence = strategy.get("confidence") == "Low"

    for action in strategy["actions"][:3]:
        critique_item = critique_map.get(action["action"])
        updated = dict(action)

        if critique_item:
            updated["reason"] = f"{action['reason']} Addressing critique: {critique_item['challenge']}"
            updated["addressed_criticisms"] = [
                critique_item["flawed_assumption"],
                critique_item["weak_signal"],
                critique_item["attribution_risk"],
            ]

        if low_confidence and action["type"] == "scale":
            updated["amount"] = round(action["amount"] * 0.5, 2)
            updated["action"] = action["action"].replace("Scale ", "Scale cautiously: ")
            updated["reason"] = f"{updated['reason']} Reduced due to low confidence in the signal."
            updated["confidence"] = "Low"
        elif low_confidence and action["type"] == "reallocate":
            updated["amount"] = round(action["amount"] * 0.5, 2)
            updated["action"] = action["action"].replace("Move ", "Move cautiously: ")
            updated["reason"] = f"{updated['reason']} Reduced due to low confidence in the signal."
            updated["confidence"] = "Low"
        elif critique_item and action["type"] == "pause":
            updated["confidence"] = "Medium"

        refined_actions.append(updated)

    while len(refined_actions) < 3:
        refined_actions.append({
            "type": "hold",
            "action": "Hold budget and monitor the current mix",
            "amount": 0.0,
            "reason": "Refinement did not uncover a safer action.",
            "confidence": "Low",
            "addressed_criticisms": ["Insufficient signal for further movement."],
        })

    return {"actions": refined_actions[:3], "confidence": "Low" if low_confidence else strategy.get("confidence", "Medium")}


# -----------------------------
# Layer 4: CRITIC
# -----------------------------

def critic(analysis: Dict[str, Any], strategy: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    thresholds: Thresholds = analysis["thresholds"]
    perf = analysis["performance"]
    critiques: List[Dict[str, Any]] = []

    for action in strategy["actions"][:3]:
        if action["type"] == "reallocate":
            source_name = action.get("from", "unknown source")
            critiques.append(
                {
                    "action": action["action"],
                    "challenge": f"The move assumes {source_name} is structurally weak rather than temporarily noisy.",
                    "flawed_assumption": "Recent underperformance may not persist.",
                    "weak_signal": "Campaign-level rollups can hide ad-level or audience-level pockets of strength.",
                    "attribution_risk": "Platform attribution windows may overstate the destination campaign's advantage.",
                }
            )
        elif action["type"] == "pause":
            critiques.append(
                {
                    "action": action["action"],
                    "challenge": "The pause logic relies heavily on CPA alone and may miss upper-funnel value.",
                    "flawed_assumption": "High CPA always means low value.",
                    "weak_signal": "The dataset does not include margin, lag, or assisted conversion data.",
                    "attribution_risk": "Last-click bias could make the campaign look worse than it is.",
                }
            )
        elif action["type"] == "scale":
            critiques.append(
                {
                    "action": action["action"],
                    "challenge": "The scale decision assumes past efficiency will hold at a larger spend level.",
                    "flawed_assumption": "Winning at current spend guarantees scaling efficiency.",
                    "weak_signal": "The sample is small enough that one campaign can dominate the ranking.",
                    "attribution_risk": "ROAS may be inflated if conversion lag is unresolved.",
                }
            )
        else:
            critiques.append(
                {
                    "action": action["action"],
                    "challenge": "Holding budget is safe, but it also delays action on obvious signal.",
                    "flawed_assumption": "Inaction is neutral when the data already shows spread.",
                    "weak_signal": "The hold only makes sense if the dataset is too thin to trust.",
                    "attribution_risk": "None added; the bigger issue is missed opportunity.",
                }
            )

    if perf["wasted_share"] is not None and perf["wasted_share"] > 0.20:
        critiques.append(
            {
                "action": "Portfolio-level note",
                "challenge": "A meaningful share of spend sits in CPA outliers, so the strategist should be conservative about the pause/scale split.",
                "flawed_assumption": "The whole account behaves like the average campaign.",
                "weak_signal": "Outliers are large enough to skew the benchmark.",
                "attribution_risk": "Cross-channel averaging may blur meaningful platform differences.",
            }
        )

    return {"critiques": critiques[:3]}


# -----------------------------
# Layer 5: SYNTHESIZER
# -----------------------------

def synthesizer(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    summary = analysis["summary"]
    perf = analysis["performance"]
    thresholds: Thresholds = analysis["thresholds"]

    lines = [
        "# Gnomeo Agent MVP Report",
        "",
        "## Profile Interpreter",
        f"- Stage: {analysis['profile']['stage']}",
        f"- Objective: {analysis['profile']['objective']}",
        f"- Acceptable CPA: {fmt_money(thresholds.acceptable_cpa)}",
        f"- Acceptable ROAS: {fmt_x(thresholds.acceptable_roas)}" if thresholds.acceptable_roas is not None else "- Acceptable ROAS: n/a",
        "",
        "## Analyst",
        f"- Campaigns analyzed: {summary['campaign_count']}",
        f"- Total spend: {fmt_money(summary['total_spend'])}",
        f"- Total impressions: {summary['total_impressions']:,.0f}",
        f"- Total clicks: {summary['total_clicks']:,.0f}",
        f"- Total conversions: {summary['total_conversions']:,.0f}",
        f"- CTR: {fmt_rate(summary['overall_ctr'])}",
        f"- CPC: {fmt_money(summary['overall_cpc'])}",
        f"- CPA: {fmt_money(summary['overall_cpa'])}",
        f"- CVR: {fmt_rate(summary['overall_cvr'])}",
        f"- Wasted spend (>2x acceptable CPA): {fmt_money(perf['wasted_spend'])}",
        f"- Wasted spend share: {fmt_rate(perf['wasted_share']) if perf['wasted_share'] is not None else 'n/a'}",
    ]
    if summary.get("revenue_available"):
        lines.extend([f"- Revenue: {fmt_money(summary['total_revenue'])}", f"- ROAS: {fmt_x(summary['overall_roas'])}"])
    else:
        lines.append("- ROAS: n/a (revenue missing)")

    lines.extend(["", "### Campaign-group segmentation"])
    for segment in analysis["segments"]:
        lines.append(
            f"- {segment['campaign_group']}: spend {fmt_money(segment['spend'])}, CPA {fmt_money(segment['cpa'])}, ROAS {fmt_x(segment['roas'])}, campaigns {segment['campaigns']}"
        )

    lines.extend(["", "### Analyst insights"])
    lines.extend(f"- {item}" for item in analysis["insights"])

    lines.extend(["", "### Top 10% performers"])
    lines.extend(f"- {label(item)} ({fmt_x(item.roas)})" for item in perf["top_10"])

    lines.extend(["", "### Bottom 20% performers"])
    lines.extend(f"- {label(item)} ({fmt_x(item.roas)})" for item in perf["bottom_20"])

    lines.extend(["", "## Strategist"])
    for item in strategy["actions"][:3]:
        lines.append(f"- {item['action']} | £ amount: {fmt_money(item.get('amount', 0.0))} | Reason: {item['reason']}")
        if item.get("addressed_criticisms"):
            for criticism in item["addressed_criticisms"]:
                lines.append(f"  - Addresses: {criticism}")

    lines.extend(["", "## Critic"])
    for item in critique["critiques"][:3]:
        lines.append(f"- {item['action']}: {item['challenge']}")
        lines.append(f"  - Flawed assumption: {item['flawed_assumption']}")
        lines.append(f"  - Weak signal: {item['weak_signal']}")
        lines.append(f"  - Attribution risk: {item['attribution_risk']}")

    lines.extend(["", "## Decisions"])
    for idx, (action, challenge, sim) in enumerate(zip(strategy["actions"][:3], critique["critiques"][:3], simulation["decisions"][:3]), 1):
        if action["type"] == "pause":
            risk = challenge["attribution_risk"]
            confidence = "Medium"
        elif action["type"] == "scale":
            risk = challenge["attribution_risk"]
            confidence = "Medium"
        elif action["type"] == "reallocate":
            risk = challenge["attribution_risk"]
            confidence = "Medium"
        else:
            risk = challenge["weak_signal"]
            confidence = "Low"

        lines.append(
            f"{idx}. Action: {action['action']}\n   £ amount: {fmt_money(action.get('amount', 0.0))}\n   Reason: {action['reason']}\n   Expected impact: {action.get('expected_impact', 'n/a')}\n   Timeframe: {action.get('timeframe', 'n/a')}\n   Source ROAS: {fmt_x(sim['source_roas'])}\n   Target ROAS: {fmt_x(sim['target_roas'])}\n   Delta: {fmt_x(sim['delta'])}\n   Theoretical gain: {fmt_money(sim['theoretical_gain'])}\n   Adjusted expected gain: {fmt_money(sim['adjusted_expected_gain'])}\n   Assumptions: {', '.join(sim['assumptions'])}\n   Risk: {risk}\n   What to monitor: {action.get('monitor', 'n/a')}\n   Confidence: {confidence}"
        )

    lines.extend(["", "## Flow control"])
    lines.append("- Required flow enforced: Analyst → Strategist → Critic → Strategist (refinement) → Synthesizer.")
    lines.append("- Only one critique round is used, and only one strategist refinement follows it.")
    lines.append("- Maximum total passes = 2 strategist passes; no recursive or open-ended loops.")
    lines.append("- Synthesizer is final authority; no post-output revision path exists.")

    lines.extend(["", "## Case study", "### Before"])
    before = simulation["before"]
    lines.append(f"- Revenue: {fmt_money(before['revenue'])}")
    lines.append(f"- ROAS: {fmt_x(before['roas'])}")
    lines.append(f"- CPA: {fmt_money(before['cpa'])}")
    lines.extend(["", "### After (projected)"])
    after = simulation["after"]
    lines.append(f"- Revenue: {fmt_money(after['revenue'])}")
    lines.append(f"- ROAS: {fmt_x(after['roas'])}")
    lines.append(f"- CPA: {fmt_money(after['cpa'])}")
    lines.append(f"- Total theoretical gain: {fmt_money(simulation['total_theoretical_gain'])}")
    lines.append(f"- Total adjusted expected gain: {fmt_money(simulation['total_expected_gain'])}")
    lines.extend(["", "### Assumptions"])
    for item in simulation["decisions"][:3]:
        lines.append(f"- {item['action']}")
        for assumption in item["assumptions"]:
            lines.append(f"  - {assumption}")

    return "\n".join(lines)


def evaluate_output(strategy: Dict[str, Any], critique: Dict[str, Any]) -> Dict[str, Any]:
    decisions = strategy["actions"][:3]
    critique_count = len(critique.get("critiques", [])[:3])

    concrete_actions = sum(1 for item in decisions if item.get("type") in {"reallocate", "pause", "scale"})
    numeric_impacts = sum(1 for item in decisions if isinstance(item.get("amount"), (int, float)))
    has_risks = sum(1 for item in decisions if item.get("type") in {"reallocate", "pause", "scale"})
    confidence_levels = [item.get("confidence", "") for item in decisions]
    has_non_low_confidence = any(level != "Low" for level in confidence_levels)

    actionability = 5 if concrete_actions == 3 else 4 if concrete_actions == 2 else 3
    if all(item.get("reason") for item in decisions):
        actionability = min(5, actionability + 1)

    financial_clarity = 5 if numeric_impacts == 3 and all(item.get("amount") is not None for item in decisions) else 4 if numeric_impacts >= 2 else 3
    if any(item.get("amount", 0) == 0 for item in decisions):
        financial_clarity = max(3, financial_clarity - 1)

    risk_awareness = 5 if critique_count == 3 and has_risks == 3 and all(item.get("Risk", True) for item in decisions) else 4
    if any(item.get("confidence") == "Low" for item in decisions):
        risk_awareness = min(risk_awareness, 4)

    confidence_quality = 5 if all(level in {"High", "Medium"} for level in confidence_levels) and has_non_low_confidence else 4
    if confidence_levels.count("Low") >= 2:
        confidence_quality = 3

    overall = round((actionability + financial_clarity + risk_awareness + confidence_quality) / 4)
    overall = max(1, min(5, overall))

    return {
        "actionability": {
            "score": actionability,
            "reason": "All 3 decisions are concrete actions with explicit implementation steps." if actionability >= 4 else "Some actions are still too generic.",
        },
        "financial_clarity": {
            "score": financial_clarity,
            "reason": "Each decision includes a numeric £ amount and visible budget direction." if financial_clarity >= 4 else "Financial impact is under-specified.",
        },
        "risk_awareness": {
            "score": risk_awareness,
            "reason": "The critic adds distinct risks to every decision." if risk_awareness >= 4 else "Risk handling is too thin.",
        },
        "confidence_quality": {
            "score": confidence_quality,
            "reason": "Confidence is calibrated and not overstated." if confidence_quality >= 4 else "Confidence is either missing or too soft.",
        },
        "overall": {
            "score": overall,
            "reason": "The output is structured, specific, and client-ready enough for a first-pass decision packet." if overall >= 4 else "The output still needs more refinement before client use.",
        },
    }


def format_expected_impact(action: Dict[str, Any], summary: Dict[str, Any]) -> str:
    total_spend = summary["total_spend"] or 0.0
    cpa = action.get("cpa")
    roas = action.get("roas")
    cvr = action.get("cvr")
    base_cpa = summary.get("overall_cpa")
    base_roas = summary.get("overall_roas")

    if action["type"] == "scale":
        if roas is not None and base_roas is not None:
            return f"Expected to lift ROAS from {fmt_x(base_roas)} to around {fmt_x(min(roas * 1.05, roas * 1.15))} if efficiency holds; CPA should stay near {fmt_money(cpa)} and conversions should rise by roughly 10–15%."
        return "Expected to increase conversions by roughly 10–15% with CPA staying broadly stable if the additional budget absorbs cleanly."

    if action["type"] == "pause":
        if cpa is not None and base_cpa is not None:
            return f"Expected to reduce blended CPA by trimming a weak spender, with ROAS improving modestly as spend shifts away from {fmt_money(cpa)} CPA traffic; conversions may fall slightly in the short term."
        return "Expected to improve efficiency by removing a weak spend pocket, with a possible short-term dip in volume."

    if action["type"] == "reallocate":
        if roas is not None and base_roas is not None:
            return f"Expected to improve ROAS from {fmt_x(base_roas)} toward {fmt_x(min(base_roas * 1.08, (roas or base_roas) * 1.05))}, with CPA drifting down or holding steady and conversions staying broadly flat to slightly up."
        return "Expected to shift spend toward a stronger efficiency pocket, improving CPA modestly while keeping conversions broadly stable."

    return "Expected impact is limited; this is a hold decision rather than a budget move."


def expected_timeframe(action: Dict[str, Any]) -> str:
    if action["type"] == "scale":
        return "7–14 days"
    if action["type"] == "pause":
        return "3–7 days"
    if action["type"] == "reallocate":
        return "7–14 days"
    return "7 days"


def basis_for_amount(action: Dict[str, Any], summary: Dict[str, Any]) -> str:
    total_spend = summary["total_spend"] or 0.0
    pct = (action.get("amount", 0.0) / total_spend * 100) if total_spend else 0.0
    if action["type"] == "reallocate":
        return f"Chosen as a {pct:.0f}% account-level move from the weaker campaign, staying inside a 10–20% test band."
    if action["type"] == "pause":
        return f"Chosen as a {pct:.0f}% cut of the weak campaign, which is a safe test threshold for reducing waste without overcorrecting."
    if action["type"] == "scale":
        return f"Chosen as a {pct:.0f}% budget lift, keeping the test in the 10–20% range so scaling does not outrun the signal."
    return "Chosen as a zero-change hold because the signal is not strong enough to justify a budget move."


def post_action_monitor(action: Dict[str, Any]) -> str:
    if action["type"] == "scale":
        return "Monitor CPA, ROAS, conversion volume, and impression share for saturation."
    if action["type"] == "pause":
        return "Monitor total conversions, blended CPA, and whether any lost volume shows up elsewhere."
    if action["type"] == "reallocate":
        return "Monitor CPA and ROAS on both source and destination campaigns, plus total conversions."
    return "Monitor whether performance stabilises without further budget movement."


def enrich_decisions(strategy: Dict[str, Any], analysis: Dict[str, Any]) -> Dict[str, Any]:
    summary = analysis["summary"]
    enriched_actions: List[Dict[str, Any]] = []
    for action in strategy["actions"][:3]:
        updated = dict(action)
        updated["expected_impact"] = format_expected_impact(action, summary)
        updated["timeframe"] = expected_timeframe(action)
        updated["basis_for_amount"] = basis_for_amount(action, summary)
        updated["monitor"] = post_action_monitor(action)
        enriched_actions.append(updated)
    return {**strategy, "actions": enriched_actions[:3]}


def normalize_name(value: str) -> str:
    return (value or "").strip().lower().replace("|", " ").replace("  ", " ")


def build_campaign_lookup(campaigns: List[Campaign]) -> Dict[str, Campaign]:
    lookup: Dict[str, Campaign] = {}
    for campaign in campaigns:
        keys = {
            normalize_name(campaign.campaign),
            normalize_name(campaign.campaign_group),
            normalize_name(campaign.platform),
        }
        for key in keys:
            if key and key not in lookup:
                lookup[key] = campaign
    return lookup


def pick_best_target(campaigns: List[Campaign], exclude: Optional[Campaign] = None) -> Optional[Campaign]:
    candidates = [c for c in campaigns if c is not exclude and c.roas is not None]
    return max(candidates, key=lambda c: c.roas or -1.0, default=None)


def simulate_decision(action: Dict[str, Any], analysis: Dict[str, Any], campaigns: List[Campaign]) -> Dict[str, Any]:
    lookup = build_campaign_lookup(campaigns)
    summary = analysis["summary"]
    total_revenue = summary["total_revenue"] or 0.0
    spend = float(action.get("amount", 0.0) or 0.0)

    source = None
    target = None
    if action["type"] == "reallocate":
        source = lookup.get(normalize_name(action.get("from", "")))
        target = lookup.get(normalize_name(action.get("to", "")))
    elif action["type"] == "pause":
        source = lookup.get(normalize_name(action.get("campaign", "")))
        target = pick_best_target(campaigns, exclude=source)
    elif action["type"] == "scale":
        source = None
        target = lookup.get(normalize_name(action.get("campaign", "")))

    source_roas = source.roas if source and source.roas is not None else summary.get("overall_roas") or 0.0
    target_roas = target.roas if target and target.roas is not None else summary.get("overall_roas") or source_roas
    if action["type"] == "scale" and source is None:
        source_roas = summary.get("overall_roas") or 0.0

    delta = target_roas - source_roas
    theoretical_gain = spend * delta
    expected_gain = theoretical_gain * 0.5

    current_revenue = total_revenue
    projected_revenue = max(0.0, current_revenue + expected_gain)
    projected_roas = (projected_revenue / summary["total_spend"]) if summary["total_spend"] else None

    if action["type"] == "pause":
        assumptions = [
            "Savings are redeployed or retained rather than fully lost.",
            "The paused campaign is genuinely below the account average.",
            "No major attribution lag hides the true value of the source campaign.",
        ]
    elif action["type"] == "scale":
        assumptions = [
            "The campaign keeps a similar efficiency profile when budget rises.",
            "No saturation or audience fatigue appears inside the test window.",
            "Extra spend converts at roughly the same ROAS as current spend, then is discounted by the realism factor.",
        ]
    else:
        assumptions = [
            "The destination campaign can absorb extra spend without a sharp ROAS drop.",
            "The source campaign can lose spend without creating hidden downstream value loss.",
            "The 50% realism factor covers normal execution slippage.",
        ]

    return {
        **action,
        "source_campaign": label(source) if source else action.get("from") or action.get("campaign") or "account baseline",
        "target_campaign": label(target) if target else action.get("to") or action.get("campaign") or "account baseline",
        "source_roas": source_roas,
        "target_roas": target_roas,
        "delta": delta,
        "theoretical_gain": theoretical_gain,
        "adjusted_expected_gain": expected_gain,
        "current_revenue": current_revenue,
        "projected_revenue": projected_revenue,
        "projected_roas": projected_roas,
        "assumptions": assumptions,
    }


def simulate_projections(strategy: Dict[str, Any], analysis: Dict[str, Any]) -> Dict[str, Any]:
    decisions = [simulate_decision(action, analysis, analysis["campaigns"]) for action in strategy["actions"][:3]]
    total_expected_gain = sum(item["adjusted_expected_gain"] for item in decisions)
    summary = analysis["summary"]
    projected_revenue = max(0.0, (summary["total_revenue"] or 0.0) + total_expected_gain)
    projected_roas = (projected_revenue / summary["total_spend"]) if summary["total_spend"] else None
    projected_cpa = (summary["total_spend"] / summary["total_conversions"]) if summary["total_conversions"] else None

    return {
        "decisions": decisions,
        "before": {
            "revenue": summary["total_revenue"] or 0.0,
            "roas": summary["overall_roas"],
            "cpa": summary["overall_cpa"],
        },
        "after": {
            "revenue": projected_revenue,
            "roas": projected_roas,
            "cpa": projected_cpa,
        },
        "total_theoretical_gain": sum(item["theoretical_gain"] for item in decisions),
        "total_expected_gain": total_expected_gain,
    }


def render_evaluation(evaluation: Dict[str, Any]) -> str:
    lines = ["## Evaluation"]
    labels = [
        ("Actionability", "actionability"),
        ("Financial clarity", "financial_clarity"),
        ("Risk awareness", "risk_awareness"),
        ("Confidence quality", "confidence_quality"),
        ("Overall decision quality", "overall"),
    ]
    for label, key in labels:
        item = evaluation[key]
        lines.append(f"- {label} score: {item['score']}/5 — {item['reason']}")
    return "\n".join(lines)


def render_key_decisions(strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    lines = ["## Key Decisions (3)"]
    for idx, (action, challenge, sim) in enumerate(zip(strategy["actions"][:3], critique["critiques"][:3], simulation["decisions"][:3]), 1):
        risk = challenge["attribution_risk"] if action["type"] in {"pause", "scale", "reallocate"} else challenge["weak_signal"]
        lines.extend([
            f"### {idx}. {action['action']}",
            f"- £ amount: {fmt_money(action.get('amount', 0.0))}",
            f"- Reason: {action['reason']}",
            f"- Expected impact: {action.get('expected_impact', 'n/a')}",
            f"- Timeframe: {action.get('timeframe', 'n/a')}",
            f"- Theoretical gain: {fmt_money(sim['theoretical_gain'])}",
            f"- Adjusted expected gain: {fmt_money(sim['adjusted_expected_gain'])}",
            f"- Risk: {risk}",
            f"- What to monitor: {action.get('monitor', 'n/a')}",
            f"- Confidence: {action.get('confidence', 'Medium')}",
        ])
    return "\n".join(lines)


def render_expected_impact(simulation: Dict[str, Any], perf: Dict[str, Any]) -> str:
    before = simulation["before"]
    after = simulation["after"]
    lines = ["## Expected Impact"]
    lines.extend([
        f"- Wasted spend: {fmt_money(perf['wasted_spend'])} ({perf['wasted_share'] * 100:.1f}%)" if perf["wasted_share"] is not None else f"- Wasted spend: {fmt_money(perf['wasted_spend'])}",
        f"- Projected uplift: {fmt_money(simulation['total_expected_gain'])} adjusted revenue gain",
        f"- Revenue: {fmt_money(before['revenue'])} → {fmt_money(after['revenue'])}",
        f"- ROAS: {fmt_x(before['roas'])} → {fmt_x(after['roas'])}",
    ])
    return "\n".join(lines)


def render_key_insights(analysis: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    summary = analysis["summary"]
    perf = analysis["performance"]
    lines = ["## Key Insights"]
    lines.extend([
        f"- Wasted spend: {fmt_money(perf['wasted_spend'])} ({perf['wasted_share'] * 100:.1f}%)" if perf["wasted_share"] is not None else f"- Wasted spend: {fmt_money(perf['wasted_spend'])}",
        f"- Account ROAS is {fmt_x(summary['overall_roas'])} before changes.",
        f"- Projected uplift from the three decisions: {fmt_money(simulation['total_expected_gain'])} adjusted revenue gain.",
    ])
    return "\n".join(lines)


def render_methodology(analysis: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    lines = ["## Methodology"]
    lines.extend([
        "- Analyst segments data by campaign group and benchmarks CPA / ROAS.",
        "- Strategist proposes one reallocation, one pause, and one scale move.",
        "- Critic challenges each move once; strategist refines once.",
        "- Projections use ROAS deltas, budget shift size, and a 0.5 realism factor.",
        "- Outputs are estimates, not guarantees.",
    ])
    return "\n".join(lines)


def render_confidence_limitations(evaluation: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    lines = ["## Confidence & Limitations"]
    lines.extend([
        f"- Confidence quality: {evaluation['confidence_quality']['score']}/5.",
        "- Brand scaling may face saturation, so ROAS gains may not scale linearly.",
        "- Cross-channel moves are directional and can be distorted by attribution windows.",
        "- Forecasts assume the source and target campaigns behave roughly like their current ROAS profile.",
        "- The projection is a simplified estimate, not a guarantee of revenue uplift.",
    ])
    return "\n".join(lines)


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def render_html_report(source: Path, analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], evaluation: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    summary = analysis["summary"]
    perf = analysis["performance"]

    decision_cards = []
    for action, challenge, sim in zip(strategy["actions"][:3], critique["critiques"][:3], simulation["decisions"][:3]):
        risk = challenge["attribution_risk"] if action["type"] in {"pause", "scale", "reallocate"} else challenge["weak_signal"]
        decision_cards.append(f"""
        <div class="card decision">
          <div class="decision-title">{esc(action['action'])}</div>
          <div class="meta"><span class="pill">{esc(fmt_money(action.get('amount', 0.0)))}</span> <span class="pill subtle">{esc(action.get('confidence', 'Medium'))}</span></div>
          <p><strong>Expected impact:</strong> {esc(action.get('expected_impact', 'n/a'))}</p>
          <p><strong>Reason:</strong> {esc(action['reason'])}</p>
          <p><strong>Theoretical gain:</strong> {esc(fmt_money(sim['theoretical_gain']))} · <strong>Adjusted expected gain:</strong> {esc(fmt_money(sim['adjusted_expected_gain']))}</p>
          <p><strong>Risk:</strong> {esc(risk)}</p>
          <p><strong>Monitor:</strong> {esc(action.get('monitor', 'n/a'))}</p>
        </div>
        """)

    eval_items = "".join(
        f"<div class='eval-item'><span>{esc(label)}</span><strong>{evaluation[key]['score']}/5</strong><p>{esc(evaluation[key]['reason'])}</p></div>"
        for label, key in [
            ("Actionability", "actionability"),
            ("Financial clarity", "financial_clarity"),
            ("Risk awareness", "risk_awareness"),
            ("Confidence quality", "confidence_quality"),
            ("Overall decision quality", "overall"),
        ]
    )

    html_doc = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gnomeo Agent MVP Report</title>
  <style>
    :root {{ --bg:#fff; --text:#101828; --muted:#667085; --line:#eaecf0; --soft:#f9fafb; --accent:#2563eb; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font:15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    .wrap {{ max-width:800px; margin:0 auto; padding:40px 24px 72px; }}
    .hero {{ margin-bottom:32px; }}
    h1 {{ font-size:30px; line-height:1.15; margin:0 0 10px; }}
    h2 {{ font-size:22px; margin:36px 0 16px; }}
    h3 {{ font-size:18px; margin:0 0 10px; }}
    p {{ margin:0 0 10px; }}
    .muted {{ color:var(--muted); }}
    .summary {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:18px 0 0; }}
    .stat, .card, .eval-item {{ border:1px solid var(--line); border-radius:16px; background:#fff; box-shadow:0 1px 2px rgba(16,24,40,.04); }}
    .stat {{ padding:16px; }}
    .stat .label {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
    .stat .value {{ font-size:22px; font-weight:700; margin-top:4px; }}
    .section {{ margin-top:10px; }}
    .cards {{ display:grid; gap:16px; }}
    .card {{ padding:18px; }}
    .decision-title {{ font-weight:700; font-size:16px; margin-bottom:10px; }}
    .meta {{ display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }}
    .pill {{ display:inline-block; padding:5px 10px; border-radius:999px; background:#eff6ff; color:#1d4ed8; font-weight:700; }}
    .pill.subtle {{ background:var(--soft); color:var(--muted); font-weight:600; }}
    .highlight {{ color:var(--accent); font-weight:800; }}
    .grid-2 {{ display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); }}
    .eval-grid {{ display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); }}
    .eval-item {{ padding:14px; }}
    .eval-item span {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
    .eval-item strong {{ display:block; font-size:20px; margin:4px 0 8px; }}
    .section-block {{ margin-top:24px; }}
    ul {{ margin:8px 0 0 20px; padding:0; }}
    li {{ margin-bottom:6px; }}
    hr {{ border:none; border-top:1px solid var(--line); margin:24px 0; }}
    .kpi {{ color:var(--accent); font-weight:800; }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>Gnomeo Agent MVP Report</h1>
      <p class="muted">Source file: {esc(source.name)}</p>
      <div class="summary">
        <div class="stat"><div class="label">Campaigns</div><div class="value">{summary['campaign_count']}</div></div>
        <div class="stat"><div class="label">Spend</div><div class="value">{esc(fmt_money(summary['total_spend']))}</div></div>
        <div class="stat"><div class="label">Wasted spend</div><div class="value kpi">{esc(fmt_money(perf['wasted_spend']))}</div><div class="muted">{esc(f'{perf["wasted_share"]*100:.1f}%') if perf['wasted_share'] is not None else 'n/a'}</div></div>
        <div class="stat"><div class="label">Current ROAS</div><div class="value">{esc(fmt_x(summary['overall_roas']))}</div></div>
        <div class="stat"><div class="label">Projected uplift</div><div class="value kpi">{esc(fmt_money(simulation['total_expected_gain']))}</div></div>
      </div>
    </div>

    <section class="section-block">
      <h2>Executive Summary</h2>
      <p>Three budget moves are recommended. The current account is at {esc(fmt_x(summary['overall_roas']))} ROAS, with {esc(fmt_money(perf['wasted_spend']))} ({esc(f'{perf["wasted_share"]*100:.1f}%') if perf['wasted_share'] is not None else 'n/a'}) of spend sitting in CPA outliers.</p>
      <p>The projected adjusted revenue uplift is <span class="highlight">{esc(fmt_money(simulation['total_expected_gain']))}</span>.</p>
    </section>

    <section class="section-block">
      <h2>Key Decisions</h2>
      <div class="cards">{''.join(decision_cards)}</div>
    </section>

    <section class="section-block">
      <h2>Expected Impact</h2>
      <div class="grid-2">
        <div class="card"><p><strong class="highlight">Wasted spend:</strong> {esc(fmt_money(perf['wasted_spend']))} ({esc(f'{perf["wasted_share"]*100:.1f}%') if perf['wasted_share'] is not None else 'n/a'})</p><p><strong>Projected uplift:</strong> {esc(fmt_money(simulation['total_expected_gain']))}</p></div>
        <div class="card"><p><strong>Before:</strong> revenue {esc(fmt_money(simulation['before']['revenue']))}, ROAS {esc(fmt_x(simulation['before']['roas']))}</p><p><strong>After (projected):</strong> revenue {esc(fmt_money(simulation['after']['revenue']))}, ROAS {esc(fmt_x(simulation['after']['roas']))}</p></div>
      </div>
    </section>

    <section class="section-block">
      <h2>Key Insights</h2>
      <ul>
        <li>Wasted spend is <span class="highlight">{esc(fmt_money(perf['wasted_spend']))}</span> ({esc(f'{perf["wasted_share"]*100:.1f}%') if perf['wasted_share'] is not None else 'n/a'}).</li>
        <li>The account currently runs at {esc(fmt_x(summary['overall_roas']))} ROAS.</li>
        <li>The projected uplift from the three decisions is <span class="highlight">{esc(fmt_money(simulation['total_expected_gain']))}</span>.</li>
      </ul>
    </section>

    <section class="section-block">
      <h2>Methodology</h2>
      <ul>
        <li>Analyst segments by campaign group and benchmarks CPA / ROAS.</li>
        <li>Strategist proposes one reallocation, one pause, and one scale move.</li>
        <li>Critic challenges each move once; strategist refines once.</li>
        <li>Projection uses ROAS delta × budget shift × 0.5 realism factor.</li>
      </ul>
    </section>

    <section class="section-block">
      <h2>Confidence &amp; Limitations</h2>
      <div class="eval-grid">{eval_items}</div>
      <div class="card" style="margin-top:12px;">
        <p>Forecasts assume current ROAS relationships hold approximately. Brand scaling can saturate, cross-channel moves can be distorted by attribution, and the projection is an estimate — not a guarantee.</p>
      </div>
    </section>
  </div>
</body>
</html>"""
    return html_doc


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


def build_report_text(source: Path, analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], final: str, evaluation: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    summary = analysis["summary"]
    perf = analysis["performance"]
    lines = [
        "# Gnomeo Agent MVP Report",
        f"Source: `{source.name}`",
        "",
        "## Executive Summary",
        f"- Campaigns analyzed: {summary['campaign_count']}",
        f"- Spend: {fmt_money(summary['total_spend'])}",
        f"- Wasted spend: {fmt_money(perf['wasted_spend'])} ({perf['wasted_share'] * 100:.1f}%)" if perf["wasted_share"] is not None else f"- Wasted spend: {fmt_money(perf['wasted_spend'])}",
        f"- Current ROAS: {fmt_x(summary['overall_roas'])}",
        f"- Projected uplift: {fmt_money(simulation['total_expected_gain'])} adjusted revenue gain",
        "",
        render_key_decisions(strategy, critique, simulation),
        "",
        render_expected_impact(simulation, perf),
        "",
        render_key_insights(analysis, simulation),
        "",
        render_methodology(analysis, simulation),
        "",
        render_confidence_limitations(evaluation, critique, simulation),
        "",
        "## Case Study",
        "### Before",
        f"- Revenue: {fmt_money(simulation['before']['revenue'])}",
        f"- ROAS: {fmt_x(simulation['before']['roas'])}",
        f"- CPA: {fmt_money(simulation['before']['cpa'])}",
        "",
        "### After (projected)",
        f"- Revenue: {fmt_money(simulation['after']['revenue'])}",
        f"- ROAS: {fmt_x(simulation['after']['roas'])}",
        f"- CPA: {fmt_money(simulation['after']['cpa'])}",
        f"- Total theoretical gain: {fmt_money(simulation['total_theoretical_gain'])}",
        f"- Total adjusted expected gain: {fmt_money(simulation['total_expected_gain'])}",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Gnomeo agent MVP workflow.")
    parser.add_argument("csv_path", nargs="?", default=str(DEFAULT_INPUT), help="Path to a CSV file")
    parser.add_argument("--business-stage", default="balanced", choices=["balanced", "growth", "defensive"], help="Business profile stage used to derive thresholds")
    parser.add_argument("--objective", default="efficient growth", help="Business objective used by the profile interpreter")
    parser.add_argument("--acceptable-cpa", type=float, default=None, help="Override acceptable CPA")
    parser.add_argument("--acceptable-roas", type=float, default=None, help="Override acceptable ROAS")
    args = parser.parse_args()

    source = Path(args.csv_path).expanduser().resolve()
    if not source.exists():
        raise SystemExit(f"Missing data file: {source}")

    campaigns = load_campaigns(source)
    profile_context = run_profile_interpreter(campaigns, args)
    analysis = analyst(campaigns, profile_context)
    strategy_initial = strategist_initial(analysis, profile_context)
    critique = critic(analysis, strategy_initial, profile_context)
    strategy_refined = strategist_refinement(analysis, strategy_initial, critique, profile_context)
    enriched_strategy = enrich_decisions(strategy_refined, analysis)
    simulation = simulate_projections(enriched_strategy, analysis)
    final = synthesizer(analysis, enriched_strategy, critique, simulation)
    evaluation = evaluate_output(enriched_strategy, critique)
    report = build_report_text(source, analysis, enriched_strategy, critique, final, evaluation, simulation)
    html_report = render_html_report(source, analysis, enriched_strategy, critique, evaluation, simulation)

    OUTPUT_REPORT.write_text(report, encoding="utf-8")
    OUTPUT_HTML.write_text(html_report, encoding="utf-8")

    print("Gnomeo agent MVP test")
    print("API mode: local mock (no remote calls)")
    print(f"Data source: {source}")
    print(f"Report written: {OUTPUT_REPORT}")
    print(f"HTML written: {OUTPUT_HTML}")
    print_section("PROFILE INTERPRETER", profile_context)
    print_section("ANALYST", analysis)
    print_section("STRATEGIST (initial)", strategy_initial)
    print_section("CRITIC", critique)
    print_section("STRATEGIST (refined)", enriched_strategy)
    print("\n=== SYNTHESIZER ===")
    print(final)
    print("\n=== EVALUATION ===")
    print(render_evaluation(evaluation))


if __name__ == "__main__":
    main()
