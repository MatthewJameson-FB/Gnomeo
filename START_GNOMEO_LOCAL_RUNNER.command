#!/bin/bash

set -u

REPO_ROOT="/Users/matthewjameson/Gnomeo"
APP_PATH="$REPO_ROOT/agent_mvp/admin_report_tool/app.py"
TEMPLATE_PATH="$REPO_ROOT/agent_mvp/report_email_template.txt"
AGENT_PATH="$REPO_ROOT/agent_mvp/agent_test.py"
INDEX_TEMPLATE_PATH="$REPO_ROOT/agent_mvp/admin_report_tool/templates/index.html"
ENV_FILE="$REPO_ROOT/.env.local"

fail() {
  printf '\n%s\n' "$1"
  printf 'Press any key to close this window...'
  IFS= read -r -n 1 -s _ </dev/tty || true
  printf '\n'
  exit 1
}

load_env_file() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*)
        continue
        ;;
      export\ *)
        line="${line#export }"
        ;;
    esac

    case "$line" in
      *=*)
        local key value
        key="${line%%=*}"
        value="${line#*=}"
        key="${key//[[:space:]]/}"

        case "$key" in
          ''|*[!A-Za-z0-9_]*|[0-9]*)
            continue
            ;;
        esac

        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
          value="${value:1:-1}"
        elif [[ "$value" == \"* ]]; then
          value="${value#\"}"
        elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
          value="${value:1:-1}"
        elif [[ "$value" == \'* ]]; then
          value="${value#\'}"
        fi

        export "$key=$value"
        ;;
    esac
  done < "$env_file"
}

printf 'Starting Gnomeo Local Runner\n'
printf 'Repository: %s\n' "$REPO_ROOT"

cd "$REPO_ROOT" || fail "Could not change into $REPO_ROOT"
if [ "$(pwd)" != "$REPO_ROOT" ]; then
  fail "Repository path check failed. Expected $REPO_ROOT but found $(pwd)."
fi

load_env_file "$ENV_FILE"

for required in "$APP_PATH" "$TEMPLATE_PATH" "$AGENT_PATH" "$INDEX_TEMPLATE_PATH"; do
  [ -f "$required" ] || fail "Missing required file: $required"
done

missing_vars=()
[ -n "${ADMIN_SECRET:-}" ] || missing_vars+=("ADMIN_SECRET")
[ -n "${RESEND_API_KEY:-}" ] || missing_vars+=("RESEND_API_KEY")

if [ "${#missing_vars[@]}" -ne 0 ]; then
  fail "Missing local env vars: ${missing_vars[*]}. Create $ENV_FILE from .env.example, add the values, and relaunch."
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
printf 'Loaded local secrets from .env.local if present.\n\n'

"$PYTHON_BIN" "$APP_PATH"
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  printf '\nGnomeo Local Runner exited with status %s.\n' "$EXIT_CODE"
  printf 'Press any key to close this window...'
  IFS= read -r -n 1 -s _ </dev/tty || true
  printf '\n'
fi

exit "$EXIT_CODE"
