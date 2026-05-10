-- Workspace memory / handover context for the beta portal.
--
-- Notes:
-- - Service-role/admin code can bypass RLS server-side.
-- - No anon/public policies are created here.
-- - Workspace memory stores derived analytical context only, not raw CSV rows.

begin;

alter table public.workspaces
  add column if not exists memory_summary jsonb not null default '{}'::jsonb,
  add column if not exists recurring_issues jsonb not null default '[]'::jsonb,
  add column if not exists open_recommendations jsonb not null default '[]'::jsonb,
  add column if not exists trend_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists next_review_focus jsonb not null default '[]'::jsonb,
  add column if not exists last_handover_at timestamptz;

create index if not exists idx_workspaces_last_handover_at on public.workspaces (last_handover_at desc nulls last);

comment on column public.workspaces.memory_summary is 'Derived workspace memory summary for the beta portal.';
comment on column public.workspaces.recurring_issues is 'Recurring risks or signal issues derived from report runs.';
comment on column public.workspaces.open_recommendations is 'Recommendations still open in the workspace memory.';
comment on column public.workspaces.trend_snapshot is 'Compact trend snapshot retained across report runs.';
comment on column public.workspaces.next_review_focus is 'Next review prompts retained for the workspace.';
comment on column public.workspaces.last_handover_at is 'When the workspace memory was last updated.';

commit;
