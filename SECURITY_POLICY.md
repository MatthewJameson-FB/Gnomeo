# Security Policy

## Core rules

- Admin portal pages are protected separately from admin APIs.
- `/admin/*` requires admin session access.
- `/api/admin/*` requires server-side admin authorization.
- `ADMIN_SECRET` stays server-side only.
- The service-role key stays server-side only.
- No secrets in git, frontend code, or URLs.
- Customer data must stay in private buckets.
- Use signed URLs only for private file access.
- Preserve workspace isolation.
- Do not log raw CSV contents.
- Do not publish customer report URLs.
- Review dependencies and security behavior before paid launch.

## Incident basics

- Rotate exposed secrets immediately.
- Revoke access and review logs if customer data is exposed.
- Limit blast radius by keeping storage private and server-side.
