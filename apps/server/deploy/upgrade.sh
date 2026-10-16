#!/usr/bin/env bash
# Upgrade a Docker Compose deployment of the AgentLink Assistant, or roll the
# last upgrade back. Docker on Ubuntu and Docker Desktop on macOS (bash 3.2).
#
#   upgrade.sh [options] [<git ref>]   build, drain, back up, switch, check
#   upgrade.sh rollback [options]      previous images and pre-upgrade records
#
# An upgrade:
#   1. checks out <git ref> in the source checkout (when given) and builds
#      the bundle and new images, tagged :candidate, while the Assistant
#      keeps working;
#   2. drains the Assistant (`agentlink-server drain`): new chats, tasks and
#      scheduled runs wait, running work gets --wait minutes to finish, and
#      what is left is recorded interrupted, to resume afterwards;
#   3. takes a backup (the safety net for rollback) and records its ID;
#   4. tags the running images :previous and the candidates :local, and
#      restarts with `docker compose up -d`;
#   5. runs `agentlink-server smoke-check` (the server answers, the data
#      format is current, every service is reachable on the same version)
#      until it passes, for up to 3 minutes;
#   6. resumes (`agentlink-server resume`).
# If the smoke check fails, it rolls back by itself: the :previous images,
# and `data/` from the backup taken in step 3 (restored with
# --reason upgrade-rollback, so the Assistant starts with scheduled jobs
# paused and says what happened in the Inbox). The failed `data/` is kept
# beside the deploy directory.
#
# Options:
#   --source <dir>      AgentLink checkout to build from (default: the one
#                       this script is in)
#   --deploy <dir>      deploy directory (default: $AGENTLINK_DEPLOY, else
#                       ~/agentlink-assistant)
#   --wait <minutes>    how long running work may take to finish (default 15)
#   --no-backup         upgrade without a backup; a rollback then restores
#                       the images only
#   --simulate-failure  fail the smoke check on purpose, to rehearse a
#                       rollback
#
# The source checkout needs Node 22 and npm; the commit is taken from git,
# or from a .agentlink-commit file in the checkout when it is not a git
# repository.
set -euo pipefail

TARGETS="assistant command-worker publisher backup"
# Built only when the deploy uses them; a rollback keeps their current
# image when there is no earlier one (the first upgrade that adds them).
OPTIONAL_TARGETS="editor"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_dir="$(cd "$script_dir/../../.." && pwd -P)"
deploy_dir="${AGENTLINK_DEPLOY:-$HOME/agentlink-assistant}"
wait_minutes=15
use_backup=1
simulate_failure=0
mode=upgrade
ref=""

say() { printf '==> %s\n' "$*"; }
fail() {
  printf 'upgrade.sh: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    rollback) mode=rollback ;;
    --source)
      [ $# -ge 2 ] || fail "--source needs a directory"
      source_dir="$(cd "$2" && pwd -P)"
      shift
      ;;
    --deploy)
      [ $# -ge 2 ] || fail "--deploy needs a directory"
      deploy_dir="$2"
      shift
      ;;
    --wait)
      [ $# -ge 2 ] || fail "--wait needs minutes"
      wait_minutes="$2"
      shift
      ;;
    --no-backup) use_backup=0 ;;
    --simulate-failure) simulate_failure=1 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) fail "unknown option $1" ;;
    *)
      [ -z "$ref" ] || fail "only one git ref"
      ref="$1"
      ;;
  esac
  shift
done

[ -d "$deploy_dir" ] || fail "no deploy directory at $deploy_dir"
deploy_dir="$(cd "$deploy_dir" && pwd -P)"
[ -f "$deploy_dir/compose.yaml" ] || fail "$deploy_dir has no compose.yaml"
command -v docker > /dev/null || fail "docker is not installed"
state_file="$deploy_dir/.upgrade-state"
witness_network="agentlink-witness"

dc() { (cd "$deploy_dir" && docker compose "$@"); }
server() { dc exec -T assistant agentlink-server "$@"; }
image_of() { printf 'agentlink-%s' "$1"; }
image_exists() { docker image inspect "$1" > /dev/null 2>&1; }

# compose.editor.yaml in COMPOSE_FILE adds the editor image.
if grep -Eq '^COMPOSE_FILE=.*compose\.editor\.yaml' "$deploy_dir/.env" 2> /dev/null; then
  TARGETS="$TARGETS editor"
fi
is_optional() { case " $OPTIONAL_TARGETS " in *" $1 "*) return 0 ;; esac; return 1; }

# Wait for the smoke check to pass, for up to 3 minutes.
smoke_check() {
  local deadline=$(($(date +%s) + 180))
  while :; do
    if server smoke-check; then
      if [ "$simulate_failure" = 1 ]; then
        say "Failing the smoke check on purpose (--simulate-failure)"
        return 1
      fi
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    say "Not ready yet; checking again in 10 seconds"
    sleep 10
  done
}

write_state() {
  # KEY=value lines; only this script reads them.
  {
    printf 'status=%s\n' "$1"
    printf 'started=%s\n' "${started:-}"
    printf 'commit=%s\n' "${commit:-}"
    printf 'snapshot=%s\n' "${snapshot:-}"
  } > "$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
}

read_state() {
  [ -f "$state_file" ] || fail "no upgrade to roll back ($state_file is missing)"
  status="$(sed -n 's/^status=//p' "$state_file")"
  started="$(sed -n 's/^started=//p' "$state_file")"
  commit="$(sed -n 's/^commit=//p' "$state_file")"
  snapshot="$(sed -n 's/^snapshot=//p' "$state_file")"
}

