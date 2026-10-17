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
say() { printf '==> %s\n' "$*"; }
fail() { printf 'agentlink-assistant: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'AgentLink Assistant (release installer preview)' \
    '  bash install.sh install --version X.Y.Z [--deploy DIR] [--origin https://HOST:8443] [--yes]' \
    '  bash install.sh update --version X.Y.Z [--deploy DIR] [--yes]' \
    '  bash install.sh rollback|status|pair [--deploy DIR] [--yes]' \
    'Run as your normal user, with Docker Engine 28+ / Docker Desktop and Compose available.' \
    'Choose an explicit assistant-vX.Y.Z release. No images have to be built locally.' \
    'Updates preserve config and secrets and use the existing backup/rollback flow.' \
    'Managed releases use Settings > Updates; CLI update/rollback are for legacy releases only.'
}
case "$mode" in help | --help | -h) usage; exit 0 ;; install | update | rollback | status | pair) ;; *) fail "unknown command: $mode" ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version | --deploy | --origin)
      [ "$#" -ge 2 ] || fail "$1 needs a value"
      case "$1" in --version) version=$2 ;; --deploy) deploy=$2 ;; --origin) origin=$2 ;; esac
      shift ;;
    --yes) confirmed=1 ;;
    --help | -h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done
case "$deploy" in /*) ;; *) fail "--deploy must be an absolute path" ;; esac
case "$deploy" in *$'\n'* | *$'\r'* | *:* | *"'"*) fail "the deployment path cannot contain a newline, colon or single quote" ;; esac
case "$deploy/" in *//* | */./* | */../*) fail "--deploy must be a normalised absolute path without a trailing slash" ;; esac
if [ "$mode" = install ] || [ "$mode" = update ]; then
  [[ "$version" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || fail "choose a released version with --version X.Y.Z (see https://github.com/reefbarman/agentlink/releases)"
fi
case "$(uname -s)" in Linux | Darwin) ;; *) fail "only Linux and macOS are supported by this installer" ;; esac
case "$(uname -m)" in x86_64 | amd64 | aarch64 | arm64) ;; *) fail "only amd64 and arm64 hosts are supported" ;; esac
[ "$(id -u)" != 0 ] || fail "run as your normal user, not root; do not use sudo for this installer"
command -v docker >/dev/null || fail "install Docker Engine 28+ and Compose on Linux (https://docs.docker.com/engine/install/) or Docker Desktop on macOS (https://docs.docker.com/desktop/setup/install/mac-install/), then rerun"
docker info >/dev/null 2>&1 || fail "Docker is not reachable; start Docker Desktop or ask your administrator to grant Docker access (Docker access is root-equivalent)"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required; install it with Docker, then rerun"
docker_version=$(docker version --format '{{.Server.Version}}')
docker_major=${docker_version%%.*}
[[ "$docker_major" =~ ^[0-9]+$ ]] && [ "$docker_major" -ge 28 ] || fail "Docker Engine 28+ is required for isolated container networks (found $docker_version)"

# A user's global Compose settings must not select a different application.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME
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
command -v curl >/dev/null || fail "curl is required to download release assets"
work=$(mktemp -d "${TMPDIR:-/tmp}/agentlink-install.XXXXXX")
install_lock=""
created_install=0
cleanup() {
  result=$?
  rm -rf "$work"
  if [ -n "$install_lock" ]; then rmdir "$install_lock" 2>/dev/null || true; fi
  if [ "$result" != 0 ] && [ "$created_install" = 1 ]; then
    printf '\nInstallation was interrupted; generated configuration and any records are kept. Do not rerun a fresh install over them.\n' >&2
    printf 'Inspect: cd %q && docker compose logs\n' "$deploy" >&2
    printf 'Retry startup: (cd %q && docker compose up -d) && (cd %q && docker compose up -d)\n' "$witness" "$deploy" >&2
    printf 'Check: cd %q && docker compose exec -T assistant agentlink-server smoke-check\n' "$deploy" >&2
    printf 'Finish trust/sign-in/pairing using the Device trust and Signing in sections of the release README; config and secrets must not be regenerated.\n' >&2
  fi
}
trap cleanup EXIT
fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location \
    --connect-timeout 15 --max-time 120 --max-filesize 8388608 --retry 2 \
    "$RELEASE_ROOT/assistant-v$version/$1" --output "$work/$1"
}
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
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$1"); else actual=$(shasum -a 256 "$1"); fi
  printf '%s\n' "${actual%% *}"
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




[ ! -e "$deploy" ] && [ ! -L "$deploy" ] || fail "fresh installation requires a new directory; $deploy already exists (nothing overwritten)"
witness="$deploy-witness"
[ ! -e "$witness" ] && [ ! -L "$witness" ] || fail "witness directory already exists at $witness (nothing overwritten)"
updater="$deploy-updater"
[ ! -e "$updater" ] && [ ! -L "$updater" ] || fail "updater directory already exists at $updater (nothing overwritten)"
command -v openssl >/dev/null || fail "openssl is required to generate service secrets"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-assistant)" ] || fail "an Assistant Compose deployment already exists on this Docker host; use its update workflow"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-witness)" ] || fail "a witness Compose deployment already exists on this Docker host; do not replace its backup store"
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=agentlink-updater)" ] || fail "an update supervisor already exists on this Docker host; do not replace its state"
if docker image inspect agentlink-assistant:local >/dev/null 2>&1; then
  fail "local Assistant images already exist; use the existing deployment's update workflow rather than replacing its image tags"
fi
if [ -z "$origin" ]; then
  default_host=$(hostname -s 2>/dev/null || hostname)
  default_host=${default_host%%.*}
  default_origin="https://$default_host.local:8443"
  [ -t 0 ] || fail "--origin https://HOST:8443 is required without a terminal"
  printf 'Browser address [%s]: ' "$default_origin"
  IFS= read -r origin
  origin=${origin:-$default_origin}
fi
[[ "$origin" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*:8443$ ]] || fail "--origin must be https://HOST:8443 (a hostname or IPv4 address, no path)"
say "Install Assistant $version at $deploy, with backups in $witness."
say "The browser address will be $origin. It must resolve to this machine; the installer does not configure DNS or mDNS."
say 'Port 8443 will listen on all host interfaces. No firewall or router changes are made; do not forward it from the internet.'
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


# Pull all immutable images before generating any deployment state or changing
# local tags. A network/registry failure is then safe to retry from scratch.
while IFS='=' read -r key image || [ -n "$key" ]; do
  case "$key" in ASSISTANT_IMAGE | COMMAND_WORKER_IMAGE | PUBLISHER_IMAGE | BACKUP_IMAGE | UPDATER_IMAGE) docker pull "$image" ;; esac
done < "$work/assistant-release.env"
# mkdir is deliberately exclusive: a concurrent installation cannot be overwritten.
mkdir -p "$(dirname "$deploy")"
mkdir -m 700 "$deploy"
created_install=1
mkdir -m 700 "$witness" "$updater"
mkdir -m 700 "$deploy/data" "$deploy/secrets" "$deploy/publisher"

mkdir -p "$deploy/projects/home" "$deploy/projects/.tasks" "$deploy/data/runners"
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
if ! dc exec -T assistant agentlink-server backup; then
  printf 'Warning: the first backup did not finish. Inspect the backup service and run docker compose exec assistant agentlink-server backup again before upgrading.\n' >&2
fi
say "Installed $version. Remaining owner steps:"
printf '  1. Save %s/secrets/backup-password somewhere off this machine.\n' "$deploy"
printf '  2. Trust %s/agentlink-ca.pem on your client devices after checking its fingerprint.\n' "$deploy"
printf '     Certificate instructions: https://github.com/reefbarman/agentlink/blob/assistant-v%s/apps/server/README.md#device-trust\n' "$version"
printf '  3. Sign in to ChatGPT: cd %q && docker compose exec assistant agentlink-server codex-login\n' "$deploy"
printf '  4. Pair your browser: bash %q pair --deploy %q\n' "$deploy/install.sh" "$deploy"
printf '  5. Open %s. Settings, GitHub and MCP connections are in the app.\n' "$origin"
printf 'Updates and rollback: open Settings > Updates in the paired browser; confirmation includes backup and interruption details.\n'
