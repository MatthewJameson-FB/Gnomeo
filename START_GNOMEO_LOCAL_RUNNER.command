#!/bin/bash

REPO_ROOT="/Users/matthewjameson/Gnomeo"
APP_PATH="$REPO_ROOT/agent_mvp/admin_report_tool/app.py"
TEMPLATE_PATH="$REPO_ROOT/agent_mvp/report_email_template.txt"
AGENT_PATH="$REPO_ROOT/agent_mvp/agent_test.py"
INDEX_TEMPLATE_PATH="$REPO_ROOT/agent_mvp/admin_report_tool/templates/index.html"

fail() {
  printf '\n%s\n' "$1"
  printf 'Press any key to close this window...'
  IFS= read -r -n 1 -s _ </dev/tty || true
  printf '\n'
  exit 1
}

printf 'Starting Gnomeo Local Runner\n'
printf 'Repository: %s\n' "$REPO_ROOT"

cd "$REPO_ROOT" || fail "Could not change into $REPO_ROOT"
if [ "$(pwd)" != "$REPO_ROOT" ]; then
  fail "Repository path check failed. Expected $REPO_ROOT but found $(pwd)."
fi

for required in "$APP_PATH" "$TEMPLATE_PATH" "$AGENT_PATH" "$INDEX_TEMPLATE_PATH"; do
  [ -f "$required" ] || fail "Missing required file: $required"
done

if [ -z "${RESEND_API_KEY:-}" ]; then
  fail "RESEND_API_KEY is not set. Export it in this shell or configure it locally before starting the runner."
fi

PYTHON_BIN=""
for candidate in \
  "$REPO_ROOT/agent_mvp/admin_report_tool/.venv/bin/python3" \
  "$REPO_ROOT/agent_mvp/admin_report_tool/.venv/bin/python" \
  "$REPO_ROOT/.venv/bin/python3" \
  "$REPO_ROOT/.venv/bin/python"; do
  if [ -x "$candidate" ]; then
    PYTHON_BIN="$candidate"
    printf 'Using virtual environment: %s\n' "$candidate"
    break
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
  [ -n "$PYTHON_BIN" ] || fail "python3 was not found on PATH. Install Python 3 or activate a virtual environment."
  printf 'No virtual environment found; using python3 at %s\n' "$PYTHON_BIN"
fi

printf 'Launching local report tool on http://localhost:5050\n'
printf 'Tip: keep RESEND_API_KEY available in this shell so email sending can succeed.\n\n'

"$PYTHON_BIN" "$APP_PATH"
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  printf '\nGnomeo Local Runner exited with status %s.\n' "$EXIT_CODE"
  printf 'Press any key to close this window...'
  IFS= read -r -n 1 -s _ </dev/tty || true
  printf '\n'
fi

exit "$EXIT_CODE"