# Sports Hub

A live-scores home screen for a Google TV stick in the man cave. One Python file on a mini PC
pulls scores, situations, odds, standings and headlines from ESPN; the stick shows them full-screen
and boots straight into it. Pick a game for the linescore, scoring plays and leaders; pick an app in
the dock to jump into ESPN, YouTube TV, FOX Sports, or whatever you subscribe to.

<p align="center">
  <img src="../docs/sportshub-home.png" alt="Sports Hub home screen" width="100%">
</p>

| Game mode board (OK on a live card) | Game detail (OK on a finished or upcoming card) |
|---|---|
| ![Game board](../docs/sportshub-board.png) | ![Game overlay](../docs/sportshub-game.png) |

Built for a TV viewed from across the room: dark background, large type, one focus ring, D-pad only.
Everything is in `rem` with `1rem = 1/120 of the screen width`, so it looks the same at 1080p and 4K.
The screenshots are from demo mode in a sandbox without internet, so they show team abbreviations
where the real page shows ESPN's team logos.

## Parts

| Path | What it is |
|---|---|
| `server.py` | Stdlib-only Python server: serves the page, proxies and caches ESPN, normalises the data. |
| `config.json` | Leagues, favourite teams, dock apps, refresh rates, timezone, fantasy hook. |
| `static/` | The page: `index.html`, `style.css`, `app.js`, the Outfit font. No build step. |
| `android/` | A 100 KB kiosk app (WebView) that makes the page the stick's home screen. |
| `demo/` | ESPN-shaped fixtures so you can develop without hitting ESPN (`--demo`). |
| `sportshub.service` | systemd unit for the mini PC. |
| `../examples/onn-4k-streaming-stick/debloat.txt` | What to disable on the stick. |

## Quick start

### 1. Mini PC: run the server

```bash
cd sportshub
python3 server.py                 # http://0.0.0.0:8777/
```