rollback() {
  read_state
  say "Rolling back the upgrade to ${commit:-the new version} started $started"
  for target in $TARGETS; do
    image="$(image_of "$target")"
    image_exists "$image:previous" || is_optional "$target" ||
      fail "no $image:previous image to roll back to"
  done
  say "Stopping the Assistant"
  dc stop > /dev/null
  for target in $TARGETS; do
    image="$(image_of "$target")"
    if image_exists "$image:previous"; then
      docker tag "$image:previous" "$image:local"
    else
      say "Keeping $image:local (there is no earlier one)"
    fi
  done
  if [ -n "$snapshot" ]; then
    say "Restoring data/ from backup $snapshot (taken before the upgrade)"
    local scratch kept
    scratch="$(mktemp -d "$(dirname "$deploy_dir")/.agentlink-rollback.XXXXXX")"
    docker run --rm --network "$witness_network" \
      -v "$scratch:/restore" \
      -v "$deploy_dir/secrets/backup-repository:/run/secrets/backup-repository:ro" \
      -v "$deploy_dir/secrets/backup-password:/run/secrets/backup-password:ro" \
      agentlink-backup:local restore --target /restore --snapshot "$snapshot" \
      --repository-file /run/secrets/backup-repository \
      --password-file /run/secrets/backup-password --reason upgrade-rollback
    kept="$deploy_dir.failed-upgrade-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$kept"
    mv "$deploy_dir/data" "$kept/data"
    mv "$scratch/data" "$deploy_dir/data"
    # The rest of the restore holds files of several owners: remove it
    # with the same image, as root.
    docker run --rm --entrypoint sh -v "$scratch:/scratch" agentlink-backup:local \
      -c 'find /scratch -mindepth 1 -delete' 2> /dev/null || true
    rmdir "$scratch" 2> /dev/null || true
    say "The failed upgrade's data/ is kept in $kept"
  else
    say "No pre-upgrade backup: keeping data/ as it is"
  fi
  dc up -d
  simulate_failure=0
  if ! smoke_check; then
    write_state rollback-failed
    fail "the rolled-back version does not pass its smoke check either; see 'docker compose logs assistant'"
  fi
  # A restore starts undrained (schedules paused); without one, lift the
  # drain the upgrade left.
  [ -n "$snapshot" ] || server resume
  write_state rolled-back
  say "Rolled back. Scheduled jobs are paused until you turn them on in Jobs."
}

if [ "$mode" = rollback ]; then
  rollback
  exit 0
fi

# --- Upgrade -------------------------------------------------------------

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$use_backup" = 1 ] && ! grep -q '"backup"' "$deploy_dir/server.json"; then
  fail "backups are not configured (see Backups in apps/server/README.md); set them up, or pass --no-backup"
fi

if [ -n "$ref" ]; then
  say "Checking out $ref in $source_dir"
  git -C "$source_dir" fetch --quiet
  git -C "$source_dir" checkout --quiet --detach "$ref"
fi
if git -C "$source_dir" rev-parse --git-dir > /dev/null 2>&1; then
  commit="$(git -C "$source_dir" rev-parse --short=8 HEAD)"
elif [ -f "$source_dir/.agentlink-commit" ]; then
  commit="$(tr -d '[:space:]' < "$source_dir/.agentlink-commit" | cut -c1-8)"
else
  commit=""
fi

say "Building ${commit:-the source} (the Assistant keeps working meanwhile)"
(
  cd "$source_dir"
  lock_sum="$(cksum package-lock.json | cut -d' ' -f1)"
  if [ ! -d node_modules ] || [ "$(cat node_modules/.agentlink-lock 2> /dev/null)" != "$lock_sum" ]; then
    npm ci --no-audit --no-fund > /dev/null
    printf '%s\n' "$lock_sum" > node_modules/.agentlink-lock
  fi
  AGENTLINK_BUILD_COMMIT="$commit" npm run build:workspaces > /dev/null
  for target in $TARGETS; do
    docker build -q --target "$target" -t "$(image_of "$target"):candidate" \
      -f apps/server/deploy/container/Dockerfile apps/server > /dev/null
  done
)

say "Draining: new work waits; running work has $wait_minutes minute(s)"
if ! server drain --wait "$wait_minutes" --reason upgrade; then
  server resume || true
  fail "the Assistant did not drain; nothing was changed"
fi

snapshot=""
if [ "$use_backup" = 1 ]; then
  say "Backing up before switching"
  if ! backup_output="$(server backup)"; then
    printf '%s\n' "$backup_output"
    server resume || true
    fail "the backup failed; nothing was changed"
  fi
  printf '%s\n' "$backup_output"
  snapshot="$(printf '%s\n' "$backup_output" | sed -n -E 's/^Backup ([0-9a-f]{8}) done.*/\1/p')"
  [ -n "$snapshot" ] || {
    server resume || true
    fail "could not read the backup's ID; nothing was changed"
  }
fi

say "Switching to the new images"
for target in $TARGETS; do
  image="$(image_of "$target")"
  if image_exists "$image:local"; then
    docker tag "$image:local" "$image:previous"
  fi
  docker tag "$image:candidate" "$image:local"
done
write_state in-progress
dc up -d

say "Checking the new version"
if ! smoke_check; then
  say "The new version failed its smoke check: rolling back"
  write_state failed
  rollback
  exit 1
fi

server resume
write_state done
say "Upgraded to ${commit:-the new version}. Roll back with: $0 rollback"
