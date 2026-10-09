#!/usr/bin/env bash
# Smoke-test the assistant and command-worker images with the shipped
# compose.yaml and server.example.json, in a throwaway compose project.
#
# Build the images first (see Dockerfile), then from the repository root:
#   apps/server/deploy/container/smoke-test.sh
#
# Safe next to a running deployment: it uses its own project name, a
# temporary directory, and publishes only on 127.0.0.1 (AGENTLINK_SMOKE_PORT,
# default 18443). It does not touch existing containers or volumes.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
assistant_image=agentlink-assistant:local
worker_image=agentlink-command-worker:local
port="${AGENTLINK_SMOKE_PORT:-18443}"
project="agentlink-smoke-$$"
work="$(mktemp -d)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok - $*"; }

compose() {
  docker compose --project-name "$project" --project-directory "$work" \
    -f "$work/compose.yaml" "$@"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$work/compose.yaml" ]; then
    echo "--- compose logs" >&2
    compose logs --no-color >&2 || true
  fi
  if [ -f "$work/compose.yaml" ]; then
    compose down --volumes --timeout 10 >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

echo "# images"
[ "$(docker image inspect -f '{{.Config.User}}' "$assistant_image")" = "1000:1000" ] ||
  fail "assistant image must run as 1000:1000"
pass "assistant image runs as 1000:1000"
[ "$(docker image inspect -f '{{.Config.User}}' "$worker_image")" = "node" ] ||
  fail "worker image must run as node"
pass "worker image runs as node"
if docker run --rm --entrypoint /bin/sh "$assistant_image" -c true >/dev/null 2>&1; then
  fail "assistant image must not contain a shell"
fi
pass "assistant image has no shell"
docker run --rm "$assistant_image" --help >/dev/null ||
  fail "assistant image cannot run agentlink-server"
pass "assistant image runs agentlink-server"
docker run --rm --entrypoint /bin/bash "$worker_image" \
  -c 'git --version && rg --version >/dev/null && [ "$(id -u)" != 0 ]' >/dev/null ||
  fail "worker image needs bash, git and ripgrep, as a non-root user"
pass "worker image has bash, git and ripgrep"

echo "# compose deployment ($project on 127.0.0.1:$port)"
cp "$here/compose.yaml" "$work/compose.yaml"
cp "$here/server.example.json" "$work/server.json"
mkdir -m 700 "$work/data" "$work/secrets"
mkdir -p "$work/projects/home"
(umask 077 && openssl rand -hex 32 >"$work/secrets/command-worker-token")
cat >"$work/.env" <<EOF
AGENTLINK_PUBLISH=127.0.0.1:$port
AGENTLINK_UID=$(id -u)
AGENTLINK_GID=$(id -g)
EOF
compose up -d --quiet-pull >/dev/null

for _ in $(seq 1 60); do
  if compose logs assistant 2>/dev/null | grep -q "listening on"; then break; fi
  sleep 1
done
compose logs assistant | grep -q "listening on" || fail "assistant did not start"
compose logs assistant | grep -q "Setup credential" ||
  fail "assistant did not print a setup credential"
pass "assistant started and printed a setup credential"

check=""
for _ in $(seq 1 30); do
  check="$(compose exec -T assistant agentlink-server --check 2>&1 || true)"
  if grep -q "Command worker: reachable" <<<"$check"; then break; fi
  sleep 1
done
grep -q "Configuration OK" <<<"$check" || fail "--check failed: $check"
grep -q "Command worker: reachable" <<<"$check" ||
  fail "assistant cannot reach the worker: $check"
pass "--check: configuration OK and command worker reachable"

status="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$port/api/auth/session")"
[ "$status" = "421" ] || fail "expected 421 for an unlisted Host, got $status"
pass "serves HTTPS and refuses hosts outside publicOrigins (421)"

compose exec -T assistant agentlink-server export-ca | grep -q "BEGIN CERTIFICATE" ||
  fail "export-ca did not print a certificate"
pass "export-ca prints the local CA"

# A command could read the token; it must still not be able to use it.
refused="$(compose exec -T command-worker node -e '
const net = require("net"), fs = require("fs");
const token = fs.readFileSync("/run/secrets/command-worker-token", "utf8").trim();
const s = net.connect({ host: "127.0.0.1", port: 7300 }, () =>
  s.write(JSON.stringify({ type: "ping", protocol: 1, token }) + "\n"));
