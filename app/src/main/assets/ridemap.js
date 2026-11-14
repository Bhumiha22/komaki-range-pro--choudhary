/* In-app map, destination search, route planning and GPS ride recording.
   - Rides still start from scooter power use (index.html). GPS keeps a ride alive while you are moving, so coasting or
     regen braking on a downhill no longer ends the ride (see window.gpsMoving, used by autoPower in index.html).
   - Vector map: MapLibre GL + OpenStreetMap data (CARTO styles) and Esri imagery for satellite. Falls back to a flat canvas map. */
(function () {
  "use strict";
  const cv = document.getElementById("gmap");
  if (!cv || typeof R === "undefined" || typeof S === "undefined") return;
  const ctx = cv.getContext("2d");
  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- map sources ---------- */
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const STY = {
    dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    light: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    sat: { version: 8, sources: { sat: { type: "raster", tiles: [ESRI], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" } }, layers: [{ id: "sat", type: "raster", source: "sat" }] }
  };
  const RAST = {
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
    light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
    sat: ESRI
  };
  const CREDIT = { dark: "© OpenStreetMap contributors © CARTO", light: "© OpenStreetMap contributors © CARTO", sat: "Imagery © Esri, Maxar, Earthstar Geographics" };
  const isLight = () => document.body.classList.contains("light");
  const kind = () => M.sat ? "sat" : isLight() ? "light" : "dark";

  const last0 = LS.get("lastPos", null);
  const M = { z: last0 ? 16 : 3.9, lat: last0 ? last0[0] : 22.5, lon: last0 ? last0[1] : 79, follow: true, pos: last0, view: null,
    hd: 0, sat: !!LS.get("mapSat", false), dest: null, from: null, nav: null, navInfo: null, needRoute: false };
  const T = { watch: null, pts: [], km: 0, vmax: 0, sp: 0, lastT: 0, fixT: 0, hist: [] };
  let GL = null, glReady = false, glEver = false, glTried = false, curKind = "", posEl = null, posMk = null, destEl = null, destMk = null, fromEl = null, fromMk = null, routing = false;
  const accent = () => getComputedStyle(document.body).getPropertyValue("--ac").trim() || "#3aa0ff";
  const visible = () => el("s-gps").classList.contains("a");
  const NAVC = "#ffb02e";

  /* ---------- projection ---------- */
  const W = z => 256 * Math.pow(2, z);
  const px = (lon, z) => (lon + 180) / 360 * W(z);
  const py = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W(z); };
  const lonOf = (x, z) => x / W(z) * 360 - 180;
  const latOf = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / W(z)))) * 180 / Math.PI;
  const hav = (a, b) => {
    const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  };

  /* ---------- flat canvas map (fallback) ---------- */
  const cache = new Map();
  let queued = false;
  const csched = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); };
  const sched = () => { if (GL) glSync(); else csched(); };
  function tile(k, z, x, y) {
    const key = k + z + "/" + x + "/" + y; let i = cache.get(key);
    if (!i) {
      i = new Image(); i.onload = csched;
      i.src = RAST[k].replace("{s}", "abcd"[(x + y) % 4]).replace("{z}", z).replace("{x}", x).replace("{y}", y);
      cache.set(key, i); if (cache.size > 260) cache.delete(cache.keys().next().value);
    }
    return i;
  }
  function path(pts, z, ox, oy) {
    ctx.beginPath(); pts.forEach((p, i) => { const x = px(p[1], z) - ox, y = py(p[0], z) - oy; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  }
  function draw() {
    const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = kind();
    ctx.fillStyle = k === "light" ? "#e8ecf1" : "#0a0c0f"; ctx.fillRect(0, 0, w, h);
    const z = Math.round(M.z), n = 2 ** z, ox = px(M.lon, z) - w / 2, oy = py(M.lat, z) - h / 2;
    for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + h) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + w) / 256); tx++) {
        const i = tile(k, z, ((tx % n) + n) % n, ty);
        if (i.complete && i.naturalWidth) ctx.drawImage(i, tx * 256 - ox, ty * 256 - oy, 256, 256);
      }
    }
    const ac = accent();
    ctx.lineJoin = ctx.lineCap = "round";
    if (M.nav && M.nav.length > 1) {
      path(M.nav, z, ox, oy); ctx.setLineDash([2, 10]); ctx.strokeStyle = NAVC; ctx.lineWidth = 5; ctx.stroke(); ctx.setLineDash([]);
    }
    const pts = M.view || (R.on ? T.pts : []);
    if (pts.length > 1) {
      path(pts, z, ox, oy);
      ctx.strokeStyle = ac; ctx.shadowColor = ac; ctx.shadowBlur = 12; ctx.lineWidth = 5; ctx.stroke();
      ctx.shadowBlur = 0; ctx.strokeStyle = "#ffffffcc"; ctx.lineWidth = 1.5; ctx.stroke();
      if (M.view) [[pts[0], "#2fe06b"], [pts[pts.length - 1], "#ff5a5a"]].forEach(([p, c]) => {
        const x = px(p[1], z) - ox, y = py(p[0], z) - oy;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#000"; ctx.stroke();
      });
    }
    if (M.dest) {
      const x = px(M.dest.lon, z) - ox, y = py(M.dest.lat, z) - oy;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fillStyle = "#ff5a5a"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
    if (M.from) {
      const x = px(M.from.lon, z) - ox, y = py(M.from.lat, z) - oy;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.fillStyle = "#2fe06b"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
    if (M.pos && !M.view) {
      const x = px(M.pos[1], z) - ox, y = py(M.pos[0], z) - oy, pulse = 14 + 5 * Math.sin(Date.now() / 400);
      ctx.beginPath(); ctx.arc(x, y, pulse, 0, 7); ctx.fillStyle = ac + "33"; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fillStyle = ac; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
    ctx.fillStyle = k === "light" ? "#00000099" : "#ffffff80"; ctx.font = "9px Roboto, sans-serif"; ctx.textAlign = "left";
    ctx.fillText(CREDIT[k], 10, h - 8);
  }

  /* ---------- vector map (MapLibre) ---------- */
  const emptyFC = () => ({ type: "FeatureCollection", features: [] });
  function initGL() {
    glTried = true;
    if (typeof maplibregl === "undefined") return;
    try {
      curKind = kind();
      GL = new maplibregl.Map({ container: "mlmap", style: STY[curKind], center: [M.lon, M.lat], zoom: M.z, attributionControl: false, fadeDuration: 0, maxPitch: 70 });
      GL.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    } catch (e) { GL = null; return; }
    el("mapcard").classList.add("gl");
    GL.on("style.load", () => { glReady = true; glEver = true; glLayers(); glSync(); });
    GL.on("error", () => { if (!glEver) glFallback(); });
    GL.on("dragstart", () => { M.follow = false; });
    GL.on("zoom", () => { M.z = GL.getZoom(); });
    setTimeout(() => { if (!glEver) glFallback(); }, 12000);
  }
  function glFallback() {
    if (!GL) return;
    try { GL.remove(); } catch (e) {}
    GL = null; glReady = false; el("mapcard").classList.remove("gl"); csched();
  }
  function glLayers() {
    const c = accent(), rnd = { "line-cap": "round", "line-join": "round" };
    try {
      GL.addSource("nav", { type: "geojson", data: emptyFC() });
      GL.addLayer({ id: "nav-case", type: "line", source: "nav", layout: rnd, paint: { "line-color": "#000000", "line-opacity": 0.35, "line-width": 9 } });
      GL.addLayer({ id: "nav", type: "line", source: "nav", layout: rnd, paint: { "line-color": NAVC, "line-width": 5, "line-dasharray": [0.4, 1.6] } });
      GL.addSource("route", { type: "geojson", data: emptyFC() });
      GL.addLayer({ id: "route-glow", type: "line", source: "route", layout: rnd, paint: { "line-color": c, "line-width": 12, "line-blur": 9, "line-opacity": 0.75 } });
      GL.addLayer({ id: "route-main", type: "line", source: "route", layout: rnd, paint: { "line-color": c, "line-width": 4.5 } });
      GL.addLayer({ id: "route-core", type: "line", source: "route", layout: rnd, paint: { "line-color": "#ffffff", "line-width": 1.4, "line-opacity": 0.85 } });
      GL.addSource("ends", { type: "geojson", data: emptyFC() });
      GL.addLayer({ id: "ends", type: "circle", source: "ends", paint: { "circle-radius": 6.5, "circle-color": ["get", "c"], "circle-stroke-width": 2, "circle-stroke-color": "#000000" } });
    } catch (e) {}
    if (!posEl) {
      posEl = document.createElement("div"); posEl.className = "posdot"; posMk = new maplibregl.Marker({ element: posEl });
      destEl = document.createElement("div"); destEl.className = "destpin"; destMk = new maplibregl.Marker({ element: destEl });
      fromEl = document.createElement("div"); fromEl.className = "frompin"; fromMk = new maplibregl.Marker({ element: fromEl });
    }
  }
  function glSync() {
    if (!GL || !glReady || !visible()) return;
    const c = accent(), pts = M.view || (R.on ? T.pts : []), ll = pts.map(q => [q[1], q[0]]);
    ["route-glow", "route-main"].forEach(id => GL.setPaintProperty(id, "line-color", c));
    const line = a => a.length > 1 ? { type: "Feature", geometry: { type: "LineString", coordinates: a } } : emptyFC();
    GL.getSource("route").setData(line(ll));
    GL.getSource("nav").setData(line((M.nav || []).map(q => [q[1], q[0]])));
    GL.getSource("ends").setData(M.view && ll.length > 1 ? { type: "FeatureCollection", features: [
      { type: "Feature", properties: { c: "#2fe06b" }, geometry: { type: "Point", coordinates: ll[0] } },
      { type: "Feature", properties: { c: "#ff5a5a" }, geometry: { type: "Point", coordinates: ll[ll.length - 1] } }] } : emptyFC());
    if (M.pos && !M.view) { posMk.setLngLat([M.pos[1], M.pos[0]]); if (!posEl.isConnected) posMk.addTo(GL); }
    else if (posEl.isConnected) posMk.remove();
    if (M.dest) { destMk.setLngLat([M.dest.lon, M.dest.lat]); if (!destEl.isConnected) destMk.addTo(GL); }
    else if (destEl.isConnected) destMk.remove();
    if (M.from) { fromMk.setLngLat([M.from.lon, M.from.lat]); if (!fromEl.isConnected) fromMk.addTo(GL); }
    else if (fromEl.isConnected) fromMk.remove();
    if (M.follow && !M.view && M.pos) {
      const o = { center: [M.pos[1], M.pos[0]], duration: 900, essential: true };
      if (R.on) { o.zoom = Math.max(GL.getZoom(), 16.5); o.pitch = 50; o.bearing = M.hd; }
      GL.easeTo(o);
    }
  }
  // map look follows the app theme and the satellite switch
  function applyKind() {
    const k = kind();
    if (GL && glEver) { if (k !== curKind) { curKind = k; glReady = false; GL.setStyle(STY[k]); } }
    else csched();
  }
  window.addEventListener("themechange", applyKind);

  /* ---------- view control ---------- */
  function center(lat, lon) {
    M.lat = lat; M.lon = lon;
    if (GL) { if (glReady) GL.easeTo({ center: [lon, lat], duration: 400 }); } else csched();
  }
  function fit(pts) {
    if (!pts || pts.length < 2) return;
    if (GL) {
      if (!glReady) return;
      const b = new maplibregl.LngLatBounds(); pts.forEach(q => b.extend([q[1], q[0]]));
      GL.fitBounds(b, { padding: { top: 90, bottom: 60, left: 50, right: 70 }, pitch: 0, bearing: 0, duration: 700, maxZoom: 17 }); return;
    }
    const w = cv.clientWidth - 70, h = cv.clientHeight - 150; if (w <= 0) return;
    let a = 90, b = -90, c = 180, d = -180;
    pts.forEach(p => { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); });
    let z = 18;
    while (z > 3 && (Math.abs(px(d, z) - px(c, z)) > w || Math.abs(py(a, z) - py(b, z)) > h)) z--;
    M.z = z; center((a + b) / 2, (c + d) / 2);
  }
  function live() {
    M.view = null; M.follow = true;
    if (GL && glReady && M.pos) GL.easeTo({ center: [M.pos[1], M.pos[0]], zoom: Math.max(GL.getZoom(), 16), pitch: R.on ? 50 : 0, bearing: R.on ? M.hd : 0, duration: 700 });
    else if (M.pos) { M.z = Math.max(M.z, 16); center(M.pos[0], M.pos[1]); }
    sched(); setMsg(); renderList();
  }
  const zoom = d => { if (GL) { if (glReady) d > 0 ? GL.zoomIn() : GL.zoomOut(); return; } M.z = Math.max(3, Math.min(19, M.z + d)); csched(); };
  el("m-in").onclick = () => zoom(1); el("m-out").onclick = () => zoom(-1); el("m-loc").onclick = live;
  el("m-sat").classList.toggle("on", M.sat);
  el("m-sat").onclick = () => { M.sat = !M.sat; LS.set("mapSat", M.sat); el("m-sat").classList.toggle("on", M.sat); applyKind(); };

  // canvas fallback: drag to pan, two fingers to zoom (MapLibre handles its own gestures)
  const ptr = new Map(); let pinch0 = 0;
  cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId); ptr.set(e.pointerId, e); pinch0 = 0; });
  cv.addEventListener("pointermove", e => {
    const o = ptr.get(e.pointerId); if (!o) return;
    if (ptr.size === 1) {
      const x = px(M.lon, M.z) - (e.clientX - o.clientX), y = py(M.lat, M.z) - (e.clientY - o.clientY);
      M.follow = false; M.lon = lonOf(x, M.z); M.lat = Math.max(-80, Math.min(80, latOf(y, M.z))); csched();
    } else if (ptr.size === 2) {
      ptr.set(e.pointerId, e); const [a, b] = [...ptr.values()], dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!pinch0) pinch0 = dist; else if (dist / pinch0 > 1.5) { zoom(1); pinch0 = dist; } else if (dist / pinch0 < 0.67) { zoom(-1); pinch0 = dist; }
      return;
    }
    ptr.set(e.pointerId, e);
  });
  const up = e => { ptr.delete(e.pointerId); pinch0 = 0; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);

  /* ---------- from / to search and route (India first) ---------- */
  const q = el("m-q"), qf = el("m-from"), res = el("m-res"), xb = el("m-x");
  const INDIA = "68.1,6.7,97.4,35.7"; // west, south, east, north
  let timer = 0, ctl = null, found = [], active = "to";
  const fmtT = m => m >= 60 ? Math.floor(m / 60) + " h " + Math.round(m % 60) + " min" : Math.max(1, Math.round(m)) + " min";
  const note = t => { res.innerHTML = '<div class="note" style="padding:12px 14px">' + t + "</div>"; res.hidden = false; };
  const near = () => M.pos ? "&lat=" + M.pos[0] + "&lon=" + M.pos[1] : "";

  function fromPhoton(j) {
    return (j.features || []).map(f => {
      const p = f.properties || {};
      return { name: p.name || p.street || p.city || "Place", lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        sub: [p.name && p.street ? p.street : null, p.district, p.city || p.county, p.state].filter(Boolean).join(", ") };
    });
  }
  function fromNominatim(a) {
    return (a || []).map(r => {
      const parts = String(r.display_name || "").split(", ");
      return { name: r.name || parts[0] || "Place", lat: parseFloat(r.lat), lon: parseFloat(r.lon), sub: parts.slice(1, 4).join(", ") };
    });
  }
  async function getJSON(u, signal) { const r = await fetch(u, { signal }); return r.json(); }
  async function search(v, deep) {
    if (ctl) ctl.abort(); ctl = new AbortController();
    const sg = ctl.signal;
    const jobs = [getJSON("https://photon.komoot.io/api/?q=" + encodeURIComponent(v) + "&limit=6&lang=en&bbox=" + INDIA + near(), sg).then(fromPhoton)];
    // pressing Enter also asks Nominatim, which knows more small localities in India
    if (deep) jobs.push(getJSON("https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=in&limit=6&q=" + encodeURIComponent(v), sg).then(fromNominatim));
    try {
      const all = (await Promise.allSettled(jobs)).flatMap(r => r.status === "fulfilled" ? r.value : []);
      if (sg.aborted) return;
      const seen = new Set(); found = all.filter(x => { const k = x.lat.toFixed(3) + "," + x.lon.toFixed(3); if (seen.has(k) || isNaN(x.lat)) return false; seen.add(k); return true; });
      if (!found.length) { note(jobs.length && all.length === 0 ? "No places found in India. Try a landmark, area or city name." : "No places found."); return; }
      showResults();
    } catch (e) { if (e.name !== "AbortError") note("Search needs internet. Check your connection and try again."); }
  }
  function showResults() {
    const mine = active === "from" ? '<button data-i="-1"><b>My location</b><small>Use GPS as the start</small></button>' : "";
    res.innerHTML = mine + found.map((f, i) => `<button data-i="${i}"><b>${esc(f.name)}</b><small>${esc(f.sub)}</small></button>`).join("");
    res.hidden = false;
    res.querySelectorAll("button").forEach(b => b.onclick = () => choose(+b.dataset.i));
  }
  function choose(i) {
    res.hidden = true; document.activeElement && document.activeElement.blur();
    if (active === "from") {
      M.from = i < 0 ? null : found[i]; qf.value = M.from ? M.from.name : "";
    } else {
      M.dest = found[i]; q.value = M.dest.name; xb.hidden = false;
    }
    M.nav = null; M.navInfo = null; M.follow = false; M.view = null; renderDest();
    if (M.dest) routeTo(); else sched();
  }
  function bind(inp, which) {
    inp.addEventListener("focus", () => { active = which; if (which === "from" && !inp.value.trim()) { found = []; showResults(); } });
    inp.addEventListener("input", () => {
      active = which; if (which === "to") xb.hidden = !inp.value;
      clearTimeout(timer); const v = inp.value.trim();
      if (v.length < 3) { if (which === "from") { found = []; showResults(); } else res.hidden = true; return; }
      timer = setTimeout(() => search(v, false), 450);
    });
  }
  bind(q, "to"); bind(qf, "from");
  el("m-form").addEventListener("submit", e => {
    e.preventDefault(); clearTimeout(timer);
    const inp = active === "from" ? qf : q, v = inp.value.trim();
    if (v.length >= 2) search(v, true); inp.blur();
  });
  xb.onclick = () => { q.value = ""; xb.hidden = true; res.hidden = true; clearDest(); };
  el("m-swap").onclick = () => {
    const here = M.pos ? { name: "My location", lat: M.pos[0], lon: M.pos[1] } : null;
    const a = M.from || here, b = M.dest; if (!b && !M.from) return;
    M.dest = a; M.from = b && b.name === "My location" ? null : b;
    q.value = M.dest ? M.dest.name : ""; qf.value = M.from ? M.from.name : ""; xb.hidden = !q.value;
    M.nav = null; M.navInfo = null; renderDest(); if (M.dest) routeTo(); else sched();
  };
  function clearDest() { M.dest = null; M.nav = null; M.navInfo = null; M.needRoute = false; renderDest(); sched(); }
  const startPt = () => M.from ? [M.from.lat, M.from.lon] : M.pos;
  async function routeTo() {
    const d = M.dest, st = startPt(); if (!d || routing) return;
    if (!st) { M.needRoute = true; center(d.lat, d.lon); M.z = 13; oneShot(); renderDest(); return; }
    M.needRoute = false; routing = true; renderDest();
    try {
      const u = `https://router.project-osrm.org/route/v1/driving/${st[1]},${st[0]};${d.lon},${d.lat}?overview=full&geometries=geojson`;
      const j = await (await fetch(u)).json();
      if (j.code !== "Ok" || !j.routes.length) throw new Error("no route");
      const r = j.routes[0];
      M.nav = r.geometry.coordinates.map(c => [c[1], c[0]]); M.navInfo = { km: r.distance / 1000, min: r.duration / 60 };
    } catch (e) { M.nav = null; M.navInfo = { err: true }; }
    routing = false; renderDest(); sched();
    if (M.nav) fit(M.nav);
  }
  function renderDest() {
    const box = el("m-dest"); box.hidden = !M.dest; if (!M.dest) return;
    const i = M.navInfo;
    const meta = i && i.err ? "Could not plan a route. Check your internet." : i ? `${i.km.toFixed(1)} km · about ${fmtT(i.min)} by road` :
      M.needRoute ? "Waiting for GPS to plan the route…" : "Planning route…";
    box.innerHTML = `<div class="dd"><b>${esc((M.from ? M.from.name : "My location") + " → " + M.dest.name)}</b><span class="meta">${esc(meta)}</span></div>` +
      `<button class="mini" id="d-re">Update</button><button class="mini" id="d-x">Clear</button>`;
    el("d-re").onclick = () => { M.nav = null; M.navInfo = null; routing = false; renderDest(); routeTo(); };
    el("d-x").onclick = () => { q.value = ""; qf.value = ""; M.from = null; xb.hidden = true; clearDest(); };
  }

  /* ---------- text ---------- */
  function setMsg(t) {
    const m = el("m-msg"); m.textContent = t || (R.on ? "Recording your route" : M.pos ? "GPS ready" : "Waiting for GPS…");
    m.classList.toggle("on", !!R.on);
  }
  const card = (k, v, u) => `<div><div class="k">${k}</div><div class="v">${v == null ? '<span class="na">N/A</span>' : v + " <small>" + u + "</small>"}</div></div>`;
  function stats() {
    const sec = R.on ? (Date.now() - R.t0) / 1000 : 0, avg = R.on && sec > 15 ? T.km / (sec / 3600) : 0;
    el("m-spd").textContent = R.on && T.sp >= 1 ? Math.round(T.sp) : 0;
    el("m-grid").innerHTML = card("Distance", R.on ? T.km.toFixed(2) : null, "km") + card("Average", avg ? avg.toFixed(1) : null, "km/h") +
      card("Top speed", R.on && T.vmax ? Math.round(T.vmax) : null, "km/h");
    if (R.on && M.pos) sched();
  }

  /* ---------- GPS ---------- */
  function onPos(p) {
    const c = p.coords, ll = [c.latitude, c.longitude];
    if (c.accuracy > 50) { setMsg("GPS weak: ±" + Math.round(c.accuracy) + " m"); return; }
    M.pos = ll; LS.set("lastPos", ll); T.fixT = Date.now();
    let v = c.speed != null && !isNaN(c.speed) ? c.speed * 3.6 : null;
    T.hist.push({ t: T.fixT, ll }); while (T.hist.length && T.fixT - T.hist[0].t > 45000) T.hist.shift();
    if (R.on) {
      const lp = T.pts[T.pts.length - 1];
      if (!lp) { T.pts.push(ll); T.lastT = p.timestamp; }
      else {
        const d = hav(lp, ll), dt = Math.max(1, (p.timestamp - T.lastT) / 1000);
        if (d >= 6 && d / dt < 50) { T.pts.push(ll); T.km += d / 1000; if (v == null) v = d / dt * 3.6; T.lastT = p.timestamp; }
      }
      if (v != null && v < 140 && v > T.vmax) T.vmax = v;
    }
    T.sp = v != null && v >= 1 ? v : 0;
    if (c.heading != null && !isNaN(c.heading) && (c.speed || 0) > 1.5) { // smooth heading, shortest turn
      const dlt = ((c.heading - M.hd + 540) % 360) - 180; M.hd = (M.hd + dlt * 0.35 + 360) % 360;
    }
    if (M.needRoute && M.dest) routeTo();
    if (GL) sched(); else if (M.follow && !M.view) center(ll[0], ll[1]); else csched();
    setMsg(R.on ? "Recording your route · GPS ±" + Math.round(c.accuracy) + " m" : null);
  }
  function onErr(e) { setMsg(e.code === 1 ? "Location is off for this app. Allow it in Settings." : "Searching for GPS…"); }
  const geo = () => navigator.geolocation;
  const GO = { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 };
  function oneShot() { if (geo()) geo().getCurrentPosition(onPos, onErr, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }); }

  // True while the scooter is really moving (speed, or position change in the last 45 s). Used so that coasting or
  // regen braking downhill (no power drawn, or current flowing back into the battery) does not end the ride.
  window.gpsMoving = function () {
    if (!R.on || Date.now() - T.fixT > 30000) return false;
    if (T.sp >= 7) return true;
    const h = T.hist; return h.length > 1 && hav(h[0].ll, h[h.length - 1].ll) >= 40;
  };

  /* ---------- hook the existing ride start / stop ---------- */
  const startOrig = window.rideStart, stopOrig = window.rideStop;
  window.rideStart = function (auto, t0) {
    const was = R.on; startOrig(auto, t0);
    if (!was && R.on) {
      Object.assign(T, { pts: [], km: 0, vmax: 0, sp: 0, lastT: 0, hist: [] }); M.view = null;
      if (!M.dest) { M.follow = true; if (M.pos) { M.z = 17; center(M.pos[0], M.pos[1]); } }
      if (geo() && T.watch == null) T.watch = geo().watchPosition(onPos, onErr, GO);
      setMsg();
    }
  };
  window.rideStop = function (end) {
    const was = R.on, n = S.rides.length; stopOrig(end);
    if (!was) return;
    if (T.watch != null) { geo().clearWatch(T.watch); T.watch = null; }
    if (S.rides.length > n) {
      const r = S.rides[S.rides.length - 1];
      r.km = Math.round(T.km * 100) / 100; r.vmax = Math.round(T.vmax); r.route = thin(T.pts);
      S.rides.forEach((x, i) => { if (i < S.rides.length - 60) delete x.route; }); // keep routes for the latest 60 rides
      LS.set("rides", S.rides);
    }
    T.sp = 0; setMsg(); stats(); renderList(); sched();
    if (GL && glReady) GL.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  };
  function thin(a, max = 700) {
    const r = q => [+q[0].toFixed(5), +q[1].toFixed(5)];
    if (a.length <= max) return a.map(r);
    const s = a.length / max, o = []; for (let i = 0; i < max; i++) o.push(r(a[Math.floor(i * s)])); o.push(r(a[a.length - 1])); return o;
  }

  /* ---------- saved rides ---------- */
  function renderList() {
    const list = S.rides.map((r, i) => ({ r, i })).filter(x => x.r.route && x.r.route.length > 1).reverse().slice(0, 15);
    el("m-list").innerHTML = list.length ? list.map(({ r, i }) => {
      const d = new Date(r.t), min = Math.max(1, Math.round((r.dur || 0) / 60)), avg = r.km && r.dur ? (r.km / (r.dur / 3600)).toFixed(0) : "–";
      return `<button class="ride" data-i="${i}"><span><b>${(r.km || 0).toFixed(1)} km</b><small>${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></span>` +
        `<span class="rr">${min} min · ${avg} km/h avg${r.mode ? " · " + esc(r.mode) : ""}</span></button>`;
    }).join("") : '<div class="note">Your rides with a route appear here. Tap one to see it on the map.</div>';
    el("m-list").querySelectorAll(".ride").forEach(b => b.onclick = () => {
      const r = S.rides[+b.dataset.i]; M.view = r.route; M.follow = false; fit(r.route); sched();
      setMsg("Saved ride. Tap the target button to go back to live."); el("mapcard").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ---------- lifecycle ---------- */
  let shown = false;
  setInterval(() => {
    const vis = visible();
    if (vis && !shown) {
      shown = true; if (!glTried) initGL(); if (GL && glReady) GL.resize();
      draw(); setMsg(); renderList(); renderDest(); if (GL) sched(); if (T.watch == null) oneShot();
    }
    if (!vis) shown = false;
    if (vis) stats();
  }, 1000);
  addEventListener("resize", () => { if (GL && glReady) GL.resize(); sched(); });
  setMsg(); stats(); renderList();
})();
