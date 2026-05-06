#!/usr/bin/env python3
from __future__ import annotations

import argparse
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
            "confidence_reason": confidence_reason,
            "confidence_reason_detailed": confidence_reason,
            "implementation": _implementation_guidance(confidence, metric_name),
            "impact_range": _estimated_impact_range(abs(float(sim.get("adjusted_expected_gain", 0.0) or 0.0))),
            "impact_low_value": abs(float(sim.get("adjusted_expected_gain", 0.0) or 0.0)) * 0.75,
            "impact_high_value": abs(float(sim.get("adjusted_expected_gain", 0.0) or 0.0)) * 1.25,
        })
    decisions = sorted(decisions, key=lambda row: row["amount"], reverse=True)
    for idx, row in enumerate(decisions, 1):
        row["priority"] = _priority_from_rank(idx)

    audit_result = audit_result or {}
    audit_status = audit_result.get("status", "pass")
    audit_warnings = list(audit_result.get("audit_warnings") or [])
    audit_blocking_errors = list(audit_result.get("blocking_errors") or [])
    audit_user_message = audit_result.get("user_message", "Recommendation audit passed.")
    wasted_pct = perf["wasted_share"] * 100 if perf["wasted_share"] is not None else None
    summary_line = audit_user_message if audit_status == "blocked" else (f"~{wasted_pct:.0f}% of budget is underperforming and can be reallocated." if wasted_pct is not None else "Underperforming spend is present but the share is unclear.")
    top_names = ", ".join(label(c) for c in (perf.get("top_30") or [])[:2]) or "n/a"
    bottom_names = ", ".join(label(c) for c in (perf.get("bottom_30") or [])[:2]) or "n/a"
    impact_low_value = sum(float(d["impact_low_value"]) for d in decisions)
    impact_high_value = sum(float(d["impact_high_value"]) for d in decisions)
    impact_available = any(float(d.get("current_spend") or 0.0) > 0 and float(d.get("impact_high_value") or 0.0) > 0 for d in decisions)
    return {
        "source_name": source_label,
        "currency_code": CURRENT_CURRENCY_CODE,
        "currency_symbol": CURRENT_CURRENCY_SYMBOL,
        "wasted_share_pct": wasted_pct,
        "wasted_spend": perf["wasted_spend"],
        "current_roas": analysis["summary"].get("overall_roas"),
        "decisions": decisions,
        "impact_low": impact_low_value if impact_available or impact_low_value > 0 else None,
        "impact_high": impact_high_value if impact_available or impact_high_value > 0 else None,
        "impact_available": impact_available or impact_low_value > 0 or impact_high_value > 0,
        "top_names": top_names,
        "bottom_names": bottom_names,
        "summary_line": summary_line,
        "audit_status": audit_status,
        "audit_user_message": audit_user_message,
        "audit_warnings": audit_warnings,
        "audit_blocking_errors": audit_blocking_errors,
        "methodology": "This analysis compares campaign efficiency and reallocates budget toward areas with stronger historical performance, while adjusting for execution risk." if audit_status != "blocked" else "Decision engine output was blocked by the recommendation audit layer.",
        "insights": list(analysis.get("insights", [])) + [
            f"Wasted spend: {fmt_money(perf['wasted_spend'])}" + (f" ({wasted_pct:.1f}%)" if wasted_pct is not None else ""),
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
        "## Executive Summary",
        content["summary_line"],
        f"All values shown in {content['currency_code']} ({content['currency_symbol']}).",
        "",
        "## Key Decisions",
    ]
    for idx, decision in enumerate(content["decisions"], 1):
        lines.extend([
            f"{idx}. {decision['action_line']}",
            f"   - Priority: {decision['priority']}",
            f"   - Campaign(s): {decision['campaign_line']}",
            f"   - Current spend: {fmt_money(decision['current_spend']) if isinstance(decision['current_spend'], (int, float)) else 'n/a'}",
            f"   - Key metric: {decision['metric_text']}",
            f"   - Estimated impact: {decision['impact_range']}",
            f"   - Confidence: {decision['confidence']}",
            f"   - Reason: {decision['confidence_reason']}",
            f"   - Implementation: {decision['implementation']}",
        ])
    lines.extend([
        "",
        "## Recommendation Audit",
        f"Status: {content.get('audit_status', 'pass')}",
        f"Message: {content.get('audit_user_message', 'Recommendation audit passed.')}",
    ])
    if content.get("audit_warnings"):
        lines.append("Warnings:")
        lines.extend(f"- {item}" for item in content["audit_warnings"])
    if content.get("audit_blocking_errors"):
        lines.append("Blocking errors:")
        lines.extend(f"- {item}" for item in content["audit_blocking_errors"])
    lines.extend([
        "",
        "## Expected Impact",
        f"Estimated impact: {_impact_summary(content.get('impact_low'), content.get('impact_high'))}",
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
    return "\n".join(lines) + "\n"


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
          <p><strong>Implementation:</strong> {esc(decision['implementation'])}</p>
        </div>
        """)
    logo_src = report_logo_data_uri()
    logo_html = f'<img class="report-logo" src="{logo_src}" alt="Gnomeo logo" />' if logo_src else ""
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
    .report-logo {{ display:block; width:180px; max-width:55vw; height:auto; object-fit:contain; margin:0 auto 18px; }}
    h1 {{ font-size:30px; margin:0 0 10px; text-align:center; }}
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
    {logo_html}
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

    <h2>Recommendation Audit</h2>
    <p><strong>Status:</strong> {esc(content.get('audit_status', 'pass'))}</p>
    <p><strong>Message:</strong> {esc(content.get('audit_user_message', 'Recommendation audit passed.'))}</p>
    {f"<p><strong>Warnings:</strong></p><ul>{''.join(f'<li>{esc(item)}</li>' for item in content.get('audit_warnings', []))}</ul>" if content.get('audit_warnings') else ''}
    {f"<p><strong>Blocking errors:</strong></p><ul>{''.join(f'<li>{esc(item)}</li>' for item in content.get('audit_blocking_errors', []))}</ul>" if content.get('audit_blocking_errors') else ''}

    <h2>Expected Impact</h2>
    <p><strong>Estimated impact:</strong> {esc(_impact_summary(content.get('impact_low'), content.get('impact_high')))}</p>
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


def marketer(source_context: Dict[str, Any], analysis: Dict[str, Any], strategy: Dict[str, Any], critique: Dict[str, Any], simulation: Dict[str, Any], evaluation: Dict[str, Any], synthesizer_text: str) -> Dict[str, Any]:
    source_value = str(source_context.get("source") or source_context.get("csv_path") or "dataset")
    source_label = Path(source_value).name if source_value else "dataset"
    ingestion_contract = source_context.get("ingestion_contract") or {}
    audit_result = audit_recommendations(ingestion_contract, {"analysis": analysis, "strategy": strategy, "simulation": simulation, "critique": critique, "evaluation": evaluation, "synthesizer_text": synthesizer_text})
    audited_actions = [item for item in audit_result.get("recommendations", []) if not item.get("blocked")]
    if not audited_actions:
        audited_actions = [{"type": "monitor", "action": "No strong budget move recommended yet", "campaign_or_segment": "account baseline", "reason": audit_result.get("user_message", "Recommendation audit blocked unsafe output."), "amount": 0.0, "confidence": "low", "expected_impact": "Hold until the signal improves.", "rollout_plan": "Monitor for 7 days.", "monitoring_window": "7 days", "revert_condition": "Re-evaluate once evidence improves."}]
    audited_strategy = {**strategy, "actions": audited_actions[:3]}
    audited_simulation = simulate_projections(audited_strategy, analysis)
    content = build_marketer_content(source_label, analysis, audited_strategy, critique, audited_simulation, audit_result)
    return {"content": content, "audit_result": audit_result, "final_report_text": render_markdown_report(source_label, content), "final_report_html": render_html_report(source_label, content)}


# Graph/UI helpers and main

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
    parser.add_argument("csv_path", nargs="?", default=str(DEFAULT_INPUT), help="Path to a CSV file")
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
    source = Path(args.csv_path).expanduser().resolve()
    if not source.exists():
        raise SystemExit(f"Missing data file: {source}")

    ingestion = ingest_campaign_export(source)
    contract = build_ingestion_contract(ingestion)
    if not contract.get("ok"):
        print(contract.get("user_message") or format_validation_message(ingestion), file=sys.stderr)
        raise SystemExit(1)

    set_currency_context(ingestion.currency.get("currency_code", "GBP"), ingestion.currency.get("currency_symbol", "£"), ingestion.currency.get("currency_source", "detected"))
    campaigns = [Campaign(**{k: v for k, v in record.items() if k != "campaign_group"}) for record in ingestion.records]
    args.ingestion_contract = contract

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
        marketer_output = marketer({"source": str(source), "ingestion_contract": contract}, analysis, enriched_strategy, critique, simulation, evaluation, "")
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
    if args.audit:
        audit_result = marketer_output.get("audit_result", {}) if isinstance(marketer_output, dict) else {}
        print_section("AUDIT", audit_result)
        print_section("AUDITED RECOMMENDATIONS", audit_result.get("recommendations", []))
    print("\n=== FINAL REPORT ===")
    print(final)
    print("\n=== EVALUATION ===")
    print(evaluation)


if __name__ == "__main__":
    main()
