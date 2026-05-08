# Security Policy

## Core rules

- Admin routes must be protected before new admin APIs are promoted.
- `ADMIN_SECRET` is required for `/api/admin/*` in production.
- The service-role key stays server-side only.
- No secrets in git.
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
