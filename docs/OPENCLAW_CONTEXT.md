# OpenClaw Context

## Working assumptions
Use this repo as the active Gnomeo workspace for OpenClaw sessions.

### Required paths and branch
- Active repo path: `/Users/matthewjameson/.openclaw/workspace/Gnomeo_ACTIVE`
- Branch: `add-logo-safe`
- Do not use `/Users/matthewjameson/.openclaw/workspace` itself for project work
- Do not use `Gnomeo_DO_NOT_USE`

### After OpenClaw pushes
Sync the real local repo with:
```bash
cd /Users/matthewjameson/Gnomeo
git pull origin add-logo-safe
```

## Product model to preserve
- private AI-assisted ad-spend review layer
- focused on what deserves attention
- calm, concise, analyst-style
- not a dashboard
- not an ad manager replacement
- not a BI tool
- not an AI optimisation engine

## Architecture guardrails
- privacy-first architecture
- token-scoped portal model
- admin/customer separation
- no frontend secrets
- no customer-facing `/api/admin` calls
- no raw CSV rows in memory/report summaries
- no raw page contents or screenshots stored/transmitted by the extension
- no broad extension permissions
- no background monitoring

## Portal posture
The portal is still important, but it is secondary to the extension-first review layer.
Keep it framed as:
- private review file
- saved reviews
- review history
- recurring memory
- deeper CSV paste/upload
- comparison against previous reviews
- token-scoped saves from the Chrome extension

## Extension posture
- primary future surface
- user-triggered only
- local visible DOM/table extraction
- no screenshots by default
- no OCR
- no OAuth yet
- no platform API integration yet
- optional private workspace save after user review

## Validation habits
When updating product docs:
- check for duplicate or conflicting claims
- grep for accidental secrets/tokens
- inspect git diff before committing

## Next tasks
- verify/fix Chrome extension injection on localhost fixtures
- manually test fixture extraction in normal Chrome
- improve extraction reliability across semantic table, ARIA grid, and div-based rows
- refine extension panel UX
- consolidate public site/pricing around the extension-first review layer
- later create Google Workspace email for `gnomeo.nl`
- later test in real Google Ads and Meta Ads accounts
