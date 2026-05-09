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
            'This policy explains how Gnomeo protects uploaded ad data, generated reports, workspace context, and manual admin operations. It applies to customer-facing use of the product, internal operations that touch customer data, and the current manual concierge beta workflow.'
        ]),
        section('Security philosophy', [
            'Gnomeo is designed around minimal retention and privacy-aware operations. Raw ad exports are sensitive commercial data. The product is intended to keep raw uploads temporary, while allowing generated reports, workspace memory, and recommendation history to persist where useful and where permitted.'
        ]),
        section('Data categories protected', items=[
            'Raw Google Ads and Meta Ads CSV exports.',
            'Generated reports and downloadable report files.',
            'Workspace preferences, notes, and business context.',
            'Recommendation history, trend summaries, and usage metadata.',
            'Admin workflows that may touch customer-facing data.'
        ]),
        section('Raw upload handling', items=[
            'Raw uploads should be treated as temporary processing data.',
            'Raw uploads should not be sold or publicly shared.',
            'Raw CSV contents should not appear in logs.',
            'Temporary files should be removed when processing is complete where possible.',
            'Raw uploads should not be retained indefinitely.'
        ]),
        section('Workspace and report protection', items=[
            'Workspace data should remain private by default.',
            'Reports may persist as part of analytical memory.',
            'Private storage buckets should be used for customer data.',
            'Signed URLs should be used for private file access when applicable.',
            'No public indexing of customer data should be allowed.'
        ]),
        section('Admin access controls', items=[
            'Admin endpoints require `ADMIN_SECRET` and a bearer-token header.',
            'The service-role key must remain server-side only.',
            'Admin access is suitable for the manual beta but is not a replacement for long-term user auth.',
            'Admin access should be limited and auditable.',
            'No secrets should be read from query strings or request bodies.'
        ]),
        section('Storage and access model', items=[
            'Customer files should live in private buckets.',
            'Storage objects should not be exposed publicly unless a deliberate public asset is intended.',
            'Workspace isolation should be preserved across all customer-facing records.',
            'Public frontend code should never contain service-role secrets.',
            'The current storage model should minimize the amount of raw data retained.'
        ]),
        section('Transport security', [
            'Customer-facing requests should use HTTPS/encrypted transport. Any file transfer or API request that carries customer data should assume transport security as a baseline requirement.'
        ]),
        section('Secrets management', items=[
            'Secrets must not be committed to git.',
            'Frontend code must not contain service-role credentials.',
            'Operational secrets should remain on the server.',
            'Secret rotation should be possible if exposure is suspected.'
        ]),
        section('Logging and operational controls', items=[
            'Logs should avoid raw CSV contents and other unnecessary sensitive detail.',
            'Operational logs should be kept only as long as needed.',
            'Access to admin functions should be restricted.',
            'Future audit logging should record meaningful actions without storing raw uploads.'
        ]),
        section('Workspace isolation', [
            'Each workspace should be isolated from other workspaces. Data from one customer or agency account must not be visible to another customer account. Aggregated product improvement must avoid workspace-to-workspace exposure.'
        ]),
        section('File access and signed URLs', [
            'Where private files need to be downloaded, signed URLs or equivalent short-lived access should be used. Public file links should be avoided for customer data unless they are intentionally public assets.'
        ]),
        section('Deletion and retention relationship', [
            'Security and retention are linked. Keeping less raw data reduces exposure. Users should be able to request deletion of workspace data, and retention windows should be minimized where practical.'
        ]),
        section('Incident response approach', items=[
            'If a secret or customer file is exposed, rotate credentials promptly.',
            'Review access logs and storage paths after an incident.',
            'Limit blast radius by keeping customer data private by default.',
            'Document corrective action before expanding paid usage.'
        ]),
        section('Current limitations', [
            'The current bearer-token admin model is appropriate for a manual concierge beta but still requires operational discipline. It does not replace full user authentication, scoped authorization, or mature audit logging.'
        ]),
        section('Future improvements', items=[
            'Stronger user auth and workspace-scoped access.',
            'More complete audit logging for admin actions.',
            'Lifecycle cleanup for temporary raw uploads and artifacts.',
            'Clearer retention tooling and deletion workflows.'
        ]),
        section('Contact / review note', [
            'This document is an operational policy for product and engineering review. It is intentionally conservative and may be refined as the paid beta matures.'
        ]),
    ]


