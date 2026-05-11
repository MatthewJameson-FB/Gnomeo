# Retention Policy

## Core rules

- Raw upload retention should be minimized.
- Paid-tier raw upload target: up to 7 days unless deleted earlier.
- Temporary parsed artifacts should be deleted within 24 hours where possible.
- Generated reports, workspace memory, and trend history persist until deletion or account closure.
- Raw CSV uploads for portal reviews should be temporary and deleted after processing where possible.
- Portal review queue records may retain filenames, detected platforms, file counts, status, and linked report ids, but not raw CSV contents.
- Beta request records are onboarding data and may be retained for manual review, but should stay separate from raw CSV uploads.
- Handle deletion requests promptly.
- A cleanup job should exist for temporary files and stale uploads.
- Backups and logs may retain data for limited operational reasons only.
- Avoid retaining more raw data than needed.
