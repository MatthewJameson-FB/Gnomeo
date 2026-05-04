from __future__ import annotations

import base64
import html
import os
import re
import subprocess
from datetime import datetime
from email.utils import parseaddr
from pathlib import Path

from flask import Flask, render_template, request, send_from_directory, url_for

import resend

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parents[1]
AGENT_SCRIPT = REPO_ROOT / "agent_test.py"
TEMPLATE_PATH = REPO_ROOT / "report_email_template.txt"
UPLOADS_DIR = BASE_DIR / "uploads"
GENERATED_DIR = BASE_DIR / "generated_reports"
DEFAULT_SENDER = "Gnomeo <reports@gnomeo.nl>"
DEFAULT_SUBJECT = "Your Gnomeo analysis"
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "gnomeo-local-report-tool")
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024


def ensure_directories() -> None:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)


def is_csv_file(filename: str) -> bool:
    return Path(filename or "").suffix.lower() == ".csv"


def valid_email(value: str) -> bool:
    name, addr = parseaddr(value or "")
    return bool(addr) and EMAIL_RE.match(addr) is not None


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value or "report")
    return value.strip("-_.") or "report"


def load_template() -> tuple[str, str]:
    if TEMPLATE_PATH.exists():
        text = TEMPLATE_PATH.read_text(encoding="utf-8")
    else:
        text = (
            "Subject: Your Gnomeo analysis\n\n"
            "Hey — I’ve run your data through Gnomeo.\n\n"
            "Attached is your report.\n\n"
            "It highlights:\n"
            "- where spend is likely being wasted\n"
            "- 3 specific decisions we’d make\n"
            "- expected impact + risks\n\n"
            "A quick note on context — this is based purely on the dataset you shared.\n\n"
            "Where this gets significantly more accurate is when we layer in:\n"
            "- your actual business goals\n"
            "- margin / LTV context\n"
            "- and track performance week to week\n\n"
            "That’s where Gnomeo starts to learn what actually works in your account over time.\n\n"
            "Happy to walk through this or run it on a weekly basis if useful.\n\n"
            "Curious what stands out / what feels off.\n"
        )
    lines = text.splitlines()
    subject = DEFAULT_SUBJECT
    body_lines = lines
    if lines and lines[0].lower().startswith("subject:"):
        subject = lines[0].split(":", 1)[1].strip() or DEFAULT_SUBJECT
        body_lines = lines[1:]
        if body_lines and body_lines[0].strip() == "":
            body_lines = body_lines[1:]
    body = "\n".join(body_lines).strip() or text.strip()
    return subject, body


def render_body_html(body: str) -> str:
    paragraphs = [chunk.strip() for chunk in re.split(r"\n\s*\n", body.strip()) if chunk.strip()]
    html_parts = []
    for para in paragraphs:
        if para.startswith("-"):
            items = [line[1:].strip() for line in para.splitlines() if line.strip().startswith("-")]
            html_parts.append("<ul>" + "".join(f"<li>{html.escape(item)}</li>" for item in items) + "</ul>")
        else:
            html_parts.append("<p>" + html.escape(para).replace("\n", "<br />") + "</p>")
    return "".join(html_parts)


def build_email_html(body: str, client_id: str | None = None, notes: str | None = None) -> str:
    extras = []
    if client_id:
        extras.append(f"<p><strong>Client ID:</strong> {html.escape(client_id)}</p>")
    if notes:
        extras.append(f"<p><strong>Notes:</strong> {html.escape(notes)}</p>")
    return (
        "<div style='font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;'>"
        + render_body_html(body)
        + "".join(extras)
        + "</div>"
    )


def run_agent(csv_path: Path, report_html_path: Path, report_md_path: Path) -> None:
    command = [
        "python3",
        str(AGENT_SCRIPT),
        "--graph",
        str(csv_path),
        "--output-report",
        str(report_md_path),
        "--output-html",
        str(report_html_path),
    ]
    subprocess.run(command, cwd=REPO_ROOT, check=True)


def send_report_email(recipient_email: str, report_html_path: Path, client_id: str | None, notes: str | None) -> None:
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is missing")

    resend.api_key = api_key
    subject, body = load_template()
    html_body = build_email_html(body, client_id=client_id, notes=notes)
    attachment_content = base64.b64encode(report_html_path.read_bytes()).decode("utf-8")

    params = {
        "from": DEFAULT_SENDER,
        "to": [recipient_email],
        "subject": subject,
        "html": html_body,
        "text": body,
        "attachments": [
            {
                "content": attachment_content,
                "filename": report_html_path.name,
            }
        ],
    }
    resend.Emails.send(params)


@app.route("/uploads/<path:filename>")
def uploaded_file(filename: str):
    return send_from_directory(UPLOADS_DIR, filename)


@app.route("/generated/<path:filename>")
def generated_file(filename: str):
    return send_from_directory(GENERATED_DIR, filename)


@app.route("/", methods=["GET", "POST"])
def index():
    ensure_directories()
    result = None
    error = None
    form = {"recipient_email": "", "client_id": "", "notes": ""}

    if request.method == "POST":
        recipient_email = (request.form.get("recipient_email") or "").strip()
        client_id = (request.form.get("client_id") or "").strip()
        notes = (request.form.get("notes") or "").strip()
        upload = request.files.get("csv_file")

        form.update({
            "recipient_email": recipient_email,
            "client_id": client_id,
            "notes": notes,
        })

        if not recipient_email:
            error = "Recipient email is required."
        elif not valid_email(recipient_email):
            error = "Recipient email is not valid."
        elif not upload or not upload.filename:
            error = "Please upload a CSV file."
        elif not is_csv_file(upload.filename):
            error = "Uploaded file must be a CSV."
        else:
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            safe_name = slugify(Path(upload.filename).stem)
            upload_path = UPLOADS_DIR / f"{timestamp}-{safe_name}.csv"
            report_html_path = GENERATED_DIR / f"{timestamp}-{safe_name}.html"
            report_md_path = GENERATED_DIR / f"{timestamp}-{safe_name}.md"

            upload.save(upload_path)

            try:
                run_agent(upload_path, report_html_path, report_md_path)
            except subprocess.CalledProcessError as exc:
                error = f"Report generation failed: {exc}"
            except Exception as exc:  # noqa: BLE001
                error = f"Report generation failed: {exc}"
            else:
                try:
                    send_report_email(recipient_email, report_html_path, client_id or None, notes or None)
                except RuntimeError as exc:
                    error = str(exc)
                except Exception as exc:  # noqa: BLE001
                    error = f"Email send failed: {exc}"
                else:
                    result = {
                        "recipient_email": recipient_email,
                        "client_id": client_id,
                        "notes": notes,
                        "upload_name": upload.filename,
                        "upload_path": str(upload_path),
                        "report_html_path": str(report_html_path),
                        "preview_url": url_for("generated_file", filename=report_html_path.name),
                    }

    return render_template("index.html", result=result, error=error, form=form)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)
