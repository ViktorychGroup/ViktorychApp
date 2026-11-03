#!/bin/sh
# Run the Page smoke scripts together.
#   scripts/smoke-all.sh                 full suite, several scripts at once
#   scripts/smoke-all.sh --jobs 4        how many scripts run at once
#   scripts/smoke-all.sh --changed       only scripts that cover files changed since origin/main
#   scripts/smoke-all.sh --shard signup  one CI shard
# CI always runs every shard. --changed is local only.
set -eu
cd "$(dirname "$0")/.."
exec node scripts/smoke_run.mjs "$@"
