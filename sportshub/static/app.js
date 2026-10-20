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
      accent: "#ffc425", accent2: "#00338d", accent2Fg: "#ffffff", live: "#c60c30", liveText: "#ff6b7f",
      bg: "#090a12", panel: "#12131f", panel2: "#1a1c2e", line: "#262a40", title: "#ffc425",
      gradient: "radial-gradient(ellipse at 0% 0%, rgba(255, 196, 37, 0.10), transparent 45%), radial-gradient(ellipse at 100% 100%, rgba(0, 51, 141, 0.35), transparent 50%)",
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
    renderTabs();
    renderGames();
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
    try { state.fantasy = await getJSON("/api/fantasy"); } catch (e) { /* keep old */ }
    renderFantasy();
  }

  function scheduleToday() {
    clearTimeout(state.timers.today);
    const r = (state.config && state.config.refresh) || {};
    const live = state.today && state.today.liveCount > 0;
    const secs = live ? (r.liveSeconds || 30) : (r.idleSeconds || 300);
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
  function sortGames(games) {
    return games.slice().sort((a, b) =>
      (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1) ||
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
    if (state.tab !== "all" && !items.some((t) => t.key === state.tab)) state.tab = "all";
    const prevTabId = state.focus && state.focus.dataset.focusable === "tab" ? state.focus.id : null;
    tabs.innerHTML = "";
    items.forEach((t) => {
      const b = el("button", "tab" + (t.key === state.tab ? " active" : ""));
      b.dataset.focusable = "tab";
      b.dataset.tab = t.key;
      b.id = "tab-" + t.key;
      b.appendChild(el("span", null, t.label));
      b.appendChild(el("span", "count", String(t.count)));
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

  function renderFantasy() {
    const sec = $("#fantasy-section");
    const f = state.fantasy;
    if (!f || !f.enabled) { sec.classList.add("hidden"); return; }
    sec.classList.remove("hidden");
    $("#fantasy-title").textContent = f.title || (state.config.fantasy && state.config.fantasy.title) || "Fantasy";
    const root = $("#fantasy");
    root.innerHTML = "";
    (f.rows || []).slice(0, 6).forEach((r) => {
      const row = el("div", "frow");
      const l = el("span", "lbl", r.label || "");
      if (r.sub) { l.appendChild(el("span", "sub", "  " + r.sub)); }
      row.appendChild(l);
      row.appendChild(el("span", "val", r.value != null ? String(r.value) : ""));
      root.appendChild(row);
    });
    (f.lines || []).slice(0, 6).forEach((t) => root.appendChild(el("div", "frow", t)));
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
      if (g) openGame(g);
    } else if (e.dataset.focusable === "app") {
      const apps = state.config.apps || [];
      const a = apps[parseInt(e.id.replace("app-", ""), 10)];
      if (a) launchApp(a);
    }
  }

  function onKey(ev) {
    state.lastKeyAt = Date.now();
    const k = ev.key, code = ev.keyCode;
    const isBack = k === "Escape" || k === "Backspace" || k === "GoBack" || k === "BrowserBack" || code === 27 || code === 461 || code === 10009;
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
    else if (k === "r" || k === "R" || k === "MediaPlayPause") loadToday();
    else return;
    ev.preventDefault();
  }

  // Exposed for the Android kiosk wrapper: it calls these on hardware Back / Home / resume.
  window.SportsHubPage = {
    back() { if (state.overlayOpen) { closeOverlay(); return true; } if (state.tab !== "all") { selectTab("all"); return true; } return false; },
    home() { closeOverlay(); selectTab("all"); },
    refresh() { loadToday(); loadMyTeams(); loadNews(); loadFantasy(); },
  };

  // ------------------------------------------------------------------ idle rotation
  function idleTick() {
    const secs = (state.config && state.config.idleRotateSeconds) || 0;
    if (!secs || state.overlayOpen) return;
    if (Date.now() - state.lastKeyAt < 90 * 1000) return;
    const tabs = Array.from($("#tabs").children);
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + 1) % tabs.length];
    state.tab = next.dataset.tab;
    renderTabs();
    renderGames();
    $("#games").scrollTop = 0;
    focusEl(next, true);
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
    setInterval(idleTick, ((state.config && state.config.idleRotateSeconds) || 20) * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) loadToday(); });
  }

  boot();
})();
