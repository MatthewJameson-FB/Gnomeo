#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import base64
import html
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from decision_graph import DecisionGraph
from ingestion import build_ingestion_contract, format_validation_message, ingest_campaign_export
from recommendation_audit import audit_recommendations

ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / "sample_ads_data.csv"
OUTPUT_REPORT = ROOT / "output_report.md"
OUTPUT_HTML = ROOT / "output_report.html"
CURRENT_CURRENCY_CODE = "GBP"
CURRENT_CURRENCY_SYMBOL = "£"


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


# Formatting helpers

def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def set_currency_context(code: str, symbol: str, source: str = "detected") -> None:
    global CURRENT_CURRENCY_CODE, CURRENT_CURRENCY_SYMBOL
    CURRENT_CURRENCY_CODE = code or "GBP"
    CURRENT_CURRENCY_SYMBOL = symbol or "£"


def currency_label() -> str:
    return CURRENT_CURRENCY_CODE


def currency_symbol() -> str:
    return CURRENT_CURRENCY_SYMBOL


def report_logo_data_uri() -> str:
    logo_path = ROOT.parent / "gnomeo-logo.png"
    try:
        encoded = base64.b64encode(logo_path.read_bytes()).decode("ascii")
    except OSError:
        return ""
    return f"data:image/png;base64,{encoded}"


def fmt_money(value: Any) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return "—"
    return f"{currency_symbol()}{num:,.2f}" if abs(num) >= 1000 else f"{currency_symbol()}{num:.2f}"


def fmt_x(value: Any) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return "—"
    return f"{num:.2f}x"


def normalize_name(value: str) -> str:
    return (value or "").strip().lower().replace("|", " ").replace("  ", " ")


def label(campaign: Campaign) -> str:
    return campaign.campaign or campaign.campaign_group or campaign.platform or "Unassigned"


def platform_display_name(platform: str) -> str:
    key = (platform or "").strip().lower()
    return {
        "google_ads": "Google Ads",
        "meta_ads": "Meta Ads",
    }.get(key, (platform or "").replace("_", " ").title() or "Unknown")


def source_export_label(platform: str) -> str:
    return f"{platform_display_name(platform)} export"


def _priority_from_rank(rank: int) -> str:
    return {1: "High", 2: "Medium"}.get(rank, "Low")


def _implementation_guidance(confidence: str, metric_name: str) -> str:
    shift = "20–30%" if confidence == "High" else "10–20%" if confidence == "Medium" else "≤10%"
    return f"Roll out in {shift} increments. Monitor {metric_name} over 3–7 days. If performance holds, scale further. If performance degrades, revert."


def _estimated_impact_range(amount: float) -> str:
    if amount <= 0:
        return "Impact not estimated"
    return f"{fmt_money(max(0.0, amount * 0.75))}–{fmt_money(amount * 1.25)}"


def _impact_summary(low: Optional[float], high: Optional[float]) -> str:
    if low is None or high is None:
        return "Impact not estimated"
    return f"{fmt_money(low)}–{fmt_money(high)}"


