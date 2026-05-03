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
    "suggested_message",
]


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

    if category not in {"data_partner", "report_validator"}:
        if any(k in role for k in ["buyer", "lead", "founder", "coordinator", "specialist", "manager"]):
            category = "data_partner"
        else:
            category = "report_validator"

    if priority not in {"high", "medium", "low"}:
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
    return candidate


def generate_message(candidate: Dict[str, str]) -> str:
    name = (candidate.get("name") or "there").strip()
    company = (candidate.get("company") or "your team").strip()
    reason = (candidate.get("reason_they_fit") or "your work").strip()

    lines = [
        f"Hi {name},",
        f"I came across {company} and thought of you because {reason.lower() if reason else 'your work seems relevant'}.",
        "I'm collecting a few real-world opinions on a lightweight outreach / part-review workflow.",
        "Would you be open to sharing a quick thought or a small data point?",
        "No rush either way — just thought I'd ask.",
    ]
    return "\n".join(lines)


def update_messages(path: Path = CSV_PATH) -> List[Dict[str, str]]:
    candidates = [classify_candidate(row) for row in load_candidates(path)]
    for candidate in candidates:
        candidate["suggested_message"] = generate_message(candidate)

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
