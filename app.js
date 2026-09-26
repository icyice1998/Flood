(() => {
  const DATA_URL = "data/latest.json";
  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_MIN = 45;

  const LEVEL = {
    normal: { th: "ปกติ", color: "var(--normal)", hex: "#2e9d5b" },
    watch: { th: "เฝ้าระวัง", color: "var(--watch)", hex: "#d9a400" },
    warning: { th: "เตือนภัย", color: "var(--warning)", hex: "#e46c0a" },
    severe: { th: "อันตราย", color: "var(--severe)", hex: "#c62828" },
  };
  const CONF = { high: "สูง", medium: "ปานกลาง", low: "ต่ำ" };
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
  const fmtTime = (t) => {
    if (!t) return "–";
    const d = new Date(t.length <= 16 && !/[+Z]/.test(t.slice(10)) ? t + "+07:00" : t);
    return isNaN(d) ? t : d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const ago = (t) => {
    const m = Math.round((Date.now() - new Date(t)) / 60000);
    return m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม. ${m % 60} นาทีที่แล้ว`;
  };

  // ------------------------------------------------------------- map
  const map = L.map("map", { zoomControl: true }).setView([13.76, 100.55], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ข้อมูล ThaiWater, Open-Meteo, GloFAS, RainViewer',
  }).addTo(map);

  const layers = {
    zones: L.layerGroup().addTo(map),
    water: L.layerGroup().addTo(map),
    rain: L.layerGroup(),
    radar: L.layerGroup().addTo(map),
  };
  L.control.layers(null, {
    "โซนประเมินความเสี่ยง": layers.zones,
    "สถานีระดับน้ำ": layers.water,
    "สถานีวัดฝน": layers.rain,
    "เรดาร์ฝน (RainViewer)": layers.radar,
  }, { collapsed: window.innerWidth < 800 }).addTo(map);

  $("#legend").innerHTML =
    Object.values(LEVEL).map((l) => `<div><i style="background:${l.hex}"></i>${l.th}</div>`).join("") +
    `<div><i style="background:#8a94a0"></i>ข้อมูลเก่า/ผิดปกติ</div>`;

  const bankColor = (w) => {
    if (w.flags.length) return "#8a94a0";
    const p = w.bank_percent;
    if (p == null) return "#8a94a0";
    return p >= 100 ? LEVEL.severe.hex : p >= 90 ? LEVEL.warning.hex : p >= 80 ? LEVEL.watch.hex : LEVEL.normal.hex;
  };
  const rainColor = (r) => {
    if (r.flags.length) return "#8a94a0";
    const v = r.rain_24h || 0;
    return v > 90 ? "#4a148c" : v > 35 ? "#1565c0" : v > 10 ? "#42a5f5" : "#b3d9f7";
  };
  const flagText = (f) => (f.length ? `<br><span class="warn">⚠ ${f.map((x) => ({ stale: "ข้อมูลเก่า", missing_value: "ไม่มีค่า", out_of_range: "ค่าผิดปกติ" }[x] || x)).join(", ")}</span>` : "");

  function drawMap(d) {
    Object.values(layers).forEach((g) => g !== layers.radar && g.clearLayers());
    d.zones.forEach((z) => {
      L.circle([z.lat, z.lon], {
        radius: z.radius_km * 1000, color: LEVEL[z.level].hex, weight: 2,
        fillOpacity: z.level === "normal" ? 0.05 : 0.18,
      }).bindPopup(`<b>${esc(z.name)}</b><br>${LEVEL[z.level].th} · คะแนน ${z.score} · ความเชื่อมั่น${CONF[z.confidence]}<br>${esc(z.advice)}`)
        .on("click", () => openZone(z.id))
        .addTo(layers.zones);
    });
    d.stations.water.forEach((w) => {
      L.circleMarker([w.lat, w.lon], { radius: 7, color: "#fff", weight: 1.5, fillColor: bankColor(w), fillOpacity: 0.95 })
        .bindPopup(`<b>${esc(w.name)}</b><br>${esc(w.amphoe)} ${esc(w.province)} · ${esc(w.agency)}<br>
          ระดับน้ำ ${w.waterlevel_msl ?? "–"} ม.รทก. · ${w.bank_percent != null ? w.bank_percent.toFixed(0) + "% ของตลิ่ง" : "–"}<br>
          เปลี่ยนแปลง ${w.rise_m != null ? (w.rise_m >= 0 ? "+" : "") + w.rise_m.toFixed(2) + " ม." : "–"}<br>
          <small>${fmtTime(w.time)} · ${esc(w.source_id)}:${esc(w.id)}</small>${flagText(w.flags)}`)
        .addTo(layers.water);
    });
    d.stations.rain.forEach((r) => {
      L.circleMarker([r.lat, r.lon], { radius: 3 + Math.min(9, (r.rain_24h || 0) / 20), color: "#fff", weight: 1, fillColor: rainColor(r), fillOpacity: 0.9 })
        .bindPopup(`<b>${esc(r.name)}</b><br>${esc(r.amphoe)} ${esc(r.province)} · ${esc(r.agency)}<br>
          ฝน 1 ชม. ${r.rain_1h ?? "–"} มม. · 24 ชม. ${r.rain_24h ?? "–"} มม.<br>
          <small>${fmtTime(r.time)} · ${esc(r.source_id)}:${esc(r.id)}</small>${flagText(r.flags)}`)
        .addTo(layers.rain);
    });
  }

  // Radar: RainViewer public tiles, past ~2 h, animated on demand
  let radarFrames = [], radarHost = "", radarIdx = 0, radarTimer = null, radarTile = null;
  async function loadRadar() {
    try {
      const r = await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" });
      const j = await r.json();
      radarHost = j.host;
      radarFrames = j.radar.past;
      radarIdx = radarFrames.length - 1;
      showRadar();
      $("#radarCtl").hidden = false;
    } catch (e) {
      console.warn("radar unavailable", e);
    }
  }
  function showRadar() {
    const f = radarFrames[radarIdx];
    if (!f) return;
    const next = L.tileLayer(`${radarHost}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0.6, maxNativeZoom: 7, maxZoom: 18 });
    layers.radar.addLayer(next);
    if (radarTile) layers.radar.removeLayer(radarTile);
    radarTile = next;
    $("#radarTime").textContent = new Date(f.time * 1000).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
  }
  $("#radarPlay").addEventListener("click", () => {
    if (radarTimer) {
      clearInterval(radarTimer); radarTimer = null;
      radarIdx = radarFrames.length - 1; showRadar();
      $("#radarPlay").textContent = "▶ เรดาร์";
      return;
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

  function drawPanel(d) {
    const counts = { severe: 0, warning: 0, watch: 0, normal: 0 };
    d.zones.forEach((z) => counts[z.level]++);
    $("#summary").innerHTML = Object.entries(counts)
      .map(([k, n]) => `<div class="n" style="background:${LEVEL[k].hex}"><b>${n}</b><small>${LEVEL[k].th}</small></div>`).join("");

    $("#tab-alerts").innerHTML = d.zones.map((z) => {
      const w = z.window;
      const when = w ? `ฝนเริ่ม ~${fmtTime(w.start)} · หนักสุด ~${fmtTime(w.peak)} (${w.peak_mm} มม./ชม.)` : "ไม่มีฝนมีนัยสำคัญใน 12 ชม.";
      return `<details class="zone" id="z-${esc(z.id)}" style="--lv:${LEVEL[z.level].color}" ${z.level !== "normal" && z.level !== "watch" ? "open" : ""}>
        <summary><span class="zn">${esc(z.name)} <small>${esc(z.name_en)}</small></span>
          <span class="badge">${LEVEL[z.level].th}</span>
          <span class="meta">คะแนน ${z.score} · ความเชื่อมั่น${CONF[z.confidence]} · ${when}</span></summary>
        <div class="body">
          ${EVIDENCE.map(([k, label]) => `<h4>${label}</h4>${evidenceList(z.evidence[k])}`).join("")}
          ${z.note ? `<p class="empty">${esc(z.note)}</p>` : ""}
          <div class="advice"><b>ควรทำอะไร:</b> ${esc(z.advice)}</div>
        </div></details>`;
    }).join("") + `<p class="warn" style="font-size:.8rem">${esc(d.method.disclaimer)}</p>`;

    const official = (d.official || []).map((o) =>
      `<li><span class="tag official">GDACS ${esc(o.level)}</span><a href="${safeUrl(o.link)}" target="_blank" rel="noopener">${esc(o.title)}</a></li>`).join("");
    $("#tab-news").innerHTML = `<ul class="news">${official}${d.news.map((n) => `
      <li><span class="tag ${n.kind}">${n.kind === "social" ? "โซเชียล" : "ข่าว"}</span>
        <a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
        <span class="m">${fmtTime(n.time)} · ${esc(n.source)}${n.zones.length ? " · โซน: " + n.zones.map((id) => esc(d.zones.find((z) => z.id === id)?.name || id)).join(", ") : ""}</span></li>`).join("")}</ul>
      <p class="empty">ข่าวและโพสต์ถูกจับคู่กับโซนด้วยชื่อเขต/ถนน — เป็นหลักฐาน "รอยืนยัน" เท่านั้น</p>`;

    $("#tab-sources").innerHTML = `<table><tr><th>แหล่ง</th><th>ประเภท</th><th>สถานะ</th><th>ข้อมูลล่าสุด</th></tr>
      ${d.sources.map((s) => `<tr><td><a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a><br><small>${esc(s.id)}</small></td>
        <td>${esc(s.kind)}</td>
        <td class="${s.ok ? "ok" : "bad"}">${s.ok ? "OK" : "ล้มเหลว"}<br><small>${s.ok ? s.count + " รายการ" + (s.stale_records ? `, เก่า ${s.stale_records}` : "") : esc(s.error)}</small></td>
        <td>${fmtTime(s.latest)}</td></tr>`).join("")}</table>
      ${riverTable(d.river)}`;
  }

  function riverTable(river) {
    if (!river || !river.length) return "";
    return `<h3>อัตราการไหลแม่น้ำ (GloFAS, ลบ.ม./วินาที)</h3><table><tr><th>วันที่</th>${river.map((r) => `<th>${esc(r.name)}</th>`).join("")}</tr>
      ${river[0].days.map((day, i) => `<tr><td>${esc(day)}</td>${river.map((r) => `<td>${r.discharge[i] != null ? Math.round(r.discharge[i]) : "–"}</td>`).join("")}</tr>`).join("")}</table>
      <p class="empty">ค่าจากแบบจำลองระดับโลก ความละเอียดหยาบ ใช้ดูแนวโน้มเท่านั้น</p>`;
  }

  function openZone(id) {
    selectTab("alerts");
    const el = document.getElementById("z-" + id);
    if (el) { el.open = true; el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }

  function selectTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
    try { localStorage.setItem("fw-tab", name); } catch (e) { /* storage unavailable */ }
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  $("#links").innerHTML = LINKS.map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("");

  // ------------------------------------------------------------- load
  async function load() {
    try {
      const r = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      drawMap(d);
      drawPanel(d);
      const ageMin = (Date.now() - new Date(d.generated_at)) / 60000;
      $("#updated").textContent = `อัปเดต ${fmtTime(d.generated_at)} (${ago(d.generated_at)})`;
      const banner = $("#banner");
      const severe = d.zones.filter((z) => z.level === "severe");
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
  try { const t = localStorage.getItem("fw-tab"); if (t) selectTab(t); } catch (e) { /* storage unavailable */ }
  load();
  loadRadar();
  setInterval(() => { load(); if (!radarTimer) loadRadar(); }, REFRESH_MS);
})();
