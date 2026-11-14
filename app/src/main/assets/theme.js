/* Light / dark theme. Theme: auto (light 6 am to 6 pm), light or dark. */
(function () {
  "use strict";
  let mode = LS.get("theme", "auto");
  const hour = () => new Date().getHours();
  const light = () => mode === "light" || (mode === "auto" && hour() >= 6 && hour() < 18);
  function apply() {
    const l = light(), was = document.body.classList.contains("light");
    document.body.classList.toggle("light", l);
    const m = document.querySelector('meta[name="color-scheme"]'); if (m) m.content = l ? "light" : "dark";
    try { if (window.AndroidBle && AndroidBle.setLightBars) AndroidBle.setLightBars(l); } catch (e) {}
    document.querySelectorAll("#themePills button").forEach(b => b.classList.toggle("a", b.dataset.th === mode));
    if (l !== was) window.dispatchEvent(new Event("themechange"));
  }
  document.querySelectorAll("#themePills button").forEach(b => b.onclick = () => { mode = b.dataset.th; LS.set("theme", mode); apply(); });
  apply(); setInterval(apply, 30000);

})();
