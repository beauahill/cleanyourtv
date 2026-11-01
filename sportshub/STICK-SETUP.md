# Stick setup runbook (for a human or an agent such as OpenClaw)

Goal: take a Walmart Onn 4K Streaming Stick (Google TV) out of the box, strip the Google TV home
screen and preloads, install the Sports Hub kiosk app as the home screen, point it at the mini PC,
and prove it works with screenshots. Everything here is reversible; the last section undoes it.

Work on the real device, one step at a time, and verify each step before the next. If a step's
check fails, stop and report rather than improvising around it.

## Inputs you need before starting

| Item | Example | Where from |
|---|---|---|
| `STICK_IP` | `192.168.1.60` | On the stick: Settings → Network & Internet → the connected network |
| `HUB_URL` | `http://192.168.1.50:8777/` | The mini PC's LAN address (`hostname -I` there) plus port 8777. Not a Tailscale 100.x address: the stick is not on Tailscale. |
| Repo checkout | this repository, branch `claude/admiring-albattani-aplkym` (or `main` once merged) | `git clone` |
| `adb` | Android platform-tools on the machine running this runbook | `sudo apt install adb` / `brew install android-platform-tools` / `winget install Google.PlatformTools` |

If `adb` cannot be installed or is blocked (macOS Local Network privacy does this), use the pure
Python client instead: `python3 -m venv tools/venv && tools/venv/bin/pip install -r tools/requirements.txt`,
then replace every `adb shell <cmd>` below with `TV_HOST=$STICK_IP tools/venv/bin/python -I tools/tv.py '<cmd>'`,
and `adb install -r file.apk` with `tools/venv/bin/python -I tools/b64push.py file.apk /data/local/tmp/k.apk`
followed by `tools/tv.py 'pm install -r /data/local/tmp/k.apk'`.

Check that the hub is reachable from this machine first: `curl -s $HUB_URL/api/health` must return
`{"ok": true, ...}`. If it does not, fix the mini PC side before touching the stick.

## 0. The stick must finish Google's setup first

Someone has to do the out-of-box setup on the TV with the remote: Wi-Fi, Google sign-in, the
"choose your apps" screen (untick everything optional). ADB is not available before that. Once on
the Google TV home screen:

1. Settings → System → About → scroll to **Android TV OS build** → press OK on it 7 times until
   "You are now a developer" appears.
2. Settings → System → **Developer options** → turn on **USB debugging**. If a **Wireless
   debugging** toggle exists, turn it on too and open it: it shows an IP:port and a "Pair device
   with pairing code" entry you may need in step 1.
3. Settings → System → Power & energy (or Device Preferences) → make sure the stick does not sleep
   during setup. Set the screensaver / sleep timer to Never for now; you can restore it at the end.

## 1. Connect

```bash
adb connect $STICK_IP:5555
adb devices          # expect  192.168.1.60:5555  device   (not "unauthorized" or "offline")
```

- `unauthorized`: a dialog "Allow USB debugging?" is on the TV. Tick "Always allow" and OK, then
  `adb devices` again.
- Connection refused and the stick shows a Wireless debugging screen with a port other than 5555:
  Android 11+ pairing. On the TV choose "Pair device with pairing code", then
  `adb pair $STICK_IP:<pairing-port> <code>` and `adb connect $STICK_IP:<port shown on the main
  Wireless debugging screen>`.
- Still nothing: USB debugging is off, or the stick slept. Wake it with the remote and re-check.

Verify and record the device:

```bash
adb shell getprop ro.product.model
adb shell getprop ro.product.device
adb shell getprop ro.build.version.release
adb shell getprop ro.build.display.id
```

## 2. Back up before changing anything

```bash
MODEL=$(adb shell getprop ro.product.device | tr -d '\r')
B=backup/$MODEL-$(date +%Y%m%d-%H%M); mkdir -p $B
adb shell pm list packages -f        > $B/packages.txt
adb shell pm list packages -d        > $B/disabled-before.txt
adb shell pm list packages -e        > $B/enabled-before.txt
adb shell getprop                    > $B/getprop.txt
adb shell settings list global       > $B/settings-global.txt
adb shell settings list secure       > $B/settings-secure.txt
adb shell settings list system       > $B/settings-system.txt
adb shell dumpsys package com.google.android.apps.tv.launcherx | grep -A3 "android.intent.category.HOME" > $B/home-activity.txt
adb exec-out screencap -p            > $B/stock-home.png
```

`backup/` is git-ignored. Keep it; the rollback section uses it.

## 3. Discover what is on this stick

The debloat list in `examples/onn-4k-streaming-stick/debloat.txt` was written from the Google TV
package set without this exact device in hand. Compare before applying:

```bash
adb shell pm list packages | sed 's/package://' | sort > $B/all.txt
grep -vE '^\s*(#|$)' examples/onn-4k-streaming-stick/debloat.txt | sed -E 's/\s+#.*$//' | sort > /tmp/list.txt
comm -23 /tmp/list.txt $B/all.txt     # in the list but NOT on the device (harmless, just noise)
comm -12 /tmp/list.txt $B/all.txt     # will actually be disabled
adb shell pm list packages -f | grep -iE 'onn|walmart|vizio|vendor' || echo "no vendor packages found"
```

For any vendor package found, look at what it does before deciding:
`adb shell dumpsys package <pkg> | grep -E 'Activity|Service|Receiver' | head -30`. Add it to the
list under "Vendor" with a comment only if it is content, ads, telemetry or a demo. Never disable
anything in the keep-list at the top of the debloat file, and do not disable
`com.google.android.apps.tv.launcherx` in this step; step 5 does that after the replacement home is
proven to work.

## 4. Debloat

One package per command. Chained `pm` commands can silently stop after the first.

