(() => {
  const DATA_URL = "data/latest.json";
  const DISTRICTS_URL = "data/districts.geojson";
  const CANALS_URL = "data/canals.geojson";
  const ROADS_URL = "data/roads.geojson";
  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_MIN = 45;

  const LEVEL = {
    severe: { th: "อันตราย", hex: "#c62828" },
    warning: { th: "เตือนภัย", hex: "#e46c0a" },
    watch: { th: "เฝ้าระวัง", hex: "#d9a400" },
    normal: { th: "ปกติ", hex: "#2e9d5b" },
  };
  const STATUS = {
    overbank: { th: "ล้นตลิ่ง", hex: "#c62828" },
    critical: { th: "เกินวิกฤต", hex: "#e46c0a" },
    warning: { th: "เกินเฝ้าระวัง", hex: "#d9a400" },
    normal: { th: "ปกติ", hex: "#1e88e5" },
    unknown: { th: "ไม่มีข้อมูล", hex: "#8a94a0" },
  };
  const CONF = { high: "สูง", medium: "ปานกลาง", low: "ต่ำ" };
  const ROADC = {
    red: { th: "ผ่านยาก/รถติดมาก", hex: "#c62828", rank: 3 },
    orange: { th: "น้ำท่วมขัง", hex: "#e46c0a", rank: 2 },
    yellow: { th: "รถติด", hex: "#d9a400", rank: 1 },
    green: { th: "น้ำลด/ผ่านได้", hex: "#2e9d5b", rank: 0 },
  };
  const CANAL_COLOR = { overbank: "#c62828", critical: "#e46c0a", warning: "#d9a400", normal: "#1e88e5", unknown: "#1e88e5" };
  const CAT = { rising: "น้ำเพิ่ม", flooding: "น้ำท่วม", warning: "เตือนภัย", rain: "ฝนหนัก" };
  const EVIDENCE = [
    ["measured", "ตรวจวัดแล้ว"],
    ["forecast", "แบบจำลองคาดการณ์"],
    ["reported", "รายงานจากข่าว/โซเชียล (รอยืนยัน)"],
    ["confirmed", "ยืนยันผลกระทบแล้ว"],
  ];
  const LINKS = [
    ["ThaiWater — ฝน ระดับน้ำ เขื่อน ทะเล", "https://www.thaiwater.net/"],
    ["เรดาร์ฝน กรมอุตุนิยมวิทยา", "https://weather.tmd.go.th/composite/index_composite.html"],
    ["สำนักการระบายน้ำ กทม. (เรดาร์ คลอง ปตร. CCTV)", "https://dds.bangkok.go.th/"],
    ["กรมทรัพยากรน้ำ — ระบบเตือนน้ำป่า/ดินถล่ม", "https://ews.dwr.go.th/ews/"],
    ["กรมชลประทาน — ระดับแม่น้ำ อ่างเก็บน้ำ", "https://hydro.rid.go.th/th/main"],
    ["GISTDA Disaster Platform", "https://disaster.gistda.or.th/dashboard"],
    ["กรมอุทกศาสตร์ — น้ำขึ้นน้ำลง", "https://hydro.navy.mi.th/waterlaveltable"],
    ["Google Flood Hub", "https://sites.research.google/floods/"],
    ["NASA Worldview", "https://worldview.earthdata.nasa.gov/"],
  ];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
  const num = (v, d = 2) => (v == null ? "–" : Number(v).toFixed(d));
  const fmtTime = (t) => {
    if (!t) return "–";
    const d = new Date(t.length <= 16 && !/[+Z]/.test(t.slice(10)) ? t + "+07:00" : t);
    return isNaN(d) ? t : d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม. ${m % 60} นาทีที่แล้ว`;
  };
  const FLAG = { stale: "ข้อมูลเก่า", missing_value: "ไม่มีค่า", out_of_range: "ค่าผิดปกติ", no_threshold: "ไม่มีเกณฑ์", threshold_suspect: "เกณฑ์ของสถานีไม่สมเหตุสมผล ใช้เฉพาะเกณฑ์ที่เหลือ" };
  const flagText = (f) => (f && f.length ? `<br><span class="warn">⚠ ${f.map((x) => FLAG[x] || x).join(", ")}</span>` : "");
  const pref = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) { /* storage unavailable */ }
    return null;
  };

  let DATA = null, GEO = null, CANAL_GEO = null, ROAD_GEO = null;
  const byId = {};
  const districtLayers = {};

  // ------------------------------------------------------------- map
  const map = L.map("map", { zoomControl: true }).setView([13.76, 100.58], 10);
  // Road incident pins crowd the city view: show them from this zoom in (road colours stay visible)
  const EV_MIN_ZOOM = 13;
  const syncEvZoom = () => map.getContainer().classList.toggle("ev-hidden", map.getZoom() < EV_MIN_ZOOM);
  map.on("zoomend", syncEvZoom);
  syncEvZoom();
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ThaiWater, สำนักการระบายน้ำ กทม., Open-Meteo, GloFAS, RainViewer · กล้อง: Longdo Traffic, iTIC, กรมทางหลวง',
  }).addTo(map);

  const layers = {
    districts: L.layerGroup().addTo(map),
    canal: L.layerGroup().addTo(map),
    river: L.layerGroup().addTo(map),
    rain: L.layerGroup(),
    radar: L.layerGroup().addTo(map),
    highlight: L.layerGroup().addTo(map),
    me: L.layerGroup().addTo(map),
    cctv: L.layerGroup().addTo(map),
    canalLines: L.layerGroup().addTo(map),
    roadLines: L.layerGroup().addTo(map),
    events: L.layerGroup().addTo(map),
    news: L.layerGroup().addTo(map),
  };
  map.createPane("water").style.zIndex = 450;
  L.control.layers(null, {
    "เขต/อำเภอ (ระดับความเสี่ยง)": layers.districts,
    "ระดับน้ำคลอง (กทม.)": layers.canal,
    "ระดับน้ำแม่น้ำ/คลองหลัก": layers.river,
    "สถานีวัดฝน": layers.rain,
    "แนวคลองและแม่น้ำ (ฟ้า = ไม่ท่วม)": layers.canalLines,
    "เหตุบนถนน (กรมทางหลวง/iTIC · ซูมเข้าเพื่อดูหมุด)": layers.events,
    "ถนนที่มีรายงาน": layers.roadLines,
    "ข่าว (กรองเวลา/หัวข้อได้ที่แถบบนแผนที่)": layers.news,
    "กล้อง CCTV (ภาพสด)": layers.cctv,
    "เรดาร์ฝน": layers.radar,
  }, { collapsed: window.innerWidth < 800 }).addTo(map);

  $("#legend").innerHTML = `<button type="button" class="ltoggle" aria-expanded="true">สัญลักษณ์</button><div class="lbody">` +
    `<b>เขต</b>${Object.values(LEVEL).map((l) => `<div><i class="sq" style="background:${l.hex}"></i>${l.th}</div>`).join("")}` +
    `<b>จุดวัดน้ำ</b>${["overbank", "critical", "warning", "normal", "unknown"].map((k) => `<div><i style="background:${STATUS[k].hex}"></i>${STATUS[k].th}</div>`).join("")}` +
    `<b>เหตุบนถนน / ถนน</b>${Object.values(ROADC).map((r) => `<div><i class="sq" style="background:${r.hex}"></i>${r.th}</div>`).join("")}` +
    `<b>แนวคลอง / แม่น้ำ</b><div><i class="ln" style="background:${CANAL_COLOR.normal}"></i>คลอง ไม่ท่วม</div>` +
    `<div><i class="ln thick" style="background:${CANAL_COLOR.normal}"></i>แม่น้ำ ไม่ท่วม</div>` +
    `<div><i class="ln" style="background:${CANAL_COLOR.warning}"></i><i class="ln" style="background:${CANAL_COLOR.critical};margin-left:-3px"></i><i class="ln" style="background:${CANAL_COLOR.overbank};margin-left:-3px"></i>ช่วง 1.5 กม. รอบจุดวัดที่น้ำสูง → ล้นตลิ่ง</div></div>`;
  const legendToggle = $("#legend .ltoggle");
  const setLegend = (open) => { $("#legend").classList.toggle("closed", !open); legendToggle.setAttribute("aria-expanded", String(open)); };
  legendToggle.addEventListener("click", () => setLegend($("#legend").classList.contains("closed")));
  setLegend(window.innerWidth >= 800);

  function drawMap(d) {
    ["districts", "canal", "river", "rain", "highlight"].forEach((k) => layers[k].clearLayers());
    drawCameras(d.cameras || []);
    drawCanalLines(d);
    drawEvents(filteredEvents());
    drawNewsPins(filteredNews());
    if (GEO) {
      L.geoJSON(GEO, {
        style: (f) => {
          const z = byId[f.properties.id];
          const lv = z ? z.level : "normal";
          return { color: LEVEL[lv].hex, weight: 1, fillColor: LEVEL[lv].hex, fillOpacity: { severe: 0.45, warning: 0.32, watch: 0.22, normal: 0.06 }[lv] };
        },
        onEachFeature: (f, lyr) => {
          const z = byId[f.properties.id];
          districtLayers[f.properties.id] = lyr;
          lyr.bindTooltip(`${esc(f.properties.name)}${z ? " · " + LEVEL[z.level].th + " (" + z.score + ")" : ""}`, { sticky: true });
          lyr.on("click", () => openDistrict(f.properties.id, false));
        },
      }).addTo(layers.districts);
    }
    d.stations.canal.forEach((g) => {
      L.circleMarker([g.lat, g.lon], { radius: g.status === "normal" ? 4 : 6, color: "#fff", weight: 1, fillColor: STATUS[g.status].hex, fillOpacity: 0.95 })
        .bindPopup(gaugePopup(g)).addTo(layers.canal);
    });
    d.stations.river.forEach((g) => {
      L.circleMarker([g.lat, g.lon], { radius: 8, color: "#1b2430", weight: 2, fillColor: STATUS[g.status].hex, fillOpacity: 0.95 })
        .bindPopup(gaugePopup(g)).addTo(layers.river);
    });
    d.stations.rain.forEach((r) => {
      const v = r.rain_24h || 0;
      const c = r.flags.length ? "#8a94a0" : v > 90 ? "#4a148c" : v > 35 ? "#1565c0" : v > 10 ? "#42a5f5" : "#b3d9f7";
      L.circleMarker([r.lat, r.lon], { radius: 3 + Math.min(9, v / 20), color: "#fff", weight: 1, fillColor: c, fillOpacity: 0.9 })
        .bindPopup(`<b>${esc(r.name)}</b><br>${esc(r.amphoe)} ${esc(r.province)} · ${esc(r.agency)}<br>
          ฝน 1 ชม. ${r.rain_1h ?? "–"} มม. · 24 ชม. ${r.rain_24h ?? "–"} มม.<br>
          <small>${fmtTime(r.time)} · ${esc(r.source_id)}:${esc(r.id)}</small>${flagText(r.flags)}`)
        .addTo(layers.rain);
    });
  }

  function gaugePopup(g) {
    const lines = [
      `<b>${esc(g.name)}</b> <span class="pill" style="background:${STATUS[g.status].hex}">${STATUS[g.status].th}</span>`,
      `${g.canal ? esc(g.canal) + " · " : ""}${esc(g.amphoe)} ${esc(g.province)}`,
      `ระดับน้ำ <b>${num(g.value)}</b> ${esc(g.unit)}` + (g.bank_percent != null ? ` · ${g.bank_percent.toFixed(0)}% ของตลิ่ง` : ""),
    ];
    if (g.bank != null || g.critical != null) lines.push(`ตลิ่ง ${num(g.bank)} · วิกฤต ${num(g.critical)} · เฝ้าระวัง ${num(g.warning)}`);
    if (g.to_bank_m != null && g.bank_percent == null) {
      lines.push(g.to_bank_m >= 0 ? `ต่ำกว่าตลิ่ง ${num(g.to_bank_m)} ม.` : `<b class="bad">สูงกว่าตลิ่ง ${num(-g.to_bank_m)} ม.</b>`);
    }
    if (g.outside != null) lines.push(`ระดับน้ำด้านนอก (แม่น้ำ) ${num(g.outside)} ม.`);
    if (g.rise_m != null) lines.push(`เปลี่ยนแปลง ${g.rise_m >= 0 ? "+" : ""}${num(g.rise_m)} ม. จากรอบก่อน`);
    lines.push(`<small>${fmtTime(g.time)} · ${esc(g.source_id)}:${esc(g.id)}</small>${flagText(g.flags)}`);
    return lines.join("<br>");
  }

  // Radar: RainViewer public tiles, past ~2 h, animated on demand
  let radarFrames = [], radarHost = "", radarIdx = 0, radarTimer = null, radarTile = null;
  async function loadRadar() {
    try {
      const j = await (await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" })).json();
      radarHost = j.host; radarFrames = j.radar.past; radarIdx = radarFrames.length - 1;
      showRadar(); $("#radarCtl").hidden = false;
    } catch (e) { console.warn("radar unavailable", e); }
  }
  function showRadar() {
    const f = radarFrames[radarIdx];
    if (!f) return;
    const next = L.tileLayer(`${radarHost}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0.55, maxNativeZoom: 7, maxZoom: 18 });
    layers.radar.addLayer(next);
    if (radarTile) layers.radar.removeLayer(radarTile);
    radarTile = next;
    $("#radarTime").textContent = new Date(f.time * 1000).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
  }
  $("#radarPlay").addEventListener("click", () => {
    if (radarTimer) {
      clearInterval(radarTimer); radarTimer = null; radarIdx = radarFrames.length - 1; showRadar();
      $("#radarPlay").textContent = "▶ เรดาร์"; return;
    }
    $("#radarPlay").textContent = "■ หยุด";
    radarTimer = setInterval(() => { radarIdx = (radarIdx + 1) % radarFrames.length; showRadar(); }, 700);
  });

  // ------------------------------------------------------------- CCTV (live HLS)
  // Camera list from Longdo Traffic; streams served by iTIC Foundation / Dept. of Highways.
  // Video loads only while a popup is open, to keep load on their servers low.
  const camMarkers = {};
  let camOpenId = null;
  let hlsPlayer = null;
  const camIcon = (live) => L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="cam-pin${live ? "" : " off"}" title="CCTV">📹</div>` });

  function stopVideo() {
    if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; }
  }

  function camPopupHtml(c) {
    return `<div class="cam-pop"><b>${esc(c.title)}</b><br><small>${esc(c.org)} · ${esc(c.id)}</small>
      <div class="cam-video"><video muted playsinline controls preload="none"></video><div class="cam-msg">กำลังโหลดภาพสด…</div></div>
      <small>${c.district ? "เขต" + esc(c.district) + " · " : ""}ตรวจสถานะ ${fmtTime(c.checked)} · <a href="${safeUrl(c.link)}" target="_blank" rel="noopener">เปิดในหน้าต่างใหม่</a></small></div>`;
  }

  function playCamera(c, root) {
    stopVideo();
    const video = root.querySelector("video");
    const msg = root.querySelector(".cam-msg");
    const fail = (t) => { msg.textContent = t; msg.hidden = false; };
    if (!c.live) return fail("กล้องนี้ออฟไลน์ในรอบตรวจล่าสุด");
    video.addEventListener("playing", () => { msg.hidden = true; }, { once: true });
    if (window.Hls && Hls.isSupported()) {
      hlsPlayer = new Hls({ maxBufferLength: 10, liveSyncDurationCount: 2 });
      hlsPlayer.on(Hls.Events.ERROR, (_, e) => {
        if (!e.fatal) return;
        const codec = /codec|incompatible/i.test(e.details || "");
        fail(codec ? "เบราว์เซอร์นี้เล่นวิดีโอ H.264 ไม่ได้ — ลองเปิดในหน้าต่างใหม่" : "เปิดภาพสดไม่ได้ — กล้องอาจออฟไลน์");
        stopVideo();
      });
      hlsPlayer.loadSource(c.hls);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = c.hls;  // Safari / iOS plays HLS natively
      video.play().catch(() => {});
      video.addEventListener("error", () => fail("เปิดภาพสดไม่ได้ — กล้องอาจออฟไลน์"), { once: true });
    } else {
      fail("เบราว์เซอร์นี้เล่นภาพสดไม่ได้");
    }
  }

  function drawCameras(cams) {
    layers.cctv.clearLayers();
    Object.keys(camMarkers).forEach((k) => delete camMarkers[k]);
    cams.forEach((c) => {
      const m = L.marker([c.lat, c.lon], { icon: camIcon(c.live), zIndexOffset: 500, title: c.title })
        .bindPopup(() => camPopupHtml(c), { maxWidth: 340, minWidth: 260, autoPanPadding: [20, 20] });
      m.on("popupopen", (e) => { camOpenId = c.id; playCamera(c, e.popup.getElement()); });
      m.on("popupclose", () => { if (camOpenId === c.id) { camOpenId = null; stopVideo(); } });
      camMarkers[c.id] = m;
      m.addTo(layers.cctv);
    });
  }

  function camsNear(lat, lon, km, max) {
    return (DATA && DATA.cameras || []).filter((c) => c.live)
      .map((c) => ({ c, d: kmBetween(lat, lon, c.lat, c.lon) }))
      .filter((x) => x.d <= km).sort((a, b) => a.d - b.d).slice(0, max);
  }
  const camButtons = (list) => list.map(({ c, d }) =>
    `<button type="button" class="camlink" data-cam="${esc(c.id)}">📹 ${esc(c.title)}${d != null ? ` <small>· ${d.toFixed(1)} กม.</small>` : ""}</button>`).join("");

  function openCamera(id) {
    const m = camMarkers[id];
    if (!m) return;
    if (!map.hasLayer(layers.cctv)) layers.cctv.addTo(map);
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
    m.openPopup();
    if (window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".camlink");
    if (b) { e.preventDefault(); openCamera(b.dataset.cam); }
  });

  // ------------------------------------------------------------- time/topic filters (lists and map)
  const minsAgo = (t) => (Date.now() - new Date(t)) / 60000;
  // Read a filter control; tolerate a cached older page that lacks it
  const val = (sel, dflt = "") => { const el = $(sel); return el ? (el.type === "checkbox" ? el.checked : el.value.trim()) : dflt; };
  const newsCats = new Set();
  let newsWin = "1440";

  function filteredEvents() {
    if (!DATA) return [];
    const q = val("#rq");
    const col = val("#rcolor");
    const off = val("#rofficial", false);
    const win = val("#rtime", "active");
    return (DATA.events || []).filter((e) =>
      (win === "active" ? new Date(e.stop) >= Date.now() : (win === "0" || minsAgo(e.start) <= +win)) &&
      (!q || e.title.includes(q) || e.text.includes(q) || (e.district || "").includes(q)) &&
      (!col || e.color === col) && (!off || e.official));
  }

  function filteredNews() {
    if (!DATA) return [];
    const q = val("#nq");
    const win = +val("#ntime", newsWin);
    return DATA.news.filter((n) => (!win || minsAgo(n.time) <= win) &&
      (!q || n.title.includes(q) || n.districts.some((d) => d.includes(q))) &&
      (!newsCats.size || [...newsCats].some((c) => (c === "social" ? n.kind === "social" : n.categories.includes(c)))));
  }

  // one pin per district, with the number of matching headlines
  function drawNewsPins(news) {
    layers.news.clearLayers();
    const byDist = new Map();
    news.forEach((n) => n.districts.forEach((d) => { if (!byDist.has(d)) byDist.set(d, []); byDist.get(d).push(n); }));
    for (const [d, items] of byDist) {
      const z = byId[d];
      if (!z) continue;
      L.marker([z.lat, z.lon], { zIndexOffset: 400, title: `ข่าว ${d}`, icon: L.divIcon({ className: "", iconSize: [34, 22], iconAnchor: [17, 11],
        html: `<div class="news-pin">📰 ${items.length}</div>` }) })
        .bindPopup(`<b>ข่าวในเขต${esc(d)}</b> <small>(${items.length})</small><ul class="pop-news">${items.slice(0, 6).map((n) =>
          `<li><a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><br><small>${fmtTime(n.time)}${n.via && n.via[d] ? " · จับคู่จาก " + esc(n.via[d]) : ""}</small></li>`).join("")}</ul>`, { maxWidth: 320 })
        .addTo(layers.news);
    }
  }

  // ------------------------------------------------------------- canal lines & road incidents
  const canalLayerByName = {};
  const statusOfCanal = (name) => (DATA.canals.find((c) => c.name === name) || {}).status || "unknown";

  // Waterways are blue; only the stretch around a gauge above its warning level takes that gauge's colour
  const ALERT_KM = 1.5;
  const ALERT_RANK = { warning: 1, critical: 2, overbank: 3 };
  const waterWeight = (river, alert) => {
    const z = map.getZoom();
    const base = z <= 10 ? 1.2 : z <= 11 ? 1.6 : z <= 12 ? 2.2 : z <= 13 ? 3 : 4;
    return base * (river ? 2 : 1) + (alert ? 3 : 0);
  };
  function nearRuns(lines, g) {
    const kx = 111.32 * Math.cos(g.lat * Math.PI / 180), ky = 110.57;
    const near = ([x, y]) => Math.hypot((x - g.lon) * kx, (y - g.lat) * ky) <= ALERT_KM;
    const runs = [];
    for (const ln of lines) {
      let run = null;
      for (let i = 0; i < ln.length - 1; i++) {
        if (near(ln[i]) || near(ln[i + 1])) {
          if (!run) { run = [ln[i]]; runs.push(run); }
          run.push(ln[i + 1]);
        } else run = null;
      }
    }
    return runs.map((r) => r.map(([x, y]) => [y, x]));
  }

  function drawCanalLines() {
    layers.canalLines.clearLayers();
    Object.keys(canalLayerByName).forEach((k) => delete canalLayerByName[k]);
    if (!CANAL_GEO) return;
    const alertGauges = [...DATA.stations.canal, ...DATA.stations.river]
      .filter((g) => ALERT_RANK[g.status] && g.canal)
      .sort((a, b) => ALERT_RANK[a.status] - ALERT_RANK[b.status]);
    L.geoJSON(CANAL_GEO, {
      pane: "water",
      style: (f) => ({ color: CANAL_COLOR.normal, weight: waterWeight(f.properties.name.startsWith("แม่น้ำ"), false), opacity: 0.9, lineCap: "round" }),
      onEachFeature: (f, lyr) => {
        const c = DATA.canals.find((x) => x.name === f.properties.name);
        canalLayerByName[f.properties.name] = lyr;
        lyr.bindTooltip(`${esc(f.properties.name)}${c ? " · " + STATUS[c.status].th : ""}`, { sticky: true });
        lyr.on("click", () => { selectTab("canals"); $("#cq").value = f.properties.name; $("#cstatus").value = ""; $("#cdist").value = ""; renderCanals(); focusCanal(f.properties.name, false); });
      },
    }).addTo(layers.canalLines);
    // alert stretches on top, worst drawn last
    for (const g of alertGauges) {
      const lyr = canalLayerByName[g.canal];
      if (!lyr) continue;
      const geom = lyr.feature.geometry;
      const runs = nearRuns(geom.type === "LineString" ? [geom.coordinates] : geom.coordinates, g);
      if (!runs.length) continue;
      L.polyline(runs, { pane: "water", color: CANAL_COLOR[g.status], weight: waterWeight(g.canal.startsWith("แม่น้ำ"), true), opacity: 0.95, lineCap: "round", alert: true, river: g.canal.startsWith("แม่น้ำ") })
        .bindTooltip(`${esc(g.canal)} · ${esc(g.name)} · ${STATUS[g.status].th}`, { sticky: true })
        .on("click", () => lyr.fire("click"))
        .addTo(layers.canalLines);
    }
  }
  map.on("zoomend", () => layers.canalLines.eachLayer(function restyle(l) {
    if (l.eachLayer && !l.feature) { l.eachLayer(restyle); return; }
    const river = l.options.alert ? l.options.river : (l.feature?.properties.name || "").startsWith("แม่น้ำ");
    l.setStyle?.({ weight: waterWeight(river, !!l.options.alert) });
  }));

  // distance (km) from point to a polyline, equirectangular approximation
  function kmToLine(lat, lon, coords) {
    const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
    let best = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const [ax, ay] = coords[i - 1], [bx, by] = coords[i];
      const x1 = (ax - lon) * kx, y1 = (ay - lat) * ky, x2 = (bx - lon) * kx, y2 = (by - lat) * ky;
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
    }
    return best;
  }
  const roadMatch = (evKey, roadKey) => evKey && roadKey && (evKey.includes(roadKey) || roadKey.includes(evKey.split(/\d/)[0]));

  const eventMarkers = {};
  function drawEvents(events) {
    layers.events.clearLayers();
    layers.roadLines.clearLayers();
    Object.keys(eventMarkers).forEach((k) => delete eventMarkers[k]);
    events.forEach((e) => {
      const c = ROADC[e.color];
      const size = e.official ? 18 : 14;
      const m = L.marker([e.lat, e.lon], { zIndexOffset: 300 + c.rank * 10, title: e.title, icon: L.divIcon({ className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        html: `<div class="ev-pin" style="background:${c.hex};width:${size}px;height:${size}px;font-size:${size - 6}px">!</div>` }) })
        .bindPopup(`<b>${esc(e.title)}</b> <span class="pill" style="background:${c.hex}">${c.th}</span><br>${esc(e.text)}<br>
          ${e.depth_cm ? `ความลึกที่รายงาน ~${e.depth_cm} ซม.<br>` : ""}<small>${fmtTime(e.start)} – ${fmtTime(e.stop)} · ${esc(e.source)}${e.district ? " · เขต" + esc(e.district) : ""}</small>`);
      eventMarkers[e.id] = m;
      m.addTo(layers.events);
    });
    if (!ROAD_GEO) return;
    // colour only the road ways near a report on the same road (within 300 m), worst colour wins
    const worst = new Map();
    for (const e of events) {
      if (!e.road_key) continue;
      for (const f of ROAD_GEO.features) {
        if (!roadMatch(e.road_key, f.properties.key)) continue;
        if (kmToLine(e.lat, e.lon, f.geometry.coordinates) > 0.3) continue;
        const prev = worst.get(f);
        if (!prev || ROADC[e.color].rank > ROADC[prev.color].rank) worst.set(f, e);
      }
    }
    for (const [f, e] of worst) {
      const news = DATA.news.filter((n) => n.title.includes(f.properties.key.slice(0, 6))).slice(0, 3);
      L.geoJSON(f, { style: { color: ROADC[e.color].hex, weight: 7, opacity: 0.75 } })
        .bindPopup(`<b>${esc(f.properties.name)}</b> <span class="pill" style="background:${ROADC[e.color].hex}">${ROADC[e.color].th}</span><br>
          <small>รายงานล่าสุดใกล้ช่วงนี้: ${esc(e.title)} · ${fmtTime(e.start)} · ${esc(e.source)}</small>
          ${news.length ? `<br><b>ข่าวที่กล่าวถึงถนนนี้</b><ul>${news.map((n) => `<li><a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></li>`).join("")}</ul>` : ""}`)
        .addTo(layers.roadLines);
    }
  }

  function renderRoads() {
    if (!$("#rlist")) { drawEvents(filteredEvents()); return; }
    const rank = (e) => -ROADC[e.color].rank;
    const shown = filteredEvents();
    drawEvents(shown);
    const list = [...shown].sort((a, b) => rank(a) - rank(b) || (a.start < b.start ? 1 : -1));
    const n = (c) => shown.filter((e) => e.color === c).length;
    $("#rcount").innerHTML = `${list.length} รายงาน · <b style="color:${ROADC.red.hex}">แดง ${n("red")}</b> · <b style="color:${ROADC.orange.hex}">ส้ม ${n("orange")}</b> · เหลือง ${n("yellow")} · เขียว ${n("green")} · แตะเพื่อดูบนแผนที่`;
    $("#rlist").innerHTML = list.slice(0, 200).map((e) => `<li class="ev" data-ev="${esc(e.id)}"><span class="pill" style="background:${ROADC[e.color].hex}">${ROADC[e.color].th}</span>
      ${e.official ? `<span class="tag official">${esc(e.source)}</span>` : ""}<b>${esc(e.title)}</b>
      <span class="m">${esc(e.text.slice(0, 140))}</span><span class="m">${fmtTime(e.start)}${e.district ? " · เขต" + esc(e.district) : ""}${e.depth_cm ? ` · ลึก ~${e.depth_cm} ซม.` : ""}</span></li>`).join("") || `<li class="empty">ไม่มีรายงานที่ตรงเงื่อนไข</li>`;
    document.querySelectorAll("#rlist li[data-ev]").forEach((li) => li.addEventListener("click", () => {
      const m = eventMarkers[li.dataset.ev];
      if (!m) return;
      if (!map.hasLayer(layers.events)) layers.events.addTo(map);
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
      m.openPopup();
      if (window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
    }));
  }

  // ------------------------------------------------------------- panel
  function evidenceList(items) {
    if (!items.length) return `<p class="empty">ไม่มี</p>`;
    return `<ul>${items.map((e) => {
      const txt = e.link ? `<a href="${safeUrl(e.link)}" target="_blank" rel="noopener">${esc(e.text)}</a>` : esc(e.text);
      return `<li>${txt} <small>(+${e.points}) · ${fmtTime(e.time)} · ${esc(e.source_id)}${e.station ? ":" + esc(e.station) : ""}</small></li>`;
    }).join("")}</ul>`;
  }

  function districtCard(z) {
    const w = z.window;
    const when = w ? `ฝนเริ่ม ~${fmtTime(w.start)} · หนักสุด ~${fmtTime(w.peak)} (${w.peak_mm} มม./ชม.)` : "ไม่มีฝนมีนัยสำคัญใน 12 ชม.";
    return `<details class="zone" id="z-${esc(z.id)}" style="--lv:${LEVEL[z.level].hex}" ${z.level === "severe" ? "open" : ""}>
      <summary><span class="zn">${esc(z.name)} <small>${esc(z.name_en)} · ${esc(z.province)}</small></span>
        <span class="badge">${LEVEL[z.level].th}</span>
        <span class="meta">คะแนน ${z.score} · ความเชื่อมั่น${CONF[z.confidence]} · จุดวัดน้ำ ${z.gauges} · ${when}</span></summary>
      <div class="body">
        ${EVIDENCE.map(([k, label]) => `<h4>${label}</h4>${evidenceList(z.evidence[k])}`).join("")}
        ${z.notes.map((n) => `<p class="empty">${esc(n)}</p>`).join("")}
        <div class="advice"><b>ควรทำอะไร:</b> ${esc(z.advice)}</div>
        ${(() => { const cams = camsNear(z.lat, z.lon, 5, 3);
          return cams.length ? `<h4>กล้อง CCTV ใกล้เขตนี้ (ดูภาพสดเพื่อยืนยันน้ำท่วม)</h4><div class="cams">${camButtons(cams)}</div>` : ""; })()}
        <button type="button" class="zoom" data-id="${esc(z.id)}">ดูบนแผนที่</button>
      </div></details>`;
  }

  function renderDistricts() {
    const q = $("#dq").value.trim().toLowerCase();
    const prov = $("#dprov").value;
    const lv = $("#dlevel").value;
    const list = DATA.districts.filter((z) =>
      (!q || z.name.includes(q) || (z.name_en || "").toLowerCase().includes(q)) &&
      (!prov || (prov === "bkk" ? z.province === "กรุงเทพมหานคร" : z.province !== "กรุงเทพมหานคร")) &&
      (!lv || z.level === lv));
    $("#dlist").innerHTML = list.map(districtCard).join("") || `<p class="empty">ไม่พบเขตที่ตรงเงื่อนไข</p>`;
    $("#dcount").textContent = `${list.length} เขต/อำเภอ`;
    document.querySelectorAll("#dlist .zoom").forEach((b) => b.addEventListener("click", () => zoomDistrict(b.dataset.id)));
  }

  function renderCanals() {
    const q = val("#cq");
    const st = val("#cstatus");
    const dist = val("#cdist");
    const sel = $("#cdist");
    if (sel && sel.options.length <= 1) {
      const ds = [...new Set(DATA.canals.flatMap((c) => c.districts))].sort((a, b) => a.localeCompare(b, "th"));
      sel.insertAdjacentHTML("beforeend", ds.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join(""));
    }
    const list = DATA.canals.filter((c) => (!q || c.name.includes(q) || c.districts.some((d) => d.includes(q))) &&
      (!st || (st === "alert" ? ["overbank", "critical", "warning"].includes(c.status) : c.status === st)) &&
      (!dist || c.districts.includes(dist)));
    $("#ccount").textContent = `${list.length} คลอง/แม่น้ำ · แตะแถวเพื่อดูเส้นคลองและจุดวัดบนแผนที่`;
    $("#clist").innerHTML = `<table class="canals"><tr><th>คลอง</th><th>สถานะ</th><th>จุดที่หนักสุด</th></tr>
      ${list.map((c) => {
        const w = c.worst;
        const wtxt = w ? `${esc(w.name)}<br><small>${num(w.value)} ม.${w.bank != null ? " / ตลิ่ง " + num(w.bank) : ""}${w.bank_percent != null ? " (" + w.bank_percent.toFixed(0) + "%)" : ""} · ${fmtTime(w.time)}</small>` : "–";
        const counts = [c.overbank && `ล้น ${c.overbank}`, c.critical && `วิกฤต ${c.critical}`, c.warning && `เฝ้าระวัง ${c.warning}`].filter(Boolean).join(" · ");
        return `<tr data-canal="${esc(c.name)}"><td><b>${esc(c.name)}</b>${canalLayerByName[c.name] ? "" : ' <small title="ไม่พบเส้นคลองใน OpenStreetMap">(ไม่มีเส้น)</small>'}<br><small>${c.districts.map(esc).join(", ")}</small>${c.news ? `<br><small class="warn">ข่าว ${c.news}</small>` : ""}</td>
          <td><span class="pill" style="background:${STATUS[c.status].hex}">${STATUS[c.status].th}</span><br><small>จุดวัด ${c.reporting}/${c.gauges}${counts ? "<br>" + counts : ""}</small>${c.rising ? `<br><small class="bad">▲ ขึ้น ${c.rising} จุด</small>` : ""}</td>
          <td>${wtxt}</td></tr>`;
      }).join("")}</table>`;
    document.querySelectorAll("#clist tr[data-canal]").forEach((tr) => tr.addEventListener("click", () => focusCanal(tr.dataset.canal)));
  }

  function focusCanal(name, move = true) {
    layers.highlight.clearLayers();
    const gs = [...DATA.stations.canal, ...DATA.stations.river].filter((g) => g.canal === name);
    const lineLyr = canalLayerByName[name];
    let bounds = null;
    if (lineLyr) {
      const glow = L.geoJSON(lineLyr.feature, { style: { color: "#0b6bcb", weight: 10, opacity: 0.35 }, interactive: false }).addTo(layers.highlight);
      L.geoJSON(lineLyr.feature, { style: { color: CANAL_COLOR[statusOfCanal(name)], weight: 5, opacity: 1 }, interactive: false }).addTo(layers.highlight);
      bounds = glow.getBounds();
    }
    gs.forEach((g) => L.circleMarker([g.lat, g.lon], { radius: 11, color: "#0b6bcb", weight: 3, fill: false }).bindPopup(gaugePopup(g)).addTo(layers.highlight));
    if (gs.length) {
      const gb = L.latLngBounds(gs.map((g) => [g.lat, g.lon]));
      bounds = bounds ? bounds.extend(gb) : gb;
    }
    if (!bounds) return;
    if (move) map.fitBounds(bounds.pad(0.15), { maxZoom: 15 });
    if (move && window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
  }

  function syncNewsbar(list) {
    const win = val("#ntime", newsWin);
    document.querySelectorAll("#mntime button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.win === win)));
    const pinned = list.filter((n) => n.districts.length).length;
    if ($("#nbcount")) $("#nbcount").textContent = `${pinned} ข่าว`;
  }

  function renderNews() {
    const d = DATA;
    const list = filteredNews();
    drawNewsPins(list);
    syncNewsbar(list);
    if (!$("#nlist")) return;
    const official = (d.official || []).map((o) =>
      `<li><span class="tag official">GDACS ${esc(o.level)}</span><a href="${safeUrl(o.link)}" target="_blank" rel="noopener">${esc(o.title)}</a></li>`).join("");
    const pinned = list.filter((n) => n.districts.length).length;
    $("#ncount").textContent = `${list.length} ข่าว · ปักหมุดบนแผนที่ ${pinned} ข่าว`;
    $("#nlist").innerHTML = official + (list.map((n) => `
      <li>${n.kind === "social" ? `<span class="tag social">โซเชียล</span>` : ""}${n.categories.map((c) => `<span class="tag c-${c}">${CAT[c] || c}</span>`).join("")}
        <a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
        <span class="m">${fmtTime(n.time)} · ${esc(n.source)}${n.districts.length ? ` · <button type="button" class="linkish" data-news-dist="${esc(n.districts[0])}">เขต: ${n.districts.map(esc).join(", ")}</button>` : ""}${n.canals.length ? " · " + n.canals.map(esc).join(", ") : ""}</span></li>`).join("")
      || `<li class="empty">ไม่มีข่าวในช่วงเวลา/หัวข้อที่เลือก</li>`);
    document.querySelectorAll("#nlist [data-news-dist]").forEach((b) => b.addEventListener("click", () => {
      const z = byId[b.dataset.newsDist];
      if (!z) return;
      if (!map.hasLayer(layers.news)) layers.news.addTo(map);
      map.setView([z.lat, z.lon], Math.max(map.getZoom(), 13));
      layers.news.eachLayer((m) => { if (m.getLatLng().equals([z.lat, z.lon])) m.openPopup(); });
      if (window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
    }));
  }

  function renderSources() {
    const d = DATA;
    $("#tab-sources").innerHTML = `<table><tr><th>แหล่ง</th><th>ประเภท</th><th>สถานะ</th><th>ข้อมูลล่าสุด</th></tr>
      ${d.sources.map((s) => `<tr><td><a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a><br><small>${esc(s.id)}</small></td>
        <td>${esc(s.kind)}</td>
        <td class="${s.ok ? "ok" : "bad"}">${s.ok ? "OK" : "ล้มเหลว"}<br><small>${s.ok ? s.count + " รายการ" + (s.stale_records ? `, เก่า ${s.stale_records}` : "") + (s.filtered_out ? `, คัดออก ${s.filtered_out}` : "") : esc(s.error)}</small></td>
        <td>${fmtTime(s.latest)}</td></tr>`).join("")}</table>${riverTable(d.river)}`;
  }

  function riverTable(river) {
    if (!river || !river.length) return "";
    return `<h3>อัตราการไหลแม่น้ำ (GloFAS, ลบ.ม./วินาที)</h3><table><tr><th>วันที่</th>${river.map((r) => `<th>${esc(r.name)}</th>`).join("")}</tr>
      ${river[0].days.map((day, i) => `<tr><td>${esc(day)}</td>${river.map((r) => `<td>${r.discharge[i] != null ? Math.round(r.discharge[i]) : "–"}</td>`).join("")}</tr>`).join("")}</table>
      <p class="empty">ค่าจากแบบจำลองระดับโลก ความละเอียดหยาบ ใช้ดูแนวโน้มเท่านั้น</p>`;
  }

  function renderSummary() {
    const counts = { severe: 0, warning: 0, watch: 0, normal: 0 };
    DATA.districts.forEach((z) => counts[z.level]++);
    const g = DATA.stations.canal.concat(DATA.stations.river);
    const over = g.filter((x) => x.status === "overbank").length;
    const crit = g.filter((x) => x.status === "critical").length;
    $("#summary").innerHTML = Object.entries(counts)
      .map(([k, n]) => `<button type="button" class="n" data-level="${k}" style="background:${LEVEL[k].hex}"><b>${n}</b><small>${LEVEL[k].th}</small></button>`).join("") +
      `<div class="gsum">เขต/อำเภอ ${DATA.districts.length} · จุดวัดน้ำ ${g.length} จุด: <b class="bad">ล้นตลิ่ง ${over}</b> · <b class="warn">เกินวิกฤต ${crit}</b></div>`;
    document.querySelectorAll("#summary .n").forEach((b) => b.addEventListener("click", () => {
      selectTab("districts"); $("#dlevel").value = b.dataset.level; renderDistricts();
    }));
  }

  function zoomDistrict(id) {
    const lyr = districtLayers[id];
    if (lyr) map.fitBounds(lyr.getBounds().pad(0.2));
    if (window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
  }

  function openDistrict(id) {
    selectTab("districts");
    $("#dq").value = ""; $("#dprov").value = ""; $("#dlevel").value = ""; renderDistricts();
    const el = document.getElementById("z-" + id);
    if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }

  function selectTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
    pref("fw-tab", name);
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  ["#dq", "#dprov", "#dlevel"].forEach((s) => $(s)?.addEventListener("input", renderDistricts));
  ["#cq", "#cstatus", "#cdist"].forEach((s) => $(s)?.addEventListener("input", renderCanals));
  ["#rq", "#rcolor", "#rofficial", "#rtime"].forEach((s) => $(s)?.addEventListener("input", renderRoads));
  ["#nq", "#ntime"].forEach((s) => $(s)?.addEventListener("input", renderNews));
  document.querySelectorAll("#ncats button, #mncats button").forEach((b) => b.addEventListener("click", () => {
    const c = b.dataset.cat;
    if (newsCats.has(c)) newsCats.delete(c); else newsCats.add(c);
    document.querySelectorAll(`#ncats button[data-cat="${c}"], #mncats button[data-cat="${c}"]`).forEach((x) => x.setAttribute("aria-pressed", String(newsCats.has(c))));
    renderNews();
  }));
  // map news bar: time segments mirror the news-tab dropdown
  document.querySelectorAll("#mntime button").forEach((b) => b.addEventListener("click", () => {
    if ($("#ntime")) $("#ntime").value = b.dataset.win;
    newsWin = b.dataset.win;
    renderNews();
  }));
  const nbToggle = $("#nbtoggle");
  const setNewsbar = (open) => { $("#newsbar")?.classList.toggle("closed", !open); nbToggle?.setAttribute("aria-expanded", String(open)); };
  nbToggle?.addEventListener("click", () => setNewsbar($("#newsbar").classList.contains("closed")));
  setNewsbar(window.innerWidth >= 800);
  map.on("overlayadd overlayremove", (e) => { if (e.layer === layers.news) $("#newsbar").hidden = e.type === "overlayremove"; });
  $("#links").innerHTML = LINKS.map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("");

  // ------------------------------------------------------------- my location (GPS)
  // Uses the browser Geolocation API; the position stays on this device.
  const me = { watch: null, pos: null, follow: true, first: true, error: null };
  const kmBetween = (a, b, c, d) => {
    const p = Math.PI / 180;
    const x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  };
  const inRing = (lon, lat, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  function districtAt(lat, lon) {
    if (!GEO) return null;
    for (const f of GEO.features) {
      const g = f.geometry;
      const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
      if (polys.some((poly) => inRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lon, lat, h)))) return f.properties.id;
    }
    return null;
  }
  const meIcon = L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });

  function renderMine() {
    const box = $("#mine");
    if (!me.watch && !me.error) { box.hidden = true; return; }
    box.hidden = false;
    if (me.error) {
      box.className = "mine err";
      box.innerHTML = `<h3>ตำแหน่งของฉัน</h3><p class="advice">${esc(me.error)}</p>`;
      return;
    }
    if (!me.pos) {
      box.className = "mine"; box.style.removeProperty("--lv");
      box.innerHTML = `<h3>ตำแหน่งของฉัน</h3><p class="meta">กำลังหาตำแหน่ง GPS…</p>`;
      return;
    }
    const { lat, lon, acc, time } = me.pos;
    const id = districtAt(lat, lon);
    const z = id && DATA ? byId[id] : null;
    const gauges = DATA ? [...DATA.stations.canal, ...DATA.stations.river]
      .filter((g) => g.status !== "unknown")
      .map((g) => ({ g, d: kmBetween(lat, lon, g.lat, g.lon) }))
      .filter((x) => x.d <= 3).sort((a, b) => a.d - b.d).slice(0, 3) : [];
    const rain = DATA ? DATA.stations.rain.filter((r) => !r.flags.length)
      .map((r) => ({ r, d: kmBetween(lat, lon, r.lat, r.lon) })).sort((a, b) => a.d - b.d)[0] : null;
    box.className = "mine";
    if (z) box.style.setProperty("--lv", LEVEL[z.level].hex); else box.style.removeProperty("--lv");
    const where = z ? `${esc(z.name)} <small>${esc(z.province)}</small>` : "นอกพื้นที่ที่ระบบครอบคลุม";
    box.innerHTML = `<h3><span>📍 ${where}</span>${z ? `<span class="badge">${LEVEL[z.level].th}</span>` : ""}</h3>
      <div class="meta">ความแม่นยำ ±${Math.round(acc)} ม. · ${new Date(time).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" })}${z ? ` · คะแนนเขต ${z.score} · ความเชื่อมั่น${CONF[z.confidence]}` : ""}</div>
      ${z ? `<p class="advice"><b>ควรทำอะไร:</b> ${esc(z.advice)}</p>` : ""}
      ${gauges.length ? `<b style="font-size:.85rem">จุดวัดน้ำใกล้คุณ</b><ul>${gauges.map(({ g, d }) =>
        `<li>${esc(g.name)} — <b style="color:${STATUS[g.status].hex}">${STATUS[g.status].th}</b> <small>${d.toFixed(1)} กม. · ${fmtTime(g.time)}</small></li>`).join("")}</ul>`
        : `<p class="meta">ไม่มีจุดวัดระดับน้ำในรัศมี 3 กม.</p>`}
      ${rain ? `<div class="meta">ฝนใกล้สุด: ${esc(rain.r.name)} (${rain.d.toFixed(1)} กม.) · 1 ชม. ${rain.r.rain_1h ?? "–"} มม. · 24 ชม. ${rain.r.rain_24h ?? "–"} มม.</div>` : ""}
      ${(() => { const cams = camsNear(lat, lon, 5, 2);
        return cams.length ? `<b style="font-size:.85rem">กล้อง CCTV ใกล้คุณ</b><div class="cams">${camButtons(cams)}</div>` : `<div class="meta">ไม่มีกล้อง CCTV ที่ออนไลน์ในรัศมี 5 กม.</div>`; })()}
      <div class="row">${z ? `<button type="button" data-act="detail">ดูรายละเอียดเขต</button>` : ""}
        <button type="button" data-act="center">กลับไปที่ตำแหน่ง</button><button type="button" data-act="stop">ปิด GPS</button></div>`;
    box.querySelector('[data-act="detail"]')?.addEventListener("click", () => openDistrict(id));
    box.querySelector('[data-act="center"]').addEventListener("click", () => { me.follow = true; map.setView([lat, lon], Math.max(map.getZoom(), 14)); });
    box.querySelector('[data-act="stop"]').addEventListener("click", stopLocate);
  }

  function drawMe() {
    layers.me.clearLayers();
    if (!me.pos) return;
    const { lat, lon, acc } = me.pos;
    L.circle([lat, lon], { radius: acc, color: "#1a73e8", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(layers.me);
    L.marker([lat, lon], { icon: meIcon, keyboard: false }).bindTooltip("ตำแหน่งของฉัน").addTo(layers.me);
    if (me.first || me.follow) {
      map.setView([lat, lon], me.first ? 14 : map.getZoom());
      me.first = false;
    }
  }

  function startLocate() {
    me.error = null;
    if (!("geolocation" in navigator)) { me.error = "เบราว์เซอร์นี้ไม่รองรับ GPS"; renderMine(); return; }
    if (!window.isSecureContext) { me.error = "ต้องเปิดผ่าน https:// จึงจะใช้ GPS ได้"; renderMine(); return; }
    me.first = true; me.follow = true;
    $("#locate").setAttribute("aria-pressed", "true");
    $("#locate").classList.add("busy");
    me.watch = navigator.geolocation.watchPosition((p) => {
      me.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, time: p.timestamp };
      $("#locate").classList.remove("busy");
      drawMe(); renderMine();
    }, (err) => {
      const msg = { 1: "ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — เปิดสิทธิ์ Location ของเบราว์เซอร์สำหรับเว็บนี้ แล้วกดปุ่มอีกครั้ง",
        2: "หาตำแหน่งไม่ได้ — ตรวจว่าเปิด GPS/Location ในเครื่องแล้ว", 3: "หาตำแหน่งนานเกินไป — ลองอีกครั้งในที่โล่ง" }[err.code] || err.message;
      if (err.code === 1 || !me.pos) { stopLocate(); me.error = msg; }
      renderMine();
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
    pref("fw-geo", "on");
    renderMine();
  }

  function stopLocate() {
    if (me.watch != null) navigator.geolocation.clearWatch(me.watch);
    me.watch = null; me.pos = null; me.error = null;
    layers.me.clearLayers();
    $("#locate").setAttribute("aria-pressed", "false");
    $("#locate").classList.remove("busy");
    pref("fw-geo", "off");
    renderMine();
  }

  $("#locate").addEventListener("click", () => {
    if (me.watch == null) startLocate();
    else if (me.pos) { me.follow = true; map.setView([me.pos.lat, me.pos.lon], Math.max(map.getZoom(), 14)); }
  });
  map.on("dragstart", () => { me.follow = false; });
  // Resume tracking on return visits only if permission was already granted (no surprise prompt)
  if (pref("fw-geo") === "on" && navigator.permissions) {
    navigator.permissions.query({ name: "geolocation" }).then((st) => { if (st.state === "granted") startLocate(); }).catch(() => {});
  }

  // ------------------------------------------------------------- load
  // Static line layers are optional and large: load in the background, redraw when they arrive
  let linesLoading = null;
  function loadLines() {
    if (linesLoading) return;
    const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    linesLoading = Promise.all([get(CANALS_URL), get(ROADS_URL)]).then(([c, r]) => {
      CANAL_GEO = c; ROAD_GEO = r;
      if (!DATA) return;
      try { drawCanalLines(); renderRoads(); } catch (err) { console.error("lines", err); }
    });
  }

  async function load() {
    try {
      if (!GEO) GEO = await (await fetch(DISTRICTS_URL)).json();
      loadLines();
      const r = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const next = await r.json();
      if (!next.districts) throw new Error("ข้อมูลรุ่นเก่า รอรอบอัปเดตถัดไป");
      DATA = next;
      Object.keys(byId).forEach((k) => delete byId[k]);
      DATA.districts.forEach((z) => (byId[z.id] = z));
      drawMap(DATA);
      for (const fn of [renderSummary, renderDistricts, renderCanals, renderNews, renderSources, renderMine, renderRoads]) {
        try { fn(); } catch (err) { console.error(fn.name, err); }
      }
      const ageMin = (Date.now() - new Date(DATA.generated_at)) / 60000;
      $("#updated").textContent = `อัปเดต ${fmtTime(DATA.generated_at)} (${ago(DATA.generated_at)})`;
      const banner = $("#banner");
      const severe = DATA.districts.filter((z) => z.level === "severe");
      if (ageMin > STALE_MIN) {
        banner.hidden = false; banner.className = "banner stale";
        banner.textContent = `ข้อมูลไม่ได้อัปเดตมา ${Math.round(ageMin)} นาที — ระบบดึงข้อมูลอาจขัดข้อง`;
      } else if (severe.length) {
        banner.hidden = false; banner.className = "banner";
        banner.textContent = `ระดับอันตราย: ${severe.map((z) => z.name).join(", ")} — ${severe[0].advice}`;
      } else {
        banner.hidden = true;
      }
    } catch (e) {
      $("#updated").textContent = "โหลดข้อมูลไม่สำเร็จ: " + e.message;
    }
  }

  $("#reload").addEventListener("click", () => { load(); loadRadar(); });
  const t = pref("fw-tab");
  if (t && document.getElementById("tab-" + t)) selectTab(t);
  load();
  loadRadar();
  setInterval(() => { load(); if (!radarTimer) loadRadar(); }, REFRESH_MS);
})();
