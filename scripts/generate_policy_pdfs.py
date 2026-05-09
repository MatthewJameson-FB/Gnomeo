#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from textwrap import wrap

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'docs'
DATE = '2026-05-09'
VERSION = '1.0'
PAGE_W, PAGE_H = 612, 792
LEFT = 54
TOP = 742
BOTTOM = 54
LINE_H = 14
MAX_CHARS = 88


def w(text: str) -> list[str]:
    text = text.strip()
    return wrap(text, MAX_CHARS) if text else ['']


def bullets(items: list[str]) -> list[str]:
    lines: list[str] = []
    for item in items:
        for i, line in enumerate(w(item)):
            lines.append(('- ' if i == 0 else '  ') + line)
        lines.append('')
    return lines


def section(title: str, paragraphs: list[str] | None = None, items: list[str] | None = None) -> list[str]:
    lines = ['']
    lines.append(title.upper())
    lines.append('')
    if paragraphs:
        for p in paragraphs:
            lines.extend(w(p))
            lines.append('')
    if items:
        lines.extend(bullets(items))
    return lines


def build_doc(title: str, summary: str, sections: list[list[str]]) -> list[str]:
    lines = [title, f'Version {VERSION} | Date {DATE} | Scope: Public policy document for Gnomeo', '']
    lines.extend(w(summary))
    lines.append('')
    for sec in sections:
        lines.extend(sec)
    return lines


def paginate(lines: list[str], lines_per_page: int = 40) -> list[list[str]]:
    pages: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        current.append(line)
        if len(current) >= lines_per_page:
            pages.append(current)
            current = []
    if current:
        pages.append(current)
    return pages


def esc(s: str) -> str:
    return s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')


