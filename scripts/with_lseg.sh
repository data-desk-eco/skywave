#!/usr/bin/env bash
# Wrapper that pulls LSEG creds from Google Secret Manager (the same
# `lseg-env` secret the Research repos use) and exports them before
# running the given command. Mirrors the behaviour of the worker's
# wrangler secrets — single source of truth.
#
# Usage:
#   ./scripts/with_lseg.sh node scripts/tdoa_watch.mjs --region english-channel
#
# Requires: gcloud authenticated to project data-desk-web.

set -euo pipefail

ENV=$(gcloud secrets versions access latest --secret=lseg-env --project=data-desk-web 2>/dev/null) || {
  echo "with_lseg: failed to fetch lseg-env secret. Run 'gcloud auth login' and 'gcloud config set project data-desk-web'." >&2
  exit 1
}
# Each line is KEY=VALUE; export them.
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  export "$line"
done <<< "$ENV"

exec "$@"
