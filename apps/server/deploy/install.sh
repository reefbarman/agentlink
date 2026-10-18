#!/usr/bin/env bash
# Guided release installation. Compatible with macOS's Bash 3.2.
# No source checkout, Node, npm, sudo, firewall edits or automatic CA trust.
set -euo pipefail
umask 077

RELEASE_ROOT=https://github.com/reefbarman/agentlink/releases/download
mode=${1:-help}
[ "$#" -eq 0 ] || shift
version=""
deploy="${AGENTLINK_DEPLOY:-$HOME/agentlink-assistant}"
origin=""
confirmed=0
capability=""
say() { printf '==> %s\n' "$*"; }
fail() { printf 'agentlink-assistant: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'AgentLink Assistant (release installer preview)' \
    '  bash install.sh diagnose [--deploy DIR] [--origin https://HOST:8443]' \
    '  bash install.sh install --version X.Y.Z [--deploy DIR] [--origin https://HOST:8443] [--yes]' \
    '  bash install.sh update --version X.Y.Z [--deploy DIR] [--yes]' \
    '  bash install.sh rollback|status|pair [--deploy DIR] [--yes]' \
    '  bash install.sh capabilities [--deploy DIR]' \
    '  bash install.sh enable|disable editor|browser [--deploy DIR] [--yes]' \
    '  bash install.sh uninstall|resume|recover [--deploy DIR] [--yes]' \
    'Run as your normal user, with Docker Engine 28+ / Docker Desktop and Compose available.' \
    'Choose an explicit assistant-vX.Y.Z release. No images have to be built locally.' \
    'Updates preserve config and secrets and use the existing backup/rollback flow.' \
    'Managed releases use Settings > Updates; CLI update/rollback are for legacy releases only.' \
    'diagnose only reads: it downloads nothing, pulls no images and creates no files.' \
    'Optional features: editor (Edit task workspaces) and browser (Research with a browser).' \
    'uninstall stops the Assistant, its backup store and update supervisor and keeps every file;' \
    'resume starts them again. Your data, configuration and backups are never deleted.' \
    'recover finishes an interrupted change by putting back the configuration saved before it.' \
    'Supported: a local rootful Docker Engine on Linux, or Docker Desktop on Apple Silicon.'
}
case "$mode" in help | --help | -h) usage; exit 0 ;; diagnose | install | update | rollback | status | pair | capabilities | enable | disable | uninstall | resume | recover) ;; *) fail "unknown command: $mode" ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version | --deploy | --origin)
      [ "$#" -ge 2 ] || fail "$1 needs a value"
      case "$1" in --version) version=$2 ;; --deploy) deploy=$2 ;; --origin) origin=$2 ;; esac
      shift ;;
    --yes) confirmed=1 ;;
    --help | -h) usage; exit 0 ;;
    -*) fail "unknown option: $1" ;;
    *)
      [ -z "$capability" ] || fail "unexpected argument: $1"
      capability=$1 ;;
  esac
  shift
done
case "$mode" in
  enable | disable)
    case "$capability" in
      editor | browser) ;;
      "") fail "name the optional feature: $mode editor or $mode browser" ;;
      *) fail "unknown optional feature: $capability (choose editor or browser)" ;;
    esac ;;
  *) [ -z "$capability" ] || fail "unexpected argument: $capability" ;;
