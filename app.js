(() => {
  const DATA_URL = "data/latest.json";
  const DISTRICTS_URL = "data/districts.geojson";
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
    normal: { th: "ปกติ", hex: "#2e9d5b" },
    unknown: { th: "ไม่มีข้อมูล", hex: "#8a94a0" },
  };
  const CONF = { high: "สูง", medium: "ปานกลาง", low: "ต่ำ" };
  const CAT = { rising: "น้ำเพิ่ม", flooding: "น้ำท่วม", warning: "เตือนภัย", rain: "ฝนหนัก" };
  const EVIDENCE = [
    ["measured", "ตรวจวัดแล้ว"],
    ["forecast", "แบบจำลองคาดการณ์"],
    ["reported", "รายงานจากข่าว/โซเชียล (รอยืนยัน)"],
    ["confirmed", "ยืนยันผลกระทบแล้ว"],
  ];
  const FILTER_REASON = {
    "opinion/emotion": "ความเห็น/อารมณ์", "question/exclamation": "พาดหัวคำถาม/อุทาน",
    "official activity/politics": "การประชุม/การเมือง", "receding/relief": "น้ำลด/แจกของ",
    "not about rising water/flooding": "ไม่เกี่ยวกับน้ำเพิ่ม/ท่วม", "rain only, no impact": "พยากรณ์ฝนอย่างเดียว",
  };
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

  let DATA = null, GEO = null;
  const byId = {};
  const districtLayers = {};

  // ------------------------------------------------------------- map
  const map = L.map("map", { zoomControl: true }).setView([13.76, 100.58], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ThaiWater, สำนักการระบายน้ำ กทม., Open-Meteo, GloFAS, RainViewer',
  }).addTo(map);

  const layers = {
    districts: L.layerGroup().addTo(map),
    canal: L.layerGroup().addTo(map),
    river: L.layerGroup().addTo(map),
    rain: L.layerGroup(),
    radar: L.layerGroup().addTo(map),
    highlight: L.layerGroup().addTo(map),
  };
  L.control.layers(null, {
    "เขต/อำเภอ (ระดับความเสี่ยง)": layers.districts,
    "ระดับน้ำคลอง (กทม.)": layers.canal,
    "ระดับน้ำแม่น้ำ/คลองหลัก": layers.river,
    "สถานีวัดฝน": layers.rain,
    "เรดาร์ฝน": layers.radar,
  }, { collapsed: window.innerWidth < 800 }).addTo(map);

  $("#legend").innerHTML = `<button type="button" class="ltoggle" aria-expanded="true">สัญลักษณ์</button><div class="lbody">` +
    `<b>เขต</b>${Object.values(LEVEL).map((l) => `<div><i class="sq" style="background:${l.hex}"></i>${l.th}</div>`).join("")}` +
    `<b>จุดวัดน้ำ</b>${["overbank", "critical", "warning", "normal", "unknown"].map((k) => `<div><i style="background:${STATUS[k].hex}"></i>${STATUS[k].th}</div>`).join("")}</div>`;
  const legendToggle = $("#legend .ltoggle");
  const setLegend = (open) => { $("#legend").classList.toggle("closed", !open); legendToggle.setAttribute("aria-expanded", String(open)); };
  legendToggle.addEventListener("click", () => setLegend($("#legend").classList.contains("closed")));
  setLegend(window.innerWidth >= 800);

  function drawMap(d) {
    ["districts", "canal", "river", "rain", "highlight"].forEach((k) => layers[k].clearLayers());
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
    const q = $("#cq").value.trim();
    const only = $("#conly").checked;
    const list = DATA.canals.filter((c) => (!q || c.name.includes(q) || c.districts.some((d) => d.includes(q))) &&
      (!only || ["overbank", "critical", "warning"].includes(c.status)));
    $("#ccount").textContent = `${list.length} คลอง/แม่น้ำ · แตะแถวเพื่อดูจุดวัดบนแผนที่`;
    $("#clist").innerHTML = `<table class="canals"><tr><th>คลอง</th><th>สถานะ</th><th>จุดที่หนักสุด</th></tr>
      ${list.map((c) => {
        const w = c.worst;
        const wtxt = w ? `${esc(w.name)}<br><small>${num(w.value)} ม.${w.bank != null ? " / ตลิ่ง " + num(w.bank) : ""}${w.bank_percent != null ? " (" + w.bank_percent.toFixed(0) + "%)" : ""} · ${fmtTime(w.time)}</small>` : "–";
        const counts = [c.overbank && `ล้น ${c.overbank}`, c.critical && `วิกฤต ${c.critical}`, c.warning && `เฝ้าระวัง ${c.warning}`].filter(Boolean).join(" · ");
        return `<tr data-canal="${esc(c.name)}"><td><b>${esc(c.name)}</b><br><small>${c.districts.map(esc).join(", ")}</small>${c.news ? `<br><small class="warn">ข่าว ${c.news}</small>` : ""}</td>
          <td><span class="pill" style="background:${STATUS[c.status].hex}">${STATUS[c.status].th}</span><br><small>จุดวัด ${c.reporting}/${c.gauges}${counts ? "<br>" + counts : ""}</small>${c.rising ? `<br><small class="bad">▲ ขึ้น ${c.rising} จุด</small>` : ""}</td>
          <td>${wtxt}</td></tr>`;
      }).join("")}</table>`;
    document.querySelectorAll("#clist tr[data-canal]").forEach((tr) => tr.addEventListener("click", () => focusCanal(tr.dataset.canal)));
  }

  function focusCanal(name) {
    layers.highlight.clearLayers();
    const gs = [...DATA.stations.canal, ...DATA.stations.river].filter((g) => g.canal === name);
    if (!gs.length) return;
    gs.forEach((g) => L.circleMarker([g.lat, g.lon], { radius: 11, color: "#0b6bcb", weight: 3, fill: false }).bindPopup(gaugePopup(g)).addTo(layers.highlight));
    map.fitBounds(L.latLngBounds(gs.map((g) => [g.lat, g.lon])).pad(0.3), { maxZoom: 14 });
    if (window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
  }

  function renderNews() {
    const d = DATA;
    const official = (d.official || []).map((o) =>
      `<li><span class="tag official">GDACS ${esc(o.level)}</span><a href="${safeUrl(o.link)}" target="_blank" rel="noopener">${esc(o.title)}</a></li>`).join("");
    const filtered = Object.entries(d.news_filtered || {}).map(([k, n]) => `${FILTER_REASON[k] || k} ${n}`).join(" · ");
    $("#tab-news").innerHTML = `<p class="empty">แสดงเฉพาะข่าวน้ำเพิ่ม/น้ำท่วม/ประกาศเตือน ภายใน ${d.method.news_max_age_h} ชม. · คัดออก: ${esc(filtered) || "–"}</p>
      <ul class="news">${official}${d.news.map((n) => `
      <li>${n.kind === "social" ? `<span class="tag social">โซเชียล</span>` : ""}${n.categories.map((c) => `<span class="tag c-${c}">${CAT[c] || c}</span>`).join("")}
        <a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
        <span class="m">${fmtTime(n.time)} · ${esc(n.source)}${n.districts.length ? " · เขต: " + n.districts.map(esc).join(", ") : ""}${n.canals.length ? " · " + n.canals.map(esc).join(", ") : ""}</span></li>`).join("")}</ul>
      <p class="empty">ข่าว/โพสต์ถูกจับคู่กับเขตจากชื่อเขต คลอง ถนน หรือสถานที่ — เป็นหลักฐาน "รอยืนยัน" เท่านั้น</p>`;
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
  ["#dq", "#dprov", "#dlevel"].forEach((s) => $(s).addEventListener("input", renderDistricts));
  ["#cq", "#conly"].forEach((s) => $(s).addEventListener("input", renderCanals));
  $("#links").innerHTML = LINKS.map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("");

  // ------------------------------------------------------------- load
  async function load() {
    try {
      if (!GEO) GEO = await (await fetch(DISTRICTS_URL)).json();
      const r = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const next = await r.json();
      if (!next.districts) throw new Error("ข้อมูลรุ่นเก่า รอรอบอัปเดตถัดไป");
      DATA = next;
      Object.keys(byId).forEach((k) => delete byId[k]);
      DATA.districts.forEach((z) => (byId[z.id] = z));
      drawMap(DATA);
      renderSummary(); renderDistricts(); renderCanals(); renderNews(); renderSources();
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
