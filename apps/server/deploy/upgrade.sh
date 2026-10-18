#!/usr/bin/env bash
# Upgrade a Docker Compose deployment of the AgentLink Assistant, or roll the
# last upgrade back. Docker on Ubuntu and Docker Desktop on macOS (bash 3.2).
#
#   upgrade.sh [options] [<git ref>]   build, drain, back up, switch, check
#   upgrade.sh --deploy DIR --release-manifest FILE  install a published release
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
# inside .upgrade-failed/ in the deploy directory (excluded from backups).
#
# Options:
#   --source <dir>      AgentLink checkout to build from (default: the one
#                       this script is in)
#   --deploy <dir>      deploy directory (default: $AGENTLINK_DEPLOY, else
#                       ~/agentlink-assistant)
#   --release-manifest <file>  install the immutable images in a release manifest
#   --release-assets <dir>     verified canonical templates staged by the updater
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
OPTIONAL_TARGETS="editor browser updater"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_dir="$(cd "$script_dir/../../.." && pwd -P)"
deploy_dir="${AGENTLINK_DEPLOY:-$HOME/agentlink-assistant}"
wait_minutes=15
use_backup=1
simulate_failure=0
mode=upgrade
ref=""
release_manifest=""
release_mode=0
release_upgrade=0
validate_release=0
release_assets=""
assets_upgrade=0
progress() { printf 'AGENTLINK_UPDATE_PHASE=%s\n' "$1"; }

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
    --release-manifest)
      [ $# -ge 2 ] || fail "--release-manifest needs a file"
      release_manifest="$2"
      shift
      ;;
    --release-assets)
      [ $# -ge 2 ] || fail "--release-assets needs a directory"
      release_assets="$2"
      shift
      ;;
    --validate-release) validate_release=1 ;;
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

if [ "$validate_release" = 0 ]; then
  [ -d "$deploy_dir" ] || fail "no deploy directory at $deploy_dir"
  deploy_dir="$(cd "$deploy_dir" && pwd -P)"
  [ -f "$deploy_dir/compose.yaml" ] || fail "$deploy_dir has no compose.yaml"
fi
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
# compose.browser.yaml adds the research browser image.
if grep -Eq '^COMPOSE_FILE=.*compose\.browser\.yaml' "$deploy_dir/.env" 2> /dev/null; then
  TARGETS="$TARGETS browser"
fi
if grep -Eq '^COMPOSE_FILE=.*compose\.updater\.yaml' "$deploy_dir/.env" 2> /dev/null; then
  TARGETS="$TARGETS updater"
fi
is_optional() { case " $OPTIONAL_TARGETS " in *" $1 "*) return 0 ;; esac; return 1; }

