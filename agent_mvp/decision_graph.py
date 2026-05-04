from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Sequence


@dataclass
class DecisionGraphState:
    currency_code: str = "GBP"
    currency_symbol: str = "£"
    profile: Dict[str, Any] | None = None
    normalized_data: Dict[str, Any] | None = None
    analyst_output: Dict[str, Any] | None = None
    strategist_initial_output: Dict[str, Any] | None = None
    critic_output: Dict[str, Any] | None = None
    strategist_refined_output: Dict[str, Any] | None = None
    synthesizer_output: str | None = None
    evaluation_output: Dict[str, Any] | None = None
    marketer_output: Dict[str, Any] | None = None
    final_report_text: str | None = None
    warnings: List[str] = field(default_factory=list)
    confidence: str = "high"
    trace: List[str] = field(default_factory=list)
    enriched_strategy: Dict[str, Any] | None = None
    simulation: Dict[str, Any] | None = None


class DecisionGraph:
    def __init__(
        self,
        *,
        profile_interpreter: Callable[[Sequence[Any], Any], Dict[str, Any]],
        analyst: Callable[[Sequence[Any], Dict[str, Any]], Dict[str, Any]],
        strategist_initial: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
        critic: Callable[[Dict[str, Any], Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
        strategist_refinement: Callable[[Dict[str, Any], Dict[str, Any], Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
        enrich_decisions: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
        simulate_projections: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
        synthesizer: Callable[[Dict[str, Any], Dict[str, Any], Dict[str, Any], Dict[str, Any]], str],
        evaluate_output: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
        marketer: Callable[[Dict[str, Any], Dict[str, Any], Dict[str, Any], Dict[str, Any], Dict[str, Any], Dict[str, Any], str], Dict[str, Any]] | None = None,
    ):
        self.profile_interpreter = profile_interpreter
        self.analyst = analyst
        self.strategist_initial = strategist_initial
        self.critic = critic
        self.strategist_refinement = strategist_refinement
        self.enrich_decisions = enrich_decisions
        self.simulate_projections = simulate_projections
        self.synthesizer = synthesizer
        self.evaluate_output = evaluate_output
        self.marketer = marketer

    @staticmethod
    def _is_low_data_quality(analysis: Dict[str, Any]) -> bool:
        summary = analysis.get("summary", {}) if isinstance(analysis, dict) else {}
        if not isinstance(summary, dict):
            return True

        if summary.get("campaign_count", 0) < 3:
            return True
        if not summary.get("revenue_available", False):
            return True
        if summary.get("total_conversions", 0) <= 0:
            return True
        return False

    def run(self, campaigns: Sequence[Any], args: Any) -> DecisionGraphState:
        state = DecisionGraphState()
        state.trace.append("Profile Interpreter")
        state.profile = self.profile_interpreter(campaigns, args)
        state.currency_code = str((state.profile or {}).get("currency_code") or "GBP")
        state.currency_symbol = str((state.profile or {}).get("currency_symbol") or "£")
        state.normalized_data = {
            "campaign_count": len(campaigns),
            "source": getattr(args, "csv_path", None),
            "mode": "graph",
            "currency_code": state.currency_code,
            "currency_symbol": state.currency_symbol,
            "account_context": (state.profile or {}).get("account_context"),
            "decision_rules": (state.profile or {}).get("decision_rules", []),
        }

        state.trace.append("Analyst")
        state.analyst_output = self.analyst(campaigns, state.profile)

        state.trace.append("Strategist Initial")
        state.strategist_initial_output = self.strategist_initial(state.analyst_output, state.profile)

        state.trace.append("Critic")
        state.critic_output = self.critic(state.analyst_output, state.strategist_initial_output, state.profile)

        state.trace.append("Strategist Refinement")
        state.strategist_refined_output = self.strategist_refinement(
            state.analyst_output,
            state.strategist_initial_output,
            state.critic_output,
            state.profile,
        )

        state.trace.append("Synthesizer")
        state.enriched_strategy = self.enrich_decisions(state.strategist_refined_output, state.analyst_output)
        state.simulation = self.simulate_projections(state.enriched_strategy, state.analyst_output)
        state.synthesizer_output = self.synthesizer(state.analyst_output, state.enriched_strategy, state.critic_output, state.simulation)

        state.trace.append("Evaluation")
        state.evaluation_output = self.evaluate_output(state.enriched_strategy, state.critic_output)

        if self._is_low_data_quality(state.analyst_output):
            state.confidence = "low"
            state.warnings.append("Data quality is low; treat the recommendations as directional rather than definitive.")
        else:
            state.confidence = "high"

        if isinstance(state.evaluation_output, dict):
            state.evaluation_output["confidence"] = state.confidence
            if state.warnings:
                state.evaluation_output["warnings"] = list(state.warnings)

        state.trace.append("Marketer")
        if self.marketer is not None:
            state.marketer_output = self.marketer(
                state.normalized_data or {},
                state.analyst_output or {},
                state.enriched_strategy or {},
                state.critic_output or {},
                state.simulation or {},
                state.evaluation_output or {},
                state.synthesizer_output or "",
            )
            if isinstance(state.marketer_output, dict):
                state.final_report_text = state.marketer_output.get("final_report_text")
        else:
            state.marketer_output = {"final_report_text": state.synthesizer_output or ""}
            state.final_report_text = state.synthesizer_output or ""

        return state
