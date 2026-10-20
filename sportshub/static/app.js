/* Sports Hub TV page. Vanilla JS, no build step.
   Input model: a TV remote. Arrow keys move a single focus ring between tabs, game cards, the dock
   and the overlay; Enter activates; Back/Escape closes the overlay. Nothing depends on a mouse. */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const state = {
    config: null,
    today: null,
    myteams: null,
    news: null,
    fantasy: null,
    tab: "all",            // "all" or a league key
    focus: null,           // focused element
    lastFocusByZone: {},   // zone -> element id, to restore focus after re-render
    overlayOpen: false,
    overlayGame: null,
    lastKeyAt: Date.now(),
    timers: {},
    gm: { active: false, league: null, id: null, enteredAt: 0, finalAt: 0, details: null, lastRotate: 0 },
    scores: {},            // "league:id" -> {away, home} for score-change detection
  };

  // ------------------------------------------------------------------ themes
  // Pick one with  "theme": {"preset": "wyo-bills"}  in config.json; any key below can be overridden
  // next to "preset" (e.g. "accent": "#ff0000"). Colours are the teams' official hex values.
  const LOGO = (sport, id) => "https://a.espncdn.com/i/teamlogos/" + sport + "/500/" + id + ".png";
  const THEMES = {
    "default": {},
    "wyoming": {
      accent: "#ffc425", accent2: "#492f24", accent2Fg: "#ffc425", live: "#ff3b3b", liveText: "#ff8a8a",
      bg: "#0b0908", panel: "#17120f", panel2: "#211a15", line: "#302620", title: "#ffc425",
      logos: [LOGO("ncaa", "2751")],
    },
    "bills": {
      accent: "#c60c30", accent2: "#00338d", accent2Fg: "#ffffff", live: "#c60c30", liveText: "#ff6b7f",
      bg: "#05081a", panel: "#0d1330", panel2: "#141d47", line: "#20306a", title: "#ffffff",
      logos: [LOGO("nfl", "buf")],
    },
    "wyo-bills": {
      // Wyoming brown and gold carry the surfaces; Bills blue and red are the highlights.
      accent: "#ffc425", accent2: "#00338d", accent2Fg: "#ffffff", live: "#c60c30", liveText: "#ff6b7f",
      bg: "#0e0b09", panel: "#1a1411", panel2: "#241b16", line: "#3a2c23", title: "#ffc425",
      muted: "#a3978b", dim: "#6f6259",
      gradient: "radial-gradient(ellipse at 0% 0%, rgba(255, 196, 37, 0.14), transparent 50%), radial-gradient(ellipse at 20% 100%, rgba(73, 47, 36, 0.55), transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(0, 51, 141, 0.30), transparent 45%)",
      logos: [LOGO("ncaa", "2751"), LOGO("nfl", "buf")],
    },
  };

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(", ");
  }

  function applyTheme(cfg) {
    const t = Object.assign({}, THEMES[(cfg && cfg.preset) || "default"] || {}, cfg || {});
    const root = document.documentElement.style;
    const map = { accent: "--accent", accent2: "--accent-2", accent2Fg: "--accent-2-fg", live: "--live",
      liveText: "--live-text", bg: "--bg", panel: "--panel", panel2: "--panel-2", line: "--line",
      title: "--title-color", text: "--text", muted: "--muted", dim: "--dim", gradient: "--bg-gradient" };
    Object.keys(map).forEach((k) => { if (t[k]) root.setProperty(map[k], t[k]); });
    const rgb = hexToRgb(t.accent);
    if (rgb) root.setProperty("--accent-rgb", rgb);
    const logos = t.logos || [];
    [["#title-logo-left", logos[0]], ["#title-logo-right", logos[1] || (logos.length === 1 ? null : null)]].forEach(([sel, src]) => {
      const img = $(sel);
      if (src) { img.src = src; img.classList.remove("hidden"); img.onerror = () => img.classList.add("hidden"); }
      else img.classList.add("hidden");
    });
  }

  // ------------------------------------------------------------------ data
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(url + " -> " + r.status);
    return r.json();
  }

  async function loadConfig() {
    state.config = await getJSON("/api/config");
    $("#title").textContent = state.config.title || "Sports Hub";
    document.title = state.config.title || "Sports Hub";
    applyTheme(state.config.theme);
    renderDock();
  }

  async function loadToday() {
    try {
      state.today = await getJSON("/api/today");
      setStale(state.today.leagues.some((l) => l.stale));
      $("#updated").textContent = "updated " + fmtTime(new Date());
    } catch (e) {
      setStale(true);
      if (!state.today) state.today = { leagues: [], liveCount: 0 };
    }
    detectScoreChanges();
    renderTabs();
    renderGames();
    if (state.gm.active) renderGameMode();
    scheduleToday();
  }

  async function loadMyTeams() {
    try { state.myteams = await getJSON("/api/myteams"); } catch (e) { /* keep old */ }
    renderMyTeams();
  }

  async function loadNews() {
    try { state.news = await getJSON("/api/news"); } catch (e) { /* keep old */ }
    renderNews();
  }

  async function loadFantasy() {
    if (!state.config || !state.config.fantasy || !state.config.fantasy.enabled) return;
    const hadTab = !!state.fantasy;
    try { state.fantasy = await getJSON("/api/fantasy"); } catch (e) { /* keep old */ }
    if (!hadTab) renderTabs();
    if (state.tab === "fantasy") renderGames();
  }

  function scheduleToday() {
    clearTimeout(state.timers.today);
    const r = (state.config && state.config.refresh) || {};
    const live = state.today && state.today.liveCount > 0;
    let secs = live ? (r.liveSeconds || 30) : (r.idleSeconds || 300);
    if (state.gm.active) secs = Math.min(secs, gmCfg().refreshSeconds || 15);
    state.timers.today = setTimeout(loadToday, secs * 1000);
  }

  function setStale(stale) {
    $("#stale-pill").classList.toggle("hidden", !stale);
  }

  // ------------------------------------------------------------------ helpers
  // All times are shown in the configured timezone (config.json), not the browser's, so the
  // page reads right even if the stick's clock settings are off.
  function tz() { return (state.config && state.config.timezone) || undefined; }
  function fmtTime(d) {
    try { return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz() }); }
    catch (e) { return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
  }
  function fmtDate(d) {
    try { return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz() }); }
    catch (e) { return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); }
  }
  function dayKey(d) {
    try { return d.toLocaleDateString("en-US", { timeZone: tz() }); } catch (e) { return d.toDateString(); }
  }

  function tickClock() {
    const now = new Date();
    $("#clock-time").textContent = fmtTime(now);
    $("#clock-date").textContent = fmtDate(now);
  }

  function logo(team, cls) {
    const wrap = el("span");
    if (team.logo) {
      const img = el("img", cls || "logo");
      img.alt = "";
      img.src = team.logo;
      img.onerror = () => { img.replaceWith(logoFallback(team, cls)); };
      return img;
    }
    return logoFallback(team, cls);
  }

  function logoFallback(team, cls) {
    const f = el("span", (cls || "logo") + " logo-fallback", (team.abbr || "?").slice(0, 3));
    f.style.background = "#" + (team.color || "334");
    return f;
  }

  function allGames() {
    const out = [];
    (state.today ? state.today.leagues : []).forEach((l) => l.games.forEach((g) => out.push(g)));
    return out;
  }

  const ORDER = { in: 0, pre: 1, post: 2 };
  // The order of "favorites" in config.json is a priority list: Wyoming before the Bills before the
  // Avs, etc. favRank() is the best (lowest) index of either team, 999 for a non-favourite.
  function favRank(g) {
    const favs = (state.config && state.config.favorites) || [];
    let best = 999;
    favs.forEach((f, i) => {
      if (f.league !== g.league) return;
      const t = (f.team || "").toLowerCase();
      if ([g.home.abbr, g.away.abbr, g.home.id, g.away.id].some((x) => String(x || "").toLowerCase() === t)) best = Math.min(best, i);
    });
    return best;
  }
  function sortGames(games) {
    return games.slice().sort((a, b) =>
      favRank(a) - favRank(b) ||
      (ORDER[a.state] - ORDER[b.state]) ||
      (a.start || "").localeCompare(b.start || ""));
  }

  // ------------------------------------------------------------------ render: tabs
  function renderTabs() {
    const tabs = $("#tabs");
    const leagues = state.today ? state.today.leagues : [];
    const withGames = leagues.filter((l) => l.games.length);
    const items = [{ key: "all", label: "Today", count: allGames().length, live: (state.today && state.today.liveCount) || 0 }]
      .concat(withGames.map((l) => ({ key: l.league, label: l.label, count: l.games.length, live: l.games.filter((g) => g.state === "in").length })));
    if (state.fantasy && state.fantasy.enabled !== false && state.config && state.config.fantasy && state.config.fantasy.enabled) {
      items.push({ key: "fantasy", label: (state.config.fantasy.title || "Fantasy").replace(/ ·.*$/, ""), count: "", live: 0 });
    }
    if (state.tab !== "all" && !items.some((t) => t.key === state.tab)) state.tab = "all";
    const prevTabId = state.focus && state.focus.dataset.focusable === "tab" ? state.focus.id : null;
    tabs.innerHTML = "";
    items.forEach((t) => {
      const b = el("button", "tab" + (t.key === state.tab ? " active" : ""));
      b.dataset.focusable = "tab";
      b.dataset.tab = t.key;
      b.id = "tab-" + t.key;
      b.appendChild(el("span", null, t.label));
      if (t.count !== "") b.appendChild(el("span", "count", String(t.count)));
      if (t.live) b.appendChild(el("span", "live-dot"));
      b.onclick = () => selectTab(t.key);
      tabs.appendChild(b);
    });
    if (!state.focus) focusEl($("#tab-all"));
    else if (prevTabId) focusEl(document.getElementById(prevTabId) || $("#tab-all"), true);
    $("#live-pill").classList.toggle("hidden", !(state.today && state.today.liveCount));
    $("#live-count").textContent = (state.today && state.today.liveCount) || 0;
  }

  function selectTab(key) {
    state.tab = key;
    renderTabs();
    renderGames();
    $("#games").scrollTop = 0;
    focusEl($("#tab-" + key));
  }

  // ------------------------------------------------------------------ render: games
  function renderGames() {
    const root = $("#games");
    const prevFocusId = state.focus && state.focus.dataset.focusable === "card" ? state.focus.id : null;
    root.innerHTML = "";
    root.classList.toggle("fantasy-page", state.tab === "fantasy");
    if (state.tab === "fantasy") { renderFantasyPage(root); if (prevFocusId) focusEl($("#tab-fantasy"), true); return; }
    const leagues = state.today ? state.today.leagues : [];
    let groups;
    if (state.tab === "all") {
      groups = [{ label: null, games: sortGames(allGames()) }];
    } else {
      const l = leagues.find((x) => x.league === state.tab);
      groups = [{ label: null, games: l ? sortGames(l.games) : [] }];
    }
    if (!groups[0].games.length) {
      const allFailed = leagues.length && leagues.every((l) => l.error);
      root.appendChild(el("div", "games-empty", !leagues.length ? "Loading…" : allFailed ? "Can't reach ESPN right now" : "No games today"));
      return;
    }
    groups.forEach((g) => {
      if (g.label) root.appendChild(el("div", "league-head", g.label));
      g.games.forEach((game) => root.appendChild(renderCard(game)));
    });
    if (prevFocusId) {
      const again = document.getElementById(prevFocusId);
      if (again) focusEl(again, true);
      else focusEl(root.querySelector("[data-focusable]"));
    }
  }

  function renderCard(g) {
    const card = el("div", "card " + g.state + (g.favorite ? " fav" : ""));
    card.id = "game-" + g.league + "-" + g.id;
    card.dataset.focusable = "card";
    card.dataset.league = g.league;
    card.dataset.id = g.id;
    card.tabIndex = -1;

    const status = el("div", "card-status");
    const st = el("span", "state");
    if (g.state === "in") st.appendChild(el("span", "dot"));
    st.appendChild(el("span", null, g.detail || ""));
    status.appendChild(st);
    const right = el("span", "bcast", state.tab === "all" ? [g.leagueLabel, g.broadcast].filter(Boolean).join(" · ") : (g.broadcast || ""));
    status.appendChild(right);
    card.appendChild(status);

    card.appendChild(renderTeamRow(g, g.away, "away"));
    card.appendChild(renderTeamRow(g, g.home, "home"));

    const foot = el("div", "card-foot");
    if (g.state === "in" && g.situation) {
      if (g.sport === "baseball" && g.situation.bases_detail) {
        const b = el("span", "bases");
        const d = g.situation.bases_detail;
        // diamond: second (top), third (left), first (right), empty (bottom)
        [["second", d.second], ["first", d.first], ["third", d.third], ["empty", false]].forEach(([k, on]) => {
          const i = el("i", k === "empty" ? "empty" : (on ? "on" : ""));
          b.appendChild(i);
        });
        foot.appendChild(b);
        foot.appendChild(el("span", null, g.situation.text || ""));
      } else {
        if (g.situation.redZone) foot.classList.add("redzone");
        foot.appendChild(el("span", null, g.situation.text || g.situation.lastPlay || ""));
      }
    } else if (g.state === "pre") {
      const bits = [];
      if (g.odds && state.config && state.config.showOdds !== false) {
        if (g.odds.details) bits.push(g.odds.details);
        if (g.odds.overUnder) bits.push("O/U " + g.odds.overUnder);
      }
      if (!bits.length && g.venue) bits.push(g.venue);
      foot.appendChild(el("span", null, bits.join("  ·  ")));
    } else {
      foot.appendChild(el("span", null, g.headline || g.notes || g.venue || ""));
    }
    card.appendChild(foot);
    card.onclick = () => openGame(g);
    return card;
  }

  function renderTeamRow(g, t, side) {
    const row = el("div", "team");
    if (g.state === "post" && !t.winner && g.home.score !== g.away.score) row.classList.add("loser");
    row.appendChild(logo(t));
    const name = el("span", "tname");
    if (t.rank) name.appendChild(el("span", "rank", String(t.rank)));
    name.appendChild(el("span", null, t.short || t.name || t.abbr));
    if (t.record) name.appendChild(el("span", "rec", t.record));
    if (g.state === "in" && g.situation && g.situation.possession === side) name.appendChild(el("span", "poss", "●"));
    row.appendChild(name);
    const score = el("span", "score", g.state === "pre" ? "" : (t.score != null ? String(t.score) : ""));
    row.appendChild(score);
    return row;
  }

  // ------------------------------------------------------------------ render: rail
  function renderMyTeams() {
    const root = $("#myteams");
    root.innerHTML = "";
    const teams = (state.myteams && state.myteams.teams) || [];
    if (!teams.length) {
      root.appendChild(el("div", "myteam-empty", state.config && state.config.favorites && state.config.favorites.length ? "…" : "Add favourites in config.json"));
      return;
    }
    teams.forEach((t) => {
      const row = el("div", "myteam");
      row.appendChild(logo(t));
      const col = el("div");
      const l1 = el("div", "line1");
      l1.appendChild(el("span", null, t.short || t.name));
      l1.appendChild(el("span", "rec", t.record || ""));
      col.appendChild(l1);
      const l2 = el("div", "line2");
      const n = t.next;
      if (n) {
        const isHome = n.home.abbr === t.abbr;
        const opp = isHome ? n.away : n.home;
        const vs = (isHome ? "vs " : "@ ") + (opp.abbr || opp.short);
        if (n.state === "in") {
          const live = el("span", "live", "LIVE ");
          l2.appendChild(live);
          l2.appendChild(document.createTextNode(vs + "  " + n.away.score + "-" + n.home.score + "  " + n.detail));
        } else if (n.state === "pre") {
          l2.textContent = vs + "  " + whenLabel(n.startLocal) + (n.broadcast ? "  " + n.broadcast : "");
        } else {
          const won = (isHome ? n.home : n.away).winner;
          l2.textContent = (won ? "W " : "L ") + n.away.score + "-" + n.home.score + " " + vs + (t.standing ? "  ·  " + t.standing : "");
        }
      } else {
        l2.textContent = t.standing || "";
      }
      col.appendChild(l2);
      row.appendChild(col);
      root.appendChild(row);
    });
  }

  function whenLabel(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    if (dayKey(d) === dayKey(now)) return "Today " + fmtTime(d);
    if (dayKey(d) === dayKey(tomorrow)) return "Tomorrow " + fmtTime(d);
    let wd; try { wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz() }); } catch (e) { wd = d.toLocaleDateString("en-US", { weekday: "short" }); }
    return wd + " " + fmtTime(d);
  }

  function renderNews() {
    const root = $("#news");
    root.innerHTML = "";
    const arts = (state.news && state.news.articles) || [];
    arts.slice(0, 8).forEach((a) => {
      const li = el("li");
      li.appendChild(el("span", "lg", a.league || ""));
      li.appendChild(el("span", null, a.headline || ""));
      root.appendChild(li);
    });
  }

  function liveProTeams() {
    // NFL pro-team abbreviations whose game is in progress right now, for the live dot on players
    const out = {};
    allGames().forEach((g) => { if (g.league === "nfl" && g.state === "in") { out[g.home.abbr] = g; out[g.away.abbr] = g; } });
    return out;
  }

  function renderFantasyPage(root) {
    const f = state.fantasy;
    const wrap = el("div", "fx");
    if (!f || f.enabled === false) { wrap.appendChild(el("div", "games-empty", "Fantasy is loading…")); root.appendChild(wrap); return; }
    const m = f.matchup;
    if (!m) {
      // generic producer: rows and lines, big
      const box = el("div", "fx-simple");
      (f.rows || []).forEach((r) => {
        const row = el("div", "frow");
        row.appendChild(el("span", "lbl", r.label || ""));
        row.appendChild(el("span", "val", r.value != null ? String(r.value) : ""));
        if (r.sub) row.appendChild(el("span", "sub", r.sub));
        box.appendChild(row);
      });
      (f.lines || []).forEach((t) => box.appendChild(el("div", "fline", t)));
      if (!box.children.length) box.appendChild(el("div", "fline", f.title || "No fantasy data"));
      wrap.appendChild(box);
      root.appendChild(wrap);
      return;
    }
    const live = liveProTeams();
    const head = el("div", "fx-head");
    const mkTeam = (t, right) => {
      const box = el("div", "fx-team" + (right ? " right" : ""));
      box.appendChild(el("div", "nm", t.name));
      box.appendChild(el("div", "rec", t.record || ""));
      box.appendChild(el("div", "pts", (t.points != null ? t.points : 0).toFixed(1)));
      box.appendChild(el("div", "proj", "proj " + (t.proj != null ? t.proj.toFixed(1) : "–")));
      return box;
    };
    const me = mkTeam(m.me, false);
    const opp = m.opp ? mkTeam(m.opp, true) : el("div", "fx-team right");
    if (m.opp && m.me.points !== m.opp.points) (m.me.points > m.opp.points ? me : opp).classList.add("lead");
    head.appendChild(me);
    const vs = el("div", "fx-vs", m.opp ? "VS" : "BYE");
    vs.appendChild(el("span", "wk", "Week " + (m.week || "")));
    head.appendChild(vs);
    head.appendChild(opp);
    wrap.appendChild(head);

    const rosters = el("div", "fx-rosters");
    const mkRoster = (t) => {
      const box = el("div", "fx-roster");
      const r = t.roster || [];
      box.appendChild(el("h3", null, "Starters"));
      r.filter((p) => !p.bench).forEach((p) => box.appendChild(mkRow(p)));
      const bench = r.filter((p) => p.bench);
      if (bench.length) {
        box.appendChild(el("h3", null, "Bench"));
        bench.forEach((p) => box.appendChild(mkRow(p)));
      }
      return box;
    };
    const mkRow = (p) => {
      const row = el("div", "fx-row" + (p.bench ? " bench" : ""));
      row.appendChild(el("span", "slot", p.slot || ""));
      const name = el("span", "name");
      name.appendChild(el("span", null, p.name || ""));
      if (p.status) name.appendChild(el("span", "st" + (p.status === "Q" ? " q" : ""), p.status));
      if (p.team && live[p.team]) name.appendChild(el("span", "ld"));
      row.appendChild(name);
      row.appendChild(el("span", "pro", p.team || ""));
      row.appendChild(el("span", "pts", p.points != null ? p.points.toFixed(1) : "–"));
      row.appendChild(el("span", "pj", p.proj != null ? p.proj.toFixed(1) : ""));
      return row;
    };
    rosters.appendChild(mkRoster(m.me));
    if (m.opp) rosters.appendChild(mkRoster(m.opp));
    wrap.appendChild(rosters);
    if (f.lines && f.lines.length) wrap.appendChild(el("div", "fx-simple fline", f.lines.join("   ·   ")));
    root.appendChild(wrap);
  }

  // ------------------------------------------------------------------ render: dock
  function renderDock() {
    const dock = $("#dock");
    dock.innerHTML = "";
    let apps = (state.config && state.config.apps) || [];
    if (!apps.length && window.SportsHub && typeof window.SportsHub.apps === "function") {
      // no dock configured: the kiosk app can tell us what is installed on the stick
      try { apps = JSON.parse(window.SportsHub.apps()) || []; } catch (e) { apps = []; }
      state.config.apps = apps;
    }
    if (!apps.length) { dock.classList.add("hidden"); return; }
    dock.classList.remove("hidden");
    apps.forEach((a, i) => {
      const t = el("div", "app-tile");
      t.id = "app-" + i;
      t.dataset.focusable = "app";
      t.dataset.package = a.package || "";
      t.dataset.url = a.url || "";
      const mono = el("span", "mono", initials(a.label));
      mono.style.background = a.color || hashColor(a.label);
      t.appendChild(mono);
      t.appendChild(el("span", null, a.label));
      t.onclick = () => launchApp(a);
      dock.appendChild(t);
    });
  }

  function initials(s) {
    const w = (s || "").split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w[0][0] + w[1][0] : (s || "?").slice(0, 2)).toUpperCase();
  }

  function hashColor(s) {
    let h = 0;
    for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return "hsl(" + (h % 360) + ", 45%, 38%)";
  }

  function launchApp(a) {
    // 1. the kiosk app's JS bridge (sportshub/android), 2. an intent:// URL (Fully Kiosk, Chrome),
    // 3. a plain URL. Each falls through to the next if unavailable.
    if (window.SportsHub && typeof window.SportsHub.launch === "function" && a.package) {
      const ok = window.SportsHub.launch(a.package);
      if (ok === false) toast("Not installed: " + a.label);
      return;
    }
    if (a.package) {
      toast("Opening " + a.label + "…");
      window.location.href = "intent:#Intent;package=" + a.package +
        ";action=android.intent.action.MAIN;category=android.intent.category.LEANBACK_LAUNCHER;launchFlags=0x10000000;end";
      return;
    }
    if (a.url) window.location.href = a.url;
  }

  // ------------------------------------------------------------------ overlay
  async function openGame(g) {
    state.overlayOpen = true;
    state.overlayGame = g;
    const card = $("#overlay-card");
    card.innerHTML = "";
    card.appendChild(renderOverlayHead(g));
    const body = el("div", "ov-body");
    body.appendChild(el("div", "ov-error", "Loading…"));
    card.appendChild(body);
    $("#overlay").classList.remove("hidden");
    card.scrollTop = 0;
    try {
      const d = await getJSON("/api/game?league=" + encodeURIComponent(g.league) + "&id=" + encodeURIComponent(g.id));
      if (!state.overlayOpen || state.overlayGame !== g) return;
      body.innerHTML = "";
      renderOverlayBody(body, g, d);
    } catch (e) {
      body.innerHTML = "";
      renderOverlayBody(body, g, null);
    }
  }

  function closeOverlay() {
    state.overlayOpen = false;
    state.overlayGame = null;
    $("#overlay").classList.add("hidden");
  }

  function renderOverlayHead(g) {
    const head = el("div", "ov-head");
    const mk = (t) => {
      const w = el("div", "ov-team");
      w.appendChild(logo(t));
      w.appendChild(el("div", "nm", (t.rank ? "#" + t.rank + " " : "") + (t.name || t.short)));
      w.appendChild(el("div", "rec", t.record || ""));
      return w;
    };
    head.appendChild(mk(g.away));
    const mid = el("div");
    mid.appendChild(el("div", "ov-score", g.state === "pre" ? fmtTime(new Date(g.startLocal || g.start)) : (g.away.score + " – " + g.home.score)));
    mid.appendChild(el("div", "ov-status" + (g.state === "in" ? " in" : ""), g.detail || ""));
    mid.appendChild(el("div", "ov-sub", [g.broadcast, g.venue].filter(Boolean).join(" · ")));
    head.appendChild(mid);
    head.appendChild(mk(g.home));
    return head;
  }

  function renderOverlayBody(body, g, d) {
    // linescore from the scoreboard (always available)
    const ls = g.away.linescores || [], lsH = g.home.linescores || [];
    if (ls.length || lsH.length) {
      const sec = el("div", "ov-section");
      sec.appendChild(el("h3", null, "Linescore"));
      const tbl = el("table", "linescore");
      const n = Math.max(ls.length, lsH.length);
      const thead = el("tr");
      thead.appendChild(el("th", null, ""));
      for (let i = 0; i < n; i++) thead.appendChild(el("th", null, String(i + 1)));
      thead.appendChild(el("th", null, "T"));
      tbl.appendChild(thead);
      [[g.away, ls], [g.home, lsH]].forEach(([t, arr]) => {
        const tr = el("tr");
        tr.appendChild(el("td", null, t.abbr));
        for (let i = 0; i < n; i++) tr.appendChild(el("td", null, arr[i] != null ? String(arr[i]) : "-"));
        tr.appendChild(el("td", "tot", t.score != null ? String(t.score) : ""));
        tbl.appendChild(tr);
      });
      sec.appendChild(tbl);
      body.appendChild(sec);
    }
    if (g.state === "pre") {
      const sec = el("div", "ov-section");
      sec.appendChild(el("h3", null, "Preview"));
      const bits = [];
      if (g.odds && g.odds.details) bits.push("Line: " + g.odds.details);
      if (g.odds && g.odds.overUnder) bits.push("O/U " + g.odds.overUnder);
      if (g.startLocal) bits.push(whenLabel(g.startLocal));
      sec.appendChild(el("div", "lastplay", bits.join("  ·  ") || "No preview available"));
      body.appendChild(sec);
    }
    const last = (d && d.lastPlay) || (g.situation && g.situation.lastPlay);
    if (g.state === "in" && (last || (g.situation && g.situation.text))) {
      const sec = el("div", "ov-section");
      sec.appendChild(el("h3", null, "Now"));
      sec.appendChild(el("div", "lastplay", [g.situation && g.situation.text, last].filter(Boolean).join("  —  ")));
      body.appendChild(sec);
    }
    if (d && d.scoringPlays && d.scoringPlays.length) {
      const sec = el("div", "ov-section");
      sec.appendChild(el("h3", null, "Scoring"));
      const list = el("div", "plays");
      d.scoringPlays.slice().reverse().forEach((p) => {
        const row = el("div", "play");
        row.appendChild(el("span", "p", (p.period ? ordinal(p.period) : "") + (p.clock ? " " + p.clock : "")));
        row.appendChild(el("span", "t", p.team || ""));
        row.appendChild(el("span", null, p.text || ""));
        row.appendChild(el("span", "s", (p.away != null && p.home != null) ? p.away + "-" + p.home : ""));
        list.appendChild(row);
      });
      sec.appendChild(list);
      body.appendChild(sec);
    }
    const leaders = (d && d.leaders && d.leaders.length) ? d.leaders : (g.leaders || []);
    if (leaders.length) {
      const sec = el("div", "ov-section");
      sec.appendChild(el("h3", null, "Leaders"));
      const grid = el("div", "leaders");
      leaders.forEach((L) => {
        const row = el("div", "leader");
        row.appendChild(el("span", "cat", (L.category || "").toUpperCase()));
        const who = el("span");
        who.appendChild(el("span", "who", (L.team ? L.team + " " : "") + (L.name || "")));
        who.appendChild(el("span", "val", "  " + (L.value || "")));
        row.appendChild(who);
        grid.appendChild(row);
      });
      sec.appendChild(grid);
      body.appendChild(sec);
    }
    if (d && d.box && d.box.length) {
      const sec = el("div", "ov-section");
      sec.appendChild(el("h3", null, "Team stats"));
      const tbl = el("table", "linescore");
      const labels = d.box[0].stats.map((s) => s.label);
      const tr0 = el("tr");
      tr0.appendChild(el("th", null, ""));
      labels.forEach((l) => tr0.appendChild(el("th", null, l)));
      tbl.appendChild(tr0);
      d.box.forEach((t) => {
        const tr = el("tr");
        tr.appendChild(el("td", null, t.team || ""));
        labels.forEach((l) => {
          const s = t.stats.find((x) => x.label === l);
          tr.appendChild(el("td", null, s ? s.value : "-"));
        });
        tbl.appendChild(tr);
      });
      sec.appendChild(tbl);
      body.appendChild(sec);
    }
    if (!body.children.length) body.appendChild(el("div", "ov-error", "No details available"));
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ------------------------------------------------------------------ focus / D-pad
  function focusables() {
    return Array.from(document.querySelectorAll("[data-focusable]")).filter((e) => e.offsetParent !== null);
  }

  function focusEl(e, silent) {
    if (!e) return;
    if (state.focus && state.focus !== e) state.focus.classList.remove("focused");
    state.focus = e;
    e.classList.add("focused");
    state.lastFocusByZone[e.dataset.focusable] = e.id;
    if (!silent) scrollIntoView(e);
  }

  function scrollIntoView(e) {
    const zone = e.dataset.focusable;
    const container = zone === "card" ? $("#games") : zone === "app" ? $("#dock") : null;
    if (!container) return;
    const r = e.getBoundingClientRect(), c = container.getBoundingClientRect();
    const pad = 16;
    if (zone === "card") {
      if (r.top < c.top + pad) container.scrollTop += r.top - c.top - pad;
      else if (r.bottom > c.bottom - pad) container.scrollTop += r.bottom - c.bottom + pad;
    } else {
      if (r.left < c.left + pad) container.scrollLeft += r.left - c.left - pad;
      else if (r.right > c.right - pad) container.scrollLeft += r.right - c.right + pad;
    }
  }

  // Geometric spatial navigation: pick the nearest focusable in the pressed direction, preferring
  // candidates that overlap the current element on the perpendicular axis.
  function move(dir) {
    let cur = state.focus;
    const all = focusables();
    if (cur && !cur.isConnected && cur.id) cur = document.getElementById(cur.id);
    if (!cur || !all.includes(cur)) { focusEl(all[0]); return; }
    if (cur !== state.focus) focusEl(cur, true);
    const a = cur.getBoundingClientRect();
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    let best = null, bestScore = Infinity;
    all.forEach((e) => {
      if (e === cur) return;
      const b = e.getBoundingClientRect();
      const bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
      let primary, secondary, overlap;
      // strict edge rule: the candidate must lie entirely beyond the current element in that direction
      if (dir === "up") { primary = a.top - b.bottom; secondary = Math.abs(bx - ax); overlap = b.right > a.left && b.left < a.right; }
      else if (dir === "down") { primary = b.top - a.bottom; secondary = Math.abs(bx - ax); overlap = b.right > a.left && b.left < a.right; }
      else if (dir === "left") { primary = a.left - b.right; secondary = Math.abs(by - ay); overlap = b.bottom > a.top && b.top < a.bottom; }
      else { primary = b.left - a.right; secondary = Math.abs(by - ay); overlap = b.bottom > a.top && b.top < a.bottom; }
      primary += 4; // tolerance for sub-pixel layouts
      if ((dir === "left" || dir === "right") && !overlap) return; // sideways moves stay within the row
      if (primary < 0) return;
      // same-zone moves are cheaper than crossing zones, overlap is cheaper than offset
      const zonePenalty = e.dataset.focusable === cur.dataset.focusable ? 0 : 200;
      const score = primary + secondary * (overlap ? 0.3 : 2) + zonePenalty;
      if (score < bestScore) { bestScore = score; best = e; }
    });
    if (best) focusEl(best);
  }

  function activate() {
    const e = state.focus;
    if (!e) return;
    if (e.dataset.focusable === "tab") selectTab(e.dataset.tab);
    else if (e.dataset.focusable === "card") {
      const g = allGames().find((x) => x.league === e.dataset.league && x.id === e.dataset.id);
      if (g && g.state === "in") enterGameMode(g);
      else if (g) openGame(g);
    } else if (e.dataset.focusable === "app") {
      const apps = state.config.apps || [];
      const a = apps[parseInt(e.id.replace("app-", ""), 10)];
      if (a) launchApp(a);
    }
  }

  function onKey(ev) {
    const idleMs = Date.now() - state.lastKeyAt;
    state.lastKeyAt = Date.now();
    const k = ev.key, code = ev.keyCode;
    if (idleMs > 10000 && !state.overlayOpen && !state.gm.active && /^Arrow/.test(k) && recoverFocusAfterIdle()) { ev.preventDefault(); return; }
    const isBack = k === "Escape" || k === "Backspace" || k === "GoBack" || k === "BrowserBack" || code === 27 || code === 461 || code === 10009;
    if (state.gm.active) {
      if (isBack || k === "Enter" || code === 13) exitGameMode();
      else if (k === "ArrowLeft") cycleGameMode(-1);
      else if (k === "ArrowRight") cycleGameMode(1);
      else if (k === "ArrowDown") { const g = gmGame(); exitGameMode(); if (g) openGame(g); }
      ev.preventDefault();
      return;
    }
    if (state.overlayOpen) {
      const card = $("#overlay-card");
      if (isBack || k === "Enter" || code === 13) { closeOverlay(); ev.preventDefault(); return; }
      if (k === "ArrowDown") card.scrollTop += 160;
      else if (k === "ArrowUp") card.scrollTop -= 160;
      ev.preventDefault();
      return;
    }
    if (k === "ArrowUp") move("up");
    else if (k === "ArrowDown") move("down");
    else if (k === "ArrowLeft") move("left");
    else if (k === "ArrowRight") move("right");
    else if (k === "Enter" || code === 13 || k === " ") activate();
    else if (isBack) { if (state.tab !== "all") selectTab("all"); else focusEl($("#tab-all")); }
    else if (/^[1-9]$/.test(k)) { const t = $("#tabs").children[parseInt(k, 10) - 1]; if (t) selectTab(t.dataset.tab); }
    else if (k === "0") demoCallout();
    else if (k === "r" || k === "R" || k === "MediaPlayPause") loadToday();
    else return;
    ev.preventDefault();
  }

  // Exposed for the Android kiosk wrapper: it calls these on hardware Back / Home / resume.
  window.SportsHubPage = {
    back() { if (state.gm.active) { exitGameMode(); return true; } if (state.overlayOpen) { closeOverlay(); return true; } if (state.tab !== "all") { selectTab("all"); return true; } return false; },
    home() { exitGameMode(); closeOverlay(); selectTab("all"); },
    gameMode(league, id) { const g = allGames().find((x) => x.league === league && x.id === id); if (g) enterGameMode(g); },
    // for testing callouts from the browser console: SportsHubPage.simulateScore("nfl", "401901001", "away", 7)
    demo(sport) { demoCallout(sport); },
    simulateScore(league, id, side, delta) { const g = allGames().find((x) => x.league === league && x.id === id); if (!g) return; g[side].score = String((parseInt(g[side].score, 10) || 0) + delta); detectScoreChanges(); if (state.gm.active) renderGameMode(); else renderGames(); },
    refresh() { loadToday(); loadMyTeams(); loadNews(); loadFantasy(); },
  };

  // ------------------------------------------------------------------ idle rotation
  // While the remote is idle the hub pages the score grid upward one row-band at a time, and
  // moves to the next league tab once the bottom is reached. Nothing needs pressing.
  let lastIdleAction = 0;
  function idleTick() {
    const cfg = state.config || {};
    const rotate = cfg.idleRotateSeconds || 0;
    if (!rotate || state.overlayOpen || state.gm.active) return;
    const now = Date.now();
    if (now - state.lastKeyAt < (cfg.idleAfterSeconds || 30) * 1000) { lastIdleAction = now; return; }
    const grid = $("#games");
    const canScroll = grid.scrollTop + grid.clientHeight < grid.scrollHeight - 4;
    const dwell = canScroll ? (cfg.idleScrollSeconds || 7) : rotate;
    if (now - lastIdleAction < dwell * 1000) return;
    lastIdleAction = now;
    if (canScroll) {
      const card = grid.querySelector(".card");
      const rowH = card ? card.getBoundingClientRect().height + 20 : grid.clientHeight / 2;
      const rows = Math.max(1, Math.floor(grid.clientHeight / rowH));
      grid.scrollTo({ top: grid.scrollTop + rows * rowH, behavior: "smooth" });
      return;
    }
    const tabs = Array.from($("#tabs").children);
    if (tabs.length < 2) { grid.scrollTo({ top: 0, behavior: "smooth" }); return; }
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + 1) % tabs.length];
    state.tab = next.dataset.tab;
    renderTabs();
    renderGames();
    grid.scrollTop = 0;
    focusEl(next, true);
  }

  // First key press after an idle spell: if the focused card was scrolled out of view, land on the
  // first visible card instead of jumping somewhere off-screen.
  function recoverFocusAfterIdle() {
    const f = state.focus;
    if (!f || f.dataset.focusable !== "card") return false;
    const grid = $("#games");
    const r = f.getBoundingClientRect(), c = grid.getBoundingClientRect();
    if (r.bottom > c.top && r.top < c.bottom) return false;
    const visible = Array.from(grid.querySelectorAll(".card")).find((e) => { const b = e.getBoundingClientRect(); return b.top >= c.top - 2 && b.bottom <= c.bottom + 2; });
    if (!visible) return false;
    focusEl(visible, true);
    return true;
  }


  // ------------------------------------------------------------------ game mode (the board)
  function gmCfg() { return (state.config && state.config.gameMode) || {}; }

  function liveFavorites() {
    return sortGames(allGames().filter((g) => g.state === "in" && g.favorite));
  }

  function gmGame() {
    return allGames().find((g) => g.league === state.gm.league && g.id === state.gm.id) || null;
  }

  function enterGameMode(g) {
    const first = !state.gm.active;
    state.gm.active = true;
    state.gm.league = g.league;
    state.gm.id = g.id;
    state.gm.enteredAt = Date.now();
    state.gm.lastRotate = Date.now();
    state.gm.finalAt = 0;
    state.gm.details = null;
    closeOverlay();
    $("#gamemode").classList.remove("hidden");
    renderGameMode();
    loadGameDetails();
    if (first) loadToday(); // tighten the refresh cadence right away
  }

  function exitGameMode() {
    if (!state.gm.active) return;
    state.gm.active = false;
    $("#gamemode").classList.add("hidden");
    scheduleToday();
  }

  function cycleGameMode(dir) {
    let pool = liveFavorites();
    if (pool.length < 2) pool = sortGames(allGames().filter((g) => g.state === "in"));
    if (pool.length < 2) return;
    const i = pool.findIndex((g) => g.league === state.gm.league && g.id === state.gm.id);
    const next = pool[(i + dir + pool.length) % pool.length];
    enterGameMode(next);
  }

  async function loadGameDetails() {
    const g = gmGame();
    if (!g) return;
    try {
      const d = await getJSON("/api/game?league=" + encodeURIComponent(g.league) + "&id=" + encodeURIComponent(g.id));
      if (state.gm.active && state.gm.id === g.id) { state.gm.details = d; renderGameMode(); }
    } catch (e) { /* board works without details */ }
  }

  function teamRgb(t) { return hexToRgb("#" + (t.color || "334455")) || "51, 68, 85"; }

  function renderGameMode() {
    const g = gmGame();
    const root = $("#gamemode");
    if (!g) { exitGameMode(); return; }
    root.style.setProperty("--away-rgb", teamRgb(g.away));
    root.style.setProperty("--home-rgb", teamRgb(g.home));
    root.innerHTML = "";

    const top = el("div", "gm-top");
    top.appendChild(el("div", "gm-league", g.leagueLabel + (g.venue ? "  ·  " + g.venue : "")));
    top.appendChild(el("div", "gm-clock-wall", fmtTime(new Date())));
    top.appendChild(el("div", "gm-right", [g.broadcast, g.city].filter(Boolean).join("  ·  ")));
    root.appendChild(top);

    const main = el("div", "gm-main");
    main.appendChild(renderGmTeam(g, g.away, "away"));
    main.appendChild(renderGmCenter(g));
    main.appendChild(renderGmTeam(g, g.home, "home"));
    root.appendChild(main);

    root.appendChild(renderGmBottom(g, state.gm.details));
    root.appendChild(el("div", "gm-hint", "◀ ▶ other games · ▼ details · BACK hub"));

    if (g.state === "post" && !state.gm.finalAt) state.gm.finalAt = Date.now();
  }

  function renderGmTeam(g, t, side) {
    const box = el("div", "gm-team " + side);
    const poss = g.state === "in" && g.situation && g.situation.possession === side;
    if (poss) box.classList.add("poss");
    if (poss && g.situation.redZone) box.classList.add("redzone");
    if (g.state === "post" && !t.winner && g.home.score !== g.away.score) box.classList.add("loser");
    box.appendChild(logo(t));
    const name = el("div", "gm-name");
    if (t.rank) name.appendChild(el("span", "rank", "#" + t.rank));
    name.appendChild(el("span", null, t.short || t.name));
    box.appendChild(name);
    box.appendChild(el("div", "gm-rec", [t.record, side === "home" ? "HOME" : "AWAY"].filter(Boolean).join("  ·  ")));
    const score = el("div", "gm-score", g.state === "pre" ? "–" : (t.score != null ? String(t.score) : "0"));
    score.id = "gm-score-" + side;
    box.appendChild(score);
    if (g.sport === "football" && g.situation && g.situation.timeouts && g.state === "in") {
      const to = el("div", "gm-timeouts");
      const n = g.situation.timeouts[side];
      for (let i = 0; i < 3; i++) to.appendChild(el("i", i < (n || 0) ? "on" : ""));
      box.appendChild(to);
    }
    return box;
  }

  function renderGmCenter(g) {
    const c = el("div", "gm-center");
    if (g.state === "in") {
      c.appendChild(el("div", "gm-state live", "● Live"));
      const isHalf = /half|end/i.test(g.detail || "");
      c.appendChild(el("div", "gm-clock", g.sport === "baseball" ? g.detail : (isHalf ? g.detail : (g.clock || ""))));
      if (g.sport !== "baseball" && !isHalf) c.appendChild(el("div", "gm-period", g.periodLabel || ""));
      if (g.situation) {
        const sit = el("div", "gm-situation" + (g.situation.redZone ? " redzone" : ""));
        if (g.sport === "baseball" && g.situation.bases_detail) {
          const b = el("span", "bases");
          const d = g.situation.bases_detail;
          [["second", d.second], ["first", d.first], ["third", d.third], ["empty", false]].forEach(([k, on]) => b.appendChild(el("i", k === "empty" ? "empty" : (on ? "on" : ""))));
          sit.appendChild(b);
        }
        sit.appendChild(el("span", null, g.situation.text || ""));
        if (g.situation.text || g.situation.bases_detail) c.appendChild(sit);
        const last = (state.gm.details && state.gm.details.lastPlay) || g.situation.lastPlay;
        if (last) c.appendChild(el("div", "gm-lastplay", last));
      }
    } else if (g.state === "pre") {
      c.appendChild(el("div", "gm-state", "Upcoming"));
      c.appendChild(el("div", "gm-clock", fmtTime(new Date(g.startLocal || g.start))));
      c.appendChild(el("div", "gm-period", whenLabel(g.startLocal)));
      if (g.odds && (g.odds.details || g.odds.overUnder)) c.appendChild(el("div", "gm-odds", [g.odds.details, g.odds.overUnder ? "O/U " + g.odds.overUnder : null].filter(Boolean).join("  ·  ")));
    } else {
      c.appendChild(el("div", "gm-state", g.detail || "Final"));
      const w = g.home.winner ? g.home : g.away.winner ? g.away : null;
      c.appendChild(el("div", "gm-clock", w ? (w.short || w.abbr) : "Tie"));
      c.appendChild(el("div", "gm-period", w ? "win" : ""));
      if (g.headline) c.appendChild(el("div", "gm-lastplay", g.headline));
    }
    return c;
  }

  function renderGmBottom(g, d) {
    const b = el("div", "gm-bottom");
    const ls = el("div");
    ls.appendChild(el("h3", null, "Linescore"));
    const a = g.away.linescores || [], h = g.home.linescores || [];
    const n = Math.max(a.length, h.length, g.sport === "baseball" ? 9 : g.sport === "hockey" ? 3 : g.sport === "football" ? 4 : 4);
    const tbl = el("table", "linescore");
    const tr0 = el("tr"); tr0.appendChild(el("th", null, ""));
    for (let i = 0; i < n; i++) tr0.appendChild(el("th", null, String(i + 1)));
    tr0.appendChild(el("th", null, "T")); tbl.appendChild(tr0);
    [[g.away, a], [g.home, h]].forEach(([t, arr]) => {
      const tr = el("tr"); tr.appendChild(el("td", null, t.abbr));
      for (let i = 0; i < n; i++) tr.appendChild(el("td", null, arr[i] != null ? String(arr[i]) : "·"));
      tr.appendChild(el("td", "tot", g.state === "pre" ? "" : String(t.score != null ? t.score : 0))); tbl.appendChild(tr);
    });
    ls.appendChild(tbl);
    b.appendChild(ls);

    const plays = el("div");
    plays.appendChild(el("h3", null, "Scoring"));
    const list = el("div", "plays");
    const sp = (d && d.scoringPlays) || [];
    if (!sp.length) list.appendChild(el("div", "ov-error", g.state === "pre" ? "Not started" : "No scoring yet"));
    sp.slice(-4).reverse().forEach((p) => {
      const row = el("div", "play");
      row.appendChild(el("span", "p", (p.period ? ordinal(p.period) : "") + (p.clock ? " " + p.clock : "")));
      row.appendChild(el("span", "t", p.team || ""));
      row.appendChild(el("span", null, p.text || ""));
      row.appendChild(el("span", "s", (p.away != null && p.home != null) ? p.away + "-" + p.home : ""));
      list.appendChild(row);
    });
    plays.appendChild(list);
    b.appendChild(plays);

    const lead = el("div", "gm-leaders");
    lead.appendChild(el("h3", null, "Leaders"));
    const L = ((d && d.leaders && d.leaders.length) ? d.leaders : (g.leaders || [])).slice(0, 4);
    if (!L.length) lead.appendChild(el("div", "ov-error", "–"));
    L.forEach((x) => {
      const row = el("div", "leader");
      row.appendChild(el("span", "cat", (x.category || "").toUpperCase()));
      const who = el("span");
      who.appendChild(el("span", "who", (x.team ? x.team + " " : "") + (x.name || "")));
      who.appendChild(el("span", "val", "  " + (x.value || "")));
      row.appendChild(who);
      lead.appendChild(row);
    });
    b.appendChild(lead);
    return b;
  }

  // ------------------------------------------------------------------ score changes + callouts
  function detectScoreChanges() {
    const first = !Object.keys(state.scores).length;
    allGames().forEach((g) => {
      const key = g.league + ":" + g.id;
      const now = { away: parseInt(g.away.score, 10) || 0, home: parseInt(g.home.score, 10) || 0 };
      const prev = state.scores[key];
      state.scores[key] = now;
      if (first || !prev || g.state !== "in") return;
      ["away", "home"].forEach((side) => {
        const delta = now[side] - prev[side];
        if (delta > 0) onScore(g, side, delta);
      });
    });
  }

  function scoreWord(g, delta) {
    switch (g.sport) {
      case "football": return delta >= 6 ? "Touchdown" : delta === 3 ? "Field goal" : delta === 2 ? "Safety" : null;
      case "hockey": return "Goal";
      case "soccer": return "Goal";
      case "baseball": return delta >= 4 ? "Grand slam" : delta === 1 ? "Run scores" : delta + " runs score";
      default: return null; // basketball scores too often to shout about
    }
  }

  function onScore(g, side, delta) {
    const t = g[side];
    const inBoard = state.gm.active && state.gm.id === g.id;
    if (inBoard) {
      const s = $("#gm-score-" + side);
      if (s) { s.classList.remove("bump"); void s.offsetWidth; s.classList.add("bump"); }
      loadGameDetails();
    }
    const word = scoreWord(g, delta);
    if (!word || gmCfg().callouts === false) return;
    if (!g.favorite && !inBoard) return;
    const favSide = isFavoriteTeam(g, side);
    showCallout(word + " " + (t.short || t.abbr), g, side, favSide);
    if (favSide) playScoreSound(g, side);
  }

  function isFavoriteTeam(g, side) {
    const favs = (state.config && state.config.favorites) || [];
    const abbr = (g[side].abbr || "").toLowerCase(), id = String(g[side].id || "").toLowerCase();
    return favs.some((f) => f.league === g.league && [abbr, id].includes((f.team || "").toLowerCase()));
  }

  const ICONS = {
    football: '<svg viewBox="0 0 100 100"><ellipse cx="50" cy="50" rx="46" ry="27" fill="#7a3b12" stroke="#f2e6d8" stroke-width="3"/><path d="M30 50h40M38 43v14M46 43v14M54 43v14M62 43v14" stroke="#f2e6d8" stroke-width="3" stroke-linecap="round"/></svg>',
    hockey: '<svg viewBox="0 0 100 100">'
      + '<defs><radialGradient id="gl" cx="40%" cy="35%" r="65%"><stop offset="0" stop-color="#ffb3b3"/><stop offset="0.35" stop-color="#ff1a1a"/><stop offset="1" stop-color="#7a0000"/></radialGradient></defs>'
      + '<rect x="18" y="72" width="64" height="12" rx="3" fill="#2b2b2b" stroke="#555" stroke-width="2"/>'
      + '<rect x="28" y="64" width="44" height="10" rx="2" fill="#3a3a3a"/>'
      + '<path d="M26 66 V40 a24 24 0 0 1 48 0 V66 Z" fill="url(#gl)" stroke="#ff6666" stroke-width="2"/>'
      + '<path d="M34 44 a16 16 0 0 1 12 -14" fill="none" stroke="#fff" stroke-opacity="0.7" stroke-width="3" stroke-linecap="round"/>'
      + '<path d="M26 52 h48 M26 59 h48" stroke="#5a0000" stroke-width="1.5" stroke-opacity="0.6"/>'
      + '</svg>',
    baseball: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#f6f1e7" stroke="#ccc" stroke-width="2"/><path d="M22 14q28 36 0 72M78 14q-28 36 0 72" fill="none" stroke="#c0392b" stroke-width="4"/><path d="M26 22l8 4M24 32l8 3M24 44l8 1M24 56l8-1M24 68l8-3M26 78l8-4M74 22l-8 4M76 32l-8 3M76 44l-8 1M76 56l-8-1M76 68l-8-3M74 78l-8-4" stroke="#c0392b" stroke-width="2.5" stroke-linecap="round"/></svg>',
    soccer: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#fafafa" stroke="#ccc" stroke-width="2"/><polygon points="50,28 68,41 61,62 39,62 32,41" fill="#111"/><path d="M50 28V10M68 41l17-6M61 62l11 14M39 62L28 76M32 41l-17-6" stroke="#111" stroke-width="5"/></svg>',
    basketball: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#e8742c" stroke="#8a3f10" stroke-width="2"/><path d="M50 6v88M6 50h88M18 18q32 32 64 64M82 18q-32 32-64 64" fill="none" stroke="#3a1a08" stroke-width="3"/></svg>',
  };

  let calloutTimer = null;
  function showCallout(word, g, side, favSide) {
    const c = $("#callout");
    const t = g[side];
    c.style.setProperty("--callout-rgb", teamRgb(t));
    c.dataset.sport = g.sport;
    c.querySelector(".callout-word").textContent = word;
    c.querySelector(".callout-sub").textContent = g.shortName + "  ·  " + g.away.score + "–" + g.home.score + (g.detail ? "  ·  " + g.detail : "");
    // restart the CSS animations by re-creating the animated nodes
    const icon = c.querySelector(".callout-icon");
    icon.innerHTML = ICONS[g.sport] || "";
    const conf = c.querySelector(".callout-confetti");
    conf.innerHTML = "";
    const colors = ["#" + (t.color || "ffffff"), "#" + (t.altColor || "ffffff"), "#ffffff"];
    const n = favSide ? 70 : 35;
    for (let i = 0; i < n; i++) {
      const p = el("i");
      p.style.left = (Math.random() * 100) + "%";
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = (Math.random() * 1.2) + "s";
      p.style.animationDuration = (2.4 + Math.random() * 1.6) + "s";
      p.style.transform = "rotate(" + (Math.random() * 360) + "deg)";
      conf.appendChild(p);
    }
    c.classList.add("hidden");
    void c.offsetWidth;
    c.classList.remove("hidden");
    clearTimeout(calloutTimer);
    calloutTimer = setTimeout(() => c.classList.add("hidden"), favSide ? 9000 : 5000);
  }

  function playScoreSound(g, side) {
    const favs = (state.config && state.config.favorites) || [];
    const abbr = (g[side].abbr || "").toLowerCase(), id = String(g[side].id || "").toLowerCase();
    const fav = favs.find((f) => f.league === g.league && [abbr, id].includes((f.team || "").toLowerCase())) || {};
    const src = fav.sound || gmCfg().sound;
    if (!src) return;
    try { const a = new Audio(src); a.volume = 1; a.play().catch(() => {}); } catch (e) { /* no audio */ }
  }

  // Demo callouts: press 0 on the page, or open /?demo=score to play every sport once.
  const DEMO_SPORTS = ["football", "hockey", "baseball", "basketball", "soccer"];
  let demoIndex = 0;
  function demoCallout(sport) {
    sport = sport || DEMO_SPORTS[demoIndex++ % DEMO_SPORTS.length];
    const favs = (state.config && state.config.favorites) || [];
    const live = allGames().find((g) => g.favorite) || allGames()[0];
    const team = live ? (isFavoriteTeam(live, "away") ? live.away : live.home) : null;
    const t = team || { abbr: (favs[0] && favs[0].team || "HOME").toUpperCase(), short: "Home Team", color: "ffc425", altColor: "492f24" };
    const g = { sport: sport, league: "demo", id: "demo", shortName: (t.abbr || "HOME") + " vs OPP", detail: "Demo",
                away: t, home: { abbr: "OPP", short: "Visitors", color: "334455", altColor: "ffffff", score: "0" }, favorite: true };
    g.away = Object.assign({}, t, { score: sport === "football" ? "7" : "1" });
    const word = scoreWord(g, sport === "football" ? 7 : 1) || "Score";
    showCallout(word + " " + (t.short || t.abbr), g, "away", true);
    playScoreSound(g, "away");
  }
  function maybeRunDemo() {
    const q = new URLSearchParams(location.search);
    if (q.get("demo") !== "score") return;
    let i = 0;
    const next = () => { if (i < DEMO_SPORTS.length) { demoCallout(DEMO_SPORTS[i++]); setTimeout(next, 7000); } };
    setTimeout(next, 1500);
  }

  // Auto takeover: a favourite is live and the remote has been idle -> show the board.
  function gameModeTick() {
    const cfg = gmCfg();
    const idleMs = Date.now() - state.lastKeyAt;
    if (state.gm.active) {
      const g = gmGame();
      if (!g) { exitGameMode(); return; }
      if (g.state === "post" && state.gm.finalAt && Date.now() - state.gm.finalAt > (cfg.exitAfterFinalSeconds || 120) * 1000) {
        const others = liveFavorites();
        if (others.length) enterGameMode(others[0]); else exitGameMode();
        return;
      }
      // Favourites are a priority list: while the board is showing a lower-priority game and a
      // higher-priority favourite is live, switch to it (only when the remote is idle).
      const top = liveFavorites()[0];
      if (top && idleMs > 30000 && (top.id !== g.id || top.league !== g.league) && favRank(top) < favRank(g)) {
        enterGameMode(top);
        return;
      }
      if (cfg.rotateSeconds && idleMs > 30000 && Date.now() - state.gm.lastRotate > cfg.rotateSeconds * 1000) {
        const pool = liveFavorites();
        if (pool.length > 1) cycleGameMode(1);
      }
      return;
    }
    if (cfg.auto === false || state.overlayOpen) return;
    if (idleMs < (cfg.idleSeconds || 60) * 1000) return;
    const live = liveFavorites();
    if (live.length) enterGameMode(live[0]);
  }

  // ------------------------------------------------------------------ misc
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 2500);
  }

  async function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    document.addEventListener("keydown", onKey);
    try { await loadConfig(); } catch (e) { toast("Server unreachable"); }
    await loadToday();
    loadMyTeams();
    loadNews();
    loadFantasy();
    setInterval(loadMyTeams, 15 * 60 * 1000);
    setInterval(loadNews, 10 * 60 * 1000);
    setInterval(loadFantasy, 2 * 60 * 1000);
    setInterval(idleTick, 1000);
    setInterval(gameModeTick, 5000);
    setInterval(() => { if (state.gm.active) loadGameDetails(); }, Math.max(15, gmCfg().refreshSeconds || 15) * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) loadToday(); });
    maybeRunDemo();
  }

  boot();
})();
