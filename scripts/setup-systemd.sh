#!/usr/bin/env bash
set -euo pipefail

# Render a unit by default. --install copies a reviewed unit but never starts it.
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
service_user="${SUDO_USER:-$(id -un)}"
node_path="$(command -v node || true)"
install_unit=false
check_unit=false

usage() {
  cat <<'USAGE'
Usage: bash scripts/setup-systemd.sh [--app-dir /absolute/checkout] [--user owner]
       [--node /absolute/node] [--check | --install]

Without --check/--install, prints wolfs-legacy.service for review.
--check validates a temporary generated unit with systemd-analyze.
--install requires root and installs the unit without enabling or starting it.
USAGE
}

while (($#)); do
  case "$1" in
    --app-dir|--user|--node)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in
        --app-dir) app_dir="$2" ;;
        --user) service_user="$2" ;;
        --node) node_path="$2" ;;
      esac
      shift 2 ;;
    --check) check_unit=true; shift ;;
    --install) install_unit=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if $install_unit && $check_unit; then
  echo 'Choose --check or --install' >&2
  exit 2
fi
[[ "$app_dir" == /* && -f "$app_dir/server/index.js" ]] || { echo 'Expected an absolute app checkout with server/index.js' >&2; exit 2; }
[[ "$node_path" == /* && -x "$node_path" ]] || { echo 'Expected an absolute executable Node path; use --node' >&2; exit 2; }
[[ "$service_user" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ && "$service_user" != root ]] || { echo 'Use an existing non-root service account via --user' >&2; exit 2; }
service_group="$(id -gn "$service_user")"

# Reject systemd expansion characters rather than accepting ambiguous paths.
for value in "$app_dir" "$node_path" "$service_group"; do
  if [[ "$value" == *[$'\n\r\t%$"\\']* || "$value" == *' '* ]]; then
    echo 'Service paths and group must not contain whitespace or systemd expansion characters' >&2
    exit 2
  fi
done

render_unit() {
  cat <<UNIT
[Unit]
Description=Wolf's Legacy encrypted vault and email workers
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=$service_user
Group=$service_group
WorkingDirectory=$app_dir
Environment=NODE_ENV=production
Environment=PORT=4444
Environment=TZ=Africa/Johannesburg
EnvironmentFile=$app_dir/.env
ExecStart=$node_path $app_dir/server/index.js
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
RestrictSUIDSGID=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
}

if $check_unit || $install_unit; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf -- "$temp_dir"' EXIT
  unit_file="$temp_dir/wolfs-legacy.service"
  render_unit > "$unit_file"
  systemd-analyze verify "$unit_file"
  if $install_unit; then
    ((EUID == 0)) || { echo '--install requires root' >&2; exit 2; }
    destination=/etc/systemd/system/wolfs-legacy.service
    if [[ -e "$destination" || -L "$destination" ]]; then
      # Refuse replacement: the existing unit may contain local restrictions.
      echo 'A unit already exists. Review and merge it explicitly; no files changed.' >&2
      exit 2
    fi
    install -m 0644 -- "$unit_file" "$destination"
    systemctl daemon-reload
    echo 'Installed wolfs-legacy.service. It has not been enabled or started.'
  fi
else
  render_unit
fi
