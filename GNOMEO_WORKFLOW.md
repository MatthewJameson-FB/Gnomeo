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

## Manual beta onboarding flow
1. User requests workspace beta.
2. Admin reviews the request.
3. Admin creates the workspace.
4. Admin generates or copies the private portal link.
5. User opens the private portal link.
6. User uploads Google/Meta CSVs and runs a portal review.
7. The portal first tries a cloud-native JS report path.
8. If cloud generation fails, the review is queued and the user sees a calm received message.
9. Workspace memory updates over time.

Notes:
- Payment is manual / not automated yet.
- Stripe comes later.
- Full login/auth comes later.
- Privacy docs support the flow.
- Beta requests should not include raw ad exports.
- Raw uploads are temporary and should be cleaned up after processing.
- The customer portal should not show Python/runtime/internal infrastructure errors.
- Local Python runner remains an admin fallback only; it is not required for customer portal reviews.
- Consolidate API routes behind `/api/admin/*` and `/api/portal/*` rewrites so Hobby stays under the Vercel function cap.

## Admin beta request conversion
1. Open admin beta requests.
2. Review the request.
3. Click `Create workspace + portal link`.
4. Copy the private portal link.
5. Send it to the customer.
6. Customer runs reports from the portal.

Notes:
- The portal link is private.
- The token is separate from admin access.
- Raw uploads are not part of beta request intake.
- Stripe/auth comes later.

## Workspace memory / handover
- After each report, retain a compact workspace memory summary.
- Keep current state, recurring issues, open recommendations, trend snapshot, and next review focus.
- This is derived analytical context, not raw CSV storage.
- It helps the next review pick up unresolved risks and recurring patterns.
- Full login/auth comes later.
