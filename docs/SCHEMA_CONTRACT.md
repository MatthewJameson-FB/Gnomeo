# Schema Contract

Internal developer note for the manual beta flow.

## Reconcile migration

- `supabase/migrations/007_schema_reconcile_portal_beta.sql`
- `supabase/migrations/008_review_comparison_memory.sql`
- Apply pending Supabase migrations manually before production beta testing.
- Run the admin Beta Readiness / Schema Health check before customer portal testing.

## Required tables

- `profiles` — admin-created customer profiles.
- `workspaces` — private portal workspace state, portal token fields, and workspace memory.
- `report_runs` — generated reports, portal history, and report metadata.
- `usage_events` — operational telemetry only.
- `beta_requests` — manual beta intake and workspace linkage.
- `portal_review_submissions` — portal upload queue / review history.

## Required columns

### profiles
- `id`, `email`, `created_at`

### workspaces
- `id`, `profile_id`, `owner_email`, `workspace_name`, `business_type`, `primary_goal`, `risk_appetite`, `budget_constraint`, `notes`, `plan`, `status`, `created_at`, `updated_at`
- `portal_token_hash`, `portal_token_created_at`, `portal_token_last_used_at`, `portal_token_revoked_at`
- `memory_summary`, `recurring_issues`, `open_recommendations`, `trend_snapshot`, `next_review_focus`, `last_handover_at`
- `changed_since_last_review`, `still_unresolved`, `likely_actioned_or_improved`, `new_this_time`, `top_actions_now`, `previous_recommendations_status`, `comparison_note`
- `beta_request_id`, `website`, `platforms`, `review_goal`, `is_agency`

### report_runs
- `id`, `workspace_id`, `status`, `source_count`, `platforms`, `spend_analysed`, `revenue_analysed`, `roas`, `wasted_spend`, `report_url`, `report_html_path`, `created_at`, `deleted_at`
- `report_title`, `report_content`, `report_markdown`, `source_platforms`, `source_filenames`, `row_count`, `input_bytes`, `summary`
- `top_recommendations`, `trend_snapshot`, `sources`, `top_priorities`, `recommendations`, `trend_notes`, `completed_at`, `error_message`, `metadata`
- `comparison_summary`
- Portal queries exclude soft-deleted report runs.

### usage_events
- `id`, `workspace_id`, `event_type`, `plan`, `metadata`, `created_at`

### beta_requests
- `id`, `created_at`, `name`, `email`, `company`, `website`, `platforms`, `monthly_spend_range`, `is_agency`, `review_goal`, `notes`, `status`, `source`, `consent_at`
- `workspace_id`, `workspace_created_at`, `portal_link_created_at`

### portal_review_submissions
- `id`, `created_at`, `workspace_id`, `status`, `filenames`, `platforms`, `file_count`, `report_run_id`, `completed_at`, `notes`, `deleted_at`
- Portal queries exclude soft-deleted review submissions.

## Feature mapping

- Beta intake: `beta_requests`
- Workspace creation + portal token issuance: `workspaces`, `beta_requests`, `profiles`
- Portal upload queue: `portal_review_submissions`
- Portal report generation/history: `report_runs`
- Workspace memory/handover: `workspaces`
- Operational telemetry: `usage_events`

## Admin readiness check

Use `/api/admin?action=schema-health` from the protected admin portal.

It reports:
- table/column presence
- required env var presence
- whether the beta flow is ready for testing

## Comparison-aware portal reviews

- First review establishes the baseline.
- Later reviews compare against the previous review and save the comparison summary on the report run.
- The workspace keeps the latest comparison highlights for the portal UI.

## Notes

- Do not expose schema health publicly.
- Keep the schema changes additive.
- Preserve the queued fallback when report generation cannot finish immediately.