esac
case "$deploy" in /*) ;; *) fail "--deploy must be an absolute path" ;; esac
case "$deploy" in *$'\n'* | *$'\r'* | *:* | *"'"*) fail "the deployment path cannot contain a newline, colon or single quote" ;; esac
case "$deploy/" in *//* | */./* | */../*) fail "--deploy must be a normalised absolute path without a trailing slash" ;; esac
if [ "$mode" = install ] || [ "$mode" = update ]; then
  [[ "$version" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || fail "choose a released version with --version X.Y.Z (see https://github.com/reefbarman/agentlink/releases)"
fi
# Prerequisite checks. Each reports pass, warning, blocked or unknown, with
# the next owner action. None of them changes the host. `diagnose` prints
# them all; other commands stop on a blocked check before doing anything.
blocked=0
check() {
  local status=$1 name=$2 detail=$3 action=${4:-}
  [ "$status" != blocked ] || blocked=$((blocked + 1))
  if [ "$mode" = diagnose ]; then
    printf '[%s] %s: %s\n' "$status" "$name" "$detail"
    [ -z "$action" ] || printf '    next: %s\n' "$action"
  elif [ "$status" = blocked ]; then
    printf 'agentlink-assistant: %s%s\n' "$detail" "${action:+; $action}" >&2
  elif [ "$status" != pass ]; then
    printf '==> %s: %s%s\n' "$status" "$detail" "${action:+ ($action)}"
  fi
}
host_os=$(uname -s)
host_arch=$(uname -m)
case "$host_os" in
  Linux | Darwin) check pass platform "$host_os $host_arch" ;;
  *) check blocked platform "only Linux and macOS are supported by this installer (found $host_os)" ;;
esac
case "$host_arch" in
  x86_64 | amd64) host_arch=amd64 ;;
  aarch64 | arm64) host_arch=arm64 ;;
  *) check blocked architecture "only amd64 and arm64 hosts are supported (found $host_arch)"; host_arch="" ;;
esac
if [ "$host_os" = Darwin ] && [ "$host_arch" = amd64 ]; then
  check warning platform "Intel Macs are not qualified; the tested macOS layout is Apple Silicon with Docker Desktop"
fi
if [ "$(id -u)" = 0 ]; then
  check blocked user "run as your normal user, not root; do not use sudo for this installer"
else
  check pass user "running as a normal user"
fi
docker_ok=0
if ! command -v docker >/dev/null; then
  check blocked docker "Docker is not installed" "install Docker Engine 28+ and Compose on Linux (https://docs.docker.com/engine/install/) or Docker Desktop on macOS (https://docs.docker.com/desktop/setup/install/mac-install/), then rerun"
elif ! docker info >/dev/null 2>&1; then
  check blocked docker "Docker is not reachable" "start Docker Desktop or ask your administrator to grant Docker access (Docker access is root-equivalent)"
else
  docker_ok=1
  if docker compose version >/dev/null 2>&1; then
    check pass compose "Docker Compose v2 is available"
  else
    check blocked compose "Docker Compose v2 is required" "install it with Docker, then rerun"
  fi
  docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  docker_major=${docker_version%%.*}
  if [[ "$docker_major" =~ ^[0-9]+$ ]] && [ "$docker_major" -ge 28 ]; then
    check pass engine "Docker Engine $docker_version"
  else
    check blocked engine "Docker Engine 28+ is required for isolated container networks (found ${docker_version:-unknown})" "upgrade Docker, then rerun"
  fi
fi
case "$mode" in diagnose | install) ;; *) [ "$blocked" = 0 ] || exit 1 ;; esac

# A user's global Compose settings must not select a different application.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME

nearest_existing() {
  local path=$1
  while [ ! -e "$path" ] && [ ! -L "$path" ]; do path=$(dirname "$path"); done
  printf '%s\n' "$path"
}
resolves() {
  if command -v getent >/dev/null 2>&1 && getent hosts "$1" >/dev/null 2>&1; then return 0; fi
  if command -v dscacheutil >/dev/null 2>&1 && dscacheutil -q host -a name "$1" 2>/dev/null | grep -q 'address:'; then return 0; fi
  return 1
}
port_in_use() {
  # Prints yes, no or unknown for TCP port $1 (default 8443). ss sees every
  # user's listeners on Linux.
  local found port=${1:-8443}
  if [ "$host_os" = Linux ] && command -v ss >/dev/null 2>&1; then
    found=$(ss -Hltn "sport = :$port" 2>/dev/null) || { printf 'unknown\n'; return; }
  elif command -v lsof >/dev/null 2>&1; then
    found=$(lsof -nP "-iTCP:$port" -sTCP:LISTEN -t 2>/dev/null || true)
  else
    printf 'unknown\n'
    return
  fi
  if [ -n "$found" ]; then printf 'yes\n'; else printf 'no\n'; fi
}

# Checks for a fresh installation: the local Docker layout this stack needs,
# tools, free locations, storage, the HTTPS port and the browser address.
install_checks() {
  local endpoint scheme socket docker_os docker_arch security parent available host path paths_free=1
  witness="$deploy-witness"
  updater="$deploy-updater"
  if [ "$docker_ok" = 1 ]; then
    # DOCKER_HOST wins over the selected context, as it does for docker itself.
    endpoint=${DOCKER_HOST:-}
    [ -n "$endpoint" ] || endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
    docker_os=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)
    docker_arch=$(docker info --format '{{.Architecture}}' 2>/dev/null || true)
    security=$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)
    socket=""
    case "$endpoint" in
      unix://?*) socket=${endpoint#unix://} ;;
      "") check unknown docker-endpoint "could not read the Docker endpoint of the current context" "check docker context ls" ;;
      *)
        case "$endpoint" in *://*) scheme=${endpoint%%://*} ;; *) scheme=unrecognised ;; esac
        check blocked docker-endpoint "the current Docker context or DOCKER_HOST uses a $scheme endpoint, not this machine's local socket" "use the local Docker daemon; remote TCP/SSH daemons are not supported because deployment directories are bind-mounted from this machine" ;;
    esac
    case "$security" in
      *rootless*) check blocked docker-mode "rootless Docker is not supported" "use the system Docker daemon (rootful Docker Engine on Linux, Docker Desktop on macOS)" ;;
    esac
    if [ -n "$socket" ]; then
      if [ "$host_os" = Darwin ]; then
        if [ "$docker_os" = "Docker Desktop" ]; then
          check pass docker-layout "Docker Desktop with a local socket (Desktop maps it into containers)"
        else
          check blocked docker-layout "only Docker Desktop is supported on macOS (found ${docker_os:-an unknown engine})" "use Docker Desktop; Colima, OrbStack and other engines are not qualified"
        fi
      else
        case "$socket" in
          /var/run/docker.sock | /run/docker.sock) check pass docker-layout "local system Docker socket at $socket" ;;
          *) check blocked docker-layout "Docker socket $socket is not the system socket" "use the local system Docker Engine; the runner manager and update supervisor mount /var/run/docker.sock" ;;
        esac
      fi
    fi
    case "$docker_arch" in x86_64 | amd64) docker_arch=amd64 ;; aarch64 | arm64) docker_arch=arm64 ;; esac
    if [ -z "$docker_arch" ]; then
      check unknown docker-architecture "could not read the Docker daemon architecture"
    elif [ -n "$host_arch" ] && [ "$docker_arch" != "$host_arch" ]; then
      check blocked docker-architecture "Docker runs $docker_arch images on this $host_arch host" "use a native Docker daemon; emulated daemons are not supported"
    else
      check pass docker-architecture "Docker runs native $docker_arch images"
    fi
    [ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-assistant 2>/dev/null)" ] || check blocked existing-deployment "an Assistant Compose deployment already exists on this Docker host" "use its update workflow"
    [ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-witness 2>/dev/null)" ] || check blocked existing-deployment "a witness Compose deployment already exists on this Docker host" "do not replace its backup store"
    [ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-updater 2>/dev/null)" ] || check blocked existing-deployment "an update supervisor deployment already exists on this Docker host" "do not replace its state"
    if docker image inspect agentlink-assistant:local >/dev/null 2>&1; then
      check blocked existing-deployment "local Assistant images already exist" "use the existing deployment's update workflow rather than replacing its image tags"
    fi
  fi
  if command -v curl >/dev/null; then check pass tools "curl is available"; else check blocked tools "curl is required to download release assets"; fi
  if command -v openssl >/dev/null; then check pass tools "openssl is available"; else check blocked tools "openssl is required to generate service secrets"; fi
  if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then
    check pass tools "a SHA-256 command is available"
  else
    check blocked tools "sha256sum or shasum is required to verify release assets"
  fi
  for path in "$deploy" "$witness" "$updater"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      paths_free=0
      check blocked paths "fresh installation requires a new directory; $path already exists (nothing overwritten)" "choose another --deploy, or use the existing installation's update workflow"
    fi
  done
  parent=$(nearest_existing "$(dirname "$deploy")")
  if [ ! -d "$parent" ] || [ ! -w "$parent" ]; then
    check blocked paths "cannot create $deploy: $parent is not a directory you can write" "choose a --deploy location your user owns"
  elif [ "$paths_free" = 1 ]; then
    check pass paths "$deploy, $witness and $updater can be created"
  fi
  available=$(df -Pk "$parent" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)
  if [[ "$available" =~ ^[0-9]+$ ]]; then
    if [ "$available" -lt 10485760 ]; then
      check warning storage "$((available / 1048576)) GiB free at $parent" "data, backups and update copies need room; 10 GiB is an advisory threshold, not a measured minimum"
    else
      check pass storage "$((available / 1048576)) GiB free at $parent"
    fi
  else
    check unknown storage "could not measure free space at $parent"
  fi
  if [ "$host_os" = Darwin ]; then
    case "$deploy/" in
      /Users/* | /Volumes/* | /private/* | /tmp/* | /var/folders/*) check unknown file-sharing "Docker Desktop shares this location by default; bind mounts are only verified when the stack starts" ;;
      *) check warning file-sharing "$deploy is outside Docker Desktop's default shared folders" "add it under Docker Desktop Settings > Resources > File sharing before installing" ;;
    esac
  fi
  case "$(port_in_use)" in
    yes) check blocked port "port 8443 is already in use on this machine" "stop the other service; the Assistant always publishes HTTPS on 8443" ;;
    no) check pass port "port 8443 is free. Docker publishes it on all interfaces, outside host firewalls such as ufw; do not forward it from the internet" ;;
    *) check unknown port "could not check whether port 8443 is in use (no ss or lsof)" ;;
  esac
  if [ -z "$origin" ] && [ "$mode" = install ] && [ "$blocked" = 0 ]; then
    default_host=$(hostname -s 2>/dev/null || hostname)
    default_host=${default_host%%.*}
    default_origin="https://$default_host.local:8443"
    if [ -t 0 ]; then
      printf 'Browser address [%s]: ' "$default_origin"
      IFS= read -r origin
      origin=${origin:-$default_origin}
    else
      check blocked origin "--origin https://HOST:8443 is required without a terminal"
    fi
  fi
  if [ -n "$origin" ]; then
    if [[ "$origin" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*:8443$ ]]; then
      host=${origin#https://}
      host=${host%:8443}
      if [[ "$host" =~ ^[0-9]{1,3}([.][0-9]{1,3}){3}$ ]]; then
        check warning origin "$origin uses an IP address" "the local CA is tied to it, so a changed address needs a new CA; prefer a hostname with a DHCP reservation"
      elif resolves "$host"; then
        check pass origin "$host resolves on this machine; each client device must resolve it to this machine too"
      else
        check warning origin "$host does not resolve on this machine" "make DNS or mDNS resolve it to this machine for every client device; the installer does not change DNS"
      fi
    else
      check blocked origin "--origin must be https://HOST:8443 (a hostname or IPv4 address, no path)"
    fi
  elif [ "$mode" = diagnose ]; then
    check unknown origin "no browser address given" "pass --origin https://HOST:8443 to check it"
  fi
}
if [ "$mode" = install ] || [ "$mode" = diagnose ]; then install_checks; fi
if [ "$mode" = diagnose ]; then
  printf '\n'
  if [ "$blocked" = 0 ]; then
    say 'No blocking problems found. Image pulls, bind mounts, child containers and client certificate trust are only verified by installing and on each device.'
    exit 0
  fi
  say "$blocked blocking problem(s) found. Installation would stop before changing anything."
  exit 1
fi
[ "$blocked" = 0 ] || fail "prerequisite checks failed; nothing was changed"
confirm() {
  [ "$confirmed" = 1 ] && return 0
  [ -t 0 ] || fail "confirmation requires a terminal; review the instructions and use --yes for an intentional non-interactive run"
  local reply
  printf 'Continue? [y/N] '
  IFS= read -r reply
  case "$reply" in y | Y | yes | YES) ;; *) fail "cancelled; nothing was changed" ;; esac
}
installed() {
  [ -f "$deploy/server.json" ] && [ -f "$deploy/compose.yaml" ] || fail "no installed deployment at $deploy"
}
dc() { (cd "$deploy" && docker compose "$@"); }
if [ "$mode" = status ]; then
  installed
  if [ -f "$deploy/release.env" ]; then
    say "Installed Assistant $(sed -n 's/^RELEASE_VERSION=//p' "$deploy/release.env") at $deploy"
  else
    say "Source-built Assistant at $deploy"
  fi
  dc ps
  exit 0
fi
if [ "$mode" = pair ]; then installed; dc exec assistant agentlink-server pair; exit 0; fi
if [ "$mode" = rollback ]; then
  installed
  [ ! -f "$deploy/assistant-deployment.json" ] || fail "managed releases require Settings > Updates > Roll back so supervisor assets and data are restored together"
  [ -f "$deploy/upgrade.sh" ] || fail "this deployment has no installed updater; use the upgrade.sh from its source checkout"
  say 'Rollback restores the previous images and pre-update data; later changes will be kept aside and scheduled jobs will be paused.'
  confirm
  exec bash "$deploy/upgrade.sh" rollback --deploy "$deploy"
fi
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$1"); else actual=$(shasum -a 256 "$1"); fi
  printf '%s\n' "${actual%% *}"
}

# Optional features, uninstall, resume and recovery for a managed release
# installation. Every change holds the deployment guard shared with the
# update supervisor (UPDATER/.deployment-mutation-lock, also taken by every
# browser update) and is journalled in UPDATER/.lifecycle-state.json. The
# files it replaces are copied to UPDATER/lifecycle-recovery/ first, so a
# failed or interrupted change can be put back exactly. Only the installed
# release's own hash-verified templates and digest-pinned images are used:
# nothing here takes a Compose file, image, mount, port or command as input.
# A killed command leaves the guard and an unsettled journal in place; it is
# never replayed automatically (see `recover`).
LOCK_NAME=.deployment-mutation-lock
JOURNAL_NAME=.lifecycle-state.json
guard_held=0
journal_written=0
journal_id=""
lifecycle_action=""
drained=0
capability_label() { case "$1" in editor) printf 'Edit task workspaces' ;; browser) printf 'Research with a browser' ;; esac; }
capability_image_key() { case "$1" in editor) printf 'EDITOR_IMAGE' ;; browser) printf 'BROWSER_IMAGE' ;; esac; }
capability_container_label() { case "$1" in editor) printf 'dev.agentlink.editor' ;; browser) printf 'dev.agentlink.browser' ;; esac; }
# The one server.json line each feature adds, next to the runners line the
# installer wrote. A file that does not match that layout is left alone.
capability_config_line() {
  case "$1" in
    editor) printf '%s' '  "editor": {"port": 8444},' ;;
    browser) printf '%s' '  "browser": {},' ;;
  esac
}
installed_hash() {
  awk -v key="\"$1\":" '$1 == key { gsub(/[",]/, "", $2); print $2 }' "$deploy/assistant-deployment.json"
}
managed_install() {
  installed
  witness="$deploy-witness"
  updater="$deploy-updater"
  [ -f "$deploy/assistant-deployment.json" ] && [ -f "$deploy/release.env" ] || fail "optional features, uninstall and recovery need a release installation made by this installer; source-built deployments are changed by hand (see the README)"
  grep -Eq '^[[:space:]]*"lifecycleProtocol": 1,?[[:space:]]*$' "$deploy/assistant-deployment.json" || fail "this installation's release predates safe optional-feature changes; update it in Settings > Updates first"
  [ -d "$updater" ] && [ ! -L "$updater" ] || fail "the update supervisor directory $updater is missing; nothing was changed"
  grep -Fqx "AGENTLINK_DEPLOY_DIRECTORY='$deploy'" "$updater/.env" 2>/dev/null || fail "$updater does not belong to $deploy; nothing was changed"
  version=$(sed -n 's/^RELEASE_VERSION=//p' "$deploy/release.env")
  [[ "$version" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || fail "installed release metadata is invalid"
}
# COMPOSE_FILE in .env is the only record of which features are selected.
read_compose_files() {
  local count name
  count=$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE[[:space:]]*=' "$deploy/.env" 2>/dev/null || true)
  [ "$count" = 1 ] || fail "$deploy/.env must have exactly one COMPOSE_FILE line; change optional features by hand (see the README)"
  ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?COMPOSE_PATH_SEPARATOR' "$deploy/.env" || fail "$deploy/.env sets COMPOSE_PATH_SEPARATOR; change optional features by hand (see the README)"
  compose_files=$(sed -n 's/^COMPOSE_FILE=//p' "$deploy/.env")
  [[ "$compose_files" =~ ^compose[a-z.-]*\.yaml(:compose[a-z.-]*\.yaml)*$ ]] || fail "COMPOSE_FILE in $deploy/.env is not a plain list of release templates; change optional features by hand (see the README)"
  local IFS=:
  for name in $compose_files; do
    [[ "$(installed_hash "$name")" =~ ^[0-9a-f]{64}$ ]] || fail "COMPOSE_FILE names $name, which is not a template of this release; nothing was changed"
    [ -f "$deploy/$name" ] && [ ! -L "$deploy/$name" ] && [ "$(sha256_file "$deploy/$name")" = "$(installed_hash "$name")" ] || fail "$deploy/$name differs from this release's copy; change optional features by hand (see the README). Nothing was changed"
  done
}
# Before running Compose for the whole installation: the selected templates
# and the update supervisor's template must be this release's exact copies.
verify_installed_templates() {
  read_compose_files
  [ -f "$updater/compose.yaml" ] && [ ! -L "$updater/compose.yaml" ] && [ "$(sha256_file "$updater/compose.yaml")" = "$(installed_hash compose.updater.yaml)" ] || fail "$updater/compose.yaml differs from this release's copy; start it by hand (see the README). Nothing was changed"
}
selected() { case ":$compose_files:" in *":$1:"*) return 0 ;; esac; return 1; }
config_has() { grep -Fqx "$(capability_config_line "$1")" "$deploy/server.json"; }
config_mentions() { grep -Eq "^[[:space:]]*\"$1\"[[:space:]]*:" "$deploy/server.json"; }
runners_line_ok() { [ "$(grep -Ec '^  "runners": \{"manager": .*\},$' "$deploy/server.json" || true)" = 1 ]; }
# enabled, disabled, changed-by-hand, or "unavailable: <reason>".
capability_state() {
  local cap=$1 file="compose.$1.yaml" in_env=0 in_config=0 image
  if selected "$file"; then in_env=1; fi
  if config_has "$cap"; then in_config=1; fi
  if [ "$in_env" = 1 ] && [ "$in_config" = 1 ]; then printf 'enabled'; return; fi
  if [ "$in_env" = 1 ] || [ "$in_config" = 1 ] || config_mentions "$cap"; then printf 'changed-by-hand'; return; fi
  if ! selected compose.runners.yaml || ! runners_line_ok; then printf 'unavailable: it needs session runners as the installer set them up'; return; fi
  [[ "$(installed_hash "$file")" =~ ^[0-9a-f]{64}$ ]] || { printf 'unavailable: this release has no %s template' "$file"; return; }
  image=$(sed -n "s/^$(capability_image_key "$cap")=//p" "$deploy/release.env")
  [[ "$image" =~ ^ghcr[.]io/reefbarman/agentlink-[a-z-]+@sha256:[0-9a-f]{64}$ ]] || { printf 'unavailable: this release has no pinned %s image' "$cap"; return; }
  printf 'disabled'
}
# Empty when there is no journal or it cannot be read as schema 1 (callers
# that find the file present treat that as unknown, never as settled).
journal_status() {
  local file="$updater/$JOURNAL_NAME"
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(wc -c < "$file" | tr -d ' ')" -le 4096 ] || return 0
  grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1[[:space:]]*[,}]' "$file" || return 0
  sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z-]*\)".*/\1/p' "$file" 2>/dev/null || true
}
journal_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([A-Za-z0-9-]*\\)\".*/\\1/p" "$updater/$JOURNAL_NAME" 2>/dev/null || true; }
journal() {
  local temporary="$updater/$JOURNAL_NAME.$$"
  printf '{"schemaVersion": 1, "id": "%s", "action": "%s", "capability": "%s", "status": "%s", "updatedAt": %s}\n' \
    "$journal_id" "$lifecycle_action" "$capability" "$1" "$(date +%s)" > "$temporary"
  mv -f "$temporary" "$updater/$JOURNAL_NAME"
  journal_written=1
}
show_guard_owner() {
  [ -r "$updater/$LOCK_NAME/owner" ] || return 0
  printf 'Guard held by:\n' >&2
  sed 's/^/  /' "$updater/$LOCK_NAME/owner" >&2 || true
}
acquire_guard() {
  if ! mkdir -m 755 "$updater/$LOCK_NAME" 2>/dev/null; then
    show_guard_owner
    fail "a browser update, another optional-feature change or an uninstall holds $updater/$LOCK_NAME, or an interrupted one left it; wait for it, or see: bash $deploy/install.sh recover --deploy $deploy"
  fi
  guard_held=1
  printf 'kind=%s\npid=%s\nstarted=%s\n' "$1" "$$" "$(date +%s)" > "$updater/$LOCK_NAME/owner"
}
release_guard() {
  rm -f "$updater/$LOCK_NAME/owner"
  rmdir "$updater/$LOCK_NAME" 2>/dev/null || true
  guard_held=0
}
# Checked under the guard: no update, rollback or earlier change is running
# or unsettled. A missing .upgrade-lock is not taken as proof of recovery.
deployment_states_ok() {
  local status id phase
  [ ! -e "$deploy/.upgrade-lock" ] || fail "an update or rollback is running, or an interrupted one left $deploy/.upgrade-lock; follow the update recovery steps in the README first"
  if [ -e "$deploy/.upgrade-state" ]; then
    status=$(sed -n 's/^status=//p' "$deploy/.upgrade-state" 2>/dev/null || true)
    case "$status" in
      done | rolled-back | retired) ;;
      *) fail "the last update or rollback is not settled (status ${status:-unreadable}); follow the update recovery steps in the README first" ;;
    esac
  fi
  if [ -e "$updater/current-operation.json" ]; then
    id=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([0-9a-f-]*\)".*/\1/p' "$updater/current-operation.json" 2>/dev/null || true)
    phase=""
    [ -z "$id" ] || phase=$(sed -n 's/.*"phase"[[:space:]]*:[[:space:]]*"\([a-z_]*\)".*/\1/p' "$updater/operations/$id.json" 2>/dev/null || true)
    case "$phase" in
      completed | failed) ;;
      interrupted) fail "a browser update was interrupted; follow the update recovery steps in the README first" ;;
      *) fail "a browser update is ${phase:-in a state this command cannot read}; wait for it to finish first" ;;
    esac
  fi
  [ -z "$(docker ps -q --filter label=io.agentlink.updater.operation 2>/dev/null)" ] || fail "an update job is still running; wait for it to finish"
  if [ -e "$updater/$JOURNAL_NAME" ]; then
    status=$(journal_status)
    case "$status" in
      completed | rolled-back | recovered | resumed) ;;
      uninstalled) [ "$mode" = resume ] || fail "this installation is uninstalled; start it again first: bash $deploy/install.sh resume --deploy $deploy" ;;
      *) fail "an earlier optional-feature change or uninstall did not finish (status ${status:-unreadable}); run: bash $deploy/install.sh recover --deploy $deploy" ;;
    esac
  fi
}
wait_ready() {
  local deadline=$(($(date +%s) + 180))
  while :; do
    if dc exec -T assistant agentlink-server smoke-check; then return 0; fi
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 5
  done
}
drain_and_back_up() {
  say 'Draining: new chats, tasks and scheduled runs wait; running work has up to 15 minutes to finish.'
  dc exec -T assistant agentlink-server drain --wait 15 --reason maintenance || fail "the Assistant did not drain; nothing was changed"
  drained=1
  say 'Backing up before the change.'
  if ! dc exec -T assistant agentlink-server backup; then
    dc exec -T assistant agentlink-server resume || true
    drained=0
    fail "the backup failed; nothing was changed"
  fi
}
undrain() {
  dc exec -T assistant agentlink-server resume || printf 'Warning: could not lift the drain; run: cd %q && docker compose exec assistant agentlink-server resume\n' "$deploy" >&2
  drained=0
}
# Replace a file in place, keeping its owner and mode: stdin is the content.
replace_file() {
  local temporary="$1.lifecycle.$$"
  cp -p "$1" "$temporary" && cat > "$temporary" && mv -f "$temporary" "$1"
}
recovery_dir() { printf '%s/lifecycle-recovery' "$updater"; }
save_recovery_set() {
  local recovery file
  recovery=$(recovery_dir)
  # The previous set belongs to a settled transaction (checked above).
  rm -rf "$recovery"
  mkdir -m 700 "$recovery"
  cp -p "$deploy/.env" "$recovery/env"
  cp -p "$deploy/server.json" "$recovery/server.json"
  for file in "$deploy"/compose*.yaml; do
    [ ! -f "$file" ] || printf '%s\n' "${file##*/}"
  done > "$recovery/templates"
  printf '%s\n' "$journal_id" > "$recovery/id"
}
restore_recovery_set() {
  local recovery file
  recovery=$(recovery_dir)
  [ -f "$recovery/env" ] && [ -f "$recovery/server.json" ] && [ -f "$recovery/templates" ] || return 1
  [ "$(cat "$recovery/id" 2>/dev/null)" = "$journal_id" ] || return 1
  cp -p "$recovery/env" "$deploy/.env.lifecycle.$$" && mv -f "$deploy/.env.lifecycle.$$" "$deploy/.env" || return 1
  cp -p "$recovery/server.json" "$deploy/server.json.lifecycle.$$" && mv -f "$deploy/server.json.lifecycle.$$" "$deploy/server.json" || return 1
  # Only this change's own feature template can go, and only if the change
  # added it; every other release file stays as it is.
  case "$capability" in editor | browser) ;; *) return 0 ;; esac
  file="$deploy/compose.$capability.yaml"
  if [ -f "$file" ] && ! grep -Fqx "compose.$capability.yaml" "$recovery/templates"; then
    rm -f "$file" || return 1
  fi
}
# The last update's rollback point holds the templates and images from before
# that update, but not this change to .env and server.json: rolling it back
# afterwards could remove a template the new .env needs. Retire it before
# anything changes; upgrade.sh rollback then refuses with nothing stopped.
retire_update_rollback() {
  local status
  [ -f "$deploy/.upgrade-state" ] || return 0
  status=$(sed -n 's/^status=//p' "$deploy/.upgrade-state")
  case "$status" in done | rolled-back) ;; *) return 0 ;; esac
  sed 's/^status=.*$/status=retired/' "$deploy/.upgrade-state" | replace_file "$deploy/.upgrade-state"
  say 'The last update can no longer be rolled back (with upgrade.sh rollback or in the browser): it was made before this change. To go back to before it, restore the backup just taken (see Backups in the README).'
}
begin_transaction() {
  lifecycle_action=$1
  journal_id="$(date +%s)-$$"
  save_recovery_set
  retire_update_rollback
  journal prepared
}
# The task containers the runner manager started: labelled
# dev.agentlink.<kind>=<id> AND named agentlink-<kind>-<id>, as it names
# them. Any other container carrying the label is left alone.
child_ids() {
  local label=$1 kind=${1##*.} id name value
  docker ps -a --filter "label=$label" --format "{{.ID}} {{.Names}} {{.Label \"$label\"}}" 2>/dev/null |
    while read -r id name value; do
      if [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] && [[ "$value" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] && [ "$name" = "agentlink-$kind-$value" ]; then
        printf '%s\n' "$id"
      fi
    done || true
}
remove_children() {
  local label ids
  for label in "$@"; do
    ids=$(child_ids "$label")
    # Word splitting on purpose: one ID per word, only Docker's hex IDs.
    [ -z "$ids" ] || docker rm -f $ids >/dev/null || printf 'Warning: could not remove every %s container\n' "$label" >&2
  done
}
roll_back_change() {
  printf 'The change did not start cleanly; putting the previous configuration back.\n' >&2
  if restore_recovery_set && dc up -d && wait_ready; then
    undrain
    journal rolled-back
    release_guard
    fail "the change was undone and the previous configuration is running again; nothing was lost. Inspect: cd $deploy && docker compose logs"
  fi
  journal rollback-failed
  fail "the change failed and could not be undone automatically. The deployment guard stays in place. Run: bash $deploy/install.sh recover --deploy $deploy"
}
# On exit: settle the guard. An unsettled journal keeps it, deliberately.
lifecycle_exit() {
  local status
  if [ "$journal_written" = 0 ]; then
    if [ "$drained" = 1 ]; then dc exec -T assistant agentlink-server resume >/dev/null 2>&1 || true; fi
    release_guard
    return 0
  fi
  status=$(journal_status)
  case "$status" in
    completed | rolled-back | recovered | resumed | uninstalled) release_guard ;;
    *)
      printf 'The change is unfinished (status %s). The deployment guard stays in place and nothing will change the deployment until you run:\n  bash %q recover --deploy %q\n' \
        "${status:-unknown}" "$deploy/install.sh" "$deploy" >&2 ;;
  esac
}

