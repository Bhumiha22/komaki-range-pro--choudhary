/* Sends battery level and range to the Android home-screen widget (at most once a minute unless the values change). */
(function () {
  "use strict";
  let last = "", lastT = 0;
  window.pushWidget = function (soc, rng, charging, eta) {
    if (soc == null || !window.AndroidBle || !AndroidBle.saveStatus) return;
    const s = Math.round(soc), r = rng == null ? -1 : Math.round(rng), c = charging ? 1 : 0;
    const e = charging && eta != null && eta >= 1 ? Math.round(eta) : -1, key = s + "|" + r + "|" + c, now = Date.now();
    if (key === last && now - lastT < 60000) return;
    last = key; lastT = now;
    try { AndroidBle.saveStatus(s, r, !!c, e); } catch (x) {}
  };
})();