def doc_retention() -> list[str]:
    return [
        section('Purpose and scope', [
            'This policy explains what Gnomeo stores temporarily, what it may retain, and why the product keeps analytical memory instead of raw exports forever. The intent is to support recurring reviews without becoming a raw ad-data warehouse.'
        ]),
        section('Data minimization principle', [
            'Gnomeo should keep less raw data whenever practical. The system is intended to preserve the minimum information needed to provide useful analysis, recurring reviews, and workspace continuity.'
        ]),
        section('Data categories', items=[
            'Temporary data: raw CSV uploads, parsed processing files, temporary report artifacts.',
            'Persistent data: generated reports, workspace memory, analytical summaries, trend snapshots, recommendation history, preferences, and usage/billing metadata where applicable.'
        ]),
        section('Temporary data', items=[
            'Raw CSV uploads are retained only temporarily for processing, support, and limited reruns.',
            'A practical paid-tier target is up to 7 days unless deleted earlier.',
            'Temporary parsed files should be deleted within 24 hours where possible.',
            'Temporary artifacts should not be used as a long-term storage layer.'
        ]),
        section('Persistent analytical data', items=[
            'Generated reports.',
            'Workspace memory and preferences.',
            'Analytical summaries and trend snapshots.',
            'Recommendation history.',
            'Usage and billing metadata where applicable.'
        ]),
        section('Why Gnomeo keeps analytical memory', [
            'Recurring reviews become more useful when Gnomeo can remember prior findings, compare trends, and track which recommendations repeat. That memory should come from summaries, derived metrics, recommendation history, and trend snapshots — not indefinite storage of raw CSV exports.'
        ]),
        section('Generated reports', [
            'Generated reports are intended to persist until a user or customer requests deletion, the workspace is removed, or the account closes. Reports are part of the analytical record and are distinct from raw CSV uploads.'
        ]),
        section('Workspace memory', [
            'Workspace memory stores the context needed for recurring reviews: business type, goals, constraints, notes, and historical recommendations. This improves continuity while keeping raw export retention low.'
        ]),
        section('Recommendation history and trend snapshots', [
            'Recommendation history and trend snapshots are derived data. They are intentionally kept so Gnomeo can show recurring patterns, budget changes, and platform tradeoffs over time without needing to preserve every raw upload.'
        ]),
        section('Usage and billing metadata', [
            'Usage events and billing metadata may be retained where applicable for operational, support, or accounting reasons. These records should stay lightweight and should not contain raw CSV contents.'
        ]),
        section('Backups and operational logs', [
            'Backups and logs may have limited operational retention. They should not become a shadow archive of raw customer uploads. The principle is to keep the shortest practical retention window that still supports service reliability and incident response.'
        ]),
        section('Deletion requests and account closure', items=[
            'Users should be able to request deletion of workspace data and raw uploads.',
            'Deletion workflows should cover persistent workspace data where applicable.',
            'Account closure should trigger cleanup where operationally possible.',
            'Backups and logs may have separate limited retention windows.'
        ]),
        section('GDPR-aware operating principles', [
            'This policy is designed to support data minimization, purpose limitation, and deletion handling. It avoids overclaiming legal compliance while keeping the retention model transparent and practical.'
        ]),
        section('Current limitations', [
            'Exact operational retention may evolve as the product matures. The important principle is that Gnomeo should not keep raw uploads longer than necessary.'
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
            'This policy explains how Gnomeo uses AI-assisted analysis and how data may be used to improve the product without turning the service into a raw-data warehouse. It applies to customer workspaces, uploaded exports, and derived operational patterns.'
        ]),
        section('How Gnomeo uses AI', [
            'Gnomeo uses AI-assisted analysis to help generate reports and recommendations from uploaded ad exports and workspace context. The goal is to produce readable analyst-style output that helps users understand waste, weak signal, budget allocation, and platform tradeoffs.'
        ]),
        section('Human-readable report generation', [
            'The product is intended to turn imported data into human-readable narrative reports. AI is used to support that analysis, but workspace context and business judgment remain important parts of the workflow.'
        ]),
        section('Customer workspace privacy', [
            'Customer workspaces remain private by default. Raw uploads are not sold or publicly shared. Gnomeo does not claim ownership of customer ad accounts or uploaded exports.'
        ]),
        section('Raw uploads and model training', [
            'Raw uploads are not used to train public foundation models. Gnomeo should not expose raw uploads from one customer to another, and raw exports should not be republished or reused as public examples without clear permission.'
        ]),
        section('Aggregated and anonymized improvement', items=[
            'Gnomeo may use aggregated, anonymized, and non-identifiable operational patterns to improve report quality.',
            'Those patterns may help improve recommendation systems, benchmarking, weak-signal detection, platform reliability, and operational insight.',
            'Aggregate learning should not expose customer names, client names, campaign names, workspace details, or raw uploaded exports.'
        ]),
        section('Why limited aggregate learning helps', [
            'Gnomeo can become more useful over time by learning from broad, non-identifiable patterns such as common waste signals, weak-signal thresholds, fragmented budget patterns, platform tradeoffs, and recurring account issues. This should improve recommendations without turning Gnomeo into a raw ad-data warehouse.'
        ]),
        section('What we do not do', items=[
            'We do not sell raw customer uploads.',
            'We do not publish customer data.',
            'We do not expose one workspace to another.',
            'We do not use raw uploads to train public foundation models.',
            'We do not claim ownership of customer ad accounts or customer exports.',
            'We do not use individual customer data to create public customer-identifiable benchmarks.'
        ]),
        section('Affordability and product quality rationale', [
            'Limited aggregate learning helps keep the product useful and affordable for small businesses and agencies. The objective is better recommendations and better operational reliability, not a public dataset of customer uploads.'
        ]),
        section('GDPR-aware improvement principles', [
            'Any product-improvement use of data should prefer aggregated, anonymized, and non-identifiable signals. The policy is designed to support privacy-aware product improvement with minimal exposure of individual workspace data.'
        ]),
        section('Future privacy controls', [
            'Future controls may allow stricter opt-outs or immediate raw-deletion modes for customers that want the narrowest possible retention profile.'
        ]),
        section('Current limitations', [
            'This policy is intentionally conservative and may evolve as the paid beta matures. It is designed to be clear about what the product intends to do and what it does not do.'
        ]),
        section('Review and updates', [
            'Policy updates should remain consistent with the core promise: workspace data stays private by default, raw uploads are temporary, and improvement learning must remain aggregated and non-identifiable.'
        ]),
    ]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    docs = {
        'security-and-data-protection.pdf': (
            'Gnomeo Security & Data Protection Policy',
            'Formal guidance on how Gnomeo protects uploaded ad data, generated reports, workspace context, and manual admin operations.',
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