lifecycle_capabilities() {
  local cap
  managed_install
  read_compose_files
  say "Optional features of Assistant $version at $deploy:"
  for cap in editor browser; do
    printf '  %-8s %-26s %s\n' "$cap" "$(capability_label "$cap")" "$(capability_state "$cap")"
  done
  printf 'Turn one on or off with: bash %q enable|disable editor|browser --deploy %q\n' "$deploy/install.sh" "$deploy"
  printf 'Advanced, set up by hand (see the README): Claude models through Meridian, and SearXNG web search.\n'
}

lifecycle_enable() {
  local cap=$capability file="compose.$capability.yaml" state image
  managed_install
  read_compose_files
  state=$(capability_state "$cap")
  case "$state" in
    enabled) say "$(capability_label "$cap") ($cap) is already on."; exit 0 ;;
    disabled) ;;
    changed-by-hand) fail "$cap is partly set up by hand (in .env or server.json); finish or undo that by hand, as the README describes" ;;
    *) fail "$cap cannot be turned on: ${state#unavailable: }" ;;
  esac
  if [ "$cap" = editor ] && [ "$(port_in_use 8444)" = yes ]; then
    fail "port 8444 is already in use on this machine; the editor serves HTTPS on 8444"
  fi
  image=$(sed -n "s/^$(capability_image_key "$cap")=//p" "$deploy/release.env")
  say "Turn on \"$(capability_label "$cap")\" ($cap) for Assistant $version at $deploy."
  if [ "$cap" = editor ]; then
    say 'Coding tasks get an Open editor button: a browser editor (code-server) for one task folder at a time, with no credentials, started by the runner manager.'
    say 'Port 8444 will listen on all host interfaces with the same certificate as the app (Docker publishes it outside host firewalls such as ufw). Each editor link is single-use and needs a paired device.'
  else
    say 'Chats on Open web projects can open pages in a throwaway, signed-out headless Chromium started by the runner manager, with no mounts or credentials. Every request goes through the egress gateway, so private and LAN addresses stay unreachable.'
  fi
  say "Each one uses up to the runners' memory and CPU limits while open. This release's pinned image is pulled: $image"
  say 'Running work is drained and a backup is taken first. If the Assistant does not start cleanly, the previous configuration is put back.'
  confirm
  acquire_guard capability
  deployment_states_ok
  # Download and pull before anything changes.
  fetch "$file"
  [ "$(sha256_file "$work/$file")" = "$(installed_hash "$file")" ] || fail "the downloaded $file does not match this release's metadata; nothing was changed"
  docker pull "$image" || fail "could not pull $image; nothing was changed"
  drain_and_back_up
  begin_transaction enable
  cp "$work/$file" "$deploy/$file"
  docker tag "$image" "agentlink-$cap:local"
  sed "s|^COMPOSE_FILE=.*\$|COMPOSE_FILE=$compose_files:$file|" "$deploy/.env" | replace_file "$deploy/.env"
  awk -v add="$(capability_config_line "$cap")" '{ print } /^  "runners": / { print add }' "$deploy/server.json" | replace_file "$deploy/server.json"
  journal applying
  if dc config --quiet && dc up -d && wait_ready; then
    undrain
    journal completed
    release_guard
    say "$(capability_label "$cap") is on."
    exit 0
  fi
  roll_back_change
}