```bash
for p in $(comm -12 /tmp/list.txt $B/all.txt); do
  echo "== $p"; adb shell pm disable-user --user 0 $p
done
adb shell pm list packages -d > $B/disabled-after.txt
diff $B/disabled-before.txt $B/disabled-after.txt
```

Each `pm disable-user` prints `Package <pkg> new state: disabled-user`. Then press Home on the
remote (`adb shell input keyevent KEYCODE_HOME`) and take a screenshot: the Google TV home should
still come up, since it is not disabled yet.

Note the Google TV setup wizard `com.google.android.tungsten.setupwraith` is in the list. If the
stick ever shows a "Finish setting up" screen after this, re-enable it:
`adb shell pm enable com.google.android.tungsten.setupwraith`.

## 5. Install the Sports Hub kiosk and make it home

Get the APK. The repository's GitHub Actions workflow builds it on every push and attaches it to a
moving pre-release, so no Java or Android SDK is needed here:

```bash
curl -L -o sportshub-kiosk.apk https://github.com/beauahill/cleanyourtv/releases/download/kiosk-latest/sportshub-kiosk.apk
ls -la sportshub-kiosk.apk     # expect roughly 50-200 KB, not an HTML error page
```

(If that URL 404s, the build has not run yet or failed: check the Actions tab, or build locally
with `TV_HOST=$STICK_IP HUB_URL=$HUB_URL sportshub/android/build-and-install.sh`, which does all
of this section itself.)

Install, set as home, start it with the hub URL:

```bash
adb install -r sportshub-kiosk.apk
adb shell cmd package set-home-activity --user 0 com.sportshub.tv/.MainActivity
adb shell am start -n com.sportshub.tv/.MainActivity --es url $HUB_URL
sleep 6
adb exec-out screencap -p > $B/kiosk-first.png
```

Look at the screenshot. Pass: the dark Sports Hub page with the clock top left, league tabs and
score cards. Fail cases:

- "Sports Hub is offline" with the URL: the stick cannot reach the mini PC. Check `HUB_URL` is the
  LAN IP, the mini PC firewall, and that both are on the same network (`adb shell ping -c 2 <mini
  pc ip>`). Fix, then `adb shell am start -n com.sportshub.tv/.MainActivity --es url $HUB_URL`.
- A blank or black screen: wait 10 more seconds and screenshot again (WebView first start). If still
  blank: `adb logcat -d | grep -iE 'SportsHub|chromium|WebView' | tail -40` and report.

Now the Home key. Press it and confirm the hub comes up, not Google TV:

```bash
adb shell input keyevent KEYCODE_HOME; sleep 2; adb exec-out screencap -p > $B/kiosk-home.png
```

If Google TV Home appears instead, Android still prefers it. Disable it now, which is safe because
the kiosk is installed and proven:

```bash
adb shell pm disable-user --user 0 com.google.android.apps.tv.launcherx
adb shell input keyevent KEYCODE_HOME; sleep 2; adb exec-out screencap -p > $B/kiosk-home2.png
```

Either way, finish by disabling launcherx if it is not already (it is what draws the ads), and
confirm Home lands on the hub.

## 6. Prove the remote works

```bash
for k in DPAD_RIGHT DPAD_RIGHT DPAD_CENTER DPAD_DOWN DPAD_RIGHT DPAD_CENTER; do adb shell input keyevent KEYCODE_$k; sleep 1; done
adb exec-out screencap -p > $B/kiosk-nav.png        # expect a game board or the game detail overlay
adb shell input keyevent KEYCODE_BACK; sleep 1
adb exec-out screencap -p > $B/kiosk-back.png       # expect the hub again
```

Then open an app from the dock and come back: Down to the dock, OK on the first tile, screenshot
(the app should be on screen), then `adb shell input keyevent KEYCODE_HOME` and screenshot (hub
again). If the dock shows "Not installed" toasts, the package names in `config.local.json` on the
mini PC don't match this stick: `adb shell pm list packages | grep -iE 'espn|youtube|fox|peacock'`
gives the right ones, or set `"apps": []` there so the kiosk lists what is installed by itself.

## 7. Finishing touches

- Restore the sleep / screensaver setting from step 0 if you changed it. The kiosk keeps the
  screen on while it is in front; the stick's own sleep timer still applies if you want it to.
- Reboot once and confirm it boots straight into the hub: `adb reboot`, wait 60 s,
  `adb connect $STICK_IP:5555`, screenshot.
- Report: device model and build, the packages disabled (diff from step 4), the hub URL set, and
  attach the screenshots from `$B`.

## Updating later

New kiosk build: `curl -L -o sportshub-kiosk.apk <same URL>` then `adb install -r sportshub-kiosk.apk`.
Same signing key, so it upgrades in place and keeps the URL. The page itself updates with
`git pull` on the mini PC; the stick just reloads it.

Change the URL: `adb shell am start -n com.sportshub.tv/.MainActivity --es url http://new-ip:8777/`.

## Rollback

```bash
adb shell pm enable com.google.android.apps.tv.launcherx
adb shell pm enable com.google.android.tungsten.setupwraith
adb shell cmd package set-home-activity --user 0 com.google.android.apps.tv.launcherx/com.google.android.apps.tv.launcherx.home.HomeActivity 2>/dev/null || true
adb uninstall com.sportshub.tv
for p in $(sed 's/package://' $B/disabled-after.txt | tr -d '\r'); do adb shell pm enable $p; done
adb shell input keyevent KEYCODE_HOME
```

If the home activity path above is wrong for this firmware, uninstalling the kiosk is enough:
Android falls back to the only remaining HOME app. `$B/home-activity.txt` from the backup has the
exact component if you need it.
