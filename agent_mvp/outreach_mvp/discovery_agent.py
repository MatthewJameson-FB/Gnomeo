#!/usr/bin/env python3
"""Public-search discovery for manual outreach review.

This script only discovers candidates. It never sends messages.
It appends validated rows into candidates.csv for manual review.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import quote_plus, urlparse, parse_qs
from urllib.request import Request, urlopen

BASE_DIR = Path(__file__).resolve().parent
CSV_PATH = BASE_DIR / "candidates.csv"

FIELDNAMES = [
    "name",
    "role",
    "company",
    "source_url",
    "reason_they_fit",
    "category",
    "priority",
    "approval_status",
    "validation_status",
    "validation_notes",
    "suggested_message",
]

REPORT_VALIDATOR_QUERIES = [
    'site:linkedin.com/in "Paid Media Manager" "Google Ads" UK',
    'site:linkedin.com/in "Performance Marketing Manager" "Meta Ads"',
    'site:linkedin.com/in "PPC Specialist" "Google Ads"',
    'site:linkedin.com/in "Google Ads Specialist" "paid media"',
    'site:linkedin.com/in "Meta Ads Specialist" "performance marketing"',
    'site:linkedin.com/in "Paid Social Manager" "PPC"',
]

DATA_PARTNER_QUERIES = [
    'site:linkedin.com/in "DTC founder" "Meta Ads"',
    'site:linkedin.com/in "ecommerce founder" "paid ads"',
    'site:linkedin.com/in "growth founder" "Google Ads"',
    'site:linkedin.com/in "small agency owner" "paid media"',
    'site:linkedin.com/in "startup founder" "paid ads"',
    'site:linkedin.com/in founder ecommerce ads',
]

ROLE_REQUIRED_TERMS = {
    "marketing",
    "ads",
    "performance",
    "ppc",
    "paid media",
    "growth",
    "ecommerce",
    "founder",
}


@dataclass
class SearchResult:
    title: str
    link: str
    snippet: str
    query: str


def load_existing(path: Path = CSV_PATH) -> List[Dict[str, str]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return [dict(row) for row in reader]


def save_candidates(rows: Sequence[Dict[str, str]], path: Path = CSV_PATH) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def build_queries(category: str) -> List[str]:
    if category == "report_validator":
        return REPORT_VALIDATOR_QUERIES[:]
    if category == "data_partner":
        return DATA_PARTNER_QUERIES[:]
    return REPORT_VALIDATOR_QUERIES + DATA_PARTNER_QUERIES


def normalized(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def is_allowed_source_url(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if "linkedin.com" in host and ("/in/" in path or "/company/" in path):
        return True
    return False


def role_is_relevant(role: str, category: str) -> bool:
    text = normalized(role)
    return any(term in text for term in ROLE_REQUIRED_TERMS) or category in text


def score_priority(role: str, category: str, query: str) -> str:
    text = normalized(" ".join([role, category, query]))
    if any(term in text for term in ["paid media manager", "performance marketing manager", "ecommerce founder", "growth founder"]):
        return "high"
    if any(term in text for term in ["ppc specialist", "google ads specialist", "meta ads specialist", "paid social manager"]):
        return "medium"
    return "medium"


def parse_name_title(title: str) -> Tuple[str, str, str]:
    clean = re.sub(r"\s*\|\s*LinkedIn.*$", "", title, flags=re.I).strip()
    parts = [p.strip() for p in re.split(r"\s+[\-|–—]\s+|\s*\|\s*", clean) if p.strip()]
    if not parts:
        return "", "", ""
    name = parts[0]
    role = parts[1] if len(parts) > 1 else ""
    company = parts[2] if len(parts) > 2 else ""
    if len(parts) == 2 and any(term in normalized(parts[1]) for term in ["linkedin", "profile"]):
        role = ""
    return name, role, company


def candidate_from_result(result: SearchResult, category: str) -> Optional[Dict[str, str]]:
    if not result.link or not is_allowed_source_url(result.link):
        return None

    name, role, company = parse_name_title(result.title)
    snippet = result.snippet.strip()
    if not role:
        role_match = re.search(
            r"\b(Paid Media Manager|Performance Marketing Manager|PPC Specialist|Google Ads Specialist|Meta Ads Specialist|Paid Social Manager|DTC founder|ecommerce founder|growth founder|small agency owner|startup founder)\b",
            f"{result.title} {snippet}",
            flags=re.I,
        )
        if role_match:
            role = role_match.group(1)

    if not name:
        return None
    if not role_is_relevant(role or snippet, category):
        return None

    company = company or extract_company_from_snippet(snippet) or ""
    reason = f"Public search result for {category.replace('_', ' ')}; profile mentions {role or 'relevant role'}"

    return {
        "name": name,
        "role": role or (category.replace("_", " ")),
        "company": company,
        "source_url": result.link,
        "reason_they_fit": reason,
        "category": category,
        "priority": score_priority(role, category, result.query),
        "approval_status": "pending",
        "validation_status": "valid",
        "validation_notes": "",
        "suggested_message": "",
    }


def extract_company_from_snippet(snippet: str) -> str:
    text = snippet.strip()
    m = re.search(r"(?:at|with|from)\s+([A-Z][\w&'.-]+(?:\s+[A-Z][\w&'.-]+){0,4})", text)
    return m.group(1).strip() if m else ""


def search_google(query: str, api_key: str, engine_id: str, limit: int) -> List[SearchResult]:
    url = (
        "https://www.googleapis.com/customsearch/v1?"
        f"key={quote_plus(api_key)}&cx={quote_plus(engine_id)}&q={quote_plus(query)}&num={min(max(limit, 1), 10)}"
    )
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    items = payload.get("items", [])
    results = []
    for item in items[:limit]:
        results.append(
            SearchResult(
                title=item.get("title", ""),
                link=item.get("link", ""),
                snippet=item.get("snippet", ""),
                query=query,
            )
        )
    return results


def manual_queries(category: str) -> List[str]:
    return build_queries(category)


def discover(category: str, limit: int) -> Tuple[List[Dict[str, str]], List[str]]:
    api_key = os.getenv("SEARCH_API_KEY", "").strip()
    engine_id = os.getenv("SEARCH_ENGINE_ID", "").strip()
    if not api_key or not engine_id:
        return [], manual_queries(category)

    seen_urls = set()
    discovered: List[Dict[str, str]] = []
    queries = build_queries(category)

    for query in queries:
        if len(discovered) >= limit:
            break
        try:
            results = search_google(query, api_key, engine_id, min(10, limit - len(discovered)))
        except Exception as exc:  # pragma: no cover - surfacing search failures
            print(f"[discovery] search failed for query: {query}\n  {exc}", file=sys.stderr)
            continue

        for result in results:
            candidate = candidate_from_result(result, category)
            if not candidate:
                continue
            if candidate["source_url"] in seen_urls:
                continue
            seen_urls.add(candidate["source_url"])
            discovered.append(candidate)
            if len(discovered) >= limit:
                break

    return discovered, []


def merge_candidates(existing: Sequence[Dict[str, str]], discovered: Sequence[Dict[str, str]]) -> List[Dict[str, str]]:
    merged: List[Dict[str, str]] = []
    seen = set()
    for row in existing:
        url = (row.get("source_url") or "").strip()
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        merged.append({field: row.get(field, "") for field in FIELDNAMES})
    for row in discovered:
        url = (row.get("source_url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        merged.append({field: row.get(field, "") for field in FIELDNAMES})
    return merged


def print_manual_queries(category: str) -> None:
    print("No SEARCH_API_KEY/SEARCH_ENGINE_ID found.")
    print("Run these public search queries manually:")
    for query in build_queries(category):
        print(f"- {query}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Discover public outreach candidates into candidates.csv")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--category", choices=["report_validator", "data_partner"], help="Discover only one category")
    group.add_argument("--all", action="store_true", help="Discover both categories")
    parser.add_argument("--limit", type=int, default=20, help="Maximum candidates to write")
    args = parser.parse_args(argv)

    categories = ["report_validator", "data_partner"] if args.all else [args.category]
    api_key = os.getenv("SEARCH_API_KEY", "").strip()
    engine_id = os.getenv("SEARCH_ENGINE_ID", "").strip()

    if not api_key or not engine_id:
        for category in categories:
            print_manual_queries(category)
        return 0

    existing = load_existing(CSV_PATH)
    discovered_rows: List[Dict[str, str]] = []

    per_category_limit = max(1, args.limit // len(categories))
    for category in categories:
        discovered, _ = discover(category, per_category_limit)
        discovered_rows.extend(discovered)

    merged = merge_candidates(existing, discovered_rows)
    save_candidates(merged, CSV_PATH)
    print(f"Saved {len(merged)} candidates to {CSV_PATH}")
    print(f"Discovered {len(discovered_rows)} new candidates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
