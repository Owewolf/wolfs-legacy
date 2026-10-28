#!/usr/bin/env bash
set -euo pipefail
# Every app/mail writer must be stopped for database-plus-files consistency.
if [[ "${1:-}" != '--service-stopped' || -z "${2:-}" || $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: DOCUMENT_STORAGE_ROOT=/verified/documents scripts/backup-managed.sh --service-stopped /new/external/snapshot [/effective-unit.txt]' >&2
  exit 2
fi
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
documents_dir="${DOCUMENT_STORAGE_ROOT:-/srv/data/files/legacy-vault-managed-documents}"
recovery_args=(backup --service-stopped "$app_dir" "$documents_dir" "$2")
if [[ $# -eq 3 ]]; then recovery_args+=("$3"); fi
exec node "$app_dir/scripts/managed-recovery.js" "${recovery_args[@]}"
