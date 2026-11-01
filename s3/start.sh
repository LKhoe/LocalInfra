#!/bin/sh
# Starts Garage as a single-node cluster (layout configured automatically).
#  - Waits until S3_DATA_DIR holds the marker file, then links /data to it. At boot Docker can
#    start this container before umbrelOS mounts the external drive; compose mounts the parent
#    folder with rslave propagation, so the drive appears here once it is mounted. Garage never
#    runs against an empty folder on the SD card.
#  - Buckets and per-project keys are created by scripts/new-project.sh --s3.
set -eu

: "${S3_DATA_DIR:?S3_DATA_DIR must be set}"
: "${GARAGE_RPC_SECRET:?GARAGE_RPC_SECRET must be set}"
: "${GARAGE_ADMIN_TOKEN:?GARAGE_ADMIN_TOKEN must be set}"

MARKER="$S3_DATA_DIR/.localinfra-s3-target"

waited=0
until [ -f "$MARKER" ]; do
  # log once a minute, not every poll
  if [ $((waited % 60)) -eq 0 ]; then
    echo "[s3] waiting for $MARKER - is the external drive mounted? Not starting."
  fi
  sleep 5
  waited=$((waited + 5))
done
echo "[s3] external drive found, starting"

ln -sfn "$S3_DATA_DIR" /data

mkdir -p /data/meta /data/blocks

exec garage server --single-node
