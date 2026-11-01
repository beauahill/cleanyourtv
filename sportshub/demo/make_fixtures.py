#!/usr/bin/env python3
"""Writes ESPN-shaped fixtures into demo/ so `server.py --demo` works offline.
Edit and re-run to change the demo data. The shapes mirror ESPN's site API closely enough for
server.py's normaliser; they are not complete copies of real responses."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = "https://a.espncdn.com/i/teamlogos/{sport}/500/{abbr}.png"


def team(sport, abbr, name, short, location, color, home_away, score=None, record=None, rank=None,
         winner=False, linescores=None, tid=None):
    t = {
        "id": tid or abbr, "homeAway": home_away, "winner": winner, "score": score,
        "team": {"id": tid or abbr, "abbreviation": abbr.upper(), "displayName": name, "shortDisplayName": short,
                 "name": short, "location": location, "color": color, "alternateColor": "ffffff",
                 "logo": LOGO.format(sport=sport, abbr=abbr.lower())},
        "records": [{"name": "overall", "type": "total", "summary": record}] if record else [],
        "linescores": [{"value": v, "displayValue": str(v)} for v in (linescores or [])],
    }
    if rank:
        t["curatedRank"] = {"current": rank}
    return t


def status(state, detail, clock="0:00", period=0, name=None, completed=False):
    return {"clock": 0.0, "displayClock": clock, "period": period,
            "type": {"id": "1", "name": name or {"pre": "STATUS_SCHEDULED", "in": "STATUS_IN_PROGRESS",
                                                  "post": "STATUS_FINAL"}[state],
                     "state": state, "completed": completed, "description": detail, "detail": detail,
                     "shortDetail": detail}}


def event(eid, date, name, short, home, away, st, broadcast=None, situation=None, odds=None, venue=None,
          leaders=None, headline=None):
    comp = {"id": eid, "date": date, "neutralSite": False,
            "venue": {"fullName": venue or "Stadium", "address": {"city": "City", "state": "ST"}},
            "competitors": [home, away], "status": st,
            "broadcasts": [{"market": "national", "names": [broadcast]}] if broadcast else []}
    if situation:
        comp["situation"] = situation
    if odds:
        comp["odds"] = [odds]
    if leaders:
        comp["leaders"] = leaders
    if headline:
        comp["headlines"] = [{"shortLinkText": headline}]
    return {"id": eid, "uid": f"s:1~e:{eid}", "date": date, "name": name, "shortName": short,
            "competitions": [comp], "status": st}


def leader(cat, name, abbr, value):
    return {"name": cat.lower(), "displayName": cat, "shortDisplayName": cat,
            "leaders": [{"displayValue": value, "athlete": {"shortName": name, "displayName": name},
                         "team": {"abbreviation": abbr}}]}


def write(name, data):
    with open(os.path.join(HERE, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)


D = "2026-10-20T"
nfl = {"leagues": [{"abbreviation": "NFL"}], "week": {"number": 7}, "events": [
    event("401901001", D + "00:15Z", "Denver Broncos at Kansas City Chiefs", "DEN @ KC",
          team("nfl", "kc", "Kansas City Chiefs", "Chiefs", "Kansas City", "e31837", "home", "17", "5-1",
               linescores=[7, 3, 7], tid="12"),
          team("nfl", "den", "Denver Broncos", "Broncos", "Denver", "fb4f14", "away", "20", "4-2",
               linescores=[3, 10, 7], tid="7"),
          status("in", "In Progress", "6:42", 3), "ESPN",
          situation={"downDistanceText": "2nd & 7 at KC 35", "possession": "7", "isRedZone": False,
                     "down": 2, "distance": 7, "yardLine": 65, "possessionText": "KC 35",
                     "homeTimeouts": 2, "awayTimeouts": 3,
                     "lastPlay": {"id": "4019010011234", "type": {"id": "24", "text": "Pass Reception"},
                                  "text": "B.Nix pass short left to C.Sutton for 12 yards", "statYardage": 12,
                                  "start": {"yardLine": 53, "text": "KC 47"}, "end": {"yardLine": 65, "text": "KC 35"},
                                  "drive": {"description": "6 plays, 40 yards, 3:12", "start": {"yardLine": 25, "text": "DEN 25"},
                                            "timeElapsed": {"displayValue": "3:12"}}}},
          venue="GEHA Field at Arrowhead Stadium",
          leaders=[leader("Passing", "B. Nix", "DEN", "214 YDS, 2 TD"), leader("Rushing", "I. Pacheco", "KC", "71 YDS"),
                   leader("Receiving", "C. Sutton", "DEN", "6 REC, 98 YDS")]),
    event("401901002", D + "17:00Z", "Green Bay Packers at Chicago Bears", "GB @ CHI",
          team("nfl", "chi", "Chicago Bears", "Bears", "Chicago", "0b162a", "home", "0", "3-3", tid="3"),
          team("nfl", "gb", "Green Bay Packers", "Packers", "Green Bay", "203731", "away", "0", "4-2", tid="9"),
          status("pre", "10/20 - 11:00 AM MDT"), "FOX", odds={"details": "GB -3.5", "overUnder": 44.5},
          venue="Soldier Field"),
    event("401901003", D + "20:25Z", "Dallas Cowboys at Philadelphia Eagles", "DAL @ PHI",
          team("nfl", "phi", "Philadelphia Eagles", "Eagles", "Philadelphia", "004c54", "home", "0", "5-1", tid="21"),
          team("nfl", "dal", "Dallas Cowboys", "Cowboys", "Dallas", "002244", "away", "0", "3-3", tid="6"),
          status("pre", "10/20 - 2:25 PM MDT"), "CBS", odds={"details": "PHI -6.5", "overUnder": 47.0},
          venue="Lincoln Financial Field"),
    event("401901004", D + "00:20Z", "Buffalo Bills at Miami Dolphins", "BUF @ MIA",
          team("nfl", "mia", "Miami Dolphins", "Dolphins", "Miami", "008e97", "home", "24", "2-4",
               linescores=[7, 10, 0, 7], tid="15"),
          team("nfl", "buf", "Buffalo Bills", "Bills", "Buffalo", "00338d", "away", "31", "5-1", winner=True,
               linescores=[14, 3, 7, 7], tid="2"),
          status("post", "Final", period=4, completed=True), "NBC", venue="Hard Rock Stadium",
          headline="Allen throws 3 TDs as Bills hold off Dolphins",
          leaders=[leader("Passing", "J. Allen", "BUF", "298 YDS, 3 TD")]),
    event("401901005", D + "00:20Z", "Seattle Seahawks at Arizona Cardinals", "SEA @ ARI",
          team("nfl", "ari", "Arizona Cardinals", "Cardinals", "Arizona", "97233f", "home", "27", "2-4",
               linescores=[7, 7, 3, 7, 3], winner=True, tid="22"),
          team("nfl", "sea", "Seattle Seahawks", "Seahawks", "Seattle", "002244", "away", "24", "4-2",
               linescores=[7, 10, 7, 0, 0], tid="26"),
          status("post", "Final/OT", period=5, completed=True), "Prime Video", venue="State Farm Stadium"),
]}
write("scoreboard-nfl", nfl)

cfb = {"leagues": [{"abbreviation": "NCAAF"}], "week": {"number": 8}, "events": [
    event("401902001", D + "01:30Z", "Wyoming Cowboys at Boise State Broncos", "WYO @ BSU",
          team("ncaa", "68", "Boise State Broncos", "Broncos", "Boise State", "0033a0", "home", "21", "6-1",
               rank=14, linescores=[7, 7, 7], tid="68"),
          team("ncaa", "2751", "Wyoming Cowboys", "Cowboys", "Wyoming", "492f24", "away", "14", "4-3",
               linescores=[0, 7, 7], tid="2751"),
          status("in", "In Progress", "11:05", 4), "FS1",
          situation={"downDistanceText": "3rd & 2 at BSU 18", "possession": "2751", "isRedZone": True,
                     "down": 3, "distance": 2, "yardLine": 82, "possessionText": "BSU 18",
                     "lastPlay": {"id": "4019020015678", "type": {"id": "5", "text": "Rush"},
                                  "text": "Sam Scott run for 6 yards to the BSU 18", "statYardage": 6,
                                  "start": {"yardLine": 76, "text": "BSU 24"}, "end": {"yardLine": 82, "text": "BSU 18"},
                                  "drive": {"description": "9 plays, 58 yards, 4:40", "start": {"yardLine": 24, "text": "WYO 24"}}}},
          venue="Albertsons Stadium"),
    event("401902002", D + "19:30Z", "Georgia Bulldogs at Texas Longhorns", "UGA @ TEX",
          team("ncaa", "251", "Texas Longhorns", "Longhorns", "Texas", "bf5700", "home", "0", "6-1", rank=3, tid="251"),
          team("ncaa", "61", "Georgia Bulldogs", "Bulldogs", "Georgia", "ba0c2f", "away", "0", "6-1", rank=5, tid="61"),
          status("pre", "10/20 - 1:30 PM MDT"), "ABC", odds={"details": "TEX -4.5", "overUnder": 51.5},
          venue="DKR Texas Memorial Stadium"),
    event("401902003", D + "23:00Z", "Ohio State Buckeyes at Penn State Nittany Lions", "OSU @ PSU",
          team("ncaa", "213", "Penn State Nittany Lions", "Nittany Lions", "Penn State", "041e42", "home", "0", "5-2",
               rank=11, tid="213"),
          team("ncaa", "194", "Ohio State Buckeyes", "Buckeyes", "Ohio State", "bb0000", "away", "0", "7-0", rank=1,
               tid="194"),
          status("pre", "10/20 - 5:00 PM MDT"), "NBC", odds={"details": "OSU -8.0", "overUnder": 46.5},
          venue="Beaver Stadium"),
]}
# the team logos for college use numeric ids
for ev in cfb["events"]:
    for c in ev["competitions"][0]["competitors"]:
        c["team"]["logo"] = f"https://a.espncdn.com/i/teamlogos/ncaa/500/{c['id']}.png"
        c["team"]["abbreviation"] = {"68": "BSU", "2751": "WYO", "251": "TEX", "61": "UGA", "213": "PSU",
                                     "194": "OSU"}[c["id"]]
write("scoreboard-cfb", cfb)

nba = {"leagues": [{"abbreviation": "NBA"}], "events": [
    event("401903001", D + "02:00Z", "Los Angeles Lakers at Denver Nuggets", "LAL @ DEN",
          team("nba", "den", "Denver Nuggets", "Nuggets", "Denver", "0e2240", "home", "0", "0-0", tid="7"),
          team("nba", "lal", "Los Angeles Lakers", "Lakers", "Los Angeles", "552583", "away", "0", "0-0", tid="13"),
          status("pre", "10/20 - 8:00 PM MDT"), "TNT", odds={"details": "DEN -5.5", "overUnder": 228.5},
          venue="Ball Arena"),
    event("401903002", D + "23:30Z", "Boston Celtics at New York Knicks", "BOS @ NY",
          team("nba", "ny", "New York Knicks", "Knicks", "New York", "006bb6", "home", "0", "0-0", tid="18"),
          team("nba", "bos", "Boston Celtics", "Celtics", "Boston", "008348", "away", "0", "0-0", tid="2"),
          status("pre", "10/20 - 5:30 PM MDT"), "TNT", venue="Madison Square Garden"),
]}
write("scoreboard-nba", nba)

nhl = {"leagues": [{"abbreviation": "NHL"}], "events": [
    event("401904001", D + "01:00Z", "Colorado Avalanche at Vegas Golden Knights", "COL @ VGK",
          team("nhl", "vgk", "Vegas Golden Knights", "Golden Knights", "Vegas", "b4975a", "home", "2", "4-1-1",
               linescores=[1, 1], tid="37"),
          team("nhl", "col", "Colorado Avalanche", "Avalanche", "Colorado", "6f263d", "away", "3", "5-1-0",
               linescores=[2, 1], tid="17"),
          status("in", "In Progress", "14:21", 3), "ESPN+", venue="T-Mobile Arena",
          situation={"lastPlay": {"text": "Nathan MacKinnon wrist shot saved by Adin Hill"}}),
    event("401904002", D + "23:00Z", "Toronto Maple Leafs at Montreal Canadiens", "TOR @ MTL",
          team("nhl", "mtl", "Montreal Canadiens", "Canadiens", "Montreal", "af1e2d", "home", "0", "3-3-0", tid="10"),
          team("nhl", "tor", "Toronto Maple Leafs", "Maple Leafs", "Toronto", "00205b", "away", "0", "4-2-0", tid="21"),
          status("pre", "10/20 - 5:00 PM MDT"), "SN", venue="Bell Centre"),
]}
write("scoreboard-nhl", nhl)

mlb = {"leagues": [{"abbreviation": "MLB"}], "events": [
    event("401905001", D + "00:08Z", "Los Angeles Dodgers at Colorado Rockies", "LAD @ COL",
          team("mlb", "col", "Colorado Rockies", "Rockies", "Colorado", "33006f", "home", "4", "2-1",
               linescores=[0, 2, 0, 1, 1, 0], tid="27"),
          team("mlb", "lad", "Los Angeles Dodgers", "Dodgers", "Los Angeles", "005a9c", "away", "3", "1-2",
               linescores=[1, 0, 0, 2, 0, 0, 0], tid="19"),
          status("in", "In Progress", "", 7), "FS1", venue="Coors Field",
          situation={"balls": 2, "strikes": 1, "outs": 1, "onFirst": True, "onSecond": False, "onThird": True,
                     "isTopInning": False, "lastPlay": {"text": "Ezequiel Tovar singles on a line drive to left"}}),
]}
write("scoreboard-mlb", mlb)
write("scoreboard-ncaam", {"leagues": [{"abbreviation": "NCAAM"}], "events": []})


def team_page(sport, league, tid, abbr, name, short, color, record, standing, nxt):
    return {"team": {"id": tid, "abbreviation": abbr, "displayName": name, "shortDisplayName": short,
                     "color": color, "logos": [{"href": LOGO.format(sport=sport, abbr=abbr.lower())}],
                     "record": {"items": [{"type": "total", "summary": record}]},
                     "standingSummary": standing, "nextEvent": [nxt] if nxt else []}}


write("team-nfl-den", team_page("nfl", "nfl", "7", "DEN", "Denver Broncos", "Broncos", "fb4f14", "4-2",
                               "2nd in AFC West", nfl["events"][0]))
wyo = team_page("ncaa", "cfb", "2751", "WYO", "Wyoming Cowboys", "Cowboys", "492f24", "4-3", "5th in MWC",
                cfb["events"][0])
wyo["team"]["logos"][0]["href"] = "https://a.espncdn.com/i/teamlogos/ncaa/500/2751.png"
write("team-cfb-wyo", wyo)
write("team-nba-den", team_page("nba", "nba", "7", "DEN", "Denver Nuggets", "Nuggets", "0e2240", "0-0",
                               "1st in Northwest Division", nba["events"][0]))
write("team-nhl-col", team_page("nhl", "nhl", "17", "COL", "Colorado Avalanche", "Avalanche", "6f263d", "5-1-0",
                               "1st in Central Division", nhl["events"][0]))
write("team-mlb-col", team_page("mlb", "mlb", "27", "COL", "Colorado Rockies", "Rockies", "33006f", "2-1",
                               "NLDS, leads 2-1", mlb["events"][0]))

news = {
    "nfl": ["Broncos' Nix building a case as the AFC's best young quarterback",
            "Week 7 injury report: who's in, who's out for Sunday",
            "Bills hold off Dolphins behind Allen's three touchdowns",
            "Power rankings: Eagles climb after fifth straight win"],
    "cfb": ["Wyoming looks to end 12-year skid in Boise",
            "Texas-Georgia: what's at stake in the SEC's game of the week",
            "Heisman watch: the top five with half a season left"],
    "nba": ["Opening night: Nuggets host Lakers in a Western Conference showdown",
            "Jokic says he's healthy and 'ready for 82'"],
    "nhl": ["Avalanche off to a 5-1 start as MacKinnon leads the league in points"],
    "mlb": ["Rockies take 2-1 NLDS lead behind Tovar's late heroics"],
}
for key, heads in news.items():
    write("news-" + key, {"articles": [{"headline": h, "description": "", "published": f"2026-10-20T1{i}:00Z",
                                       "type": "Story"} for i, h in enumerate(heads)]})

write("summary-nfl-401901001", {
    "scoringPlays": [
        {"text": "Courtland Sutton 24 yd pass from Bo Nix (Wil Lutz kick)", "period": {"number": 1},
         "clock": {"displayValue": "8:12"}, "team": {"abbreviation": "DEN"}, "homeScore": 0, "awayScore": 7,
         "scoringType": {"abbreviation": "TD"}},
        {"text": "Harrison Butker 41 yd field goal", "period": {"number": 1}, "clock": {"displayValue": "2:03"},
         "team": {"abbreviation": "KC"}, "homeScore": 3, "awayScore": 7, "scoringType": {"abbreviation": "FG"}},
        {"text": "Travis Kelce 9 yd pass from Patrick Mahomes (Butker kick)", "period": {"number": 2},
         "clock": {"displayValue": "9:44"}, "team": {"abbreviation": "KC"}, "homeScore": 10, "awayScore": 7,
         "scoringType": {"abbreviation": "TD"}},
        {"text": "Wil Lutz 33 yd field goal", "period": {"number": 2}, "clock": {"displayValue": "0:04"},
         "team": {"abbreviation": "DEN"}, "homeScore": 10, "awayScore": 10, "scoringType": {"abbreviation": "FG"}},
        {"text": "Isiah Pacheco 3 yd run (Butker kick)", "period": {"number": 3}, "clock": {"displayValue": "11:30"},
         "team": {"abbreviation": "KC"}, "homeScore": 17, "awayScore": 10, "scoringType": {"abbreviation": "TD"}},
        {"text": "Marvin Mims Jr. 55 yd punt return (Lutz kick)", "period": {"number": 3},
         "clock": {"displayValue": "8:10"}, "team": {"abbreviation": "DEN"}, "homeScore": 17, "awayScore": 17,
         "scoringType": {"abbreviation": "TD"}},
        {"text": "Wil Lutz 47 yd field goal", "period": {"number": 3}, "clock": {"displayValue": "6:55"},
         "team": {"abbreviation": "DEN"}, "homeScore": 17, "awayScore": 20, "scoringType": {"abbreviation": "FG"}},
    ],
    "leaders": [
        {"team": {"abbreviation": "DEN"}, "leaders": [
            {"shortDisplayName": "PASS", "leaders": [{"displayValue": "18/26, 214 YDS, 2 TD", "athlete": {"shortName": "B. Nix"}}]},
            {"shortDisplayName": "RUSH", "leaders": [{"displayValue": "9 CAR, 44 YDS", "athlete": {"shortName": "J. Williams"}}]},
            {"shortDisplayName": "REC", "leaders": [{"displayValue": "6 REC, 98 YDS, TD", "athlete": {"shortName": "C. Sutton"}}]}]},
        {"team": {"abbreviation": "KC"}, "leaders": [
            {"shortDisplayName": "PASS", "leaders": [{"displayValue": "21/30, 233 YDS, TD", "athlete": {"shortName": "P. Mahomes"}}]},
            {"shortDisplayName": "RUSH", "leaders": [{"displayValue": "14 CAR, 71 YDS, TD", "athlete": {"shortName": "I. Pacheco"}}]},
            {"shortDisplayName": "REC", "leaders": [{"displayValue": "7 REC, 81 YDS, TD", "athlete": {"shortName": "T. Kelce"}}]}]},
    ],
    "boxscore": {"teams": [
        {"team": {"abbreviation": "DEN"}, "statistics": [{"label": "Total Yards", "displayValue": "312"},
                                                          {"label": "Turnovers", "displayValue": "0"},
                                                          {"label": "Possession", "displayValue": "19:42"}]},
        {"team": {"abbreviation": "KC"}, "statistics": [{"label": "Total Yards", "displayValue": "341"},
                                                         {"label": "Turnovers", "displayValue": "1"},
                                                         {"label": "Possession", "displayValue": "21:36"}]}]},
    "winprobability": [{"homeWinPercentage": 0.41}],
})
print("fixtures written to", HERE)
