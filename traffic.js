// Traffic map: city / BMA traffic cameras (cctv.js), live iTIC streams, Longdo Traffic road events
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = CCTV.esc;
  const EVENTS_URL = "https://event.longdo.com/feed/json";
  const BBOX = [13.45, 100.25, 14.25, 100.95];
  const TOP_N = 5, WALL_N = 8, WALL_MS = 30000;
  // Longdo event icon → label, colour, priority (lower = listed first)
  const EV = {
    accident: ["อุบัติเหตุ", "#c62828", 0], carbreakdown: ["รถเสีย", "#ef6c00", 1], fire: ["ไฟไหม้", "#b71c1c", 0],
    roadclosed: ["ปิดถนน", "#6a1b9a", 1], diversion: ["เบี่ยงการจราจร", "#8e24aa", 2], warning: ["เตือน", "#f9a825", 2],
    complaint: ["ร้องเรียน", "#78909c", 3], event: ["กิจกรรม", "#5c6bc0", 3], information: ["ข้อมูล", "#607d8b", 3],
    rain: ["ฝนตก", "#1e88e5", 3], flood: ["น้ำท่วม", "#0277bd", 4],
  };

  const map = L.map("map", { zoomControl: true }).setView([13.75, 100.55], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · กล้อง: BMA Traffic ผ่าน <a href="https://cctv.maholan.net/">cctv.maholan.net</a>, iTIC, กรมทางหลวง · เหตุบนถนน: Longdo Traffic',
  }).addTo(map);
  const layers = { bma: L.layerGroup().addTo(map), hls: L.layerGroup().addTo(map), ev: L.layerGroup().addTo(map), flood: L.layerGroup() };
  let CAMS = [], HLS = [], EVENTS = [], markers = {}, hlsMarkers = {}, orgOff = new Set(), showAll = false, me = null;

  $("#legend").innerHTML = `<button type="button" class="ltoggle" aria-expanded="true">สัญลักษณ์</button><div class="lbody"><b>กล้อง</b>${Object.entries(CCTV.ORG).map(([k, c]) => `<div><i style="background:${c}"></i>${k}</div>`).join("")}
    <div><span class="cc-ai-pin" style="display:inline-block;transform:scale(.8)">💧AI</span> AI พบน้ำท่วม</div><div>📹 กล้องวิดีโอสด</div>
    <b>เหตุบนถนน</b>${["accident", "carbreakdown", "roadclosed", "diversion", "flood"].map((k) => `<div><i style="background:${EV[k][1]}"></i>${EV[k][0]}</div>`).join("")}</div>`;

  const setLegend = (open) => { $("#legend").classList.toggle("closed", !open); $("#legend .ltoggle").setAttribute("aria-expanded", String(open)); };
  $("#legend .ltoggle").addEventListener("click", () => setLegend($("#legend").classList.contains("closed")));
  setLegend(window.innerWidth >= 800);

  // ------------------------------------------------------------- cameras
  const camOk = (c) => !orgOff.has(c.org);
  function drawCams() {
    layers.bma.clearLayers();
    const { group, markers: m } = CCTV.layer(map, CAMS.filter(camOk));
    markers = m;
    group.addTo(layers.bma);
  }

  let hlsPlayer = null;
  function drawHls() {
    layers.hls.clearLayers();
    hlsMarkers = {};
    HLS.forEach((c) => {
      const m = L.marker([c.lat, c.lon], { zIndexOffset: 500, title: c.title,
        icon: L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="cam-pin">📹</div>` }) })
        .bindPopup(`<div class="cam-pop"><b>${esc(c.title)}</b><br><small>${esc(c.org)}${c.district ? " · " + esc(c.district) : ""}</small>
          <div class="cam-video"><video muted playsinline controls></video><div class="cam-msg">กำลังโหลดภาพสด…</div></div>
          <small><a href="${esc(c.link)}" target="_blank" rel="noopener">เปิดในหน้าต่างใหม่ ↗</a></small></div>`, { maxWidth: 360, minWidth: 260 });
      m.on("popupopen", (e) => {
        const v = e.popup.getElement().querySelector("video"), msg = e.popup.getElement().querySelector(".cam-msg");
        v.addEventListener("playing", () => { msg.hidden = true; }, { once: true });
        if (window.Hls && Hls.isSupported()) {
          hlsPlayer = new Hls({ maxBufferLength: 10 });
          hlsPlayer.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) msg.textContent = "เปิดภาพสดไม่ได้ — กล้องอาจออฟไลน์"; });
          hlsPlayer.loadSource(c.hls); hlsPlayer.attachMedia(v);
          hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
        } else { v.src = c.hls; v.play().catch(() => {}); }
      });
      m.on("popupclose", () => { if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; } });
      m.addTo(layers.hls);
      hlsMarkers[c.id] = m;
    });
  }

  function openCam(id) {
    const m = markers[id] || hlsMarkers[id];
    if (!m) return;
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 16));
    m.openPopup();
    if (window.innerWidth < 800) $("#map").scrollIntoView({ behavior: "smooth" });
  }

  // ------------------------------------------------------------- wall: snapshots of cameras in view
  let wallTimer = null;
  function renderWall() {
    const z = map.getZoom(), b = map.getBounds(), c = map.getCenter();
    const inView = CAMS.filter((x) => camOk(x) && b.contains([x.lat, x.lon]));
    if (z < 14 && inView.length > WALL_N * 4) {
      $("#wallnote").textContent = `(${inView.length} กล้อง)`;
      $("#wall").innerHTML = `<p class="note">ซูมเข้าในบริเวณที่สนใจ หรือแตะจุดกล้องบนแผนที่ เพื่อดูภาพ ${WALL_N} กล้องในกรอบ</p>`;
      return;
    }
    const pick = inView.map((x) => ({ x, d: CCTV.km(c.lat, c.lng, x.lat, x.lon) }))
      .sort((p, q) => !!q.x.ai - !!p.x.ai || p.d - q.d).slice(0, WALL_N).map((p) => p.x);
    $("#wallnote").textContent = `(${pick.length} จาก ${inView.length} กล้อง · อัปเดตทุก ${WALL_MS / 1000} วิ)`;
    $("#wall").innerHTML = pick.length ? pick.map((x) => `<button type="button" class="tf-tile${x.ai ? " ai" : ""}" data-cam="${esc(x.id)}">
        <img alt="" loading="lazy" referrerpolicy="no-referrer" src="${CCTV.snap(x.id)}" onerror="this.classList.add('err')">
        <span>${x.ai ? "💧 " : ""}${esc(x.name)}</span></button>`).join("") : `<p class="note">ไม่มีกล้องในกรอบแผนที่</p>`;
  }
  const refreshWall = () => { if (!document.hidden) $("#wall").querySelectorAll("button[data-cam] img").forEach((i) => { i.classList.remove("err"); i.src = CCTV.snap(i.parentElement.dataset.cam); }); };
  map.on("moveend", renderWall);

  // ------------------------------------------------------------- search / near me
  function renderFound() {
    const q = $("#q").value.trim().toLowerCase();
    let list = CAMS.filter(camOk);
    if (q) list = list.filter((c) => (c.name + " " + c.district + " " + c.org).toLowerCase().includes(q));
    if (me) list = list.map((c) => ({ ...c, d: CCTV.km(me[0], me[1], c.lat, c.lon) })).sort((a, b) => a.d - b.d);
    else list = [...list].sort((a, b) => !!b.ai - !!a.ai || a.district.localeCompare(b.district, "th"));
    const head = me ? `<li class="note">เรียงจากใกล้ตำแหน่งของคุณ · <a href="#" data-clear-me>ล้าง</a></li>` : "";
    const shown = showAll ? list : list.slice(0, TOP_N);
    $("#found").innerHTML = head + shown.map((c) => `<li data-cam="${esc(c.id)}"><i class="dot" style="background:${CCTV.ORG[c.org]}"></i>
      ${c.ai ? "💧 " : ""}${esc(c.name)} <small class="muted">${esc(c.district)}${c.d != null ? ` · ${c.d.toFixed(1)} กม.` : ""}</small></li>`).join("") +
      (list.length > TOP_N ? `<li class="more"><button type="button" data-show-all>${showAll ? "ย่อ" : `แสดงทั้งหมด (${list.length})`}</button></li>` : "") +
      (!list.length ? `<li class="note">ไม่พบกล้อง</li>` : "");
  }
  $("#q").addEventListener("input", () => { showAll = false; renderFound(); });
  $("#gps").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    $("#gps").textContent = "📍 กำลังหาตำแหน่ง…";
    navigator.geolocation.getCurrentPosition((p) => {
      me = [p.coords.latitude, p.coords.longitude];
      $("#gps").textContent = "📍 กล้องใกล้ฉัน";
      L.circleMarker(me, { radius: 7, color: "#fff", weight: 2, fillColor: "#1565c0", fillOpacity: 1 }).addTo(map);
      map.setView(me, 15);
      showAll = false; renderFound();
    }, () => { $("#gps").textContent = "📍 หาตำแหน่งไม่ได้ — ลองใหม่"; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });

  function renderOrgs() {
    const n = {};
    CAMS.forEach((c) => { n[c.org] = (n[c.org] || 0) + 1; });
    $("#orgs").innerHTML = Object.keys(CCTV.ORG).filter((k) => n[k]).map((k) => `<label><input type="checkbox" data-org="${esc(k)}"${orgOff.has(k) ? "" : " checked"}>
      <i class="dot" style="background:${CCTV.ORG[k]}"></i>${esc(k)} <small>${n[k]}</small></label>`).join("");
  }
  $("#orgs").addEventListener("change", (e) => {
    const k = e.target.dataset.org;
    if (!k) return;
    e.target.checked ? orgOff.delete(k) : orgOff.add(k);
    drawCams(); renderFound(); renderWall();
  });

  // ------------------------------------------------------------- Longdo Traffic events (live, CORS *)
  function drawEvents() {
    layers.ev.clearLayers(); layers.flood.clearLayers();
    EVENTS.forEach((e) => {
      const [th, hex] = EV[e.icon] || EV.information;
      const m = L.circleMarker([e.lat, e.lon], { radius: 7, color: "#fff", weight: 2, fillColor: hex, fillOpacity: 0.95 })
        .bindPopup(`<b>${esc(e.title)}</b><br><small>${th} · ${esc(e.start.slice(11, 16))}–${esc(e.stop.slice(11, 16))} น.</small><p style="margin:4px 0">${esc(e.desc)}</p>
          ${(() => { const c = CCTV.near(e.lat, e.lon, 1, 3); return c.length ? `<small>กล้องใกล้จุดนี้:</small><br>${c.map(({ c: x, d }) => `<a href="#" data-cam="${esc(x.id)}">📷 ${esc(x.name)}</a> <small>${d.toFixed(1)} กม.</small>`).join("<br>")}` : ""; })()}`);
      m.addTo(e.icon === "flood" || e.icon === "rain" ? layers.flood : layers.ev);
      e.marker = m;
    });
    const traffic = EVENTS.filter((e) => e.icon !== "flood" && e.icon !== "rain").sort((a, b) => (EV[a.icon] || EV.information)[2] - (EV[b.icon] || EV.information)[2] || b.start.localeCompare(a.start));
    $("#events").innerHTML = traffic.slice(0, 8).map((e) => `<li data-ev="${esc(e.id)}"><i class="dot" style="background:${(EV[e.icon] || EV.information)[1]}"></i>
      ${esc(e.title)} <small class="muted">${esc(e.start.slice(11, 16))} น.</small></li>`).join("") || `<li class="note">ไม่มีเหตุจราจรที่รายงานตอนนี้</li>`;
    renderSum();
  }
  async function loadEvents() {
    try {
      const r = await fetch(EVENTS_URL);
      const j = await r.json();
      const now = Date.now();
      EVENTS = j.map((e) => ({ id: e.eid, title: e.title, desc: (e.description || "").replace(/\s*Cr\.\S+/g, "").trim().slice(0, 240), icon: e.icon,
        lat: +e.latitude, lon: +e.longitude, start: e.start || "", stop: e.stop || "" }))
        .filter((e) => e.lat > BBOX[0] && e.lat < BBOX[2] && e.lon > BBOX[1] && e.lon < BBOX[3] && (!e.stop || new Date(e.stop.replace(" ", "T") + "+07:00") > now));
      drawEvents();
    } catch (e) { $("#events").innerHTML = `<li class="note">โหลดเหตุบนถนนไม่ได้ (${esc(e.message)})</li>`; }
  }

  function renderSum() {
    const ai = CAMS.filter((c) => c.ai).length, tr = EVENTS.filter((e) => e.icon !== "flood" && e.icon !== "rain").length;
    $("#sum").innerHTML = `<div style="background:#1e88e5"><b>${CAMS.length}</b><small>กล้อง กทม.</small></div>
      <div style="background:#c62828"><b>${ai}</b><small>💧AI พบน้ำท่วม</small></div>
      <div style="background:#ef6c00"><b>${tr}</b><small>เหตุจราจร</small></div>
      <div style="background:#0277bd"><b>${EVENTS.length - tr}</b><small>น้ำท่วม/ฝน (Longdo)</small></div>`;
  }

  // ------------------------------------------------------------- events, toggles, load
  document.addEventListener("click", (e) => {
    const cam = e.target.closest("[data-cam]");
    if (cam) { e.preventDefault(); openCam(cam.dataset.cam); return; }
    const ev = e.target.closest("[data-ev]");
    if (ev) { const x = EVENTS.find((y) => y.id === ev.dataset.ev); if (x) { map.setView([x.lat, x.lon], 16); x.marker.openPopup(); } return; }
    if (e.target.closest("[data-show-all]")) { showAll = !showAll; renderFound(); return; }
    if (e.target.closest("[data-clear-me]")) { e.preventDefault(); me = null; renderFound(); }
  });
  [["#c-bma", "bma"], ["#c-hls", "hls"], ["#c-ev", "ev"], ["#c-flood", "flood"]].forEach(([id, k]) =>
    $(id).addEventListener("change", (e) => (e.target.checked ? layers[k].addTo(map) : map.removeLayer(layers[k]))));

  async function load() {
    $("#updated").textContent = "กำลังโหลด…";
    const [cc, lt] = await Promise.allSettled([CCTV.load(), fetch("data/latest.json?t=" + Math.floor(Date.now() / 60000)).then((r) => r.json())]);
    if (cc.status === "fulfilled") { CAMS = cc.value.cameras; drawCams(); renderOrgs(); renderFound(); renderWall(); }
    if (lt.status === "fulfilled") { HLS = (lt.value.cameras || []).filter((c) => c.live); drawHls(); }
    loadEvents();
    $("#updated").textContent = cc.status === "fulfilled"
      ? `กล้อง ${CAMS.length} ตัว · รายชื่อ ${new Date(cc.value.list_at).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · AI ${new Date(cc.value.generated_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}`
      : "โหลดรายชื่อกล้องไม่ได้: " + cc.reason.message;
    renderSum();
  }
  $("#reload").addEventListener("click", load);
  load();
  setInterval(loadEvents, 5 * 60000);
  setInterval(() => CCTV.load().then((d) => { CAMS = d.cameras; drawCams(); renderSum(); }).catch(() => {}), 15 * 60000);
  clearInterval(wallTimer);
  wallTimer = setInterval(refreshWall, WALL_MS);
})();