# The worker verifies JSON metadata and hashes first. Check the flat staging
# list again here, before Docker or replacing anything. Never copy user config.
asset_allowed() {
  case "$1" in
    install.sh|upgrade.sh|compose.yaml|compose.backup.yaml|compose.browser.yaml|compose.editor.yaml|compose.meridian.yaml|compose.publisher.yaml|compose.runners.yaml|compose.searxng.yaml|compose.worker-egress.yaml|compose.witness.yaml|compose.updater.yaml|compose.update-client.yaml|server.example.json|assistant-deployment.json) return 0 ;;
  esac
  return 1
}
if [ -n "$release_assets" ]; then
  [ -n "$release_manifest" ] || fail "--release-assets requires --release-manifest"
  [ "$use_backup" = 1 ] || fail "transactional assets require a backup"
  [ -f "$release_assets/.asset-list" ] || fail "missing verified asset list"
  while read -r digest name extra; do
    asset_allowed "$name" || fail "unknown deployment asset"
    [ -z "${extra:-}" ] && [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "invalid asset hash"
    [ -f "$release_assets/$name" ] && [ ! -L "$release_assets/$name" ] || fail "invalid staged asset"
    if command -v sha256sum >/dev/null; then
      actual="$(sha256sum "$release_assets/$name")"
    else
      actual="$(shasum -a 256 "$release_assets/$name")"
    fi
    [ "${actual%% *}" = "$digest" ] || fail "staged asset hash mismatch"
  done < "$release_assets/.asset-list"
fi

# Parse the release file as data, never shell code. The target list is derived
# from this deployment's compose configuration before validating image keys.
if [ "$validate_release" = 1 ] && [ -z "$release_manifest" ]; then
  fail "--validate-release requires --release-manifest"
fi
if [ -n "$release_manifest" ]; then
  release_mode=1
  [ -f "$release_manifest" ] || fail "release manifest not found: $release_manifest"
  release_version=""
  release_commit=""
  release_assistant=""
  release_command_worker=""
  release_publisher=""
  release_backup=""
  release_editor=""
  release_browser=""
  release_updater=""
  seen_keys="|"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in *=*) ;; *) fail "invalid release manifest line" ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    [ -n "$value" ] || fail "empty value for $key in release manifest"
    case "$seen_keys" in *"|$key|"*) fail "duplicate release manifest key: $key" ;; esac
    seen_keys="${seen_keys}${key}|"
    case "$key" in
      RELEASE_VERSION) release_version="$value" ;;
      RELEASE_COMMIT) release_commit="$value" ;;
      ASSISTANT_IMAGE) release_assistant="$value" ;;
      COMMAND_WORKER_IMAGE) release_command_worker="$value" ;;
      PUBLISHER_IMAGE) release_publisher="$value" ;;
      BACKUP_IMAGE) release_backup="$value" ;;
      EDITOR_IMAGE) release_editor="$value" ;;
      BROWSER_IMAGE) release_browser="$value" ;;
      UPDATER_IMAGE) release_updater="$value" ;;
      *) fail "unknown release manifest key: $key" ;;
    esac
  done < "$release_manifest"
  [[ "$release_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] || fail "invalid RELEASE_VERSION"
  [[ "$release_commit" =~ ^[0-9a-f]{40}$ ]] || fail "invalid RELEASE_COMMIT"
  for target in $TARGETS; do
    case "$target" in
      assistant) key=ASSISTANT_IMAGE; value="$release_assistant" ;;
      command-worker) key=COMMAND_WORKER_IMAGE; value="$release_command_worker" ;;
      publisher) key=PUBLISHER_IMAGE; value="$release_publisher" ;;
      backup) key=BACKUP_IMAGE; value="$release_backup" ;;
      editor) key=EDITOR_IMAGE; value="$release_editor" ;;
      browser) key=BROWSER_IMAGE; value="$release_browser" ;;
      updater) key=UPDATER_IMAGE; value="$release_updater" ;;
    esac
    case "$seen_keys" in *"|$key|"*) ;; *) fail "missing release manifest key: $key" ;; esac
    [[ "$value" =~ ^ghcr\.io/reefbarman/agentlink-${target}@sha256:[0-9a-f]{64}$ ]] || fail "invalid $key reference"
  done
  for target in $OPTIONAL_TARGETS; do
    case "$target" in
      editor) key=EDITOR_IMAGE; value="$release_editor" ;;
      browser) key=BROWSER_IMAGE; value="$release_browser" ;;
      updater) key=UPDATER_IMAGE; value="$release_updater" ;;
    esac
    case "$seen_keys" in
      *"|$key|"*) [[ "$value" =~ ^ghcr\.io/reefbarman/agentlink-${target}@sha256:[0-9a-f]{64}$ ]] || fail "invalid $key reference" ;;
    esac
  done
fi
if [ "$validate_release" = 1 ]; then
  say "Release manifest is valid for this deployment"
  exit 0
fi
lock_dir="$deploy_dir/.upgrade-lock"
if ! mkdir "$lock_dir" 2> /dev/null; then
  printf 'Lock: %s\n' "$lock_dir" >&2
  printf 'If a previous updater was killed or the host rebooted, first verify no upgrade/rollback process is running, then remove the empty lock with: rmdir %q\n' "$lock_dir" >&2
  fail "another upgrade or rollback is running, or an interrupted update left its lock; never remove a live updater's lock"
fi
transaction_active=0
drain_active=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" != 0 ] && [ "$transaction_active" = 1 ]; then
    say "The update was interrupted by an error: restoring the previous deployment"
    (rollback) || result=1
  elif [ "$result" != 0 ] && [ "$drain_active" = 1 ]; then
    server resume || true
  fi
  rmdir "$lock_dir" 2>/dev/null || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
