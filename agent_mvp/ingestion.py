from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

FIELD_ALIASES = {
    "campaign_name": ["campaign name", "campaign_name", "campaign", "campaignname", "campaign group"],
    "platform": ["platform", "channel", "network"],
    "campaign_type": ["campaign_type", "campaign type", "objective"],
    "country": ["country", "geo", "market", "location", "region"],
    "ad_group": ["ad_group", "ad group", "adset", "ad set", "ad set name", "adset_name", "ad_set_name"],
    "ad_set_name": ["ad_set_name", "ad set name", "adset_name", "adset", "ad group", "ad_group"],
    "ad_name": ["ad_name", "ad name", "creative", "ad"],
    "keyword": ["keyword", "keywords"],
    "search_term": ["search term", "search_term", "search terms"],
    "device": ["device"],
    "spend": [
        "amount spent",
        "amount spent gbp",
        "amount spent usd",
        "amount_spent",
        "cost micros",
        "cost micros gbp",
        "cost micros usd",
        "cost gbp",
        "cost usd",
        "cost",
        "spend",
        "monthly spend gbp",
        "ad spend",
    ],
    "clicks": ["link clicks", "outbound clicks", "clicks", "landing page views"],
    "impressions": ["impressions", "impr"],
    "conversions": ["purchases", "website purchases", "leads", "actions", "conversions", "conversion", "results", "all conversions", "purchase conversion count", "purchase"],
    "revenue": [
        "purchase conversion value",
        "purchases conversion value",
        "website purchases conversion value",
        "total conversion value",
        "conversion value",
        "conv value",
        "revenue",
        "revenue gbp",
        "conversion_value",
        "conv_value",
        "purchase_value",
        "purchases_conversion_value",
        "website_purchase_value",
        "purchase_value_gbp",
    ],
    "currency": ["currency", "currency_code", "currency_symbol"],
}

GOOGLE_SIGNAL_FIELDS = {"cost", "cost_micros", "conversions", "conversion_value", "conv_value", "ad_group", "keyword", "search_term", "device", "impr"}
META_SIGNAL_FIELDS = {"amount_spent", "results", "purchases", "purchase_value", "purchase_conversion_value", "conversion_value", "ad_set_name", "ad_name", "link_clicks", "outbound_clicks"}
GENERIC_SIGNAL_FIELDS = {"platform", "campaign_type", "campaign_name", "country", "spend", "conversions", "revenue"}

STRATEGY_ORDER = [
    ("campaign_name", ("campaign_name",)),
    ("campaign_name + ad_group", ("campaign_name", "ad_group")),
    ("campaign_name + keyword", ("campaign_name", "keyword")),
    ("campaign_name + search_term", ("campaign_name", "search_term")),
    ("campaign_name + device", ("campaign_name", "device")),
    ("campaign_name + ad_set_name", ("campaign_name", "ad_set_name")),
    ("campaign_name + ad_name", ("campaign_name", "ad_name")),
    ("campaign_name + country", ("campaign_name", "country")),
    ("campaign_name + campaign_type", ("campaign_name", "campaign_type")),
]

CURRENCY_MAP = {
    "gbp": ("GBP", "£"),
    "usd": ("USD", "$"),
    "eur": ("EUR", "€"),
}

EMPTY_VALUES = {"", "-", "n/a", "na", "none", "null", ""}


@dataclass
class IngestionIssue:
    code: str
    message: str
    detail: str = ""
    severity: str = "error"


@dataclass
class IngestionResult:
    path: Path
    raw_rows: List[Dict[str, str]] = field(default_factory=list)
    records: List[Dict[str, Any]] = field(default_factory=list)
    field_mapping: Dict[str, Optional[str]] = field(default_factory=dict)
    currency: Dict[str, str] = field(default_factory=dict)
    platform: Dict[str, str] = field(default_factory=dict)
    analysis_mode: str = ""
    segment_strategy: Dict[str, Any] = field(default_factory=dict)
    issues: List[IngestionIssue] = field(default_factory=list)
    warnings: List[IngestionIssue] = field(default_factory=list)
    summary: Dict[str, Any] = field(default_factory=dict)
    debug: Dict[str, Any] = field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)

    def to_contract(self) -> Dict[str, Any]:
        return build_ingestion_contract(self)


@dataclass
class _NormalizedRow:
    raw: Dict[str, str]
    values: Dict[str, Any]


@dataclass
class _SegmentStrategyResult:
    name: str
    fields: Tuple[str, ...]
    segment_labels: List[str]
    segment_count: int
    segment_samples: List[str]
    coverage: float


