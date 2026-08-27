#!/bin/zsh

set -eu

mode=""
artifact=""
target_app=""
wait_pid=""
wait_backend_pid=""
health_url=""
log_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      mode="$2"
      shift 2
      ;;
    --artifact)
      artifact="$2"
      shift 2
      ;;
    --target)
      target_app="$2"
      shift 2
      ;;
    --wait-pid)
      wait_pid="$2"
      shift 2
      ;;
    --wait-backend-pid)
      wait_backend_pid="$2"
      shift 2
      ;;
    --health-url)
      health_url="$2"
      shift 2
      ;;
    --log-path)
      log_path="$2"
      shift 2
      ;;
    *)
      print -u2 "Unknown app-update argument: $1"
      exit 64
      ;;
  esac
done

if [[ "$mode" != "preflight" && "$mode" != "install" ]]; then
  print -u2 "--mode must be preflight or install"
  exit 64
fi
if [[ -z "$artifact" || -z "$target_app" ]]; then
  print -u2 "--artifact and --target are required"
  exit 64
fi
if [[ "$mode" == "install" && ( -z "$wait_pid" || -z "$wait_backend_pid" || -z "$health_url" || -z "$log_path" ) ]]; then
  print -u2 "install mode requires --wait-pid, --wait-backend-pid, --health-url, and --log-path"
  exit 64
fi

work_dir="$(mktemp -d /tmp/solla-code-app-update.XXXXXX)"
mount_dir="$work_dir/mount"
extract_dir="$work_dir/extracted"
verified_app="$work_dir/Solla Code.app"
mounted=0

cleanup() {
  if [[ "$mounted" -eq 1 ]]; then
    /usr/bin/hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  fi
  /bin/rm -rf "$work_dir"
}
trap cleanup EXIT

artifact_kind=""
source_app=""
lower_artifact="${artifact:l}"

if [[ -d "$artifact" && "$lower_artifact" == *.app ]]; then
  artifact_kind="app"
  source_app="$artifact"
elif [[ -f "$artifact" && "$lower_artifact" == *.dmg ]]; then
  artifact_kind="dmg"
  /bin/mkdir "$mount_dir"
  /usr/bin/hdiutil attach "$artifact" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null
  mounted=1
  source_app="$(/usr/bin/find "$mount_dir" -maxdepth 2 -type d -name 'Solla Code.app' -print -quit)"
elif [[ -f "$artifact" && "$lower_artifact" == *.zip ]]; then
  artifact_kind="zip"
  /bin/mkdir "$extract_dir"
  /usr/bin/ditto -x -k "$artifact" "$extract_dir"
  source_app="$(/usr/bin/find "$extract_dir" -maxdepth 3 -type d -name 'Solla Code.app' -print -quit)"
else
  print -u2 "The macOS update artifact must be a Solla Code .app, .dmg, or .zip."
  exit 65
fi

if [[ -z "$source_app" || ! -d "$source_app" ]]; then
  print -u2 "The update artifact does not contain Solla Code.app."
  exit 65
fi

/usr/bin/ditto "$source_app" "$verified_app"
info_plist="$verified_app/Contents/Info.plist"
app_executable="$verified_app/Contents/MacOS/Solla Code"
if [[ ! -f "$info_plist" || ! -x "$app_executable" ]]; then
  print -u2 "The update artifact does not contain a runnable Solla Code application."
  exit 65
fi

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")"
if [[ "$bundle_id" != "com.sollacode.app" ]]; then
  print -u2 "Unexpected application identifier: $bundle_id"
  exit 65
fi
if [[ -z "$version" ]] || ! print -r -- "$version" | /usr/bin/grep -Eq '^[0-9A-Za-z.+-]+$'; then
  print -u2 "The update artifact has an invalid application version."
  exit 65
fi

if [[ "$mode" == "preflight" ]]; then
  /usr/bin/printf '{"platform":"darwin","artifactKind":"%s","version":"%s","productName":"Solla Code"}\n' "$artifact_kind" "$version"
  exit 0