command -v docker > /dev/null || fail "docker is not installed"

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

preserve_metadata() {
  local temporary="$1" destination="$2" owner mode
  if [ -f "$destination" ]; then
    owner="$(stat -c '%u:%g' "$destination" 2>/dev/null || stat -f '%u:%g' "$destination")"
    mode="$(stat -c '%a' "$destination" 2>/dev/null || stat -f '%Lp' "$destination")"
  else
    owner="$(stat -c '%u:%g' "$deploy_dir" 2>/dev/null || stat -f '%u:%g' "$deploy_dir")"
    mode=600
  fi
  # CHOWN + DAC_OVERRIDE deliberately do not grant FOWNER. Change mode while
  # the new temporary is still ours, and transfer ownership only afterwards.
  chmod "$mode" "$temporary" || return 1
  chown "$owner" "$temporary" || return 1
}
copy_preserved() {
  local temporary
  temporary="$(mktemp "$deploy_dir/.upgrade-copy.XXXXXX")" || return 1
  cat "$1" > "$temporary" || return 1
  preserve_metadata "$temporary" "$1" || return 1
  mv "$temporary" "$2" || return 1
}
write_state() {
  # KEY=value lines; only this script reads them.
  local temporary
  temporary="$(mktemp "$deploy_dir/.upgrade-state.XXXXXX")" || return 1
  {
    printf 'status=%s\n' "$1"
    printf 'started=%s\n' "${started:-}"
    printf 'commit=%s\n' "${commit:-}"
    printf 'snapshot=%s\n' "${snapshot:-}"
    printf 'release=%s\n' "${release_upgrade:-0}"
    printf 'assets=%s\n' "${assets_upgrade:-0}"
  } > "$temporary"
  preserve_metadata "$temporary" "$state_file" || return 1
  mv "$temporary" "$state_file" || return 1
}

read_state() {
  [ -f "$state_file" ] || fail "no upgrade to roll back ($state_file is missing)"
  status="$(sed -n 's/^status=//p' "$state_file")"
  started="$(sed -n 's/^started=//p' "$state_file")"
  commit="$(sed -n 's/^commit=//p' "$state_file")"
  snapshot="$(sed -n 's/^snapshot=//p' "$state_file")"
  release_upgrade="$(sed -n 's/^release=//p' "$state_file")"
  assets_upgrade="$(sed -n 's/^assets=//p' "$state_file")"
}

restore_assets() {
  [ "${assets_upgrade:-0}" = 1 ] || return 0
  [ -f "$deploy_dir/.upgrade-assets-previous/.files" ] || fail "previous templates are missing"
  while IFS= read -r name; do
    asset_allowed "$name" || fail "invalid previous asset name"
    [ "$name" != compose.updater.yaml ] || continue
    if [ -f "$deploy_dir/.upgrade-assets-previous/$name" ]; then
      copy_preserved "$deploy_dir/.upgrade-assets-previous/$name" "$deploy_dir/$name" || fail "could not restore previous templates"
    else
      rm -f "$deploy_dir/$name" || fail "could not remove an added template"
    fi
  done < "$deploy_dir/.upgrade-assets-previous/.files"
}

# Before anything stops: restoring the templates must not remove one that the
# current .env uses (one added by the update and turned on afterwards).
check_assets_restorable() {
  [ "${assets_upgrade:-0}" = 1 ] || return 0
  [ -f "$deploy_dir/.upgrade-assets-previous/.files" ] || fail "previous templates are missing; nothing was stopped"
  local active name
  active=":$(sed -n 's/^COMPOSE_FILE=//p' "$deploy_dir/.env" 2> /dev/null | sed -n '$p'):"
  while IFS= read -r name; do
    asset_allowed "$name" || fail "invalid previous asset name"
    [ "$name" != compose.updater.yaml ] || continue
    [ ! -f "$deploy_dir/.upgrade-assets-previous/$name" ] || continue
    case "$active" in
      *":$name:"*) fail "rolling back would remove $name, which COMPOSE_FILE in .env uses now; nothing was stopped. To go back, restore a backup (see Backups in the README)" ;;
    esac
  done < "$deploy_dir/.upgrade-assets-previous/.files"
}

