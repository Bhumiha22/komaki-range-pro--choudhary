/* Web Bluetooth shim for Android WebView. Backed by the native AndroidBle bridge (BleBridge.kt).
   Implements only what the app uses: requestDevice, getDevices, GATT connect/disconnect, service and
   characteristic lookup by UUID, notifications, read, write. Also wakeLock and blob downloads. */
(function () {
  const B = window.AndroidBle;
  if (!B) return;
  const BASE = "-0000-1000-8000-00805f9b34fb";
  const norm = u => {
    if (typeof u === "number") return u.toString(16).padStart(8, "0") + BASE;
    u = String(u).toLowerCase();
    return /^[0-9a-f]{4}$/.test(u) ? "0000" + u + BASE : u;
  };
  const toB64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const fromB64 = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const bytesOf = v => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

  let seq = 0; const pending = {};
  const call = (method, args) => new Promise((res, rej) => {
    const id = ++seq; pending[id] = { res, rej };
    B.call(id, method, JSON.stringify(args || {}));
  });
  // payload is a JSON string on success, or "ErrorName:message" on failure
  window.__bleResult = (id, ok, payload) => {
    const p = pending[id]; if (!p) return; delete pending[id];
    if (ok) { p.res(payload ? JSON.parse(payload) : null); return; }
    const i = payload.indexOf(":"), e = new Error(payload.slice(i + 1));
    e.name = i > 0 ? payload.slice(0, i) : "NetworkError"; p.rej(e);
  };

  const devs = {}, chars = {};
  const getDev = i => devs[i.id] || (devs[i.id] = new Device(i));

  class Characteristic extends EventTarget {
    constructor(dev, svc, uuid, p) {
      super(); this.service = { device: dev, uuid: svc }; this.uuid = uuid; this.value = null;
      this.properties = { read: !!p.read, write: !!p.write, writeWithoutResponse: !!p.writeWithoutResponse, notify: !!p.notify, indicate: !!p.indicate };
      chars[dev.id + "|" + svc + "|" + uuid] = this;
    }
    _a() { return { id: this.service.device.id, svc: this.service.uuid, ch: this.uuid }; }
    async startNotifications() { await call("startNotifications", this._a()); return this; }
    async stopNotifications() { await call("stopNotifications", this._a()); return this; }
    async readValue() {
      const r = await call("read", this._a()); const u = fromB64(r.v);
      this.value = new DataView(u.buffer); this.dispatchEvent(new Event("characteristicvaluechanged")); return this.value;
    }
    async writeValue(v) { await call("write", Object.assign(this._a(), { v: toB64(bytesOf(v)), resp: true })); }
    async writeValueWithResponse(v) { return this.writeValue(v); }
    async writeValueWithoutResponse(v) { await call("write", Object.assign(this._a(), { v: toB64(bytesOf(v)), resp: false })); }
  }
  class Service {
    constructor(dev, uuid) { this.device = dev; this.uuid = uuid; this.isPrimary = true; }
    async getCharacteristic(u) {
      u = norm(u); const p = await call("getCharacteristic", { id: this.device.id, svc: this.uuid, ch: u });
      return new Characteristic(this.device, this.uuid, u, p);
    }
  }
  class Server {
    constructor(dev) { this.device = dev; this.connected = false; }
    async connect() { await call("connect", { id: this.device.id }); this.connected = true; return this; }
    disconnect() { this.connected = false; call("disconnect", { id: this.device.id }).catch(() => {}); }
    async getPrimaryService(u) { u = norm(u); await call("getService", { id: this.device.id, svc: u }); return new Service(this.device, u); }
  }
  class Device extends EventTarget {
    constructor(i) { super(); this.id = i.id; this.name = i.name || null; this.gatt = new Server(this); }
  }

  window.__bleNotify = (id, svc, ch, b64) => {
    const c = chars[id + "|" + svc + "|" + ch]; if (!c) return;
    c.value = new DataView(fromB64(b64).buffer); c.dispatchEvent(new Event("characteristicvaluechanged"));
  };
  window.__bleDisc = id => {
    const d = devs[id]; if (!d) return;
    d.gatt.connected = false; d.dispatchEvent(new Event("gattserverdisconnected"));
  };

  const bt = {
    async requestDevice() { return getDev(await call("requestDevice")); },
    async getDevices() { return (await call("getDevices")).map(getDev); },
    async getAvailability() { return true; }
  };
  try { Object.defineProperty(navigator, "bluetooth", { value: bt, configurable: true }); } catch (e) { navigator.bluetooth = bt; }

  // Screen wake lock -> FLAG_KEEP_SCREEN_ON
  const wl = { request() { B.keepAwake(true); return Promise.resolve({ release() { B.keepAwake(false); return Promise.resolve(); } }); } };
  try { Object.defineProperty(navigator, "wakeLock", { value: wl, configurable: true }); } catch (e) {}

  // <a download href="blob:..."> -> save into Downloads
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith("blob:")) {
      const name = this.download;
      fetch(this.href).then(r => r.blob()).then(b => {
        const fr = new FileReader();
        fr.onload = () => B.saveFile(name, b.type || "application/octet-stream", String(fr.result).split(",")[1]);
        fr.readAsDataURL(b);
      });
      return;
    }
    return origClick.call(this);
  };
})();
