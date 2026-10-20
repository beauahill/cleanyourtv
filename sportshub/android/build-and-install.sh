#!/usr/bin/env bash
# Build the Sports Hub kiosk APK and install it on the stick as the default home screen.
#
#   TV_HOST=192.168.1.60 HUB_URL=http://192.168.1.50:8777/ sportshub/android/build-and-install.sh
#
# HUB_URL is optional: it overrides hub_url from res/values/config.xml without a rebuild.
# Set KEEP_STOCK_HOME=1 to install without disabling Google TV Home (then launch "Sports Hub" from
# the apps row, or press Home and pick it when Android asks).
set -euo pipefail
cd "$(dirname "$0")"
: "${TV_HOST:?set TV_HOST to the stick's IP address, e.g. TV_HOST=192.168.1.60 $0}"
STOCK_LAUNCHER="${STOCK_LAUNCHER:-com.google.android.apps.tv.launcherx}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || echo /opt/homebrew/opt/openjdk@17)}"
export ANDROID_HOME="${ANDROID_HOME:-$([ -d ~/Library/Android/sdk ] && echo ~/Library/Android/sdk || echo /opt/homebrew/share/android-commandlinetools)}"
export PATH="$JAVA_HOME/bin:$PATH"
[ -f local.properties ] || echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug -q --console=plain
PY=../../tools/venv/bin/python
[ -x "$PY" ] || PY=../../tools/venv/Scripts/python.exe
[ -x "$PY" ] || { echo "run: python3 -m venv tools/venv && tools/venv/bin/pip install -r tools/requirements.txt"; exit 1; }
export MSYS_NO_PATHCONV=1
APK=app/build/outputs/apk/debug/app-debug.apk
"$PY" -I ../../tools/b64push.py "$APK" /data/local/tmp/sportshub.apk
START="am start -n com.sportshub.tv/.MainActivity"
[ -n "${HUB_URL:-}" ] && START="$START --es url $HUB_URL"
{
  echo "pm install -r /data/local/tmp/sportshub.apk"
  echo "rm -f /data/local/tmp/sportshub.apk"
  echo "cmd package set-home-activity --user 0 com.sportshub.tv/.MainActivity"
  if [ -z "${KEEP_STOCK_HOME:-}" ]; then
    echo "pm disable-user --user 0 $STOCK_LAUNCHER"
  fi
  echo "$START"
} | "$PY" -I ../../tools/tv.py --batch
echo "Installed. Press Home on the remote. Undo: tools/restore.sh examples/onn-4k-streaming-stick/debloat.txt $STOCK_LAUNCHER"
