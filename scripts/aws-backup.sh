#!/usr/bin/env bash
# Daily PostgreSQL backup to S3.
# Run via cron: 0 2 * * * /home/ubuntu/grover/scripts/aws-backup.sh >> /var/log/grover-backup.log 2>&1
#
# Environment (set in crontab or shell profile):
#   GROVER_BACKUP_BUCKET  S3 bucket name (required)
#   GROVER_BACKUP_PREFIX  S3 key prefix (default: grover-backups)
#   GROVER_BACKUP_RETAIN  Days to keep backups (default: 14)

set -euo pipefail

GROVER_DIR="${GROVER_DIR:-$HOME/grover}"
BUCKET="${GROVER_BACKUP_BUCKET:-}"
PREFIX="${GROVER_BACKUP_PREFIX:-grover-backups}"
RETAIN_DAYS="${GROVER_BACKUP_RETAIN:-14}"
DATE=$(date +%Y%m%d-%H%M%S)
DUMP_FILE="/tmp/grover-backup-${DATE}.dump"

if [[ -z "$BUCKET" ]]; then
  echo "[$(date)] ERROR: GROVER_BACKUP_BUCKET not set. Skipping backup."
  exit 1
fi

echo "[$(date)] Starting backup..."

# Dump PostgreSQL using the running container
cd "$GROVER_DIR"
docker compose exec -T postgres pg_dump -U grover -Fc grover > "$DUMP_FILE"

DUMP_SIZE=$(stat --printf="%s" "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
echo "[$(date)] Dump created: ${DUMP_FILE} ($(( DUMP_SIZE / 1024 / 1024 )) MB)"

# Upload to S3
S3_KEY="s3://${BUCKET}/${PREFIX}/grover-${DATE}.dump"
aws s3 cp "$DUMP_FILE" "$S3_KEY" --quiet
echo "[$(date)] Uploaded to ${S3_KEY}"

# Also overwrite the latest seed dump
aws s3 cp "$DUMP_FILE" "s3://${BUCKET}/dumps/grover-seed.dump" --quiet
echo "[$(date)] Updated seed at s3://${BUCKET}/dumps/grover-seed.dump"

# Clean up local dump
rm -f "$DUMP_FILE"

# Prune old backups from S3
if [[ "$RETAIN_DAYS" -gt 0 ]]; then
  CUTOFF=$(date -d "-${RETAIN_DAYS} days" +%Y%m%d 2>/dev/null || date -v-${RETAIN_DAYS}d +%Y%m%d)
  echo "[$(date)] Pruning backups older than ${RETAIN_DAYS} days (before ${CUTOFF})..."
  aws s3 ls "s3://${BUCKET}/${PREFIX}/" | while read -r line; do
    FILE=$(echo "$line" | awk '{print $4}')
    # Extract date from filename: grover-YYYYMMDD-HHMMSS.dump
    FILE_DATE=$(echo "$FILE" | grep -oP '\d{8}' | head -1)
    if [[ -n "$FILE_DATE" && "$FILE_DATE" < "$CUTOFF" ]]; then
      echo "  Deleting: $FILE"
      aws s3 rm "s3://${BUCKET}/${PREFIX}/${FILE}" --quiet
    fi
  done
fi

echo "[$(date)] Backup complete."
