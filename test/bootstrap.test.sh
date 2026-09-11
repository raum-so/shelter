#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/archive/ops/lib"
export BOOT_LOG="$work/log" BOOT_ARCHIVE="$work/release.tar.gz"
cat > "$work/bin/id" <<'MOCK'
#!/bin/sh
echo 0
MOCK
cat > "$work/bin/uname" <<'MOCK'
#!/bin/sh
echo Linux
MOCK
cat > "$work/bin/gh" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$BOOT_LOG"
case "$*" in
 *--help*|'auth status') exit 0 ;;
 'release view '*) echo v1.2.3 ;;
 'release verify-asset '*) [ "${FAIL_VERIFY:-0}" != 1 ] ;;
 'release download '*) while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then cp "$BOOT_ARCHIVE" "$2"; break; fi; shift; done ;;
esac
MOCK
cat > "$work/archive/ops/download-release.sh" <<'MOCK'
#!/bin/sh
set -eu
printf 'verified-downloader\n' >> "$BOOT_LOG"
while [ "$#" -gt 0 ]; do if [ "$1" = --destination ]; then destination=$2; fi; shift; done
mkdir -p "$destination/ops"
printf '#!/bin/sh\nprintf "dependencies\\n" >> "$BOOT_LOG"\n' > "$destination/ops/install-dependencies.sh"
printf '#!/bin/sh\nprintf "installed\\n" >> "$BOOT_LOG"\n' > "$destination/ops/install-release-bundle.sh"
MOCK
printf '# trusted helper\n' > "$work/archive/ops/lib/release-bundle.sh"
tar -czf "$BOOT_ARCHIVE" -C "$work/archive" .
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"
: > "$BOOT_LOG"
if FAIL_VERIFY=1 sh "$repo/bootstrap.sh" --yes --directory "$work/failed" > "$work/output" 2>&1; then echo 'unverified bootstrap succeeded'; exit 1; fi
! grep -q verified-downloader "$BOOT_LOG"
[ ! -e "$work/failed" ]
sh "$repo/bootstrap.sh" --yes --directory "$work/shelter" > "$work/output" 2>&1
tail -3 "$BOOT_LOG" | diff - <(printf 'verified-downloader\ndependencies\ninstalled\n')
if sh "$repo/bootstrap.sh" --yes --directory "$work/shelter" > "$work/output" 2>&1; then echo 'overwrote existing directory'; exit 1; fi
if sh "$repo/bootstrap.sh" --yes --tag '../bad' --directory "$work/bad" > "$work/output" 2>&1; then echo 'accepted invalid tag'; exit 1; fi
printf 'Bootstrap: verified ordering, failed attestation, unsafe tag and existing installation checks passed.\n'