lifecycle_disable() {
  local cap=$capability file="compose.$capability.yaml" state remaining
  managed_install
  read_compose_files
  state=$(capability_state "$cap")
  case "$state" in
    enabled) ;;
    changed-by-hand) fail "$cap is partly set up by hand (in .env or server.json); finish or undo that by hand, as the README describes" ;;
    *) say "$(capability_label "$cap") ($cap) is already off."; exit 0 ;;
  esac
  say "Turn off \"$(capability_label "$cap")\" ($cap) at $deploy."
  if [ "$cap" = editor ]; then
    say 'Open editors close (a taken-over task goes back to its chat). Task folders, chats, history and credentials are kept, and port 8444 is no longer published.'
  else
    say 'Open research browsers close. Chats, history and credentials are kept.'
  fi
  say 'Running work is drained and a backup is taken first. The template and image stay, so turning it back on needs no download.'
  confirm
  acquire_guard capability
  deployment_states_ok
  drain_and_back_up
  begin_transaction disable
  remaining=$(printf '%s' ":$compose_files:" | sed "s|:$file:|:|; s|^:||; s|:\$||")
  sed "s|^COMPOSE_FILE=.*\$|COMPOSE_FILE=$remaining|" "$deploy/.env" | replace_file "$deploy/.env"
  awk -v drop="$(capability_config_line "$cap")" '$0 != drop' "$deploy/server.json" | replace_file "$deploy/server.json"
  journal applying
  if dc config --quiet && dc up -d && wait_ready; then
    remove_children "$(capability_container_label "$cap")"
    undrain
    journal completed
    release_guard
    say "$(capability_label "$cap") is off."
    exit 0
  fi
  roll_back_change
}