@dataclass
class _SegmentAggregate:
    segment_name: str
    campaign_name: str = ""
    platform: str = ""
    campaign_type: str = ""
    country: str = ""
    ad_group: str = ""
    ad_set_name: str = ""
    ad_name: str = ""
    keyword: str = ""
    search_term: str = ""
    device: str = ""
    spend: float = 0.0
    clicks: int = 0
    impressions: int = 0
    conversions: int = 0
    revenue: Optional[float] = None
    revenue_missing: bool = True
    raw_rows: List[Dict[str, str]] = field(default_factory=list)

    def merge(self, row: _NormalizedRow) -> None:
        values = row.values
        self.raw_rows.append(row.raw)
        self.spend += float(values.get("spend") or 0.0)
        self.clicks += int(values.get("clicks") or 0)
        self.impressions += int(values.get("impressions") or 0)
        self.conversions += int(values.get("conversions") or 0)

        revenue = values.get("revenue")
        if revenue is not None:
            self.revenue = (self.revenue or 0.0) + float(revenue)
            self.revenue_missing = False

        for field in ("campaign_name", "platform", "campaign_type", "country", "ad_group", "ad_set_name", "ad_name", "keyword", "search_term", "device"):
            current = getattr(self, field)
            incoming = str(values.get(field) or "").strip()
            if not current and incoming:
                setattr(self, field, incoming)

    def as_record(self) -> Dict[str, Any]:
        return {
            "campaign": self.segment_name,
            "platform": self.platform,
            "campaign_type": self.campaign_type,
            "industry": "",
            "country": self.country,
            "ad_set": self.ad_set_name or self.ad_group,
            "ad": self.ad_name,
            "spend": self.spend,
            "impressions": self.impressions,
            "clicks": self.clicks,
            "conversions": self.conversions,
            "revenue": self.revenue,
            "raw_ctr": _safe_ratio(self.clicks, self.impressions),
            "raw_cpc": _safe_ratio(self.spend, self.clicks),
            "raw_cpa": _safe_ratio(self.spend, self.conversions),
            "raw_roas": _safe_ratio(self.revenue, self.spend) if self.revenue is not None else None,
            "raw": {
                "segment_strategy": self.segment_name,
                "segment_rows": str(len(self.raw_rows)),
                "segment_revenue_missing": str(self.revenue_missing).lower(),
            },
        }


CURRENCY_SUFFIXES = {"gbp", "usd", "eur", "aud", "cad", "sgd", "nzd", "jpy", "sek", "nok", "dkk", "chf", "zar"}
HEADER_PARENS_RE = re.compile(r"\([^)]*\)")
HEADER_SEPARATORS_RE = re.compile(r"[^a-z0-9]+")


