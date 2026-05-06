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
- Run the local report UI via `START_GNOMEO.command`.
- Never use `git add .`; stage only intentional files.
- Keep commits tight and intentional.
