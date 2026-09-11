#!/usr/bin/env sh
# Host provisioning is deliberately separate from read-only doctor checks.
set -eu
umask 077
accept=0
case "${1:-}" in
  --yes) accept=1 ;;
  '') ;;
  --help) printf 'Usage: ops/install-dependencies.sh [--yes]\nInstalls missing Docker/Compose/Buildx and OpenSSL on Ubuntu 24.04/26.04.\n'; exit 0 ;;
  *) printf 'Unknown dependency option\n' >&2; exit 2 ;;
esac
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'Automatic provisioning requires Ubuntu Linux.'
# Read fixed fields as data, never source OS metadata as shell code.
os_id=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
os_version=$(awk -F= '$1 == "VERSION_ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
[ "$os_id" = ubuntu ] || fail 'Automatic provisioning supports Ubuntu only; install prerequisites manually.'
case "$os_version" in
  24.04) codename=noble ;;
  26.04) codename=resolute ;;
  *) fail 'Automatic provisioning supports Ubuntu 24.04 and 26.04 only.' ;;
esac
case "$(uname -m)" in
  x86_64|aarch64|amd64|arm64) ;;
  *) fail 'Automatic provisioning supports amd64 and arm64 only.' ;;
esac
command -v apt-get >/dev/null 2>&1 || fail 'apt-get is required.'
command -v dpkg-query >/dev/null 2>&1 || fail 'dpkg-query is required.'
need_docker=0
need_compose=0
need_buildx=0
need_openssl=0
command -v docker >/dev/null 2>&1 || need_docker=1
docker compose version >/dev/null 2>&1 || need_compose=1
docker buildx version >/dev/null 2>&1 || need_buildx=1
command -v openssl >/dev/null 2>&1 || need_openssl=1
[ "$need_docker$need_compose$need_buildx$need_openssl" != 0000 ] || { printf 'Host prerequisites already available.\n'; exit 0; }
# Never replace distro Docker, Podman, containerd, or runc behind an operator's back.
if [ "$need_docker$need_compose$need_buildx" != 000 ]; then
  for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
      fail "Existing ${package} package requires manual prerequisite installation; no packages were removed."
    fi
  done
  if [ "$need_docker" -eq 0 ] && ! dpkg-query -W -f='${Status}' docker-ce 2>/dev/null | grep -q '^install ok installed$'; then
    fail 'Unmanaged Docker installation detected; install missing plugins manually.'
  fi
fi
printf 'Host prerequisite plan (existing packages and containers are preserved):\n'
printf '  Install missing OpenSSL and Docker Engine/Compose/Buildx as needed.\n'
printf '  Use the official Docker Ubuntu repository; no distribution upgrade.\n'
[ "$need_docker" -eq 0 ] || printf '  Enable and start the new Docker service.\n'
if [ "$accept" -eq 0 ]; then
  [ -r /dev/tty ] || fail 'Use --yes to approve host provisioning without a terminal.'
  printf 'Install these prerequisites? [y/N]: ' >/dev/tty
  answer=
  read -r answer </dev/tty || fail 'Confirmation requires a terminal; use --yes.'
  case "$answer" in y|Y|yes|YES) ;; *) fail 'Prerequisite installation declined.' ;; esac
fi
root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -- "$@"; fi
}
[ "$(id -u)" -eq 0 ] || command -v sudo >/dev/null 2>&1 || fail 'Run as root or install sudo.'
if [ "$need_docker$need_compose$need_buildx" != 000 ]; then
  # Do not overwrite repository configuration installed by the operator.
  for source in /etc/apt/sources.list.d/*; do
    [ -f "$source" ] || continue
    if grep -q 'download.docker.com' "$source"; then
      repository_ready=1
      break
    fi
  done
  if [ "${repository_ready:-0}" -eq 0 ]; then
    root apt-get update
    root apt-get install -y --no-remove ca-certificates curl
    root install -m 0755 -d /etc/apt/keyrings
    key=$(mktemp)
    source_file=$(mktemp)
    trap 'rm -f "$key" "$source_file"' 0
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://download.docker.com/linux/ubuntu/gpg -o "$key"
    [ -s "$key" ] || fail 'Docker signing key download was empty.'
    [ ! -e /etc/apt/keyrings/shelter-docker.asc ] && [ ! -L /etc/apt/keyrings/shelter-docker.asc ] || fail 'Shelter Docker key path already exists; review it manually.'
    [ ! -e /etc/apt/sources.list.d/shelter-docker.sources ] && [ ! -L /etc/apt/sources.list.d/shelter-docker.sources ] || fail 'Shelter Docker repository path already exists; review it manually.'
    printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/shelter-docker.asc\n' "$codename" "$(dpkg --print-architecture)" > "$source_file"
    root install -m 0644 "$key" /etc/apt/keyrings/shelter-docker.asc
    root install -m 0644 "$source_file" /etc/apt/sources.list.d/shelter-docker.sources
  fi
fi
set --
[ "$need_openssl" -eq 0 ] || set -- "$@" openssl
[ "$need_docker" -eq 0 ] || set -- "$@" docker-ce docker-ce-cli containerd.io
[ "$need_compose" -eq 0 ] || set -- "$@" docker-compose-plugin
[ "$need_buildx" -eq 0 ] || set -- "$@" docker-buildx-plugin
root apt-get update
root apt-get install -y --no-remove "$@"
[ "$need_docker" -eq 0 ] || root systemctl enable --now docker
printf 'Prerequisites installed. Docker access is checked by the Shelter installer.\n'
