#!/bin/bash
# Smoke test for the Linux Desktop deb on an Ubuntu 24.04 host (CI runner or a
# disposable VM): installs it with apt, checks that its AppArmor profile is
# loaded, launches the app headlessly and checks that Chromium kept its
# renderer sandbox with Ubuntu's unprivileged user namespace restriction on,
# then removes the package and checks the profile is unloaded.
#
# Changes the host: installs and removes packages and sets
# kernel.apparmor_restrict_unprivileged_userns=1 for the run (restored on exit).
# Usage: scripts/smoke-desktop-deb.sh desktop-releases/AgentLink-Desktop-*.deb
set -euo pipefail

deb=$(realpath "$1")
sysctl_key=kernel.apparmor_restrict_unprivileged_userns
previous=$(sysctl -n "$sysctl_key" 2>/dev/null || echo "")
log=$(mktemp)
cleanup() {
  if [ -n "${app_pid:-}" ]; then kill "$app_pid" 2>/dev/null || true; fi
  sudo apt-get remove -y -qq agentlink-desktop >/dev/null 2>&1 || true
  if [ -n "$previous" ]; then sudo sysctl -q -w "$sysctl_key=$previous"; fi
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  tail -40 "$log" >&2 || true
  exit 1
}

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends xvfb xauth dbus-x11 apparmor curl >/dev/null
# The case the profile exists for: Ubuntu 23.10+'s default restriction.
sudo sysctl -q -w "$sysctl_key=1"

sudo apt-get install -y -qq "$deb"
test -x /opt/AgentLink/agentlink || fail "/opt/AgentLink/agentlink missing"
test -f /etc/apparmor.d/agentlink || fail "AppArmor profile not installed"
sudo grep -q '^agentlink ' /sys/kernel/security/apparmor/profiles ||
  fail "AppArmor profile not loaded"
echo "AppArmor profile installed and loaded"

dbus-run-session -- xvfb-run -a /usr/bin/agentlink >"$log" 2>&1 &
app_pid=$!
for _ in $(seq 1 60); do
  sleep 1
  curl -fsS -o /dev/null http://127.0.0.1:47138/ 2>/dev/null && break
done
curl -fsS -o /dev/null http://127.0.0.1:47138/ ||
  fail "Desktop helper did not serve the chat UI"
sleep 4

browser=$(pgrep -o -x agentlink) || fail "Desktop is not running"
grep -qa -- --no-sandbox "/proc/$browser/cmdline" &&
  fail "Desktop started with --no-sandbox"
host_userns=$(readlink "/proc/$browser/ns/user")
sandboxed=0
for pid in $(pgrep -x agentlink); do
  args=$(tr '\0' ' ' <"/proc/$pid/cmdline")
  case "$args" in *--type=zygote*) ;; *) continue ;; esac
  case "$args" in *--no-sandbox*) fail "zygote has --no-sandbox" ;; esac
  # Chromium's namespace sandbox puts the sandboxed zygote in its own user
  # namespace; without userns it would fail to start or run unsandboxed.
  if [ "$(readlink "/proc/$pid/ns/user")" != "$host_userns" ]; then
    sandboxed=$((sandboxed + 1))
  fi
done
[ "$sandboxed" -gt 0 ] || fail "no zygote runs in its own user namespace"
echo "Chromium renderer sandbox is on ($sandboxed sandboxed zygote(s))"

kill "$app_pid" 2>/dev/null || true
app_pid=
sleep 2
sudo apt-get remove -y -qq agentlink-desktop >/dev/null
if sudo grep -q '^agentlink ' /sys/kernel/security/apparmor/profiles; then
  fail "AppArmor profile still loaded after removal"
fi
test ! -e /etc/apparmor.d/agentlink || fail "profile file left after removal"
echo "Package removal unloaded the AppArmor profile"
echo "PASS"
