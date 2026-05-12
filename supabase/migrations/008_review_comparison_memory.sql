-- Comparison-aware review memory for recurring portal reviews.
-- Additive only: no drops, no deletes, no RLS weakening.

begin;

alter table public.report_runs
  add column if not exists comparison_summary jsonb not null default '{}'::jsonb;

alter table public.workspaces
  add column if not exists changed_since_last_review jsonb not null default '[]'::jsonb,
  add column if not exists still_unresolved jsonb not null default '[]'::jsonb,
  add column if not exists likely_actioned_or_improved jsonb not null default '[]'::jsonb,
  add column if not exists new_this_time jsonb not null default '[]'::jsonb,
  add column if not exists top_actions_now jsonb not null default '[]'::jsonb,
  add column if not exists previous_recommendations_status jsonb not null default '[]'::jsonb,
  add column if not exists comparison_note text;

comment on column public.report_runs.comparison_summary is 'Derived comparison summary between the current and previous portal review.';
comment on column public.workspaces.changed_since_last_review is 'Comparison highlights for the latest portal review.';
comment on column public.workspaces.still_unresolved is 'Items that still appear open after the latest comparison.';
comment on column public.workspaces.likely_actioned_or_improved is 'Items that appear improved, reduced, or no longer visible.';
comment on column public.workspaces.new_this_time is 'New segments, shifts, or risks detected in the latest comparison.';
comment on column public.workspaces.top_actions_now is 'Current operational actions to change now.';
comment on column public.workspaces.previous_recommendations_status is 'Conservative status tracking for previous recommendations.';
comment on column public.workspaces.comparison_note is 'Short comparison note for the latest review.';

notify pgrst, 'reload schema';

commit;
