#!/bin/bash
# Wrapper that sources admin creds from ~/.config/elmspark/dev-admin.env
# then runs the Playwright suite. Pass any args through to `playwright test`.
#
# Usage:
#   ./run-tests.sh                          # run all tests
#   ./run-tests.sh tests/ep-local-business* # run a subset
#   ./run-tests.sh --headed                 # show the browser
#   ./run-tests.sh --ui                     # open the Playwright UI runner
set -e

CREDS=~/.config/elmspark/dev-admin.env
if [ ! -f "$CREDS" ]; then
	cat <<EOF >&2
Error: $CREDS does not exist.

Create it with:
  mkdir -p ~/.config/elmspark
  chmod 700 ~/.config/elmspark
  cat > $CREDS <<INNER
DEV_ADMIN_USER=claude_code
DEV_ADMIN_PASSWORD=<paste the current dev.elmspark.com claude_code password>
INNER
  chmod 600 $CREDS

These credentials are read at test time only; they are never committed
or written to any tmp file. Rotate the dev admin password independently;
update this file when you do.
EOF
	exit 1
fi

set -a
# shellcheck disable=SC1090
source "$CREDS"
set +a

cd "$(dirname "$0")"
exec npx playwright test "$@"
