from __future__ import annotations

import re
from statistics import median
from typing import Any, Dict, List, Optional, Sequence, Tuple

ACTION_NORMALIZATION = {
    "stop": "pause",
    "cut": "reduce",
    "decrease": "reduce",
    "increase": "scale",
    "grow": "scale",
    "move budget": "reallocate",
    "shift budget": "reallocate",
    "experiment": "test",
    "wait": "monitor",
    "no action": "monitor",
}

KNOWN_ACTIONS = {"pause", "reduce", "scale", "reallocate", "test", "monitor"}
CONFIDENCE_ORDER = {"low": 0, "medium": 1, "high": 2}


def _get(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _norm(value: Any) -> str:
    return _text(value).lower().replace("|", " ").replace("  ", " ")


def _parse_budget_value(value: Any) -> Tuple[float, Optional[float]]:
    text = _text(value)
    if not text:
        return 0.0, None
    cleaned = text.replace(",", "")
    match = re.search(r"(-?\d+(?:\.\d+)?)", cleaned)
    if not match:
        return 0.0, None
    parsed = float(match.group(1))
    if "%" in cleaned or "percent" in cleaned.lower():
        return parsed, parsed / 100.0
    if parsed <= 1 and any(token in cleaned.lower() for token in ("move", "budget", "reallocate", "scale", "reduce", "cut")):
        return parsed, parsed
    return parsed, None


def _normalize_action(action: Dict[str, Any]) -> str:
    raw = _norm(action.get("type") or action.get("action"))
    return ACTION_NORMALIZATION.get(raw, raw or "monitor")


def _campaign_label(item: Any) -> str:
    for key in ("campaign_or_segment", "campaign", "campaign_name", "source_campaign", "target_campaign", "from", "to", "segment_name"):
        value = _text(_get(item, key))
        if value:
            return value
    return ""


def _lookup_campaign(campaigns: Sequence[Any], name: str) -> Any:
    target = _norm(name)
    if not target:
        return None
    for campaign in campaigns:
        labels = {
            _norm(_get(campaign, "campaign")),
            _norm(_get(campaign, "campaign_group")),
            _norm(_get(campaign, "segment_name")),
            _norm(_get(campaign, "platform")),
        }
        if target in labels:
            return campaign
    return None


def _metric(campaign: Any, mode: str) -> Optional[float]:
    value = _get(campaign, "cpa") if mode == "cpa" else _get(campaign, "roas")
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _median_metric(campaigns: Sequence[Any], mode: str) -> Optional[float]:
    values = [v for v in (_metric(item, mode) for item in campaigns) if v is not None]
    return float(median(values)) if values else None


def _confidence_cap(ingestion_confidence: str, mode: str, summary: Dict[str, Any]) -> Tuple[str, bool]:
    confidence = _norm(ingestion_confidence) or "low"
    capped = False
    total_spend = float(summary.get("total_spend") or 0.0)
    total_conversions = float(summary.get("total_conversions") or 0.0)
    campaign_count = int(summary.get("campaign_count") or summary.get("segments") or 0)
    low_volume = total_spend < 1000 or total_conversions < 20 or campaign_count < 3

    if confidence == "low":
        confidence = "medium"
        capped = True

    if low_volume and CONFIDENCE_ORDER[confidence] > CONFIDENCE_ORDER["medium"]:
        confidence = "medium"
        capped = True

    if mode == "cpa" and (total_spend < 10000 or total_conversions < 100) and CONFIDENCE_ORDER[confidence] > CONFIDENCE_ORDER["medium"]:
        confidence = "medium"
        capped = True

    return confidence, capped


def _metric_basis(mode: str, value: Optional[float], median_value: Optional[float]) -> str:
    if value is None or median_value is None:
        return f"{mode.upper()} median unavailable"
    return f"CPA {value:.2f} vs median {median_value:.2f}" if mode == "cpa" else f"ROAS {value:.2f} vs median {median_value:.2f}"


def _expected_impact(action_type: str, mode: str) -> str:
    if action_type == "scale":
        return f"Potential {mode.upper()} lift if the signal holds."
    if action_type in {"pause", "reduce"}:
        return "Potential waste reduction if weak performance persists."
    if action_type == "reallocate":
        return "Shift budget toward the stronger campaign."
    if action_type == "test":
        return "Run a controlled test before a larger move."
    return "Monitor before making a budget move."


def _rollout_plan(action_type: str, amount_pct: float) -> str:
    pct = max(0.0, min(amount_pct * 100.0, 30.0))
    if action_type == "scale":
        return f"Roll out in {pct:.0f}% increments over 7–14 days."
    if action_type in {"pause", "reduce"}:
        return f"Apply in a {pct:.0f}% cut, then review after 3–7 days."
    if action_type == "reallocate":
        return f"Move budget in {pct:.0f}% increments, then review after 7–14 days."
    if action_type == "test":
        return "Run a small controlled test for 7 days."
    return "Monitor for 7 days before changing budget."


def _monitor_window(action_type: str) -> str:
    if action_type == "scale":
        return "7–14 days"
    if action_type in {"pause", "reduce"}:
        return "3–7 days"
    if action_type == "reallocate":
        return "7–14 days"
    if action_type == "test":
        return "7 days"
    return "7–14 days"


def _revert_condition(action_type: str, mode: str, median_value: Optional[float]) -> str:
    if median_value is None:
        return "Revert if the change creates instability or lower volume without a clear gain."
    if mode == "cpa":
        if action_type == "scale":
            return f"Revert if CPA rises above {median_value * 1.1:.2f}."
        if action_type in {"pause", "reduce", "reallocate"}:
            return f"Revert if blended CPA rises above {median_value * 1.1:.2f}."
    else:
        if action_type == "scale":
            return f"Revert if ROAS falls below {median_value * 0.9:.2f}."
        if action_type in {"pause", "reduce", "reallocate"}:
            return f"Revert if blended ROAS falls below {median_value * 0.9:.2f}."
    return "Revert if the test degrades the account or shows no improvement."


def _threshold(action_type: str, mode: str, value: Optional[float], median_value: Optional[float], source_value: Optional[float] = None, target_value: Optional[float] = None) -> str:
    if action_type == "reallocate":
        if source_value is None or target_value is None:
            return "unsupported"
        if mode == "roas":
            if target_value >= source_value * 1.2:
                return "strong" if target_value >= source_value * 1.25 else "soft"
            return "weak"
        if target_value <= source_value * 0.8:
            return "strong" if target_value <= source_value * 0.75 else "soft"
        return "weak"

    if value is None or median_value in (None, 0):
        return "unsupported"

    if action_type == "scale":
        if mode == "roas":
            if value >= median_value * 1.2:
                return "strong" if value >= median_value * 1.25 else "soft"
            return "weak"
        if value <= median_value * 0.8:
            return "strong" if value <= median_value * 0.75 else "soft"
        return "weak"

    if action_type in {"pause", "reduce"}:
        if mode == "roas":
            if value <= median_value * 0.8:
                return "strong" if value <= median_value * 0.75 else "soft"
            return "weak"
        if value >= median_value * 1.2:
            return "strong" if value >= median_value * 1.25 else "soft"
        return "weak"

    return "unsupported"


def audit_recommendations(ingestion_contract: Dict[str, Any], decision_output: Dict[str, Any]) -> Dict[str, Any]:
    analysis = decision_output.get("analysis") if isinstance(decision_output.get("analysis"), dict) else {}
    strategy = decision_output.get("strategy") if isinstance(decision_output.get("strategy"), dict) else {}
    if not analysis and isinstance(decision_output, dict):
        analysis = decision_output
    if not strategy:
        strategy = decision_output if isinstance(decision_output, dict) else {}

    campaigns = list(analysis.get("campaigns", []) or [])
    summary = dict(analysis.get("summary", {}) or {})
    if not summary and isinstance(ingestion_contract.get("summary"), dict):
        summary = dict(ingestion_contract.get("summary") or {})

    mode = _norm(ingestion_contract.get("analysis_mode") or summary.get("analysis_mode") or analysis.get("analysis_mode") or "roas")
    if mode not in {"roas", "cpa"}:
        mode = "roas"

    median_value = _median_metric(campaigns, mode)
    total_spend = float(summary.get("total_spend") or 0.0)
    cap, confidence_floor_applied = _confidence_cap(_norm(ingestion_contract.get("confidence") or "low"), mode, summary)
    low_ingestion_conf = _norm(ingestion_contract.get("confidence") or "low") == "low"

    actions = list(strategy.get("actions", []) or [])
    if not actions and isinstance(decision_output.get("actions"), list):
        actions = list(decision_output.get("actions") or [])

    recommendations: List[Dict[str, Any]] = []
    audit_warnings: List[str] = []
    blocking_errors: List[str] = []
    conflicts: List[Dict[str, Any]] = []
    metric_checks: List[Dict[str, Any]] = []
    actions_seen: List[str] = []
    campaigns_seen: List[str] = []
    used_roles: Dict[str, set[str]] = {}
    developer_warnings: List[str] = []
    confidence_warning_emitted = False
    cpa_warning_emitted = False

    def add_conflict(key: str, idx: int, role: str) -> None:
        conflicts.append({"campaign": key, "new_role": role, "action_index": idx})
        blocking_errors.append(f"Recommendation {idx} conflicts with an earlier action for {key}.")

    for idx, raw in enumerate(actions, 1):
        action = dict(raw or {})
        raw_action = _text(action.get("type") or action.get("action"))
        action_type = _normalize_action(action)
        actions_seen.append(action_type)

        unknown_action = bool(raw_action) and raw_action.lower() not in KNOWN_ACTIONS and raw_action.lower() not in ACTION_NORMALIZATION
        if unknown_action:
            audit_warnings.append(f"Unknown action '{raw_action}' was normalised conservatively.")

        reason = _text(action.get("reason"))
        source_name = _text(action.get("from") or action.get("source_campaign"))
        target_name = _text(action.get("to") or action.get("target_campaign"))
        campaign_name = _text(action.get("campaign") or action.get("campaign_or_segment"))
        campaign_or_segment = f"{source_name} → {target_name}" if action_type == "reallocate" else (campaign_name or source_name or target_name)

        if not raw_action:
            blocking_errors.append(f"Recommendation {idx} is missing an action.")
            recommendations.append({
                "action": "monitor",
                "campaign_or_segment": campaign_or_segment or _campaign_label(action),
                "reason": reason or "No action was provided.",
                "metric_basis": "missing",
                "expected_impact": "Blocked because the recommendation is missing an action.",
                "confidence": "low",
                "rollout_plan": "",
                "monitoring_window": "",
                "revert_condition": "",
                "status": "blocked",
                "blocked": True,
                "warnings": ["Missing action."],
            })
            continue

        if not campaign_or_segment:
            blocking_errors.append(f"Recommendation {idx} is missing a campaign or segment.")
            recommendations.append({
                "action": action_type,
                "campaign_or_segment": "",
                "reason": reason or "Campaign or segment was not provided.",
                "metric_basis": "missing",
                "expected_impact": "Blocked because the recommendation is missing a campaign or segment.",
                "confidence": "low",
                "rollout_plan": "",
                "monitoring_window": "",
                "revert_condition": "",
                "status": "blocked",
                "blocked": True,
                "warnings": ["Missing campaign or segment."],
            })
            continue

        if not reason:
            audit_warnings.append(f"Recommendation {idx} is missing a reason; the formatter should fill it.")

        if action_type == "reallocate" and _norm(source_name) == _norm(target_name) and source_name:
            blocking_errors.append(f"Recommendation {idx} uses the same campaign as both source and destination.")
            conflicts.append({"campaign": source_name, "new_role": "reallocate", "action_index": idx})
            recommendations.append({
                "action": action_type,
                "campaign_or_segment": campaign_or_segment,
                "reason": reason or "No reason provided.",
                "metric_basis": _metric_basis(mode, None, median_value),
                "expected_impact": "Blocked because the source and destination are identical.",
                "confidence": "low",
                "rollout_plan": "",
                "monitoring_window": "",
                "revert_condition": "",
                "status": "blocked",
                "blocked": True,
                "warnings": ["Source and destination are identical."],
            })
            continue

        source_campaign = _lookup_campaign(campaigns, source_name or campaign_or_segment)
        target_campaign = _lookup_campaign(campaigns, target_name or campaign_or_segment)
        primary_campaign = source_campaign if action_type in {"pause", "reduce"} else target_campaign or source_campaign
        source_value = _metric(source_campaign, mode)
        target_value = _metric(target_campaign, mode)
        primary_value = _metric(primary_campaign, mode)
        threshold = _threshold(action_type, mode, primary_value, median_value, source_value, target_value)
        metric_checks.append({
            "campaign_or_segment": campaign_or_segment,
            "action": action_type,
            "mode": mode,
            "metric_value": primary_value,
            "median": median_value,
            "threshold": threshold,
        })

        final_type = action_type
        warnings: List[str] = []
        material_warning = False

        required_fields = ("metric_basis", "expected_impact", "confidence", "rollout_plan", "monitoring_window", "revert_condition")
        for field in required_fields:
            if not _text(action.get(field)):
                developer_warnings.append(f"Filled missing {field} for {campaign_or_segment or raw_action or 'unspecified recommendation'}.")

        if threshold == "weak" and action_type in {"scale", "pause", "reduce", "reallocate"}:
            final_type = "test" if action_type in {"scale", "reallocate"} else "monitor"
            warnings.append("Weak evidence downgraded the recommendation.")
            audit_warnings.append(f"Downgraded {campaign_or_segment} because the performance gap was too small.")
            material_warning = True
        elif threshold == "soft":
            warnings.append("Evidence is only marginally above the threshold.")
            material_warning = True
        elif threshold == "unsupported" and action_type in {"scale", "pause", "reduce", "reallocate"}:
            final_type = "test" if action_type in {"scale", "reallocate"} else "monitor"
            warnings.append("Metric comparison was incomplete, so the action was downgraded.")
            material_warning = True

        outlier = False
        if primary_value is not None and median_value not in (None, 0):
            ratio = primary_value / median_value
            outlier = ratio >= 5 or ratio <= 0.2
        if outlier and final_type == "scale":
            final_type = "test"
            warnings.append("Outlier handling converted aggressive scaling into a test-only move.")
            audit_warnings.append(f"Outlier handling applied to {campaign_or_segment}; aggressive scaling was disallowed.")
            material_warning = True

        amount, parsed_pct = _parse_budget_value(action.get("amount"))
        movement_percent = action.get("budget_movement_percent")
        if movement_percent is None and parsed_pct is not None:
            movement_percent = parsed_pct * 100.0 if parsed_pct <= 1 else parsed_pct
        if movement_percent is None:
            _, action_pct = _parse_budget_value(action.get("action"))
            if action_pct is not None:
                movement_percent = action_pct * 100.0 if action_pct <= 1 else action_pct
        if isinstance(movement_percent, str):
            _, parsed_ratio = _parse_budget_value(movement_percent)
            movement_percent = parsed_ratio if parsed_ratio is not None else None
        movement_pct = None
        if movement_percent is not None:
            try:
                movement_pct = float(movement_percent) / 100.0 if float(movement_percent) > 1 else float(movement_percent)
            except (TypeError, ValueError):
                movement_pct = None
        relevant_spend = float(_get(source_campaign, "spend") or _get(target_campaign, "spend") or total_spend or 0.0)
        max_allowed = 0.30
        if outlier:
            max_allowed = min(max_allowed, 0.15)
        if movement_pct is not None and movement_pct > max_allowed:
            warnings.append(f"Budget movement capped from {movement_pct * 100:.0f}% to {max_allowed * 100:.0f}%.")
            audit_warnings.append(f"Capped {campaign_or_segment} budget movement above {max_allowed * 100:.0f}%.")
            movement_pct = max_allowed
            amount = round(total_spend * movement_pct if total_spend else relevant_spend * movement_pct, 2)
            material_warning = True
        elif total_spend > 0 and amount > total_spend * 0.30:
            new_amount = round(total_spend * 0.30, 2)
            warnings.append(f"Budget movement capped from {amount:.2f} to {new_amount:.2f}.")
            audit_warnings.append(f"Capped {campaign_or_segment} budget movement above 30%.")
            amount = new_amount
            material_warning = True
        elif relevant_spend > 0 and amount > relevant_spend * 0.30:
            new_amount = round(relevant_spend * 0.30, 2)
            warnings.append(f"Budget movement capped from {amount:.2f} to {new_amount:.2f}.")
            audit_warnings.append(f"Capped {campaign_or_segment} budget movement to 30% of the relevant campaign spend.")
            amount = new_amount
            material_warning = True

        confidence = _norm(action.get("confidence") or ("high" if threshold == "strong" and final_type in {"scale", "pause", "reduce", "reallocate"} else "medium" if final_type in {"scale", "pause", "reduce", "reallocate"} else "low"))
        if low_ingestion_conf and confidence == "high":
            confidence = "medium"
            confidence_floor_applied = True
            if not confidence_warning_emitted:
                audit_warnings.append("Low ingestion confidence capped recommendation confidence.")
                confidence_warning_emitted = True
            material_warning = True
        if mode == "cpa" and confidence == "high":
            confidence = "medium"
            confidence_floor_applied = True
            if not cpa_warning_emitted:
                audit_warnings.append("CPA-only mode capped recommendation confidence.")
                cpa_warning_emitted = True
            material_warning = True
        if total_spend < 1000 or float(summary.get("total_conversions") or 0.0) < 20:
            if confidence == "high":
                confidence = "medium"
                confidence_floor_applied = True
                warnings.append("Low volume capped the recommendation confidence.")
                material_warning = True
        if final_type == "monitor":
            confidence = "low"
        elif final_type == "test" and confidence == "high":
            confidence = "medium"
            confidence_floor_applied = True

        rollout_plan = _text(action.get("rollout_plan")) or _rollout_plan(final_type, amount / total_spend if total_spend else 0.0)
        monitoring_window = _text(action.get("monitoring_window")) or _monitor_window(final_type)
        revert_condition = _text(action.get("revert_condition")) or _revert_condition(final_type, mode, median_value)

        role_entries: List[Tuple[str, str]] = []
        if final_type == "reallocate":
            role_entries = [(_norm(source_name), "source"), (_norm(target_name), "destination")]
        elif final_type in {"pause", "reduce"}:
            role_entries = [(_norm(campaign_or_segment), "remove")]
        elif final_type == "scale":
            role_entries = [(_norm(campaign_or_segment), "scale")]
        elif final_type == "test":
            role_entries = [(_norm(campaign_or_segment), "test")]
        else:
            role_entries = [(_norm(campaign_or_segment), "monitor")]

        conflict = False
        for key, role in role_entries:
            if not key:
                continue
            existing = used_roles.setdefault(key, set())
            if role == "destination":
                existing.add(role)
                continue
            if role == "scale" and existing.intersection({"source", "remove", "test", "pause"}):
                conflict = True
            elif role in {"remove", "pause"} and existing.intersection({"scale", "test"}):
                conflict = True
            elif role == "test" and existing.intersection({"scale", "pause", "remove"}):
                conflict = True
            existing.add(role)

        if conflict:
            add_conflict(campaign_or_segment, idx, final_type)
            recommendations.append({
                "action": final_type,
                "campaign_or_segment": campaign_or_segment,
                "source_campaign": source_name or campaign_or_segment,
                "target_campaign": target_name or campaign_or_segment,
                "reason": reason,
                "metric_basis": _metric_basis(mode, primary_value, median_value),
                "expected_impact": _expected_impact(final_type, mode),
                "confidence": confidence,
                "rollout_plan": rollout_plan,
                "monitoring_window": monitoring_window,
                "revert_condition": revert_condition,
                "amount": round(amount, 2),
                "metric_value": primary_value,
                "metric_median": median_value,
                "metric_threshold": threshold,
                "status": "blocked",
                "blocked": True,
                "warnings": warnings + ["Conflicting actions were detected for the same campaign or segment."],
            })
            continue

        if campaign_or_segment:
            campaigns_seen.append(campaign_or_segment)

        recommendations.append({
            "action": final_type,
            "campaign_or_segment": campaign_or_segment,
            "source_campaign": source_name or campaign_or_segment,
            "target_campaign": target_name or campaign_or_segment,
            "reason": reason,
            "metric_basis": _metric_basis(mode, primary_value, median_value),
            "expected_impact": _expected_impact(final_type, mode),
            "confidence": confidence,
            "rollout_plan": rollout_plan,
            "monitoring_window": monitoring_window,
            "revert_condition": revert_condition,
            "amount": round(amount, 2),
            "metric_value": primary_value,
            "metric_median": median_value,
            "metric_threshold": threshold,
            "status": "warning" if material_warning else "pass",
            "blocked": False,
            "warnings": warnings,
        })

    recommendation_count = len(recommendations)
    blocked_count = sum(1 for item in recommendations if item.get("blocked"))
    warning_count = sum(1 for item in recommendations if item.get("status") == "warning")
    max_budget_movement = None
    if recommendations:
        if total_spend > 0:
            max_budget_movement = max(float(item.get("amount") or 0.0) / total_spend for item in recommendations)
        else:
            max_budget_movement = max(float(item.get("amount") or 0.0) for item in recommendations)

    if blocking_errors:
        status = "blocked"
        ok = False
        user_message = "Recommendation audit blocked unsafe output."
    elif audit_warnings or warning_count:
        status = "warning"
        ok = True
        user_message = "Recommendation audit applied safeguards and warnings."
    else:
        status = "pass"
        ok = True
        user_message = "Recommendation audit passed."

    if not recommendations and not blocking_errors:
        audit_warnings.append("No recommendations were provided; the audit layer recommends monitoring only.")
        status = "warning"
        ok = True
        user_message = "No strong budget move recommended yet."

    return {
        "ok": ok,
        "status": status,
        "user_message": user_message or "Recommendation audit passed.",
        "recommendations": recommendations,
        "audit_warnings": audit_warnings,
        "blocking_errors": blocking_errors,
        "summary": {
            "recommendation_count": recommendation_count,
            "blocked_count": blocked_count,
            "warning_count": warning_count,
            "max_budget_movement": max_budget_movement,
            "confidence_floor_applied": confidence_floor_applied,
        },
        "debug": {
            "actions_seen": actions_seen,
            "campaigns_seen": list(dict.fromkeys(campaigns_seen)),
            "conflicts": conflicts,
            "metric_threshold_checks": metric_checks,
            "developer_warnings": developer_warnings,
        },
    }
