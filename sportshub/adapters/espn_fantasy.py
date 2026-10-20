#!/usr/bin/env python3
"""ESPN Fantasy Football -> Sports Hub "fantasy" rows.

Reads the same ff_config.json that ff.py uses (league_id, team_name, espn_s2, swid) and prints the
JSON the hub's fantasy panel expects. Standard library only.

    python3 espn_fantasy.py --config ~/fantasy/ff_config.json
    python3 espn_fantasy.py --config ~/fantasy/ff_config.json --dump /tmp/league.json   # save raw ESPN reply
    python3 espn_fantasy.py --from-file /tmp/league.json --team "My Team"              # parse a saved reply

Hook it up in sportshub/config.local.json:
    "fantasy": {"enabled": true,
                "command": "python3 /home/you/tv-vibehack/sportshub/adapters/espn_fantasy.py --config /home/you/fantasy/ff_config.json"}

Errors are printed as hub rows too (exit code 0), so a bad cookie shows up on the TV instead of a
blank panel.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

YEAR = datetime.date.today().year if datetime.date.today().month >= 8 else datetime.date.today().year - 1
HOSTS = ["https://lm-api-reads.fantasy.espn.com", "https://fantasy.espn.com"]
POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
BENCH_SLOTS = {20, 21}  # BN, IR
INJ = {"ACTIVE": "", "QUESTIONABLE": "Q", "DOUBTFUL": "D", "OUT": "OUT", "INJURY_RESERVE": "IR", "SUSPENSION": "SUSP"}


def fetch(cfg, year):
    views = ["mTeam", "mRoster", "mMatchup", "mMatchupScore", "mSettings"]
    query = "&".join("view=" + v for v in views)
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if cfg.get("espn_s2") and cfg.get("swid"):
        headers["Cookie"] = f"espn_s2={cfg['espn_s2']}; SWID={cfg['swid']}"
    last = None
    for host in HOSTS:
        url = f"{host}/apis/v3/games/ffl/seasons/{year}/segments/0/leagues/{cfg['league_id']}?{query}"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise RuntimeError("ESPN rejected the login cookies (espn_s2 / swid in ff_config.json)")
            if e.code == 404:
                raise RuntimeError(f"ESPN 404: check league_id {cfg.get('league_id')!r} for {year}")
            last = f"{host}: HTTP {e.code}"
        except Exception as e:  # noqa: BLE001
            last = f"{host}: {e}"
    raise RuntimeError(f"ESPN unreachable ({last})")


def team_name(t):
    return (t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}").strip()


def week_points(player, week, source):
    """source 0 = actual, 1 = projected; weekly split (statSplitTypeId 1) for this scoring period."""
    for s in player.get("stats", []) or []:
        if s.get("statSourceId") == source and s.get("statSplitTypeId") == 1 and s.get("scoringPeriodId") == week:
            v = s.get("appliedTotal")
            if v is not None:
                return float(v)
    return None


def starters(team):
    out = []
    for e in team.get("roster", {}).get("entries", []) or []:
        if e.get("lineupSlotId") in BENCH_SLOTS:
            continue
        p = (e.get("playerPoolEntry") or {}).get("player") or e.get("player") or {}
        out.append(p)
    return out


def summarise(data, my_name):
    week = data.get("scoringPeriodId") or (data.get("status") or {}).get("currentMatchupPeriod") or 1
    period = (data.get("status") or {}).get("currentMatchupPeriod") or week
    teams = {t["id"]: t for t in data.get("teams", [])}
    mine = next((t for t in teams.values() if team_name(t).strip().lower() == my_name.strip().lower()), None)
    if mine is None:
        names = ", ".join(repr(team_name(t)) for t in teams.values())
        raise RuntimeError(f"team_name {my_name!r} not in league. Teams: {names}")

    opp, match = None, None
    for m in data.get("schedule", []) or []:
        if m.get("matchupPeriodId") != period:
            continue
        h, a = (m.get("home") or {}).get("teamId"), (m.get("away") or {}).get("teamId")
        if mine["id"] in (h, a):
            match = m
            opp = teams.get(a if h == mine["id"] else h)
            break

    def points(team, side):
        live = None
        if match and side:
            live = side.get("totalPointsLive")
            if live is None and side.get("totalPoints") not in (None, 0):
                live = side.get("totalPoints")
        if live is None:
            vals = [week_points(p, week, 0) for p in starters(team)]
            live = sum(v for v in vals if v is not None) if any(v is not None for v in vals) else 0.0
        proj = sum((week_points(p, week, 1) or 0.0) for p in starters(team))
        return float(live), proj

    my_side = opp_side = None
    if match:
        my_side = match["home"] if match["home"].get("teamId") == mine["id"] else match["away"]
        opp_side = match["away"] if my_side is match["home"] else match["home"]
    my_pts, my_proj = points(mine, my_side)
    rec = (mine.get("record") or {}).get("overall") or {}
    record = f"{rec.get('wins', 0)}-{rec.get('losses', 0)}" + (f"-{rec['ties']}" if rec.get("ties") else "")

    rows = []
    if opp:
        opp_pts, opp_proj = points(opp, opp_side)
        rows.append({"label": f"{team_name(mine)} vs {team_name(opp)}", "value": f"{my_pts:.1f} – {opp_pts:.1f}",
                     "sub": f"proj {my_proj:.0f} – {opp_proj:.0f}"})
    else:
        rows.append({"label": team_name(mine), "value": f"{my_pts:.1f}", "sub": f"proj {my_proj:.0f} · bye week?"})
    rows.append({"label": "Record", "value": record, "sub": f"Week {week}"})

    scored = []
    flags = []
    for p in starters(mine):
        name = p.get("fullName", "?")
        pos = POS.get(p.get("defaultPositionId"), "")
        status = INJ.get(p.get("injuryStatus", "ACTIVE"), p.get("injuryStatus", ""))
        pts, proj = week_points(p, week, 0), week_points(p, week, 1)
        if status and status != "Q":
            flags.append(f"{name} {status}")
        elif status == "Q":
            flags.append(f"{name} Q")
        scored.append((pts if pts is not None else -1, name, pos, proj, status))
    scored.sort(reverse=True)
    for pts, name, pos, proj, status in scored[:3]:
        if pts < 0:
            continue
        rows.append({"label": f"{name} · {pos}" + (f" [{status}]" if status else ""), "value": f"{pts:.1f}",
                     "sub": f"proj {proj:.1f}" if proj is not None else ""})
    lines = []
    if flags:
        lines.append("Flags: " + ", ".join(flags[:4]))
    return {"title": f"Fantasy · Week {week}", "rows": rows, "lines": lines}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", help="path to ff_config.json")
    ap.add_argument("--team", help="override team_name")
    ap.add_argument("--year", type=int, default=YEAR)
    ap.add_argument("--dump", help="write the raw ESPN response here (no cookies in it)")
    ap.add_argument("--from-file", help="parse a saved response instead of calling ESPN")
    a = ap.parse_args()
    try:
        cfg = {}
        if a.config:
            with open(os.path.expanduser(a.config), encoding="utf-8") as f:
                cfg = json.load(f)
        name = a.team or cfg.get("team_name") or ""
        if a.from_file:
            with open(a.from_file, encoding="utf-8") as f:
                data = json.load(f)
        else:
            if not cfg.get("league_id"):
                raise RuntimeError("league_id missing: pass --config ff_config.json")
            data = fetch(cfg, a.year)
            if a.dump:
                with open(a.dump, "w", encoding="utf-8") as f:
                    json.dump(data, f)
        out = summarise(data, name)
    except Exception as e:  # noqa: BLE001
        out = {"title": "Fantasy", "rows": [], "lines": [f"Fantasy unavailable: {e}"[:160]]}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
