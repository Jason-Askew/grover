#!/usr/bin/env bash
# Sync corpus files and database seed dumps to/from S3.
#
# Usage:
#   ./scripts/s3-sync.sh <command>
#
# Commands:
#   push-corpus   Upload local corpus/ to S3
#   pull-corpus   Download S3 corpus to local corpus/
#   push-seed     Create pg_dump and upload as dumps/grover-seed.dump
#   pull-seed     Download seed dump to config/grover-seed.dump
#
# Environment:
#   GROVER_S3_BUCKET  S3 bucket name (required)
#   GROVER_DIR        Project root (default: script's parent directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GROVER_DIR="${GROVER_DIR:-$(dirname "$SCRIPT_DIR")}"
BUCKET="${GROVER_S3_BUCKET:-}"

if [[ -z "$BUCKET" ]]; then
  echo "ERROR: GROVER_S3_BUCKET not set."
  echo "  export GROVER_S3_BUCKET=your-bucket-name"
  exit 1
fi

command="${1:-}"
if [[ -z "$command" ]]; then
  echo "Usage: $0 <push-corpus|pull-corpus|push-seed|pull-seed>"
  exit 1
fi

case "$command" in
  push-corpus)
    echo "Uploading corpus to s3://${BUCKET}/corpus/ ..."
    aws s3 sync "${GROVER_DIR}/corpus/" "s3://${BUCKET}/corpus/" --delete --quiet
    echo "Done. Corpus pushed to S3."
    ;;

  pull-corpus)
    echo "Downloading corpus from s3://${BUCKET}/corpus/ ..."
    mkdir -p "${GROVER_DIR}/corpus"
    aws s3 sync "s3://${BUCKET}/corpus/" "${GROVER_DIR}/corpus/" --quiet
    echo "Done. Corpus pulled from S3."
    ;;

  push-seed)
    DUMP_FILE="/tmp/grover-seed-$$.dump"
    echo "Creating database dump..."
    cd "$GROVER_DIR"
    docker compose exec -T postgres pg_dump -U grover -Fc grover > "$DUMP_FILE"

    DUMP_SIZE=$(stat --printf="%s" "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
    echo "Dump created: $(( DUMP_SIZE / 1024 / 1024 )) MB"

    echo "Uploading to s3://${BUCKET}/dumps/grover-seed.dump ..."
    aws s3 cp "$DUMP_FILE" "s3://${BUCKET}/dumps/grover-seed.dump" --quiet
    rm -f "$DUMP_FILE"
    echo "Done. Seed dump pushed to S3."
    ;;

  pull-seed)
    echo "Downloading seed from s3://${BUCKET}/dumps/grover-seed.dump ..."
    mkdir -p "${GROVER_DIR}/config"
    aws s3 cp "s3://${BUCKET}/dumps/grover-seed.dump" "${GROVER_DIR}/config/grover-seed.dump" --quiet
    echo "Done. Seed dump saved to config/grover-seed.dump"
    ;;

  *)
    echo "Unknown command: $command"
    echo "Usage: $0 <push-corpus|pull-corpus|push-seed|pull-seed>"
    exit 1
    ;;
esac
