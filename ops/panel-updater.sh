#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

installation=${1:-/opt/shelter}
[[ $# -le 1 && "$installation" =~ ^/[A-Za-z0-9._/-]+$ && "$installation" != / && "$installation" != */ && "$installation" != *//* && "/$installation/" != */./* && "/$installation/" != */../* ]] || exit 1
readonly installation
readonly bridge=$installation/.shelter-updates
readonly request=$bridge/requests/request.json
readonly status=$bridge/status
readonly repository=raum-so/shelter
readonly version_pattern='(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})'
[[ $(id -u) == 0 ]] || exit 1
for directory in "$installation" "$bridge" "$bridge/requests" "$status"; do
  [[ -d "$directory" && ! -L "$directory" ]] || exit 1
done
for tool in gh jq docker rsync openssl timeout flock; do command -v "$tool" >/dev/null || exit 1; done
# Serialize timer and direct operator invocations before either can touch status.
[[ ! -L "$bridge/agent.lock" && ( ! -e "$bridge/agent.lock" || -f "$bridge/agent.lock" ) ]] || exit 1
exec 9> "$bridge/agent.lock"
flock -n 9 || exit 0

write_json() {
  local name=$1 content=$2 temporary
  [[ ! -L "$status/$name" && ( ! -e "$status/$name" || -f "$status/$name" ) ]] || return 1
  temporary=$(mktemp "$status/.state.XXXXXX")
  printf '%s\n' "$content" > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$status/$name"
}
write_json ready.json "$(jq -cn --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{checkedAt:$time}')"
[[ -e "$request" || -L "$request" ]] || exit 0
[[ -f "$request" && ! -L "$request" ]] || exit 1
# Input is data only. The service accepts no commands, repositories or filesystem paths.
contents=$(timeout 5s head -c 4097 -- "$request")
[[ ${#contents} -le 4096 ]] || exit 1
jq -e 'type=="object" and (keys|sort)==["fromVersion","id","tag"] and (.id|type)=="string" and (.tag|type)=="string" and (.fromVersion|type)=="string"' <<< "$contents" >/dev/null
job_id=$(jq -r .id <<< "$contents")
tag=$(jq -r .tag <<< "$contents")
from_version=$(jq -r .fromVersion <<< "$contents")
[[ $job_id =~ ^[a-f0-9]{32}$ && $tag =~ ^v${version_pattern}$ && $from_version =~ ^${version_pattern}$ ]] || exit 1

phase=verifying
temporary=
token=
lock_acquired=0
write_job() {
  write_json job.json "$(jq -cn --arg id "$job_id" --arg tag "$tag" --arg from "$from_version" --arg phase "$phase" --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{id:$id,tag:$tag,fromVersion:$from,phase:$phase,updatedAt:$time}')"
}
remote_action() {
  local action=$1 manifest=${2:-}
  cat "$installation/ops/lib/release-bundle.sh" "$installation/ops/lib/deploy-release-remote.sh" |
    sh -s -- "$action" "$installation" "$tag" "$token" "$manifest" 0
}
cleanup() {
  local result=$?
  trap - EXIT HUP INT TERM
  if (( result != 0 )); then phase=failed; write_job || true; fi
  if (( lock_acquired )); then remote_action cleanup >/dev/null 2>&1 || true; fi
  [[ -z "$temporary" ]] || rm -rf -- "$temporary"
  # Do not delete a replacement request. A terminal status remains visible across API restarts.
  if [[ -f "$request" && ! -L "$request" ]] && [[ $(timeout 5s head -c 4097 -- "$request") == "$contents" ]]; then rm -- "$request"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -f "$status/job.json" && ! -L "$status/job.json" ]] &&
  jq -e --arg id "$job_id" '.id==$id' "$status/job.json" >/dev/null; then
  # Never replay a request or reuse an earlier worker acknowledgement. Interrupted
  # operations need operator inspection, never an automatic unlock or retry.
  exit 1
fi
write_job
latest=$(gh api "repos/$repository/releases/latest" --jq 'select(.draft==false and .prerelease==false and .immutable==true) | .tag_name')
[[ "$latest" == "$tag" ]] || exit 1
api_id=$(docker compose --env-file "$installation/.env" -f "$installation/compose.yaml" ps -q api)
[[ $api_id =~ ^[a-f0-9]{12,64}$ ]] || exit 1
running_version=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$api_id")
[[ "$running_version" == "$from_version" ]] || exit 1
# Wait for the worker to finish the iteration that preceded admission. A fresh
# acknowledgement prevents a deployment claim racing the API's idle check.
paused=0
for attempt in {1..30}; do
  acknowledgement=$(docker exec "$api_id" node --input-type=module -e '
    import fs from "node:fs"; import path from "node:path"; import Database from "better-sqlite3";
    const directory = process.env.DATA_DIR || "/data";
    const current = path.join(directory, "shelter.sqlite"), legacy = path.join(directory, "portsmith.sqlite");
    const db = new Database(fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy, {readonly:true, fileMustExist:true});
    process.stdout.write(db.prepare("SELECT value FROM settings WHERE key=?").get("worker.update-pause")?.value || "");
    db.close();
  ')
  if [[ "$acknowledgement" == "$job_id" ]]; then paused=1; break; fi
  sleep 1
done
(( paused )) || exit 1
IFS=. read -r next_major next_minor next_patch <<< "${tag#v}"
IFS=. read -r previous_major previous_minor previous_patch <<< "$from_version"
(( next_major > previous_major || (next_major == previous_major && next_minor > previous_minor) || (next_major == previous_major && next_minor == previous_minor && next_patch > previous_patch) )) || exit 1

temporary=$(mktemp -d /tmp/shelter-panel-update.XXXXXX)
"$installation/ops/download-release.sh" --repo "$repository" --tag "$tag" --destination "$temporary/bundle"
source "$installation/ops/lib/release-bundle.sh"
shelter_release_load "$temporary/bundle"
manifest_sha=$SHELTER_RELEASE_MANIFEST_SHA256
token=$(openssl rand -hex 16)
[[ $token =~ ^[a-f0-9]{32}$ ]] || exit 1
lock_acquired=1
remote_action prepare
rsync -rlpt "$temporary/bundle/" "$installation/releases/.incoming/${tag}-${token}/"
phase=installing
write_job
# Reuse the complete root staging, immutable publication, snapshot, digest installation
# and final doctor path. No credentials or unverified downloaded scripts reach the API.
remote_action activate "$manifest_sha"
lock_acquired=0
phase=succeeded
write_job
write_json ready.json "$(jq -cn --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{checkedAt:$time}')"