rollback() {
  transaction_active=0
  drain_active=0
  read_state
  [ "$status" != preparing ] || fail "the update stopped before switching images; there is no complete recovery point for that attempt"
  [ "$status" != retired ] || fail "the last update can no longer be rolled back: an optional feature was turned on or off with install.sh after it, and its recovery point does not include that change. Nothing was stopped. To go back, restore a backup (see Backups in the README)"
  check_assets_restorable
  progress rolling_back
  say "Rolling back the upgrade to ${commit:-the new version} started $started"
  for target in $TARGETS; do
    image="$(image_of "$target")"
    image_exists "$image:previous" || is_optional "$target" ||
      fail "no $image:previous image to roll back to"
  done
  say "Stopping the Assistant"
  dc stop > /dev/null || fail "could not stop services for rollback"
  # Restore templates even if the subsequent backup restore is unavailable.
  restore_assets
  for target in $TARGETS; do
    image="$(image_of "$target")"
    if image_exists "$image:previous"; then
      docker tag "$image:previous" "$image:local" || fail "could not restore a previous image"
    else
      say "Keeping $image:local (there is no earlier one)"
    fi
  done
  if [ -n "$snapshot" ]; then
    say "Restoring data/ from backup $snapshot (taken before the upgrade)"
    local scratch kept
    scratch="$(mktemp -d "$deploy_dir/.upgrade-rollback.XXXXXX")"
    docker run --rm --network "$witness_network" \
      -v "$scratch:/restore" \
      -v "$deploy_dir/secrets/backup-repository:/run/secrets/backup-repository:ro" \
      -v "$deploy_dir/secrets/backup-password:/run/secrets/backup-password:ro" \
      agentlink-backup:local restore --target /restore --snapshot "$snapshot" \
      --repository-file /run/secrets/backup-repository \
      --password-file /run/secrets/backup-password --reason upgrade-rollback || fail "backup restore failed; live data was not moved"
    [ -d "$scratch/data" ] || fail "backup restore has no data; live data was not moved"
    kept="$deploy_dir/.upgrade-failed/$(date +%Y%m%d-%H%M%S)"
    if [ ! -d "$deploy_dir/.upgrade-failed" ]; then
      mkdir -m 700 "$deploy_dir/.upgrade-failed" || fail "could not create failed-data archive"
      owner="$(stat -c '%u:%g' "$deploy_dir" 2>/dev/null || stat -f '%u:%g' "$deploy_dir")"
      chown "$owner" "$deploy_dir/.upgrade-failed" || fail "could not preserve archive ownership"
    fi
    mkdir -m 700 "$kept" || fail "could not create failed-data archive"
    owner="$(stat -c '%u:%g' "$deploy_dir" 2>/dev/null || stat -f '%u:%g' "$deploy_dir")"
    chown "$owner" "$kept" || fail "could not preserve archive ownership"
    mv "$deploy_dir/data" "$kept/data" || fail "could not preserve the failed upgrade's data"
    if ! mv "$scratch/data" "$deploy_dir/data"; then
      mv "$kept/data" "$deploy_dir/data" || true
      fail "could not install restored data; services remain stopped"
    fi
    # The rest of the restore holds files of several owners: remove it
    # with the same image, as root.
    docker run --rm --entrypoint sh -v "$scratch:/scratch" agentlink-backup:local \
      -c 'find /scratch -mindepth 1 -delete' 2> /dev/null || true
    rmdir "$scratch" 2> /dev/null || true
    say "The failed upgrade's data/ is kept in $kept"
  else
    say "No pre-upgrade backup: keeping data/ as it is"
  fi

  dc up -d || fail "could not start the restored services"
  simulate_failure=0
  if ! smoke_check; then
    write_state rollback-failed
    fail "the rolled-back version does not pass its smoke check either; see 'docker compose logs assistant'"
  fi
  # A restore starts undrained (schedules paused); without one, lift the
  # drain the upgrade left.
  [ -n "$snapshot" ] || server resume || fail "could not resume restored services"
  if [ "${release_upgrade:-0}" = 1 ] && [ -f "$deploy_dir/.release-previous-present" ]; then
    if [ "$(cat "$deploy_dir/.release-previous-present")" = yes ]; then
      local manifest_temporary
      manifest_temporary="$(mktemp "$deploy_dir/.upgrade-manifest.XXXXXX")" || fail "could not stage previous release metadata"
      cat "$deploy_dir/.release-previous.env" > "$manifest_temporary" || fail "could not restore previous release metadata"
      preserve_metadata "$manifest_temporary" "$deploy_dir/.release-previous.env" || fail "could not restore previous release ownership"
      mv "$manifest_temporary" "$deploy_dir/release.env" || fail "could not restore previous release metadata"
    else
      rm -f "$deploy_dir/release.env"
    fi
    rm -f "$deploy_dir/.release-previous-present" "$deploy_dir/.release-previous.env"
  fi
  write_state rolled-back || fail "could not record rollback completion"
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

if [ "$release_mode" = 1 ]; then
  release_upgrade=1
  commit="$release_commit"
  progress pulling
  say "Pulling immutable release images for $release_version"
  for target in $TARGETS; do
    case "$target" in
      assistant) image_ref="$release_assistant" ;;
      command-worker) image_ref="$release_command_worker" ;;
      publisher) image_ref="$release_publisher" ;;
      backup) image_ref="$release_backup" ;;
      editor) image_ref="$release_editor" ;;
      browser) image_ref="$release_browser" ;;
      updater) image_ref="$release_updater" ;;
    esac
    docker pull "$image_ref"
    docker tag "$image_ref" "$(image_of "$target"):candidate"
  done