fi

exec >> "$log_path" 2>&1
print "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ') Installing Solla Code $version from $artifact"

if [[ "$wait_pid" != <-> || "$wait_pid" -le 1 ]]; then
  print -u2 "The desktop process identifier is invalid."
  exit 64
fi
if [[ "$wait_backend_pid" != <-> || "$wait_backend_pid" -le 1 ]]; then
  print -u2 "The desktop backend process identifier is invalid."
  exit 64
fi
if [[ ! -d "$target_app" || "${target_app:l}" != *.app ]]; then
  print -u2 "The running Solla Code application target is invalid: $target_app"
  exit 65
fi

artifact_real="${artifact:A}"
target_real="${target_app:A}"
if [[ "$artifact_real" == "$target_real" ]]; then
  print -u2 "Refusing to replace the running app from the same app directory."
  exit 65
fi

# Bind this installer invocation to the exact desktop/backend process pair
# that scheduled it. Bundle identifiers survive an app replacement, while
# process identifiers do not; quitting by bundle id lets a stale retry close
# the newly installed app. A replay with dead or reused PIDs must fail before
# staging or signaling anything.
expected_executable="$target_real/Contents/MacOS/Solla Code"
desktop_command="$(/bin/ps -p "$wait_pid" -o command= 2>/dev/null || true)"
if [[ -z "$desktop_command" || "$desktop_command" != "$expected_executable"* ]]; then
  print -u2 "The Solla Code desktop process that requested this update is no longer running."
  exit 75
fi
backend_parent="$(/bin/ps -p "$wait_backend_pid" -o ppid= 2>/dev/null | /usr/bin/tr -d '[:space:]' || true)"
backend_command="$(/bin/ps -p "$wait_backend_pid" -o command= 2>/dev/null || true)"
if [[ "$backend_parent" != "$wait_pid" || "$backend_command" != "$expected_executable"* || "$backend_command" != *"apps/server/dist/bin.mjs"* ]]; then
  print -u2 "The Solla Code backend process that requested this update is no longer running."
  exit 75
fi

target_parent="${target_app:h}"
target_name="${target_app:t}"
staged_app="$target_parent/.${target_name}.update-staged-$wait_pid"
backup_app="$target_parent/.${target_name}.update-backup-$wait_pid"
shutdown_grace_seconds=15
if [[ -e "$staged_app" || -e "$backup_app" ]]; then
  print -u2 "A previous Solla Code update staging path still exists."
  exit 73
fi

/usr/bin/ditto "$verified_app" "$staged_app"

# Give the MCP response time to flush before closing the process that served it.
/bin/sleep 3
if ! /bin/kill -TERM "$wait_pid" >/dev/null 2>&1; then
  print -u2 "The Solla Code desktop process ended before it could be closed for the update."
  /bin/rm -rf "$staged_app"
  exit 75
fi

for (( attempt = 0; attempt < shutdown_grace_seconds; attempt++ )); do
  if ! /bin/kill -0 "$wait_pid" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 1
done
if /bin/kill -0 "$wait_pid" >/dev/null 2>&1; then
  # A provider drain can stall forever. Revalidate the exact captured process
  # immediately before escalating so a recycled PID can never be targeted.
  current_desktop_command="$(/bin/ps -p "$wait_pid" -o command= 2>/dev/null || true)"
  if [[ -z "$current_desktop_command" || "$current_desktop_command" != "$expected_executable"* ]]; then
    print -u2 "The Solla Code desktop process changed while the update was waiting; the installed app was not changed."
    /bin/rm -rf "$staged_app"
    exit 75
  fi
  print "Solla Code did not finish its graceful shutdown within ${shutdown_grace_seconds}s; stopping the verified desktop PID."
  /bin/kill -KILL "$wait_pid"
  for (( attempt = 0; attempt < shutdown_grace_seconds; attempt++ )); do
    if ! /bin/kill -0 "$wait_pid" >/dev/null 2>&1; then
      break
    fi
    /bin/sleep 1
  done
  if /bin/kill -0 "$wait_pid" >/dev/null 2>&1; then
    print -u2 "The verified Solla Code desktop process could not be stopped; the installed app was not changed."
    /bin/rm -rf "$staged_app"
    exit 75
  fi
