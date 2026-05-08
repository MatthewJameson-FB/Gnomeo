from __future__ import annotations

import csv
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, send_from_directory, url_for
from werkzeug.utils import secure_filename

APP_DIR = Path(__file__).resolve().parent
ROOT = APP_DIR.parent.parent
RUN_REPORT = APP_DIR.parent / "run_report.py"
HOME_REPORTS = Path.home() / "Gnomeo" / "free_reports"
INBOX_DIR = HOME_REPORTS / "inbox"
OUTPUT_DIR = HOME_REPORTS / "output"
ALLOWED_EXTENSIONS = {".csv"}

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "gnomeo-free-report-runner")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024


def ensure_dirs() -> None:
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def is_csv(filename: str) -> bool:
    return Path(filename or "").suffix.lower() in ALLOWED_EXTENSIONS


def csv_looks_valid(path: Path) -> None:
    if not path.exists() or not path.is_file():
        raise ValueError("CSV file is missing.")
    if not path.stat().st_size:
        raise ValueError("CSV file is empty.")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        sample = handle.read(2048)
        if not sample.strip():
            raise ValueError("CSV file is empty.")
        handle.seek(0)
        reader = csv.reader(handle)
        next(reader, None)


def safe_email(value: str) -> str:
    safe = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return safe.strip("_") or "customer"


def parse_paths(output: str) -> tuple[str | None, str | None]:
    html_path = None
    md_path = None
    for line in output.splitlines():
        if line.startswith("HTML report path:"):
            html_path = line.split(":", 1)[1].strip()
        elif line.startswith("MD report path:"):
            md_path = line.split(":", 1)[1].strip()
    return html_path, md_path


def cleanup_temp_files(*paths: Path | None) -> None:
    for path in paths:
        if not path:
            continue
        try:
            path.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
        except Exception:
            continue


@app.route("/reports/<path:filename>")
def report_file(filename: str):
    return send_from_directory(OUTPUT_DIR, filename)


@app.route("/", methods=["GET", "POST"])
def index():
    ensure_dirs()
    error = None
    result = None
    form = {"email": ""}

    if request.method == "POST":
        email = (request.form.get("email") or "").strip()
        uploaded = request.files.get("csv_file")
        form["email"] = email

        if not email:
            error = "Customer email is required."
        elif not uploaded or not uploaded.filename:
            error = "Please choose a CSV file."
        elif not is_csv(uploaded.filename):
            error = "Uploaded file must be a CSV."
        else:
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            safe_name = secure_filename(Path(uploaded.filename).name) or f"report_{stamp}.csv"
            saved_name = f"{stamp}_{safe_name}"
            saved_csv = INBOX_DIR / saved_name

            try:
                uploaded.save(saved_csv)
                csv_looks_valid(saved_csv)
            except PermissionError:
                error = "Move the CSV into ~/Gnomeo/free_reports/inbox first."
            except Exception as exc:  # noqa: BLE001
                error = f"CSV validation failed: {exc}"
            else:
                try:
                    process = subprocess.run(
                        [
                            "python3",
                            str(RUN_REPORT),
                            "--csv",
                            str(saved_csv),
                            "--email",
                            email,
                        ],
                        cwd=APP_DIR,
                        capture_output=True,
                        text=True,
                    )

                    output = (process.stdout or "") + ("\n" + process.stderr if process.stderr else "")
                    html_path, md_path = parse_paths(output)

                    if process.returncode != 0:
                        error = output.strip() or "Report generation failed."
                    elif not html_path or not md_path:
                        error = "Report finished, but output paths were not returned."
                    else:
                        html_file = Path(html_path)
                        md_file = Path(md_path)
                        result = {
                            "email": email,
                            "saved_csv": str(saved_csv),
                            "csv_name": saved_csv.name,
                            "html_path": str(html_file),
                            "html_name": html_file.name,
                            "md_path": str(md_file),
                            "md_name": md_file.name,
                            "report_link": url_for("report_file", filename=html_file.name),
                            "admin_link": "https://www.gnomeo.nl/admin/submissions.html",
                            "generated_at": stamp,
                        }
                finally:
                    cleanup_temp_files(saved_csv, INBOX_DIR.parent / "processed_inputs" / f"{stamp}_{saved_csv.name}")

    return render_template("index.html", error=error, result=result, form=form)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=6060, debug=True)
