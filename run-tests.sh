#!/bin/bash
# Wrapper that sources admin creds from ~/.config/elmspark/dev11b-admin.env
# then runs the Playwright suite. Pass any args through to `playwright test`.
#
# Usage:
#   ./run-tests.sh                          # run all tests
#   ./run-tests.sh tests/ep-local-business* # run a subset
#   ./run-tests.sh --headed                 # show the browser
#   ./run-tests.sh --ui                     # open the Playwright UI runner
#
# Credentials: dev11b-admin.env, NOT dev-admin.env. The latter holds the
# password for the retired dev.elmspark.com and dev11b rejects it with
# invalid_credentials, which surfaces as a confusing "#pm-login still present"
# assertion failure in fixtures/auth.ts rather than as a login error. The
# emptiness guard below exists so that mistake fails loudly next time.
set -e

CREDS=~/.config/elmspark/dev11b-admin.env
if [ ! -f "$CREDS" ]; then
	cat <<EOF >&2
Error: $CREDS does not exist.

Create it with:
  mkdir -p ~/.config/elmspark
  chmod 700 ~/.config/elmspark
  cat > $CREDS <<INNER
DEV_ADMIN_USER=claude_code
DEV_ADMIN_PASSWORD=<paste the current dev11b.elmspark.com claude_code password>
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

if [ -z "$DEV_ADMIN_USER" ] || [ -z "$DEV_ADMIN_PASSWORD" ]; then
	echo "Error: $CREDS is missing DEV_ADMIN_USER and/or DEV_ADMIN_PASSWORD." >&2
	echo "Both must be set, or every test fails at login for a reason the" >&2
	echo "failure message will not name." >&2
	exit 1
fi

# dev.elmspark.com was retired 2026-08-20 and only 301-redirects here, so the
# old default made the suite pass through a dead name. Named explicitly;
# override by exporting DEV_BASE_URL before calling.
export DEV_BASE_URL="${DEV_BASE_URL:-https://dev11b.elmspark.com}"

cd "$(dirname "$0")"
exec npx playwright test "$@"
