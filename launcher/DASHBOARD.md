# Web dashboard on a Chromecast

The launcher can show any web page full screen from a **Dashboard** tile in the dock, for example a
short-term-rental (STR) dashboard on a bar or lobby TV. It can open the dashboard on boot and go back
to it when nobody has touched the remote for a while. The screen stays on while it is showing, the
page reloads on a timer, and a dropped connection retries every 30 seconds.

## 1. Check which Chromecast you have

| Device | Works? |
|---|---|
| **Chromecast with Google TV** (4K 2020 or HD 2022, comes with a remote) | Yes |
| **Google TV Streamer** (2024) | Yes |
| Older Chromecast pucks with no remote (1st to 3rd gen, Ultra) | No. They only receive casts and cannot run a launcher. |

If yours has no remote, the closest option is casting the page from a computer, for example with
[catt](https://github.com/skorokithakis/catt) (`catt cast_site https://…`). That session ends when
the computer sleeps, so a Chromecast with Google TV (or any Android TV box) is the better fit.

## 2. Turn on ADB

1. Settings → System → About → press OK on **Android TV OS build** seven times.
2. Settings → System → Developer options → turn on **USB debugging**.
3. Settings → Network & Internet → your Wi-Fi network: note the **IP address**.

Then on a computer on the same Wi-Fi:

```bash
python3 -m venv tools/venv && tools/venv/bin/pip install -r tools/requirements.txt
export TV_HOST=192.168.1.50                   # the Chromecast's IP
tools/venv/bin/python -I tools/tv.py --probe  # accept "Allow USB debugging?" on the TV
```

## 3. Point it at your dashboard

Edit `app/src/main/res/values/config.xml`:

```xml
<string name="dashboard_url" translatable="false">https://your-dashboard.example.com/view</string>
<string name="dashboard_title" translatable="false">STR Dashboard</string>
<bool name="dashboard_autostart">true</bool>          <!-- open it after every boot -->
<integer name="dashboard_idle_minutes">10</integer>   <!-- back to it after 10 idle minutes on Home -->
<integer name="dashboard_reload_minutes">15</integer>
```

The Dashboard tile is first in `dock_apps`. It stays hidden while `dashboard_url` is empty.

## 4. Install

The Google TV home app on a Chromecast is `com.google.android.apps.tv.launcherx`, not the default
the script assumes:

```bash
TV_HOST=192.168.1.50 STOCK_LAUNCHER=com.google.android.apps.tv.launcherx launcher/build-and-install.sh
```

On Windows: `launcher\build-and-install.ps1 -TvHost 192.168.1.50 -StockLauncher com.google.android.apps.tv.launcherx`.

If Home still opens Google TV afterwards, the Google TV setup app is also answering the Home button.
Disabling it as well is a common fix on Chromecasts (reversible, see Undo below):

```bash
tools/venv/bin/python -I tools/tv.py 'pm disable-user --user 0 com.google.android.tungsten.setupwraith'
```

## 5. Change settings without rebuilding

Every setting can be pushed over ADB. It is saved on the device and survives reboots:

```bash
tools/venv/bin/python -I tools/tv.py "am start -n com.gathin.tvhome/.DashboardActivity \
  --es url 'https://your-dashboard.example.com/view' --ez autostart true --ei idle_minutes 10"
```

| Extra | Type | What it does |
|---|---|---|
| `url` | `--es` | Dashboard address. Changing it reloads straight away. |
| `title` | `--es` | Tile name and loading text. |
| `autostart` | `--ez` | Open the dashboard once after every boot. |
| `idle_minutes` | `--ei` | Return to the dashboard after this many untouched minutes on Home. 0 is off. |
| `reload_minutes` | `--ei` | Reload interval. 0 is off. |
| `zoom` | `--ei` | Initial page scale in percent. 0 fits the width. Try 75 if the layout is cramped. |
| `desktop` | `--ez` | Request the desktop layout instead of the phone layout. On by default. |
| `reset` | `--ez` | `true` drops all pushed values and goes back to `config.xml`. |

Only the ADB shell can do this. Other apps on the TV cannot change the URL.

## 6. Keep it on all day

- Settings → System → Energy → **Turn off display**: set to **Never**. The dashboard holds the screen
  on, and this stops the Chromecast sleeping while someone is on the home screen.
- The ambient-mode screensaver does not start while the dashboard is showing.
- Check the TV's own eco or sleep timer too. Many TVs switch off after hours without remote input,
  whatever the Chromecast does.

## 7. Signing in, and what the room can see

The page runs in a built-in browser that keeps cookies across reboots, so you only sign in once. The
Chromecast's on-screen keyboard works, and the Google TV app on your phone can type for you.

A view-only share link is the better choice on a TV in a public room. Most dashboard tools have one,
for example Looker Studio report sharing or Google Sheets "Publish to web". Anyone in the bar sees
what is on screen, so leave guest names, contact details and payouts off that view.

## Using it

| Remote | On the dashboard |
|---|---|
| D-pad | Scrolls and moves between links |
| Back | Goes back inside the page, then to the home screen |
| Home | Home screen. The dashboard stays loaded in the background. |
| Dashboard tile | Reopens it and reloads the numbers |
| Menu, where the remote has one | Reloads |

## Undo

This puts Google TV back as the home screen. Skip the setupwraith line if you never disabled it.

```bash
printf '%s\n' \
  'pm enable com.google.android.apps.tv.launcherx' \
  'pm enable com.google.android.tungsten.setupwraith' \
  'cmd package set-home-activity --user 0 $(cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME com.google.android.apps.tv.launcherx | tail -n 1)' \
  | tools/venv/bin/python -I tools/tv.py --batch
```

To remove the launcher completely afterwards: `tools/venv/bin/python -I tools/tv.py 'pm uninstall com.gathin.tvhome'`.
