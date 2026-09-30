(() => {
  "use strict";
  const API = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load";
  const REFRESH_MIN = 15;
  // Main rivers and how to order stations from source to mouth
  const RIVERS = [
    ["แม่น้ำปิง", "ns"], ["แม่น้ำวัง", "ns"], ["แม่น้ำยม", "ns"], ["แม่น้ำน่าน", "ns"],
    ["แม่น้ำเจ้าพระยา", "ns"], ["แม่น้ำป่าสัก", "ns"], ["แม่น้ำน้อย", "ns"], ["แม่น้ำท่าจีน", "ns"],
    ["แม่น้ำแม่กลอง", "ns"], ["แม่น้ำแควน้อย", "ns"], ["แม่น้ำบางปะกง", "ew"], ["แม่น้ำนครนายก", "ns"],
    ["แม่น้ำมูล", "we"], ["แม่น้ำชี", "we"],
  ];
  const MAIN = new Set(RIVERS.map((r) => r[0]));
  // Large dams that release into each river (directly or through a tributary)
  const DAM_RIVER = {
    "ภูมิพล": ["แม่น้ำปิง", "แม่น้ำเจ้าพระยา"], "แม่งัดสมบูรณ์ชล": ["แม่น้ำปิง"], "แม่กวงอุดมธารา": ["แม่น้ำปิง"],
    "สิริกิติ์": ["แม่น้ำน่าน", "แม่น้ำเจ้าพระยา"], "แควน้อยบำรุงแดน": ["แม่น้ำน่าน"], "กิ่วลม": ["แม่น้ำวัง"], "กิ่วคอหมา": ["แม่น้ำวัง"],
    "แม่มอก": ["แม่น้ำยม"], "ป่าสักชลสิทธิ์": ["แม่น้ำป่าสัก", "แม่น้ำเจ้าพระยา"], "ทับเสลา": ["แม่น้ำเจ้าพระยา"], "กระเสียว": ["แม่น้ำท่าจีน"],
    "ศรีนครินทร์": ["แม่น้ำแม่กลอง"], "วชิราลงกรณ": ["แม่น้ำแควน้อย", "แม่น้ำแม่กลอง"], "ขุนด่านปราการชล": ["แม่น้ำนครนายก", "แม่น้ำบางปะกง"],
    "นฤบดินทรจินดา": ["แม่น้ำบางปะกง"], "อุบลรัตน์": ["แม่น้ำชี"], "ลำปาว": ["แม่น้ำชี"], "จุฬาภรณ์": ["แม่น้ำชี"],
    "สิรินธร": ["แม่น้ำมูล"], "ลำตะคอง": ["แม่น้ำมูล"], "ลำพระเพลิง": ["แม่น้ำมูล"], "มูลบน": ["แม่น้ำมูล"], "ลำแชะ": ["แม่น้ำมูล"],
    "ลำนางรอง": ["แม่น้ำมูล"], "ปากมูล": ["แม่น้ำมูล"],
  };
  let DAMS = [];
  const LEVEL = [
    { max: 10, th: "น้อยวิกฤต", hex: "#a1887f" },
    { max: 30, th: "น้อย", hex: "#d7ccc8" },
    { max: 70, th: "ปกติ", hex: "#66bb6a" },
    { max: 100, th: "มาก", hex: "#1e88e5" },
    { max: Infinity, th: "ล้นตลิ่ง", hex: "#c62828" },
  ];
  const lvl = (p) => LEVEL.find((l) => p < l.max);

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (t) => (t ? new Date(t.replace(" ", "T") + ":00+07:00").toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "–");
  const num = (x) => (x == null || x === "" ? null : +x);

  let ST = [], sel = null;

  // ------------------------------------------------------------- map
  const map = L.map("map", { zoomSnap: 0.5 }).setView([15.3, 100.6], 6.5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 16, opacity: 0.7, attribution: "© OpenStreetMap · ระดับน้ำ: ThaiWater/สสน., กรมชลประทาน" }).addTo(map);
  const heat = L.heatLayer([], { radius: 28, blur: 22, maxZoom: 9, max: 1.2,
    gradient: { 0.35: "#4fc3f7", 0.55: "#ffee58", 0.75: "#ffa726", 0.9: "#ef5350", 1.0: "#b71c1c" } }).addTo(map);
  const dots = L.layerGroup().addTo(map);
  const hl = L.layerGroup().addTo(map);
  const damLayer = L.layerGroup().addTo(map);
  const damIcon = (d) => L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<div class="dam-ic" style="background:${TW.cls(TW.DAM, d.pct).hex}" title="${esc(d.name)}"></div>` });
  function damPopup(d) {
    const c = TW.cls(TW.DAM, d.pct);
    return `<b>เขื่อน${esc(d.name)}</b><br>${esc(d.province)} · ${esc(d.basin)}<br><span class="pill" style="background:${c.hex}">${c.th} ${d.pct.toFixed(1)}%</span>
      ${d.storage != null ? ` ${Math.round(d.storage).toLocaleString()} / ${Math.round(d.cap || 0).toLocaleString()} ล้าน ลบ.ม.` : ""}
      <br>ไหลเข้า ${d.inflow ?? "–"} · <b>ระบาย ${d.release ?? "–"}</b> ล้าน ลบ.ม./วัน${d.spill ? ` · ล้นทางระบาย ${d.spill}` : ""}
      ${DAM_RIVER[d.name] ? `<br>ส่งน้ำลง: ${DAM_RIVER[d.name].map(esc).join(", ")}` : ""}<br><small>${esc(d.date)} · ThaiWater/กรมชลประทาน/กฟผ.</small>`;
  }
  function drawDams() {
    damLayer.clearLayers();
    if (!$("#damchk").checked) return;
    for (const d of DAMS) L.marker([d.lat, d.lon], { icon: damIcon(d), zIndexOffset: 500 }).bindPopup(damPopup(d)).addTo(damLayer);
  }
  $("#legend").innerHTML = `<b>% ความจุลำน้ำ</b>${LEVEL.map((l, i) => `<div><i style="background:${l.hex}"></i>${l.th}${i < 4 ? ` &lt;${l.max}%` : " &gt;100%"}</div>`).join("")}
    <div><span class="up">▲</span> กำลังขึ้น <span class="down">▼</span> กำลังลง</div>`;

  function parse(json) {
    return (json.waterlevel_data && json.waterlevel_data.data || []).map((r) => {
      const s = r.station || {};
      const msl = num(r.waterlevel_msl), prev = num(r.waterlevel_msl_previous);
      return {
        id: s.id, code: s.tele_station_oldcode || "", name: (s.tele_station_name && s.tele_station_name.th) || "",
        lat: s.tele_station_lat, lon: s.tele_station_long, river: r.river_name || "",
        basin: r.basin && r.basin.basin_name ? r.basin.basin_name.th : "", region: r.geocode && r.geocode.area_name ? r.geocode.area_name.th : "",
        province: r.geocode && r.geocode.province_name ? r.geocode.province_name.th : "",
        pct: num(r.storage_percent), msl, bank: s.min_bank, diff: num(r.diff_wl_bank),
        trend: msl != null && prev != null ? +(msl - prev).toFixed(2) : null, time: r.waterlevel_datetime, q: num(r.discharge),
      };
    }).filter((x) => x.lat && x.lon && x.pct != null);
  }
  const visible = () => ($("#mainonly").checked ? ST.filter((s) => MAIN.has(s.river)) : ST);
  const arrow = (t) => (t == null ? "" : t > 0.02 ? `<span class="up">▲${t.toFixed(2)}</span>` : t < -0.02 ? `<span class="down">▼${Math.abs(t).toFixed(2)}</span>` : "=");

  function popup(s) {
    return `<b>${esc(s.name)}</b> ${s.code ? `<small>(${esc(s.code)})</small>` : ""}<br>${esc(s.river || "–")} · ${esc(s.province)}
      <br><span class="pill" style="background:${lvl(s.pct).hex}">${lvl(s.pct).th} ${s.pct.toFixed(0)}%</span>
      ${s.diff != null ? ` ${s.diff >= 0 ? "สูงกว่าตลิ่ง" : "ต่ำกว่าตลิ่ง"} ${Math.abs(s.diff).toFixed(2)} ม.` : ""}
      <br>ระดับ ${s.msl != null ? s.msl.toFixed(2) + " ม.รทก." : "–"} ${arrow(s.trend)}${s.q ? ` · น้ำไหล ${Math.round(s.q)} ลบ.ม./วิ` : ""}
      <br><small>${fmt(s.time)} · ThaiWater</small>`;
  }

  function drawMap() {
    const v = visible();
    heat.setLatLngs(v.filter((s) => s.pct >= 50).map((s) => [s.lat, s.lon, Math.min(1.2, s.pct / 100)]));
    dots.clearLayers();
    if (!$("#dots").checked) return;
    for (const s of v) {
      L.circleMarker([s.lat, s.lon], { radius: s.pct >= 100 ? 6 : 4.5, color: "#fff", weight: 1, fillColor: lvl(s.pct).hex, fillOpacity: 0.95 })
        .bindPopup(popup(s)).addTo(dots);
    }
  }
  $("#damchk").addEventListener("change", drawDams);
  ["#heat", "#dots", "#mainonly"].forEach((id) => $(id).addEventListener("change", () => {
    if (id === "#heat") { if ($("#heat").checked) heat.addTo(map); else map.removeLayer(heat); }
    drawMap(); renderSum(); renderRegions();
  }));

  // ------------------------------------------------------------- panel
  function renderSum() {
    const v = visible();
    const n = (f) => v.filter(f).length;
    const over = n((s) => s.pct >= 100), high = n((s) => s.pct >= 70 && s.pct < 100), rising = n((s) => s.trend > 0.02);
    $("#sum").innerHTML = `<div style="background:#c62828"><b>${over}</b><small>ล้นตลิ่ง</small></div>
      <div style="background:#1e88e5"><b>${high}</b><small>น้ำมาก</small></div>
      <div style="background:#e46c0a"><b>${rising}</b><small>กำลังขึ้น</small></div>
      <div style="background:#546e7a"><b>${v.length}</b><small>สถานี</small></div>
      <p>${$("#mainonly").checked ? "เฉพาะแม่น้ำสายหลัก" : "ทุกสถานีทั่วประเทศ"} · % ความจุ = ระดับน้ำเทียบตลิ่ง</p>`;
  }

  function ordered(river) {
    const dir = (RIVERS.find((r) => r[0] === river) || [, "ns"])[1];
    const key = { ns: (s) => -s.lat, we: (s) => s.lon, ew: (s) => -s.lon }[dir];
    return ST.filter((s) => s.river === river).sort((a, b) => key(a) - key(b));
  }

  function renderRivers() {
    const rows = RIVERS.map(([r]) => {
      const ss = ordered(r);
      if (!ss.length) return null;
      const peak = ss.reduce((a, b) => (b.pct > a.pct ? b : a));
      const avg = ss.reduce((t, s) => t + s.pct, 0) / ss.length;
      const up = ss.filter((s) => s.trend > 0.02).length;
      return { r, ss, peak, avg, up };
    }).filter(Boolean).sort((a, b) => b.peak.pct - a.peak.pct);
    $("#rivers").innerHTML = rows.map(({ r, ss, peak, avg, up }) => `<div class="rv-river${sel === r ? " sel" : ""}" style="--c:${lvl(peak.pct).hex}" data-river="${esc(r)}">
        <span class="n">${esc(r.replace("แม่น้ำ", ""))}</span><span class="p">${peak.pct.toFixed(0)}%</span>
        <div class="rv-bar">${ss.map((s) => `<i style="width:${100 / ss.length}%;background:${lvl(s.pct).hex}" title="${esc(s.name)} ${s.pct.toFixed(0)}%"></i>`).join("")}</div>
        <span class="m">มวลน้ำหนาแน่นสุดที่ ${esc(peak.name)} (${esc(peak.province)}) ${arrow(peak.trend)} · เฉลี่ย ${avg.toFixed(0)}% · ${ss.length} สถานี${up ? ` · ขึ้น ${up}` : ""}</span>
      </div>`).join("") || `<p class="note">ไม่มีข้อมูล</p>`;
  }

  function renderProfile(river) {
    const ss = ordered(river);
    const box = $("#profile");
    if (!ss.length) { box.hidden = true; return; }
    box.hidden = false;
    const W = 360, H = 140, L0 = 24, B = 26, T = 8, bw = (W - L0 - 4) / ss.length;
    const top = Math.max(120, ...ss.map((s) => s.pct));
    const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
    const bars = ss.map((s, i) => `<rect x="${L0 + i * bw + 1}" y="${y(s.pct)}" width="${Math.max(2, bw - 2)}" height="${H - B - y(s.pct)}" fill="${lvl(s.pct).hex}"><title>${esc(s.name)}: ${s.pct.toFixed(0)}%</title></rect>
      ${s.trend > 0.02 ? `<text x="${L0 + i * bw + bw / 2}" y="${y(s.pct) - 2}" text-anchor="middle" class="ax" fill="#c62828">▲</text>` : ""}`).join("");
    const bank = `<line x1="${L0}" x2="${W}" y1="${y(100)}" y2="${y(100)}" stroke="#c62828" stroke-dasharray="4 3"/><text class="ax" x="${W - 2}" y="${y(100) - 2}" text-anchor="end">ตลิ่ง 100%</text>`;
    const labels = ss.map((s, i) => (i === 0 || i === ss.length - 1 || i === Math.floor(ss.length / 2)) ? `<text class="ax" x="${L0 + i * bw + bw / 2}" y="${H - 14}" text-anchor="middle">${esc(s.province.slice(0, 8))}</text>` : "").join("");
    const ups = DAMS.filter((d) => (DAM_RIVER[d.name] || []).includes(river));
    const damBox = ups.length ? `<div class="rv-dams"><b>เขื่อนต้นน้ำ:</b> ${ups.map((d) => `เขื่อน${esc(d.name)} <b style="color:${TW.cls(TW.DAM, d.pct).hex === "#fff176" ? "#9e8a00" : TW.cls(TW.DAM, d.pct).hex}">${d.pct.toFixed(0)}%</b> ระบาย ${d.release ?? "–"} ล้าน ลบ.ม./วัน`).join(" · ")}</div>` : "";
    box.innerHTML = `<h4>${esc(river)}</h4>${damBox}<small class="note">ต้นน้ำ (ซ้าย) → ปลายน้ำ (ขวา) · แท่ง = % ความจุ · ▲ = กำลังขึ้น</small>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="แนวลำน้ำ${esc(river)}">
        <text class="ax" x="0" y="${T + 6}">${top.toFixed(0)}%</text><text class="ax" x="0" y="${H - B}">0</text>
        <line x1="${L0}" x2="${W}" y1="${H - B}" y2="${H - B}" stroke="#90a4ae"/>${bank}${bars}${labels}
        <text class="ax" x="${L0}" y="${H - 3}">ต้นน้ำ</text><text class="ax" x="${W}" y="${H - 3}" text-anchor="end">ปลายน้ำ</text></svg>
      <table><tr><th>สถานี</th><th>จังหวัด</th><th>%</th><th>แนวโน้ม</th></tr>
      ${ss.map((s, i) => `<tr data-i="${i}"><td>${esc(s.name)}</td><td>${esc(s.province)}</td><td style="color:${lvl(s.pct).hex};font-weight:700">${s.pct.toFixed(0)}</td><td>${arrow(s.trend)}</td></tr>`).join("")}</table>`;
    box.querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("click", () => flyTo(ss[+tr.dataset.i])));
    hl.clearLayers();
    L.polyline(ss.map((s) => [s.lat, s.lon]), { color: "#0b6bcb", weight: 3, opacity: 0.6, dashArray: "6 5", interactive: false }).addTo(hl);
    map.fitBounds(L.latLngBounds(ss.map((s) => [s.lat, s.lon])).pad(0.2));
  }

  function flyTo(s) {
    map.setView([s.lat, s.lon], 10);
    L.popup().setLatLng([s.lat, s.lon]).setContent(popup(s)).openOn(map);
  }

  function renderDamList() {
    const rows = DAMS.filter((d) => DAM_RIVER[d.name]).sort((a, b) => b.pct - a.pct);
    $("#damlist").innerHTML = `<table class="wtab"><tr><th>เขื่อน</th><th>%</th><th>ไหลเข้า</th><th>ระบาย</th></tr>
      ${rows.map((d, i) => `<tr data-dam="${i}"><td>${esc(d.name)} <small>→ ${esc(DAM_RIVER[d.name][0].replace("แม่น้ำ", ""))}</small></td>
        <td style="font-weight:700;color:${TW.cls(TW.DAM, d.pct).hex === "#fff176" ? "#9e8a00" : TW.cls(TW.DAM, d.pct).hex}">${d.pct.toFixed(0)}</td><td>${d.inflow ?? "–"}</td><td>${d.release ?? "–"}</td></tr>`).join("")}</table>
      <small class="note">ล้าน ลบ.ม./วัน · ข้อมูลรายวัน ${esc(rows[0] ? rows[0].date : "")}</small>`;
    $("#damlist").querySelectorAll("tr[data-dam]").forEach((tr) => tr.addEventListener("click", () => {
      const d = rows[+tr.dataset.dam];
      map.setView([d.lat, d.lon], 10);
      L.popup().setLatLng([d.lat, d.lon]).setContent(damPopup(d)).openOn(map);
    }));
  }

  function renderRegions() {
    const v = visible();
    const regs = [...new Set(v.map((s) => s.region))].filter(Boolean);
    const rows = regs.map((r) => {
      const ss = v.filter((s) => s.region === r);
      return { r, n: ss.length, over: ss.filter((s) => s.pct >= 100).length, high: ss.filter((s) => s.pct >= 70 && s.pct < 100).length, up: ss.filter((s) => s.trend > 0.02).length };
    }).sort((a, b) => b.over - a.over || b.high - a.high);
    $("#regions").innerHTML = `<table><tr><th>ภาค</th><th>ล้นตลิ่ง</th><th>น้ำมาก</th><th>ขึ้น</th><th>สถานี</th></tr>
      ${rows.map((x) => `<tr><td>${esc(x.r)}</td><td class="bad">${x.over}</td><td>${x.high}</td><td>${x.up}</td><td>${x.n}</td></tr>`).join("")}</table>`;
  }

  function renderFound() {
    const q = $("#q").value.trim();
    if (q.length < 2) { $("#found").innerHTML = ""; return; }
    const hits = ST.filter((s) => s.name.includes(q) || s.river.includes(q) || s.province.includes(q) || s.code.includes(q)).sort((a, b) => b.pct - a.pct).slice(0, 20);
    $("#found").innerHTML = hits.map((s, i) => `<li data-i="${i}"><span class="pill" style="background:${lvl(s.pct).hex}">${s.pct.toFixed(0)}%</span> ${esc(s.name)} <small>${esc(s.river)} · ${esc(s.province)}</small> ${arrow(s.trend)}</li>`).join("") || "<li>ไม่พบ</li>";
    $("#found").querySelectorAll("li[data-i]").forEach((li) => li.addEventListener("click", () => flyTo(hits[+li.dataset.i])));
  }
  $("#q").addEventListener("input", renderFound);

  document.addEventListener("click", (e) => {
    const r = e.target.closest(".rv-river");
    if (!r) return;
    sel = r.dataset.river;
    renderRivers();
    renderProfile(sel);
    $("#profile").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // ------------------------------------------------------------- load (live from ThaiWater)
  async function load() {
    try {
      ST = await TW.waterlevel();
      const latest = ST.map((s) => s.time).filter(Boolean).sort().pop();
      $("#updated").textContent = `ระดับน้ำล่าสุด ${fmt(latest)} · ${ST.length} สถานี`;
      drawMap(); renderSum(); renderRivers(); renderRegions(); renderFound();
      TW.dams().then((d) => { DAMS = d.large; drawDams(); renderDamList(); if (sel) renderProfile(sel); }).catch(() => {});
      if (sel) renderProfile(sel);
    } catch (e) {
      $("#updated").textContent = "โหลดข้อมูล ThaiWater ไม่ได้: " + e.message + " · ลองใหม่อัตโนมัติใน 1 นาที";
      clearTimeout(retry);
      retry = setTimeout(load, 60000);
    }
  }
  let retry = null;
  $("#reload").addEventListener("click", load);
  load();
  setInterval(load, REFRESH_MIN * 60000);
})();
