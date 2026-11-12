/* In-app map + GPS ride recording.
   Rides still start and stop from scooter power use (existing logic). This file hooks rideStart/rideStop to
   record the GPS route, distance and speed, and saves them with the ride. Map tiles: OpenStreetMap data, CARTO dark style. */
(function () {
  "use strict";
  const cv = document.getElementById("gmap");
  if (!cv || typeof R === "undefined" || typeof S === "undefined") return;
  const ctx = cv.getContext("2d");
  const el = id => document.getElementById(id);
  const TILE = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png";
  const last0 = LS.get("lastPos", null);
  const M = { z: last0 ? 16 : 4, lat: last0 ? last0[0] : 20.59, lon: last0 ? last0[1] : 78.96, follow: true, pos: last0, view: null };
  const T = { watch: null, pts: [], km: 0, vmax: 0, sp: 0, lastT: 0 };
  M.hd = 0;
  // Vector map (MapLibre GL, OpenStreetMap data, CARTO Dark Matter style). Falls back to the flat canvas map below
  // if the library file is missing or the style cannot load (for example no internet).
  const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
  let GL = null, glReady = false, glTried = false, posEl = null, posMk = null;
  const accent = () => getComputedStyle(document.body).getPropertyValue("--ac").trim() || "#3aa0ff";
  const visible = () => el("s-gps").classList.contains("a");

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

  /* ---------- tiles ---------- */
  const cache = new Map();
  let queued = false;
  const csched = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); };
  const sched = () => { if (GL) glSync(); else csched(); };
  function tile(z, x, y) {
    const k = z + "/" + x + "/" + y; let i = cache.get(k);
    if (!i) {
      i = new Image(); i.onload = csched;
      i.src = TILE.replace("{s}", "abcd"[(x + y) % 4]).replace("{z}", z).replace("{x}", x).replace("{y}", y);
      cache.set(k, i); if (cache.size > 260) cache.delete(cache.keys().next().value);
    }
    return i;
  }

  /* ---------- drawing ---------- */
  function draw() {
    const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a0c0f"; ctx.fillRect(0, 0, w, h);
    const z = M.z, n = 2 ** z, ox = px(M.lon, z) - w / 2, oy = py(M.lat, z) - h / 2;
    for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + h) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + w) / 256); tx++) {
        const i = tile(z, ((tx % n) + n) % n, ty);
        if (i.complete && i.naturalWidth) ctx.drawImage(i, tx * 256 - ox, ty * 256 - oy, 256, 256);
      }
    }
    const ac = accent();
    const pts = M.view || (R.on ? T.pts : []);
    if (pts.length > 1) {
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      pts.forEach((p, i) => { const x = px(p[1], z) - ox, y = py(p[0], z) - oy; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = ac; ctx.shadowColor = ac; ctx.shadowBlur = 12; ctx.lineWidth = 5; ctx.stroke();
      ctx.shadowBlur = 0; ctx.strokeStyle = "#ffffffcc"; ctx.lineWidth = 1.5; ctx.stroke();
      if (M.view) { // start and end markers for a saved ride
        [[pts[0], "#2fe06b"], [pts[pts.length - 1], "#ff5a5a"]].forEach(([p, c]) => {
          const x = px(p[1], z) - ox, y = py(p[0], z) - oy;
          ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#000"; ctx.stroke();
        });
      }
    }
    if (M.pos && !M.view) {
      const x = px(M.pos[1], z) - ox, y = py(M.pos[0], z) - oy, pulse = 14 + 5 * Math.sin(Date.now() / 400);
      ctx.beginPath(); ctx.arc(x, y, pulse, 0, 7); ctx.fillStyle = ac + "33"; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fillStyle = ac; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
    ctx.fillStyle = "#ffffff80"; ctx.font = "9px Roboto, sans-serif"; ctx.textAlign = "left";
    ctx.fillText("© OpenStreetMap contributors © CARTO", 10, h - 8);
  }


  /* ---------- vector map (MapLibre) ---------- */
  function initGL() {
    glTried = true;
    if (typeof maplibregl === "undefined") return;
    try {
      GL = new maplibregl.Map({ container: "mlmap", style: STYLE, center: [M.lon, M.lat], zoom: M.z, attributionControl: false, fadeDuration: 0, maxPitch: 70 });
      GL.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    } catch (e) { GL = null; return; }
    el("mapcard").classList.add("gl");
    GL.on("load", () => { glReady = true; glLayers(); glSync(); });
    GL.on("error", () => { if (!glReady) glFallback(); });
    GL.on("dragstart", () => { M.follow = false; });
    GL.on("zoom", () => { M.z = GL.getZoom(); });
    setTimeout(() => { if (!glReady) glFallback(); }, 12000);
  }
  function glFallback() {
    if (!GL) return;
    try { GL.remove(); } catch (e) {}
    GL = null; glReady = false; el("mapcard").classList.remove("gl"); csched();
  }
  const emptyFC = () => ({ type: "FeatureCollection", features: [] });
  function glLayers() {
    const c = accent(), line = { "line-cap": "round", "line-join": "round" };
    GL.addSource("route", { type: "geojson", data: emptyFC() });
    GL.addLayer({ id: "route-glow", type: "line", source: "route", layout: line, paint: { "line-color": c, "line-width": 12, "line-blur": 9, "line-opacity": 0.75 } });
    GL.addLayer({ id: "route-main", type: "line", source: "route", layout: line, paint: { "line-color": c, "line-width": 4.5 } });
    GL.addLayer({ id: "route-core", type: "line", source: "route", layout: line, paint: { "line-color": "#ffffff", "line-width": 1.4, "line-opacity": 0.85 } });
    GL.addSource("ends", { type: "geojson", data: emptyFC() });
    GL.addLayer({ id: "ends", type: "circle", source: "ends", paint: { "circle-radius": 6.5, "circle-color": ["get", "c"], "circle-stroke-width": 2, "circle-stroke-color": "#000000" } });
    posEl = document.createElement("div"); posEl.className = "posdot";
    posMk = new maplibregl.Marker({ element: posEl });
  }
  function glSync() {
    if (!GL || !glReady || !visible()) return;
    const c = accent(), pts = M.view || (R.on ? T.pts : []), ll = pts.map(q => [q[1], q[0]]);
    ["route-glow", "route-main"].forEach(id => GL.setPaintProperty(id, "line-color", c));
    GL.getSource("route").setData(ll.length > 1 ? { type: "Feature", geometry: { type: "LineString", coordinates: ll } } : emptyFC());
    GL.getSource("ends").setData(M.view && ll.length > 1 ? { type: "FeatureCollection", features: [
      { type: "Feature", properties: { c: "#2fe06b" }, geometry: { type: "Point", coordinates: ll[0] } },
      { type: "Feature", properties: { c: "#ff5a5a" }, geometry: { type: "Point", coordinates: ll[ll.length - 1] } }] } : emptyFC());
    if (M.pos && !M.view) { posMk.setLngLat([M.pos[1], M.pos[0]]); if (!posEl.isConnected) posMk.addTo(GL); }
    else if (posEl && posEl.isConnected) posMk.remove();
    if (M.follow && !M.view && M.pos) {
      const o = { center: [M.pos[1], M.pos[0]], duration: 900, essential: true };
      if (R.on) { o.zoom = Math.max(GL.getZoom(), 16.5); o.pitch = 50; o.bearing = M.hd; }
      GL.easeTo(o);
    }
  }

  /* ---------- view control ---------- */
  function center(lat, lon) {
    M.lat = lat; M.lon = lon;
    if (GL) { if (glReady) GL.easeTo({ center: [lon, lat], duration: 400 }); } else csched();
  }
  function fit(pts) {
    if (GL) {
      if (!glReady || pts.length < 2) return;
      const b = new maplibregl.LngLatBounds(); pts.forEach(q => b.extend([q[1], q[0]]));
      GL.fitBounds(b, { padding: { top: 90, bottom: 60, left: 50, right: 70 }, pitch: 0, bearing: 0, duration: 700, maxZoom: 17 }); return;
    }
    const w = cv.clientWidth - 70, h = cv.clientHeight - 90; if (!w || pts.length < 2) return;
    let a = 90, b = -90, c = 180, d = -180;
    pts.forEach(p => { a = Math.min(a, p[0]); b = Math.max(b, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[1]); });
    let z = 18;
    while (z > 3 && (Math.abs(px(d, z) - px(c, z)) > w || Math.abs(py(a, z) - py(b, z)) > h)) z--;
    M.z = z; center((a + b) / 2, (c + d) / 2);
  }
  function live() {
    M.view = null; M.follow = true;
    if (GL && glReady && M.pos) GL.easeTo({ center: [M.pos[1], M.pos[0]], zoom: Math.max(GL.getZoom(), 16), pitch: R.on ? 50 : 0, bearing: R.on ? M.hd : 0, duration: 700 });
    else if (M.pos) { M.z = Math.max(M.z, 16); center(M.pos[0], M.pos[1]); } else sched();
    sched(); setMsg(); renderList();
  }
  const zoom = d => { if (GL) { if (glReady) d > 0 ? GL.zoomIn() : GL.zoomOut(); return; } M.z = Math.max(3, Math.min(19, M.z + d)); csched(); };
  el("m-in").onclick = () => zoom(1); el("m-out").onclick = () => zoom(-1); el("m-loc").onclick = live;

  // drag to pan, two fingers to zoom
  const ptr = new Map(); let pinch0 = 0;
  cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId); ptr.set(e.pointerId, e); pinch0 = 0; });
  cv.addEventListener("pointermove", e => {
    const o = ptr.get(e.pointerId); if (!o) return;
    if (ptr.size === 1) {
      const x = px(M.lon, M.z) - (e.clientX - o.clientX), y = py(M.lat, M.z) - (e.clientY - o.clientY);
      M.follow = false; M.lon = lonOf(x, M.z); M.lat = Math.max(-80, Math.min(80, latOf(y, M.z))); sched();
    } else if (ptr.size === 2) {
      ptr.set(e.pointerId, e); const [a, b] = [...ptr.values()], dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!pinch0) pinch0 = dist; else if (dist / pinch0 > 1.5) { zoom(1); pinch0 = dist; } else if (dist / pinch0 < 0.67) { zoom(-1); pinch0 = dist; }
      return;
    }
    ptr.set(e.pointerId, e);
  });
  const up = e => { ptr.delete(e.pointerId); pinch0 = 0; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);

  /* ---------- text ---------- */
  function setMsg(t) {
    el("m-msg").textContent = t || (R.on ? "Recording route" : M.pos ? "Ready. Route records when you ride" : "Waiting for GPS…");
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
    M.pos = ll; LS.set("lastPos", ll);
    let v = c.speed != null && !isNaN(c.speed) ? c.speed * 3.6 : null;
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
    if (GL) sched(); else if (M.follow && !M.view) center(ll[0], ll[1]); else csched();
    setMsg(R.on ? "Recording route · GPS ±" + Math.round(c.accuracy) + " m" : null);
  }
  function onErr(e) {
    setMsg(e.code === 1 ? "Location is off for this app. Allow it in Settings." : "Searching for GPS…");
  }
  const geo = () => navigator.geolocation;
  const GO = { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 };
  function oneShot() { if (geo()) geo().getCurrentPosition(onPos, onErr, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }); }

  /* ---------- hook the existing ride start / stop ---------- */
  const startOrig = window.rideStart, stopOrig = window.rideStop;
  window.rideStart = function (auto, t0) {
    const was = R.on; startOrig(auto, t0);
    if (!was && R.on) {
      Object.assign(T, { pts: [], km: 0, vmax: 0, sp: 0, lastT: 0 }); M.view = null; M.follow = true;
      if (M.pos) { M.z = 17; center(M.pos[0], M.pos[1]); }
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
        `<span class="rr">${min} min · ${avg} km/h avg${r.mode ? " · " + r.mode : ""}</span></button>`;
    }).join("") : '<div class="note">Your rides with a route appear here. Tap one to see it on the map.</div>';
    el("m-list").querySelectorAll(".ride").forEach(b => b.onclick = () => {
      const r = S.rides[+b.dataset.i]; M.view = r.route; M.follow = false; fit(r.route);
      setMsg("Saved ride · tap the target button to go back to live"); el("mapcard").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ---------- lifecycle ---------- */
  let shown = false;
  setInterval(() => {
    const vis = el("s-gps").classList.contains("a");
    if (vis && !shown) {
      shown = true; if (!glTried) initGL(); if (GL && glReady) GL.resize();
      draw(); setMsg(); renderList(); if (GL) sched(); if (T.watch == null) oneShot();
    }
    if (!vis) shown = false;
    if (vis) stats();
  }, 1000);
  addEventListener("resize", () => { if (GL && glReady) GL.resize(); sched(); });
  setMsg(); stats(); renderList();
})();