lifecycle_uninstall() {
  local label count
  managed_install
  verify_installed_templates
  say 'Uninstall stops and removes the containers and networks of:'
  printf '  %s (the Assistant)\n  %s (the update supervisor)\n  %s (the backup store)\n' "$deploy" "$updater" "$witness"
  for label in dev.agentlink.runner dev.agentlink.editor dev.agentlink.browser; do
    count=$(child_ids "$label" | wc -l | tr -d ' ' || true)
    [ "${count:-0}" = 0 ] || printf '  %s %s container(s) started for tasks and chats\n' "$count" "${label##*.}"
  done
  say 'Kept: everything in those three folders (configuration, secrets, chats and data, projects, update history and the backup repository) and the local images. Nothing is deleted.'
  say 'Running work is drained first; what is left is recorded interrupted and can be resumed later. Other Docker containers are not touched.'
  confirm
  acquire_guard uninstall
  deployment_states_ok
  lifecycle_action=uninstall
  journal_id="$(date +%s)-$$"
  journal uninstalling
  dc exec -T assistant agentlink-server drain --wait 15 --reason uninstall || printf 'Warning: the Assistant did not drain; stopping it anyway.\n' >&2
  remove_children dev.agentlink.runner dev.agentlink.editor dev.agentlink.browser
  dc down
  (cd "$updater" && docker compose down)
  (cd "$witness" && docker compose down)
  journal uninstalled
  release_guard
  say 'Uninstalled. Every file is still in place.'
  printf 'Start it again, in this order and with the same configuration and secrets:\n  bash %q resume --deploy %q\n' "$deploy/install.sh" "$deploy"
  printf 'To delete it for good, first make sure you no longer need its backups (the backup store in %s holds them, and %s/secrets/backup-password is needed to read them), then remove the three folders yourself.\n' "$witness" "$deploy"
  printf 'Also revoke any GitHub tokens or app access you gave it, and remove its CA (agentlink-ca.pem) from the devices that trust it.\n'
}

