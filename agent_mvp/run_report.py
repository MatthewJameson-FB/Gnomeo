#!/usr/bin/env python3
from __future__ import annotations

import argparse
import errno
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path.home() / "Gnomeo" / "free_reports"
INBOX_DIR = ROOT / "inbox"
PROCESSED_DIR = ROOT / "processed_inputs"
OUTPUT_DIR = ROOT / "output"
AGENT_TEST = Path(__file__).resolve().parent / "agent_test.py"


def email_safe(value: str) -> str:
    safe = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return safe.strip("_") or "customer"


def timestamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local Gnomeo free-tier report process.")
    parser.add_argument("--csv", nargs="+", required=True, help="Path(s) to the input CSV file(s)")
    parser.add_argument("--email", required=True, help="Customer email address")
    return parser.parse_args()


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def main() -> int:
    args = parse_args()
    csv_paths = [Path(value).expanduser() for value in args.csv]
    email = args.email.strip()

    for csv_path in csv_paths:
        try:
            if not csv_path.exists() or not csv_path.is_file() or not csv_path.stat().st_size:
                fail(f"CSV not found or unreadable: {csv_path}")
            with csv_path.open("rb"):
                pass
        except PermissionError:
            fail(f"CSV not found or unreadable: {csv_path}")

    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    stamp = timestamp()
    safe_email = email_safe(email)
    processed_csvs = [PROCESSED_DIR / f"{stamp}_{index + 1:02d}_{csv_path.name}" for index, csv_path in enumerate(csv_paths)]
    output_html = OUTPUT_DIR / f"gnomeo_report_{safe_email}_{stamp}.html"
    output_md = OUTPUT_DIR / f"gnomeo_report_{safe_email}_{stamp}.md"

    try:
        for source_path, processed_csv in zip(csv_paths, processed_csvs):
            shutil.copy2(source_path, processed_csv)
    except PermissionError:
        fail("Move the CSV into ~/Gnomeo/free_reports/inbox first.")
    except OSError as error:
        if error.errno in {errno.EACCES, errno.EPERM}:
            fail("Move the CSV into ~/Gnomeo/free_reports/inbox first.")
        fail(f"Unable to copy CSV: {error}")

    try:
        subprocess.run(
            [
                "python3",
                str(AGENT_TEST),
                "--graph",
                *[str(path) for path in processed_csvs],
                "--output-html",
                str(output_html),
                "--output-report",
                str(output_md),
            ],
            cwd=AGENT_TEST.parent,
            check=True,
            capture_output=True,
            text=True,
        )
    except PermissionError:
        fail("Move the CSV into ~/Gnomeo/free_reports/inbox first.")
    except subprocess.CalledProcessError as error:
        stderr = (error.stderr or "").strip()
        stdout = (error.stdout or "").strip()
        if stderr:
            fail(stderr)
        if stdout:
            fail(stdout)
        fail(f"Report processing failed: {error}")
    finally:
        try:
            for processed_csv in processed_csvs:
                processed_csv.unlink(missing_ok=True)
        except Exception:
            pass

    print(f"HTML report path: {output_html}")
    print(f"MD report path: {output_md}")
    print("Next steps: Review report, upload HTML to admin submission, send report email.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
