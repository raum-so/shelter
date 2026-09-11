#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/etc/apt/sources.list.d" "$work/etc/apt/keyrings"
# All host paths are redirected in the test copy. No real packages or services
# are touched, even on Linux or when this test is run as root.
sed "s|/etc/|$work/etc/|g" "$repo/ops/install-dependencies.sh" > "$work/dependencies.sh"
export DEP_LOG="$work/log"
for tool in awk grep mktemp rm chmod cat install; do ln -s "$(command -v "$tool")" "$work/bin/$tool"; done
cat > "$work/bin/uname" <<'MOCK'
#!/bin/sh
case "$1" in -s) echo Linux ;; *) echo x86_64 ;; esac
MOCK
cat > "$work/bin/id" <<'MOCK'
#!/bin/sh
echo 0
MOCK
cat > "$work/bin/dpkg-query" <<'MOCK'
#!/bin/sh
case "$*" in *docker.io) [ "${CONFLICT:-0}" = 1 ] && printf 'install ok installed' && exit 0 ;; esac
exit 1
MOCK
cat > "$work/bin/dpkg" <<'MOCK'
#!/bin/sh
echo amd64
MOCK
cat > "$work/bin/apt-get" <<'MOCK'
#!/bin/sh
printf 'apt %s\n' "$*" >> "$DEP_LOG"
[ "${FAIL_APT:-0}" != 1 ]
MOCK
cat > "$work/bin/systemctl" <<'MOCK'
#!/bin/sh
printf 'service %s\n' "$*" >> "$DEP_LOG"
MOCK
cat > "$work/bin/curl" <<'MOCK'
#!/bin/sh
while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf 'test signing key' > "$2"; break; fi; shift; done
MOCK
for script in uname id dpkg-query dpkg apt-get systemctl curl; do chmod +x "$work/bin/$script"; done
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' > "$work/etc/os-release"
: > "$DEP_LOG"
if CONFLICT=1 PATH="$work/bin" /bin/sh "$work/dependencies.sh" --yes > "$work/output" 2>&1; then echo 'removed conflict'; exit 1; fi
[ ! -s "$DEP_LOG" ]
printf 'ID=debian\nVERSION_ID="13"\n' > "$work/etc/os-release"
if PATH="$work/bin" /bin/sh "$work/dependencies.sh" --yes > "$work/output" 2>&1; then echo 'accepted unsupported OS'; exit 1; fi
[ ! -s "$DEP_LOG" ]
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' > "$work/etc/os-release"
PATH="$work/bin" /bin/sh "$work/dependencies.sh" --yes > "$work/output" 2>&1
grep -q 'apt install -y --no-remove openssl docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin' "$DEP_LOG"
grep -q 'service enable --now docker' "$DEP_LOG"
grep -q 'Suites: noble' "$work/etc/apt/sources.list.d/shelter-docker.sources"
# A fully provisioned host must be a no-op.
cat > "$work/bin/docker" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cp "$work/bin/docker" "$work/bin/openssl"
chmod +x "$work/bin/docker" "$work/bin/openssl"
: > "$DEP_LOG"
PATH="$work/bin" /bin/sh "$work/dependencies.sh" --yes > "$work/output" 2>&1
[ ! -s "$DEP_LOG" ]
printf 'Dependencies: fresh installation, conflicts, unsupported OS and idempotency checks passed.\n'