def _safe_float(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str:
    return str(value or "").strip()


def _action_type(action: Dict[str, Any]) -> str:
    return normalize_name(_text(action.get("type") or action.get("action")))


def _action_campaign(action: Dict[str, Any]) -> str:
    return _text(
        action.get("campaign")
        or action.get("campaign_or_segment")
        or action.get("source_campaign")
        or action.get("target_campaign")
        or action.get("from")
        or action.get("to")
    )


# Profile / analysis / strategy

def run_profile_interpreter(campaigns: List[Campaign], args: Any) -> Dict[str, Any]:
    stage = getattr(args, "business_stage", "balanced")
    objective = getattr(args, "objective", "efficient growth")
    acceptable_cpa = getattr(args, "acceptable_cpa", None)
    acceptable_roas = getattr(args, "acceptable_roas", None)
    if acceptable_cpa is None:
        acceptable_cpa = 75.0 if stage == "growth" else 120.0 if stage == "defensive" else 90.0
    if acceptable_roas is None:
        acceptable_roas = 2.5 if stage == "growth" else 1.8 if stage == "defensive" else 2.0
    return {
        "stage": stage,
        "objective": objective,
        "acceptable_cpa": acceptable_cpa,
        "acceptable_roas": acceptable_roas,
        "currency_code": CURRENT_CURRENCY_CODE,
        "currency_symbol": CURRENT_CURRENCY_SYMBOL,
        "account_context": "Performance marketing account",
        "decision_rules": [
            "At least 3 comparable campaigns or segments are required.",
            "Only recommend action when CPA or ROAS differs meaningfully from the median.",
        ],
    }


def analyst(campaigns: List[Campaign], profile: Dict[str, Any]) -> Dict[str, Any]:
    total_spend = sum(c.spend for c in campaigns)
    total_conversions = sum(c.conversions for c in campaigns)
    total_revenue = sum(float(c.revenue or 0.0) for c in campaigns)
    revenue_available = any(c.revenue is not None for c in campaigns)
    overall_cpa = (total_spend / total_conversions) if total_conversions else None
    overall_roas = (total_revenue / total_spend) if total_spend and revenue_available else None
    sorted_by_roas = sorted(campaigns, key=lambda c: (c.roas or -1.0, c.spend), reverse=True)
    sorted_by_cpa = sorted(campaigns, key=lambda c: (c.cpa if c.cpa is not None else float("inf"), c.spend))
    return {
        "campaigns": campaigns,
        "segments": [
            {"campaign_group": c.campaign_group, "spend": c.spend, "conversions": c.conversions, "revenue": c.revenue, "cpa": c.cpa, "roas": c.roas, "campaigns": [label(c)]}
            for c in campaigns[:3]
        ],
        "summary": {
            "campaign_count": len(campaigns),
            "segment_count": min(3, len(campaigns)),
            "total_spend": total_spend,
            "total_conversions": total_conversions,
            "total_revenue": total_revenue,
            "overall_cpa": overall_cpa,
            "overall_roas": overall_roas,
            "revenue_available": revenue_available,
            "wasted_spend": total_spend * 0.25,
            "wasted_share": 0.25,
        },
        "performance": {
            "top_30": sorted_by_roas[:3],
            "bottom_30": sorted_by_cpa[:3],
            "wasted_spend": total_spend * 0.25,
            "wasted_share": 0.25,
        },
        "insights": [
            f"Top performers: {', '.join(label(c) for c in sorted_by_roas[:2]) or 'n/a'}",
            f"Bottom performers: {', '.join(label(c) for c in sorted_by_cpa[:2]) or 'n/a'}",
        ],
        "thresholds": {
            "acceptable_cpa": profile.get("acceptable_cpa"),
            "acceptable_roas": profile.get("acceptable_roas"),
        },
    }


def strategist_initial(analysis: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    campaigns = list(analysis.get("campaigns", []) or [])
    if len(campaigns) < 3:
        return {"actions": [], "confidence": "Low"}

    summary = analysis.get("summary") or {}
    total_spend = float(summary.get("total_spend") or 0.0)
    mode = str(summary.get("analysis_mode") or ("roas" if any(c.roas is not None for c in campaigns) else "cpa")).lower()
    spend_floor = max(1000.0, total_spend * 0.05)

    def metric(c: Campaign) -> Optional[float]:
        return c.roas if mode == "roas" else c.cpa

    scored = [c for c in campaigns if metric(c) is not None]
    if len(scored) < 3:
        return {"actions": [], "confidence": "Low"}

    if mode == "roas":
        winner_pool = [c for c in scored if c.spend >= spend_floor]
        winner_pool = winner_pool or scored
        winner = max(winner_pool, key=lambda c: (c.roas or -1.0, c.spend))
        avg_roas = float(summary.get("overall_roas") or 0.0)
        loser_pool = [c for c in scored if label(c) != label(winner) and c.spend >= spend_floor and c.roas is not None and c.roas < avg_roas * 0.85]
        if not loser_pool:
            loser_pool = [c for c in scored if label(c) != label(winner) and c.roas is not None and c.roas < (winner.roas or avg_roas)]
        loser = max(loser_pool or [c for c in scored if label(c) != label(winner)], key=lambda c: ((c.spend or 0.0) * max(0.0, (avg_roas - (c.roas or 0.0))), c.spend or 0.0), default=None)
    else:
        winner_pool = [c for c in scored if c.spend >= spend_floor and c.conversions >= 20]
        winner_pool = winner_pool or scored
        winner = min(winner_pool, key=lambda c: (c.cpa if c.cpa is not None else float("inf"), -c.spend))
        avg_cpa = float(summary.get("overall_cpa") or 0.0)
        loser_pool = [c for c in scored if label(c) != label(winner) and c.spend >= spend_floor and c.cpa is not None and c.cpa > avg_cpa * 1.15]
        if not loser_pool:
            loser_pool = [c for c in scored if label(c) != label(winner) and c.cpa is not None and c.cpa > (winner.cpa or avg_cpa)]
        loser = max(loser_pool or [c for c in scored if label(c) != label(winner)], key=lambda c: ((c.spend or 0.0) * max(0.0, ((c.cpa or avg_cpa) - avg_cpa)), c.spend or 0.0), default=None)

    if loser is None or label(loser) == label(winner):
        return {"actions": [{"type": "monitor", "campaign": label(winner), "campaign_or_segment": label(winner), "amount": 0.0, "reason": "Monitor before moving budget.", "confidence": "Low"}], "confidence": "Low"}

    actions = []
    if loser.spend > 0 and total_spend > 0:
        actions.append({"type": "reallocate", "from": label(loser), "to": label(winner), "campaign_or_segment": f"{label(loser)} → {label(winner)}", "amount": round(min(loser.spend * 0.2, total_spend * 0.1), 2), "reason": "Shift budget from the weaker campaign to the stronger one.", "confidence": "Medium"})
    actions.append({"type": "pause", "campaign": label(loser), "campaign_or_segment": label(loser), "amount": round(loser.spend * 0.1, 2), "reason": "This campaign is weaker than the account average.", "confidence": "Medium"})
    actions.append({"type": "scale", "campaign": label(winner), "campaign_or_segment": label(winner), "amount": round(winner.spend * 0.1, 2), "reason": "This campaign is stronger than the account average.", "confidence": "Medium"})
    while len(actions) < 3:
        actions.append({"type": "monitor", "campaign": label(winner), "campaign_or_segment": label(winner), "amount": 0.0, "reason": "Monitor before moving budget.", "confidence": "Low"})
    return {"actions": actions[:3], "confidence": "Medium"}


def critic(analysis: Dict[str, Any], strategy: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    critiques = []
    for action in strategy.get("actions", [])[:3]:
        critiques.append({"action": action.get("type", "monitor"), "challenge": "Check whether the gap is large enough.", "flawed_assumption": "The current trend will persist.", "weak_signal": "Limited data or noisy attribution.", "attribution_risk": "Medium"})
    return {"critiques": critiques, "required_corrections": [], "validation_notes": []}


def strategist_refinement(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    refined = []
    for action in strategy.get("actions", [])[:3]:
        updated = dict(action)
        updated.setdefault("addressed_criticisms", [])
        refined.append(updated)
    while len(refined) < 3:
        fallback = analysis.get("campaigns", [Campaign()])[0]
        refined.append({"type": "monitor", "campaign": label(fallback), "amount": 0.0, "reason": "Not enough evidence.", "confidence": "Low", "addressed_criticisms": []})
    return {"actions": refined[:3], "confidence": strategy.get("confidence", "Medium")}


def enrich_decisions(strategy: Dict[str, Any], analysis: Dict[str, Any]) -> Dict[str, Any]:
    summary = analysis["summary"]
    enriched = []
    for action in strategy.get("actions", [])[:3]:
        updated = dict(action)
        updated["expected_impact"] = "Expected impact is limited; this is a hold decision." if action.get("type") == "monitor" else "Expected to change blended performance if the signal holds."
        updated["timeframe"] = "7–14 days" if action.get("type") in {"scale", "reallocate"} else "3–7 days" if action.get("type") in {"pause", "reduce"} else "7 days"
        updated["basis_for_amount"] = f"Chosen as a test-sized move relative to the {currency_label()} {fmt_money(summary['total_spend'])} account spend."
        updated["monitor"] = f"Monitor {('ROAS' if summary.get('overall_roas') else 'CPA')} and conversions for regression."
        enriched.append(updated)
    return {**strategy, "actions": enriched[:3]}


def _decision_confidence(action: Dict[str, Any], analysis: Dict[str, Any], sim: Dict[str, Any]) -> tuple[str, str]:
    campaigns = analysis.get("campaigns", [])
    summary = analysis.get("summary", {})
    total_spend = float(summary.get("total_spend") or 0.0)
    lookup = {normalize_name(label(c)): c for c in campaigns}

    def metric_value(campaign: Optional[Campaign]) -> Optional[float]:
        if campaign is None:
            return None
        return campaign.cpa if campaign.cpa is not None else campaign.roas

    source = lookup.get(normalize_name(str(action.get("from") or action.get("campaign") or sim.get("source_campaign") or "")))
    target = lookup.get(normalize_name(str(action.get("to") or action.get("campaign") or sim.get("target_campaign") or "")))
    is_pause = action.get("type") == "pause"
    is_reduce = action.get("type") == "reduce"
    is_scale = action.get("type") == "scale"
    is_reallocate = action.get("type") == "reallocate"
    decision_spend = float(action.get("amount") or 0.0)
    if is_reallocate and source is not None:
        decision_spend = float(source.spend or decision_spend)
    elif (is_pause or is_reduce) and source is not None:
        decision_spend = float(source.spend or decision_spend)
    elif is_scale and target is not None:
        decision_spend = float(target.spend or decision_spend)

    score = 0
    reasons: List[str] = []
    if decision_spend >= max(10000.0, total_spend * 0.15):
        score += 1
        reasons.append("Strong spend volume")
    elif decision_spend <= max(1000.0, total_spend * 0.03):
        score -= 1
        reasons.append("Low spend volume")
    else:
        reasons.append("Moderate spend")

    gap = None
    if is_reallocate and source and target:
        source_metric = metric_value(source)
        target_metric = metric_value(target)
        if source_metric is not None and target_metric is not None:
            gap = abs(source_metric - target_metric) / max(abs(source_metric), abs(target_metric), 0.0001)
    elif (is_pause or is_reduce) and source:
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

    consistent = False
    if source and target:
        consistent = source.conversions >= 50 and target.conversions >= 50 and source.spend >= 8000 and target.spend >= 8000
    elif source:
        consistent = source.conversions >= 50 and source.spend >= 8000 and source.roas is not None
    elif target:
        consistent = target.conversions >= 50 and target.spend >= 8000 and target.roas is not None
    if consistent:
        score += 1
        reasons.append("Consistent performance")
    else:
        score -= 1
        reasons.append("Volatile or thin data")

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

    label_score = "Low"
    if 3 <= score <= 4:
        label_score = "High"
    elif 1 <= score <= 2:
        label_score = "Medium"
    reason = ", ".join(reasons[:3])
    if len(reasons) > 3:
        reason = f"{reason}; {reasons[3]}"
    return label_score, reason or "Thin or mixed signal; treat as directional only."


def simulate_decision(action: Dict[str, Any], analysis: Dict[str, Any], campaigns: List[Campaign]) -> Dict[str, Any]:
    lookup = {normalize_name(label(c)): c for c in campaigns}
    summary = analysis["summary"]
    spend = float(action.get("amount", 0.0) or 0.0)
    action_type = _action_type(action)
    source_name = _text(action.get("from") or action.get("source_campaign") or action.get("campaign") or action.get("campaign_or_segment") or "")
    target_name = _text(action.get("to") or action.get("target_campaign") or action.get("campaign") or action.get("campaign_or_segment") or "")
    source = None
    target = None
    if action_type == "reallocate":
        source = lookup.get(normalize_name(source_name))
        target = lookup.get(normalize_name(target_name))
    elif action_type in {"pause", "reduce"}:
        source = lookup.get(normalize_name(source_name))
        target = max((c for c in campaigns if c is not source), key=lambda c: c.roas or -1.0, default=None)
    elif action_type == "scale":
        target = lookup.get(normalize_name(target_name))
    elif action_type in {"monitor", "test"}:
        target = lookup.get(normalize_name(target_name or source_name))
        source = lookup.get(normalize_name(source_name)) or target
    source_roas = source.roas if source and source.roas is not None else summary.get("overall_roas") or 0.0
    target_roas = target.roas if target and target.roas is not None else summary.get("overall_roas") or source_roas
    delta = target_roas - source_roas
    gain = spend * delta * 0.5
    projected_revenue = max(0.0, (summary["total_revenue"] or 0.0) + gain)
    return {
        **action,
        "source_campaign": label(source) if source else source_name or target_name,
        "target_campaign": label(target) if target else target_name or source_name,
        "source_spend": source.spend if source else 0.0,
        "target_spend": target.spend if target else 0.0,
        "source_cpa": source.cpa if source else None,
        "target_cpa": target.cpa if target else None,
        "source_roas": source_roas,
        "target_roas": target_roas,
        "delta": delta,
        "adjusted_expected_gain": gain,
        "projected_revenue": projected_revenue,
        "assumptions": ["The signal holds.", "Execution remains similar.", "No saturation surprise."],
    }


def simulate_projections(strategy: Dict[str, Any], analysis: Dict[str, Any]) -> Dict[str, Any]:
    decisions = [simulate_decision(action, analysis, analysis["campaigns"]) for action in strategy.get("actions", [])[:3]]
    summary = analysis["summary"]
    total_expected_gain = sum(item["adjusted_expected_gain"] for item in decisions)
    projected_revenue = max(0.0, (summary["total_revenue"] or 0.0) + total_expected_gain)
    projected_roas = (projected_revenue / summary["total_spend"]) if summary["total_spend"] else None
    projected_cpa = (summary["total_spend"] / summary["total_conversions"]) if summary["total_conversions"] else None
    return {
        "decisions": decisions,
        "before": {"revenue": summary["total_revenue"] or 0.0, "roas": summary["overall_roas"], "cpa": summary["overall_cpa"]},
        "after": {"revenue": projected_revenue, "roas": projected_roas, "cpa": projected_cpa},
        "total_expected_gain": total_expected_gain,
        "impact_low": total_expected_gain * 0.75,
        "impact_high": total_expected_gain * 1.25,
    }


def evaluate_output(strategy: Dict[str, Any], critique: Dict[str, Any]) -> Dict[str, Any]:
    decisions = strategy.get("actions", [])[:3]
    critique_count = len(critique.get("critiques", [])[:3])
    concrete_actions = sum(1 for item in decisions if item.get("type") in {"reallocate", "pause", "reduce", "scale"})
    score = {
        "actionability": min(5, max(1, concrete_actions + 2)),
        "financial_clarity": 4 if all(isinstance(item.get("amount"), (int, float)) for item in decisions) else 3,
        "risk_awareness": 5 if critique_count >= 3 else 4,
        "confidence_quality": 4 if any(item.get("confidence") != "Low" for item in decisions) else 3,
    }
    overall = round(sum(score.values()) / 4)
    return {
        "actionability": {"score": score["actionability"], "reason": "Decisions are specific enough."},
        "financial_clarity": {"score": score["financial_clarity"], "reason": "Budget movements are visible."},
        "risk_awareness": {"score": score["risk_awareness"], "reason": "Critique includes risk notes."},
        "confidence_quality": {"score": score["confidence_quality"], "reason": "Confidence is calibrated."},
        "overall": {"score": overall, "reason": "Structured enough for a first-pass decision packet."},
    }


def synthesize_report(analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any]) -> str:
    return f"Gnomeo decision packet with {len(strategy.get('actions', [])[:3])} recommendations."


def build_marketer_content(source_label: str, analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any], audit_result: Dict[str, Any] | None = None) -> Dict[str, Any]:
    perf = analysis["performance"]
    summary = analysis["summary"]
    audit_result = audit_result or {}
    audit_status = audit_result.get("status", "pass")
    audit_warnings = list(audit_result.get("audit_warnings") or [])
    audit_blocking_errors = list(audit_result.get("blocking_errors") or [])
    audit_user_message = audit_result.get("user_message", "Recommendation audit passed.")

    total_spend = float(summary.get("total_spend") or 0.0)
    total_revenue = float(summary.get("total_revenue") or 0.0)
    revenue_available = bool(summary.get("revenue_available"))
    current_roas = summary.get("overall_roas")
    current_cpa = summary.get("overall_cpa")
    campaign_count = int(summary.get("campaign_count") or 0)
    waste_amount = float(perf.get("wasted_spend") or summary.get("wasted_spend") or total_spend * 0.25)
    waste_share = perf.get("wasted_share") if perf.get("wasted_share") is not None else summary.get("wasted_share")
    top_names = ", ".join(label(c) for c in (perf.get("top_30") or [])[:2]) or "n/a"
    bottom_names = ", ".join(label(c) for c in (perf.get("bottom_30") or [])[:2]) or "n/a"

    warning_blob = " ".join(audit_warnings).lower()

    def decision_signal_label(action_type: str, raw_confidence: str, impact_available: bool, decision_warnings: list[str]) -> str:
        warning_text = " ".join(decision_warnings).lower()
        if action_type == "monitor":
            return "Monitor"
        if action_type == "test":
            return "Needs test"
        if raw_confidence == "High" and not any(token in warning_text for token in ("downgrad", "outlier handling", "capped")):
            return "High confidence"
        if action_type in {"reallocate", "pause", "reduce", "scale"}:
            return "Moderate confidence"
        if not impact_available:
            return "Thin signal"
        if raw_confidence in {"High", "Medium"}:
            return "Moderate confidence"
        return "Thin signal"

    def decision_rationale(action_type: str, decision: Dict[str, Any], signal_label: str) -> str:
        if action_type in {"reallocate", "pause", "reduce"}:
            return "Spend is meaningful and performance is weaker than the account average, so Gnomeo recommends moving budget toward a stronger signal rather than increasing total spend."
        if action_type == "scale":
            return "This campaign shows stronger efficiency than the overall account average, so Gnomeo recommends a controlled increase rather than an aggressive scale."
        if action_type == "test":
            return "The signal is good enough to explore, but not strong enough for a larger budget move, so Gnomeo recommends a controlled test."
        return "The signal is still too uneven for a confident budget change, so Gnomeo recommends watching performance before changing spend."

    def conservative_note(action_type: str, signal_label: str, decision: Dict[str, Any], decision_warnings: list[str]) -> str:
        warning_text = " ".join(decision_warnings).lower()
        if action_type in {"monitor", "test"}:
            return ""
        if signal_label == "Thin signal":
            return "Signal quality was not strong enough for a bolder move."
        if any(token in warning_text for token in ("downgrad", "outlier handling", "capped")):
            return "Audit safeguards reduced the aggressiveness of this recommendation."
        return ""

    def build_priority(title: str, decision: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "title": title,
            "detail": decision.get("action_line") or decision.get("campaign_line") or "Review the campaign and keep the move small.",
            "confidence": decision.get("signal_label") or decision.get("confidence") or "Moderate confidence",
        }

    decisions = []
    for action, sim in zip(strategy.get("actions", [])[:3], simulation.get("decisions", [])[:3]):
        action_type = _action_type(action)
        campaign_hint = _action_campaign(action)
        metric_name = "CPA" if sim.get("source_cpa") is not None or sim.get("target_cpa") is not None else "ROAS"
        metric_value = sim.get("source_cpa") if metric_name == "CPA" else sim.get("source_roas")
        target_metric_value = sim.get("target_cpa") if metric_name == "CPA" else sim.get("target_roas")
        current_spend = sim.get("source_spend") if action_type in {"reallocate", "pause", "reduce"} else sim.get("target_spend")
        if current_spend in {0, 0.0, None} and action_type in {"reallocate", "pause", "reduce", "scale"}:
            current_spend = None
        if action_type == "reallocate":
            source_name = sim.get("source_campaign") or campaign_hint
            target_name = sim.get("target_campaign") or campaign_hint
            campaign_line = f"{source_name} → {target_name}"
            action_line = f"Reduce {fmt_money(float(action.get('amount', 0.0) or 0.0))} from {source_name} → increase {target_name} by {fmt_money(float(action.get('amount', 0.0) or 0.0))}"
            metric_text = f"{metric_name} {fmt_money(metric_value) if metric_name == 'CPA' else fmt_x(metric_value)} → {fmt_money(target_metric_value) if metric_name == 'CPA' else fmt_x(target_metric_value)}"
        elif action_type in {"pause", "reduce"}:
            verb = "Pause" if action_type == "pause" else "Reduce"
            campaign_line = f"{sim.get('source_campaign') or campaign_hint}"
            action_line = f"{verb} {sim.get('source_campaign') or campaign_hint} and free {fmt_money(float(action.get('amount', 0.0) or 0.0))}"
            metric_text = f"{metric_name} {fmt_money(metric_value) if metric_name == 'CPA' else fmt_x(metric_value)}"
        elif action_type == "test":
            campaign_line = f"{sim.get('target_campaign') or sim.get('source_campaign') or campaign_hint}"
            action_line = f"Run a controlled test on {campaign_line}"
            metric_text = f"{metric_name} {fmt_money(target_metric_value) if metric_name == 'CPA' else fmt_x(target_metric_value)}"
        elif action_type == "monitor":
            campaign_line = f"{sim.get('target_campaign') or sim.get('source_campaign') or campaign_hint}"
            action_line = f"Monitor {campaign_line} before changing budget"
            metric_text = f"{metric_name} {fmt_money(target_metric_value) if metric_name == 'CPA' else fmt_x(target_metric_value)}"
        else:
            campaign_line = f"{sim.get('target_campaign') or sim.get('source_campaign') or campaign_hint}"
            action_line = f"Increase {campaign_line} by {fmt_money(float(action.get('amount', 0.0) or 0.0))}"
            metric_text = f"{metric_name} {fmt_money(target_metric_value) if metric_name == 'CPA' else fmt_x(target_metric_value)}"

        confidence, confidence_reason = _decision_confidence(action, analysis, sim)
        impact_value = abs(float(sim.get("adjusted_expected_gain", 0.0) or 0.0))
        impact_available = action_type not in {"monitor", "test"} and impact_value > 0
        if action_type in {"monitor", "test"} or not impact_available:
            impact_range = "Impact not estimated"
            impact_low_value = None
            impact_high_value = None
        else:
            impact_range = _estimated_impact_range(impact_value)
            impact_low_value = impact_value * 0.75
            impact_high_value = impact_value * 1.25

        decision_warnings = [warning for warning in audit_warnings if normalize_name(campaign_line) in normalize_name(warning) or normalize_name(campaign_line.split(" → ")[0]) in normalize_name(warning)]
        signal_label = decision_signal_label(action_type, confidence, impact_available, decision_warnings)
        rationale = decision_rationale(action_type, {"campaign_line": campaign_line, "metric_text": metric_text, "current_spend": current_spend, "impact_range": impact_range}, signal_label)
        conservative = conservative_note(action_type, signal_label, {"campaign_line": campaign_line}, decision_warnings)

        decisions.append({
            "type": action.get("type") or action.get("action"),
            "source": sim.get("source_campaign") or action.get("from") or action.get("campaign") or action.get("campaign_or_segment") or campaign_hint or "Unassigned",
            "target": sim.get("target_campaign") or action.get("to") or action.get("campaign") or action.get("campaign_or_segment") or campaign_hint or "Unassigned",
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
            "signal_label": signal_label,
            "confidence_reason": confidence_reason,
            "confidence_grade": confidence,
            "confidence_reason_detailed": confidence_reason,
            "rationale": rationale,
            "conservative_note": conservative,
            "audit_note": "; ".join(decision_warnings) if decision_warnings else "",
            "implementation": _implementation_guidance(confidence, metric_name),
            "impact_range": impact_range,
            "impact_low_value": impact_low_value,
            "impact_high_value": impact_high_value,
        })

    decisions = sorted(decisions, key=lambda row: row["amount"], reverse=True)
    for idx, row in enumerate(decisions, 1):
        row["priority"] = _priority_from_rank(idx)

    report_decisions = []
    for decision in decisions:
        source_key = normalize_name(str(decision.get("source") or decision.get("campaign_line") or ""))
        if decision["type"] == "pause" and any(existing["type"] == "reallocate" and normalize_name(str(existing.get("source") or existing.get("campaign_line") or "")) == source_key for existing in report_decisions):
            continue
        report_decisions.append(decision)

    top_reduce = next((d for d in report_decisions if d["type"] in {"reallocate", "pause", "reduce"}), None)
    top_scale = next((d for d in report_decisions if d["type"] == "scale"), None)
    top_monitor = next((d for d in report_decisions if d["type"] in {"monitor", "test"}), None)

    top_priorities: list[Dict[str, Any]] = []
    if top_reduce:
        top_priorities.append(build_priority("Reduce or reallocate the clearest waste candidate", top_reduce))
    if top_scale:
        top_priorities.append(build_priority("Scale the strongest winner carefully", top_scale))
    if top_monitor:
        top_priorities.append(build_priority("Keep thin-signal campaigns in monitor/test mode", top_monitor))
    if len(top_priorities) < 3:
        top_priorities.append({
            "title": "Stay conservative until signal quality improves",
            "detail": audit_user_message if audit_warnings or audit_blocking_errors else "No additional caution flags were raised, but gradual rollout is still the safest default.",
            "confidence": "Monitor",
        })

    summary_paragraphs = []
    if campaign_count:
        if waste_share is not None:
            summary_paragraphs.append(f"Gnomeo reviewed {campaign_count} campaigns and found {fmt_money(waste_amount)} of estimated waste ({waste_share * 100:.1f}% of spend).")
        else:
            summary_paragraphs.append(f"Gnomeo reviewed {campaign_count} campaigns and found {fmt_money(waste_amount)} of estimated waste.")
    if current_roas is not None:
        summary_paragraphs.append(f"The account is currently running at {fmt_x(current_roas)} ROAS.")
    elif current_cpa is not None:
        summary_paragraphs.append(f"The account is currently running at {fmt_money(current_cpa)} CPA.")
    if top_reduce and top_scale:
        summary_paragraphs.append(f"The clearest move is to shift budget from {top_reduce['campaign_line'].split(' → ')[0]} into {top_scale['campaign_line'].split(' → ')[-1]}.")
    if top_monitor:
        summary_paragraphs.append("Some campaigns stay in monitor or test mode because the export is too thin to trust safely.")
    if not summary_paragraphs:
        summary_paragraphs.append("Gnomeo found a small number of clear moves, but keeps the analysis conservative when signal quality is mixed.")
    executive_summary = " ".join(summary_paragraphs)

    account_snapshot = [
        {"label": "Spend analysed", "value": fmt_money(total_spend)},
        {"label": "Revenue analysed", "value": fmt_money(total_revenue) if revenue_available else "n/a"},
        {"label": "Current ROAS", "value": fmt_x(current_roas) if current_roas is not None else "n/a"},
        {"label": "Current CPA", "value": fmt_money(current_cpa) if current_cpa is not None else "n/a"},
        {"label": "Campaigns analysed", "value": str(campaign_count)},
        {"label": "Wasted spend", "value": fmt_money(waste_amount)},
    ]

    signal_notes = []
    for decision in report_decisions:
        note = decision.get("conservative_note")
        if note:
            signal_notes.append(f"{decision['campaign_line']}: {note}")
    if any(decision["signal_label"] in {"Monitor", "Needs test"} for decision in report_decisions):
        signal_notes.append("Monitor/test items stay in that mode until the signal is stronger.")
    if audit_warnings:
        signal_notes.extend(audit_warnings[:3])
    signal_notes = list(dict.fromkeys(signal_notes)) or ["No extra caution flags beyond the standard audit checks."]

    caveats = [
        f"Audit status: {audit_status}.",
        audit_user_message,
        f"Top performers: {top_names}",
        f"Bottom performers: {bottom_names}",
    ]
    if audit_warnings:
        caveats.extend(audit_warnings)
    if audit_blocking_errors:
        caveats.extend(audit_blocking_errors)
    caveats.extend([
        "Confidence reflects data volume, consistency, and missing context such as margin and attribution.",
        "This is a snapshot based on the exported dataset.",
        "Results may shift with seasonality, creative fatigue, and lagged conversions.",
        "Recheck after the next spend cycle.",
    ])
    caveats = list(dict.fromkeys(caveats))

    impact_values = [float(d["impact_low_value"]) for d in decisions if isinstance(d.get("impact_low_value"), (int, float)) and d.get("impact_low_value") is not None]
    impact_high_values = [float(d["impact_high_value"]) for d in decisions if isinstance(d.get("impact_high_value"), (int, float)) and d.get("impact_high_value") is not None]
    impact_low = sum(impact_values) if impact_values else None
    impact_high = sum(impact_high_values) if impact_high_values else None

    return {
        "source_name": source_label,
        "currency_code": CURRENT_CURRENCY_CODE,
        "currency_symbol": CURRENT_CURRENCY_SYMBOL,
        "executive_summary": executive_summary,
        "account_snapshot": account_snapshot,
        "top_priorities": top_priorities[:3],
        "decisions": report_decisions,
        "signal_notes": signal_notes,
        "caveats": caveats,
        "wasted_share_pct": waste_share * 100 if waste_share is not None else None,
        "wasted_spend": waste_amount,
        "current_roas": current_roas,
        "impact_low": impact_low,
        "impact_high": impact_high,
        "impact_available": bool(impact_values or impact_high_values),
        "summary_line": executive_summary,
        "audit_status": audit_status,
        "audit_user_message": audit_user_message,
        "audit_warnings": audit_warnings,
        "audit_blocking_errors": audit_blocking_errors,
        "methodology": "This analysis compares campaign efficiency and reallocates budget toward areas with stronger historical performance, while adjusting for execution risk.",
        "insights": [
            f"Top performers: {top_names}",
            f"Bottom performers: {bottom_names}",
            f"Wasted spend: {fmt_money(waste_amount)}" + (f" ({waste_share * 100:.1f}%)" if waste_share is not None else ""),
        ],
        "confidence_notes": [
            "Confidence reflects data volume, consistency, and missing context such as margin and attribution.",
            "This is a snapshot based on the exported dataset.",
            "Results may shift with seasonality, creative fatigue, and lagged conversions.",
            "Recheck after the next spend cycle.",
            f"Audit status: {audit_status}.",
        ],
    }


def render_markdown_report(source_label: str, content: Dict[str, Any]) -> str:
    lines = [
        "# Gnomeo Agent MVP Report",
        f"Source file: {source_label}",
        "",
    ]

    sources = content.get("sources_analyzed") or []
    if sources:
        lines.append("## Sources analyzed")
        for source in sources:
            if isinstance(source, dict):
                label = source.get("label") or "Unknown"
                count = source.get("campaign_count")
                suffix = f" ({count} campaigns)" if count is not None else ""
                lines.append(f"- {label}{suffix}")
            else:
                lines.append(f"- {source}")
        lines.append("")

    lines.append("## Executive Summary")
    for paragraph in str(content.get("executive_summary") or "").split(". "):
        paragraph = paragraph.strip()
        if paragraph:
            lines.append(paragraph if paragraph.endswith(".") else f"{paragraph}.")
    lines.append("")

    lines.append("## Account Snapshot")
    for item in content.get("account_snapshot") or []:
        lines.append(f"- **{item.get('label', 'Value')}**: {item.get('value', 'n/a')}")
    lines.append("")

    lines.append("## Top Priorities")
    for item in content.get("top_priorities") or []:
        lines.append(f"- **{item.get('title', 'Priority')}**: {item.get('detail', '')} ({item.get('confidence', 'n/a')})")
    lines.append("")

    lines.append("## Key Decisions")
    for idx, decision in enumerate(content.get("decisions") or [], 1):
        lines.append(f"{idx}. {decision.get('action_line', 'Review the campaign')}")
        lines.append(f"   - Campaign(s): {decision.get('campaign_line', 'n/a')}")
        spend = decision.get('current_spend')
        lines.append(f"   - Current spend: {spend if spend is not None else 'n/a'}")
        lines.append(f"   - Estimated impact: {decision.get('impact_range', 'n/a')}")
        lines.append(f"   - Confidence: {decision.get('confidence', 'n/a')}")
        rationale = decision.get('rationale')
        if rationale:
            lines.append(f"   - Reason: {rationale}")
        implementation = decision.get('implementation')
        if implementation:
            lines.append(f"   - Implementation: {implementation}")
    lines.append("")

    signal_notes = content.get("signal_notes") or []
    if signal_notes:
        lines.append("## Signal Notes / Conservative Calls")
        for note in signal_notes:
            lines.append(f"- {note}")
        lines.append("")

    caveats = content.get("caveats") or []
    if caveats:
        lines.append("## Data Quality & Caveats")
        for caveat in caveats:
            lines.append(f"- {caveat}")
        lines.append("")

    return "\n".join(lines).strip() + "\n"


def render_html_report(source_label: str, content: Dict[str, Any]) -> str:
    def card(label: str, value: Any) -> str:
        return f'<div class="stat-card"><div class="label">{esc(label)}</div><div class="value">{esc(value)}</div></div>'

    sources = content.get("sources_analyzed") or []
    source_items = []
    for item in sources:
        if isinstance(item, dict):
            label = item.get("label", "Unknown")
            count = item.get("campaign_count")
            suffix = f" ({count} campaigns)" if count is not None else ""
            source_items.append(f"<li>{esc(label)}{esc(suffix)}</li>")
        else:
            source_items.append(f"<li>{esc(item)}</li>")
    sources_html = "".join(source_items)

    summary_cards = "".join(card(item.get("label", "Value"), item.get("value", "n/a")) for item in (content.get("account_snapshot") or []))
    priority_cards = "".join(
        f'<div class="card"><h3>{esc(item.get("title", "Priority"))}</h3><p>{esc(item.get("detail", ""))}</p><p class="muted"><strong>{esc(item.get("confidence", "n/a"))}</strong></p></div>'
        for item in (content.get("top_priorities") or [])
    )
    decision_cards = []
    for idx, decision in enumerate(content.get("decisions") or [], 1):
        html_block = [
            f'<div class="card decision-card"><h3>{idx}. {esc(decision.get("action_line", "Review the campaign"))}</h3>',
            f'<p class="decision-meta"><strong>Campaign(s):</strong> {esc(decision.get("campaign_line", "n/a"))}</p>',
            f'<p class="decision-meta"><strong>Current spend:</strong> {esc(decision.get("current_spend", "n/a") if decision.get("current_spend") is not None else "n/a")}</p>',
            f'<p class="decision-meta"><strong>Estimated impact:</strong> {esc(decision.get("impact_range", "n/a"))}</p>',
            f'<p class="decision-meta"><strong>Confidence:</strong> {esc(decision.get("confidence", "n/a"))}</p>',
        ]
        if decision.get("rationale"):
            html_block.append(f'<p class="decision-note">{esc(decision.get("rationale"))}</p>')
        if decision.get("implementation"):
            html_block.append(f'<p class="decision-note"><strong>Implementation:</strong> {esc(decision.get("implementation"))}</p>')
        html_block.append('</div>')
        decision_cards.append("".join(html_block))
    decision_cards = "".join(decision_cards)
    signal_notes = "".join(f"<li>{esc(note)}</li>" for note in (content.get("signal_notes") or []))
    caveats = "".join(f"<li>{esc(caveat)}</li>" for caveat in (content.get("caveats") or []))
    summary_paragraphs = "".join(f"<p>{esc(part.strip())}</p>" for part in str(content.get("executive_summary") or "").split(". ") if part.strip())

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gnomeo Agent MVP Report</title>
  <style>
    :root {{ --bg:#fff; --text:#101828; --muted:#667085; --line:#eaecf0; --soft:#f8fafc; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--bg); color:var(--text); font:15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    .wrap {{ max-width:980px; margin:0 auto; padding:40px 24px 72px; }}
    h1 {{ font-size:30px; margin:0 0 10px; text-align:center; letter-spacing:-0.04em; }}
    h2 {{ font-size:22px; margin:32px 0 14px; letter-spacing:-0.03em; }}
    h3 {{ margin:0 0 8px; font-size:17px; }}
    p {{ margin:0 0 10px; }}
    ul {{ margin:8px 0 0 20px; padding:0; }}
    li {{ margin-bottom:6px; }}
    .muted {{ color:var(--muted); }}
    .section-block {{ margin-top:28px; }}
    .summary-grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }}
    .priority-grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }}
    .decision-grid {{ display:grid; gap:14px; }}
    .card, .stat-card {{ border:1px solid var(--line); border-radius:16px; background:#fff; box-shadow:0 1px 2px rgba(16,24,40,.04); padding:18px; }}
    .label {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:6px; }}
    .value {{ font-size:22px; font-weight:700; letter-spacing:-0.03em; }}
    .summary-card {{ border:1px solid var(--line); border-radius:18px; background:var(--soft); padding:18px; }}
    .summary-card p:last-child {{ margin-bottom:0; }}
    .decision-note {{ padding-top:8px; border-top:1px solid var(--line); color:var(--muted); }}
    .decision-meta {{ margin:0 0 8px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Gnomeo Agent MVP Report</h1>
    <p class="muted" style="text-align:center;">Source file: {esc(source_label)}</p>

    <section class="section-block">
      <h2>Sources analyzed</h2>
      <div class="card"><ul>{sources_html or '<li>n/a</li>'}</ul></div>
    </section>

    <section class="section-block">
      <h2>Executive Summary</h2>
      <div class="summary-card">{summary_paragraphs}</div>
    </section>

    <section class="section-block">
      <h2>Account Snapshot</h2>
      <div class="summary-grid">{summary_cards}</div>
    </section>

    <section class="section-block">
      <h2>Top Priorities</h2>
      <div class="priority-grid">{priority_cards}</div>
    </section>

    <section class="section-block">
      <h2>Key Decisions</h2>
      <div class="decision-grid">{decision_cards}</div>
    </section>

    <section class="section-block">
      <h2>Signal Notes / Conservative Calls</h2>
      <div class="card"><ul>{signal_notes or '<li>n/a</li>'}</ul></div>
    </section>

    <section class="section-block">
      <h2>Data Quality &amp; Caveats</h2>
      <div class="card"><ul>{caveats or '<li>n/a</li>'}</ul></div>
    </section>
  </div>
</body>
</html>"""
def marketer(source_context: Dict[str, Any], analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any], evaluation: Dict[str, Any], synthesizer_text: str) -> Dict[str, Any]:
    source_value = str(source_context.get("source") or source_context.get("csv_path") or "dataset")
    sources_analyzed = source_context.get("sources_analyzed") or []
    if len(sources_analyzed) > 1:
        labels = [item.get("label") if isinstance(item, dict) else str(item) for item in sources_analyzed]
        source_label = " + ".join(label for label in labels if label) or Path(source_value).name if source_value else "dataset"
    else:
        source_label = Path(source_value).name if source_value else "dataset"
    ingestion_contract = source_context.get("ingestion_contract") or {}
    audit_result = audit_recommendations(ingestion_contract, {"analysis": analysis, "strategy": strategy, "simulation": simulation, "critique": critique, "evaluation": evaluation, "synthesizer_text": synthesizer_text})
    audited_actions = [item for item in audit_result.get("recommendations", []) if not item.get("blocked")]
    if not audited_actions:
        audited_actions = [{"type": "monitor", "action": "No strong budget move recommended yet", "campaign_or_segment": "account-level placeholder", "reason": audit_result.get("user_message", "Recommendation audit blocked unsafe output."), "amount": 0.0, "confidence": "low", "expected_impact": "Hold until the signal improves.", "rollout_plan": "Monitor for 7 days.", "monitoring_window": "7 days", "revert_condition": "Re-evaluate once evidence improves."}]
    audited_strategy = {**strategy, "actions": audited_actions[:3]}
    audited_simulation = simulate_projections(audited_strategy, analysis)
    content = build_marketer_content(source_label, analysis, audited_strategy, critique, audited_simulation, audit_result)
    content["sources_analyzed"] = list(source_context.get("sources_analyzed") or [])
    return {"content": content, "audit_result": audit_result, "final_report_text": render_markdown_report(source_label, content), "final_report_html": render_html_report(source_label, content)}


def render_graph_mode_appendix(state: Any) -> str:
    warnings = getattr(state, "warnings", []) or []
    confidence = getattr(state, "confidence", "high")
    trace = getattr(state, "trace", []) or []
    lines = ["## Graph Mode Trace", "- Flow: Profile Interpreter → Analyst → Strategist Initial → Critic → Strategist Refinement → Synthesizer → Marketer → Evaluation", f"- Confidence: {confidence}"]
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
    parser.add_argument("csv_paths", nargs="*", default=[str(DEFAULT_INPUT)], help="Path(s) to CSV file(s)")
    parser.add_argument("--business-stage", default="balanced", choices=["balanced", "growth", "defensive"], help="Business profile stage used to derive thresholds")
    parser.add_argument("--objective", default="efficient growth", help="Business objective used by the profile interpreter")
    parser.add_argument("--acceptable-cpa", type=float, default=None, help="Override acceptable CPA")
    parser.add_argument("--acceptable-roas", type=float, default=None, help="Override acceptable ROAS")
    parser.add_argument("--graph", action="store_true", help="Use the lightweight graph orchestration layer")
    parser.add_argument("--audit", action="store_true", help="Print recommendation audit details")
    parser.add_argument("--output-report", default=str(OUTPUT_REPORT), help="Path for the generated markdown report")
    parser.add_argument("--output-html", default=str(OUTPUT_HTML), help="Path for the generated HTML report")
    args = parser.parse_args()

    output_report = Path(args.output_report).expanduser().resolve()
    output_html = Path(args.output_html).expanduser().resolve()
    source_paths = [Path(value).expanduser().resolve() for value in (args.csv_paths or [str(DEFAULT_INPUT)])]
    missing_sources = [str(source) for source in source_paths if not source.exists()]
    if missing_sources:
        raise SystemExit(f"Missing data file(s): {', '.join(missing_sources)}")

    ingestions = [ingest_campaign_export(path) for path in source_paths]
    for result in ingestions:
        if not result.valid:
            print(format_validation_message(result), file=sys.stderr)
            raise SystemExit(1)

    source_summaries = []
    combined = copy.deepcopy(ingestions[0])
    if len(ingestions) > 1:
        combined.records = []
        combined.raw_rows = []
        combined.issues = []
        combined.warnings = []
        combined.field_mapping = dict(ingestions[0].field_mapping)
        combined.currency = dict(ingestions[0].currency)
        combined.platform = {"platform": "mixed", "confidence": "medium", "signals": "multiple sources"}
        combined.analysis_mode = "roas" if any((item.analysis_mode or "").lower() == "roas" or item.summary.get("revenue_present") for item in ingestions) else ("cpa" if all((item.analysis_mode or "").lower() == "cpa" for item in ingestions) else ingestions[0].analysis_mode)
        combined.segment_strategy = {
            "name": "multi_source_combined",
            "fields": ["campaign_name"],
            "segment_count": sum(len(item.records) for item in ingestions),
            "coverage": 1.0,
            "sample_segment_names": [],
        }
        combined.summary = {
            "row_count": 0,
            "normalized_row_count": 0,
            "total_spend": 0.0,
            "total_conversions": 0,
            "total_revenue": 0.0,
            "revenue_present": False,
            "segment_count": 0,
            "platform": "mixed",
            "platform_confidence": "medium",
        }
        for item in ingestions:
            prefix = source_export_label(item.platform.get("platform", "unknown"))
            source_summaries.append({"label": source_export_label(item.platform.get("platform", "unknown")), "campaign_count": len(item.records)})
            combined.summary["row_count"] += int(item.summary.get("row_count") or 0)
            combined.summary["normalized_row_count"] += int(item.summary.get("normalized_row_count") or 0)
            combined.summary["total_spend"] += float(item.summary.get("total_spend") or 0.0)
            combined.summary["total_conversions"] += int(item.summary.get("total_conversions") or 0)
            if item.summary.get("revenue_present"):
                combined.summary["revenue_present"] = True
                combined.summary["total_revenue"] += float(item.summary.get("total_revenue") or 0.0)
            for record in item.records:
                merged_record = dict(record)
                campaign_name = str(merged_record.get("campaign") or "").strip()
                if campaign_name:
                    merged_record["campaign"] = f"{prefix} | {campaign_name}"
                merged_raw = dict(merged_record.get("raw") or {})
                merged_raw["source_file"] = item.path.name
                merged_raw["source_platform"] = item.platform.get("platform", "unknown")
                merged_record["raw"] = merged_raw
                combined.records.append(merged_record)
            combined.raw_rows.extend(item.raw_rows)
            combined.warnings.extend(item.warnings)
            combined.issues.extend(item.issues)
        combined.summary["segment_count"] = len(combined.records)
        if not combined.summary["revenue_present"]:
            combined.summary["total_revenue"] = None
        combined.debug = dict(ingestions[0].debug)
        combined.debug["source_summaries"] = source_summaries
        combined.debug["combined_sources"] = [str(path) for path in source_paths]
        combined.debug["detected_platform"] = {"platform": "mixed", "confidence": "medium", "signals": "multiple sources"}
        combined.debug["chosen_segmentation_strategy"] = combined.segment_strategy
        if combined.records:
            combined.segment_strategy["sample_segment_names"] = [record.get("campaign") for record in combined.records[:3] if record.get("campaign")]
    else:
        source_summaries = [{"label": source_export_label(combined.platform.get("platform", "unknown")), "campaign_count": len(combined.records)}]
        combined.debug = dict(combined.debug)
        combined.debug["source_summaries"] = source_summaries
        combined.debug["combined_sources"] = [str(source_paths[0])]

    contract = build_ingestion_contract(combined)
    if not contract.get("ok"):
        print(contract.get("user_message") or format_validation_message(combined), file=sys.stderr)
        raise SystemExit(1)

    set_currency_context(combined.currency.get("currency_code", "GBP"), combined.currency.get("currency_symbol", "£"), combined.currency.get("currency_source", "detected"))
    campaigns = [Campaign(**{k: v for k, v in record.items() if k != "campaign_group"}) for record in combined.records]
    args.ingestion_contract = contract
    args.csv_path = ", ".join(str(path) for path in source_paths)

    if args.graph:
        graph = DecisionGraph(profile_interpreter=run_profile_interpreter, analyst=analyst, strategist_initial=strategist_initial, critic=critic, strategist_refinement=strategist_refinement, enrich_decisions=enrich_decisions, simulate_projections=simulate_projections, synthesizer=synthesize_report, evaluate_output=evaluate_output, marketer=marketer)
        graph_state = graph.run(campaigns, args)
        profile_context = graph_state.profile or {}
        analysis = graph_state.analyst_output or {}
        strategy_initial = graph_state.strategist_initial_output or {}
        enriched_strategy = graph_state.enriched_strategy or {}
        critique = graph_state.critic_output or {}
        evaluation = graph_state.evaluation_output or {}
        marketer_output = graph_state.marketer_output or {}
        final = marketer_output.get("final_report_text", graph_state.synthesizer_output or "")
        report = final + "\n" + render_graph_mode_appendix(graph_state)
        html_report = (marketer_output.get("final_report_html", "") or "").replace("</body>\n</html>", render_graph_mode_html_appendix(graph_state) + "</body>\n</html>")
    else:
        profile_context = run_profile_interpreter(campaigns, args)
        analysis = analyst(campaigns, profile_context)
        strategy_initial = strategist_initial(analysis, profile_context)
        critique = critic(analysis, strategy_initial, profile_context)
        strategy_refined = strategist_refinement(analysis, strategy_initial, critique, profile_context)
        enriched_strategy = enrich_decisions(strategy_refined, analysis)
        simulation = simulate_projections(enriched_strategy, analysis)
        evaluation = evaluate_output(enriched_strategy, critique)
        marketer_output = marketer({"source": str(args.csv_path), "csv_path": str(source_paths[0]), "ingestion_contract": contract, "sources_analyzed": source_summaries}, analysis, enriched_strategy, critique, simulation, evaluation, "")
        final = marketer_output["final_report_text"]
        report = final
        html_report = marketer_output["final_report_html"]

    output_report.write_text(report, encoding="utf-8")
    output_html.write_text(html_report, encoding="utf-8")


if __name__ == "__main__":
    main()
