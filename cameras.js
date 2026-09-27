(() => {
  "use strict";
  const DATA_URL = "data/cameras_ai.json";
  const CANALS_URL = "data/canals.geojson";
  const STALE_MIN = 60;
  const ST = {
    flooded: { th: "น้ำท่วมผิวจราจร", short: "น้ำท่วม", hex: "#c62828", rank: 0 },
    possible: { th: "อาจมีน้ำขัง", short: "อาจมีน้ำ", hex: "#e46c0a", rank: 1 },
    wet: { th: "ถนนเปียก", short: "เปียก", hex: "#1e88e5", rank: 2 },
    dry: { th: "ถนนแห้ง", short: "แห้ง", hex: "#2e9d5b", rank: 3 },
    unknown: { th: "ภาพใช้ไม่ได้", short: "ภาพเสีย", hex: "#8a94a0", rank: 4 },
    offline: { th: "กล้องออฟไลน์", short: "ออฟไลน์", hex: "#5d6b7a", rank: 5 },
  };
  const GROUP = { water: ["flooded", "possible"], wet: ["wet"], dry: ["dry"], nodata: ["unknown", "offline"] };
  const CONF = { high: "สูง", medium: "ปานกลาง", low: "ต่ำ" };
  const TRAFFIC = { light: "โล่ง", moderate: "ปานกลาง", heavy: "หนาแน่น" };
  const FLAG = { night: "กลางคืน/แสงน้อย", frozen: "ภาพค้าง (เหมือนรอบก่อน)", uniform: "จอดำ/ภาพเรียบ", no_signal: "No signal" };
  const VEH = { car: "รถยนต์", motorcycle: "มอเตอร์ไซค์", bus: "รถเมล์", truck: "รถบรรทุก" };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//.test(u || "") ? esc(u) : "#");
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "เมื่อสักครู่" : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม. ${m % 60} นาทีที่แล้ว`;
  };
  const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

  let DATA = null;
  const filt = new Set();
  const markers = {};

  // ------------------------------------------------------------- map
  const map = L.map("map").setView([13.76, 100.55], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap · ภาพกล้อง: iTIC, กรมทางหลวง ผ่าน Longdo Traffic",
  }).addTo(map);
  map.createPane("water").style.zIndex = 350;
  const canals = L.layerGroup().addTo(map);
  const cams = L.layerGroup().addTo(map);
  const tags = L.layerGroup().addTo(map);
  fetch(CANALS_URL).then((r) => (r.ok ? r.json() : null)).then((gj) => {
    if (gj) L.geoJSON(gj, { pane: "water", interactive: false, style: (f) => ({ color: "#1e88e5", weight: f.properties.name.startsWith("แม่น้ำ") ? 3 : 1.5, opacity: 0.45 }) }).addTo(canals);
  }).catch(() => {});
  L.control.layers(null, { "กล้อง": cams, "ป้ายสถานะน้ำ": tags, "แนวคลองและแม่น้ำ": canals }, { collapsed: true }).addTo(map);

  $("#legend").innerHTML = `<b>AI อ่านภาพกล้อง</b>` +
    Object.values(ST).map((s) => `<div><i style="background:${s.hex}"></i>${s.th}</div>`).join("");

  // ------------------------------------------------------------- live view in popup
  let hls = null;
  let popupOpen = false;
  function stopLive() { if (hls) { hls.destroy(); hls = null; } }
  map.on("popupopen", () => { popupOpen = true; });
  map.on("popupclose", () => { popupOpen = false; stopLive(); });

  function startLive(c, box) {
    stopLive();
    if (c.hls) {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.controls = true;
      box.replaceChildren(v);
      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 10, liveSyncDurationCount: 2 });
        hls.on(Hls.Events.ERROR, (_, e) => { if (e.fatal) box.innerHTML = `<p class="note">เปิดภาพสดไม่ได้ (กล้องอาจออฟไลน์)</p>`; });
        hls.loadSource(c.hls); hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
      } else { v.src = c.hls; v.play().catch(() => {}); }
    } else if (c.img) {
      const img = new Image();
      img.alt = c.title;
      img.onerror = () => { box.innerHTML = `<p class="note">โหลดภาพไม่ได้ (กล้องอาจออฟไลน์)</p>`; };
      img.src = c.img + (c.img.includes("?") ? "&" : "?") + "t=" + Date.now();
      box.replaceChildren(img);
    }
  }

  function popupHtml(c) {
    const s = ST[c.status];
    const p = c.probs || {};
    const veh = c.vehicles ? Object.entries(c.vehicles).filter(([, n]) => n).map(([k, n]) => `${VEH[k]} ${n}`).join(" · ") || "ไม่พบรถ" : "–";
    const base = c.baseline != null ? `ค่าปกติของกล้องนี้ ${pct(c.baseline)}` : `ยังเก็บข้อมูลกล้องนี้ ${c.history_scans || 0}/24 รอบ`;
    return `<div class="cam-pop">
      <b>${esc(c.title)}</b><br><span class="pill" style="background:${s.hex}">${s.th}</span>
      ${c.confidence ? ` <small>ความมั่นใจ${CONF[c.confidence]}</small>` : ""}
      <div class="live" data-live="${esc(c.id)}"><p class="note">กำลังโหลดภาพสด…</p></div>
      <table>
        ${c.flood_score != null ? `<tr><td>คะแนนน้ำท่วม</td><td><b>${pct(c.flood_score)}</b> <small>(${base})</small>
          <div class="bar"><i style="width:${Math.round(c.flood_score * 100)}%;background:${s.hex}"></i>${c.baseline != null ? `<b style="left:${Math.round(c.baseline * 100)}%"></b>` : ""}</div></td></tr>` : ""}
        ${c.probs ? `<tr><td>AI เห็น</td><td>แห้ง ${pct(p.dry)} · เปียก ${pct(p.wet)} · ท่วม ${pct(p.flood)}</td></tr>` : ""}
        <tr><td>รถในภาพ</td><td>${veh}${c.traffic ? ` (${TRAFFIC[c.traffic]})` : ""}</td></tr>
        ${c.water_since ? `<tr><td>เห็นน้ำตั้งแต่</td><td>${fmtTime(c.water_since)}</td></tr>` : ""}
        ${c.flags && c.flags.length ? `<tr><td>หมายเหตุภาพ</td><td>${c.flags.map((f) => FLAG[f] || f).join(", ")}</td></tr>` : ""}
        ${c.error ? `<tr><td>สาเหตุ</td><td><small>${esc(c.error)}</small></td></tr>` : ""}
        <tr><td>เวลาที่ AI อ่าน</td><td>${fmtTime(c.frame_time || c.checked)} · ${esc(c.org || "")}</td></tr>
      </table>
      <p class="note">ภาพด้านบนเป็นภาพสด ณ ตอนนี้ ผล AI มาจากเฟรมเวลาที่ระบุ · AI ประเมิน ไม่ใช่การวัด ${c.link ? `· <a href="${safeUrl(c.link)}" target="_blank" rel="noopener">เปิดที่ต้นทาง</a>` : ""}</p>
    </div>`;
  }

  // ------------------------------------------------------------- render
  function visible() {
    const q = $("#q").value.trim();
    const allowed = new Set([...filt].flatMap((g) => GROUP[g]));
    return DATA.cameras.filter((c) => (!allowed.size || allowed.has(c.status)) &&
      (!q || c.title.includes(q) || (c.district || "").includes(q) || (c.org || "").includes(q)));
  }

  function drawMap(list) {
    cams.clearLayers(); tags.clearLayers();
    Object.keys(markers).forEach((k) => delete markers[k]);
    list.forEach((c) => {
      const s = ST[c.status];
      const off = c.status === "offline" || c.status === "unknown";
      const m = L.marker([c.lat, c.lon], {
        title: c.title, zIndexOffset: 1000 - s.rank * 100,
        icon: L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="cam-pin${off ? " off" : ""}" style="background:${s.hex}">📷</div>` }),
      }).bindPopup(popupHtml(c), { maxWidth: 320, autoPan: true });
      m.on("popupopen", (e) => { const box = e.popup.getElement().querySelector("[data-live]"); if (box) startLive(c, box); });
      m.addTo(cams);
      markers[c.id] = m;
      if (c.status === "flooded" || c.status === "possible" || c.status === "wet") {
        L.marker([c.lat, c.lon], { interactive: false, keyboard: false,
          icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<span class="cam-tag" style="background:${s.hex}">${s.short}</span>` }) }).addTo(tags);
      }
    });
  }

  function render() {
    if (!DATA) return;
    const list = visible();
    drawMap(list);
    $("#count").textContent = `${list.length} กล้อง · เรียงจากน้ำมากไปน้อย`;
    $("#list").innerHTML = list.map((c) => {
      const s = ST[c.status];
      const veh = c.vehicle_total != null ? ` · รถ ${c.vehicle_total} คัน` : "";
      return `<li data-id="${esc(c.id)}"><span class="dot" style="background:${s.hex}"></span>
        <span class="t">${esc(c.title)}</span><span class="pill" style="background:${s.hex}">${s.short}</span>
        <span class="m">${c.district ? esc(c.district) + " · " : ""}${c.flood_score != null ? `น้ำ ${pct(c.flood_score)}` : esc(s.th)}${veh}${c.confidence ? ` · มั่นใจ${CONF[c.confidence]}` : ""}</span></li>`;
    }).join("") || `<li class="empty">ไม่มีกล้องที่ตรงเงื่อนไข</li>`;
    document.querySelectorAll("#list li[data-id]").forEach((li) => li.addEventListener("click", () => {
      const m = markers[li.dataset.id];
      if (!m) return;
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
      m.openPopup();
      if (window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
    }));
  }

  function renderSummary() {
    const n = (k) => DATA.cameras.filter((c) => GROUP[k].includes(c.status)).length;
    const tiles = [["water", "มีน้ำ", ST.flooded.hex], ["wet", "ถนนเปียก", ST.wet.hex], ["dry", "แห้ง", ST.dry.hex], ["nodata", "ไม่มีภาพ", ST.offline.hex]];
    const flooded = DATA.cameras.filter((c) => c.status === "flooded").length;
    $("#summary").innerHTML = tiles.map(([k, th, hex]) =>
      `<button type="button" class="n" data-g="${k}" style="background:${hex}"><b>${n(k)}</b><small>${th}</small></button>`).join("") +
      `<button type="button" class="n" data-g="" style="background:var(--accent)"><b>${DATA.cameras.length}</b><small>ทั้งหมด</small></button>` +
      `<div class="gsum">น้ำท่วมผิวจราจร ${flooded} · อาจมีน้ำขัง ${n("water") - flooded} · AI อ่านได้ ${DATA.cameras.length - n("nodata")} กล้อง</div>`;
    document.querySelectorAll("#summary .n").forEach((b) => b.addEventListener("click", () => {
      filt.clear();
      if (b.dataset.g) filt.add(b.dataset.g);
      document.querySelectorAll("#st button").forEach((x) => x.setAttribute("aria-pressed", String(filt.has(x.dataset.st))));
      render();
    }));
  }

  document.querySelectorAll("#st button").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.st;
    if (filt.has(k)) filt.delete(k); else filt.add(k);
    b.setAttribute("aria-pressed", String(filt.has(k)));
    render();
  }));
  $("#q").addEventListener("input", render);

  // ------------------------------------------------------------- load
  async function load() {
    try {
      const r = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      DATA = await r.json();
      renderSummary();
      if (!popupOpen) render();  // do not close a camera someone is watching
      const age = (Date.now() - new Date(DATA.generated_at)) / 60000;
      $("#updated").textContent = `AI อ่านภาพล่าสุด ${fmtTime(DATA.generated_at)} (${ago(DATA.generated_at)})`;
      const banner = $("#banner");
      if (age > STALE_MIN) {
        banner.hidden = false; banner.className = "banner stale";
        banner.textContent = `ผล AI ไม่ได้อัปเดตมา ${ago(DATA.generated_at)} ภาพอาจไม่ตรงกับตอนนี้`;
      } else if (DATA.summary.flooded) {
        banner.hidden = false; banner.className = "banner";
        banner.textContent = `AI เห็นน้ำท่วมผิวจราจร ${DATA.summary.flooded} กล้อง (ประเมินจากภาพ รอยืนยัน)`;
      } else banner.hidden = true;
    } catch (e) {
      $("#updated").textContent = "โหลดผล AI ไม่ได้: " + e.message;
    }
  }
  $("#reload").addEventListener("click", load);
  load();
  setInterval(load, 5 * 60 * 1000);
})();
