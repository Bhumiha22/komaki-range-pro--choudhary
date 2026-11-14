/* Light / dark theme and the Home clock. Theme: auto (light 6 am to 6 pm), light or dark. */
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

  function tick() {
    const d = new Date(), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const x = t.match(/^(.*?)\s*([AaPp]\.?[Mm]\.?)?$/) || [t, t, ""];
    document.getElementById("clk-t").textContent = x[1];
    document.getElementById("clk-s").textContent = x[2] || "";
    document.getElementById("clk-d").textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  }
  tick(); setInterval(tick, 1000);
})();
