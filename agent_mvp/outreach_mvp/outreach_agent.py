#!/usr/bin/env python3
"""Lightweight outreach MVP for manual approval workflows.

CSV is the source of truth.
No messages are sent automatically.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path
from typing import Dict, List

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

ALLOWED_CATEGORIES = {"data_partner", "report_validator"}
ALLOWED_PRIORITIES = {"high", "medium", "low"}
VAGUE_REASON_PHRASES = {
    "various",
    "something",
    "something like",
    "etc",
    "etc.",
    "general",
    "vague",
    "maybe relevant",
    "some work",
    "any work",
    "works in auto",
    "works in cars",
    "auto",
}
ROLE_REQUIRED_TERMS = {"marketing", "ads", "performance"}


def load_candidates(path: Path = CSV_PATH) -> List[Dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return [dict(row) for row in reader]


def classify_candidate(candidate: Dict[str, str]) -> Dict[str, str]:
    category = (candidate.get("category") or "").strip().lower()
    priority = (candidate.get("priority") or "").strip().lower()
    role = (candidate.get("role") or "").lower()
    company = (candidate.get("company") or "").lower()
    reason = (candidate.get("reason_they_fit") or "").lower()

    if category not in ALLOWED_CATEGORIES:
        if any(k in role for k in ["buyer", "lead", "founder", "coordinator", "specialist", "manager"]):
            category = "data_partner"
        else:
            category = "report_validator"

    if priority not in ALLOWED_PRIORITIES:
        if any(k in reason for k in ["discontinued", "older vehicles", "fitment", "sourcing", "supplier"]):
            priority = "high"
        elif any(k in company for k in ["forum", "club", "notes", "community"]):
            priority = "low"
        else:
            priority = "medium"

    candidate["category"] = category
    candidate["priority"] = priority
    if not (candidate.get("approval_status") or "").strip():
        candidate["approval_status"] = "pending"
    candidate["source_url"] = (candidate.get("source_url") or "").strip()
    candidate["validation_status"] = "valid"
    notes = []
    if not candidate["source_url"]:
        notes.append("missing_source_url")
        candidate["validation_status"] = "ignored"
    elif "linkedin.com" not in candidate["source_url"].lower():
        notes.append("non_linkedin_source_url")
        candidate["validation_status"] = "ignored"
    if not any(term in role for term in ROLE_REQUIRED_TERMS):
        notes.append("role_missing_marketing_ads_performance")
        if candidate["validation_status"] == "valid":
            candidate["validation_status"] = "flagged"
    if candidate["validation_status"] == "flagged":
        notes.append("vague_reason_they_fit")
    elif candidate["validation_status"] == "valid" and is_vague_reason(candidate.get("reason_they_fit") or ""):
        notes.append("vague_reason_they_fit")
        candidate["validation_status"] = "flagged"
    candidate["validation_notes"] = ";".join(notes)
    return candidate


def is_vague_reason(reason: str) -> bool:
    text = (reason or "").strip().lower()
    if not text:
        return True
    if len(text) < 18:
        return True
    return any(phrase in text for phrase in VAGUE_REASON_PHRASES)


def generate_message(candidate: Dict[str, str]) -> str:
    name = (candidate.get("name") or "there").strip()
    role = (candidate.get("role") or "").strip()
    company = (candidate.get("company") or "").strip()
    work_ref = candidate.get("reason_they_fit") or "your work"

    if role and company:
        reference = f"your {role.lower()} work at {company}"
    elif company:
        reference = f"what you do at {company}"
    elif role:
        reference = f"your {role.lower()} work"
    else:
        reference = work_ref.lower().strip()

    lines = [
        f"Hi {name},",
        f"I came across {reference} and it seemed relevant.",
        "I’m checking a small set of outreach fits by hand.",
        "If you’re open to it, could you share a blunt thought?",
        "No pressure if not.",
    ]
    return "\n".join(lines)


def update_messages(path: Path = CSV_PATH) -> List[Dict[str, str]]:
    candidates = [classify_candidate(row) for row in load_candidates(path)]
    for candidate in candidates:
        should_generate = (
            candidate.get("approval_status") == "pending"
            and bool(candidate.get("source_url"))
            and candidate.get("validation_status") == "valid"
        )
        candidate["suggested_message"] = generate_message(candidate) if should_generate else ""

    clean_rows = [{field: candidate.get(field, "") for field in FIELDNAMES} for candidate in candidates]

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(clean_rows)

    return clean_rows


def main() -> int:
    if not CSV_PATH.exists():
        print(f"Missing CSV: {CSV_PATH}", file=sys.stderr)
        return 1
    candidates = update_messages(CSV_PATH)
    print(f"Updated {len(candidates)} candidates in {CSV_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