else
[ ! -f "$deploy_dir/release.env" ] || fail "this deployment uses released images; use --release-manifest (automatic conversion to a source build is not supported)"
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
  case " $TARGETS " in
    *" editor "*)
      # The AgentLink extension built into the editor image, for Linux on
      # this machine's architecture.
      case "$(uname -m)" in
        x86_64 | amd64) vsce_target=linux-x64 ;;
        aarch64 | arm64) vsce_target=linux-arm64 ;;
        *) fail "no AgentLink extension build for $(uname -m)" ;;
      esac
      vsix_dir="$(mktemp -d)"
      # Packaging builds the workspaces again: keep the commit in them.
      AGENTLINK_BUILD_COMMIT="$commit" AGENTLINK_VSCE_TARGET="$vsce_target" \
        npm run package -- "$vsix_dir/agentlink.vsix" > /dev/null
      cp "$vsix_dir/agentlink.vsix" apps/server/dist/agentlink-editor.vsix
      rm -rf "$vsix_dir"
      ;;
  esac
  for target in $TARGETS; do
    docker build -q --target "$target" -t "$(image_of "$target"):candidate" \
      -f apps/server/deploy/container/Dockerfile apps/server > /dev/null
  done
)
fi

progress draining
say "Draining: new work waits; running work has $wait_minutes minute(s)"
if ! server drain --wait "$wait_minutes" --reason upgrade; then
  server resume || true
  fail "the Assistant did not drain; nothing was changed"
fi

drain_active=1
snapshot=""
if [ "$use_backup" = 1 ]; then
  progress backing_up
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

# Hide the prior recovery point before replacing any recovery records. A failed
# preparation has not switched images and must never advertise mixed snapshots.
write_state preparing
if [ "$release_mode" = 1 ]; then
  if [ -f "$deploy_dir/release.env" ]; then
    copy_preserved "$deploy_dir/release.env" "$deploy_dir/.release-previous.env.tmp"
    mv "$deploy_dir/.release-previous.env.tmp" "$deploy_dir/.release-previous.env"
    printf 'yes\n' > "$deploy_dir/.release-previous-present.tmp"
  else
    rm -f "$deploy_dir/.release-previous.env"
    printf 'no\n' > "$deploy_dir/.release-previous-present.tmp"
  fi
  mv "$deploy_dir/.release-previous-present.tmp" "$deploy_dir/.release-previous-present"
