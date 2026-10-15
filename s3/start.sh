#!/bin/sh
# Starts Garage as a single-node cluster (layout configured automatically).
#  - Refuses to start unless /data holds the marker file: if the external drive isn't mounted,
#    Docker silently creates an empty folder on the SD card at S3_DATA_DIR instead, and Garage
#    would happily start an empty store there.
#  - Buckets and per-project keys are created by scripts/new-project.sh --s3.
set -eu

MARKER=/data/.localinfra-s3-target

if [ ! -f "$MARKER" ]; then
  echo "[s3] ERROR: $MARKER not found - is the external drive mounted? Not starting."
  exit 1
fi
: "${GARAGE_RPC_SECRET:?GARAGE_RPC_SECRET must be set}"
: "${GARAGE_ADMIN_TOKEN:?GARAGE_ADMIN_TOKEN must be set}"

mkdir -p /data/meta /data/blocks

exec garage server --single-node
