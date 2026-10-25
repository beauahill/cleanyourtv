#!/usr/bin/env python3
"""Sports Hub server: serves the TV page and a small cached JSON API over ESPN's public endpoints.

Standard library only, so it runs on any box with Python 3.9+ (a mini PC, a Pi, a NAS).

    python3 server.py                       # http://0.0.0.0:8777, config.json next to this file
    python3 server.py --port 8080 --config /etc/sportshub.json
    python3 server.py --demo                # serve the fixtures in demo/ instead of calling ESPN

Endpoints (all JSON unless noted):
    /                      the TV page (static/index.html)
    /api/config            the config, minus anything the page does not need
    /api/today             every configured league's games for today, normalised
    /api/scoreboard?league=nfl[&date=YYYYMMDD]
    /api/myteams           record, standing and next game for each favourite team
    /api/news?league=nfl   headlines
    /api/game?league=nfl&id=401...   scoring plays and leaders for one game
    /api/fantasy           optional, see the "fantasy" block in config.json
    /api/health            cache state and last errors

ESPN's site API is unofficial and unauthenticated. Every upstream call is cached, and when ESPN is
down or rate limiting, the last good response is served with "stale": true instead of an error.
"""
import argparse
import json
import logging
import mimetypes
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
DEMO = os.path.join(HERE, "demo")
ESPN = "https://site.api.espn.com/apis/site/v2/sports"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) SportsHub/1.0 (+https://github.com/beauahill/tv-vibehack)"

log = logging.getLogger("sportshub")

DEFAULT_CONFIG = {
    "title": "Sports Hub",
    "timezone": "America/Denver",
    "leagues": [
        {"key": "nfl", "label": "NFL", "sport": "football", "league": "nfl"},
        {"key": "cfb", "label": "CFB", "sport": "football", "league": "college-football", "params": {"groups": "80"}},
        {"key": "nba", "label": "NBA", "sport": "basketball", "league": "nba"},
        {"key": "nhl", "label": "NHL", "sport": "hockey", "league": "nhl"},
        {"key": "mlb", "label": "MLB", "sport": "baseball", "league": "mlb"},
    ],
    "favorites": [],
    "apps": [],
    "refresh": {"liveSeconds": 30, "idleSeconds": 300, "cacheSeconds": 20, "teamCacheSeconds": 900,
                "newsCacheSeconds": 600},
    "idleAfterSeconds": 30,
    "idleScrollSeconds": 7,
    "idleRotateSeconds": 20,
    "scoreDelaySeconds": 0,
    "showOdds": True,
    "gameMode": {"auto": True, "idleSeconds": 60, "rotateSeconds": 0, "refreshSeconds": 15,
                 "exitAfterFinalSeconds": 120, "callouts": True, "calloutDelaySeconds": 0, "sound": "builtin",
                 "soundVolume": 0.8},
    "fantasy": {"enabled": False, "command": "", "url": "", "cacheSeconds": 120, "timeoutSeconds": 30},
}


# ----------------------------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------------------------

def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        with open(path, encoding="utf-8") as f:
            head = f.read(200)
        hint = ""
        if head.lstrip().startswith("<<<<<<<") or "=======" in head or ">>>>>>>" in head:
            hint = " (looks like leftover git conflict markers from a stash pop or merge)"
        if not head.strip():
            hint = " (the file is empty)"
        sys.exit(f"{path}: invalid JSON at line {e.lineno} column {e.colno}: {e.msg}{hint}\n"
                 f"check it with: python3 -m json.tool {path}")


def _merge(base, extra):
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def load_config(path):
    """config.json, then config.local.json next to it layered on top (lists such as "favorites"
    and "leagues" are replaced whole, dicts are merged). Keep personal settings in the local file:
    it is git-ignored, so `git pull` never conflicts with it."""
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if path and os.path.exists(path):
        _merge(cfg, _read_json(path))
    else:
        log.warning("config %s not found, using defaults", path)
    local = os.path.join(os.path.dirname(os.path.abspath(path)), "config.local.json") if path else None
    if local and os.path.exists(local):
        _merge(cfg, _read_json(local))
        log.info("applied %s", local)
    cfg["_leagues_by_key"] = {lg["key"]: lg for lg in cfg["leagues"]}
    return cfg


def league_path(cfg, key):
    lg = cfg["_leagues_by_key"].get(key)
    if not lg:
        raise KeyError(f"unknown league {key!r}")
    return f"{lg['sport']}/{lg['league']}", lg


# ----------------------------------------------------------------------------------------------
# Cache + fetch
# ----------------------------------------------------------------------------------------------

class Cache:
    """TTL cache that keeps the last good value forever so it can be served stale on errors."""

    def __init__(self):
        self._lock = threading.Lock()
        self._items = {}   # key -> (expires_at, value)
        self.errors = {}   # key -> last error string

    def get(self, key):
        with self._lock:
            item = self._items.get(key)
            if not item:
                return None, True
            expires, value = item
            return value, time.time() >= expires

    def put(self, key, value, ttl):
        with self._lock:
            self._items[key] = (time.time() + ttl, value)
            self.errors.pop(key, None)

    def fail(self, key, err):
        with self._lock:
            self.errors[key] = f"{datetime.now().isoformat(timespec='seconds')} {err}"

    def stats(self):
        with self._lock:
            now = time.time()
            return {
                "entries": len(self._items),
                "fresh": sum(1 for e, _ in self._items.values() if e > now),
                "errors": dict(self.errors),
            }


CACHE = Cache()


def http_get_json(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def cached_json(key, ttl, loader):
    """Return (value, stale). Serves the cached value while fresh, refreshes when expired, and
    falls back to the stale value (or raises) when the refresh fails."""
    value, expired = CACHE.get(key)
    if value is not None and not expired:
        return value, False
    try:
        fresh = loader()
        CACHE.put(key, fresh, ttl)
        return fresh, False
    except Exception as e:  # noqa: BLE001 - we want to fail quietly on anything upstream
        CACHE.fail(key, repr(e))
        log.warning("fetch %s failed: %s", key, e)
        if value is not None:
            return value, True
        raise


class Demo:
    """Serves hand-written fixtures from demo/ so the page can be developed without ESPN."""

    def __init__(self, enabled):
        self.enabled = enabled

    def load(self, name):
        path = os.path.join(DEMO, name + ".json")
        with open(path, encoding="utf-8") as f:
            return json.load(f)


# ----------------------------------------------------------------------------------------------
# ESPN -> normalised shapes
# ----------------------------------------------------------------------------------------------

def _team_side(comp, home_away):
    for c in comp.get("competitors", []):
        if c.get("homeAway") == home_away:
            return c
    return {}


def _record(competitor):
    for r in competitor.get("records", []) or []:
        if r.get("type") in ("total", "overall") or r.get("name") == "overall":
            return r.get("summary")
    recs = competitor.get("records") or []
    return recs[0].get("summary") if recs else None


def _rank(competitor):
    rank = (competitor.get("curatedRank") or {}).get("current")
    if isinstance(rank, int) and 0 < rank <= 25:
        return rank
    return None


def _score(competitor):
    """Scoreboard gives "17"; the team endpoint's nextEvent gives {"value": 17, "displayValue": "17"}."""
    sc = competitor.get("score")
    if isinstance(sc, dict):
        return sc.get("displayValue") or (str(int(sc["value"])) if sc.get("value") is not None else None)
    return sc


def _norm_team(competitor):
    t = competitor.get("team", {}) or {}
    return {
        "id": t.get("id"),
        "abbr": t.get("abbreviation") or (t.get("shortDisplayName") or "")[:4].upper(),
        "name": t.get("displayName") or t.get("name"),
        "short": t.get("shortDisplayName") or t.get("name"),
        "location": t.get("location"),
        "logo": t.get("logo") or ((t.get("logos") or [{}])[0].get("href")),
        "color": t.get("color"),
        "altColor": t.get("alternateColor"),
        "score": _score(competitor),
        "record": _record(competitor),
        "rank": _rank(competitor),
        "winner": bool(competitor.get("winner")),
        "linescores": [ls.get("displayValue", ls.get("value")) for ls in competitor.get("linescores", []) or []],
    }


def _broadcast(comp):
    names = []
    for b in comp.get("broadcasts", []) or []:
        names.extend(b.get("names", []) or [])
    if not names:
        for gb in comp.get("geoBroadcasts", []) or []:
            media = (gb.get("media") or {}).get("shortName")
            if media:
                names.append(media)
    seen, out = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return ", ".join(out[:3])


def _situation(comp, sport, home_id, away_id):
    s = comp.get("situation") or {}
    if not s:
        return None
    out = {}
    poss = s.get("possession")
    if poss:
        out["possession"] = "home" if str(poss) == str(home_id) else "away" if str(poss) == str(away_id) else None
    if sport == "football":
        out["text"] = s.get("downDistanceText") or s.get("shortDownDistanceText")
        out["redZone"] = bool(s.get("isRedZone"))
        out["possessionText"] = s.get("possessionText")
        if s.get("homeTimeouts") is not None:
            out["timeouts"] = {"home": s.get("homeTimeouts"), "away": s.get("awayTimeouts")}
    elif sport == "baseball":
        bases = "".join("●" if s.get(k) else "○" for k in ("onFirst", "onSecond", "onThird"))
        parts = []
        if s.get("balls") is not None and s.get("strikes") is not None:
            parts.append(f"{s.get('balls')}-{s.get('strikes')}")
        if s.get("outs") is not None:
            parts.append(f"{s.get('outs')} out")
        out["text"] = "  ".join(parts)
        out["bases"] = bases
        out["bases_detail"] = {"first": bool(s.get("onFirst")), "second": bool(s.get("onSecond")),
                               "third": bool(s.get("onThird"))}
    last = (s.get("lastPlay") or {}).get("text")
    if last:
        out["lastPlay"] = last
    return out


def _period_label(sport, league, period, state):
    if not period:
        return ""
    if sport == "baseball":
        return f"{_ordinal(period)} inn"
    if sport == "hockey":
        return "OT" if period == 4 else f"{period - 3}OT" if period > 4 else f"{_ordinal(period)} period"
    if sport == "basketball":
        if league == "mens-college-basketball" or league == "womens-college-basketball":
            base = 2
        else:
            base = 4
        if period > base:
            return "OT" if period == base + 1 else f"{period - base}OT"
        return f"{_ordinal(period)} half" if base == 2 else f"{_ordinal(period)} qtr"
    if sport == "football":
        return "OT" if period == 5 else f"{period - 4}OT" if period > 5 else f"{_ordinal(period)} qtr"
    if sport == "soccer":
        return f"{_ordinal(period)} half"
    return f"P{period}"


def _ordinal(n):
    return "%d%s" % (n, "tsnrhtdd"[(n // 10 % 10 != 1) * (n % 10 < 4) * n % 10::4])


def normalise_event(ev, league_cfg, favorites, tz):
    sport, league = league_cfg["sport"], league_cfg["league"]
    comp = (ev.get("competitions") or [{}])[0]
    home_c, away_c = _team_side(comp, "home"), _team_side(comp, "away")
    home, away = _norm_team(home_c), _norm_team(away_c)
    status = comp.get("status") or ev.get("status") or {}
    stype = status.get("type") or {}
    state = stype.get("state") or "pre"
    period = status.get("period") or 0
    start = ev.get("date") or comp.get("date")
    start_local = _to_local(start, tz)
    fav_keys = {(f.get("league"), str(f.get("team") or "").lower()) for f in favorites}
    is_fav = any((league_cfg["key"], str(t.get(k) or "").lower()) in fav_keys for t in (home, away) for k in ("abbr", "id"))

    detail = stype.get("shortDetail") or stype.get("detail") or ""
    if state == "pre":
        # ESPN's football scoreboards cover the whole week, so say which day when it is not today.
        if start_local:
            detail = start_local.strftime("%-I:%M %p")
            day = _day_label(start_local, tz)
            if day:
                detail = f"{day} {detail}"
            if (stype.get("name") == "STATUS_POSTPONED") or "TBD" in (stype.get("shortDetail") or ""):
                detail = stype.get("shortDetail") or detail
    elif state == "in":
        clock = status.get("displayClock") or ""
        plabel = _period_label(sport, league, period, state)
        if stype.get("name") == "STATUS_HALFTIME" or (stype.get("description") or "").lower() == "halftime":
            detail = "Halftime"
        elif stype.get("name") == "STATUS_END_PERIOD":
            detail = f"End {plabel}"
        elif sport == "baseball":
            detail = f"{'Top' if (comp.get('situation') or {}).get('isTopInning', True) else 'Bot'} {_ordinal(period)}" if period else detail
        else:
            detail = f"{clock} {plabel}".strip()
    else:
        detail = "Final" + (f" / {_period_label(sport, league, period, state)}" if (
            (sport == "football" and period > 4) or (sport == "basketball" and period > (2 if 'college' in league else 4)) or
            (sport == "hockey" and period > 3) or (sport == "baseball" and period and period != 9)) else "")
        if sport == "hockey" and period == 5:
            detail = "Final / SO"

    odds = None
    o = (comp.get("odds") or [{}])[0] if comp.get("odds") else None
    if o:
        odds = {"details": o.get("details"), "overUnder": o.get("overUnder")}

    headline = None
    for h in comp.get("headlines", []) or []:
        headline = h.get("shortLinkText") or h.get("description")
        if headline:
            break

    leaders = []
    for group in comp.get("leaders", []) or []:
        for L in (group.get("leaders") or [])[:1]:
            ath = L.get("athlete") or {}
            leaders.append({
                "category": group.get("shortDisplayName") or group.get("displayName") or group.get("name"),
                "name": ath.get("shortName") or ath.get("displayName"),
                "team": (L.get("team") or {}).get("abbreviation") or (ath.get("team") or {}).get("abbreviation"),
                "value": L.get("displayValue"),
                "headshot": ath.get("headshot"),
            })

    venue = comp.get("venue") or {}
    addr = venue.get("address") or {}
    return {
        "id": ev.get("id"),
        "league": league_cfg["key"],
        "leagueLabel": league_cfg["label"],
        "sport": sport,
        "name": ev.get("name"),
        "shortName": ev.get("shortName"),
        "start": start,
        "startLocal": start_local.isoformat() if start_local else None,
        "state": state,
        "completed": bool(stype.get("completed")),
        "detail": detail,
        "longDetail": stype.get("detail"),
        "clock": status.get("displayClock"),
        "period": period,
        "periodLabel": _period_label(sport, league, period, state),
        "broadcast": _broadcast(comp),
        "venue": venue.get("fullName"),
        "city": ", ".join(x for x in (addr.get("city"), addr.get("state")) if x),
        "neutral": bool(comp.get("neutralSite")),
        "home": home,
        "away": away,
        "situation": _situation(comp, sport, home.get("id"), away.get("id")),
        "odds": odds,
        "headline": headline,
        "leaders": leaders[:3],
        "favorite": is_fav,
        "notes": " ".join(n.get("headline", "") for n in comp.get("notes", []) or [] if n.get("headline")),
    }


def _day_label(dt_local, tz):
    today = datetime.now(tz).date()
    d = dt_local.date()
    if d == today:
        return ""
    if d == today + timedelta(days=1):
        return "Tomorrow"
    if d == today - timedelta(days=1):
        return "Yesterday"
    if abs((d - today).days) < 7:
        return dt_local.strftime("%a")
    return dt_local.strftime("%a %-m/%-d")


def _to_local(iso, tz):
    if not iso:
        return None
    try:
        dt = datetime.strptime(iso.replace("Z", "+0000"), "%Y-%m-%dT%H:%M%z")
    except ValueError:
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        except ValueError:
            return None
    return dt.astimezone(tz)


def sort_key(g):
    order = {"in": 0, "pre": 1, "post": 2}
    return (0 if g["favorite"] else 1, order.get(g["state"], 3), g["start"] or "")


# ----------------------------------------------------------------------------------------------
# API
# ----------------------------------------------------------------------------------------------

class Api:
    def __init__(self, cfg, demo):
        self.cfg = cfg
        self.demo = demo
        self.tz = _tz(cfg.get("timezone"))

    # -- upstream ------------------------------------------------------------------------------
    def _espn(self, path, params=None):
        url = f"{ESPN}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return http_get_json(url)

    def scoreboard_raw(self, key, date=None):
        path, lg = league_path(self.cfg, key)
        params = dict(lg.get("params") or {})
        if date:
            params["dates"] = date
        ttl = self.cfg["refresh"].get("cacheSeconds", 20)
        if self.demo.enabled:
            return cached_json(f"demo:{key}", ttl, lambda: self.demo.load(f"scoreboard-{key}"))
        return cached_json(f"sb:{key}:{date or 'today'}", ttl, lambda: self._espn(f"{path}/scoreboard", params))

    # -- public --------------------------------------------------------------------------------
    def scoreboard(self, key, date=None):
        _, lg = league_path(self.cfg, key)
        raw, stale = self.scoreboard_raw(key, date)
        games = [normalise_event(ev, lg, self.cfg.get("favorites", []), self.tz) for ev in raw.get("events", [])]
        games.sort(key=sort_key)
        week = (raw.get("week") or {}).get("number")
        return {"league": key, "label": lg["label"], "games": games, "stale": stale, "week": week,
                "day": (raw.get("day") or {}).get("date")}

    def today(self):
        out = {"generatedAt": datetime.now(self.tz).isoformat(timespec="seconds"),
               "timezone": str(self.tz), "version": static_version(), "leagues": [], "errors": {}}
        for lg in self.cfg["leagues"]:
            try:
                out["leagues"].append(self.scoreboard(lg["key"]))
            except Exception as e:  # noqa: BLE001
                out["errors"][lg["key"]] = repr(e)
                out["leagues"].append({"league": lg["key"], "label": lg["label"], "games": [], "stale": True,
                                       "error": True})
        out["liveCount"] = sum(1 for L in out["leagues"] for g in L["games"] if g["state"] == "in")
        return out

    def team(self, key, team):
        path, lg = league_path(self.cfg, key)
        ttl = self.cfg["refresh"].get("teamCacheSeconds", 900)
        if self.demo.enabled:
            raw, stale = cached_json(f"demo:team:{key}:{team}", ttl,
                                     lambda: self.demo.load(f"team-{key}-{team.lower()}"))
        else:
            raw, stale = cached_json(f"team:{key}:{team}", ttl, lambda: self._espn(f"{path}/teams/{team}"))
        t = raw.get("team") or raw
        record = None
        for item in (t.get("record") or {}).get("items", []) or []:
            if item.get("type") in ("total", "overall"):
                record = item.get("summary")
                break
        if record is None:
            items = (t.get("record") or {}).get("items") or []
            record = items[0].get("summary") if items else None
        nxt = None
        for ev in t.get("nextEvent", []) or []:
            nxt = normalise_event(ev, lg, self.cfg.get("favorites", []), self.tz)
            break
        return {
            "league": key, "leagueLabel": lg["label"],
            "id": t.get("id"), "abbr": t.get("abbreviation"), "name": t.get("displayName"),
            "short": t.get("shortDisplayName") or t.get("name"),
            "logo": ((t.get("logos") or [{}])[0]).get("href"),
            "color": t.get("color"), "altColor": t.get("alternateColor"),
            "record": record, "standing": t.get("standingSummary"), "next": nxt, "stale": stale,
        }

    def myteams(self):
        out = {"teams": [], "errors": {}}
        for f in self.cfg.get("favorites", []):
            try:
                out["teams"].append(self.team(f["league"], f["team"]))
            except Exception as e:  # noqa: BLE001
                out["errors"][f"{f.get('league')}:{f.get('team')}"] = repr(e)
        return out

    def news(self, key, limit=12):
        path, lg = league_path(self.cfg, key)
        ttl = self.cfg["refresh"].get("newsCacheSeconds", 600)
        if self.demo.enabled:
            raw, stale = cached_json(f"demo:news:{key}", ttl, lambda: self.demo.load(f"news-{key}"))
        else:
            raw, stale = cached_json(f"news:{key}", ttl, lambda: self._espn(f"{path}/news", {"limit": limit}))
        arts = []
        for a in raw.get("articles", [])[:limit]:
            arts.append({"headline": a.get("headline"), "description": a.get("description"),
                         "published": a.get("published"), "type": a.get("type"), "league": lg["label"]})
        return {"league": key, "label": lg["label"], "articles": arts, "stale": stale}

    def allnews(self, per=4):
        out = {"articles": [], "errors": {}}
        for lg in self.cfg["leagues"]:
            if lg.get("news") is False:
                continue
            try:
                out["articles"].extend(self.news(lg["key"], per)["articles"])
            except Exception as e:  # noqa: BLE001
                out["errors"][lg["key"]] = repr(e)
        out["articles"].sort(key=lambda a: a.get("published") or "", reverse=True)
        return out

    def game(self, key, game_id):
        path, lg = league_path(self.cfg, key)
        if not re.fullmatch(r"[0-9]{1,16}", str(game_id)):
            raise ValueError("bad game id")
        ttl = self.cfg["refresh"].get("cacheSeconds", 20)
        if self.demo.enabled:
            raw, stale = cached_json(f"demo:game:{key}:{game_id}", ttl,
                                     lambda: self.demo.load(f"summary-{key}-{game_id}"))
        else:
            raw, stale = cached_json(f"game:{key}:{game_id}", ttl,
                                     lambda: self._espn(f"{path}/summary", {"event": game_id}))
        plays = []
        for p in (raw.get("scoringPlays") or [])[-12:]:
            plays.append({
                "text": p.get("text"), "period": (p.get("period") or {}).get("number"),
                "clock": (p.get("clock") or {}).get("displayValue"),
                "team": (p.get("team") or {}).get("abbreviation"),
                "home": p.get("homeScore"), "away": p.get("awayScore"),
                "type": (p.get("scoringType") or p.get("type") or {}).get("abbreviation") or
                        (p.get("type") or {}).get("text"),
            })
        leaders = []
        for side in raw.get("leaders") or []:
            team = (side.get("team") or {}).get("abbreviation")
            for cat in side.get("leaders") or []:
                for L in (cat.get("leaders") or [])[:1]:
                    ath = L.get("athlete") or {}
                    leaders.append({"team": team, "category": cat.get("shortDisplayName") or cat.get("displayName"),
                                    "name": ath.get("shortName") or ath.get("displayName"),
                                    "value": L.get("displayValue"), "headshot": ath.get("headshot")})
        box = []
        for t in ((raw.get("boxscore") or {}).get("teams") or []):
            stats = [{"label": s.get("label") or s.get("name"), "value": s.get("displayValue")}
                     for s in (t.get("statistics") or [])[:10]]
            box.append({"team": (t.get("team") or {}).get("abbreviation"), "stats": stats})
        last = None
        drives = raw.get("drives") or {}
        cur = drives.get("current") or {}
        if cur.get("plays"):
            last = (cur["plays"][-1] or {}).get("text")
        win = None
        wp = raw.get("winprobability") or []
        if wp:
            win = wp[-1].get("homeWinPercentage")
        return {"league": key, "id": game_id, "scoringPlays": plays, "leaders": leaders[:8], "box": box,
                "lastPlay": last, "homeWinPct": win, "stale": stale}

    def fantasy(self):
        fcfg = self.cfg.get("fantasy") or {}
        if not fcfg.get("enabled"):
            return {"enabled": False}
        ttl = fcfg.get("cacheSeconds", 120)
        timeout = fcfg.get("timeoutSeconds", 30)

        def load():
            if fcfg.get("url"):
                return http_get_json(fcfg["url"], timeout=timeout)
            if fcfg.get("command"):
                proc = subprocess.run(shlex.split(fcfg["command"]), capture_output=True, text=True,
                                      timeout=timeout, check=True, cwd=fcfg.get("cwd") or None)
                return json.loads(proc.stdout)
            raise RuntimeError("fantasy enabled but neither url nor command is set")

        data, stale = cached_json("fantasy", ttl, load)
        if isinstance(data, dict):
            data = dict(data)
            data["enabled"] = True
            data["stale"] = stale
        return data

    def health(self):
        return {"ok": True, "demo": self.demo.enabled, "time": datetime.now(self.tz).isoformat(timespec="seconds"),
                "cache": CACHE.stats()}

    def public_config(self):
        cfg = {k: v for k, v in self.cfg.items() if not k.startswith("_")}
        f = dict(cfg.get("fantasy") or {})
        cfg["fantasy"] = {"enabled": bool(f.get("enabled")), "title": f.get("title")}
        return cfg


_VERSION = {"at": 0, "value": ""}


def static_version():
    """Fingerprint of the page files, checked at most every 10 s; the page reloads when it changes."""
    now = time.time()
    if now - _VERSION["at"] > 10:
        parts = []
        for root, _dirs, files in os.walk(STATIC):
            for f in files:
                if f.endswith((".html", ".js", ".css")):
                    p = os.path.join(root, f)
                    try:
                        parts.append(f"{f}:{int(os.stat(p).st_mtime)}:{os.path.getsize(p)}")
                    except OSError:
                        pass
        _VERSION["value"] = str(abs(hash("|".join(sorted(parts)))) % 10**10)
        _VERSION["at"] = now
    return _VERSION["value"]


def _tz(name):
    if name and ZoneInfo:
        try:
            return ZoneInfo(name)
        except Exception:  # noqa: BLE001
            log.warning("unknown timezone %r, using local", name)
    return datetime.now().astimezone().tzinfo


# ----------------------------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    api = None  # set in main()
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        log.debug("%s " + fmt, self.address_string(), *args)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith("/api/"):
            return self._api(parsed)
        if parsed.path in ("", "/"):
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _api(self, parsed):
        q = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        name = parsed.path[len("/api/"):]
        api = self.api
        try:
            if name == "config":
                body = api.public_config()
            elif name == "today":
                body = api.today()
            elif name == "scoreboard":
                body = api.scoreboard(q.get("league", "nfl"), _safe_date(q.get("date")))
            elif name == "myteams":
                body = api.myteams()
            elif name == "news":
                body = api.news(q["league"]) if q.get("league") else api.allnews()
            elif name == "game":
                body = api.game(q.get("league", "nfl"), q.get("id", ""))
            elif name == "fantasy":
                body = api.fantasy()
            elif name == "health":
                body = api.health()
            else:
                return self._json({"error": "not found"}, 404)
            return self._json(body)
        except KeyError as e:
            return self._json({"error": e.args[0] if e.args else "bad request"}, 400)
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            log.exception("api %s failed", name)
            return self._json({"error": repr(e)}, 502)

    def _json(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def _safe_date(s):
    if not s:
        return None
    if not re.fullmatch(r"\d{8}", s):
        raise ValueError("date must be YYYYMMDD")
    return s


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default=os.environ.get("SPORTSHUB_HOST", "0.0.0.0"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SPORTSHUB_PORT", "8777")))
    p.add_argument("--config", default=os.environ.get("SPORTSHUB_CONFIG", os.path.join(HERE, "config.json")))
    p.add_argument("--demo", action="store_true", help="serve fixtures from demo/ instead of ESPN")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    mimetypes.add_type("font/ttf", ".ttf")
    mimetypes.add_type("font/otf", ".otf")
    mimetypes.add_type("font/woff", ".woff")
    mimetypes.add_type("font/woff2", ".woff2")
    cfg = load_config(args.config)
    Handler.api = Api(cfg, Demo(args.demo))
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    log.info("Sports Hub on http://%s:%d/  (%s, %d leagues, %d favourites)%s", args.host, args.port,
             args.config, len(cfg["leagues"]), len(cfg.get("favorites", [])), "  DEMO MODE" if args.demo else "")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
