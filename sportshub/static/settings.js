/* Sports Hub settings screen: everything a remote can do. Edits the *user* config (the overrides
   layered on the defaults: config.local.json on a PC, config.json on the stick), so untouched keys
   keep following the defaults. Opened from the "Hub Settings" dock tile or the Menu key.

   Navigation: Up/Down rows, Left/Right change a value, OK opens, Back goes up a level; Back at the
   top level saves and applies. */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const LEAGUES = [
    { key: "nfl", label: "NFL", sport: "football", league: "nfl" },
    { key: "cfb", label: "CFB", sport: "football", league: "college-football", params: { groups: "80" } },
    { key: "nba", label: "NBA", sport: "basketball", league: "nba" },
    { key: "wnba", label: "WNBA", sport: "basketball", league: "wnba" },
    { key: "ncaam", label: "NCAAM", sport: "basketball", league: "mens-college-basketball", params: { groups: "50" }, news: false },
    { key: "ncaaw", label: "NCAAW", sport: "basketball", league: "womens-college-basketball", params: { groups: "50" }, news: false },
    { key: "nhl", label: "NHL", sport: "hockey", league: "nhl" },
    { key: "mlb", label: "MLB", sport: "baseball", league: "mlb" },
    { key: "mls", label: "MLS", sport: "soccer", league: "usa.1" },
    { key: "epl", label: "Premier League", sport: "soccer", league: "eng.1" },
    { key: "ucl", label: "Champions League", sport: "soccer", league: "uefa.champions" },
  ];
  const THEMES = ["default", "wyoming", "bills", "wyo-bills"];
  const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Berlin", "Australia/Sydney"];
  const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ".split("").concat(["⌫", "✓"]);

  const S = {
    open: false, draft: null, dirty: false,
    section: 0, zone: "nav", row: 0, modal: [],   // modal stack: {type, title, items, pick, sel, text}
    teamsCache: {}, apps: null, health: null,
  };

  // ------------------------------------------------------------------ helpers
  function hub() { return window.SportsHubPage || {}; }
  function effective() { return (hub().config && hub().config()) || {}; }
  function isDirect() { return hub().mode && hub().mode() === "direct"; }
  function get(path, dflt) {
    const d = path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), S.draft);
    if (d !== undefined) return d;
    const e = path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), effective());
    return e !== undefined ? e : dflt;
  }
  function set(path, value) {
    const ks = path.split("."); let o = S.draft;
    ks.slice(0, -1).forEach((k) => { if (!o[k] || typeof o[k] !== "object") o[k] = {}; o = o[k]; });
    o[ks[ks.length - 1]] = value; S.dirty = true;
  }
  function favs() { if (!S.draft.favorites) S.draft.favorites = JSON.parse(JSON.stringify(effective().favorites || [])); return S.draft.favorites; }
  function leagues() { if (!S.draft.leagues) S.draft.leagues = JSON.parse(JSON.stringify(effective().leagues || [])); return S.draft.leagues; }
  function toast(m) { if (hub().toast) hub().toast(m); }
  async function api(url) { return hub().getJSON(url); }

  // ------------------------------------------------------------------ open / close / save
  async function open() {
    if (S.open) return;
    S.open = true; S.section = 0; S.zone = "nav"; S.row = 0; S.modal = []; S.dirty = false;
    try { S.draft = JSON.parse(JSON.stringify(await api("/api/config/local") || {})); } catch (e) { S.draft = {}; }
    if (S.draft.favorites === undefined) S.draft.favorites = JSON.parse(JSON.stringify(effective().favorites || []));
    $("#settings").classList.remove("hidden");
    render();
    api("/api/health").then((h) => { S.health = h; if (S.open && S.section === 5) render(); }).catch(() => {});
  }
  function close() { S.open = false; $("#settings").classList.add("hidden"); }
  async function saveAndClose() {
    if (!S.dirty) { close(); return; }
    const json = JSON.stringify(S.draft, null, 2);
    try {
      if (isDirect()) {
        if (window.SportsHub && typeof window.SportsHub.writeConfig === "function") window.SportsHub.writeConfig(json);
        else localStorage.setItem("sportshub.config", json);
        close(); toast("Settings saved");
        if (hub().reloadConfig) hub().reloadConfig();
      } else {
        const r = await fetch("/api/config/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
        const res = await r.json();
        if (!r.ok || res.error) throw new Error(res.error || r.status);
        close(); toast("Settings saved, reloading…");
        setTimeout(() => location.reload(), 600);
      }
    } catch (e) { toast("Save failed: " + e.message); }
  }

  // ------------------------------------------------------------------ sections
  const SECTIONS = ["Teams", "Leagues", "Display", "Sounds", "Apps", "About"];

  function rowsFor(section) {
    const rows = [];
    const toggle = (label, path, dflt) => rows.push({ type: "toggle", label, get: () => !!get(path, dflt), set: (v) => set(path, v) });
    const stepper = (label, path, dflt, min, max, step, fmt) => rows.push({ type: "stepper", label, get: () => Number(get(path, dflt)), set: (v) => set(path, v), min, max, step, fmt: fmt || ((v) => String(v)) });
    const choice = (label, path, dflt, options, names) => rows.push({ type: "choice", label, get: () => get(path, dflt), set: (v) => set(path, v), options, names });
    const text = (label, path, dflt) => rows.push({ type: "text", label, get: () => String(get(path, dflt) || ""), set: (v) => set(path, v) });

    if (section === 0) {
      favs().forEach((f, i) => rows.push({ type: "fav", label: favLabel(f), f, i, hint: favHint(f) }));
      rows.push({ type: "action", label: "+ Add a team", run: pickLeagueThenTeam });
      if (!favs().length) rows.push({ type: "note", label: "Favourites get the gold edge, the board takeover, callouts and sounds. Order is priority." });
    } else if (section === 1) {
      const on = leagues();
      LEAGUES.forEach((L) => {
        const idx = on.findIndex((x) => x.key === L.key);
        rows.push({ type: "league", label: L.label, L, on: idx >= 0, idx, hint: idx >= 0 ? "Tab " + (idx + 1) + "  ·  OK to move or turn off" : "OK to turn on" });
      });
    } else if (section === 2) {
      text("Title", "title", "Sports Hub");
      choice("Theme", "theme.preset", "default", THEMES, ["Neutral", "Wyoming", "Bills", "Wyoming + Bills"]);
      choice("Time zone", "timezone", "America/Denver", TIMEZONES, TIMEZONES.map((z) => z.split("/")[1].replace("_", " ")));
      stepper("Broadcast delay", "scoreDelaySeconds", 0, 0, 180, 5, (v) => v + " s");
      stepper("Screen edge margin", "safeAreaRem", 2.5, 1, 6, 0.5, (v) => v.toFixed(1));
      choice("Dock position", "dockPosition", "bottom", ["bottom", "top"], ["Bottom (hidden until needed)", "Top, under the tabs"]);
      toggle("Odds on upcoming games", "showOdds", true);
      stepper("Team logos beside title", "titleLogosMax", 6, 0, 8, 1);
      stepper("Auto board after idle", "gameMode.idleSeconds", 60, 15, 300, 15, (v) => v + " s");
      stepper("Hands-off scroll every", "idleScrollSeconds", 7, 3, 30, 1, (v) => v + " s");
    } else if (section === 3) {
      choice("Score sound", "gameMode.sound", "builtin", ["builtin", "none"], ["Built-in horn", "Off"]);
      stepper("Volume", "gameMode.soundVolume", 0.8, 0, 1, 0.1, (v) => Math.round(v * 100) + "%");
      stepper("Sound length", "gameMode.soundSeconds", 20, 5, 90, 5, (v) => v + " s");
      stepper("Fade out", "gameMode.soundFadeSeconds", 3, 0, 10, 1, (v) => v + " s");
      toggle("Score callouts", "gameMode.callouts", true);
      stepper("Callout delay (extra)", "gameMode.calloutDelaySeconds", 0, 0, 60, 5, (v) => v + " s");
      toggle("Period / halftime cards", "gameMode.periodCallouts", true);
      toggle("Final cards", "gameMode.finalCallouts", true);
      rows.push({ type: "action", label: "▶ Test a callout", run: () => { if (hub().demo) hub().demo(); } });
    } else if (section === 4) {
      const all = get("apps", []);
      toggle("Show every installed app", "_allApps", !Array.isArray(all) || all.length === 0);
      rows[rows.length - 1].set = (v) => { if (v) set("apps", []); else set("apps", (S.apps || []).slice(0, 8)); };
      rows[rows.length - 1].get = () => { const a = get("apps", []); return !Array.isArray(a) || a.length === 0; };
      const chosen = get("apps", []);
      if (Array.isArray(chosen) && chosen.length) {
        chosen.forEach((a, i) => rows.push({ type: "app", label: a.label || a.package, a, i, hint: a.package }));
      }
      rows.push({ type: "action", label: "+ Add an app", run: pickApp });
      if (!S.apps) rows.push({ type: "note", label: isDirect() || (window.SportsHub) ? "Reading installed apps…" : "On a PC browser the installed list is not available; add by package name." });
    } else if (section === 5) {
      rows.push({ type: "note", label: "Mode: " + (isDirect() ? "stick-only (ESPN from the stick)" : "PC-hosted") });
      rows.push({ type: "note", label: "Settings file: " + (isDirect() ? "config.json in the app's files folder" : "config.local.json on the PC") });
      const h = S.health;
      rows.push({ type: "note", label: h ? ("ESPN: " + (Object.keys((h.cache || {}).errors || {}).length ? "errors on " + Object.keys(h.cache.errors).join(", ") : "ok") + "  ·  cache " + (h.cache || {}).fresh + "/" + (h.cache || {}).entries + " fresh") : "ESPN: checking…" });
      rows.push({ type: "action", label: "Reset all settings to defaults", run: () => confirmModal("Reset everything to defaults?", () => { S.draft = {}; S.dirty = true; render(); }) });
      rows.push({ type: "action", label: "Discard changes and close", run: () => { S.dirty = false; close(); } });
    }
    rows.push({ type: "action", label: S.dirty ? "Save and close" : "Close", run: saveAndClose, accent: S.dirty });
    return rows;
  }

  function favLabel(f) {
    const mt = ((hub().myteams && hub().myteams()) || []).find((t) => t.league === f.league && [String(t.abbr || ""), String(t.id || "")].map((x) => x.toLowerCase()).includes(String(f.team).toLowerCase()));
    return (mt ? (mt.name || mt.short) : String(f.team).toUpperCase()) + "  ·  " + (LEAGUES.find((L) => L.key === f.league) || { label: f.league }).label;
  }
  function favHint(f) {
    const bits = [];
    if (f.video) bits.push("clip " + f.video.split("/").pop());
    else if (f.sound) bits.push("sound " + f.sound.split("/").pop());
    return bits.join("  ·  ") || "OK for options";
  }

  // ------------------------------------------------------------------ modals
  function listModal(title, items, pick, opts) { S.modal.push(Object.assign({ type: "list", title, items, pick, sel: 0 }, opts || {})); render(); }
  function confirmModal(title, yes) { listModal(title, [{ label: "Yes", value: true }, { label: "No", value: false }], (v) => { if (v) yes(); }); }
  function keyboardModal(title, value, done) { S.modal.push({ type: "keyboard", title, text: value || "", sel: 0, done }); render(); }

  async function pickLeagueThenTeam() {
    const on = leagues();
    listModal("Which league?", on.map((L) => ({ label: L.label, value: L.key })), async (key) => {
      let data = S.teamsCache[key];
      if (!data) {
        toast("Loading teams…");
        try { data = (await api("/api/teams?league=" + encodeURIComponent(key))).teams; S.teamsCache[key] = data; }
        catch (e) { toast("Couldn't load teams: " + e.message); return; }
      }
      const letters = Array.from(new Set(data.map((t) => (t.name || "?")[0].toUpperCase()))).sort();
      const addTeam = (t) => {
        const team = (t.abbr || t.id || "").toString().toLowerCase();
        if (favs().some((f) => f.league === key && String(f.team).toLowerCase() === team)) { toast("Already a favourite"); return; }
        favs().push({ league: key, team }); S.dirty = true; S.row = favs().length - 1; toast("Added " + (t.name || team));
      };
      if (data.length <= 40) { listModal("Pick a team", data.map((t) => ({ label: t.name, value: t, logo: t.logo })), addTeam); return; }
      listModal("First letter", letters.map((l) => ({ label: l, value: l })), (l) => {
        listModal("Teams · " + l, data.filter((t) => (t.name || "?")[0].toUpperCase() === l).map((t) => ({ label: t.name, value: t, logo: t.logo })), addTeam);
      }, { grid: true });
    });
  }

  function favMenu(row) {
    const f = row.f, i = row.i, list = favs();
    const items = [];
    if (i > 0) items.push({ label: "Move up (higher priority)", value: "up" });
    if (i < list.length - 1) items.push({ label: "Move down", value: "down" });
    items.push({ label: "Sound: " + (f.video ? "clip " + f.video : f.sound ? f.sound : "built-in horn"), value: "sound" });
    items.push({ label: "Remove", value: "remove" });
    listModal(favLabel(f), items, (v) => {
      if (v === "up") { list.splice(i - 1, 0, list.splice(i, 1)[0]); S.row = i - 1; }
      else if (v === "down") { list.splice(i + 1, 0, list.splice(i, 1)[0]); S.row = i + 1; }
      else if (v === "remove") { list.splice(i, 1); S.row = Math.max(0, i - 1); }
      else if (v === "sound") {
        listModal("Sound for " + favLabel(f), [
          { label: "Built-in horn (default)", value: "default" }, { label: "Silent", value: "none" },
          { label: "Audio file: media/<name>…", value: "sound" }, { label: "Video clip: media/<name>…", value: "video" },
        ], (w) => {
          if (w === "default") { delete f.sound; delete f.video; }
          else if (w === "none") { f.sound = "none"; delete f.video; }
          else keyboardModal("File name under media/ (e.g. SABRES.MP4)", (w === "video" ? f.video : f.sound || "").replace(/^media\//, ""), (name) => {
            if (!name) return; const p = "media/" + name.toLowerCase();
            if (w === "video") { f.video = p; delete f.sound; } else { f.sound = p; delete f.video; }
          });
          S.dirty = true;
        });
        return;
      }
      S.dirty = true;
    });
  }

  function leagueMenu(row) {
    const on = leagues();
    if (!row.on) { on.push(JSON.parse(JSON.stringify(row.L))); S.dirty = true; return; }
    const i = row.idx, items = [];
    if (i > 0) items.push({ label: "Move up", value: "up" });
    if (i < on.length - 1) items.push({ label: "Move down", value: "down" });
    items.push({ label: "Turn off", value: "off" });
    listModal(row.L.label, items, (v) => {
      if (v === "up") on.splice(i - 1, 0, on.splice(i, 1)[0]);
      else if (v === "down") on.splice(i + 1, 0, on.splice(i, 1)[0]);
      else if (v === "off") { if (on.length <= 1) { toast("Keep at least one league"); return; } on.splice(i, 1); }
      S.dirty = true;
    });
  }

  function appMenu(row) {
    const list = get("apps", []), i = row.i, items = [];
    if (i > 0) items.push({ label: "Move left", value: "up" });
    if (i < list.length - 1) items.push({ label: "Move right", value: "down" });
    items.push({ label: "Remove from dock", value: "remove" });
    listModal(row.label, items, (v) => {
      const l = list.slice();
      if (v === "up") l.splice(i - 1, 0, l.splice(i, 1)[0]);
      else if (v === "down") l.splice(i + 1, 0, l.splice(i, 1)[0]);
      else l.splice(i, 1);
      set("apps", l);
    });
  }

  function pickApp() {
    const installed = S.apps || [];
    const current = get("apps", []);
    if (installed.length) {
      listModal("Installed apps", installed.filter((a) => !current.some((c) => c.package === a.package)).map((a) => ({ label: a.label, value: a })), (a) => {
        set("apps", current.concat([{ label: a.label, package: a.package }]));
      });
    } else {
      keyboardModal("Package name (e.g. COM.ESPN.SCORE_CENTER)", "", (pkg) => {
        if (!pkg) return; const p = pkg.toLowerCase().replace(/\s+/g, "");
        set("apps", current.concat([{ label: p.split(".").slice(-1)[0], package: p }]));
      });
    }
  }

  // ------------------------------------------------------------------ render
  function render() {
    const root = $("#settings");
    root.innerHTML = "";
    const panel = el("div", "st-panel");
    const nav = el("div", "st-nav");
    nav.appendChild(el("div", "st-title", "Hub Settings"));
    SECTIONS.forEach((name, i) => {
      const b = el("div", "st-nav-item" + (i === S.section ? " active" : "") + (S.zone === "nav" && i === S.section ? " focused" : ""), name);
      nav.appendChild(b);
    });
    nav.appendChild(el("div", "st-hint", "▲▼ move · ◀▶ change · OK open · BACK " + (S.dirty ? "saves" : "closes")));
    panel.appendChild(nav);

    const pane = el("div", "st-pane");
    const rows = rowsFor(S.section);
    if (S.row >= rows.length) S.row = rows.length - 1;
    rows.forEach((r, i) => {
      const row = el("div", "st-row st-" + r.type + (S.zone === "pane" && i === S.row ? " focused" : "") + (r.accent ? " accent" : ""));
      row.appendChild(el("div", "st-label", r.label));
      if (r.hint) row.appendChild(el("div", "st-sub", r.hint));
      let val = "";
      if (r.type === "toggle") val = r.get() ? "On" : "Off";
      else if (r.type === "stepper") val = "◀  " + r.fmt(r.get()) + "  ▶";
      else if (r.type === "choice") { const idx = r.options.indexOf(r.get()); val = "◀  " + (idx >= 0 ? (r.names || r.options)[idx] : String(r.get())) + "  ▶"; }
      else if (r.type === "text") val = r.get() || "—";
      else if (r.type === "league") val = r.on ? "On" : "Off";
      if (val) row.appendChild(el("div", "st-value" + (r.type === "toggle" || r.type === "league" ? (val === "On" ? " on" : " off") : ""), val));
      pane.appendChild(row);
    });
    panel.appendChild(pane);
    root.appendChild(panel);
    const f = pane.querySelector(".focused");
    if (f) f.scrollIntoView({ block: "nearest" });

    // modals
    S.modal.forEach((m, mi) => {
      const top = mi === S.modal.length - 1;
      const ov = el("div", "st-modal" + (top ? "" : " behind"));
      const box = el("div", "st-box" + (m.grid ? " grid" : "") + (m.type === "keyboard" ? " keyboard" : ""));
      box.appendChild(el("div", "st-box-title", m.title));
      if (m.type === "list") {
        const list = el("div", "st-list" + (m.grid ? " grid" : ""));
        m.items.forEach((it, i) => {
          const b = el("div", "st-item" + (i === m.sel ? " focused" : ""));
          if (it.logo) { const img = el("img"); img.src = it.logo; img.alt = ""; img.onerror = () => img.remove(); b.appendChild(img); }
          b.appendChild(el("span", null, it.label));
          list.appendChild(b);
        });
        if (!m.items.length) list.appendChild(el("div", "st-item", "Nothing to pick"));
        box.appendChild(list);
      } else {
        box.appendChild(el("div", "st-text", m.text || " "));
        const kb = el("div", "st-keys");
        KEYS.forEach((k, i) => kb.appendChild(el("div", "st-key" + (i === m.sel ? " focused" : "") + (k === " " ? " space" : ""), k === " " ? "space" : k)));
        box.appendChild(kb);
      }
      ov.appendChild(box); root.appendChild(ov);
      const fi = box.querySelector(".focused"); if (fi && top) fi.scrollIntoView({ block: "nearest" });
    });
  }

  // ------------------------------------------------------------------ keys
  function handleKey(ev) {
    const k = ev.key, code = ev.keyCode;
    const isBack = k === "Escape" || k === "Backspace" || k === "GoBack" || k === "BrowserBack" || code === 27 || code === 461 || code === 10009;
    const ok = k === "Enter" || code === 13 || k === " ";
    if (S.modal.length) { modalKey(S.modal[S.modal.length - 1], k, ok, isBack); render(); return true; }
    const rows = rowsFor(S.section);
    if (S.zone === "nav") {
      if (k === "ArrowUp") S.section = Math.max(0, S.section - 1);
      else if (k === "ArrowDown") S.section = Math.min(SECTIONS.length - 1, S.section + 1);
      else if (k === "ArrowRight" || ok) { S.zone = "pane"; S.row = 0; }
      else if (isBack) { saveAndClose(); return true; }
      if (k === "ArrowUp" || k === "ArrowDown") { S.row = 0; if (S.section === 4 && !S.apps) loadApps(); }
      render(); return true;
    }
    const r = rows[S.row];
    if (k === "ArrowUp") { if (S.row === 0) S.zone = "nav"; else S.row--; }
    else if (k === "ArrowDown") S.row = Math.min(rows.length - 1, S.row + 1);
    else if (k === "ArrowLeft" || k === "ArrowRight") {
      const dir = k === "ArrowRight" ? 1 : -1;
      if (r.type === "stepper") r.set(Math.round(Math.min(r.max, Math.max(r.min, r.get() + dir * r.step)) * 100) / 100);
      else if (r.type === "choice") { const i = r.options.indexOf(r.get()); r.set(r.options[(i + dir + r.options.length) % r.options.length]); }
      else if (r.type === "toggle") r.set(!r.get());
      else if (k === "ArrowLeft") S.zone = "nav";
    }
    else if (ok) {
      if (r.type === "toggle") r.set(!r.get());
      else if (r.type === "action") { r.run(); }
      else if (r.type === "text") keyboardModal(r.label, r.get(), (v) => r.set(v));
      else if (r.type === "fav") favMenu(r);
      else if (r.type === "league") leagueMenu(r);
      else if (r.type === "app") appMenu(r);
      else if (r.type === "choice") { const i = r.options.indexOf(r.get()); r.set(r.options[(i + 1) % r.options.length]); }
    }
    else if (isBack) S.zone = "nav";
    if (S.open) render();
    return true;
  }

  function modalKey(m, k, ok, isBack) {
    if (m.type === "list") {
      const cols = m.grid ? 6 : 1, n = m.items.length;
      if (k === "ArrowDown") m.sel = Math.min(n - 1, m.sel + cols);
      else if (k === "ArrowUp") m.sel = Math.max(0, m.sel - cols);
      else if (k === "ArrowRight") m.sel = Math.min(n - 1, m.sel + 1);
      else if (k === "ArrowLeft") m.sel = Math.max(0, m.sel - 1);
      else if (ok) { const it = m.items[m.sel]; S.modal.pop(); if (it) m.pick(it.value); }
      else if (isBack) S.modal.pop();
      return;
    }
    // keyboard (a physical keyboard on a laptop types directly; space types a space)
    const cols = 10, n = KEYS.length;
    if (k === " ") { if (m.text.length < 40) m.text += " "; return; }
    if (k === "ArrowDown") m.sel = Math.min(n - 1, m.sel + cols);
    else if (k === "ArrowUp") m.sel = Math.max(0, m.sel - cols);
    else if (k === "ArrowRight") m.sel = Math.min(n - 1, m.sel + 1);
    else if (k === "ArrowLeft") m.sel = Math.max(0, m.sel - 1);
    else if (ok) {
      const key = KEYS[m.sel];
      if (key === "⌫") m.text = m.text.slice(0, -1);
      else if (key === "✓") { S.modal.pop(); m.done(m.text.trim()); }
      else if (m.text.length < 40) m.text += key;
    }
    else if (isBack) { S.modal.pop(); m.done(m.text.trim()); }
    else if (k && k.length === 1) { if (m.text.length < 40) m.text += k.toUpperCase(); } // physical keyboard on a laptop
  }

  function loadApps() {
    try {
      if (window.SportsHub && typeof window.SportsHub.apps === "function") S.apps = JSON.parse(window.SportsHub.apps()) || [];
    } catch (e) { S.apps = []; }
  }

  window.SportsHubSettings = { open, close, isOpen: () => S.open, handleKey, _state: S };
})();