let reply = ""; s.on("data", (d) => (reply += d)); s.on("error", () => {});
s.on("close", () => console.log(reply.includes("pong") ? "accepted" : "refused"));
')"
[ "$refused" = "refused" ] || fail "worker accepted a connection from inside its container"
pass "worker refuses connections from inside its own container"

if compose exec -T assistant /bin/sh -c true >/dev/null 2>&1; then
  fail "a shell is reachable in the running assistant"
fi
pass "no shell in the running assistant"

echo "# command egress"
# Ask the gateway for a tunnel from the worker; prints "<status> <reason>".
probe='
const http = require("http");
const req = http.request({ host: "egress-gateway", port: 3128, method: "CONNECT", path: process.argv[1] });
req.on("connect", (res, socket) => { console.log(`${res.statusCode} ${res.statusMessage}`); socket.destroy(); });
req.on("error", (error) => console.log(`error ${error.code}`));
req.setTimeout(15000, () => { console.log("timeout"); req.destroy(); });
req.end();
'
egress() { compose exec -T command-worker node -e "$probe" "$1"; }
allowed=""
for _ in $(seq 1 15); do
  allowed="$(egress registry.npmjs.org:443)"
  case "$allowed" in "200 "*) break ;; esac
  sleep 1
done
case "$allowed" in "200 "*) ;; *) fail "gateway did not open a tunnel to npm: $allowed" ;; esac
pass "gateway tunnels to an allowlisted registry"
for target in example.com:443 assistant:8443 meridian:3456 registry.npmjs.org:80 1.1.1.1:443; do
  result="$(egress "$target")"
  case "$result" in "403 "*) ;; *) fail "gateway allowed $target: $result" ;; esac
done
case "$(egress example.com:443)" in *example.com*) ;; *) fail "the refusal does not name the host" ;; esac
pass "gateway refuses unlisted hosts, sibling containers, other ports and IP addresses, naming the host"
version="$(compose exec -T -e HOME=/tmp -e HTTPS_PROXY=http://egress-gateway:3128 \
  -e npm_config_update_notifier=false \
  command-worker npm view --cache /tmp/npm-cache esbuild@0.25.0 version)"
[ "$version" = "0.25.0" ] || fail "npm through the gateway failed: $version"
pass "npm reaches the registry through the gateway"
direct="$(compose exec -T command-worker node -e '
const s = require("net").connect({ host: "1.1.1.1", port: 443 });
s.setTimeout(5000, () => { console.log("blocked"); s.destroy(); });
s.on("connect", () => { console.log("connected"); s.destroy(); });
s.on("error", () => console.log("blocked"));
')"
[ "$direct" = "blocked" ] || fail "the worker reached the internet without the gateway"
pass "the worker has no direct route to the internet"

# A canary on every host address: the worker must not reach it through its
# network's bridge gateway (which would expose sshd and the like).
canary_port="${AGENTLINK_SMOKE_CANARY_PORT:-18999}"
python3 -m http.server --bind 0.0.0.0 "$canary_port" >/dev/null 2>&1 &
canary=$!
# Keep the script's exit status for cleanup, which reads $? first.
trap 'rc=$?; kill "$canary" 2>/dev/null; (exit "$rc"); cleanup' EXIT
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$canary_port/" && break
  sleep 0.5
done
curl -s -o /dev/null "http://127.0.0.1:$canary_port/" || fail "host canary did not start"
subnet="$(docker network inspect "${project}_command-worker" -f '{{(index .IPAM.Config 0).Subnet}}')"
host_gateway="${subnet%.*}.1"
reach="$(compose exec -T command-worker node -e '
const s = require("net").connect({ host: process.argv[1], port: +process.argv[2] });
s.setTimeout(4000, () => { console.log("blocked"); s.destroy(); });
s.on("connect", () => { console.log("connected"); s.destroy(); });
s.on("error", () => console.log("blocked"));
' "$host_gateway" "$canary_port")"
[ "$reach" = "blocked" ] || fail "the worker reached a host service via $host_gateway"
pass "the worker cannot reach host services through its network gateway ($host_gateway)"

echo "# all container smoke checks passed"
