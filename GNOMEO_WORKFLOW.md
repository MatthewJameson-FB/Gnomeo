# Gnomeo Workflow

## Source of truth
- Active repo: `~/Gnomeo` only.
- Do not use `~/.openclaw/workspace/Gnomeo` for production work.

## Homepage
- Production homepage entry file: `index.html` at repo root.
- Static assets live in `public/`.

## Reports
- Generated reports belong in `free_reports/output/`.
- Treat `agent_mvp/output_report.*` as generated artifacts, not source files.

## Local workflow
- Run the local report UI via `START_GNOMEO_LOCAL_RUNNER.command`.
- Never use `git add .`; stage only intentional files.
- Keep commits tight and intentional.

## Starting the local runner from Desktop
- Run `scripts/install_local_runner_desktop_shortcut.sh` once.
- Then double-click `Gnomeo Local Runner.command` on the Desktop.
- This launcher is local-only and is not part of production deployment.

## Local secrets
- Create a git-ignored `.env.local` in the repo root.
- Add `ADMIN_SECRET` and `RESEND_API_KEY` there.
- Use `.env.example` as the template.
- Never commit `.env.local`.
- Vercel still needs `ADMIN_SECRET` configured separately for Preview and Production.

## Manual beta self-serve portal flow
- Admin creates a workspace and issues a private portal link.
- Admin sends the link to the customer.
- Customer opens `portal.html?token=...`, uploads CSV exports, and generates a server-side report.
- Reports appear in the portal with history and trend context.
- Raw uploads are temporary and should be cleaned up after processing.
- Full login/auth comes later.

## Workspace memory / handover
- After each report, retain a compact workspace memory summary.
- Keep current state, recurring issues, open recommendations, trend snapshot, and next review focus.
- This is derived analytical context, not raw CSV storage.
- It helps the next review pick up unresolved risks and recurring patterns.
- Full login/auth comes later.