start_everything() {
  (cd "$witness" && docker compose up -d) && (cd "$updater" && docker compose up -d) && dc up -d && wait_ready
}

lifecycle_resume() {
  managed_install
  [ "$(journal_status)" = uninstalled ] || { say 'This installation is not uninstalled; nothing to resume.'; exit 0; }
  verify_installed_templates
  say "Start the backup store, update supervisor and Assistant at $deploy again, with their existing configuration and secrets."
  confirm
  acquire_guard resume
  deployment_states_ok
  lifecycle_action=resume
  journal_id=$(journal_field id)
  journal resuming
  start_everything || fail "the services did not start cleanly; inspect cd $deploy && docker compose logs, then run: bash $deploy/install.sh recover --deploy $deploy"
  undrain
  journal resumed
  release_guard
  say 'Running again. Work interrupted by the uninstall can be resumed from its chat or the Tasks panel.'
}

lifecycle_recover() {
  local lock kind pid status
  managed_install
  lock="$updater/$LOCK_NAME"
  status=$(journal_status)
  if [ -e "$updater/$JOURNAL_NAME" ] && [ -z "$status" ]; then
    fail "$updater/$JOURNAL_NAME cannot be read, so whether a change is unfinished is unknown. Recover by hand as the README describes; nothing was changed"
  fi
  if [ -d "$lock" ]; then
    kind=$(sed -n 's/^kind=//p' "$lock/owner" 2>/dev/null || true)
    pid=$(sed -n 's/^pid=//p' "$lock/owner" 2>/dev/null || true)
    case "$kind" in
      capability | uninstall | resume | recover) ;;
      update) fail "the deployment guard is held by a browser update, or one that was interrupted. Follow the update recovery steps in the README; this command never clears an update's guard" ;;
      *) fail "the deployment guard $lock has no recognised owner; inspect it by hand as the README describes, and never remove it while an update or installer command may be running" ;;
    esac
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      fail "the command holding the guard (process $pid) is still running; wait for it to finish"
    fi
  fi
  case "$status" in
    "" | completed | rolled-back | recovered | resumed)
      [ -d "$lock" ] || { say 'Nothing to recover.'; exit 0; }
      say "An interrupted $kind command left the deployment guard but recorded no unfinished change, so nothing was changed. Release the guard?"
      confirm
      guard_held=1
      release_guard
      say 'Released.'
      exit 0 ;;
    uninstalled) say "This installation was uninstalled on purpose. Start it with: bash $deploy/install.sh resume --deploy $deploy"; exit 0 ;;
  esac
  journal_id=$(journal_field id)
  lifecycle_action=$(journal_field action)
  capability=$(journal_field capability)
  [ ! -e "$deploy/.upgrade-lock" ] || fail "an update or rollback is running, or an interrupted one left $deploy/.upgrade-lock; follow the update recovery steps in the README first"
  case "$lifecycle_action" in
    enable | disable) say "An optional-feature change ($lifecycle_action ${capability:-?}) did not finish (status $status). Recovery puts back the configuration saved before it, restarts the Assistant and checks it." ;;
    uninstall | resume) say "An uninstall or resume did not finish (status $status). Recovery starts the backup store, update supervisor and Assistant with their existing configuration." ;;
    *) fail "the unfinished change in $updater/$JOURNAL_NAME is not one this command recognises; recover by hand from a backup as the README describes" ;;
  esac
  confirm
  if [ -d "$lock" ]; then
    guard_held=1
    printf 'kind=recover\npid=%s\nstarted=%s\n' "$$" "$(date +%s)" > "$lock/owner"
  else
    acquire_guard recover
  fi
  journal_written=1
  case "$lifecycle_action" in
    enable | disable)
      restore_recovery_set || fail "the saved configuration does not match the unfinished change ($journal_id); restore it by hand from a backup as the README describes. The guard stays in place"
      verify_installed_templates
      dc up -d && wait_ready || fail "the previous configuration did not start cleanly; inspect cd $deploy && docker compose logs. The guard stays in place"
      undrain ;;
    *)
      verify_installed_templates
      start_everything || fail "the services did not start cleanly; inspect cd $deploy && docker compose logs. The guard stays in place"
      undrain ;;
  esac
  journal recovered
  release_guard
  say 'Recovered: the previous configuration is running and checked.'
}

command -v curl >/dev/null || fail "curl is required to download release assets"
work=$(mktemp -d "${TMPDIR:-/tmp}/agentlink-install.XXXXXX")
install_lock=""
created_install=0
cleanup() {
  result=$?
  rm -rf "$work"
  if [ -n "$install_lock" ]; then rmdir "$install_lock" 2>/dev/null || true; fi
  if [ "$guard_held" = 1 ]; then lifecycle_exit || true; fi
  if [ "$result" != 0 ] && [ "$created_install" = 1 ]; then
    printf '\nInstallation was interrupted. Its configuration, secrets and any records are kept in:\n  %s\n  %s\n  %s\n' "$deploy" "$witness" "$updater" >&2
    printf 'Do not rerun a fresh install over them (it refuses existing directories), and do not regenerate config or secrets.\n' >&2
    printf 'Inspect: (cd %q && docker compose logs) and (cd %q && docker compose logs)\n' "$deploy" "$updater" >&2
    printf 'Retry startup, in this order (backup store, update supervisor, Assistant):\n' >&2
    printf '  (cd %q && docker compose up -d)\n' "$witness" "$updater" "$deploy" >&2
    printf 'Check: cd %q && docker compose exec -T assistant agentlink-server smoke-check\n' "$deploy" >&2
    printf 'Then back up once: cd %q && docker compose exec assistant agentlink-server backup\n' "$deploy" >&2
    printf 'Finish with the owner steps in the Device trust and Signing in sections of the release README.\n' >&2
  fi
}
trap cleanup EXIT
fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location \
    --connect-timeout 15 --max-time 120 --max-filesize 8388608 --retry 2 \
    "$RELEASE_ROOT/assistant-v$version/$1" --output "$work/$1"
}
case "$mode" in
  capabilities) lifecycle_capabilities; exit 0 ;;
  enable) lifecycle_enable ;;
  disable) lifecycle_disable ;;
  uninstall) lifecycle_uninstall; exit 0 ;;
  resume) lifecycle_resume; exit 0 ;;
  recover) lifecycle_recover; exit 0 ;;
