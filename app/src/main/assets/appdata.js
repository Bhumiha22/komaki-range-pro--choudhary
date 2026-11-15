/* Keep-screen-on switch, data backup / restore, and the app version line (Settings). */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const B = window.AndroidBle;
  const msg = t => { $("#bkMsg").textContent = t; };
  const APP = "komaki-x1-range-pro";

  // Screen stays on while the app is open (default on)
  const keep = $("#keepOn");
  keep.checked = LS.get("keepOn", true);
  const applyKeep = () => { try { if (B && B.setKeepOn) B.setKeepOn(keep.checked); } catch (e) {} };
  keep.onchange = () => { LS.set("keepOn", keep.checked); applyKeep(); };
  applyKeep();

  try { const v = B && B.appVersion && B.appVersion(); if (v) $("#appVer").textContent = "App version " + v; } catch (e) {}

  // Back up: every saved item goes into one JSON file in Downloads
  $("#bBackup").onclick = () => {
    const data = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); data[k] = localStorage.getItem(k); } }
    catch (e) { msg("Could not read the app data."); return; }
    const d = new Date(), p = n => String(n).padStart(2, "0");
    const name = `komaki-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
    const blob = new Blob([JSON.stringify({ app: APP, v: 1, t: Date.now(), data })], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    msg("Saved " + name + " to your Downloads folder (" + Object.keys(data).length + " items).");
  };

  // Restore: pick that file again
  $("#bRestore").onclick = () => {
    if (typeof R !== "undefined" && R.on) { msg("Stop the current ride before restoring."); return; }
    $("#fRestore").click();
  };
  $("#fRestore").onchange = e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      let o; try { o = JSON.parse(r.result); } catch (x) { msg("That file is not a valid backup."); return; }
      if (!o || o.app !== APP || !o.data || typeof o.data !== "object") { msg("That file is not a Komaki backup."); return; }
      const keys = Object.keys(o.data);
      if (!confirm("Restore " + keys.length + " items from this backup? It replaces your current rides, Home and settings.")) return;
      try { localStorage.clear(); keys.forEach(k => localStorage.setItem(k, String(o.data[k]))); }
      catch (x) { msg("Restore failed: " + x.message); return; }
      msg("Restored. Reloading…"); setTimeout(() => location.reload(), 600);
    };
    r.onerror = () => msg("Could not read that file.");
    r.readAsText(f);
  };
})();