fi

# Snapshot management assets only after the data backup, before any replacement.
if [ -n "$release_assets" ]; then
  rm -rf "$deploy_dir/.upgrade-assets-previous"
  mkdir -m 700 "$deploy_dir/.upgrade-assets-previous"
  owner="$(stat -c '%u:%g' "$deploy_dir" 2>/dev/null || stat -f '%u:%g' "$deploy_dir")"
  chown "$owner" "$deploy_dir/.upgrade-assets-previous"
  while read -r digest name extra; do
    [ "$name" != compose.updater.yaml ] || continue
    printf '%s\n' "$name" >> "$deploy_dir/.upgrade-assets-previous/.files"
    if [ -f "$deploy_dir/$name" ]; then
      copy_preserved "$deploy_dir/$name" "$deploy_dir/.upgrade-assets-previous/$name"
    fi
  done < "$release_assets/.asset-list"
  assets_upgrade=1
fi
progress installing
say "Switching to the new images"
# Preserve every old image before switching any local tag.
for target in $TARGETS; do
  image="$(image_of "$target")"
  if image_exists "$image:local"; then
    docker tag "$image:local" "$image:previous"
  fi
done
write_state in-progress
transaction_active=1
for target in $TARGETS; do
  image="$(image_of "$target")"
  docker tag "$image:candidate" "$image:local"
done
# Catch partial template installation failures with the same rollback as startup.
install_assets() {
  [ -n "$release_assets" ] || return 0
  while read -r digest name extra; do
    [ "$name" != compose.updater.yaml ] || continue
    temporary="$(mktemp "$deploy_dir/.upgrade-asset.XXXXXX")" || return 1
    cat "$release_assets/$name" > "$temporary" || return 1
    if [ -f "$deploy_dir/$name" ]; then
      preserve_metadata "$temporary" "$deploy_dir/$name" || return 1
    else
      owner="$(stat -c '%u:%g' "$deploy_dir" 2>/dev/null || stat -f '%u:%g' "$deploy_dir")"
      case "$name" in *.sh) chmod 700 "$temporary" || return 1 ;;
        *) chmod 600 "$temporary" || return 1 ;; esac
      chown "$owner" "$temporary" || return 1
    fi
    mv "$temporary" "$deploy_dir/$name" || return 1
  done < "$release_assets/.asset-list"
}
if ! install_assets || ! dc up -d; then
  say "The new services failed to start: rolling back"
  write_state failed
  rollback
  fail "the new services failed to start; the previous deployment was restored"
fi

progress checking_health
say "Checking the new version"
if ! smoke_check; then
  say "The new version failed its smoke check: rolling back"
  write_state failed
  rollback
  exit 1
fi

if [ "$release_mode" = 1 ]; then
  manifest_temporary="$(mktemp "$deploy_dir/.upgrade-manifest.XXXXXX")"
  {
    printf 'RELEASE_VERSION=%s\n' "$release_version"
    printf 'RELEASE_COMMIT=%s\n' "$release_commit"
    printf 'ASSISTANT_IMAGE=%s\n' "$release_assistant"
    printf 'COMMAND_WORKER_IMAGE=%s\n' "$release_command_worker"
    printf 'PUBLISHER_IMAGE=%s\n' "$release_publisher"
    printf 'BACKUP_IMAGE=%s\n' "$release_backup"
    case "$seen_keys" in *"|EDITOR_IMAGE|"*) printf 'EDITOR_IMAGE=%s\n' "$release_editor" ;; esac
    case "$seen_keys" in *"|BROWSER_IMAGE|"*) printf 'BROWSER_IMAGE=%s\n' "$release_browser" ;; esac
    case "$seen_keys" in *"|UPDATER_IMAGE|"*) printf 'UPDATER_IMAGE=%s\n' "$release_updater" ;; esac
  } > "$manifest_temporary"
  preserve_metadata "$manifest_temporary" "$deploy_dir/release.env"
  mv "$manifest_temporary" "$deploy_dir/release.env"
fi
server resume
drain_active=0
write_state done
transaction_active=0
say "Upgraded to ${commit:-the new version}. Roll back with: $0 rollback"