esac
fetch assistant-release.env
if [ "$mode" = update ]; then
  installed
  [ ! -f "$deploy/assistant-deployment.json" ] || fail "managed releases require Settings > Updates so supervisor assets and images are updated together"
  [ -f "$deploy/release.env" ] || fail "this is a source-built deployment; use its existing upgrade.sh workflow (automatic conversion is not supported)"
  [ -f "$deploy/upgrade.sh" ] || fail "the installed updater is missing; restore upgrade.sh from this installation's exact release before updating"
  validator="$deploy/upgrade.sh"
  bash "$validator" --deploy "$deploy" --release-manifest "$work/assistant-release.env" --validate-release
  release_version=$(sed -n 's/^RELEASE_VERSION=//p' "$work/assistant-release.env")
  [ "$release_version" = "$version" ] || fail "the release manifest does not match requested version $version"
  current=$(sed -n 's/^RELEASE_VERSION=//p' "$deploy/release.env")
  [[ "$current" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || fail "installed release metadata is invalid"
  if [ "$current" = "$version" ]; then say "Already on $version"; exit 0; fi
  awk -v old="$current" -v next_version="$version" 'BEGIN { split(old,a,"."); split(next_version,b,"."); for(i=1;i<=3;i++) { if(b[i]+0>a[i]+0) exit 0; if(b[i]+0<a[i]+0) exit 1 } exit 1 }' || fail "use rollback, not update, to return to an older version"
  say "Update legacy release $current -> $version at $deploy. Images pull before drain, backup and health checks; config and secrets are preserved."
  say 'Legacy CLI updates change images only, not management templates, and do not enable browser updates. Read the target release notes before continuing.'
  confirm
  bash "$validator" --deploy "$deploy" --release-manifest "$work/assistant-release.env"
  exit 0
fi
fetch assistant-deployment.json
metadata_schema=$(sed -n 's/^[[:space:]]*"schemaVersion": \([0-9][0-9]*\),$/\1/p' "$work/assistant-deployment.json")
metadata_protocol=$(sed -n 's/^[[:space:]]*"updaterProtocol": \([0-9][0-9]*\),$/\1/p' "$work/assistant-deployment.json")
metadata_version=$(sed -n 's/^[[:space:]]*"version": "\([0-9.]*\)",$/\1/p' "$work/assistant-deployment.json")
metadata_commit=$(sed -n 's/^[[:space:]]*"commit": "\([0-9a-f]*\)",$/\1/p' "$work/assistant-deployment.json")
release_version=$(sed -n 's/^RELEASE_VERSION=//p' "$work/assistant-release.env")
release_commit=$(sed -n 's/^RELEASE_COMMIT=//p' "$work/assistant-release.env")
[ "$metadata_schema" = 1 ] && [ "$metadata_protocol" = 1 ] && [ "$metadata_version" = "$version" ] && [ "$metadata_commit" = "$release_commit" ] && [ "$release_version" = "$version" ] || fail "deployment metadata does not match requested release $version"
updater_image=$(sed -n 's/^UPDATER_IMAGE=//p' "$work/assistant-release.env")
[[ "$updater_image" =~ ^ghcr[.]io/reefbarman/agentlink-updater@sha256:[0-9a-f]{64}$ ]] || fail "release has no digest-pinned updater image"
asset_hash() {
  awk -v key="\"$1\":" '$1 == key { gsub(/[",]/, "", $2); print $2 }' "$work/assistant-deployment.json"
}
verify_asset() {
  expected=$(asset_hash "$1")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "deployment metadata is missing a valid hash for $1"
  [ "$(sha256_file "$work/$1")" = "$expected" ] || fail "release asset hash mismatch: $1"
}
# The official script validates the manifest as data, never as shell code.
fetch upgrade.sh
verify_asset upgrade.sh
validator="$work/upgrade.sh"
bash "$validator" --deploy "$deploy" --release-manifest "$work/assistant-release.env" --validate-release
release_version=$(sed -n 's/^RELEASE_VERSION=//p' "$work/assistant-release.env")
[ "$release_version" = "$version" ] || fail "the release manifest does not match requested version $version"
updater_image=$(sed -n 's/^UPDATER_IMAGE=//p' "$work/assistant-release.env")
[[ "$updater_image" =~ ^ghcr[.]io/reefbarman/agentlink-updater@sha256:[0-9a-f]{64}$ ]] || fail "release has no digest-pinned updater image"

# The paths were checked by install_checks; check again in case one appeared
# while assets downloaded. The origin was validated there too.
for path in "$deploy" "$witness" "$updater"; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || fail "fresh installation requires a new directory; $path already exists (nothing overwritten)"
done
say "Install Assistant $version at $deploy, with backups in $witness and the update supervisor in $updater."
say "The browser address will be $origin. It must resolve to this machine; the installer does not configure DNS or mDNS."
say 'Port 8443 will listen on all host interfaces. Docker publishes it outside host firewalls such as ufw. No firewall or router changes are made; do not forward it from the internet.'
say 'The runner manager has root-equivalent Docker socket access. The separate update supervisor also needs root-equivalent Docker socket access to apply owner-approved updates. Containers restart with Docker; Docker Desktop usually starts after login on macOS.'
say 'A local CA will be created. You must explicitly trust its certificate on each client device; no trust stores are changed automatically.'
say 'Backups on this same disk do not protect against losing the machine. Keep the generated backup password in your password manager.'
confirm
# Local image tags and Compose project names are shared by installations on
# this Docker host. Do not race another installer under this user account.
lock_path="$HOME/.agentlink-assistant-install.lock"
mkdir -m 700 "$lock_path" 2>/dev/null || fail "another install is running, or an interrupted install left $lock_path; inspect it before removing the empty lock directory"
install_lock="$lock_path"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-assistant)" ] || fail "an Assistant deployment appeared while setup was awaiting confirmation"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-witness)" ] || fail "a witness deployment appeared while setup was awaiting confirmation"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-updater)" ] || fail "an update supervisor appeared while setup was awaiting confirmation"

for asset in install.sh upgrade.sh compose.yaml compose.update-client.yaml compose.updater.yaml compose.publisher.yaml compose.runners.yaml compose.backup.yaml compose.witness.yaml server.example.json; do
  fetch "$asset"
  verify_asset "$asset"
