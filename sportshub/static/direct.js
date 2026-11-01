/* Sports Hub, stick-only mode: the data layer of server.py ported to JavaScript so the page can
   talk to ESPN directly with no PC in between. Produces the same shapes as the Python API, so
   app.js does not know which one it is talking to.

   Browser: window.SportsHubDirect.init({config, fetchJSON}) then SportsHubDirect.call("/api/today").
   Node (tests): const D = require("./direct.js"); D.init({...}). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SportsHubDirect = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

  const DEFAULT_CONFIG = {
    title: "Sports Hub",
    timezone: "",            // "" = the device's own time zone
    leagues: [
      { key: "nfl", label: "NFL", sport: "football", league: "nfl" },
      { key: "cfb", label: "CFB", sport: "football", league: "college-football", params: { groups: "80" } },
      { key: "nba", label: "NBA", sport: "basketball", league: "nba" },
      { key: "nhl", label: "NHL", sport: "hockey", league: "nhl" },
      { key: "mlb", label: "MLB", sport: "baseball", league: "mlb" },
    ],
    favorites: [],
    apps: [],
    refresh: { liveSeconds: 30, idleSeconds: 300, cacheSeconds: 20, teamCacheSeconds: 900, newsCacheSeconds: 600 },
    idleAfterSeconds: 30, idleScrollSeconds: 7, idleRotateSeconds: 20,
    scoreDelaySeconds: 0, safeAreaRem: 2.5, titleLogosMax: 6, showOdds: true,
    gameMode: { auto: true, idleSeconds: 60, rotateSeconds: 0, refreshSeconds: 15, exitAfterFinalSeconds: 120,
      callouts: true, calloutDelaySeconds: 0, sound: "builtin", soundVolume: 0.8, soundSeconds: 20, soundFadeSeconds: 3,
      periodCallouts: true, finalCallouts: true },
    fantasy: { enabled: false },
  };

  function merge(base, extra) {
    Object.keys(extra || {}).forEach((k) => {
      const v = extra[k];
      if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) merge(base[k], v);
      else base[k] = v;
    });
    return base;
  }

  // ------------------------------------------------------------------ state
  let cfg = null;
  let fetchJSON = null;
  let nowFn = () => new Date();
  const cache = {};   // key -> {expires, value}
  const errors = {};

  function init(opts) {
    cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    (opts.configs || [opts.config]).forEach((c) => { if (c) merge(cfg, c); });
    cfg._leagues = {};
    cfg.leagues.forEach((l) => { cfg._leagues[l.key] = l; });
    fetchJSON = opts.fetchJSON || defaultFetch;
    if (opts.now) nowFn = opts.now;
    return cfg;
  }

  function defaultFetch(url) {
    return fetch(url, { cache: "no-store", headers: { Accept: "application/json" } }).then((r) => {
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return r.json();
    });
  }

  async function cached(key, ttl, loader) {
    const c = cache[key];
    const now = Date.now();
    if (c && now < c.expires) return { value: c.value, stale: false };
    try {
      const v = await loader();
      cache[key] = { expires: now + ttl * 1000, value: v };
      delete errors[key];
      return { value: v, stale: false };
    } catch (e) {
      errors[key] = new Date().toISOString() + " " + String(e);
      if (c) return { value: c.value, stale: true };
      throw e;
    }
  }

  function espn(path, params) {
    let url = ESPN + "/" + path;
    const q = Object.keys(params || {}).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    if (q.length) url += "?" + q.join("&");
    return fetchJSON(url);
  }

  function leaguePath(key) {
    const lg = cfg._leagues[key];
    if (!lg) throw new Error("unknown league '" + key + "'");
    return [lg.sport + "/" + lg.league, lg];
  }

  // ------------------------------------------------------------------ time helpers (config timezone)
  function tz() { return cfg.timezone || undefined; }
  function parts(d, zone) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const o = {};
    f.formatToParts(d).forEach((p) => { if (p.type !== "literal") o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
  }
  function offsetMinutes(d, zone) {
    const p = parts(d, zone);
    const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUTC - d.getTime()) / 60000);
  }
  function isoLocal(d, zone) {
    const p = parts(d, zone), off = offsetMinutes(d, zone);
    const pad = (n) => String(n).padStart(2, "0");
    const sign = off < 0 ? "-" : "+", a = Math.abs(off);
    return p.y + "-" + pad(p.m) + "-" + pad(p.d) + "T" + pad(p.h) + ":" + pad(p.mi) + ":" + pad(p.s) + sign + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
  }
  function timeLabel(d, zone) {
    return d.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  }
  function dayKey(d, zone) { const p = parts(d, zone); return p.y * 10000 + p.m * 100 + p.d; }
  function dayLabel(d, zone) {
    const now = nowFn();
    const today = dayKey(now, zone), that = dayKey(d, zone);
    if (that === today) return "";
    const daysDiff = Math.round((Date.UTC(parts(d, zone).y, parts(d, zone).m - 1, parts(d, zone).d) - Date.UTC(parts(now, zone).y, parts(now, zone).m - 1, parts(now, zone).d)) / 86400000);
    if (daysDiff === 1) return "Tomorrow";
    if (daysDiff === -1) return "Yesterday";
    const wd = d.toLocaleDateString("en-US", { timeZone: zone, weekday: "short" });
    if (Math.abs(daysDiff) < 7) return wd;
    const p = parts(d, zone);
    return wd + " " + p.m + "/" + p.d;
  }
  function parseDate(iso) {
    if (!iso) return null;
    const d = new Date(iso.replace(/Z$/, "+00:00"));
    return isNaN(d.getTime()) ? null : d;
  }

  // ------------------------------------------------------------------ normaliser (mirrors server.py)
  function teamSide(comp, ha) { return (comp.competitors || []).find((c) => c.homeAway === ha) || {}; }
  function record(c) {
    const recs = c.records || [];
    for (const r of recs) if (r.type === "total" || r.type === "overall" || r.name === "overall") return r.summary == null ? null : r.summary;
    return recs.length ? (recs[0].summary == null ? null : recs[0].summary) : null;
  }
  function rank(c) { const r = (c.curatedRank || {}).current; return Number.isInteger(r) && r > 0 && r <= 25 ? r : null; }
  function score(c) {
    const sc = c.score;
    if (sc && typeof sc === "object") return sc.displayValue || (sc.value != null ? String(Math.trunc(sc.value)) : null);
    return sc == null ? null : sc;
  }
  function normTeam(c) {
    const t = c.team || {};
    return {
      id: t.id == null ? null : t.id,
      abbr: t.abbreviation || (t.shortDisplayName || "").slice(0, 4).toUpperCase(),
      name: t.displayName || t.name || null,
      short: t.shortDisplayName || t.name || null,
      location: t.location == null ? null : t.location,
      logo: t.logo || ((t.logos || [{}])[0] || {}).href || null,
      color: t.color == null ? null : t.color,
      altColor: t.alternateColor == null ? null : t.alternateColor,
      score: score(c),
      record: record(c),
      rank: rank(c),
      winner: !!c.winner,
      linescores: (c.linescores || []).map((ls) => ls.displayValue !== undefined ? ls.displayValue : (ls.value === undefined ? null : ls.value)),
    };
  }
  function broadcast(comp) {
    let names = [];
    (comp.broadcasts || []).forEach((b) => { names = names.concat(b.names || []); });
    if (!names.length) (comp.geoBroadcasts || []).forEach((gb) => { const m = (gb.media || {}).shortName; if (m) names.push(m); });
    const seen = new Set(), out = [];
    names.forEach((n) => { if (!seen.has(n)) { seen.add(n); out.push(n); } });
    return out.slice(0, 3).join(", ");
  }
  const PLAY_KINDS = [
    ["penalty", "penalty"], ["timeout", "timeout"], ["two-minute", "timeout"], ["end period", "other"], ["end of", "other"],
    ["kickoff", "kickoff"], ["punt", "punt"], ["field goal", "fieldgoal"], ["extra point", "fieldgoal"], ["two-point", "rush"],
    ["interception", "turnover"], ["fumble recovery (opponent)", "turnover"], ["fumble", "rush"], ["safety", "turnover"],
    ["sack", "sack"], ["pass incompletion", "incomplete"], ["incomplete", "incomplete"], ["pass", "pass"], ["rush", "rush"],
  ];
  function playKind(typeText) {
    const t = (typeText || "").toLowerCase();
    for (const [needle, kind] of PLAY_KINDS) if (t.includes(needle)) return kind;
    return "other";
  }
  function yardsToGo(spotText, offenseAbbr) {
    if (!spotText || !offenseAbbr) return null;
    const m = /^\s*([A-Za-z&'. ]+?)\s+(\d{1,2})\s*$/.exec(spotText);
    if (!m) return null;
    const side = m[1].trim().toUpperCase(), n = parseInt(m[2], 10);
    if (n === 50) return 50;
    return side === offenseAbbr.toUpperCase() ? 100 - n : n;
  }
  function field(s, out, home, away) {
    const side = out.possession;
    if (!side) return;
    const offense = side === "home" ? home : away;
    const ytg = yardsToGo(s.possessionText, offense.abbr);
    if (ytg == null) return;
    out.yardsToGo = ytg;
    if (Number.isInteger(s.down) && s.down > 0) out.down = s.down;
    if (Number.isInteger(s.distance)) {
      out.distance = s.distance;
      out.firstDownAt = s.distance < ytg ? Math.max(0, ytg - s.distance) : 0;
    }
    const lp = s.lastPlay;
    if (lp && Object.keys(lp).length) {
      const drive = lp.drive || {};
      const dstart = yardsToGo((drive.start || {}).text, offense.abbr);
      if (dstart != null) out.drive = { startYtg: dstart, text: drive.description == null ? null : drive.description };
      const ptype = (lp.type || {}).text || "";
      const kind = playKind(ptype);
      const playTeam = String((lp.team || {}).id || "");
      const same = playTeam === "" || playTeam === String(offense.id || "");
      const play = { id: lp.id == null ? null : lp.id, kind: kind, type: ptype, text: lp.text == null ? null : lp.text, yards: lp.statYardage == null ? null : lp.statYardage, sameTeam: same };
      if (same && Number.isInteger(play.yards) && ["pass", "rush", "sack"].includes(kind)) { play.startYtg = Math.max(0, Math.min(100, ytg + play.yards)); play.endYtg = ytg; }
      out.play = play;
    }
  }

  function situation(comp, sport, homeId, awayId, home, away) {
    const s = comp.situation;
    if (!s || !Object.keys(s).length) return null;
    const out = {};
    if (s.possession) out.possession = String(s.possession) === String(homeId) ? "home" : String(s.possession) === String(awayId) ? "away" : null;
    if (sport === "football") {
      out.text = s.downDistanceText || s.shortDownDistanceText || null;
      out.redZone = !!s.isRedZone;
      out.possessionText = s.possessionText == null ? null : s.possessionText;
      if (s.homeTimeouts != null) out.timeouts = { home: s.homeTimeouts, away: s.awayTimeouts == null ? null : s.awayTimeouts };
      field(s, out, home || {}, away || {});
    } else if (sport === "baseball") {
      out.bases = ["onFirst", "onSecond", "onThird"].map((k) => s[k] ? "●" : "○").join("");
      const p = [];
      if (s.balls != null && s.strikes != null) p.push(s.balls + "-" + s.strikes);
      if (s.outs != null) p.push(s.outs + " out");
      out.text = p.join("  ");
      out.bases_detail = { first: !!s.onFirst, second: !!s.onSecond, third: !!s.onThird };
    }
    const last = (s.lastPlay || {}).text;
    if (last) out.lastPlay = last;
    return out;
  }
  function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function periodLabel(sport, league, period) {
    if (!period) return "";
    if (sport === "baseball") return ordinal(period) + " inn";
    if (sport === "hockey") return period === 4 ? "OT" : period > 4 ? (period - 3) + "OT" : ordinal(period) + " period";
    if (sport === "basketball") {
      const base = (league === "mens-college-basketball" || league === "womens-college-basketball") ? 2 : 4;
      if (period > base) return period === base + 1 ? "OT" : (period - base) + "OT";
      return base === 2 ? ordinal(period) + " half" : ordinal(period) + " qtr";
    }
    if (sport === "football") return period === 5 ? "OT" : period > 5 ? (period - 4) + "OT" : ordinal(period) + " qtr";
    if (sport === "soccer") return ordinal(period) + " half";
    return "P" + period;
  }

  function normaliseEvent(ev, lg, favorites) {
    const sport = lg.sport, league = lg.league;
    const comp = (ev.competitions || [{}])[0] || {};
    const home = normTeam(teamSide(comp, "home")), away = normTeam(teamSide(comp, "away"));
    const status = comp.status || ev.status || {};
    const stype = status.type || {};
    const state = stype.state || "pre";
    const period = status.period || 0;
    const start = ev.date || comp.date || null;
    const startD = parseDate(start);
    const favKeys = new Set((favorites || []).map((f) => f.league + "|" + String(f.team || "").toLowerCase()));
    const isFav = [home, away].some((t) => ["abbr", "id"].some((k) => favKeys.has(lg.key + "|" + String(t[k] || "").toLowerCase())));

    let detail = stype.shortDetail || stype.detail || "";
    if (state === "pre") {
      if (startD) {
        detail = timeLabel(startD, tz());
        const day = dayLabel(startD, tz());
        if (day) detail = day + " " + detail;
        if (stype.name === "STATUS_POSTPONED" || (stype.shortDetail || "").includes("TBD")) detail = stype.shortDetail || detail;
      }
    } else if (state === "in") {
      const clock = status.displayClock || "";
      const pl = periodLabel(sport, league, period);
      if (stype.name === "STATUS_HALFTIME" || (stype.description || "").toLowerCase() === "halftime") detail = "Halftime";
      else if (stype.name === "STATUS_END_PERIOD") detail = "End " + pl;
      else if (sport === "baseball") detail = period ? ((comp.situation || {}).isTopInning === false ? "Bot" : "Top") + " " + ordinal(period) : detail;
      else detail = (clock + " " + pl).trim();
    } else {
      const extra = (sport === "football" && period > 4) || (sport === "basketball" && period > (league.includes("college") ? 2 : 4)) ||
        (sport === "hockey" && period > 3) || (sport === "baseball" && period && period !== 9);
      detail = "Final" + (extra ? " / " + periodLabel(sport, league, period) : "");
      if (sport === "hockey" && period === 5) detail = "Final / SO";
    }

    let odds = null;
    if (comp.odds && comp.odds.length) { const o = comp.odds[0] || {}; odds = { details: o.details == null ? null : o.details, overUnder: o.overUnder == null ? null : o.overUnder }; }
    let headline = null;
    for (const h of comp.headlines || []) { headline = h.shortLinkText || h.description || null; if (headline) break; }
    const leaders = [];
    (comp.leaders || []).forEach((group) => {
      (group.leaders || []).slice(0, 1).forEach((L) => {
        const ath = L.athlete || {};
        leaders.push({
          category: group.shortDisplayName || group.displayName || group.name || null,
          name: ath.shortName || ath.displayName || null,
          team: (L.team || {}).abbreviation || (ath.team || {}).abbreviation || null,
          value: L.displayValue == null ? null : L.displayValue,
          headshot: ath.headshot == null ? null : ath.headshot,
        });
      });
    });
    const venue = comp.venue || {}, addr = venue.address || {};
    return {
      id: ev.id == null ? null : ev.id,
      league: lg.key, leagueLabel: lg.label, sport: sport,
      name: ev.name == null ? null : ev.name, shortName: ev.shortName == null ? null : ev.shortName,
      start: start, startLocal: startD ? isoLocal(startD, tz()) : null,
      state: state, statusName: stype.name == null ? null : stype.name, completed: !!stype.completed,
      detail: detail, longDetail: stype.detail == null ? null : stype.detail,
      clock: status.displayClock == null ? null : status.displayClock,
      period: period, periodLabel: periodLabel(sport, league, period),
      broadcast: broadcast(comp), venue: venue.fullName == null ? null : venue.fullName,
      city: [addr.city, addr.state].filter(Boolean).join(", "),
      neutral: !!comp.neutralSite, home: home, away: away,
      situation: situation(comp, sport, home.id, away.id, home, away), odds: odds, headline: headline,
      leaders: leaders.slice(0, 3), favorite: isFav,
      notes: (comp.notes || []).filter((n) => n.headline).map((n) => n.headline).join(" "),
    };
  }

  const ORDER = { in: 0, pre: 1, post: 2 };
  function sortGames(games) {
    return games.slice().sort((a, b) => (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1) ||
      ((ORDER[a.state] == null ? 3 : ORDER[a.state]) - (ORDER[b.state] == null ? 3 : ORDER[b.state])) ||
      (a.start || "").localeCompare(b.start || ""));
  }

  // ------------------------------------------------------------------ API
  async function scoreboard(key, date) {
    const [path, lg] = leaguePath(key);
    const params = Object.assign({}, lg.params || {});
    if (date) params.dates = date;
    const ttl = cfg.refresh.cacheSeconds == null ? 20 : cfg.refresh.cacheSeconds;
    const { value: raw, stale } = await cached("sb:" + key + ":" + (date || "today"), ttl, () => espn(path + "/scoreboard", params));
    const games = sortGames((raw.events || []).map((ev) => normaliseEvent(ev, lg, cfg.favorites)));
    return { league: key, label: lg.label, games: games, stale: stale, week: (raw.week || {}).number == null ? null : raw.week.number, day: (raw.day || {}).date == null ? null : raw.day.date };
  }

  async function today() {
    const out = { generatedAt: isoLocal(nowFn(), tz()), timezone: tz() || "local", version: null, leagues: [], errors: {} };
    for (const lg of cfg.leagues) {
      try { out.leagues.push(await scoreboard(lg.key)); }
      catch (e) { out.errors[lg.key] = String(e); out.leagues.push({ league: lg.key, label: lg.label, games: [], stale: true, error: true }); }
    }
    out.liveCount = out.leagues.reduce((n, L) => n + L.games.filter((g) => g.state === "in").length, 0);
    return out;
  }

  async function team(key, teamKey) {
    const [path, lg] = leaguePath(key);
    const ttl = cfg.refresh.teamCacheSeconds == null ? 900 : cfg.refresh.teamCacheSeconds;
    const { value: raw, stale } = await cached("team:" + key + ":" + teamKey, ttl, () => espn(path + "/teams/" + teamKey));
    const t = raw.team || raw;
    let rec = null;
    const items = ((t.record || {}).items) || [];
    for (const it of items) if (it.type === "total" || it.type === "overall") { rec = it.summary == null ? null : it.summary; break; }
    if (rec == null && items.length) rec = items[0].summary == null ? null : items[0].summary;
    let nxt = null;
    for (const ev of t.nextEvent || []) { nxt = normaliseEvent(ev, lg, cfg.favorites); break; }
    return {
      league: key, leagueLabel: lg.label, id: t.id == null ? null : t.id, abbr: t.abbreviation == null ? null : t.abbreviation,
      name: t.displayName == null ? null : t.displayName, short: t.shortDisplayName || t.name || null,
      logo: ((t.logos || [{}])[0] || {}).href || null, color: t.color == null ? null : t.color, altColor: t.alternateColor == null ? null : t.alternateColor,
      record: rec, standing: t.standingSummary == null ? null : t.standingSummary, next: nxt, stale: stale,
    };
  }

  async function myteams() {
    const out = { teams: [], errors: {} };
    for (const f of cfg.favorites || []) {
      try { out.teams.push(await team(f.league, f.team)); } catch (e) { out.errors[f.league + ":" + f.team] = String(e); }
    }
    return out;
  }

  async function news(key, limit) {
    limit = limit || 12;
    const [path, lg] = leaguePath(key);
    const ttl = cfg.refresh.newsCacheSeconds == null ? 600 : cfg.refresh.newsCacheSeconds;
    const { value: raw, stale } = await cached("news:" + key, ttl, () => espn(path + "/news", { limit: limit }));
    const arts = (raw.articles || []).slice(0, limit).map((a) => ({ headline: a.headline == null ? null : a.headline, description: a.description == null ? null : a.description,
      published: a.published == null ? null : a.published, type: a.type == null ? null : a.type, league: lg.label }));
    return { league: key, label: lg.label, articles: arts, stale: stale };
  }

  async function allnews(per) {
    per = per || 4;
    const out = { articles: [], errors: {} };
    for (const lg of cfg.leagues) {
      if (lg.news === false) continue;
      try { out.articles = out.articles.concat((await news(lg.key, per)).articles); } catch (e) { out.errors[lg.key] = String(e); }
    }
    out.articles.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
    return out;
  }

  async function game(key, id) {
    const [path] = leaguePath(key);
    if (!/^[0-9]{1,16}$/.test(String(id))) throw new Error("bad game id");
    const ttl = cfg.refresh.cacheSeconds == null ? 20 : cfg.refresh.cacheSeconds;
    const { value: raw, stale } = await cached("game:" + key + ":" + id, ttl, () => espn(path + "/summary", { event: id }));
    const plays = (raw.scoringPlays || []).slice(-12).map((p) => ({
      text: p.text == null ? null : p.text, period: (p.period || {}).number == null ? null : p.period.number,
      clock: (p.clock || {}).displayValue == null ? null : p.clock.displayValue, team: (p.team || {}).abbreviation == null ? null : p.team.abbreviation,
      home: p.homeScore == null ? null : p.homeScore, away: p.awayScore == null ? null : p.awayScore,
      type: ((p.scoringType || p.type || {}).abbreviation) || ((p.type || {}).text) || null,
    }));
    const leaders = [];
    (raw.leaders || []).forEach((side) => {
      const tm = (side.team || {}).abbreviation == null ? null : side.team.abbreviation;
      (side.leaders || []).forEach((cat) => (cat.leaders || []).slice(0, 1).forEach((L) => {
        const ath = L.athlete || {};
        leaders.push({ team: tm, category: cat.shortDisplayName || cat.displayName || null, name: ath.shortName || ath.displayName || null,
          value: L.displayValue == null ? null : L.displayValue, headshot: ath.headshot == null ? null : ath.headshot });
      }));
    });
    const box = (((raw.boxscore || {}).teams) || []).map((t) => ({ team: (t.team || {}).abbreviation == null ? null : t.team.abbreviation,
      stats: (t.statistics || []).slice(0, 10).map((s) => ({ label: s.label || s.name || null, value: s.displayValue == null ? null : s.displayValue })) }));
    let last = null;
    const cur = ((raw.drives || {}).current) || {};
    if (cur.plays && cur.plays.length) last = (cur.plays[cur.plays.length - 1] || {}).text || null;
    const wp = raw.winprobability || [];
    const win = wp.length ? (wp[wp.length - 1].homeWinPercentage == null ? null : wp[wp.length - 1].homeWinPercentage) : null;
    return { league: key, id: String(id), scoringPlays: plays, leaders: leaders.slice(0, 8), box: box, lastPlay: last, homeWinPct: win, stale: stale };
  }

  async function teams(key) {
    const [path, lg] = leaguePath(key);
    const params = { limit: 1000 };
    if ((lg.params || {}).groups) params.groups = lg.params.groups;
    const { value: raw, stale } = await cached("teams:" + key, 6 * 3600, () => espn(path + "/teams", params));
    const out = [];
    (raw.sports || []).forEach((sp) => (sp.leagues || []).forEach((L) => (L.teams || []).forEach((item) => {
      const t = item.team || item;
      out.push({ id: t.id == null ? null : t.id, abbr: t.abbreviation == null ? null : t.abbreviation, name: t.displayName == null ? null : t.displayName,
        short: t.shortDisplayName || t.name || null, location: t.location == null ? null : t.location,
        logo: ((t.logos || [{}])[0] || {}).href || null, color: t.color == null ? null : t.color });
    })));
    out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return { league: key, label: lg.label, teams: out, stale: stale };
  }

  let userConfig = {};
  function setUserConfig(c) { userConfig = c || {}; }

  function publicConfig() {
    const c = {};
    Object.keys(cfg).forEach((k) => { if (!k.startsWith("_")) c[k] = cfg[k]; });
    c.fantasy = { enabled: false, title: (cfg.fantasy || {}).title || null };
    c.mode = "direct";
    return c;
  }

  function health() {
    const now = Date.now();
    return { ok: true, demo: false, direct: true, time: isoLocal(nowFn(), tz()),
      cache: { entries: Object.keys(cache).length, fresh: Object.values(cache).filter((c) => c.expires > now).length, errors: Object.assign({}, errors) } };
  }

  // Route a "/api/..." URL exactly like the Python server does.
  async function call(url) {
    const u = new URL(url, "http://local/");
    const name = u.pathname.replace(/^\/api\//, "");
    const q = u.searchParams;
    switch (name) {
      case "config": return publicConfig();
      case "today": return today();
      case "scoreboard": return scoreboard(q.get("league") || "nfl", q.get("date") || null);
      case "myteams": return myteams();
      case "news": return q.get("league") ? news(q.get("league")) : allnews();
      case "game": return game(q.get("league") || "nfl", q.get("id") || "");
      case "teams": return teams(q.get("league") || "nfl");
      case "config/local": return JSON.parse(JSON.stringify(userConfig));
      case "fantasy": return { enabled: false };
      case "health": return health();
      default: throw new Error("not found: " + name);
    }
  }

  return { init: init, call: call, normaliseEvent: normaliseEvent, DEFAULT_CONFIG: DEFAULT_CONFIG, merge: merge, setUserConfig: setUserConfig, get config() { return cfg; } };
});
