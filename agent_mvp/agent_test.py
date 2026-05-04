#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
import sys
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Optional

from decision_graph import DecisionGraph

ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / "sample_ads_data.csv"
OUTPUT_REPORT = ROOT / "output_report.md"
OUTPUT_HTML = ROOT / "output_report.html"

CURRENT_CURRENCY_CODE = "GBP"
CURRENT_CURRENCY_SYMBOL = "£"
CURRENT_CURRENCY_SOURCE = "default"

CURRENCY_MAP = {
    "gbp": ("GBP", "£"),
    "usd": ("USD", "$"),
    "eur": ("EUR", "€"),
}

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
    "currency": ["currency", "currency_code", "currency_symbol"],
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
    cleaned = value.strip().replace(",", "")
    for _, symbol in CURRENCY_MAP.values():
        cleaned = cleaned.replace(symbol, "")
    if cleaned == "":
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def set_currency_context(code: str, symbol: str, source: str = "detected") -> None:
    global CURRENT_CURRENCY_CODE, CURRENT_CURRENCY_SYMBOL, CURRENT_CURRENCY_SOURCE
    CURRENT_CURRENCY_CODE = code or "GBP"
    CURRENT_CURRENCY_SYMBOL = symbol or "£"
    CURRENT_CURRENCY_SOURCE = source or "detected"


def detect_currency(path: Path) -> Dict[str, str]:
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            fieldnames = reader.fieldnames or []
            headers = [str(name or "") for name in fieldnames]
            lower_headers = [name.lower() for name in headers]

            header_hints = [
                ("GBP", "£", hdr) for hdr in headers if "gbp" in hdr.lower() or "£" in hdr
            ] + [
                ("USD", "$", hdr) for hdr in headers if "usd" in hdr.lower() or "$" in hdr
            ] + [
                ("EUR", "€", hdr) for hdr in headers if "eur" in hdr.lower() or "€" in hdr
            ]
            if header_hints:
                code, symbol, source = header_hints[0]
                return {"currency_code": code, "currency_symbol": symbol, "currency_source": f"header:{source}"}

            currency_column = _find_column(fieldnames, COLUMN_ALIASES["currency"])
            if currency_column:
                for row in reader:
                    raw = (row.get(currency_column) or "").strip().lower()
                    if not raw:
                        continue
                    if raw in CURRENCY_MAP:
                        code, symbol = CURRENCY_MAP[raw]
                        return {"currency_code": code, "currency_symbol": symbol, "currency_source": f"column:{currency_column}"}
                    if raw in {"£", "$", "€"}:
                        symbol_to_code = {v[1]: k for k, v in CURRENCY_MAP.items()}
                        code = symbol_to_code.get(raw, "gbp").upper()
                        return {"currency_code": code, "currency_symbol": raw, "currency_source": f"column:{currency_column}"}
                    for code_key, (code, symbol) in CURRENCY_MAP.items():
                        if code_key in raw or code.lower() in raw or symbol in raw:
                            return {"currency_code": code, "currency_symbol": symbol, "currency_source": f"column:{currency_column}"}

            fh.seek(0)
            reader = csv.DictReader(fh)
            sample_rows = []
            for _, row in zip(range(10), reader):
                sample_rows.append(row)
            for row in sample_rows:
                joined = " ".join(str(v or "") for v in row.values())
                if "€" in joined or "eur" in joined.lower():
                    return {"currency_code": "EUR", "currency_symbol": "€", "currency_source": "sample-data"}
                if "$" in joined or "usd" in joined.lower():
                    return {"currency_code": "USD", "currency_symbol": "$", "currency_source": "sample-data"}
                if "£" in joined or "gbp" in joined.lower():
                    return {"currency_code": "GBP", "currency_symbol": "£", "currency_source": "sample-data"}
    except Exception:
        pass
    return {"currency_code": "GBP", "currency_symbol": "£", "currency_source": "default"}


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


def attach_currency(data: Dict[str, Any]) -> Dict[str, Any]:
    return {**data, **currency_payload()}


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
    if c.campaign:
        return c.campaign
    if c.platform and c.campaign_type:
        return f"{c.platform} {c.campaign_type}".strip()
    if c.platform:
        return c.platform
    if c.campaign_type:
        return c.campaign_type
    return "Unassigned segment"