done
# The witness runs a pinned third-party image named by its hash-verified
# template. Exactly one plain image reference is accepted.
witness_image=$(sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$work/compose.witness.yaml")
[[ "$witness_image" =~ ^[a-z0-9][a-z0-9./-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$ ]] || fail "the release's witness template does not name exactly one valid image"

# Pull every image, including the witness's, before generating any deployment
# state or changing local tags. A network/registry failure is then safe to
# retry from scratch.
while IFS='=' read -r key image || [ -n "$key" ]; do
  case "$key" in ASSISTANT_IMAGE | COMMAND_WORKER_IMAGE | PUBLISHER_IMAGE | BACKUP_IMAGE | UPDATER_IMAGE) docker pull "$image" || fail "could not pull $image; nothing was created, so the install can be retried" ;; esac
done < "$work/assistant-release.env"
docker pull "$witness_image" || fail "could not pull the backup witness image $witness_image; nothing was created, so the install can be retried"
# mkdir is deliberately exclusive: a concurrent installation cannot be overwritten.
mkdir -p "$(dirname "$deploy")"
mkdir -m 700 "$deploy"
created_install=1
mkdir -m 700 "$witness" "$updater"
mkdir -m 700 "$deploy/data" "$deploy/secrets" "$deploy/publisher"

mkdir -p "$deploy/projects/home" "$deploy/projects/.tasks" "$deploy/data/runners"
# Marks a fresh installation, so the first paired browser opens setup.
# Existing installations without this file only get a "Setup" entry.
mkdir -m 700 "$deploy/data/settings"
printf '%s\n' '{"schemaVersion": 1, "revision": 0, "freshInstall": true, "steps": {}}' > "$deploy/data/settings/onboarding.json"
# Opts this installation in to setting an OpenAI API key and the default
# model in the browser. Keys are stored by the server, never in server.json.
printf '%s\n' '{"schemaVersion": 1, "revision": 0}' > "$deploy/data/settings/model-providers.json"
cp "$work/server.example.json" "$deploy/server.example.json"
cp "$work/compose.witness.yaml" "$witness/compose.yaml"
for asset in install.sh upgrade.sh compose.yaml compose.update-client.yaml compose.publisher.yaml compose.runners.yaml compose.backup.yaml; do cp "$work/$asset" "$deploy/$asset"; done
cp "$work/assistant-release.env" "$deploy/release.env"
cp "$work/assistant-deployment.json" "$deploy/assistant-deployment.json"
cp "$work/compose.updater.yaml" "$updater/compose.yaml"
chmod 700 "$deploy/install.sh" "$deploy/upgrade.sh"

for secret in command-worker-token egress-policy-key publisher-token publisher-key runner-manager-token backup-token backup-password updater-token; do
  openssl rand -hex 32 > "$deploy/secrets/$secret"
done
cp "$deploy/secrets/updater-token" "$updater/updater-token"
printf '%s\n' 'rest:http://witness:8000/agentlink/' > "$deploy/secrets/backup-repository"
printf '%s\n' \
  'COMPOSE_FILE=compose.yaml:compose.publisher.yaml:compose.runners.yaml:compose.backup.yaml:compose.update-client.yaml' \
  "AGENTLINK_UID=$(id -u)" "AGENTLINK_GID=$(id -g)" > "$deploy/.env"
printf '%s\n' \
  "UPDATER_IMAGE=$updater_image" \
  "AGENTLINK_DEPLOY_DIRECTORY='$deploy'" \
  "AGENTLINK_UPDATER_DIRECTORY='$updater'" > "$updater/.env"
# origin is restricted above, so it cannot inject JSON or configuration keys.
cat > "$deploy/server.json" <<JSON
{
  "schemaVersion": 1,
  "dataRoot": "/var/lib/agentlink",
  "listen": {"host": "0.0.0.0", "port": 8443},
  "publicOrigins": ["$origin"],
  "tls": {"localCa": true},
  "defaultModel": {"providerId": "codex", "modelId": "gpt-6.1-sol"},
  "providers": [{"type": "codex"}],
  "projects": [{"id": "home", "label": "Home", "root": "/srv/agentlink/projects/home"}],
  "projectsRoot": "/srv/agentlink/projects",
  "ripgrepPath": "/usr/bin/rg",
  "commandWorker": {"host": "command-worker", "port": 7300, "token": {"file": "/run/secrets/command-worker-token"}, "egressProxy": "http://egress-gateway:3128", "egressPolicyKey": {"file": "/run/secrets/egress-policy-key"}},
  "publisher": {"host": "publisher", "port": 7400, "token": {"file": "/run/secrets/publisher-token"}},
  "runners": {"manager": {"host": "runner-manager", "port": 7700, "token": {"file": "/run/secrets/runner-manager-token"}}},
  "backup": {"host": "backup", "port": 7800, "token": {"file": "/run/secrets/backup-token"}},
  "updater": {"host": "updater", "port": 7900, "token": {"file": "/run/secrets/updater-token"}}
}
JSON
# Read only known values from the already validated manifest. Never source it.
while IFS='=' read -r key image || [ -n "$key" ]; do
  case "$key" in
    ASSISTANT_IMAGE) target=assistant ;;
    COMMAND_WORKER_IMAGE) target=command-worker ;;
    PUBLISHER_IMAGE) target=publisher ;;
    BACKUP_IMAGE) target=backup ;;
    *) continue ;;
  esac
  docker tag "$image" "agentlink-$target:local"
done < "$deploy/release.env"
dc config --quiet
(cd "$witness" && docker compose up -d)
(cd "$updater" && docker compose config --quiet && docker compose up -d)
dc up -d
ready=0
deadline=$(($(date +%s) + 180))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if dc exec -T assistant agentlink-server smoke-check; then ready=1; break; fi
  sleep 5
done
[ "$ready" = 1 ] || fail "startup checks failed; installation is kept at $deploy for inspection (docker compose logs). No existing installation was changed"
dc exec -T assistant agentlink-server export-ca > "$deploy/agentlink-ca.pem"
fingerprint=$(openssl x509 -in "$deploy/agentlink-ca.pem" -noout -fingerprint -sha256 2>/dev/null | sed 's/^[^=]*=//' || true)
backup_ready=1
if ! dc exec -T assistant agentlink-server backup; then
  backup_ready=0
  printf 'Warning: the first backup did not finish. Inspect the backup service and run docker compose exec assistant agentlink-server backup again before upgrading.\n' >&2
fi
if [ "$backup_ready" = 1 ]; then
  say "Installed $version and made the first backup (on this machine's disk only)."
else
  say "Installed $version, but setup is degraded: there is no backup yet. Fix it before relying on this installation or updating."
fi
say 'Remaining owner steps, in order:'
printf '  1. Save %s/secrets/backup-password somewhere off this machine, such as a password manager. Backups cannot be restored without it.\n' "$deploy"
printf '  2. Trust the local CA on each client device. Copy %s/agentlink-ca.pem over a channel you trust,\n' "$deploy"
if [ -n "$fingerprint" ]; then
  printf '     check that the device shows SHA-256 fingerprint %s, then trust it.\n' "$fingerprint"
else
  printf '     compare its fingerprint with the one printed above, then trust it.\n'
fi
printf '     Certificate instructions: https://github.com/reefbarman/agentlink/blob/assistant-v%s/apps/server/README.md#device-trust\n' "$version"
printf '  3. Pair your first browser: bash %q pair --deploy %q\n' "$deploy/install.sh" "$deploy"
printf '     Then open %s on a trusted device and enter the code. Pairing does not need a model sign-in.\n' "$origin"
printf '  4. Sign in to ChatGPT in the setup guide that opens after pairing (or Setup in the app).\n'
printf '     Terminal fallback: cd %q && docker compose exec assistant agentlink-server codex-login\n' "$deploy"
printf '  5. Optional, in the same guide: name, time zone, quiet hours, GitHub and MCP connections.\n'
printf 'Updates and rollback: open Settings > Updates in the paired browser; confirmation includes backup and interruption details.\n'
printf 'Containers restart with Docker. On macOS, Docker Desktop usually starts only after you log in, and the Assistant is unavailable while the Mac sleeps.\n'
