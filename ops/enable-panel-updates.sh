#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

installation=/opt/shelter
[[ $(id -u) == 0 ]] || { echo 'Run this command as root on the Shelter VPS.' >&2; exit 1; }
[[ $# == 0 ]] || { echo 'Usage: ops/enable-panel-updates.sh' >&2; exit 2; }
[[ -d "$installation" && ! -L "$installation" && -f "$installation/.env" && ! -L "$installation/.env" ]] || exit 1
for tool in systemctl gh jq docker rsync openssl timeout flock; do
  command -v "$tool" >/dev/null || { echo "$tool is required before enabling panel updates." >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo 'Authenticate GitHub CLI as root first with gh auth login.' >&2; exit 1; }
source "$installation/ops/lib/release-bundle.sh"
shelter_release_load "$installation"
"$installation/install.sh" doctor
for directory in "$installation/.shelter-updates" "$installation/.shelter-updates/requests" "$installation/.shelter-updates/status"; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || exit 1
  install -d -m 0700 -o root -g root "$directory"
done
for file in /etc/systemd/system/shelter-updater.service /etc/systemd/system/shelter-updater.timer; do
  [[ ! -L "$file" && ( ! -e "$file" || -f "$file" ) ]] || exit 1
done
cat > /etc/systemd/system/shelter-updater.service <<'UNIT'
[Unit]
Description=Shelter verified panel update agent
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
WorkingDirectory=/opt/shelter
ExecStart=/bin/bash /opt/shelter/ops/panel-updater.sh
TimeoutStartSec=90min
UMask=0077
PrivateTmp=true
NoNewPrivileges=true
UNIT
cat > /etc/systemd/system/shelter-updater.timer <<'UNIT'
[Unit]
Description=Process Shelter panel update requests

[Timer]
OnBootSec=30s
OnUnitInactiveSec=5s
AccuracySec=1s
Unit=shelter-updater.service

[Install]
WantedBy=timers.target
UNIT
chmod 0644 /etc/systemd/system/shelter-updater.service /etc/systemd/system/shelter-updater.timer
systemctl daemon-reload
systemctl enable --now shelter-updater.timer
systemctl start shelter-updater.service
echo 'Panel updates enabled. Disable with systemctl disable --now shelter-updater.timer.'
