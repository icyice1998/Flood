(() => {
  "use strict";
  const REFRESH_MIN = 30;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const f0 = (x) => (x == null ? "–" : Math.round(x).toLocaleString("th-TH"));
  const f1 = (x) => (x == null ? "–" : (+x).toFixed(1));
  const { cls } = TW;

  let DATA = { river: [], dams: { large: [], medium: [], small: [] }, rain: [] };
  let metric = "dam", showAllDams = false, showAllBasins = false;

  // ------------------------------------------------------------- map
  const map = L.map("map", { zoomSnap: 0.5 }).setView([13.1, 101.0], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 15, opacity: 0.65, attribution: "© OpenStreetMap · ข้อมูลน้ำ: ThaiWater/สสน., กรมชลประทาน, กฟผ., กรมทรัพยากรน้ำ" }).addTo(map);
  const GRAD = { 0.3: "#4fc3f7", 0.5: "#ffee58", 0.7: "#ffa726", 0.85: "#ef5350", 1.0: "#b71c1c" };
  const heat = L.heatLayer([], { radius: 26, blur: 20, maxZoom: 9, max: 1, gradient: GRAD }).addTo(map);
  const marks = L.layerGroup().addTo(map);

  const allDams = () => [...DATA.dams.large, ...($("#medium").checked ? [...DATA.dams.medium, ...DATA.dams.small] : [])];

  function heatPoints() {
    if (metric === "dam") return allDams().map((d) => [d.lat, d.lon, Math.min(1, Math.max(0, (d.pct - 30) / 80)) * (d.kind === "large" ? 1 : 0.6)]);
    if (metric === "river") return DATA.river.filter((s) => s.pct >= 50).map((s) => [s.lat, s.lon, Math.min(1, s.pct / 110)]);
    return DATA.rain.filter((r) => r.mm >= 1).map((r) => [r.lat, r.lon, Math.min(1, r.mm / 100)]);
  }

  function damPopup(d) {
    const c = cls(TW.DAM, d.pct);
    return `<b>${esc(d.name)}</b> <small>${d.kind === "large" ? "เขื่อนขนาดใหญ่" : d.kind === "medium" ? "อ่างขนาดกลาง" : "อ่างขนาดเล็ก"}</small><br>${esc(d.province)} · ${esc(d.basin)}
      <br><span class="pill" style="background:${c.hex}">${c.th} ${f1(d.pct)}%</span> ${d.storage != null ? `${f0(d.storage)}${d.cap ? " / " + f0(d.cap) : ""} ล้าน ลบ.ม.` : ""}
      ${d.inflow != null ? `<br>น้ำไหลเข้า ${f1(d.inflow)} · ระบาย ${f1(d.release)} ล้าน ลบ.ม./วัน${d.spill ? ` · ทางระบายน้ำล้น ${f1(d.spill)}` : ""}` : ""}
      <br><small>${esc(String(d.date).slice(0, 10))} · ThaiWater</small>`;
  }

  function drawMap() {
    heat.setLatLngs(heatPoints());
    marks.clearLayers();
    if (!$("#marks").checked) return;
    if (metric === "dam") {
      for (const d of allDams()) {
        const big = d.kind === "large";
        L.circleMarker([d.lat, d.lon], { radius: big ? 4 + Math.sqrt((d.cap || 100) / 60) : 3, color: big ? "#263238" : "#fff", weight: big ? 1.5 : 0.8,
          fillColor: cls(TW.DAM, d.pct).hex, fillOpacity: 0.95 }).bindPopup(damPopup(d)).addTo(marks);
      }
    } else if (metric === "river") {
      for (const s of DATA.river) {
        L.circleMarker([s.lat, s.lon], { radius: s.pct >= 100 ? 5 : 3.5, color: "#fff", weight: 0.8, fillColor: cls(TW.RIVER, s.pct).hex, fillOpacity: 0.95 })
          .bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.river || "–")} · ${esc(s.province)}<br>${f0(s.pct)}% ความจุลำน้ำ${s.trend ? ` · ${s.trend > 0 ? "▲" : "▼"}${Math.abs(s.trend).toFixed(2)} ม.` : ""}<br><small>${esc(s.time)}</small>`).addTo(marks);
      }
    } else {
      for (const r of DATA.rain.filter((x) => x.mm >= 10)) {
        L.circleMarker([r.lat, r.lon], { radius: r.mm >= 90 ? 5 : 3.5, color: "#fff", weight: 0.6, fillColor: cls(TW.RAIN, r.mm).hex, fillOpacity: 0.9 })
          .bindPopup(`<b>${esc(r.name)}</b><br>${esc(r.province)}<br>ฝน 24 ชม. <b>${f1(r.mm)} มม.</b><br><small>${esc(r.time)}</small>`).addTo(marks);
      }
    }
    const scale = metric === "dam" ? TW.DAM : metric === "river" ? TW.RIVER : TW.RAIN;
    const unit = metric === "rain" ? "มม." : "%";
    $("#legend").innerHTML = `<b>${metric === "dam" ? "% ความจุเขื่อน/อ่าง" : metric === "river" ? "% ความจุลำน้ำ" : "ฝน 24 ชม."}</b>` +
      scale.map((c, i) => `<div><i style="background:${c.hex}"></i>${c.th}${c.max !== Infinity ? ` &lt;${c.max}${unit}` : ""}</div>`).join("") +
      `<div class="note">Heatmap: สีแดง = มากที่สุด</div>`;
  }

  // ------------------------------------------------------------- panel
  function renderSum() {
    const L_ = DATA.dams.large;
    const st = L_.reduce((s, d) => s + (d.storage || 0), 0), cap = L_.reduce((s, d) => s + (d.cap || 0), 0);
    const inflow = L_.reduce((s, d) => s + (d.inflow || 0), 0), rel = L_.reduce((s, d) => s + (d.release || 0), 0);
    const full = allDams().filter((d) => d.pct >= 80).length;
    const over = DATA.river.filter((s) => s.pct >= 100).length;
    const heavy = DATA.rain.filter((r) => r.mm >= 90).length;
    $("#sum").innerHTML = `<div style="background:#1e88e5"><b>${cap ? f0(st / cap * 100) : "–"}%</b><small>เขื่อนใหญ่รวม</small></div>
      <div style="background:#6a1b9a"><b>${full}</b><small>เขื่อน/อ่าง ≥80%</small></div>
      <div style="background:#c62828"><b>${over}</b><small>สถานีล้นตลิ่ง</small></div>
      <div style="background:#e65100"><b>${heavy}</b><small>ฝน &gt;90 มม.</small></div>
      <p>เขื่อนขนาดใหญ่ ${L_.length} แห่ง เก็บน้ำ ${f0(st)} / ${f0(cap)} ล้าน ลบ.ม. · วันนี้ไหลเข้า ${f0(inflow)} ระบาย ${f0(rel)} ล้าน ลบ.ม.</p>`;
  }

  function groupTable(key, rowsLimit) {
    const keys = new Set([...DATA.river, ...allDams(), ...DATA.rain].map((x) => x[key]).filter(Boolean));
    let rows = [...keys].map((k) => {
      const ds = allDams().filter((d) => d[key] === k), ss = DATA.river.filter((s) => s[key] === k), rs = DATA.rain.filter((r) => r[key] === k);
      const st = ds.reduce((s, d) => s + (d.storage || 0), 0), cap = ds.reduce((s, d) => s + (d.cap || 0), 0);
      return { k, damPct: cap ? st / cap * 100 : null, nd: ds.length, over: ss.filter((s) => s.pct >= 100).length, high: ss.filter((s) => s.pct >= 70 && s.pct < 100).length,
        rain: rs.length ? Math.max(...rs.map((r) => r.mm)) : null };
    });
    rows.sort((a, b) => b.over - a.over || (b.damPct || 0) - (a.damPct || 0));
    const total = rows.length;
    if (rowsLimit) rows = rows.slice(0, rowsLimit);
    return { total, html: `<table class="wtab"><tr><th>${key === "region" ? "ภาค" : "ลุ่มน้ำ"}</th><th title="ปริมาณน้ำรวมในเขื่อน/อ่าง">เขื่อน</th><th>ล้นตลิ่ง</th><th>น้ำมาก</th><th>ฝนสูงสุด</th></tr>
      ${rows.map((r) => `<tr data-k="${esc(r.k)}" data-key="${key}"><td>${esc(r.k.replace("ลุ่มน้ำ", ""))}</td>
        <td>${r.damPct != null ? `<span style="color:${cls(TW.DAM, r.damPct).hex === "#fff176" ? "#9e8a00" : cls(TW.DAM, r.damPct).hex};font-weight:700">${f0(r.damPct)}%</span>` : "–"}</td>
        <td class="bad">${r.over || ""}</td><td>${r.high || ""}</td><td>${r.rain != null ? f0(r.rain) : "–"}</td></tr>`).join("")}</table>` };
  }

  function renderGroups() {
    $("#regions").innerHTML = groupTable("region").html;
    const b = groupTable("basin", showAllBasins ? 0 : 8);
    $("#basins").innerHTML = b.html + (b.total > 8 && !showAllBasins ? `<button type="button" class="linkish" id="moreBasins">แสดงทั้งหมด ${b.total} ลุ่มน้ำ</button>` : "");
  }

  function renderDams() {
    const q = $("#q").value.trim();
    let list = q ? allDams().filter((d) => d.name.includes(q) || d.province.includes(q) || d.basin.includes(q)) : DATA.dams.large;
    list = [...list].sort((a, b) => b.pct - a.pct);
    const total = list.length;
    if (!q && !showAllDams) list = list.slice(0, 10);
    $("#damnote").textContent = q ? `(${total} ที่ตรงกับ "${q}")` : `(${DATA.dams.large.length} แห่ง เรียงจาก % สูงสุด)`;
    $("#dams").innerHTML = `<div class="dlist">${list.map((d, i) => {
      const c = cls(TW.DAM, d.pct);
      return `<div class="drow" data-i="${i}"><div class="dn"><b>${esc(d.name)}</b> <small>${esc(d.province)}</small></div><div class="dp" style="color:${c.hex === "#fff176" ? "#9e8a00" : c.hex}">${f1(d.pct)}%</div>
        <div class="dbar"><i style="width:${Math.min(100, d.pct)}%;background:${c.hex}"></i></div>
        <div class="dm">${d.storage != null ? `${f0(d.storage)}${d.cap ? " / " + f0(d.cap) : ""} ล้าน ลบ.ม.` : ""}${d.inflow != null ? ` · เข้า ${f1(d.inflow)} ระบาย ${f1(d.release)}/วัน` : ""}</div></div>`;
    }).join("") || "<p class='note'>ไม่พบ</p>"}</div>` + (!q && !showAllDams && total > 10 ? `<button type="button" class="linkish" id="moreDams">แสดงทั้งหมด ${total} เขื่อน</button>` : "");
    $("#dams").querySelectorAll(".drow").forEach((el) => el.addEventListener("click", () => {
      const d = list[+el.dataset.i];
      map.setView([d.lat, d.lon], 10);
      L.popup().setLatLng([d.lat, d.lon]).setContent(damPopup(d)).openOn(map);
    }));
  }

  document.addEventListener("click", (e) => {
    if (e.target.id === "moreDams") { showAllDams = true; renderDams(); }
    if (e.target.id === "moreBasins") { showAllBasins = true; renderGroups(); }
    const tr = e.target.closest("tr[data-k]");
    if (tr) {   // zoom to everything in that region/basin
      const k = tr.dataset.k, key = tr.dataset.key;
      const pts = [...DATA.river, ...allDams(), ...DATA.rain].filter((x) => x[key] === k).map((x) => [x.lat, x.lon]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.1));
    }
  });
  document.querySelectorAll("#metric button").forEach((b) => b.addEventListener("click", () => {
    metric = b.dataset.m;
    document.querySelectorAll("#metric button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    drawMap();
  }));
  $("#heat").addEventListener("change", () => ($("#heat").checked ? heat.addTo(map) : map.removeLayer(heat)));
  $("#marks").addEventListener("change", drawMap);
  $("#medium").addEventListener("change", () => { drawMap(); renderSum(); renderGroups(); renderDams(); });
  $("#q").addEventListener("input", renderDams);

  // ------------------------------------------------------------- load
  async function load() {
    $("#updated").textContent = "กำลังโหลดข้อมูลจาก ThaiWater…";
    const [river, dams, rain] = await Promise.allSettled([TW.waterlevel(), TW.dams(), TW.rain24()]);
    const errs = [];
    if (river.status === "fulfilled") DATA.river = river.value; else errs.push("ระดับน้ำ");
    if (dams.status === "fulfilled") DATA.dams = dams.value; else errs.push("เขื่อน");
    if (rain.status === "fulfilled") DATA.rain = rain.value; else errs.push("ฝน");
    drawMap(); renderSum(); renderGroups(); renderDams();
    const damDate = DATA.dams.large.map((d) => d.date).sort().pop();
    $("#updated").textContent = (errs.length ? `โหลดไม่ได้: ${errs.join(", ")} · ` : "") +
      `เขื่อน ${damDate || "–"} · แม่น้ำ ${DATA.river.length} สถานี · ฝน ${DATA.rain.length} สถานี`;
  }
  $("#reload").addEventListener("click", load);
  load();
  setInterval(load, REFRESH_MIN * 60000);
})();
