#!/usr/bin/env sh
# Download this script from a trusted Shelter release before running it.
set -eu
umask 077
repository=raum-so/shelter
tag=
destination=/opt/shelter
accept=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag|--directory) [ "$#" -ge 2 ] || exit 2; case "$1" in --tag) tag=$2 ;; --directory) destination=$2 ;; esac; shift ;;
    --yes) accept=1 ;;
    --) shift; break ;;
    --help) printf 'Usage: bootstrap.sh [--tag vX.Y.Z] [--directory /opt/shelter] [--yes] [-- INSTALLER_OPTIONS...]\nInstalls the latest verified release by default. GitHub CLI authentication is required for attestations.\n'; exit 0 ;;
    *) printf 'Unknown bootstrap option\n' >&2; exit 2 ;;
  esac
  shift
done
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'Run this installer on your Ubuntu VPS.'
[ "$(id -u)" -eq 0 ] || fail 'Run with sudo or as root on your VPS.'
case "$destination" in /*) ;; *) fail 'The installation directory must be absolute.' ;; esac
case "$destination" in *[!A-Za-z0-9_./-]*|*..*|*/|/) fail 'Use a simple absolute installation directory without a trailing slash.' ;; esac
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail 'Destination already exists. Resume its install-release-bundle.sh or use the documented update workflow.'
if [ "$accept" -eq 0 ]; then
  printf 'Install missing verification tools, verify a Shelter release, then install its missing Docker prerequisites in %s? [y/N]: ' "$destination" >/dev/tty
  answer=
  read -r answer </dev/tty || fail 'A terminal is required; use --yes for provisioning.'
  case "$answer" in y|Y|yes|YES) ;; *) fail 'Installation declined.' ;; esac
fi
if ! command -v gh >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  os_id=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
  os_version=$(awk -F= '$1 == "VERSION_ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
  [ "$os_id" = ubuntu ] || fail 'Automatic tool installation supports Ubuntu only.'
  case "$os_version" in 24.04|26.04) ;; *) fail 'Use Ubuntu 24.04 or 26.04.' ;; esac
  apt-get update
  apt-get install -y --no-remove ca-certificates curl openssl
  if ! command -v gh >/dev/null 2>&1; then
    [ ! -e /etc/apt/sources.list.d/shelter-github-cli.list ] && [ ! -L /etc/apt/sources.list.d/shelter-github-cli.list ] || fail 'GitHub CLI repository path already exists; review it manually.'
    [ ! -e /etc/apt/keyrings/shelter-github-cli.gpg ] && [ ! -L /etc/apt/keyrings/shelter-github-cli.gpg ] || fail 'GitHub CLI key path already exists; review it manually.'
    install -m 0755 -d /etc/apt/keyrings
    key=$(mktemp)
    trap 'rm -f "$key"' 0
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$key"
    [ -s "$key" ] || fail 'GitHub signing key download was empty.'
    install -m 0644 "$key" /etc/apt/keyrings/shelter-github-cli.gpg
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/shelter-github-cli.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/shelter-github-cli.list
    chmod 644 /etc/apt/sources.list.d/shelter-github-cli.list
    rm -f "$key"
    trap - 0
    apt-get update
    apt-get install -y --no-remove gh
  fi
fi
gh release verify --help >/dev/null 2>&1 && gh release verify-asset --help >/dev/null 2>&1 || fail 'Upgrade GitHub CLI to a version supporting release verify and verify-asset.'
if ! gh auth status >/dev/null 2>&1; then
  [ "$accept" -eq 0 ] || fail 'Authenticate GitHub CLI first, or supply GH_TOKEN through your secret manager.'
  gh auth login --hostname github.com --git-protocol https --web
fi
[ -n "$tag" ] || tag=$(gh release view --repo "$repository" --json tagName --jq .tagName)
printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Expected a stable release tag vX.Y.Z.'
work=$(mktemp -d)
trap 'rm -rf "$work"' 0
trap 'exit 130' 2
trap 'exit 143' 15
asset=shelter-${tag}.tar.gz
gh release verify "$tag" --repo "$repository"
gh release download "$tag" --repo "$repository" --pattern "$asset" --output "$work/$asset"
gh release verify-asset "$tag" "$work/$asset" --repo "$repository"
[ "$(wc -c < "$work/$asset")" -le 104857600 ] || fail 'Release archive exceeds 100 MB.'
# Only fixed, authenticated helper payloads are streamed to known local paths.
# The trusted downloader then checks the entire archive and all payload hashes.
mkdir -p "$work/helpers/lib"
for helper in ops/download-release.sh ops/lib/release-bundle.sh; do
  output=$work/helpers/${helper#ops/}
  tar -xOzf "$work/$asset" "./$helper" > "$output"
  [ -s "$output" ] || fail 'Release is missing bootstrap helpers.'
done
mkdir -p "${destination%/*}"
sh "$work/helpers/download-release.sh" --repo "$repository" --tag "$tag" --destination "$destination"
sh "$destination/ops/install-dependencies.sh" --yes
sh "$destination/ops/install-release-bundle.sh" -- "$@"
printf '\nUse the SSH tunnel and panel port printed above, then open Setup guide in the browser.\n'
