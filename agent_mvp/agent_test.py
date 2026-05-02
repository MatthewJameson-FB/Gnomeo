#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median
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

def synthesizer(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any]) -> str:
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
        lines.append(f"- {item['action']} | Budget change: {fmt_money(item.get('amount', 0.0))} | Reason: {item['reason']}")
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
    for idx, (action, challenge) in enumerate(zip(strategy["actions"][:3], critique["critiques"][:3]), 1):
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
            f"{idx}. Action: {action['action']}\n   Financial impact (£): {fmt_money(action.get('amount', 0.0))}\n   Reason: {action['reason']}\n   Risk: {risk}\n   Confidence: {confidence}"
        )

    lines.extend(["", "## Flow control"])
    lines.append("- Required flow enforced: Analyst → Strategist → Critic → Strategist (refinement) → Synthesizer.")
    lines.append("- Only one critique round is used, and only one strategist refinement follows it.")
    lines.append("- Maximum total passes = 2 strategist passes; no recursive or open-ended loops.")
    lines.append("- Synthesizer is final authority; no post-output revision path exists.")

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


def build_report_text(source: Path, analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], final: str, evaluation: Dict[str, Any]) -> str:
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

    lines.extend(["", "## Output trace", "### Profile Interpreter"])
    lines.append(f"- {analysis['thresholds'].source}")
    lines.extend(["", "### Analyst"])
    lines.extend(f"- {item}" for item in analysis["insights"])
    lines.extend(["", "### Strategist"])
    for item in strategy["actions"][:3]:
        lines.append(f"- {item['action']} | Budget change: {fmt_money(item.get('amount', 0.0))}")
        if item.get("addressed_criticisms"):
            lines.extend(f"  - Addresses: {crit}" for crit in item["addressed_criticisms"])
    lines.extend(["", "### Critic"])
    for item in critique["critiques"][:3]:
        lines.append(f"- {item['action']}: {item['challenge']}")
    lines.extend(["", "### Flow limits"])
    lines.append("- One critique round only")
    lines.append("- One strategist refinement only")
    lines.append("- No open discussion or recursive loop")
    lines.append("- Synthesizer ends the flow")
    lines.extend(["", render_evaluation(evaluation)])
    lines.append("")
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
    final = synthesizer(analysis, strategy_refined, critique)
    evaluation = evaluate_output(strategy_refined, critique)
    report = build_report_text(source, analysis, strategy_refined, critique, final, evaluation)

    OUTPUT_REPORT.write_text(report, encoding="utf-8")

    print("Gnomeo agent MVP test")
    print("API mode: local mock (no remote calls)")
    print(f"Data source: {source}")
    print(f"Report written: {OUTPUT_REPORT}")
    print_section("PROFILE INTERPRETER", profile_context)
    print_section("ANALYST", analysis)
    print_section("STRATEGIST (initial)", strategy_initial)
    print_section("CRITIC", critique)
    print_section("STRATEGIST (refined)", strategy_refined)
    print("\n=== SYNTHESIZER ===")
    print(final)
    print("\n=== EVALUATION ===")
    print(render_evaluation(evaluation))


if __name__ == "__main__":
    main()