Python 3.9 or newer, nothing to install. Open `http://<pc-ip>:8777/` in any browser on the LAN and
drive it with the arrow keys and Enter to check it before touching the stick. Edit `config.json`
first if you want different leagues or teams (see [Configuration](#configuration)).

To keep it running, see [Running as a service](#running-as-a-service).

### 2. Stick: developer mode and ADB

On the stick: Settings → System → About → press OK on **Android TV OS build** seven times, then
Settings → System → Developer options → **USB debugging** on (and **Wireless debugging** if shown).
Note the stick's IP under Settings → Network. Then from the repo root:

```bash
python3 -m venv tools/venv && tools/venv/bin/pip install -r tools/requirements.txt
export TV_HOST=192.168.1.60                         # the stick
tools/venv/bin/python -I tools/tv.py --probe       # accept "Allow USB debugging?" on the TV
```

### 3. Stick: back up, then debloat

```bash
mkdir -p backup && tools/venv/bin/python -I tools/tv.py 'pm list packages' > backup/packages.txt
tools/venv/bin/python -I tools/tv.py 'pm list packages -d' > backup/disabled.txt
tools/disable.sh examples/onn-4k-streaming-stick/debloat.txt
```

Read the header of that list first: it was composed from the Google TV package set and still needs
checking against a real stick. Comment out anything you use. Undo any time with
`tools/restore.sh examples/onn-4k-streaming-stick/debloat.txt com.google.android.apps.tv.launcherx`.

### 4. Stick: make the hub the home screen

**The full step-by-step, with checks and a rollback, is in [`STICK-SETUP.md`](STICK-SETUP.md).**
It is written so an agent with `adb` can run it unattended.

**Option A, the kiosk app (recommended).** A prebuilt APK is attached to the
[`kiosk-latest` release](https://github.com/beauahill/cleanyourtv/releases/tag/kiosk-latest) by
GitHub Actions on every push, so you don't need Java to install it: download it, `adb install -r`,
`cmd package set-home-activity`, as in the runbook. To build it yourself instead you need JDK 17
and the Android SDK, same as `launcher/` (macOS: `brew install openjdk@17 android-commandlinetools
&& sdkmanager "platforms;android-34" "build-tools;34.0.0"`), then:

```bash
TV_HOST=192.168.1.60 HUB_URL=http://192.168.1.50:8777/ sportshub/android/build-and-install.sh
```

That builds the APK, pushes it over ADB, sets it as the home activity, disables Google TV Home and
starts it. Press Home on the remote and you are in the hub. Hardware Back closes the game overlay
or returns to Today; it never exits, because this *is* the home screen. If the server is down the
app shows an offline page with the URL it tried; OK retries. To change the URL later without a
rebuild:

```bash
tools/venv/bin/python -I tools/tv.py 'am start -n com.sportshub.tv/.MainActivity --es url http://192.168.1.50:8777/'
```

Set `KEEP_STOCK_HOME=1` to install the app without disabling Google TV Home (it then appears in
the apps row as "Sports Hub"). The kiosk app has not yet been built against a real stick in this
repo's history: if `gradlew` or the first install trips on something, open an issue with the output.

**Option B, no build.** Sideload [Projectivy Launcher](https://play.google.com/store/apps/details?id=com.spocky.projengmenu)
as the home screen and [Fully Kiosk Browser](https://www.fully-kiosk.com/) (or any TV browser)
pointed at `http://<pc-ip>:8777/`, pinned as the first tile. The dock still works: with no kiosk
bridge the page launches apps through `intent://` URLs, which Fully Kiosk and Chrome-based
browsers honour. You lose the Back/Home handling and the offline page.

## Using it

| Remote | Does |
|---|---|
| ▲ ▼ ◀ ▶ | Move the focus ring between the league tabs, the game cards and the dock. Sideways moves stay in the row. |
| OK | On a tab: show that league. On a card: open the game (linescore, scoring, leaders, team stats). On a dock tile: launch the app. |
| Back | Close the overlay or board; on the hub, jump to the app dock (and back to the tabs). |
| Hold ▼ / ▲ | Jump from the score grid straight to the dock / the tabs. |
| 1–9 | Jump to the n-th tab. |
| Play/Pause | Refresh now. |

The **Today** tab merges every league, with your favourites first, then live games, then upcoming,
then finals. Favourites get a gold edge. Live cards show the clock, possession (●), down and
distance, red-zone alerts, runners on base, or the last play. Upcoming cards show the line and
over/under; finals show the headline. The **My Teams** rail shows record, standing and the next or
current game for each favourite.

**Hands-off mode.** After `idleAfterSeconds` without a key press the hub drives itself: the score
grid pages upward one row-band every `idleScrollSeconds`, and when it reaches the bottom the next
league tab comes up (`idleRotateSeconds` is the dwell on a tab that fits on one screen). The first
arrow press afterwards lands on a visible card. Scores refresh every `liveSeconds` while any game
is in progress, else every `idleSeconds`. If ESPN stops answering, the last good data stays on
screen with an "OFFLINE · cached" pill; nothing goes blank.

## Game mode: the board

OK on a live card opens a full-screen scoreboard in the two teams' colours: logos, scores at 15rem,
clock and period, down and distance or runners on base, possession dot, timeouts, a red-zone pulse
on the side with the ball, and along the bottom the linescore, the last four scoring plays and the
stat leaders. ◀ ▶ flips between live games, ▼ opens the detail overlay, Back returns to the hub.

It also takes over on its own. When a favourite is playing and the remote has been idle for
`gameMode.idleSeconds`, the hub switches to the board for that game and stays until
`exitAfterFinalSeconds` after the final, then returns to the hub (or to the next live favourite).
**Favourites are a priority list**: the order in `config.json` decides which game the board shows
when two favourites are live at once, and it switches up to a higher-priority game if one starts.
Set `gameMode.rotateSeconds` above 0 to cycle through all live favourites instead.

```json
"favorites": [
  {"league": "cfb", "team": "wyo"},
  {"league": "nfl", "team": "buf", "sound": "sounds/bills.mp3"},
  {"league": "nhl", "team": "col"},
  {"league": "nhl", "team": "buf"}
],
"gameMode": {"auto": true, "idleSeconds": 60, "rotateSeconds": 0, "refreshSeconds": 15,
             "exitAfterFinalSeconds": 120, "callouts": true, "calloutDelaySeconds": 0,
             "sound": "builtin", "soundVolume": 0.8}
```

**Score callouts.** Whenever a favourite's game changes score (or any game while its board is up)
the screen flashes a banner in the scoring team's colour: TOUCHDOWN / FIELD GOAL / SAFETY, GOAL,
RUN SCORES / GRAND SLAM, with a sport-specific animation (a tumbling football, a goal lamp and a
sliding puck, a ball arcing out of the park, a rolling soccer ball) and confetti in the team's
colours. Basketball is left quiet because it scores every 20 seconds.

**Field goals** get their own animation (uprights, ball through them) distinct from the tumbling
football of a touchdown. **Period events** for favourites: "End of 1st quarter", "Halftime", "End
of 2nd period" show a quiet six-second card with the score (no sound; baseball excluded).
**Finals**: a win brings fireworks, a confetti storm, "COWBOYS WIN" and the team's sound or clip;
a loss is a calm "Final" card. `"periodCallouts": false` / `"finalCallouts": false` in `gameMode`
turn these off. Demo: `?demo=score&team=wyo&event=fieldgoal` (or `halftime`, `period`, `win`,
`loss`), or `SportsHubPage.demoEvent("win", "buf")`; the `0` key cycle includes them.

**Sound.** A favourite's score also plays a celebration: by default a synthesized arena goal horn
with a crowd roar (hockey, football, soccer) or the ballpark organ "Charge!" (baseball), no files
needed. Options in `gameMode`: `"sound": "builtin"` (default), `"none"`, or a file such as
`"sounds/horn.mp3"` placed under `static/sounds/` (git-ignored); `"soundVolume": 0.8`. A favourite
can carry its own `"sound"` (the Sabres horn for the Sabres, say) which wins over the global one.
The file can also be a video (`"sound": "media/sabres.mp4"`): only its audio plays, under the normal
animation. File sounds stop after `"soundSeconds"` (default 20) with a `"soundFadeSeconds"`
(default 3) fade; both can be set globally in `gameMode` or per favourite.
The kiosk app allows autoplay; a desktop browser may stay silent until you press a key on the page.

**Video for a team.** A favourite can play a clip instead: put an `.mp4` (H.264) or `.webm` under
`static/media/` (git-ignored) and add `"video": "media/sabres.mp4"` to that favourite. The clip
runs full-screen with its own audio, the GOAL text over the bottom, and ends with the clip or
after `"videoSeconds"` (default: `soundSeconds`), fading picture and sound over `"videoFadeSeconds"`
(default: `soundFadeSeconds`); Back or OK cuts it short. `"videoMuted": true` keeps the synth
horn under a silent clip. Only use clips you have the right to play; the hub can't fetch from
YouTube or anywhere else, it plays files you put there.

**Delay.** ESPN's data usually beats the broadcast by 20 to 60 seconds, which spoils the moment.
Two knobs:

- `"scoreDelaySeconds": 30` (top level) holds *everything on screen* back that long: cards, the
  board, scoring plays, My Teams. The header shows "delayed 30s" so you know. Polling tightens to
  15 s while a game is live so the delayed feed moves smoothly.
- `"gameMode": {"calloutDelaySeconds": 5}` additionally holds the banner and sound back after the
  delayed score lands, if you want the numbers a beat before the celebration.

Tune against your stream: note how far ahead the hub is on the next score and set
`scoreDelaySeconds` to that. Try values live without a restart from the laptop's browser console:
`SportsHubPage.setOption("scoreDelaySeconds", 45)`.

To see the callouts without waiting for a game: press `0` on the page (each press is the next
sport, for your first favourite), or open `http://<pc-ip>:8777/?demo=score` to play them all in a
row. For one team's own sound or clip: `http://<pc-ip>:8777/?demo=score&team=buf` (a favourite's
abbreviation or id), or in the browser console `SportsHubPage.demo(null, "buf")`. On the stick:
`adb shell am start -n com.sportshub.tv/.MainActivity --es url "http://<pc-ip>:8777/?demo=score"`,
then set the URL back without the query.

## Configuration

`config.json` holds the defaults that ship with the repo. Put **your** settings in
`config.local.json` next to it: same shape, only the keys you want to change, and it is git-ignored
so `git pull` never conflicts with it. Lists such as `favorites`, `leagues` and `apps` replace the
default list whole; nested objects such as `gameMode` merge key by key. Restart the server after
editing either file. A minimal local file:

```json
{
  "title": "Man Cave",
  "theme": {"preset": "wyo-bills"},
  "favorites": [
    {"league": "cfb", "team": "wyo"},
    {"league": "nfl", "team": "buf"},
    {"league": "nhl", "team": "col"},
    {"league": "nhl", "team": "buf"}
  ]
}
```

The full set of keys, with their defaults:

```jsonc
{
  "title": "Man Cave",
  "timezone": "America/Denver",           // all times on the page are shown in this zone
  "leagues": [                            // order = tab order
    {"key": "nfl", "label": "NFL", "sport": "football", "league": "nfl"},
    {"key": "cfb", "label": "CFB", "sport": "football", "league": "college-football",
     "params": {"groups": "80"}}          // 80 = all FBS; use a conference id (e.g. 8 = SEC, 17 = MWC) to narrow
  ],
  "favorites": [{"league": "nfl", "team": "den"}],   // ESPN team abbreviation per league key
  "apps": [{"label": "ESPN", "package": "com.espn.score_center"}],
  "refresh": {"liveSeconds": 30, "idleSeconds": 300, "cacheSeconds": 20},
  "idleAfterSeconds": 30, "idleScrollSeconds": 7, "idleRotateSeconds": 20,
  "showOdds": true,
  "gameMode": {"auto": true, "idleSeconds": 60},
  "fantasy": {"enabled": false}
}
```

- **Screen edges.** If the TV crops the clock on the left or the status pills on the right, the TV
  is overscanning. Best fix is on the TV: picture size "Fit to screen" / "Just scan" / "Direct"
  (Roku TVs: Settings → TV picture settings → Picture size). Otherwise `"safeAreaRem": 4` (default
  2.5) insets the whole page further. `"titleLogosMax": 4` limits the team logos beside the title.
- **Leagues.** `sport/league` is ESPN's path: `football/nfl`, `football/college-football`,
  `basketball/nba`, `basketball/mens-college-basketball`, `basketball/wnba`, `hockey/nhl`,
  `baseball/mlb`, `soccer/usa.1` (MLS), `soccer/eng.1` (Premier League), `golf/pga`… `params` are
  passed straight through (`groups` for conferences, `limit`). Set `"news": false` on a league to
  keep it out of the headlines.
- **Favourites.** `team` is the abbreviation ESPN uses in its URLs (`den`, `kc`, `wyo`, `col`).
  For college teams the numeric id also works. The defaults are a Wyoming/Colorado guess, change them.
- **Apps.** `package` names: `adb shell pm list packages` on the stick (or `tools/tv.py 'pm list
  packages'`), e.g. `adb shell pm list packages | grep -i mountain` to find one app. Leave `apps`
  empty when using the kiosk app and the dock fills itself with every installed TV app,
  alphabetically. Tiles show the app's real TV banner when the page runs inside the kiosk; in a
  plain browser they show initials unless you give an `icon` URL or drop `static/icons/<package>.png`
  in place. `color` tints the initials tile. `"dockPosition": "top"` moves the dock under the tabs.

### Theme

```json
"theme": {"preset": "wyo-bills"}
```

Presets: `default` (neutral dark, amber focus ring), `wyoming` (brown and gold), `bills` (royal
blue and red), `wyo-bills` (gold focus ring and favourite edges, Bills blue active tab, Bills red
live indicators, both logos beside the title). Any colour can be overridden next to the preset:

```json
"theme": {"preset": "wyo-bills", "title": "#ffffff", "logos": ["https://a.espncdn.com/i/teamlogos/ncaa/500/2751.png"]}
```

**Custom title font.** Put a `.ttf`/`.otf` in `static/fonts/custom/` (git-ignored, so your
downloaded fonts stay out of the repo) and add it to the theme:

```json
"theme": {"preset": "wyo-bills",
          "titleFont": {"file": "fonts/custom/wyoming.ttf", "size": "2.8rem", "letterSpacing": "0.08em", "callouts": true}}
```

`callouts: true` also sets the big TOUCHDOWN / GOAL text in that font. Check the font's licence
before using it on anything public; most team "fan fonts" are personal-use only.

Keys: `accent` (focus ring, favourite edge), `accent2` / `accent2Fg` (active tab), `live` /
`liveText`, `bg`, `panel`, `panel2`, `line`, `title`, `text`, `muted`, `dim`, `gradient` (any CSS
background-image), `logos` (up to two image URLs flanking the title). ESPN logo URLs follow
`https://a.espncdn.com/i/teamlogos/{nfl|nba|nhl|mlb|ncaa}/500/{abbr or college id}.png`.

### Fantasy hook

When enabled, a **Fantasy** tab appears after the leagues: your matchup with live points and
projections, both starting lineups side by side (slot, player, pro team, points, projection,
injury flags, a live dot while that player's NFL game is on) and the benches.

**ESPN Fantasy Football, ready made.** `adapters/espn_fantasy.py` reads an `ff_config.json` with
`league_id`, `team_name` and, for a private league, the `espn_s2` and `swid` cookies, and prints
everything the tab needs. Standard library only. In `config.local.json`:

```json
"fantasy": {"enabled": true,
            "command": "python3 /home/you/tv-vibehack/sportshub/adapters/espn_fantasy.py --config /home/you/fantasy/ff_config.json"}
```

Try it by hand first: run that command in a terminal and it should print one line of JSON. If
it prints `Fantasy unavailable: ...` the message says what is wrong (cookies, league id, team
name). `--dump league.json` saves ESPN's raw reply for debugging; it contains no cookies.

**Anything else.** Point `command` or `url` at anything that returns JSON in this shape:

```json
"fantasy": {"enabled": true, "title": "Gillette League", "command": "python3 /home/beau/ff/ff.py --hub-json",
            "cwd": "/home/beau/ff", "cacheSeconds": 120, "timeoutSeconds": 30}
```

Expected output, either or both keys:

```json
{"title": "Week 7", "rows": [{"label": "Beau vs Ryan", "value": "88.4 – 71.2", "sub": "proj 112–104"}],
 "lines": ["Nix 24.6  ·  Sutton 18.2"]}
```

`rows` render as large label / value pairs on the Fantasy tab, `lines` as plain text underneath.
The ESPN adapter additionally sends a `matchup` object (see its output) which the tab renders as
the full two-roster view. The server caches the result, so the command runs at most once per
`cacheSeconds`.

## Running as a service

**Linux (systemd), from the git checkout** so `git pull` picks up fixes:

```bash
sudo cp sportshub/sportshub.service /etc/systemd/system/
sudo sed -i "s#/opt/sportshub#$PWD/sportshub#g; s/^DynamicUser=yes/User=$USER/; /^ProtectHome=yes/d" /etc/systemd/system/sportshub.service
sudo systemctl daemon-reload && sudo systemctl enable --now sportshub
journalctl -u sportshub -f
```

Or copy it to `/opt/sportshub` and install the unit unchanged; it then runs as a locked-down dynamic
user, which is fine unless the fantasy hook needs to read files in your home directory.

**Windows mini PC:** create a Scheduled Task that runs at logon:
`pythonw.exe C:\sportshub\server.py --config C:\sportshub\config.json`, or use NSSM to wrap it as a
service. Allow TCP 8777 through Windows Firewall for the private network.

Give the mini PC a DHCP reservation so the URL in the stick never changes.

## API

Everything the page uses is plain JSON you can reuse elsewhere (a phone, Home Assistant):

| Endpoint | Returns |
|---|---|
| `/api/today` | Every configured league's games for today, normalised and sorted. |
| `/api/scoreboard?league=nfl&date=20261020` | One league, optionally another day. |
| `/api/myteams` | Record, standing, next game for each favourite. |
| `/api/news` or `/api/news?league=nfl` | Headlines. |
| `/api/game?league=nfl&id=401…` | Scoring plays, leaders, team stats, win probability for one game. |
| `/api/fantasy` | Output of the fantasy hook. |
| `/api/health` | Cache state and the last upstream error per key. |

ESPN's `site.api.espn.com` is unofficial and has no auth; be a good neighbour and keep
`cacheSeconds` at 15 or more. The server never calls it more often than that per league, no matter
how many screens are open.

## Development

```bash
python3 server.py --demo -v        # fixtures from demo/, no network
python3 -I demo/make_fixtures.py   # regenerate the fixtures after editing the generator
```

Demo mode has a live NFL game with a red-zone drive, a college game with ranks, a baseball game with
runners on, an overtime final, odds on the upcoming games, plus team pages and headlines, which
covers every branch the page renders. Open `http://localhost:8777/` and use the arrow keys.
