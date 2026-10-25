#!/usr/bin/env bash
set -euo pipefail
# Full managed documents backup: call only after stopping the service to ensure SQLite consistency.
APP="/home/wolf/Projects/legacy-vault"
DOCS="${DOCUMENT_STORAGE_ROOT:-}"
DEST="${1:-}"
if [[ -z "$DEST" || -z "$DOCS" ]]; then
  echo 'Usage: DOCUMENT_STORAGE_ROOT=/verified/documents scripts/backup-managed.sh /external/backup/folder' >&2
  exit 2
fi
[[ -d "$APP/data" && -d "$DOCS" && -d "$DEST" ]] || { echo 'A required directory is missing; backup aborted' >&2; exit 2; }
case "$DEST" in "$DOCS"|"$DOCS"/*|"$APP"|"$APP"/*) echo 'Backups must go to an independent destination' >&2; exit 2;; esac
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$DEST/legacy-vault-full-$stamp.tar.gz"
[[ ! -e "$archive" ]] || { echo 'Backup exists' >&2; exit 2; }
echo 'IMPORTANT: stop legacy-vault.service before running a consistency backup.'
# Archive explicit directories (including .secrets) without following symlinks.
tar -czf "$archive" -C /home/wolf/Projects legacy-vault/data legacy-vault/.env -C / "${DOCS#/}"
sha256sum "$archive" > "$archive.sha256"
tar -tzf "$archive" >/dev/null
printf 'Created and checked: %s\n' "$archive"
printf 'CHECK: test restoration to an isolated machine before relying on this backup.\n'