def fmt_money(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{CURRENT_CURRENCY_SYMBOL}{value:,.2f}"


def currency_label() -> str:
    return f"{CURRENT_CURRENCY_CODE} ({CURRENT_CURRENCY_SYMBOL})"


def currency_payload() -> Dict[str, str]:
    return {"currency_code": CURRENT_CURRENCY_CODE, "currency_symbol": CURRENT_CURRENCY_SYMBOL, "currency_source": CURRENT_CURRENCY_SOURCE}


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
        **currency_payload(),
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
    top_30 = top_percent(roas_ready, 0.30, lambda c: c.roas or -1.0)
    bottom_30 = percentile(roas_ready, 0.30, lambda c: c.roas or -1.0)

    return {
        "wasted_campaigns": wasted,
        "wasted_spend": wasted_spend,
        "wasted_share": wasted_share,
        "top_30": sorted(top_30, key=lambda c: c.roas or -1.0, reverse=True),
        "bottom_30": bottom_30,
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

    return attach_currency({
        "profile": context["profile"],
        "campaigns": campaigns,
        "summary": summary,
        "thresholds": thresholds,
        "segments": group_segments,
        "performance": performance,
        "insights": insights,
    })


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
        winners = [c for c in sorted(perf["top_30"], key=lambda c: (c.roas or -1.0, c.spend), reverse=True)]

    losers = [c for c in all_campaigns if c.cpa is not None and c.cpa > thresholds.acceptable_cpa]
    if not losers:
        losers = [c for c in sorted(perf["bottom_30"], key=lambda c: (c.roas or 0.0, c.spend))]

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
    return attach_currency({"actions": actions[:3], "confidence": base_confidence})


# -----------------------------
# Layer 3b: STRATEGIST (refinement pass)
# -----------------------------

def _normalize_campaign_name(value: str) -> str:
    return normalize_name(value)


def _campaign_keys(action: Dict[str, Any]) -> List[str]:
    keys: List[str] = []
    for field in ("from", "to", "campaign"):
        value = action.get(field)
        if value:
            keys.append(_normalize_campaign_name(str(value)))
    return [key for key in keys if key]


def _pick_campaign(campaigns: List[Campaign], used: set[str], *, prefer_winners: bool, exclude: set[str] | None = None) -> Optional[Campaign]:
    exclude = exclude or set()
    pool = [c for c in campaigns if _normalize_campaign_name(label(c)) not in used and _normalize_campaign_name(label(c)) not in exclude]
    if not pool:
        return None
    if prefer_winners:
        return sorted(pool, key=lambda c: ((c.roas or -1.0), -(c.spend or 0.0)), reverse=True)[0]
    return sorted(pool, key=lambda c: ((c.cpa if c.cpa is not None else -1.0), (c.spend or 0.0)), reverse=True)[0]


def strategist_refinement(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    refined_actions: List[Dict[str, Any]] = []
    corrections = critique.get("required_corrections", []) if isinstance(critique, dict) else []
    corrections_by_index = {item.get("action_index"): item for item in corrections if isinstance(item, dict) and item.get("action_index") is not None}
    low_confidence = strategy.get("confidence") == "Low"
    used_campaigns: set[str] = set()

    campaigns = analysis.get("campaigns", [])
    campaign_lookup = build_campaign_lookup(campaigns)
    winners = list(analysis.get("performance", {}).get("top_30", []))
    losers = list(analysis.get("performance", {}).get("bottom_30", []))

    for idx, action in enumerate(strategy.get("actions", [])[:3], 1):
        correction = corrections_by_index.get(idx, {})
        updated = dict(action)
        action_type = updated.get("type")

        def mark_used_from_action(act: Dict[str, Any]) -> None:
            for key in _campaign_keys(act):
                used_campaigns.add(key)

        def set_hold(reason: str) -> None:
            updated.clear()
            updated.update({
                "type": "hold",
                "action": "Hold budget and monitor the current mix",
                "amount": 0.0,
                "reason": reason,
                "confidence": "Low",
            })

        issue = correction.get("issue")
        duplicate_issue = issue == "duplicate_campaign"
        causal_issue = issue == "causal_issue"
        clarity_issue = issue == "clarity_issue"
        realism_issue = issue == "realism_issue"
        confidence_issue = issue == "confidence_issue"

        if action_type == "reallocate":
            source = campaign_lookup.get(normalize_name(str(action.get("from") or "")))
            target = campaign_lookup.get(normalize_name(str(action.get("to") or "")))
            if source and _normalize_campaign_name(label(source)) in used_campaigns:
                source = _pick_campaign(campaigns, used_campaigns, prefer_winners=False)
            if target and (_normalize_campaign_name(label(target)) in used_campaigns or (source and _normalize_campaign_name(label(target)) == _normalize_campaign_name(label(source)))):
                target = _pick_campaign(campaigns, used_campaigns | ({_normalize_campaign_name(label(source))} if source else set()), prefer_winners=True)
            if source and target and _normalize_campaign_name(label(source)) != _normalize_campaign_name(label(target)):
                updated["from"] = label(source)
                updated["to"] = label(target)
                updated["action"] = f"Move {fmt_money(updated['amount'])} from {label(source)} to {label(target)}"
                updated["source_campaign"] = label(source)
                updated["target_campaign"] = label(target)
            elif duplicate_issue or clarity_issue:
                set_hold("Refinement could not find a unique reallocation path.")
        elif action_type == "pause":
            source = campaign_lookup.get(normalize_name(str(action.get("campaign") or "")))
            if source and _normalize_campaign_name(label(source)) in used_campaigns:
                source = _pick_campaign(campaigns, used_campaigns, prefer_winners=False)
            if source:
                updated["campaign"] = label(source)
                updated["action"] = f"Pause or cut {label(source)} by {fmt_money(updated['amount'])}"
                updated["source_campaign"] = label(source)
            elif duplicate_issue or clarity_issue:
                set_hold("Refinement could not find a unique pause candidate.")
        elif action_type == "scale":
            target = campaign_lookup.get(normalize_name(str(action.get("campaign") or "")))
            if target and _normalize_campaign_name(label(target)) in used_campaigns:
                target = _pick_campaign(campaigns, used_campaigns, prefer_winners=True)
            if target:
                updated["campaign"] = label(target)
                updated["action"] = f"Scale {label(target)} by {fmt_money(updated['amount'])}"
                updated["target_campaign"] = label(target)
            elif duplicate_issue or clarity_issue:
                set_hold("Refinement could not find a unique scale candidate.")

        if updated.get("type") != "hold":
            mark_used_from_action(updated)

        if causal_issue and updated.get("type") in {"reallocate", "scale"}:
            updated["amount"] = round(float(updated.get("amount", 0.0) or 0.0) * 0.5, 2)
            updated["reason"] = f"{updated.get('reason', '')} Reduced after causal validation flagged the gap as too small.".strip()
            updated["confidence"] = "Low"

        if realism_issue and updated.get("type") in {"reallocate", "pause", "scale"}:
            updated["amount"] = round(float(updated.get("amount", 0.0) or 0.0) * 0.75, 2)
            updated["reason"] = f"{updated.get('reason', '')} Projection was trimmed for realism.".strip()

        if confidence_issue and updated.get("confidence") == "High":
            updated["confidence"] = "Medium"

        if low_confidence and updated.get("type") == "scale":
            updated["amount"] = round(float(updated.get("amount", 0.0) or 0.0) * 0.5, 2)
            updated["action"] = updated["action"].replace("Scale ", "Scale cautiously: ")
            updated["reason"] = f"{updated.get('reason', '')} Reduced due to low confidence in the signal.".strip()
            updated["confidence"] = "Low"
        elif low_confidence and updated.get("type") == "reallocate":
            updated["amount"] = round(float(updated.get("amount", 0.0) or 0.0) * 0.5, 2)
            updated["action"] = updated["action"].replace("Move ", "Move cautiously: ")
            updated["reason"] = f"{updated.get('reason', '')} Reduced due to low confidence in the signal.".strip()
            updated["confidence"] = "Low"
        elif updated.get("type") == "pause" and updated.get("confidence") == "High":
            updated["confidence"] = "Medium"

        if updated.get("type") != "hold":
            if updated.get("amount") is None:
                updated["amount"] = 0.0
            updated["reason"] = updated.get("reason", "")
            updated["addressed_criticisms"] = updated.get("addressed_criticisms", [])

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

    return attach_currency({"actions": refined_actions[:3], "confidence": "Low" if low_confidence else strategy.get("confidence", "Medium")})


# -----------------------------
# Layer 4: CRITIC
# -----------------------------


def critic(analysis: Dict[str, Any], strategy: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    thresholds: Thresholds = analysis["thresholds"]
    perf = analysis["performance"]
    campaigns = analysis.get("campaigns", [])
    campaign_lookup = build_campaign_lookup(campaigns)
    critiques: List[Dict[str, Any]] = []
    required_corrections: List[Dict[str, Any]] = []
    validation_notes: List[Dict[str, Any]] = []
    seen_campaigns: Dict[str, int] = {}
    approval = "pass"

    def campaign_names(action: Dict[str, Any]) -> List[str]:
        names: List[str] = []
        for field in ("from", "to", "campaign"):
            value = action.get(field)
            if value:
                names.append(normalize_name(str(value)))
        return [name for name in names if name]

    def add_note(index: int, severity: str, issue: str, detail: str, correction: str | None = None) -> None:
        nonlocal approval
        note = {"action_index": index, "severity": severity, "issue": issue, "detail": detail}
        validation_notes.append(note)
        if severity == "error":
            approval = "revise"
            if correction:
                required_corrections.append({"action_index": index, "issue": issue, "correction": correction})

    for idx, action in enumerate(strategy.get("actions", [])[:3], 1):
        names = campaign_names(action)
        action_type = action.get("type")
        amount = float(action.get("amount", 0.0) or 0.0)
        source = campaign_lookup.get(normalize_name(str(action.get("from") or action.get("campaign") or "")))
        target = campaign_lookup.get(normalize_name(str(action.get("to") or action.get("campaign") or "")))

        duplicate_names = [name for name in names if name in seen_campaigns]
        for name in names:
            seen_campaigns[name] = idx
        if duplicate_names:
            add_note(
                idx,
                "error",
                "duplicate_campaign",
                f"Campaign(s) used more than once: {', '.join(sorted(set(duplicate_names)))}.",
                "Choose unique campaigns for this decision or convert it to a hold.",
            )

        if action_type == "reallocate" and (not action.get("from") or not action.get("to") or amount <= 0):
            add_note(idx, "error", "clarity_issue", "Reallocation is missing a campaign or £ amount.", "Add a campaign name and explicit £ movement.")
        elif action_type in {"pause", "scale"} and (not action.get("campaign") or amount <= 0):
            add_note(idx, "error", "clarity_issue", f"{action_type.title()} is missing a campaign or £ amount.", "Add a campaign name and explicit £ amount.")

        if action_type == "reallocate" and source and target and source is not target:
            source_cpa = source.cpa
            target_cpa = target.cpa
            if source_cpa and target_cpa:
                diff = abs(source_cpa - target_cpa) / max(source_cpa, target_cpa)
                if diff < 0.25:
                    add_note(
                        idx,
                        "error",
                        "causal_issue",
                        f"CPA gap between {label(source)} and {label(target)} is only {diff * 100:.0f}%, which is too small to justify a reallocation.",
                        "Only keep the move if the CPA gap is at least 20–30%; otherwise downgrade or remove it.",
                    )
        elif action_type == "scale" and target:
            if target.roas is not None and analysis["summary"].get("overall_roas") is not None:
                lift = (target.roas - analysis["summary"]["overall_roas"]) / max(abs(analysis["summary"]["overall_roas"]), 0.0001)
                if lift < 0.20:
                    add_note(
                        idx,
                        "error",
                        "causal_issue",
                        f"{label(target)} does not outperform the blended account by 20%+.",
                        "Only scale when performance is meaningfully better than the account baseline.",
                    )

        if action_type in {"reallocate", "pause", "scale"}:
            estimated_gain = abs(float(action.get("adjusted_expected_gain") or 0.0))
            if estimated_gain and estimated_gain > amount * 3:
                add_note(
                    idx,
                    "error",
                    "realism_issue",
                    f"Projected impact {fmt_money(estimated_gain)} is more than 3x the budget move {fmt_money(amount)}.",
                    "Reduce the projection or trim the budget move until impact stays within a 3x multiple.",
                )

        decision_spend = amount
        if action_type in {"reallocate", "pause"} and source is not None:
            decision_spend = float(getattr(source, "spend", amount) or amount)
        elif action_type == "scale" and target is not None:
            decision_spend = float(getattr(target, "spend", amount) or amount)

        meaningful_spend = decision_spend >= max(1000.0, (analysis["summary"].get("total_spend") or 0.0) * 0.05)
        if action_type == "reallocate" and source and target and source.cpa and target.cpa:
            consistent = abs(source.cpa - target.cpa) / max(source.cpa, target.cpa) >= 0.25
        elif action_type == "pause" and source:
            consistent = (source.roas is not None and analysis["summary"].get("overall_roas") is not None and source.roas <= analysis["summary"]["overall_roas"] * 0.8) or (source.cpa is not None and analysis["summary"].get("overall_cpa") is not None and source.cpa >= analysis["summary"]["overall_cpa"] * 1.25)
        elif action_type == "scale" and target and analysis["summary"].get("overall_roas") is not None:
            consistent = target.roas is not None and target.roas >= analysis["summary"]["overall_roas"] * 1.2
        else:
            consistent = action.get("confidence") != "Low" and action_type in {"reallocate", "pause", "scale"}
        if action.get("confidence") == "High" and not (meaningful_spend and consistent):
            add_note(
                idx,
                "error",
                "confidence_issue",
                "High confidence is not supported by meaningful spend or consistent performance.",
                "Downgrade the confidence to Medium unless the spend and signal are clearly strong.",
            )
        elif action.get("confidence") == "High" and meaningful_spend and consistent:
            validation_notes.append({"action_index": idx, "severity": "info", "issue": "confidence_valid", "detail": "High confidence is supported by spend and consistency."})

        critiques.append(
            {
                "action": action.get("action"),
                "challenge": "Structured validation applied.",
                "flawed_assumption": "See validation notes.",
                "weak_signal": "See validation notes.",
                "attribution_risk": "See validation notes.",
            }
        )

    if perf["wasted_share"] is not None and perf["wasted_share"] > 0.20:
        validation_notes.append({"action_index": 0, "severity": "warning", "issue": "portfolio_note", "detail": "A meaningful share of spend sits in CPA outliers, so the strategist should stay conservative."})

    return {
        "approval": approval,
        "validation_notes": validation_notes,
        "required_corrections": required_corrections,
        "critiques": critiques[:3],
    }


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

    lines.extend(["", "### Top 30% performers"])
    lines.extend(f"- {label(item)} ({fmt_x(item.roas)})" for item in perf["top_30"])

    lines.extend(["", "### Bottom 30% performers"])
    lines.extend(f"- {label(item)} ({fmt_x(item.roas)})" for item in perf["bottom_30"])

    lines.extend(["", "## Strategist"])
    for item in strategy["actions"][:3]:
        lines.append(f"- {item['action']} | Amount: {fmt_money(item.get('amount', 0.0))} | Reason: {item['reason']}")
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
            f"{idx}. Action: {action['action']}\n   Amount: {fmt_money(action.get('amount', 0.0))}\n   Reason: {action['reason']}\n   Expected impact: {action.get('expected_impact', 'n/a')}\n   Timeframe: {action.get('timeframe', 'n/a')}\n   Source ROAS: {fmt_x(sim['source_roas'])}\n   Target ROAS: {fmt_x(sim['target_roas'])}\n   Delta: {fmt_x(sim['delta'])}\n   Assumptions: {', '.join(sim['assumptions'])}\n   Risk: {risk}\n   What to monitor: {action.get('monitor', 'n/a')}\n   Confidence: {confidence}"
        )

    lines.extend(["", "## Flow control"])
    lines.append("- Required flow enforced: Analyst → Strategist → Critic → Strategist (refinement) → Synthesizer.")
    lines.append("- Only one critique round is used, and only one strategist refinement follows it.")
    lines.append("- Maximum total passes = 2 strategist passes; no recursive or open-ended loops.")
    lines.append("- Synthesizer is final authority; no post-output revision path exists.")
    lines.append(f"- All values shown in {currency_label()}.")

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

    return attach_currency({
        "actionability": {
            "score": actionability,
            "reason": "All 3 decisions are concrete actions with explicit implementation steps." if actionability >= 4 else "Some actions are still too generic.",
        },
        "financial_clarity": {
            "score": financial_clarity,
            "reason": "Each decision includes a numeric amount and visible budget direction." if financial_clarity >= 4 else "Financial impact is under-specified.",
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
    })


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
        return "Expected to increase conversions if the larger budget holds current efficiency."

    if action["type"] == "pause":
        if cpa is not None and base_cpa is not None:
            return f"Expected to reduce blended CPA by trimming a weak spender, with ROAS improving modestly as spend shifts away from {fmt_money(cpa)} CPA traffic; conversions may fall slightly in the short term."
        return "Expected to improve efficiency by removing a weaker spender, with a possible short-term dip in volume."

    if action["type"] == "reallocate":
        if roas is not None and base_roas is not None:
            return f"Expected to improve ROAS from {fmt_x(base_roas)} toward {fmt_x(min(base_roas * 1.08, (roas or base_roas) * 1.05))}, with CPA drifting down or holding steady and conversions staying broadly flat to slightly up."
        return "Expected to shift spend toward a stronger campaign and improve blended efficiency."

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
    return attach_currency({**strategy, "actions": enriched_actions[:3]})


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

    source_cpa = source.cpa if source and source.cpa is not None else None
    target_cpa = target.cpa if target and target.cpa is not None else None
    source_spend = source.spend if source else 0.0
    target_spend = target.spend if target else 0.0

    delta = target_roas - source_roas
    theoretical_gain = spend * delta
    expected_gain = theoretical_gain * 0.5
    cap = spend * 3.0
    if abs(expected_gain) > cap:
        expected_gain = cap if expected_gain >= 0 else -cap

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
            "Extra spend converts in line with the current pattern.",
        ]
    else:
        assumptions = [
            "The destination campaign can absorb extra spend without a sharp ROAS drop.",
            "The source campaign can lose spend without creating hidden downstream value loss.",
            "Execution risk is moderate and should be monitored closely.",
        ]

    return {
        **action,
        "source_campaign": label(source) if source else action.get("from") or action.get("campaign") or "account baseline",
        "target_campaign": label(target) if target else action.get("to") or action.get("campaign") or "account baseline",
        "source_spend": source_spend,
        "target_spend": target_spend,
        "source_cpa": source_cpa,
        "target_cpa": target_cpa,
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
    impact_low = total_expected_gain * 0.75
    impact_high = total_expected_gain * 1.25

    return attach_currency({
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
        "total_expected_gain": total_expected_gain,
        "impact_low": impact_low,
        "impact_high": impact_high,
    })


def render_evaluation(evaluation: Dict[str, Any]) -> str:
    return "\n".join([
        "## Confidence & limitations",
        "- Confidence reflects data volume, consistency, and missing context.",
        "- This is a snapshot from the exported dataset.",
        "- Attribution, seasonality, creative fatigue, and margin/LTV gaps can change the call.",
        "- Recheck decisions after the next spend cycle.",
    ])


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _decision_confidence(action: Dict[str, Any], analysis: Dict[str, Any], sim: Dict[str, Any]) -> tuple[str, str]:
    campaigns = analysis.get("campaigns", [])
    lookup = build_campaign_lookup(campaigns)
    summary = analysis.get("summary", {})
    total_spend = float(summary.get("total_spend") or 0.0)

    def metric_value(campaign: Optional[Campaign]) -> Optional[float]:
        if campaign is None:
            return None
        if campaign.cpa is not None:
            return campaign.cpa
        if campaign.roas is not None:
            return campaign.roas
        return None

    source = lookup.get(normalize_name(str(action.get("from") or action.get("campaign") or sim.get("source_campaign") or "")))
    target = lookup.get(normalize_name(str(action.get("to") or action.get("campaign") or sim.get("target_campaign") or "")))
    is_pause = action.get("type") == "pause"
    is_scale = action.get("type") == "scale"
    is_reallocate = action.get("type") == "reallocate"

    decision_spend = float(action.get("amount") or 0.0)
    if is_reallocate and source is not None:
        decision_spend = float(source.spend or decision_spend)
    elif is_pause and source is not None:
        decision_spend = float(source.spend or decision_spend)
    elif is_scale and target is not None:
        decision_spend = float(target.spend or decision_spend)

    score = 0
    reasons: List[str] = []

    # 1) Data volume
    if decision_spend >= max(10000.0, total_spend * 0.15):
        score += 1
        reasons.append("Strong spend volume")
    elif decision_spend <= max(1000.0, total_spend * 0.03):
        score -= 1
        reasons.append("Low spend volume")
    else:
        reasons.append("Moderate spend")

    # 2) Performance gap
    gap = None
    if is_reallocate and source and target:
        source_metric = metric_value(source)
        target_metric = metric_value(target)
        if source_metric is not None and target_metric is not None:
            gap = abs(source_metric - target_metric) / max(abs(source_metric), abs(target_metric), 0.0001)
    elif is_pause and source:
        source_metric = metric_value(source)
        baseline = summary.get("overall_cpa") if source.cpa is not None else summary.get("overall_roas")
        if source_metric is not None and baseline is not None:
            gap = abs(source_metric - baseline) / max(abs(source_metric), abs(baseline), 0.0001)
    elif is_scale and target:
        target_metric = metric_value(target)
        baseline = summary.get("overall_cpa") if target.cpa is not None else summary.get("overall_roas")
        if target_metric is not None and baseline is not None:
            gap = abs(target_metric - baseline) / max(abs(target_metric), abs(baseline), 0.0001)

    if gap is not None and gap > 0.5:
        score += 1
        reasons.append("Strong performance gap")
    elif gap is not None and gap < 0.2:
        score -= 1
        reasons.append("Weak performance gap")
    elif gap is not None:
        reasons.append("Moderate performance gap")
    else:
        score -= 1
        reasons.append("Missing performance comparison")

    # 3) Consistency
    if source and target:
        consistent = source.conversions >= 50 and target.conversions >= 50 and source.spend >= 8000 and target.spend >= 8000
    elif source:
        consistent = source.conversions >= 50 and source.spend >= 8000 and source.roas is not None
    elif target:
        consistent = target.conversions >= 50 and target.spend >= 8000 and target.roas is not None
    else:
        consistent = False

    if consistent:
        score += 1
        reasons.append("Consistent performance")
    else:
        score -= 1
        reasons.append("Volatile or thin data")

    # 4) Context risk
    same_channel = True
    if source and target:
        same_channel = (source.platform or "").strip().lower() == (target.platform or "").strip().lower()
    elif source:
        same_channel = bool(source.platform)
    elif target:
        same_channel = bool(target.platform)

    if same_channel:
        score += 1
        reasons.append("Same channel context")
    else:
        score -= 1
        reasons.append("Cross-channel risk")

    label = "Low"
    if 3 <= score <= 4:
        label = "High"
    elif 1 <= score <= 2:
        label = "Medium"

    reason = ", ".join(reasons[:3])
    if len(reasons) > 3:
        reason = f"{reason}; {reasons[3]}"

    if label == "High":
        reason = reason or "Strong spend, clear performance gap, stable data, and same-channel context."
    elif label == "Medium":
        reason = reason or "Mixed signal with some supporting evidence, but meaningful risk remains."
    else:
        reason = reason or "Thin or mixed signal; treat as directional only."

    return label, reason


def _priority_from_rank(rank: int) -> str:
    return {1: "High", 2: "Medium"}.get(rank, "Low")


def _estimated_impact_range(amount: float) -> str:
    low = max(0.0, amount * 0.75)
    high = amount * 1.25
    return f"{fmt_money(low)}–{fmt_money(high)}"


def _build_decision_rows(strategy: Dict[str, Any], analysis: Dict[str, Any], simulation: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for action, sim in zip(strategy["actions"][:3], simulation["decisions"][:3]):
        metric_name = "CPA" if sim.get("source_cpa") is not None or sim.get("target_cpa") is not None else "ROAS"
        metric_value = sim.get("source_cpa") if metric_name == "CPA" else sim.get("source_roas")
        target_metric_value = sim.get("target_cpa") if metric_name == "CPA" else sim.get("target_roas")
        current_spend = sim.get("source_spend") if action.get("type") in {"reallocate", "pause"} else sim.get("target_spend")
        confidence, confidence_reason = _decision_confidence(action, analysis, sim)
        impact_low_value = abs(float(sim.get("adjusted_expected_gain", 0.0) or 0.0)) * 0.75
        impact_high_value = abs(float(sim.get("adjusted_expected_gain", 0.0) or 0.0)) * 1.25
        if action.get("type") == "reallocate":
            campaign_line = f"{sim.get('source_campaign')} → {sim.get('target_campaign')}"
            action_line = f"Reduce {fmt_money(float(action.get('amount', 0.0) or 0.0))} from {sim.get('source_campaign')} → increase {sim.get('target_campaign')} by {fmt_money(float(action.get('amount', 0.0) or 0.0))}"
            metric_text = f"{metric_name} {fmt_money(metric_value) if metric_name == 'CPA' else fmt_x(metric_value)} → {fmt_money(target_metric_value) if metric_name == 'CPA' else fmt_x(target_metric_value)}"
        elif action.get("type") == "pause":
            campaign_line = f"{sim.get('source_campaign')}"
            action_line = f"Pause {sim.get('source_campaign')} and free {fmt_money(float(action.get('amount', 0.0) or 0.0))}"
            metric_text = f"{metric_name} {fmt_money(metric_value) if metric_name == 'CPA' else fmt_x(metric_value)}"
        else:
            campaign_line = f"{sim.get('target_campaign')}"
            action_line = f"Increase {sim.get('target_campaign')} by {fmt_money(float(action.get('amount', 0.0) or 0.0))}"
            metric_text = f"{metric_name} {fmt_money(target_metric_value) if metric_name == 'CPA' else fmt_x(target_metric_value)}"
        rows.append({
            "type": action.get("type"),
            "source": sim.get("source_campaign") or action.get("from") or action.get("campaign") or "Account baseline",
            "target": sim.get("target_campaign") or action.get("to") or action.get("campaign") or "Account baseline",
            "campaign_line": campaign_line,
            "action_line": action_line,
            "metric_name": metric_name,
            "metric_value": metric_value,
            "target_metric_value": target_metric_value,
            "metric_text": metric_text,
            "current_spend": current_spend,
            "amount": float(action.get("amount", 0.0) or 0.0),
            "priority": None,
            "confidence": confidence,
            "confidence_reason": confidence_reason,
            "confidence_reason_detailed": confidence_reason,
            "impact_range": _estimated_impact_range(abs(float(sim.get("adjusted_expected_gain", 0.0) or 0.0))),
            "impact_low_value": impact_low_value,
            "impact_high_value": impact_high_value,
        })
    rows = sorted(rows, key=lambda row: row["amount"], reverse=True)
    for idx, row in enumerate(rows, 1):
        row["priority"] = _priority_from_rank(idx)
    return rows


def build_marketer_content(source_label: str, analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any]) -> Dict[str, Any]:
    perf = analysis["performance"]
    decisions = _build_decision_rows(strategy, analysis, simulation)
    total_low = sum(float(d["impact_low_value"]) for d in decisions)
    total_high = sum(float(d["impact_high_value"]) for d in decisions)
    top_names = ", ".join(label(c) for c in (perf.get("top_30") or [])[:2]) or "n/a"
    bottom_names = ", ".join(label(c) for c in (perf.get("bottom_30") or [])[:2]) or "n/a"
    wasted_pct = perf["wasted_share"] * 100 if perf["wasted_share"] is not None else None
    return {
        "source_name": source_label,
        "currency_code": CURRENT_CURRENCY_CODE,
        "currency_symbol": CURRENT_CURRENCY_SYMBOL,
        "wasted_share_pct": wasted_pct,
        "wasted_spend": perf["wasted_spend"],
        "current_roas": analysis["summary"].get("overall_roas"),
        "decisions": decisions,
        "impact_low": total_low,
        "impact_high": total_high,
        "top_names": top_names,
        "bottom_names": bottom_names,
        "summary_line": f"~{wasted_pct:.0f}% of budget is underperforming and can be reallocated." if wasted_pct is not None else "Underperforming spend is present but the share is unclear.",
        "methodology": "This analysis compares campaign efficiency and reallocates budget toward areas with stronger historical performance, while adjusting for execution risk.",
        "insights": [
            f"Top performers: {top_names}",
            f"Bottom performers: {bottom_names}",
            f"Wasted spend: {fmt_money(perf['wasted_spend'])}" + (f" ({wasted_pct:.1f}%)" if wasted_pct is not None else ""),
        ],
        "confidence_notes": [
            "Confidence reflects data volume, consistency, and missing context such as margin and attribution.",
            "This is a snapshot based on the exported dataset.",
            "Results may shift with seasonality, creative fatigue, and lagged conversions.",
            "Recheck after the next spend cycle.",
        ],
    }


def render_html_report(source_label: str, content: Dict[str, Any]) -> str:
    decision_cards = []
    for idx, decision in enumerate(content["decisions"], 1):
        current_spend_text = fmt_money(decision['current_spend']) if isinstance(decision['current_spend'], (int, float)) else "n/a"
        decision_cards.append(f"""
        <div class=\"card\">
          <div class=\"decision-title\">{idx}. {esc(decision['action_line'])}</div>
          <p><strong>Priority:</strong> {esc(decision['priority'])}</p>
          <p><strong>Campaign(s):</strong> {esc(decision['campaign_line'])}</p>
          <p><strong>Current spend:</strong> {esc(current_spend_text)}</p>
          <p><strong>Key metric:</strong> {esc(decision['metric_text'])}</p>
          <p><strong>Estimated impact:</strong> {esc(decision['impact_range'])}</p>
          <p><strong>Confidence:</strong> {esc(decision['confidence'])}</p>
          <p><strong>Reason:</strong> {esc(decision['confidence_reason'])}</p>
        </div>
        """)

    return f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>Gnomeo Agent MVP Report</title>
  <style>
    :root {{ --bg:#fff; --text:#101828; --muted:#667085; --line:#eaecf0; --accent:#2563eb; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font:15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; }}
    .wrap {{ max-width:840px; margin:0 auto; padding:40px 24px 72px; }}
    h1 {{ font-size:30px; margin:0 0 10px; }}
    h2 {{ font-size:22px; margin:32px 0 14px; }}
    p {{ margin:0 0 10px; }}
    .muted {{ color:var(--muted); }}
    .summary {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:18px 0 0; }}
    .stat, .card {{ border:1px solid var(--line); border-radius:16px; background:#fff; box-shadow:0 1px 2px rgba(16,24,40,.04); }}
    .stat {{ padding:16px; }}
    .stat .label {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }}
    .stat .value {{ font-size:22px; font-weight:700; margin-top:4px; }}
    .cards {{ display:grid; gap:16px; }}
    .card {{ padding:18px; }}
    .decision-title {{ font-weight:700; font-size:16px; margin-bottom:10px; }}
    .highlight {{ color:var(--accent); font-weight:800; }}
    ul {{ margin:8px 0 0 20px; padding:0; }}
    li {{ margin-bottom:6px; }}
  </style>
</head>
<body>
  <div class=\"wrap\">
    <h1>Gnomeo Agent MVP Report</h1>
      <p class=\"muted\">Source file: {esc(source_label)}</p>
    <div class=\"summary\">
      <div class=\"stat\"><div class=\"label\">Budget underperforming</div><div class=\"value\">{esc(content['summary_line'])}</div></div>
      <div class=\"stat\"><div class=\"label\">Wasted spend</div><div class=\"value\">{esc(fmt_money(content['wasted_spend']))}</div></div>
      <div class=\"stat\"><div class=\"label\">Current ROAS</div><div class=\"value\">{esc(fmt_x(content['current_roas']))}</div></div>
      <div class=\"stat\"><div class=\"label\">Estimated impact</div><div class=\"value highlight\">{esc(fmt_money(content['impact_low']))}–{esc(fmt_money(content['impact_high']))}</div></div>
    </div>

    <h2>Executive Summary</h2>
    <p>{esc(content['summary_line'])}</p>
    <p class="muted">All values shown in {esc(content['currency_code'])} ({esc(content['currency_symbol'])}).</p>

    <h2>Key Decisions (prioritised)</h2>
    <div class=\"cards\">{''.join(decision_cards)}</div>

    <h2>Expected Impact</h2>
    <p><strong>Estimated impact:</strong> {esc(fmt_money(content['impact_low']))}–{esc(fmt_money(content['impact_high']))}</p>
    <p><strong>Current waste:</strong> {esc(fmt_money(content['wasted_spend']))}</p>

    <h2>Key Insights</h2>
    <ul>{''.join(f'<li>{esc(item)}</li>' for item in content['insights'])}</ul>

    <h2>How to read this report</h2>
    <p>{esc(content['methodology'])}</p>

    <h2>Confidence &amp; Limitations</h2>
    <ul>{''.join(f'<li>{esc(item)}</li>' for item in content['confidence_notes'])}</ul>
  </div>
</body>
</html>"""


def build_report_text(source_label: str, content: Dict[str, Any]) -> str:
    lines = [
        "# Gnomeo Agent MVP Report",
        f"Source: `{source_label}`",
        "",
        "## Executive Summary",
        content["summary_line"],
        f"All values shown in {content['currency_code']} ({content['currency_symbol']}).",
        f"- Wasted spend: {fmt_money(content['wasted_spend'])}",
        f"- Current ROAS: {fmt_x(content['current_roas'])}",
        f"- Estimated impact: {fmt_money(content['impact_low'])}–{fmt_money(content['impact_high'])}",
        "",
        "## Key Decisions (prioritised)",
    ]
    for idx, decision in enumerate(content["decisions"], 1):
        lines.extend([
            f"### {idx}. {decision['action_line']}",
            f"- Priority: {decision['priority']}",
            f"- Campaign(s): {decision['campaign_line']}",
            f"- Current spend: {fmt_money(decision['current_spend']) if isinstance(decision['current_spend'], (int, float)) else 'n/a'}",
            f"- Key metric: {decision['metric_text']}",
            f"- Estimated impact: {decision['impact_range']}",
            f"- Confidence: {decision['confidence']}",
            f"- Reason: {decision['confidence_reason']}",
        ])
    lines.extend([
        "",
        "## Expected Impact",
        f"Estimated impact: {fmt_money(content['impact_low'])}–{fmt_money(content['impact_high'])}",
        f"Current waste: {fmt_money(content['wasted_spend'])}",
        "",
        "## Key Insights",
    ])
    lines.extend(f"- {item}" for item in content["insights"])
    lines.extend([
        "",
        "## How to read this report",
        content["methodology"],
        "",
        "## Confidence & Limitations",
    ])
    lines.extend(f"- {item}" for item in content["confidence_notes"])
    return "\n".join(lines)


def marketer(source_context: Dict[str, Any], analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any], evaluation: Dict[str, Any], synthesizer_text: str) -> Dict[str, Any]:
    source_value = str(source_context.get("source") or source_context.get("csv_path") or "dataset")
    source_label = Path(source_value).name if source_value else "dataset"
    content = build_marketer_content(source_label, analysis, strategy, critique, simulation)
    return attach_currency({
        "content": content,
        "final_report_text": build_report_text(source_label, content),
        "final_report_html": render_html_report(source_label, content),
    })


def render_graph_mode_appendix(state: Any) -> str:
    warnings = getattr(state, "warnings", []) or []
    confidence = getattr(state, "confidence", "high")
    trace = getattr(state, "trace", []) or []
    lines = [
        "## Graph Mode Trace",
        "- Flow: Profile Interpreter → Analyst → Strategist Initial → Critic → Strategist Refinement → Synthesizer → Marketer → Evaluation",
        f"- Confidence: {confidence}",
    ]
    if trace:
        lines.append(f"- Steps executed: {' > '.join(trace)}")
    if warnings:
        lines.append("")
        lines.append("## Graph Mode Warnings")
        lines.extend(f"- {warning}" for warning in warnings)
    return "\n".join(lines).strip() + "\n"


def render_graph_mode_html_appendix(state: Any) -> str:
    warnings = getattr(state, "warnings", []) or []
    confidence = getattr(state, "confidence", "high")
    trace = getattr(state, "trace", []) or []
    trace_html = " > ".join(esc(step) for step in trace) if trace else "n/a"
    warning_html = "".join(f"<li>{esc(warning)}</li>" for warning in warnings)
    return f"""
    <section class=\"section-block\">
      <h2>Graph Mode Trace</h2>
      <div class=\"card\">
        <p><strong>Flow:</strong> Profile Interpreter → Analyst → Strategist Initial → Critic → Strategist Refinement → Synthesizer → Marketer → Evaluation</p>
        <p><strong>Confidence:</strong> {esc(confidence)}</p>
        <p><strong>Steps executed:</strong> {trace_html}</p>
        {f'<p><strong>Warnings:</strong></p><ul>{warning_html}</ul>' if warnings else ''}
      </div>
    </section>
"""


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
    parser = argparse.ArgumentParser(description="Run the local Gnomeo agent MVP workflow.")
    parser.add_argument("csv_path", nargs="?", default=str(DEFAULT_INPUT), help="Path to a CSV file")
    parser.add_argument("--business-stage", default="balanced", choices=["balanced", "growth", "defensive"], help="Business profile stage used to derive thresholds")
    parser.add_argument("--objective", default="efficient growth", help="Business objective used by the profile interpreter")
    parser.add_argument("--acceptable-cpa", type=float, default=None, help="Override acceptable CPA")
    parser.add_argument("--acceptable-roas", type=float, default=None, help="Override acceptable ROAS")
    parser.add_argument("--graph", action="store_true", help="Use the lightweight graph orchestration layer")
    parser.add_argument("--output-report", default=str(OUTPUT_REPORT), help="Path for the generated markdown report")
    parser.add_argument("--output-html", default=str(OUTPUT_HTML), help="Path for the generated HTML report")
    args = parser.parse_args()

    output_report = Path(args.output_report).expanduser().resolve()
    output_html = Path(args.output_html).expanduser().resolve()

    source = Path(args.csv_path).expanduser().resolve()
    if not source.exists():
        raise SystemExit(f"Missing data file: {source}")

    currency = detect_currency(source)
    set_currency_context(currency["currency_code"], currency["currency_symbol"], currency.get("currency_source", "detected"))
    if currency.get("currency_source") == "default":
        print("[gnomeo currency] currency not detected; defaulting to GBP (£)", file=sys.stderr)

    campaigns = load_campaigns(source)

    if args.graph:
        graph = DecisionGraph(
            profile_interpreter=run_profile_interpreter,
            analyst=analyst,
            strategist_initial=strategist_initial,
            critic=critic,
            strategist_refinement=strategist_refinement,
            enrich_decisions=enrich_decisions,
            simulate_projections=simulate_projections,
            synthesizer=synthesizer,
            evaluate_output=evaluate_output,
            marketer=marketer,
        )
        graph_state = graph.run(campaigns, args)
        profile_context = graph_state.profile or {}
        analysis = graph_state.analyst_output or {}
        strategy_initial = graph_state.strategist_initial_output or {}
        strategy_refined = graph_state.strategist_refined_output or {}
        enriched_strategy = graph_state.enriched_strategy or {}
        critique = graph_state.critic_output or {}
        simulation = graph_state.simulation or {}
        evaluation = graph_state.evaluation_output or {}
        marketer_output = graph_state.marketer_output or marketer({"source": str(source)}, analysis, enriched_strategy, critique, simulation, evaluation, graph_state.synthesizer_output or "")
        final = marketer_output.get("final_report_text", graph_state.synthesizer_output or "")
        report = final
        report += "\n" + render_graph_mode_appendix(graph_state)
        html_report = marketer_output.get("final_report_html", "")
        html_report = html_report.replace("</body>\n</html>", render_graph_mode_html_appendix(graph_state) + "</body>\n</html>")
    else:
        profile_context = run_profile_interpreter(campaigns, args)
        analysis = analyst(campaigns, profile_context)
        strategy_initial = strategist_initial(analysis, profile_context)
        critique = critic(analysis, strategy_initial, profile_context)
        strategy_refined = strategist_refinement(analysis, strategy_initial, critique, profile_context)
        enriched_strategy = enrich_decisions(strategy_refined, analysis)
        simulation = simulate_projections(enriched_strategy, analysis)
        final = synthesizer(analysis, enriched_strategy, critique, simulation)
        evaluation = evaluate_output(enriched_strategy, critique)
        marketer_output = marketer({"source": str(source)}, analysis, enriched_strategy, critique, simulation, evaluation, final)
        final = marketer_output["final_report_text"]
        report = final
        html_report = marketer_output["final_report_html"]

    output_report.write_text(report, encoding="utf-8")
    output_html.write_text(html_report, encoding="utf-8")

    print("Gnomeo agent MVP test")
    print("API mode: local mock (no remote calls)")
    print(f"Data source: {source}")
    print(f"Report written: {output_report}")
    print(f"HTML written: {output_html}")
    print_section("PROFILE INTERPRETER", profile_context)
    print_section("ANALYST", analysis)
    print_section("STRATEGIST (initial)", strategy_initial)
    print_section("CRITIC", critique)
    print_section("STRATEGIST (refined)", enriched_strategy)
    print("\n=== FINAL REPORT ===")
    print(final)
    print("\n=== EVALUATION ===")
    print(render_evaluation(evaluation))


if __name__ == "__main__":
    main()
