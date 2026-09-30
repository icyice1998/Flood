(() => {
  "use strict";
  // ?scope=th switches from Bangkok districts to all 77 provinces (points) plus observed rain from ThaiWater
  const NATION = new URLSearchParams(location.search).get("scope") === "th";
  const DISTRICTS_URL = NATION ? "data/provinces.geojson" : "data/districts.geojson";
  const UNIT = NATION ? "จังหวัด" : "เขต";
  const OM = "https://api.open-meteo.com/v1/forecast";
  const HOURS = 48;
  const MODELS = [["ecmwf_ifs025", "ECMWF"], ["gfs_seamless", "GFS"], ["icon_seamless", "ICON"]];
  // Colour classes (mm). Hourly: rain-rate feel; accumulated: TMD 24-h classes
  const SCALE = {
    hourly: [[0.1, "#e3f2fd", "ปรอย"], [1, "#90caf9", "เล็กน้อย"], [5, "#42a5f5", "ปานกลาง"], [10, "#fbc02d", "หนัก"], [20, "#f57c00", "หนักมาก"], [40, "#c62828", "รุนแรง"]],
    accum: [[0.1, "#e3f2fd", "0.1–10 เล็กน้อย"], [10, "#64b5f6", "10–35 ปานกลาง"], [35, "#f57c00", "35–90 หนัก"], [90, "#c62828", ">90 หนักมาก"]],
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtHour = (t) => new Date(t + ":00+07:00").toLocaleString("th-TH", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  const colorFor = (mm, mode) => {
    let c = null;
    for (const [min, hex] of SCALE[mode]) if (mm >= min) c = hex;
    return c;
  };
  const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);

  let GEO = null, FC = null, times = [], hour = 0, mode = "hourly", horizon = 24, selected = null, timer = null;
  const layerById = {};

  // ------------------------------------------------------------- map
  const map = NATION ? L.map("map", { zoomSnap: 0.5 }).setView([13.2, 101.0], 6) : L.map("map").setView([13.76, 100.55], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, opacity: 0.6, attribution: "© OpenStreetMap · พยากรณ์: Open-Meteo",
  }).addTo(map);
  const districts = L.layerGroup().addTo(map);

  function valueAt(i) {
    const p = FC[i].precipitation;
    return mode === "hourly" ? p[hour] || 0 : sum(p.slice(0, hour + 1));
  }

  function paint() {
    if (!FC) return;
    GEO.features.forEach((f, i) => {
      const v = valueAt(i);
      const c = colorFor(v, mode);
      layerById[f.properties.id].setStyle({ fillColor: c || "#ffffff", fillOpacity: c ? 0.75 : 0.05,
        weight: f.properties.id === selected ? 3 : 0.8, color: f.properties.id === selected ? "#0b6bcb" : "#607d8b" });
      layerById[f.properties.id].setTooltipContent(`<b>${esc(f.properties.name)}</b><br>${v.toFixed(1)} มม. · โอกาสฝน ${FC[i].precipitation_probability[hour] ?? "–"}%`);
    });
    $("#hourlabel").textContent = `${mode === "hourly" ? "ฝนชั่วโมง" : "สะสมถึง"} ${fmtHour(times[hour])} (+${hour + 1} ชม.)`;
    $("#legend").innerHTML = `<b>${mode === "hourly" ? "ฝนรายชั่วโมง (มม.)" : "ฝนสะสม (มม.)"}</b>` +
      SCALE[mode].map(([min, hex, th]) => `<div><i class="sq" style="background:${hex}"></i>${mode === "hourly" ? "≥" + min + " " : ""}${th}</div>`).join("");
  }

  function drawDistricts() {
    districts.clearLayers();
    L.geoJSON(GEO, {
      style: { weight: 0.8, color: "#607d8b", fillOpacity: 0.05 },
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 11, weight: 0.8, color: "#607d8b", fillOpacity: 0.05 }),
      onEachFeature: (f, lyr) => {
        layerById[f.properties.id] = lyr;
        lyr.bindTooltip(f.properties.name, { sticky: true });
        lyr.on("click", () => select(f.properties.id));
      },
    }).addTo(districts);
  }

  // ------------------------------------------------------------- panel
  function renderTop() {
    const q = $("#q").value.trim();
    const rows = GEO.features.map((f, i) => ({ id: f.properties.id, name: f.properties.name, prov: f.properties.province,
      mm: sum(FC[i].precipitation.slice(0, horizon)), pmax: Math.max(...FC[i].precipitation_probability.slice(0, horizon).map((x) => x || 0)) }))
      .filter((r) => !q || r.name.includes(q) || (r.prov || "").includes(q))
      .sort((a, b) => b.mm - a.mm);
    $("#toplabel").textContent = `(คาดสะสม ${horizon} ชม. ข้างหน้า)`;
    $("#top").innerHTML = rows.map((r) => {
      const seen = NATION ? obsMaxBy(r.name) : null;
      return `<li data-id="${esc(r.id)}"><span class="sw" style="background:${colorFor(r.mm, "accum") || "#eceff1"}"></span>${esc(r.name)}
      <small>${esc(r.prov === "กรุงเทพมหานคร" ? "" : r.prov)}</small><span class="mm">${r.mm.toFixed(1)} มม. <small>(${r.pmax}%)</small></span>
      ${seen != null ? `<br><small class="obs">ตกแล้ว 24 ชม. สูงสุด ${seen.toFixed(0)} มม.</small>` : ""}</li>`;
    }).join("");
    document.querySelectorAll("#top li").forEach((li) => li.addEventListener("click", () => select(li.dataset.id, true)));
  }

  // Observed rain (national scope): ThaiWater gauges, last 24 h
  let OBS = null;
  const obsLayer = L.layerGroup();
  const obsMaxBy = (name) => { const r = (OBS || []).filter((x) => x.province === name); return r.length ? Math.max(...r.map((x) => x.mm)) : null; };
  function obsLine() {
    if (!OBS || !OBS.length) return "";
    const top = OBS.reduce((a, b) => (b.mm > a.mm ? b : a));
    return `<br>☔ ตกแล้ว 24 ชม. (ThaiWater ${OBS.length} สถานี): สูงสุด <b>${top.mm.toFixed(1)} มม.</b> ที่ ${esc(top.name)} (${esc(top.province)}) · หนักมาก &gt;90 มม. ${OBS.filter((r) => r.mm > 90).length} สถานี`;
  }
  async function loadObs() {
    if (!NATION || !window.TW) return;
    try {
      OBS = await TW.rain24();
      obsLayer.clearLayers();
      if (L.heatLayer) L.heatLayer(OBS.filter((r) => r.mm >= 1).map((r) => [r.lat, r.lon, Math.min(1, r.mm / 100)]),
        { radius: 18, blur: 14, maxZoom: 9, max: 1, gradient: { 0.1: "#90caf9", 0.35: "#42a5f5", 0.6: "#ffa726", 0.9: "#c62828" } }).addTo(obsLayer);
      OBS.filter((r) => r.mm >= 35).forEach((r) => L.circleMarker([r.lat, r.lon], { radius: 3.5, color: "#fff", weight: 0.6, fillColor: TW.cls(TW.RAIN, r.mm).hex, fillOpacity: 0.95 })
        .bindPopup(`<b>${esc(r.name)}</b><br>${esc(r.province)}<br>ฝนตกแล้ว 24 ชม. <b>${r.mm.toFixed(1)} มม.</b><br><small>${esc(r.time)} · ThaiWater</small>`).addTo(obsLayer));
      if (FC) { renderNow(); renderTop(); }
    } catch (e) { OBS = []; }
  }

  function renderNow() {
    const all = FC.map((f) => f.precipitation);
    const next3 = all.map((p) => sum(p.slice(0, 3)));
    const wet3 = next3.filter((x) => x >= 1).length;
    const max24 = Math.max(...all.map((p) => sum(p.slice(0, 24))));
    const firstWet = (() => {
      for (let h = 0; h < HOURS; h++) if (all.filter((p) => (p[h] || 0) >= 1).length >= 5) return h;
      return -1;
    })();
    const top24 = GEO.features[all.map((p) => sum(p.slice(0, 24))).indexOf(max24)].properties.name;
    $("#now").innerHTML = `<b class="big">${wet3 ? `ฝน ≥1 มม. ใน 3 ชม. ข้างหน้า ${wet3} ${UNIT}` : "3 ชม. ข้างหน้า: ส่วนใหญ่ไม่มีฝนหรือฝนเล็กน้อย"}</b><br>
      ${firstWet >= 0 ? `ฝนเริ่มกระจาย (≥5 ${UNIT}) ประมาณ <b>${fmtHour(times[firstWet])}</b>` : "ยังไม่เห็นช่วงฝนกระจายใน 48 ชม."}<br>
      คาดสะสม 24 ชม. สูงสุด <b>${max24.toFixed(1)} มม.</b> (${esc(top24)})${obsLine()}`;
  }

  async function select(id, fly = false) {
    selected = id;
    paint();
    const i = GEO.features.findIndex((f) => f.properties.id === id);
    const f = GEO.features[i];
    if (fly) {
      const l = layerById[id];
      if (l.getBounds) map.fitBounds(l.getBounds().pad(0.6)); else map.setView(l.getLatLng(), 8);
    }
    const seen = NATION && OBS ? OBS.filter((r) => r.province === f.properties.name) : [];
    $("#dname").textContent = `${UNIT}${f.properties.name} · 48 ชม. ข้างหน้า` + (seen.length ? ` · ตกแล้ว 24 ชม. สูงสุด ${Math.max(...seen.map((r) => r.mm)).toFixed(1)} มม.` : "");
    chart(FC[i].precipitation, FC[i].precipitation_probability);
    // model spread for this district only (one small request)
    $("#models").textContent = "กำลังเทียบโมเดล…";
    try {
      const u = `${OM}?latitude=${f.properties.lat}&longitude=${f.properties.lon}&hourly=precipitation&models=${MODELS.map((m) => m[0]).join(",")}&forecast_hours=${HOURS}&timezone=Asia%2FBangkok`;
      const j = await (await fetch(u)).json();
      if (selected !== id) return;
      const tot = (h) => MODELS.map(([k, n]) => [n, sum((j.hourly[`precipitation_${k}`] || []).slice(0, h))]);
      const t24 = tot(24), t48 = tot(48);
      const vals = t24.map((x) => x[1]);
      const spread = Math.max(...vals) - Math.min(...vals);
      const agree = spread <= Math.max(5, 0.5 * Math.max(...vals)) ? "โมเดลใกล้เคียงกัน (ความมั่นใจสูงขึ้น)" : "โมเดลต่างกันมาก (ความมั่นใจต่ำ)";
      $("#models").innerHTML = `<table><tr><td></td>${MODELS.map((m) => `<td><b>${m[1]}</b></td>`).join("")}</tr>
        <tr><td>24 ชม.</td>${t24.map((x) => `<td>${x[1].toFixed(1)}</td>`).join("")}</tr>
        <tr><td>48 ชม.</td>${t48.map((x) => `<td>${x[1].toFixed(1)}</td>`).join("")}</tr></table>${agree}`;
    } catch (e) {
      $("#models").textContent = "เทียบโมเดลไม่ได้: " + e.message;
    }
  }

  // hourly bars (mm) with probability line (%)
  function chart(mm, prob) {
    const W = 360, H = 150, L0 = 26, B = 20, T = 8, n = mm.length, bw = (W - L0 - 4) / n;
    const top = Math.max(5, ...mm.map((x) => x || 0));
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const yp = (p) => T + (H - T - B) * (1 - p / 100);
    const bars = mm.map((v, i) => `<rect x="${L0 + i * bw}" y="${y(v || 0)}" width="${Math.max(1, bw - 1)}" height="${H - B - y(v || 0)}" fill="${colorFor(v || 0, "hourly") || "#cfd8dc"}"><title>${fmtHour(times[i])}: ${(v || 0).toFixed(1)} มม., ${prob[i] ?? "–"}%</title></rect>`).join("");
    const line = prob.map((p, i) => `${i ? "L" : "M"}${(L0 + i * bw + bw / 2).toFixed(1)},${yp(p || 0).toFixed(1)}`).join("");
    const ticks = [0, 12, 24, 36, 47].map((i) => `<text class="ax" x="${L0 + i * bw}" y="${H - 6}">${new Date(times[i] + ":00+07:00").toLocaleString("th-TH", { weekday: "short", hour: "2-digit", timeZone: "Asia/Bangkok" })}</text>`).join("");
    const now = `<line x1="${L0 + hour * bw + bw / 2}" x2="${L0 + hour * bw + bw / 2}" y1="${T}" y2="${H - B}" stroke="#0b6bcb" stroke-dasharray="3 2"/>`;
    $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟฝนรายชั่วโมง">
      <text class="ax" x="0" y="${T + 6}">${top.toFixed(0)} มม.</text><text class="ax" x="0" y="${H - B}">0</text>
      <line x1="${L0}" x2="${W}" y1="${H - B}" y2="${H - B}" stroke="#90a4ae"/>${bars}
      <path d="${line}" fill="none" stroke="#7e57c2" stroke-width="1.5"/>${now}${ticks}</svg>
      <small class="note">แท่ง = ฝน (มม./ชม.) · เส้นม่วง = โอกาสฝน (%) · เส้นประ = ชั่วโมงที่เลือกบนแผนที่</small>`;
  }

  // ------------------------------------------------------------- controls
  const pressed = (sel, attr, v) => document.querySelectorAll(`${sel} button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === String(v))));
  const redrawChart = () => {
    if (!selected) return;
    const i = GEO.features.findIndex((f) => f.properties.id === selected);
    chart(FC[i].precipitation, FC[i].precipitation_probability);
  };
  $("#hour").addEventListener("input", () => { hour = +$("#hour").value; paint(); redrawChart(); });
  document.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; pressed("#mode", "mode", mode); paint(); }));
  document.querySelectorAll("#horizon button").forEach((b) => b.addEventListener("click", () => { horizon = +b.dataset.h; pressed("#horizon", "h", horizon); renderTop(); }));
  $("#q").addEventListener("input", () => FC && renderTop());
  $("#play").addEventListener("click", () => {
    if (timer) { clearInterval(timer); timer = null; $("#play").textContent = "▶"; return; }
    $("#play").textContent = "⏸";
    timer = setInterval(() => { hour = (hour + 1) % HOURS; $("#hour").value = hour; paint(); redrawChart(); }, 700);
  });

  // Windy embed (their free public widget)
  let wOverlay = "rain", wModel = "ecmwf";
  function windy() {
    const c = map.getCenter();
    $("#windy").src = `https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=km%2Fh` +
      `&zoom=${Math.min(map.getZoom(), 11)}&overlay=${wOverlay}&product=${wModel}&level=surface&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&detailLat=${c.lat.toFixed(3)}&detailLon=${c.lng.toFixed(3)}&marker=true`;
  }
  document.querySelectorAll("#wOverlay button").forEach((b) => b.addEventListener("click", () => { wOverlay = b.dataset.v; pressed("#wOverlay", "v", wOverlay); windy(); }));
  document.querySelectorAll("#wModel button").forEach((b) => b.addEventListener("click", () => { wModel = b.dataset.v; pressed("#wModel", "v", wModel); windy(); }));
  document.querySelectorAll(".viewtabs button").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.view;
    document.querySelectorAll(".viewtabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $("#view-map").hidden = v !== "map";
    $("#view-windy").hidden = v !== "windy";
    if (v === "windy" && !$("#windy").src) windy();
    if (v === "map") map.invalidateSize();
  }));

  // ------------------------------------------------------------- my location
  const meLayer = L.layerGroup().addTo(map);
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function districtAt(lat, lon) {
    if (NATION) {   // provinces are points: take the nearest one
      let best = null, bd = Infinity;
      for (const f of GEO.features) { const d = Math.hypot(f.properties.lat - lat, f.properties.lon - lon); if (d < bd) { bd = d; best = f.properties.id; } }
      return best;
    }
    for (const f of GEO.features) {
      const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      if (polys.some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)))) return f.properties.id;
    }
    return null;
  }
  async function showMe(lat, lon, acc) {
    meLayer.clearLayers();
    L.circle([lat, lon], { radius: acc, weight: 1, color: "#1a73e8", fillOpacity: 0.08, interactive: false }).addTo(meLayer);
    L.marker([lat, lon], { icon: L.divIcon({ className: "", iconSize: [16, 16], html: '<div class="me-dot"></div>' }), interactive: false }).addTo(meLayer);
    map.setView([lat, lon], NATION ? 8 : 12);
    const box = $("#me");
    box.hidden = false;
    box.textContent = "กำลังดึงพยากรณ์ที่ตำแหน่งของคุณ…";
    try {
      const j = await (await fetch(`${OM}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=precipitation,precipitation_probability&forecast_hours=24&timezone=Asia%2FBangkok`)).json();
      const p = j.hourly.precipitation, pr = j.hourly.precipitation_probability;
      const first = p.findIndex((v) => (v || 0) >= 1);
      const peak = p.indexOf(Math.max(...p));
      box.innerHTML = `<b>ที่ตำแหน่งของคุณ</b><br>ฝน 1 ชม. หน้า <b>${(p[0] || 0).toFixed(1)} มม.</b> (โอกาส ${pr[0] ?? "–"}%) · 3 ชม. <b>${sum(p.slice(0, 3)).toFixed(1)} มม.</b> · 24 ชม. <b>${sum(p).toFixed(1)} มม.</b><br>
        ${first >= 0 ? `ฝน ≥1 มม./ชม. เริ่มประมาณ <b>${fmtHour(j.hourly.time[first])}</b> · หนักสุด ${fmtHour(j.hourly.time[peak])} (${p[peak].toFixed(1)} มม.)` : "ไม่คาดว่าจะมีฝน ≥1 มม./ชม. ใน 24 ชม."}`;
    } catch (e) { box.textContent = "ดึงพยากรณ์ที่ตำแหน่งไม่ได้: " + e.message; }
    const id = GEO && districtAt(lat, lon);
    if (id && FC) select(id);
  }
  $("#gps").addEventListener("click", () => {
    if (!("geolocation" in navigator) || !window.isSecureContext) { $("#me").hidden = false; $("#me").textContent = "ใช้ GPS ไม่ได้ (ต้องเปิดผ่าน https และเบราว์เซอร์รองรับ)"; return; }
    $("#gps").textContent = "📍 กำลังหาตำแหน่ง…";
    navigator.geolocation.getCurrentPosition((p) => {
      $("#gps").textContent = "📍 ฝนที่ตำแหน่งของฉัน (อัปเดต)";
      showMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
    }, (err) => {
      $("#gps").textContent = "📍 ฝนที่ตำแหน่งของฉัน";
      $("#me").hidden = false;
      $("#me").textContent = { 1: "ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — เปิดสิทธิ์ Location ให้เว็บนี้แล้วลองใหม่", 2: "หาตำแหน่งไม่ได้", 3: "หาตำแหน่งนานเกินไป" }[err.code] || err.message;
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  });

  // Scope switch and the observed-rain toggle
  document.querySelectorAll("#scope a").forEach((a) => a.setAttribute("aria-pressed", String((a.dataset.scope === "th") === NATION)));
  if (NATION) {
    document.querySelectorAll("[data-unit]").forEach((el) => { el.textContent = el.dataset.unit; });
    $("#q").placeholder = "ค้นหาจังหวัดหรือภาค";
    const box = $("#obsctl");
    box.hidden = false;
    obsLayer.addTo(map);
    $("#obschk").addEventListener("change", () => ($("#obschk").checked ? obsLayer.addTo(map) : map.removeLayer(obsLayer)));
  }

  // ------------------------------------------------------------- load
  async function load() {
    // Observed rain comes from ThaiWater and does not wait for the forecast
    if (NATION) loadObs();
    try {
      if (!GEO) { GEO = await (await fetch(DISTRICTS_URL)).json(); drawDistricts(); }
      const lat = GEO.features.map((f) => f.properties.lat).join(",");
      const lon = GEO.features.map((f) => f.properties.lon).join(",");
      const r = await fetch(`${OM}?latitude=${lat}&longitude=${lon}&hourly=precipitation,precipitation_probability&forecast_hours=${HOURS}&timezone=Asia%2FBangkok`);
      if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
      const j = await r.json();
      FC = (Array.isArray(j) ? j : [j]).map((x) => x.hourly);
      times = FC[0].time;
      paint(); renderTop(); renderNow();
      if (selected) select(selected);
      $("#updated").textContent = `พยากรณ์ ณ ${new Date().toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })} · เริ่ม ${fmtHour(times[0])}`;
    } catch (e) {
      // Open-Meteo answers a burst limit without CORS headers, which shows up as "Failed to fetch"
      $("#updated").textContent = "โหลดพยากรณ์ไม่ได้ (" + e.message + ") · ลองใหม่อัตโนมัติใน 1 นาที";
      clearTimeout(retry);
      retry = setTimeout(load, 60000);
    }
  }
  let retry = null;
  $("#reload").addEventListener("click", load);
  load();
  setInterval(load, 30 * 60 * 1000);
})();
