(() => {
  "use strict";
  // Browser key for Google Maps Platform (Weather API only, HTTP-referrer restricted), written by the
  // "WeatherNext key" workflow from the GOOGLE_WEATHER_API_KEY repo secret.
  const KEY = window.WEATHERNEXT_KEY || "";
  const API = "https://weather.googleapis.com/v1/forecast/hours:lookup";
  const OM = "https://api.open-meteo.com/v1/forecast";
  const DISTRICTS_URL = "data/districts.geojson";
  const CACHE_MIN = 20;
  const OVERVIEW = [
    ["กลางเมือง (ปทุมวัน)", 13.744, 100.533], ["เหนือ (ดอนเมือง)", 13.913, 100.595], ["ตะวันออกเฉียงเหนือ (บางเขน/สายไหม)", 13.873, 100.66],
    ["ตะวันออก (มีนบุรี)", 13.812, 100.73], ["ตะวันออกเฉียงใต้ (บางนา/บางพลี)", 13.668, 100.66], ["ใต้ (บางขุนเทียน)", 13.62, 100.44],
    ["ตะวันตก (ตลิ่งชัน/บางแค)", 13.73, 100.43], ["นนทบุรี", 13.86, 100.51], ["ปทุมธานี (รังสิต)", 13.99, 100.62],
  ];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtHour = (iso) => new Date(iso).toLocaleString("th-TH", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
  const rainColor = (mm) => (mm >= 20 ? "#c62828" : mm >= 10 ? "#f57c00" : mm >= 5 ? "#fbc02d" : mm >= 1 ? "#42a5f5" : mm >= 0.1 ? "#90caf9" : "#eceff1");

  // ------------------------------------------------------------- Google Weather API (WeatherNext 3)
  async function lookup(lat, lon, hours) {
    const ck = `wn:${lat.toFixed(3)},${lon.toFixed(3)},${hours}`;
    try {
      const c = JSON.parse(sessionStorage.getItem(ck) || "null");
      if (c && Date.now() - c.at < CACHE_MIN * 60000) return c.rows;
    } catch { /* storage unavailable */ }
    const rows = [];
    let token = "";
    while (rows.length < hours) {
      const u = `${API}?key=${encodeURIComponent(KEY)}&location.latitude=${lat}&location.longitude=${lon}&hours=${hours}&pageSize=24&languageCode=th&unitsSystem=METRIC${token ? "&pageToken=" + encodeURIComponent(token) : ""}`;
      const r = await fetch(u);
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
      for (const h of j.forecastHours || []) {
        rows.push({
          t: h.interval && h.interval.startTime,
          mm: (h.precipitation && h.precipitation.qpf && h.precipitation.qpf.quantity) || 0,
          pp: h.precipitation && h.precipitation.probability ? h.precipitation.probability.percent : null,
          thunder: h.thunderstormProbability ?? null,
          cond: (h.weatherCondition && h.weatherCondition.description && h.weatherCondition.description.text) || "",
          icon: h.weatherCondition && h.weatherCondition.iconBaseUri ? h.weatherCondition.iconBaseUri + ".svg" : "",
          temp: h.temperature ? h.temperature.degrees : null,
        });
      }
      token = j.nextPageToken;
      if (!token || !(j.forecastHours || []).length) break;
    }
    try { sessionStorage.setItem(ck, JSON.stringify({ at: Date.now(), rows })); } catch { /* ignore */ }
    return rows.slice(0, hours);
  }

  async function openMeteo(lat, lon, hours) {
    try {
      const j = await (await fetch(`${OM}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=precipitation&forecast_hours=${hours}&timezone=Asia%2FBangkok`)).json();
      return j.hourly.precipitation;
    } catch { return null; }
  }

  // ------------------------------------------------------------- map (for picking a point only)
  const map = L.map("map").setView([13.78, 100.56], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
  const pick = L.layerGroup().addTo(map);
  const outline = L.layerGroup().addTo(map);
  let GEO = null;

  map.on("click", (e) => showPoint(e.latlng.lat, e.latlng.lng, `จุดที่เลือก (${e.latlng.lat.toFixed(3)}, ${e.latlng.lng.toFixed(3)})`));

  function marker(lat, lon, me) {
    pick.clearLayers();
    L.marker([lat, lon], me ? { icon: L.divIcon({ className: "", iconSize: [16, 16], html: '<div class="me-dot"></div>' }) } : {}).addTo(pick);
  }

  // ------------------------------------------------------------- selected point
  async function showPoint(lat, lon, label, me = false) {
    marker(lat, lon, me);
    const box = $("#point");
    box.hidden = false;
    if (!KEY) { box.innerHTML = `<b>${esc(label)}</b><p class="note">ยังไม่ได้ตั้งค่าคีย์ Google Weather API (ดูแถบด้านบน)</p>`; return; }
    box.innerHTML = `<b>${esc(label)}</b><p class="note">กำลังดึงพยากรณ์ WeatherNext 3…</p>`;
    try {
      const [rows, om] = await Promise.all([lookup(lat, lon, 48), openMeteo(lat, lon, 48)]);
      const mm = rows.map((r) => r.mm);
      const first = rows.findIndex((r) => r.mm >= 1);
      const peak = mm.indexOf(Math.max(...mm));
      const thunder = Math.max(0, ...rows.slice(0, 24).map((r) => r.thunder || 0));
      const g24 = sum(mm.slice(0, 24)), o24 = om ? sum(om.slice(0, 24)) : null;
      const agree = o24 == null ? "" : Math.abs(g24 - o24) <= Math.max(5, 0.5 * Math.max(g24, o24))
        ? "สองแหล่งใกล้เคียงกัน" : "สองแหล่งต่างกันมาก (ความไม่แน่นอนสูง)";
      box.innerHTML = `<b>${esc(label)}</b>
        <div class="wn-sum">
          <div><small>1 ชม. หน้า</small><b>${mm[0].toFixed(1)}</b><small>มม. · ${rows[0].pp ?? "–"}%</small></div>
          <div><small>3 ชม.</small><b>${sum(mm.slice(0, 3)).toFixed(1)}</b><small>มม.</small></div>
          <div><small>24 ชม.</small><b>${g24.toFixed(1)}</b><small>มม.</small></div>
          <div><small>พายุฝนฟ้าคะนอง</small><b>${thunder}%</b><small>สูงสุด 24 ชม.</small></div>
        </div>
        <p>${first >= 0 ? `ฝน ≥1 มม./ชม. เริ่มประมาณ <b>${fmtHour(rows[first].t)}</b> · หนักสุด ${fmtHour(rows[peak].t)} (${mm[peak].toFixed(1)} มม.)` : "ไม่คาดว่าจะมีฝน ≥1 มม./ชม. ใน 48 ชม."}</p>
        ${o24 != null ? `<p class="note">เทียบ 24 ชม.: WeatherNext 3 ${g24.toFixed(1)} มม. · Open-Meteo ${o24.toFixed(1)} มม. — ${agree}</p>` : ""}
        ${chart(rows, om)}
        <details><summary>ตารางรายชั่วโมง</summary><table class="wn-table"><tr><th>เวลา</th><th></th><th>มม.</th><th>โอกาส</th><th>ฟ้าคะนอง</th><th>°C</th></tr>
        ${rows.map((r) => `<tr><td>${fmtHour(r.t)}</td><td>${r.icon ? `<img src="${esc(r.icon)}" alt="" width="20" height="20">` : ""} <small>${esc(r.cond)}</small></td>
          <td style="background:${rainColor(r.mm)}">${r.mm.toFixed(1)}</td><td>${r.pp ?? "–"}%</td><td>${r.thunder ?? "–"}%</td><td>${r.temp ?? "–"}</td></tr>`).join("")}</table></details>
        <p class="attrib">Source: Includes weather data from Google</p>`;
    } catch (e) {
      box.innerHTML = `<b>${esc(label)}</b><p class="note">ดึงพยากรณ์ไม่ได้: ${esc(e.message)}</p>`;
    }
  }

  function chart(rows, om) {
    const W = 360, H = 150, L0 = 26, B = 20, T = 8, n = rows.length, bw = (W - L0 - 4) / n;
    const top = Math.max(5, ...rows.map((r) => r.mm), ...(om || []).map((x) => x || 0));
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const yp = (p) => T + (H - T - B) * (1 - p / 100);
    const bars = rows.map((r, i) => `<rect x="${L0 + i * bw}" y="${y(r.mm)}" width="${Math.max(1, bw - 1)}" height="${H - B - y(r.mm)}" fill="${rainColor(r.mm)}"><title>${fmtHour(r.t)}: ${r.mm.toFixed(1)} มม., ${r.pp ?? "–"}%</title></rect>`).join("");
    const pline = rows.map((r, i) => `${i ? "L" : "M"}${(L0 + i * bw + bw / 2).toFixed(1)},${yp(r.pp || 0).toFixed(1)}`).join("");
    const oline = om ? om.slice(0, n).map((v, i) => `${i ? "L" : "M"}${(L0 + i * bw + bw / 2).toFixed(1)},${y(v || 0).toFixed(1)}`).join("") : "";
    const ticks = [0, 12, 24, 36].filter((i) => i < n).map((i) => `<text class="ax" x="${L0 + i * bw}" y="${H - 6}">${fmtHour(rows[i].t)}</text>`).join("");
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟฝนรายชั่วโมง">
      <text class="ax" x="0" y="${T + 6}">${top.toFixed(0)} มม.</text><text class="ax" x="0" y="${H - B}">0</text>
      <line x1="${L0}" x2="${W}" y1="${H - B}" y2="${H - B}" stroke="#90a4ae"/>${bars}
      <path d="${pline}" fill="none" stroke="#7e57c2" stroke-width="1.5"/>
      ${oline ? `<path d="${oline}" fill="none" stroke="#2e7d32" stroke-width="1.2" stroke-dasharray="3 2"/>` : ""}${ticks}</svg>
      <small class="note">แท่ง = ฝน WeatherNext 3 (มม./ชม.) · เส้นม่วง = โอกาสฝน (%) · เส้นประเขียว = ฝน Open-Meteo (มม./ชม.)</small></div>`;
  }

  // ------------------------------------------------------------- city overview
  async function overview() {
    if (!KEY) { $("#overview").innerHTML = `<p class="note">ต้องตั้งค่าคีย์ก่อน</p>`; return; }
    const res = await Promise.all(OVERVIEW.map(([name, lat, lon]) => lookup(lat, lon, 24).then((rows) => ({ name, lat, lon, rows })).catch((e) => ({ name, lat, lon, err: e.message }))));
    const ok = res.filter((r) => r.rows);
    if (!ok.length) { $("#overview").innerHTML = `<p class="note">ดึงข้อมูลไม่ได้: ${esc(res[0].err)}</p>`; return; }
    $("#overview").innerHTML = `<table class="wn-table"><tr><th>พื้นที่</th><th>1 ชม.</th><th>3 ชม.</th><th>24 ชม.</th><th>ฟ้าคะนอง</th></tr>
      ${res.map((r) => r.rows ? (() => {
        const mm = r.rows.map((x) => x.mm);
        const s3 = sum(mm.slice(0, 3)), s24 = sum(mm);
        return `<tr data-lat="${r.lat}" data-lon="${r.lon}" data-name="${esc(r.name)}"><td><a href="#">${esc(r.name)}</a></td>
          <td style="background:${rainColor(mm[0])}">${mm[0].toFixed(1)}</td><td style="background:${rainColor(s3)}">${s3.toFixed(1)}</td>
          <td>${s24.toFixed(1)}</td><td>${Math.max(0, ...r.rows.map((x) => x.thunder || 0))}%</td></tr>`;
      })() : `<tr><td>${esc(r.name)}</td><td colspan="4"><small>${esc(r.err)}</small></td></tr>`).join("")}</table>
      <p class="note">หน่วย มม. · กดชื่อพื้นที่เพื่อดูรายชั่วโมง</p>`;
    document.querySelectorAll("#overview tr[data-lat]").forEach((tr) => tr.addEventListener("click", (e) => {
      e.preventDefault();
      showPoint(+tr.dataset.lat, +tr.dataset.lon, tr.dataset.name);
      map.setView([+tr.dataset.lat, +tr.dataset.lon], 12);
    }));
    $("#updated").textContent = `WeatherNext 3 · ดึงเมื่อ ${new Date().toLocaleString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })}`;
  }

  // ------------------------------------------------------------- districts, GPS
  fetch(DISTRICTS_URL).then((r) => r.json()).then((g) => {
    GEO = g;
    const opts = g.features.map((f) => f.properties).sort((a, b) => a.name.localeCompare(b.name, "th"));
    $("#dist").insertAdjacentHTML("beforeend", opts.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.province !== "กรุงเทพมหานคร" ? " (" + esc(p.province) + ")" : ""}</option>`).join(""));
  }).catch(() => {});
  $("#dist").addEventListener("change", () => {
    const f = GEO && GEO.features.find((x) => x.properties.id === $("#dist").value);
    if (!f) return;
    outline.clearLayers();
    const lyr = L.geoJSON(f, { style: { color: "#0b6bcb", weight: 2, fillOpacity: 0.05 }, interactive: false }).addTo(outline);
    map.fitBounds(lyr.getBounds().pad(0.3));
    showPoint(f.properties.lat, f.properties.lon, `เขต${f.properties.name}`);
  });
  $("#gps").addEventListener("click", () => {
    if (!("geolocation" in navigator) || !window.isSecureContext) { $("#point").hidden = false; $("#point").textContent = "ใช้ GPS ไม่ได้ (ต้องเปิดผ่าน https)"; return; }
    $("#gps").textContent = "📍 กำลังหาตำแหน่ง…";
    navigator.geolocation.getCurrentPosition((p) => {
      $("#gps").textContent = "📍 พยากรณ์ที่ตำแหน่งของฉัน";
      map.setView([p.coords.latitude, p.coords.longitude], 13);
      showPoint(p.coords.latitude, p.coords.longitude, "📍 ตำแหน่งของฉัน", true);
    }, (err) => {
      $("#gps").textContent = "📍 พยากรณ์ที่ตำแหน่งของฉัน";
      $("#point").hidden = false;
      $("#point").textContent = { 1: "ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — เปิดสิทธิ์ Location ให้เว็บนี้แล้วลองใหม่", 2: "หาตำแหน่งไม่ได้", 3: "หาตำแหน่งนานเกินไป" }[err.code] || err.message;
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  });

  if (!KEY) {
    const b = $("#setup");
    b.hidden = false;
    b.textContent = "ยังไม่ได้เชื่อม Google Weather API: ผู้ดูแลต้องเพิ่มคีย์เป็น repo secret ชื่อ GOOGLE_WEATHER_API_KEY แล้วรัน workflow \"WeatherNext key\" (ดู README)";
  }
  overview();
})();
