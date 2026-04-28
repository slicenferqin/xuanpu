#!/bin/zsh

set -euo pipefail

APP_NAME="Xuanpu"
APP_BUNDLE="玄圃.app"
APP_BUNDLE_ID="com.slicenfer.xuanpu"
TARGET_DIR="/Applications"
TARGET_APP="${TARGET_DIR}/${APP_BUNDLE}"
SUDO=()

pause() {
  printf '\nPress Return to close this window.'
  IFS= read -r _ || true
}

fail() {
  printf '\nInstall failed: %s\n' "$1" >&2
  pause
  exit 1
}

print_step() {
  printf '\n%s\n' "$1"
}

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)" || fail "Cannot resolve installer location."
SOURCE_APP="${SCRIPT_DIR}/${APP_BUNDLE}"

if [[ ! -d "$SOURCE_APP" ]]; then
  fail "Cannot find ${APP_BUNDLE}. Open the DMG and run this installer from there."
fi

if [[ "$TARGET_APP" != "/Applications/${APP_BUNDLE}" ]]; then
  fail "Refusing to install to unexpected path: ${TARGET_APP}"
fi

print_step "Installing ${APP_NAME} to ${TARGET_APP}"

if /usr/bin/pgrep -f "${APP_BUNDLE}/Contents/MacOS" >/dev/null 2>&1; then
  print_step "Quitting the running app before replacing it..."
  /usr/bin/osascript -e "tell application id \"${APP_BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
  sleep 2

  if /usr/bin/pgrep -f "${APP_BUNDLE}/Contents/MacOS" >/dev/null 2>&1; then
    fail "Xuanpu is still running. Quit it and run this installer again."
  fi
fi

needs_sudo=0
if [[ ! -w "$TARGET_DIR" ]]; then
  needs_sudo=1
fi
if [[ -e "$TARGET_APP" && ! -w "$TARGET_APP" ]]; then
  needs_sudo=1
fi

if [[ "$needs_sudo" == "1" ]]; then
  print_step "Administrator permission is required to update /Applications."
  /usr/bin/sudo -v || fail "Administrator permission was not granted."
  SUDO=(/usr/bin/sudo)
fi

if [[ -e "$TARGET_APP" ]]; then
  print_step "Replacing existing ${APP_BUNDLE}..."
  "${SUDO[@]}" /bin/rm -rf -- "$TARGET_APP" || fail "Cannot remove the existing app."
fi

print_step "Copying app bundle..."
"${SUDO[@]}" /usr/bin/ditto "$SOURCE_APP" "$TARGET_APP" || fail "Cannot copy the app bundle."

print_step "Removing macOS quarantine attributes..."
"${SUDO[@]}" /usr/bin/xattr -cr "$TARGET_APP" || fail "Cannot remove quarantine attributes."

print_step "Opening ${APP_NAME}..."
/usr/bin/open "$TARGET_APP" || fail "Cannot open the installed app."

printf '\nDone. %s is installed and ready to use.\n' "$APP_NAME"
pause
