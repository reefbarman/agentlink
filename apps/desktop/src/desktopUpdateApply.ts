export interface DesktopPendingUpdate {
  version: string;
  staged: string;
  destination: string;
  destinationFingerprint: { inode: string; version: string };
  backup: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The detached process owns rollback. Startup, not this script, owns cleanup. */
export function buildDesktopUpdateApplyScript(options: {
  pending: DesktopPendingUpdate;
  appPid: number;
  resultPath: string;
  appWaitSeconds?: number;
  processWaitSeconds?: number;
}): string {
  const { pending } = options;
  const q = shellQuote;
  return `#!/bin/sh
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
DEST=${q(pending.destination)}
STAGED=${q(pending.staged)}
BACKUP=${q(pending.backup)}
RESULT=${q(options.resultPath)}
MOVED=0
ACTIVATED=0
record() {
  printf '%s\\n' "$1" > "$RESULT.partial" && mv -f "$RESULT.partial" "$RESULT"
}
fail() {
  trap - HUP INT TERM EXIT
  message="$1"
  if [ "$MOVED" = 1 ]; then
    if [ "$ACTIVATED" = 1 ]; then
      mv "$DEST" "$STAGED" || message="rollback_new_bundle_failed"
    fi
    if [ ! -e "$DEST" ]; then
      mv "$BACKUP" "$DEST" || message="rollback_backup_restore_failed"
    fi
  fi
  record "{\\"status\\":\\"failed\\",\\"message\\":\\"$message\\"}"
  if [ -d "$DEST" ]; then open "$DEST"; fi
  exit 1
}
trap 'fail interrupted' HUP INT TERM
trap 'fail unexpected_exit' EXIT
count=0
while kill -0 ${options.appPid} 2>/dev/null; do
  [ "$count" -lt ${options.appWaitSeconds ?? 60} ] || fail app_exit_timeout
  sleep 1
  count=$((count + 1))
done
count=0
CONTENTS_PREFIX="$DEST/Contents/"
export CONTENTS_PREFIX
while :; do
  PROCESS_LIST="$(ps -axo comm=)" || fail process_scan_failed
  printf '%s\\n' "$PROCESS_LIST" | awk 'index($0, ENVIRON["CONTENTS_PREFIX"]) == 1 { found=1 } END { exit !found }'
  case "$?" in 1) break;; 0) ;; *) fail process_scan_failed;; esac
  [ "$count" -lt ${options.processWaitSeconds ?? 120} ] || fail bundle_process_timeout
  sleep 1
  count=$((count + 1))
done
[ ! -L "$DEST" ] && [ -d "$DEST" ] || fail destination_changed
[ "$(stat -f %i "$DEST")" = ${q(pending.destinationFingerprint.inode)} ] || fail destination_changed
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist")" = ${q(pending.destinationFingerprint.version)} ] || fail destination_changed
[ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ] || fail backup_exists
[ ! -L "$STAGED" ] && [ -d "$STAGED" ] || fail staged_bundle_missing
[ "$(stat -f %d "$DEST")" = "$(stat -f %d "$STAGED")" ] || fail staging_filesystem_changed
# Two same-volume renames. Rollback covers command failures and catchable signals,
# but SIGKILL or power loss between the renames still requires manual recovery.
mv "$DEST" "$BACKUP" || fail backup_rename_failed
MOVED=1
mv "$STAGED" "$DEST" || fail activation_rename_failed
ACTIVATED=1
record '{"status":"applied"}' || fail result_write_failed
open "$DEST" || fail launch_failed
trap - HUP INT TERM EXIT
exit 0
`;
}