fi

# Do not accept a health response from the backend that served the update
# request. The replacement must own the listener before the installer succeeds.
for (( attempt = 0; attempt < shutdown_grace_seconds; attempt++ )); do
  if ! /bin/kill -0 "$wait_backend_pid" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 1
done
if /bin/kill -0 "$wait_backend_pid" >/dev/null 2>&1; then
  current_backend_command="$(/bin/ps -p "$wait_backend_pid" -o command= 2>/dev/null || true)"
  if [[ -z "$current_backend_command" || "$current_backend_command" != "$expected_executable"* || "$current_backend_command" != *"apps/server/dist/bin.mjs"* ]]; then
    print -u2 "The Solla Code backend process changed while the update was waiting; the installed app was not changed."
    /bin/rm -rf "$staged_app"
    exit 75
  fi
  print "The old backend remained after its verified desktop owner exited; stopping that exact backend PID."
  /bin/kill -KILL "$wait_backend_pid"
  for (( attempt = 0; attempt < shutdown_grace_seconds; attempt++ )); do
    if ! /bin/kill -0 "$wait_backend_pid" >/dev/null 2>&1; then
      break
    fi
    /bin/sleep 1
  done
  if /bin/kill -0 "$wait_backend_pid" >/dev/null 2>&1; then
    print -u2 "The verified Solla Code backend process could not be stopped; the installed app was not changed."
    /bin/rm -rf "$staged_app"
    exit 75
  fi
fi

/bin/mv "$target_app" "$backup_app"
if ! /bin/mv "$staged_app" "$target_app"; then
  /bin/mv "$backup_app" "$target_app"
  exit 74
fi

# Launch the bundle at this filesystem path. Never a bundle id, never a process
# name, never a PID captured before replacement: macOS reuses PIDs and Launch
# Services can keep a stale registration for com.sollacode.app after an in-place
# swap. Targeting either one starts a second Solla Code and the installer fights
# it in a restart loop. The only process this script may signal is $wait_pid,
# verified above as the pre-update desktop executable.
launch_solla_code_app() {
  local app="$1"
  local exe="$app/Contents/MacOS/Solla Code"
  if [[ ! -x "$exe" ]]; then
    return 1
  fi
  local lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [[ -x "$lsregister" ]]; then
    "$lsregister" -f "$app" >/dev/null 2>&1 || true
  fi
  # Path as the thing to open, not `-a` / `-b`. Those look up a name or id.
  if /usr/bin/env -u ELECTRON_RUN_AS_NODE /usr/bin/open -n "$app" --args --auto-resume; then
    return 0
  fi
  print "open failed for $app; launching the installed executable directly"
  # Disown immediately: this installer exits after the health check, and a
  # child of the script would otherwise die with it.
  /usr/bin/env -u ELECTRON_RUN_AS_NODE /usr/bin/nohup "$exe" --auto-resume >/dev/null 2>&1 &!
  return 0
}

rollback() {
  print -u2 "The updated app did not become healthy; restoring the previous app."
  /bin/rm -rf "$target_app"
  /bin/mv "$backup_app" "$target_app"
  launch_solla_code_app "$target_app" || true
}

if ! launch_solla_code_app "$target_app"; then
  rollback
  exit 70
fi

healthy=0
for _ in {1..120}; do
  if /usr/bin/curl --fail --silent --show-error --max-time 2 "$health_url" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  /bin/sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  rollback
  exit 70
fi

/bin/rm -rf "$backup_app"
print "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ') Solla Code $version is healthy at $health_url"