def pdf_bytes(title: str, pages: list[list[str]]) -> bytes:
    objects: list[bytes] = []

    def obj(num: int, body: str) -> bytes:
        return f'{num} 0 obj\n{body}\nendobj\n'.encode('latin-1')

    num_pages = len(pages)
    page_ids = []
    content_ids = []
    next_id = 3
    for _ in pages:
        page_ids.append(next_id)
        content_ids.append(next_id + 1)
        next_id += 2
    font_id = next_id

    kids = ' '.join(f'{pid} 0 R' for pid in page_ids)
    objects.append(obj(1, '<< /Type /Catalog /Pages 2 0 R >>'))
    objects.append(obj(2, f'<< /Type /Pages /Kids [ {kids} ] /Count {num_pages} >>'))

    for idx, page_lines in enumerate(pages, start=1):
        body_lines = page_lines[2:]
        stream = ['BT']
        y = TOP

        def add_line(text: str, x: int = LEFT, size: int = 11):
            nonlocal y
            stream.append(f'/F1 {size} Tf')
            stream.append(f'1 0 0 1 {x} {y} Tm')
            stream.append(f'({esc(text)}) Tj')
            y -= LINE_H

        add_line(title, LEFT, 18)
        y -= 6
        add_line(page_lines[1], LEFT, 9)
        y -= 8

        for line in body_lines:
            if y < BOTTOM:
                break
            if not line:
                y -= 8
                continue
            is_heading = line.isupper() and len(line) > 3 and not line.startswith('-')
            if is_heading:
                add_line(line, LEFT, 12)
                y -= 2
                continue
            x = LEFT + 14 if line.startswith('- ') else LEFT
            add_line(line, x, 11)

        stream.append('/F1 9 Tf')
        stream.append(f'1 0 0 1 {PAGE_W - 110} 28 Tm')
        stream.append(f'(Page {idx} of {num_pages}) Tj')
        stream.append('ET')
        content = '\n'.join(stream).encode('latin-1', 'replace')
        objects.append(obj(page_ids[idx - 1], f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_ids[idx - 1]} 0 R >>'))
        objects.append(obj(content_ids[idx - 1], f'<< /Length {len(content)} >>\nstream\n{content.decode("latin-1")}\nendstream'))

    objects.append(obj(font_id, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'))

    header = b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
    offsets = [0]
    body = b''
    cursor = len(header)
    for o in objects:
        offsets.append(cursor)
        body += o
        cursor += len(o)
    xref_off = len(header) + len(body)
    xref_lines = ['xref', f'0 {len(objects)+1}', '0000000000 65535 f ']
    for off in offsets[1:]:
        xref_lines.append(f'{off:010d} 00000 n ')
    xref = ('\n'.join(xref_lines) + '\n').encode('latin-1')
    trailer = f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref_off}\n%%EOF\n'.encode('latin-1')
    return header + body + xref + trailer


def render(path: Path, title: str, summary: str, sections: list[list[str]]) -> None:
    lines = build_doc(title, summary, sections)
    raw_pages = paginate(lines, lines_per_page=40)
    pages = [[title, f'Version {VERSION} | Date {DATE} | Scope: Public policy document for Gnomeo'] + page[2:] for page in raw_pages]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pdf_bytes(title, pages))
    print(f'{path.relative_to(ROOT)}: {path.stat().st_size} bytes, {len(pages)} pages')


def doc_security() -> list[str]:
    return [
        section('Purpose and scope', [
            'This policy explains how Gnomeo protects uploaded ad data, generated reports, workspace context, and administrative access. It applies to customer-facing use of the product, private storage and access handling, and the current manual beta operating model.'
        ]),
        section('What Gnomeo protects', [
            'Raw ad exports are commercially sensitive. They can reveal budget structure, campaign performance, audience segments, and operational decisions. Gnomeo is designed to protect that material as private customer data.'
        ]),
        section('Security principles', items=[
            'Workspace data remains private by default.',
            'Raw uploads are handled as temporary processing data.',
            'Reports and analytical memory are kept separate from raw export files.',
            'Customer data is isolated by workspace and access scope.',
            'Public exposure of uploaded files is avoided.'
        ]),
        section('Raw upload handling', items=[
            'Raw uploads are not sold.',
            'Raw uploads are not publicly shared.',
            'Raw CSV contents are not intended to appear in logs.',
            'Temporary processing files are removed when practical after processing.',
            'Raw uploads are not meant to be retained indefinitely.'
        ]),
        section('Private storage and access', items=[
            'Customer files are stored in private locations.',
            'Short-lived access methods are used when files need to be downloaded.',
            'Public file access is avoided unless a file is intentionally public.',
            'Workspace isolation is preserved across customer records.',
            'Service credentials remain server-side only.'
        ]),
        section('Administrative access', [
            'Administrative endpoints are protected by server-side access controls for the current manual beta. Administrative secrets are not exposed in frontend code.'
        ]),
        section('Secrets management', items=[
            'Secrets are not committed to git.',
            'Frontend code must not contain service credentials.',
            'Operational secrets are stored on the server.',
            'If exposure is suspected, secrets should be rotated without delay.'
        ]),
        section('Transport and logging', items=[
            'Customer-facing requests are expected to use encrypted transport.',
            'Logs are kept lightweight and avoid raw export contents.',
            'Operational records are retained only as long as needed for support, reliability, or incident review.',
            'Access to sensitive operations is limited.'
        ]),
        section('Deletion and retention', [
            'Security and retention are linked. Keeping less raw data reduces exposure. Users may request deletion of workspace data, and temporary files are intended to be removed as soon as they are no longer needed.'
        ]),
        section('Incident response', items=[
            'If a secret or customer file is exposed, credentials should be rotated.',
            'Affected storage paths and access logs should be reviewed.',
            'Exposure should be contained by keeping customer data private by default.',
            'Corrective action should be documented before broader rollout.'
        ]),
        section('Current manual beta limitations', [
            'The current manual beta uses a simpler administrative access model than a mature production system. It is appropriate for controlled operation, but it does not replace fully scoped user authorization, complete audit trails, or long-term security hardening.'
        ]),
        section('Future security improvements', items=[
            'Stronger user authentication and workspace-scoped authorization.',
            'More complete audit logging for administrative actions.',
            'Clearer cleanup for temporary uploads and derived artifacts.',
            'Further access-control hardening as paid usage expands.'
        ]),
    ]


def doc_retention() -> list[str]:
    return [
        section('Purpose and scope', [
            'This policy explains what Gnomeo stores temporarily, what it may retain, and why the product keeps analytical memory rather than raw exports forever. The goal is to support recurring reviews without turning the service into a raw ad-data warehouse.'
        ]),
        section('Data minimization', [
            'Gnomeo is designed to keep less raw data whenever practical. The system should preserve the minimum information needed to produce useful analysis, recurring reviews, and workspace continuity.'
        ]),
        section('Data categories', items=[
            'Temporary data includes raw CSV uploads, parsed processing files, and short-lived report artifacts.',
            'Persistent data may include generated reports, workspace memory, analytical summaries, trend snapshots, recommendation history, preferences, and usage or billing metadata where applicable.'
        ]),
        section('Temporary raw uploads', items=[
            'Paid-tier raw uploads may be retained for up to 7 days for processing, support, and limited reruns unless deleted earlier.',
            'Temporary parsed files are intended to be deleted within 24 hours where practical.',
            'Temporary artifacts are not intended to be a long-term storage layer.'
        ]),
        section('Generated reports and workspace memory', [
            'Generated reports and workspace memory may be retained until deletion request, account closure, or workspace removal. These records help preserve continuity across reviews and are distinct from raw CSV uploads.'
        ]),
        section('Analytical memory', [
            'Workspace memory stores the context needed for recurring reviews: business type, goals, constraints, notes, and historical recommendations. This helps the product stay useful without preserving every original export.'
        ]),
        section('Recommendation history and trend snapshots', [
            'Recommendation history and trend snapshots are derived data. They are retained so Gnomeo can show recurring patterns, budget changes, and platform tradeoffs over time.'
        ]),
        section('Usage and billing metadata', [
            'Usage events and billing metadata may be retained where applicable for operational, support, or accounting reasons. These records should stay lightweight and should not contain raw CSV contents.'
        ]),
        section('Backups and logs', [
            'Backups and logs may have separate operational retention windows. They should not become a shadow archive of raw customer uploads. The retention goal is the shortest practical period consistent with reliability and incident response.'
        ]),
        section('Deletion requests and account closure', items=[
            'Users may request deletion of workspace data and raw uploads.',
            'Deletion workflows should cover persistent workspace data where applicable.',
            'Account closure should trigger cleanup where operationally possible.',
            'Backups and logs may be subject to separate limited retention windows.'
        ]),
        section('GDPR-aware operating principles', [
            'This policy is designed around data minimization, purpose limitation, and deletion handling. It is written to be transparent and practical without overclaiming legal certification.'
        ]),
        section('Current limitations', [
            'Exact retention mechanics may evolve as the product matures. The core principle remains the same: raw uploads should not be kept longer than necessary.'
        ]),
        section('Future improvements', items=[
            'More explicit cleanup automation for parsed artifacts and raw uploads.',
            'User-facing deletion tooling.',
            'Workspace-scoped retention controls for stricter customers.',
            'Clearer operational reporting on what is kept and for how long.'
        ]),
    ]


def doc_ai() -> list[str]:
    return [
        section('Purpose and scope', [
            'This policy explains how Gnomeo uses AI-assisted analysis and how data may be used to improve the product while keeping customer workspaces private by default. It applies to customer workspaces, uploaded exports, and derived operational patterns.'
        ]),
        section('How Gnomeo uses AI', [
            'Gnomeo uses AI-assisted analysis to help generate reports and recommendations from uploaded ad exports and workspace context. The goal is to produce readable analyst-style output that helps users understand waste, weak signal, budget allocation, and platform tradeoffs.'
        ]),
        section('Report generation', [
            'The product is intended to turn imported data into human-readable narrative reports. AI supports that analysis, while workspace context and business judgment remain part of the workflow.'
        ]),
        section('Customer workspace privacy', [
            'Customer workspaces remain private by default. Raw uploads are not sold or publicly shared. Gnomeo does not claim ownership of customer ad accounts or customer exports.'
        ]),
        section('Raw uploads and model training', [
            'Raw uploads are not used to train public foundation models. Gnomeo should not expose raw uploads from one customer to another, and raw exports should not be republished or reused as public examples without permission.'
        ]),
        section('Aggregated improvement', items=[
            'Gnomeo may use aggregated, anonymized, and non-identifiable operational patterns to improve report quality, benchmarking, weak-signal detection, recommendation systems, platform reliability, and operational insight.',
            'Those patterns should not expose customer names, client names, campaign names, workspace details, or raw uploaded exports.',
            'This form of aggregate learning helps keep the product useful and affordable for small teams and agencies.'
        ]),
        section('What Gnomeo does not do', items=[
            'Gnomeo does not sell raw customer uploads.',
            'Gnomeo does not publish customer data.',
            'Gnomeo does not expose one workspace to another.',
            'Gnomeo does not use raw uploads to train public foundation models.',
            'Gnomeo does not claim ownership of customer ad accounts or customer exports.',
            'Gnomeo does not use individual customer data to create public customer-identifiable benchmarks.'
        ]),
        section('Why aggregate learning helps', [
            'Gnomeo can improve over time by learning from broad, non-identifiable patterns such as common waste signals, weak-signal thresholds, fragmented budget patterns, platform tradeoffs, and recurring account issues. This improves recommendations without turning the service into a public dataset of customer uploads.'
        ]),
        section('Privacy-aware improvement principles', [
            'Product-improvement use of data should prefer aggregated, anonymized, and non-identifiable signals. The policy is designed to support quality improvements with minimal exposure of individual workspace data.'
        ]),
        section('Future privacy controls', [
            'Future controls may give customers stricter opt-outs or narrower retention settings where the product supports them.'
        ]),
        section('Current limitations', [
            'This policy is intentionally conservative and may evolve as the paid beta matures. It is intended to be clear about what the product does and does not do today.'
        ]),
        section('Policy updates', [
            'Any future updates should preserve the core promise: workspace data stays private by default, raw uploads remain temporary, and improvement learning stays aggregated and non-identifiable.'
        ]),
    ]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    docs = {
        'security-and-data-protection.pdf': (
            'Gnomeo Security & Data Protection Policy',
            'Formal guidance on how Gnomeo protects uploaded ad data, generated reports, workspace context, and administrative access.',
            doc_security(),
        ),
        'data-handling-and-retention.pdf': (
            'Gnomeo Data Handling & Retention Policy',
            'Formal guidance on what Gnomeo stores temporarily, what it retains, and why analytical memory is kept instead of raw exports forever.',
            doc_retention(),
        ),
        'ai-and-product-improvement-policy.pdf': (
            'Gnomeo AI & Product Improvement Policy',
            'Formal guidance on how Gnomeo uses AI-assisted analysis and how privacy-preserving product improvement may work.',
            doc_ai(),
        ),
    }
    for filename, (title, summary, sections) in docs.items():
        lines = build_doc(title, summary, sections)
        raw_pages = paginate(lines, lines_per_page=40)
        pages = [[title, f'Version {VERSION} | Date {DATE} | Scope: Public policy document for Gnomeo'] + page[2:] for page in raw_pages]
        pdf_path = OUT / filename
        pdf_path.write_bytes(pdf_bytes(title, pages))
        print(f'{pdf_path.relative_to(ROOT)}: {pdf_path.stat().st_size} bytes, {len(pages)} pages')


if __name__ == '__main__':
    main()
