# Stick-only mode (no PC)

The kiosk APK carries the whole page inside it and talks to ESPN directly, so a Google TV stick
is all you need. The PC-hosted mode in [README.md](README.md) still exists and is the better fit if
you want the fantasy panel, instant edits, or big video clips served over the LAN; everything else
works the same in both modes.

## Install

Developer options and USB debugging on the stick, `adb` on any computer on the same Wi-Fi
(see [STICK-SETUP.md](STICK-SETUP.md) steps 0 to 2 for that part and the optional debloat).

```bash
curl -L -o sportshub-kiosk.apk https://github.com/beauahill/cleanyourtv/releases/download/kiosk-latest/sportshub-kiosk.apk
adb connect <stick-ip>:5555
adb install -r sportshub-kiosk.apk
adb shell cmd package set-home-activity --user 0 com.sportshub.tv/.MainActivity
adb shell am start -n com.sportshub.tv/.MainActivity
```

With no server URL configured the app opens its bundled page in direct mode: default leagues,
no favourites yet, ESPN fetched from the stick. Press Home: that is the hub.

## Your settings

Settings are a `config.json` in the app's files folder on the stick. Same keys and layering as the
PC version's `config.local.json`: only what you want to change, lists replace, objects merge.

```json
{
  "title": "Man Cave",
  "timezone": "America/Denver",
  "theme": {"preset": "wyo-bills"},
  "favorites": [
    {"league": "cfb", "team": "wyo"},
    {"league": "nfl", "team": "buf", "video": "media/bills.mp4", "videoSeconds": 60},
    {"league": "nhl", "team": "buf", "sound": "media/sabres.mp4"}
  ],
  "apps": [],
  "scoreDelaySeconds": 30
}
```

Push it and reload:

```bash
adb push config.json /sdcard/Android/data/com.sportshub.tv/files/config.json
adb shell am start -n com.sportshub.tv/.MainActivity
```

(`am start` while the app is already up makes it re-read the file.) Alternatively pass the JSON
inline, handy from a script: `adb shell am start -n com.sportshub.tv/.MainActivity --es config "$(cat config.json)"`;
quoting gets awkward with large files, so `adb push` is the reliable way.

`"apps": []` makes the dock list every TV app installed, with its real artwork; name the ones you
want in the usual `{"label", "package"}` form to pick and order them.

## Media, fonts, icons

Clips, horns, a title font and dock icons go in the same folder, same relative paths as the PC
version:

```bash
adb push bills.mp4   /sdcard/Android/data/com.sportshub.tv/files/media/bills.mp4
adb push wyoming.otf /sdcard/Android/data/com.sportshub.tv/files/fonts/custom/wyoming.otf
```

and in config: `"video": "media/bills.mp4"`, `"titleFont": {"file": "fonts/custom/wyoming.otf"}`.
The stick has about 8 GB free; a 16 MB clip per team is nothing.

## Switching modes

- Point at a PC: `adb shell am start -n com.sportshub.tv/.MainActivity --es url http://192.168.1.50:8777/`
  (remembered until changed).
- Back to stick-only: `adb shell am start -n com.sportshub.tv/.MainActivity --es mode direct`.

## What differs from PC mode

- **Fantasy** is off; it needs the Python adapter and your ESPN login on a PC.
- **Updates** come as a new APK (`adb install -r`), not a `git pull`. Settings and media stay.
- **Caching** is per page load. The delay queues, callouts, board and everything else are
  identical, since it is the same page.
- A laptop browser can preview direct mode with `http://<pc>:8777/?mode=direct` (settings then
  come from the browser's localStorage key `sportshub.config` instead of the stick file).

## Troubleshooting

- "Can't reach ESPN right now": the stick has no internet, or ESPN is down; check with the YouTube
  app. ESPN's API is unofficial and occasionally rate-limits; the page retries on its own.
- A toast saying config.json is not valid JSON: fix it on the computer with
  `python3 -m json.tool config.json`, push again.
- Clips show the first frame then fall back to the normal callout: the file is not H.264/AAC,
  see the conversion note in README.md.