def _normalize_header(value: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = HEADER_PARENS_RE.sub(" ", text)
    text = text.replace("&", " and ")
    text = HEADER_SEPARATORS_RE.sub(" ", text)
    tokens = [token for token in text.split() if token not in CURRENCY_SUFFIXES]
    return " ".join(tokens).strip()


def _clean_key(value: str) -> str:
    return _normalize_header(value).replace(" ", "_")


def _find_column(fieldnames: Sequence[str], aliases: Sequence[str]) -> Optional[str]:
    normalized = {_clean_key(name): name for name in fieldnames if _clean_key(name)}
    for alias in aliases:
        key = _clean_key(alias)
        if key and key in normalized:
            return normalized[key]
    return None


def _find_all_columns(fieldnames: Sequence[str], aliases: Sequence[str]) -> List[str]:
    normalized = {_clean_key(name): name for name in fieldnames if _clean_key(name)}
    found = []
    for alias in aliases:
        key = _clean_key(alias)
        if key in normalized:
            found.append(normalized[key])
    return found


def _read_text(path: Path) -> str:
    last_error: Exception | None = None
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError as error:
            last_error = error
        except OSError:
            raise
    raise UnicodeDecodeError("utf-8", b"", 0, 1, f"Unable to decode CSV: {last_error}")


def clean_numeric(value: Any, *, micros: bool = False) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text or _clean_key(text) in EMPTY_VALUES:
        return None
    if text == "-":
        return None
    cleaned = text.replace(",", "")
    cleaned = cleaned.replace("£", "").replace("$", "").replace("€", "")
    cleaned = cleaned.replace("%", "")
    cleaned = cleaned.replace("x", "")
    cleaned = cleaned.replace("X", "")
    cleaned = cleaned.replace(" ", "")
    cleaned = re.sub(r"[^0-9.\-]+", "", cleaned)
    if cleaned in {"", ".", "-", "-."}:
        return None
    try:
        parsed = float(cleaned)
    except ValueError:
        return None
    if micros:
        parsed /= 1_000_000
    return parsed


def _safe_ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or denominator in (None, 0, 0.0):
        return None
    return numerator / denominator


def _safe_count(value: Any) -> Optional[int]:
    parsed = clean_numeric(value)
    if parsed is None:
        return None
    return int(round(parsed))


def _text_value(row: Dict[str, str], column: Optional[str]) -> str:
    if not column:
        return ""
    return str(row.get(column, "") or "").strip()


def _is_present(value: str) -> bool:
    return bool(value and _clean_key(value) not in EMPTY_VALUES)


def _detect_currency(fieldnames: Sequence[str], rows: Sequence[Dict[str, str]]) -> Dict[str, str]:
    header_hints = [
        ("GBP", "£", hdr) for hdr in fieldnames if "gbp" in _clean_key(hdr) or "£" in str(hdr)
    ] + [
        ("USD", "$", hdr) for hdr in fieldnames if "usd" in _clean_key(hdr) or "$" in str(hdr)
    ] + [
        ("EUR", "€", hdr) for hdr in fieldnames if "eur" in _clean_key(hdr) or "€" in str(hdr)
    ]
    if header_hints:
        code, symbol, source = header_hints[0]
        return {"currency_code": code, "currency_symbol": symbol, "currency_source": f"header:{source}"}

    currency_column = _find_column(fieldnames, FIELD_ALIASES["currency"])
    if currency_column:
        for row in rows:
            raw = _text_value(row, currency_column).lower()
            if not raw:
                continue
            if raw in CURRENCY_MAP:
                code, symbol = CURRENCY_MAP[raw]
                return {"currency_code": code, "currency_symbol": symbol, "currency_source": f"column:{currency_column}"}
            if raw in {"£", "$", "€"}:
                reverse = {symbol: code for code, symbol in CURRENCY_MAP.values()}
                code = reverse.get(raw, "GBP")
                return {"currency_code": code, "currency_symbol": raw, "currency_source": f"column:{currency_column}"}
            for code_key, (code, symbol) in CURRENCY_MAP.items():
                if code_key in raw or code.lower() in raw or symbol in raw:
                    return {"currency_code": code, "currency_symbol": symbol, "currency_source": f"column:{currency_column}"}

    for row in rows[:10]:
        joined = " ".join(str(v or "") for v in row.values())
        lower = joined.lower()
        if "€" in joined or "eur" in lower:
            return {"currency_code": "EUR", "currency_symbol": "€", "currency_source": "sample-data"}
        if "$" in joined or "usd" in lower:
            return {"currency_code": "USD", "currency_symbol": "$", "currency_source": "sample-data"}
        if "£" in joined or "gbp" in lower:
            return {"currency_code": "GBP", "currency_symbol": "£", "currency_source": "sample-data"}

    return {"currency_code": "GBP", "currency_symbol": "£", "currency_source": "default"}


def _detect_platform(fieldnames: Sequence[str], mapping: Optional[Dict[str, Optional[str]]] = None) -> Dict[str, str]:
    lower = {_clean_key(name) for name in fieldnames}
    mapping = mapping or _map_columns(fieldnames)

    generic_hits = sum(1 for key in ("platform", "campaign_type", "campaign_name", "country", "spend", "conversions", "revenue") if mapping.get(key))
    google_specific = any(key in lower for key in ("cost_micros", "cost", "keyword", "search_term", "device", "ad_group", "ad group"))
    meta_specific = any(key in lower for key in ("amount_spent", "amount spent", "results", "purchases", "purchase_value", "purchase value", "ad_set_name", "ad set name", "ad_name", "ad name"))
    has_core_metrics = bool(mapping.get("spend") and mapping.get("conversions"))

    if google_specific and has_core_metrics:
        confidence = "high" if any(mapping.get(key) for key in ("ad_group", "keyword", "search_term", "device")) else "medium"
        return {"platform": "google_ads", "confidence": confidence, "signals": ", ".join(sorted(lower & GOOGLE_SIGNAL_FIELDS))}

    if meta_specific and has_core_metrics:
        confidence = "high" if any(mapping.get(key) for key in ("ad_set_name", "ad_name")) else "medium"
        return {"platform": "meta_ads", "confidence": confidence, "signals": ", ".join(sorted(lower & META_SIGNAL_FIELDS))}

    if generic_hits >= 4:
        confidence = "high" if generic_hits >= 6 else "medium"
        return {"platform": "structured_generic", "confidence": confidence, "signals": ", ".join(sorted(lower & GENERIC_SIGNAL_FIELDS))}

    return {"platform": "unknown", "confidence": "low", "signals": ""}


def _map_columns(fieldnames: Sequence[str]) -> Dict[str, Optional[str]]:
    return {logical: _find_column(fieldnames, aliases) for logical, aliases in FIELD_ALIASES.items()}


def _mapping_confidence(mapping: Dict[str, Optional[str]], platform: Dict[str, str]) -> str:
    direct_hits = sum(1 for key in ("campaign_name", "spend", "clicks", "impressions", "conversions", "revenue") if mapping.get(key))
    if direct_hits >= 4 and platform.get("platform") != "unknown":
        return "high"
    if direct_hits >= 3:
        return "medium"
    return "low"


def _normalize_row(row: Dict[str, str], mapping: Dict[str, Optional[str]], spend_is_micros: bool) -> Tuple[_NormalizedRow, List[IngestionIssue]]:
    issues: List[IngestionIssue] = []

    def parse_text(name: str) -> str:
        return _text_value(row, mapping.get(name))

    def parse_number(name: str, *, micros: bool = False, allow_negative: bool = False, count: bool = False) -> Optional[float | int]:
        raw = _text_value(row, mapping.get(name))
        if not _is_present(raw):
            return None
        parsed = _safe_count(raw) if count else clean_numeric(raw, micros=micros)
        if parsed is None:
            issues.append(IngestionIssue("invalid_numeric", f"The {name} column contains a value Gnomeo could not parse.", f"Sample value: {raw}"))
            return None
        if parsed < 0 and not allow_negative:
            issues.append(IngestionIssue("negative_numeric", f"The {name} column contains a negative value, which Gnomeo cannot use.", f"Sample value: {raw}"))
            return None
        return parsed

    campaign_name = parse_text("campaign_name")
    platform = parse_text("platform")
    campaign_type = parse_text("campaign_type")
    country = parse_text("country")
    ad_group = parse_text("ad_group")
    ad_set_name = parse_text("ad_set_name")
    ad_name = parse_text("ad_name")
    keyword = parse_text("keyword")
    search_term = parse_text("search_term")
    device = parse_text("device")

    normalized = {
        "campaign_name": campaign_name,
        "platform": platform,
        "campaign_type": campaign_type,
        "country": country,
        "ad_group": ad_group,
        "ad_set_name": ad_set_name or ad_group,
        "ad_name": ad_name,
        "keyword": keyword,
        "search_term": search_term,
        "device": device,
        "spend": parse_number("spend", micros=spend_is_micros),
        "clicks": parse_number("clicks", count=True),
        "impressions": parse_number("impressions", count=True),
        "conversions": parse_number("conversions", count=True),
        "revenue": parse_number("revenue"),
        "raw_spend": _text_value(row, mapping.get("spend")),
        "raw_clicks": _text_value(row, mapping.get("clicks")),
        "raw_impressions": _text_value(row, mapping.get("impressions")),
        "raw_conversions": _text_value(row, mapping.get("conversions")),
        "raw_revenue": _text_value(row, mapping.get("revenue")),
        "raw": dict(row),
    }

    return _NormalizedRow(raw=dict(row), values=normalized), issues


def _segment_value(row: Dict[str, Any], field: str) -> str:
    value = str(row.get(field, "") or "").strip()
    if _is_present(value):
        return value
    return ""


def _build_segment_label(row: Dict[str, Any], fields: Sequence[str]) -> str:
    parts = [_segment_value(row, field) for field in fields]
    parts = [part for part in parts if part]
    if parts:
        return " | ".join(parts)
    return "Unassigned segment"


def _score_strategy(rows: Sequence[_NormalizedRow], name: str, fields: Sequence[str]) -> _SegmentStrategyResult:
    labels = [_build_segment_label(row.values, fields) for row in rows]
    labels_no_unassigned = [label for label in labels if label != "Unassigned segment"]
    segment_labels = sorted(set(labels_no_unassigned))
    coverage = (len(labels_no_unassigned) / len(rows)) if rows else 0.0
    return _SegmentStrategyResult(
        name=name,
        fields=tuple(fields),
        segment_labels=segment_labels,
        segment_count=len(segment_labels),
        segment_samples=segment_labels[:3],
        coverage=coverage,
    )


def _choose_strategy(rows: Sequence[_NormalizedRow], platform: Dict[str, str]) -> Optional[_SegmentStrategyResult]:
    if not rows:
        return None

    if platform.get("platform") == "google_ads":
        ordered = STRATEGY_ORDER[:5] + [STRATEGY_ORDER[7], STRATEGY_ORDER[8]]
    elif platform.get("platform") == "meta_ads":
        ordered = STRATEGY_ORDER[:1] + STRATEGY_ORDER[5:7] + STRATEGY_ORDER[7:]
    else:
        ordered = STRATEGY_ORDER

    candidates = [_score_strategy(rows, name, fields) for name, fields in ordered]
    for candidate in candidates:
        if candidate.segment_count >= 3:
            return candidate
    return None


def _aggregate_rows(rows: Sequence[_NormalizedRow], strategy: _SegmentStrategyResult) -> List[Dict[str, Any]]:
    buckets: Dict[str, _SegmentAggregate] = {}
    for row in rows:
        segment_name = _build_segment_label(row.values, strategy.fields)
        bucket = buckets.get(segment_name)
        if bucket is None:
            bucket = _SegmentAggregate(segment_name=segment_name)
            buckets[segment_name] = bucket
        bucket.merge(row)

    return [bucket.as_record() for bucket in sorted(buckets.values(), key=lambda item: item.spend, reverse=True)]


def _evaluate_validation(
    result: IngestionResult,
    normalized_rows: Sequence[_NormalizedRow],
    strategy: Optional[_SegmentStrategyResult],
) -> None:
    rows = list(normalized_rows)
    total_spend = sum(float(row.values.get("spend") or 0.0) for row in rows)
    total_conversions = sum(int(row.values.get("conversions") or 0) for row in rows)
    revenue_present = any(row.values.get("revenue") is not None for row in rows)
    click_present = any(int(row.values.get("clicks") or 0) > 0 for row in rows)
    impression_present = any(int(row.values.get("impressions") or 0) > 0 for row in rows)
    segment_spend_count = sum(1 for record in result.records if float(record.get("spend") or 0.0) > 0)

    if total_spend <= 0:
        result.issues.append(IngestionIssue("zero_spend", "The export contains no spend, so Gnomeo cannot rank campaigns."))
    if segment_spend_count == 1:
        result.issues.append(IngestionIssue("single_spend_bucket", "Only one comparable segment contains spend, so Gnomeo cannot compare budget options."))
    if not revenue_present and total_conversions <= 0:
        result.issues.append(IngestionIssue("no_signal", "The export does not contain usable performance signals.", "Gnomeo needs at least conversions or revenue alongside spend."))
    if strategy is None:
        result.issues.append(IngestionIssue("insufficient_segmentation", "The export is not meaningfully segmented.", "No consistent segmentation strategy produced at least 3 comparable segments."))
    elif strategy.segment_count < 3:
        result.issues.append(IngestionIssue("insufficient_segmentation", "The export is not meaningfully segmented.", "Gnomeo needs at least 3 comparable segments before it can generate decisions."))

    if result.summary.get("segment_count") == 1:
        result.issues.append(IngestionIssue("single_bucket", "The export only contains one aggregated bucket.", "Add more segments or export a more granular report."))

    if total_spend < 1000:
        result.warnings.append(IngestionIssue("low_spend", "Low total spend may make the recommendations less stable.", severity="warning"))
    if total_conversions < 20:
        result.warnings.append(IngestionIssue("low_conversion_volume", "Low conversion volume may make the recommendations less stable.", severity="warning"))
    if strategy is not None and strategy.segment_count == 3:
        result.warnings.append(IngestionIssue("exactly_three_segments", "Only three comparable segments were found; Gnomeo can proceed, but the comparison set is thin.", severity="warning"))
    if strategy is not None and strategy.coverage < 1.0:
        result.warnings.append(IngestionIssue("limited_segmentation_coverage", "Some rows did not contribute to the chosen segmentation strategy.", severity="warning"))
    if result.platform.get("platform") == "unknown":
        result.warnings.append(IngestionIssue("low_platform_confidence", "Gnomeo could not confidently identify the ad platform from the headers.", severity="warning"))
    if not revenue_present and total_conversions > 0:
        result.warnings.append(IngestionIssue("cpa_mode", "Revenue data was not found, so Gnomeo will use CPA-based analysis instead of ROAS.", severity="warning"))

    result.analysis_mode = "ROAS" if revenue_present else ("CPA" if total_conversions > 0 else "")
    result.summary.update(
        {
            "total_spend": total_spend,
            "total_conversions": total_conversions,
            "revenue_present": revenue_present,
            "clicks_present": click_present,
            "impressions_present": impression_present,
            "segment_spend_count": segment_spend_count,
        }
    )

    if strategy is not None:
        result.segment_strategy = {
            "name": strategy.name,
            "fields": list(strategy.fields),
            "segment_count": strategy.segment_count,
            "coverage": round(strategy.coverage, 3),
            "sample_segment_names": strategy.segment_samples,
        }


def _build_debug(result: IngestionResult, fieldnames: Sequence[str], mapping: Dict[str, Optional[str]], platform: Dict[str, str]) -> None:
    normalized_columns = sorted({key for key, value in mapping.items() if value})
    missing_fields = [key for key in ("campaign_name", "spend") if not mapping.get(key)]
    if not result.analysis_mode and result.summary.get("total_conversions", 0) <= 0 and not result.summary.get("revenue_present", False):
        missing_fields.append("conversions_or_revenue")
    result.debug = {
        "original_columns": list(fieldnames),
        "normalized_columns": normalized_columns,
        "selected_mappings": mapping,
        "missing_fields": missing_fields,
        "mapping_confidence": _mapping_confidence(mapping, platform),
        "detected_platform": platform,
        "analysis_mode": result.analysis_mode or "",
        "chosen_segmentation_strategy": result.segment_strategy,
        "warnings": [issue.message for issue in result.warnings],
        "platform_signals": platform.get("signals", ""),
    }


def ingest_campaign_export(path: Path) -> IngestionResult:
    result = IngestionResult(path=path)

    try:
        if not path.exists() or not path.is_file():
            result.issues.append(IngestionIssue("missing_file", "CSV not found or unreadable.", str(path)))
            return result
        if path.stat().st_size <= 0:
            result.issues.append(IngestionIssue("empty_file", "The CSV file is empty."))
            return result
    except OSError as error:
        result.issues.append(IngestionIssue("unreadable_file", "CSV not found or unreadable.", str(error)))
        return result

    try:
        text = _read_text(path)
    except (OSError, UnicodeDecodeError) as error:
        result.issues.append(IngestionIssue("unreadable_file", "CSV not found or unreadable.", str(error)))
        return result

    if not text.strip():
        result.issues.append(IngestionIssue("empty_file", "The CSV file is empty."))
        return result

    try:
        reader = csv.DictReader(io.StringIO(text), restkey="__extra_columns__", restval="", strict=True)
        fieldnames = [str(name or "").strip() for name in (reader.fieldnames or [])]
        if not fieldnames or not any(fieldnames):
            result.issues.append(IngestionIssue("invalid_csv", "The CSV does not contain a readable header row."))
            return result
        raw_rows = list(reader)
    except csv.Error as error:
        result.issues.append(IngestionIssue("invalid_csv", "The CSV could not be parsed.", str(error)))
        return result

    if not raw_rows:
        result.issues.append(IngestionIssue("no_rows", "The CSV has a header row but no data rows."))
        result.summary["row_count"] = 0
        result.currency = _detect_currency(fieldnames, [])
        result.field_mapping = _map_columns(fieldnames)
        result.platform = _detect_platform(fieldnames, result.field_mapping)
        _build_debug(result, fieldnames, result.field_mapping, result.platform)
        return result

    mapping = _map_columns(fieldnames)
    platform = _detect_platform(fieldnames, mapping)
    currency = _detect_currency(fieldnames, raw_rows)
    spend_micros = bool(mapping.get("spend") and "micros" in _clean_key(mapping["spend"]))

    normalized_rows: List[_NormalizedRow] = []
    row_issues: List[IngestionIssue] = []
    for row in raw_rows:
        normalized_row, issues = _normalize_row(row, mapping, spend_micros)
        normalized_rows.append(normalized_row)
        row_issues.extend(issues)

    result.raw_rows = raw_rows
    result.field_mapping = mapping
    result.platform = platform
    result.currency = currency
    result.issues.extend(row_issues)

    if mapping.get("spend") is None:
        result.issues.append(IngestionIssue("missing_spend_mapping", "Could not identify a spend column in the export.", "Check the CSV headers for spend, cost, amount spent, or cost micros fields."))

    if mapping.get("campaign_name") is None:
        result.warnings.append(IngestionIssue("inferred_campaign", "No dedicated campaign column was found; Gnomeo will infer campaign labels from the available dimensions.", severity="warning"))

    candidate_strategy = _choose_strategy(normalized_rows, platform)
    if candidate_strategy is not None:
        result.records = _aggregate_rows(normalized_rows, candidate_strategy)
    else:
        # Keep the raw-row-normalized records around so validation/debug can still reason about the file.
        result.records = []

    segment_count = len(result.records)
    total_spend = sum(float(record.get("spend") or 0.0) for record in result.records)
    total_conversions = sum(int(record.get("conversions") or 0) for record in result.records)
    total_revenue = sum(float(record.get("revenue") or 0.0) for record in result.records if record.get("revenue") is not None)
    revenue_present = any(record.get("revenue") is not None for record in result.records)
    if candidate_strategy is None:
        # Use the normalized raw rows for the summary so validation can still explain what happened.
        segment_count = len({_build_segment_label(row.values, ("campaign_name",)) for row in normalized_rows if _build_segment_label(row.values, ("campaign_name",)) != "Unassigned segment"})

    result.summary = {
        "row_count": len(raw_rows),
        "normalized_row_count": len(normalized_rows),
        "total_spend": total_spend,
        "total_conversions": total_conversions,
        "total_revenue": total_revenue if revenue_present else None,
        "revenue_present": revenue_present,
        "segment_count": segment_count,
        "platform": platform.get("platform", "unknown"),
        "platform_confidence": platform.get("confidence", "low"),
    }

    if candidate_strategy is not None:
        result.segment_strategy = {
            "name": candidate_strategy.name,
            "fields": list(candidate_strategy.fields),
            "segment_count": candidate_strategy.segment_count,
            "coverage": round(candidate_strategy.coverage, 3),
            "sample_segment_names": candidate_strategy.segment_samples,
        }

    _evaluate_validation(result, normalized_rows, candidate_strategy)
    _build_debug(result, fieldnames, mapping, platform)

    # Hard fail if validation surfaced errors; warnings are retained for the CLI.
    return result


def format_validation_message(result: IngestionResult) -> str:
    lines = ["Gnomeo can't generate recommendations from this file yet."]
    for issue in result.issues:
        lines.append(f"- {issue.message}")
        if issue.detail:
            lines.append(f"  {issue.detail}")

    if result.field_mapping:
        mapped = ", ".join(f"{key}={value or '—'}" for key, value in result.field_mapping.items() if key in {"campaign_name", "spend", "conversions", "revenue", "clicks", "impressions"})
        if mapped:
            lines.append(f"Mapped fields: {mapped}")
    if result.debug.get("selected_mappings"):
        lines.append(f"Platform: {result.debug.get('detected_platform', {}).get('platform', 'unknown')} / Mode: {result.analysis_mode or 'unavailable'}")

    return "\n".join(lines)


def _contract_mode(result: IngestionResult) -> str:
    if not result.valid:
        return "failed"
    mode = (result.analysis_mode or "").lower()
    if mode in {"roas", "cpa", "limited"}:
        return mode
    return "limited"


def _contract_confidence(result: IngestionResult) -> str:
    platform_confidence = str(result.debug.get("detected_platform", {}).get("confidence", "low") or "low").lower()
    mapping_confidence = str(result.debug.get("mapping_confidence", "low") or "low").lower()
    order = {"low": 0, "medium": 1, "high": 2}
    if order.get(mapping_confidence, 0) < order.get(platform_confidence, 0):
        return platform_confidence
    return mapping_confidence if mapping_confidence in order else "low"


def _field_map(result: IngestionResult) -> Dict[str, Any]:
    mapping = dict(result.debug.get("selected_mappings", {}) or {})
    mapping.setdefault("campaign_name", result.field_mapping.get("campaign_name"))
    mapping.setdefault("spend", result.field_mapping.get("spend"))
    mapping.setdefault("conversions", result.field_mapping.get("conversions"))
    mapping.setdefault("revenue", result.field_mapping.get("revenue"))
    mapping.setdefault("clicks", result.field_mapping.get("clicks"))
    mapping.setdefault("impressions", result.field_mapping.get("impressions"))
    mapping.setdefault("platform", result.field_mapping.get("platform"))
    mapping.setdefault("campaign_type", result.field_mapping.get("campaign_type"))
    mapping.setdefault("country", result.field_mapping.get("country"))
    mapping.setdefault("ad_group", result.field_mapping.get("ad_group"))
    mapping.setdefault("ad_set", result.field_mapping.get("ad_set_name") or result.field_mapping.get("ad_group"))
    mapping.setdefault("ad", result.field_mapping.get("ad_name"))
    mapping.setdefault("keyword", result.field_mapping.get("keyword"))
    mapping.setdefault("search_term", result.field_mapping.get("search_term"))
    mapping.setdefault("device", result.field_mapping.get("device"))
    mapping.setdefault("date", result.field_mapping.get("date"))
    return mapping


def _missing_required_fields(result: IngestionResult) -> List[str]:
    missing = []
    field_map = _field_map(result)
    if not field_map.get("campaign_name"):
        missing.append("campaign_name")
    if not field_map.get("spend"):
        missing.append("spend")
    if not result.valid and not result.records:
        missing.append("segment")
    if result.summary.get("total_conversions", 0) <= 0 and not result.summary.get("revenue_present", False):
        missing.append("conversions_or_revenue")
    return missing


def _missing_optional_fields(result: IngestionResult) -> List[str]:
    field_map = _field_map(result)
    optional = ["revenue", "clicks", "impressions", "platform", "campaign_type", "country", "ad_group", "ad_set", "ad", "keyword", "search_term", "device", "date"]
    return [field for field in optional if not field_map.get(field)]


def _revenue_status(result: IngestionResult) -> str:
    summary = result.summary or {}
    if summary.get("revenue_present") and summary.get("total_revenue") not in (None, 0, 0.0):
        return "available"
    if summary.get("revenue_present") and float(summary.get("total_revenue") or 0.0) == 0.0:
        return "zero"
    if result.analysis_mode.lower() == "cpa":
        return "missing"
    return "unknown"


def build_ingestion_contract(result: IngestionResult) -> Dict[str, Any]:
    ok = bool(result.valid)
    status = "pass" if ok else "fail"
    analysis_mode = _contract_mode(result)
    confidence = _contract_confidence(result)
    decision_engine_allowed = ok and status == "pass"
    field_map = _field_map(result)
    strategy = result.segment_strategy or result.debug.get("chosen_segmentation_strategy") or {}
    summary = result.summary or {}
    clean_rows = list(result.records or []) if ok else []
    warnings = [issue.message for issue in (result.warnings or [])]
    blocking_errors = [issue.message if not issue.detail else f"{issue.message} {issue.detail}" for issue in (result.issues or [])]
    if not blocking_errors and not ok:
        blocking_errors = [result.debug.get("validation_message", "Validation failed.")]

    user_message = format_validation_message(result) if not ok else (
        "Dataset is ready for CPA-based analysis. Revenue data was not found." if analysis_mode == "cpa" else
        "Dataset is ready for ROAS-based analysis." if analysis_mode == "roas" else
        "Dataset is valid, but confidence is limited."
    )

    platform = result.debug.get("detected_platform", {}) or {}
    matched_columns = sorted({value for value in field_map.values() if value})
    total_spend = float(summary.get("total_spend") or 0.0)
    total_conversions = summary.get("total_conversions")
    total_revenue = summary.get("total_revenue")
    handoff = {
        "analysis_mode": analysis_mode,
        "confidence": confidence,
        "clean_rows_count": len(clean_rows),
        "total_spend": total_spend,
        "total_conversions": total_conversions,
        "total_revenue": total_revenue,
        "warnings_count": len(warnings),
        "decision_engine_allowed": decision_engine_allowed,
    }

    contract = {
        "ok": ok,
        "status": status,
        "user_message": user_message or "Validation complete.",
        "analysis_mode": analysis_mode,
        "confidence": confidence,
        "decision_engine_allowed": decision_engine_allowed,
        "platform": {
            "detected": platform.get("platform", "unknown"),
            "confidence": platform.get("confidence", "low"),
            "reason": platform.get("signals", "") or "No reliable platform signal matched.",
            "matched_columns": matched_columns,
        },
        "mapping": {
            "field_map": field_map,
            "missing_required_fields": _missing_required_fields(result),
            "missing_optional_fields": _missing_optional_fields(result),
            "warnings": warnings,
        },
        "segmentation": {
            "strategy": strategy.get("name", "not available") if isinstance(strategy, dict) else str(strategy or "not available"),
            "dimensions_used": list(strategy.get("fields", []) or []) if isinstance(strategy, dict) else [],
            "segment_count": int(summary.get("segment_count") or (strategy.get("segment_count", 0) if isinstance(strategy, dict) else 0)),
            "reason": strategy.get("reason", "") if isinstance(strategy, dict) else "",
            "sample_segments": list(strategy.get("sample_segment_names", []) or []) if isinstance(strategy, dict) else [],
        },
        "summary": {
            "raw_row_count": len(result.raw_rows or []),
            "clean_row_count": len(clean_rows),
            "excluded_row_count": int(summary.get("excluded_row_count") or 0),
            "total_spend": total_spend,
            "total_conversions": total_conversions if total_conversions is not None else None,
            "total_revenue": total_revenue if total_revenue is not None else None,
            "revenue_status": _revenue_status(result),
            "segments": int(summary.get("segment_count") or len(clean_rows)),
        },
        "clean_rows": clean_rows,
        "warnings": warnings,
        "blocking_errors": blocking_errors,
        "handoff": handoff,
        "debug": {
            **(result.debug or {}),
            "stable_contract_version": 1,
        },
    }
    return contract
