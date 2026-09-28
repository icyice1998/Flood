(() => {
  "use strict";
  const DATA_URL = "data/latest.json";
  const TRAFFY_URL = "data/traffy.json";
  const VALHALLA = "https://valhalla1.openstreetmap.de/route";
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const OM = "https://api.open-meteo.com/v1/forecast";
  const VIEWBOX = "100.20,14.20,100.95,13.45";
  const NEAR_M = 60;          // a report this close to the route line counts as "on the route"
  const CAM_M = 300;          // cameras shown along the route
  const RECENT_H = 6;         // reports older than this are ignored (unless still active)
  const MAX_EXCLUDE = 45;     // public Valhalla accepts ~50 excluded locations

  const MODE = {
    flood: {
      title: "เลี่ยงน้ำท่วม",
      intro: "หาเส้นทางที่ผ่านจุดน้ำท่วมน้อยที่สุด จากรายงานกรมทางหลวง/iTIC/ประชาชน (Longdo), Traffy Fondue ที่แจ้งน้ำลึก และสถานีวัดน้ำที่ล้นตลิ่ง แล้วให้ระบบนำทางเลี่ยงจุดเหล่านั้น",
      how: `<ol><li>ขอเส้นทางปกติ 2–3 เส้นจาก Valhalla</li>
        <li>ตรวจจุดเสี่ยงในระยะ ${NEAR_M} ม. จากเส้นทาง: รายงานน้ำท่วม/ถนนปิดที่ยังมีผลหรือแจ้งใน ${RECENT_H} ชม. (แดง = 3 แต้ม, ส้ม = 2), Traffy แจ้งน้ำลึก ≥30 ซม. (2 แต้ม) หรือไม่ระบุความลึก (1 แต้ม), สถานีวัดน้ำล้นตลิ่ง/เกินวิกฤตภายใน 150 ม. (1 แต้ม)</li>
        <li>ส่งจุดที่ขวางอยู่บนเส้นทาง (สูงสุด ${MAX_EXCLUDE} จุด) ให้ Valhalla คำนวณเส้นทางใหม่แบบเลี่ยงจุดนั้น ทำซ้ำได้ 2 รอบ</li>
        <li>เรียงเส้นทางตามแต้มความเสี่ยงน้ำท่วมก่อน แล้วค่อยดูเวลา</li></ol>`,
    },
    traffic: {
      title: "เส้นทางจราจร",
      intro: "เปรียบเทียบเส้นทางจากเวลาเดินทางโดยประมาณ บวกเวลาที่อาจเสียจากรายงานรถติด/น้ำท่วม ถนนปิด และฝนตามเส้นทาง พร้อมกล้อง CCTV และข่าวจราจรของถนนที่ผ่าน",
      how: `<ol><li>ขอเส้นทาง 2–3 เส้นจาก Valhalla (เวลาเดินทางจากความเร็วถนนปกติ ไม่มีข้อมูลความเร็วสด)</li>
        <li>ถนนปิดหรือ "ผ่านไม่ได้" ถูกส่งให้ Valhalla เลี่ยง</li>
        <li>บวกเวลาชดเชย: รายงานรถติด +8 นาที/จุด, น้ำท่วมสีแดง +10, สีส้ม +4, Traffy น้ำลึก +3, ฝน ≥10 มม./ชม. ในชั่วโมงหน้าตามเส้นทาง +5 (≥20 มม. +10)</li>
        <li>เรียงตามเวลารวม และแสดงกล้อง CCTV ในระยะ ${CAM_M} ม. และข่าวที่กล่าวถึงถนนบนเส้นทาง</li></ol>`,
    },
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//.test(u || "") ? esc(u) : "#");
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "–");
  const hoursAgo = (iso) => (Date.now() - new Date(iso)) / 3600000;
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} ชม. ${Math.round(m % 60)} นาที` : `${Math.round(m)} นาที`);

  let mode = location.hash === "#traffic" ? "traffic" : "flood";
  let DATA = null, TRAFFY = null;
  let A = null, B = null;           // {lat, lon, label}
  let routes = [], chosen = 0;

  // ------------------------------------------------------------- map
  const map = L.map("map").setView([13.76, 100.55], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap · เส้นทาง: Valhalla/FOSSGIS" }).addTo(map);
  const lyr = { routes: L.layerGroup().addTo(map), hz: L.layerGroup().addTo(map), cams: L.layerGroup().addTo(map), ends: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };
  const endIcon = (t, c) => L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 26], html: `<div class="endpin" style="background:${c}"><span>${t}</span></div>` });

  function drawEnds() {
    lyr.ends.clearLayers();
    for (const [p, t, c, set] of [[A, "A", "#2e7d32", (v) => { A = v; }], [B, "B", "#c62828", (v) => { B = v; }]]) {
      if (!p) continue;
      L.marker([p.lat, p.lon], { icon: endIcon(t, c), draggable: true }).on("dragend", (e) => {
        const ll = e.target.getLatLng();
        set({ lat: ll.lat, lon: ll.lng, label: `จุดบนแผนที่ (${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})` });
        syncInputs(); if (A && B) plan();
      }).addTo(lyr.ends);
    }
  }
  function syncInputs() { $("#from").value = A ? A.label : ""; $("#to").value = B ? B.label : ""; }

  map.on("click", (e) => {
    const p = { lat: e.latlng.lat, lon: e.latlng.lng, label: `จุดบนแผนที่ (${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)})` };
    if (!A) A = p; else if (!B) B = p; else { B = p; }
    syncInputs(); drawEnds();
    if (A && B) plan();
  });

  function setMode(m) {
    mode = m;
    $("#ptitle").textContent = MODE[m].title;
    document.title = `Floodwatcher ${MODE[m].title}`;
    $("#intro").textContent = MODE[m].intro;
    $("#how").innerHTML = MODE[m].how;
    document.querySelectorAll(".pages a[data-mode]").forEach((a) => {
      if (a.dataset.mode === m) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    legend();
    if (A && B) plan();
  }
  window.addEventListener("hashchange", () => setMode(location.hash === "#traffic" ? "traffic" : "flood"));

  function legend() {
    $("#legend").innerHTML = `<b>${MODE[mode].title}</b>
      <div><i class="ln" style="background:#1a73e8;height:5px"></i>เส้นทางที่แนะนำ</div>
      <div><i class="ln" style="background:#90a4ae"></i>เส้นทางอื่น</div>
      <div><i class="sq" style="background:#c62828"></i>น้ำท่วม/ถนนปิด (แดง)</div>
      <div><i class="sq" style="background:#e46c0a"></i>น้ำท่วมขัง</div>
      <div><i class="sq" style="background:#d9a400"></i>รถติด</div>
      <div><i style="background:#7b1fa2"></i>Traffy น้ำลึก</div>
      <div><i style="background:#37474f"></i>กล้อง CCTV</div>`;
  }

  // ------------------------------------------------------------- GPS
  $("#gps").addEventListener("click", () => {
    if (!("geolocation" in navigator) || !window.isSecureContext) { status("ใช้ GPS ไม่ได้ (ต้องเปิดผ่าน https และเบราว์เซอร์รองรับ)"); return; }
    status("กำลังหาตำแหน่งของคุณ…");
    navigator.geolocation.getCurrentPosition((p) => {
      A = { lat: p.coords.latitude, lon: p.coords.longitude, label: "📍 ตำแหน่งของฉัน" };
      lyr.me.clearLayers();
      L.circle([A.lat, A.lon], { radius: p.coords.accuracy, weight: 1, color: "#1a73e8", fillOpacity: 0.08, interactive: false }).addTo(lyr.me);
      L.marker([A.lat, A.lon], { icon: L.divIcon({ className: "", iconSize: [16, 16], html: '<div class="me-dot"></div>' }), interactive: false }).addTo(lyr.me);
      syncInputs(); drawEnds(); status("");
      if (B) plan(); else map.setView([A.lat, A.lon], 14);
    }, (err) => status({ 1: "ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — เปิดสิทธิ์ Location ให้เว็บนี้แล้วลองใหม่", 2: "หาตำแหน่งไม่ได้", 3: "หาตำแหน่งนานเกินไป" }[err.code] || err.message),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  });

  // ------------------------------------------------------------- place search (Nominatim; one request per pause in typing)
  function suggest(input, list, set) {
    let t = null;
    input.addEventListener("input", () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (q.length < 3 || q.startsWith("📍") || q.startsWith("จุดบนแผนที่")) { list.innerHTML = ""; return; }
      t = setTimeout(async () => {
        try {
          const r = await fetch(`${NOMINATIM}?format=json&limit=6&countrycodes=th&viewbox=${VIEWBOX}&bounded=1&accept-language=th&q=${encodeURIComponent(q)}`);
          const js = await r.json();
          list.innerHTML = js.map((x, i) => `<li data-i="${i}">${esc(x.display_name.split(",").slice(0, 3).join(","))}</li>`).join("") ||
            `<li class="none">ไม่พบสถานที่ ลองพิมพ์ชื่ออื่นหรือแตะบนแผนที่</li>`;
          list.querySelectorAll("li[data-i]").forEach((li) => li.addEventListener("click", () => {
            const x = js[+li.dataset.i];
            set({ lat: +x.lat, lon: +x.lon, label: x.display_name.split(",").slice(0, 2).join(",") });
            list.innerHTML = ""; syncInputs(); drawEnds();
            if (A && B) plan(); else map.setView([+x.lat, +x.lon], 14);
          }));
        } catch (e) { list.innerHTML = `<li class="none">ค้นหาไม่ได้: ${esc(e.message)}</li>`; }
      }, 600);
    });
  }
  suggest($("#from"), $("#sFrom"), (v) => { A = v; });
  suggest($("#to"), $("#sTo"), (v) => { B = v; });
  $("#swap").addEventListener("click", () => { [A, B] = [B, A]; syncInputs(); drawEnds(); if (A && B) plan(); });
  $("#clear").addEventListener("click", () => {
    A = B = null; routes = []; syncInputs();
    Object.values(lyr).forEach((l) => l !== lyr.me && l.clearLayers());
    $("#results").innerHTML = ""; status("");
    history.replaceState(null, "", location.pathname + "#" + mode);
  });
  $("#form").addEventListener("submit", (e) => { e.preventDefault(); if (A && B) plan(); else status("เลือกต้นทางและปลายทางก่อน (ค้นหา หรือแตะบนแผนที่)"); });
  const status = (t) => { $("#rstatus").textContent = t; };

  // ------------------------------------------------------------- geometry
  function decode(str, precision = 6) {
    const f = 10 ** precision, pts = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (const k of [0, 1]) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lon += d;
      }
      pts.push([lat / f, lon / f]);
    }
    return pts;
  }
  // metres from a point to a polyline (equirectangular around the point)
  function distToLine(lat, lon, line, bbox) {
    if (bbox && (lat < bbox[0] - 0.01 || lat > bbox[2] + 0.01 || lon < bbox[1] - 0.01 || lon > bbox[3] + 0.01)) return Infinity;
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110570;
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][1] - lon) * kx, ay = (line[i - 1][0] - lat) * ky;
      const bx = (line[i][1] - lon) * kx, by = (line[i][0] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
    return best;
  }
  const bboxOf = (line) => line.reduce((b, [la, lo]) => [Math.min(b[0], la), Math.min(b[1], lo), Math.max(b[2], la), Math.max(b[3], lo)], [90, 180, -90, -180]);

  // ------------------------------------------------------------- hazards from Floodwatcher data
  function hazards() {
    const out = [];
    const recent = (e) => new Date(e.stop) >= Date.now() || hoursAgo(e.start) <= RECENT_H;
    for (const e of DATA.events || []) {
      if (e.color === "green" || !recent(e)) continue;
      const jam = e.kind === "trafficjam";
      const closed = e.kind === "roadclosed" || /\(ผ่านไม่ได้\)|ผ่านไม่ได้|ปิดถนน|ปิดเส้นทาง/.test(e.title + e.text) && !/\(ผ่านได้\)/.test(e.title);
      out.push({ type: jam ? "jam" : "event", lat: e.lat, lon: e.lon, color: e.color, closed,
        flood: jam ? 0 : e.color === "red" ? 3 : 2, delay: jam ? 8 : e.color === "red" ? 10 : 4,
        avoid: mode === "flood" ? !jam : closed,
        label: `${e.title}${e.depth_cm ? ` (ลึก ~${e.depth_cm} ซม.)` : ""}`, src: e.source, time: e.start });
    }
    for (const t of (TRAFFY && TRAFFY.reports) || []) {
      if (t.state === "done" || hoursAgo(t.time) > RECENT_H) continue;
      const deep = (t.depth_cm || 0) >= 30;
      out.push({ type: "traffy", lat: t.lat, lon: t.lon, flood: deep ? 2 : 1, delay: deep ? 3 : 0, avoid: mode === "flood" && deep, deep,
        label: `Traffy: ${t.text}${t.depth_cm ? ` (~${t.depth_cm} ซม.)` : ""}`, src: "ประชาชน (Traffy Fondue)", time: t.time, id: t.id });
    }
    for (const g of [...(DATA.stations.canal || []), ...(DATA.stations.river || [])]) {
      if (g.status !== "overbank" && g.status !== "critical") continue;
      out.push({ type: "gauge", lat: g.lat, lon: g.lon, flood: 1, delay: 0, avoid: false, near: 150,
        label: `สถานีวัดน้ำ ${g.name}: ${g.status === "overbank" ? "ล้นตลิ่ง" : "เกินวิกฤต"}`, src: "ThaiWater", time: g.time });
    }
    return out;
  }

  function onRoute(line, hz) {
    const bb = bboxOf(line);
    return hz.filter((h) => distToLine(h.lat, h.lon, line, bb) <= (h.near || NEAR_M));
  }

  // ------------------------------------------------------------- routing
  async function valhalla(exclude) {
    const body = {
      locations: [{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }],
      costing: "auto", alternates: 2, units: "kilometers", directions_options: { units: "kilometers" },
    };
    if (exclude.length) body.exclude_locations = exclude.map((h) => ({ lat: h.lat, lon: h.lon }));
    const r = await fetch(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`);
    const j = await r.json();
    if (!j.trip) throw new Error(j.error || "ไม่พบเส้นทาง");
    return [j, ...(j.alternates || [])].map((x) => {
      const leg = x.trip.legs[0];
      const names = [];
      for (const m of leg.maneuvers) for (const n of m.street_names || []) if (!names.includes(n)) names.push(n);
      return { line: decode(leg.shape), km: x.trip.summary.length, min: x.trip.summary.time / 60, roads: names };
    });
  }

  // Rain along every candidate route in ONE request (Open-Meteo counts each location as a call)
  async function rainAlongAll(cands) {
    const per = cands.map((c) => {
      const n = Math.min(5, Math.max(2, Math.round(c.line.length / 150)));
      return Array.from({ length: n }, (_, i) => c.line[Math.round(i * (c.line.length - 1) / (n - 1))]);
    });
    const pts = per.flat();
    try {
      const u = `${OM}?latitude=${pts.map((p) => p[0].toFixed(3)).join(",")}&longitude=${pts.map((p) => p[1].toFixed(3)).join(",")}&hourly=precipitation,precipitation_probability&forecast_hours=3&timezone=Asia%2FBangkok`;
      const j = await (await fetch(u)).json();
      const arr = Array.isArray(j) ? j : [j];
      let k = 0;
      per.forEach((ps, ci) => {
        const mine = arr.slice(k, k + ps.length); k += ps.length;
        cands[ci].rain = {
          next1: Math.max(...mine.map((x) => x.hourly.precipitation[0] || 0)),
          next3: Math.max(...mine.map((x) => x.hourly.precipitation.slice(0, 3).reduce((s2, v) => s2 + (v || 0), 0))),
          prob: Math.max(...mine.map((x) => Math.max(...x.hourly.precipitation_probability.map((v) => v || 0)))),
        };
      });
    } catch { cands.forEach((c) => { c.rain = null; }); }
  }

  const sameRoute = (a, b) => Math.abs(a.km - b.km) < 0.05 * Math.max(a.km, b.km) && Math.abs(a.min - b.min) < 1.5 &&
    distToLine(a.line[Math.floor(a.line.length / 2)][0], a.line[Math.floor(a.line.length / 2)][1], b.line) < 150;

  async function plan() {
    if (!DATA) { status("รอข้อมูลน้ำท่วม/จราจรโหลดก่อน…"); return; }
    status("กำลังคำนวณเส้นทาง…");
    $("#results").innerHTML = "";
    history.replaceState(null, "", `${location.pathname}?o=${A.lat.toFixed(5)},${A.lon.toFixed(5)}&d=${B.lat.toFixed(5)},${B.lon.toFixed(5)}#${mode}`);
    try {
      const hz = hazards();
      let cands = await valhalla([]);
      cands.forEach((c) => { c.kind = "ปกติ"; });
      // Avoid what actually sits on the routes; repeat once for hazards the detour runs into
      let exclude = [];
      for (let round = 0; round < 2; round++) {
        const hits = [];
        for (const c of cands) for (const h of onRoute(c.line, hz)) if (h.avoid && !hits.includes(h) && !exclude.includes(h)) hits.push(h);
        if (!hits.length) break;
        exclude = [...exclude, ...hits.sort((a, b) => b.flood - a.flood)].slice(0, MAX_EXCLUDE);
        status(`กำลังคำนวณเส้นทางเลี่ยง ${exclude.length} จุด…`);
        try {
          const det = await valhalla(exclude);
          det.forEach((c) => { c.kind = mode === "flood" ? "เลี่ยงน้ำท่วม" : "เลี่ยงถนนปิด"; });
          for (const d of det) if (!cands.some((c) => sameRoute(c, d))) cands.push(d);
        } catch (e) { status(`เลี่ยงทุกจุดไม่ได้ (${e.message}) แสดงเส้นทางที่มี`); break; }
      }
      for (const c of cands) {
        c.hz = onRoute(c.line, hz);
        c.flood = c.hz.reduce((s, h) => s + h.flood, 0);
        c.closed = c.hz.filter((h) => h.closed).length;
        c.jams = c.hz.filter((h) => h.type === "jam").length;
        c.delay = c.hz.reduce((s, h) => s + h.delay, 0);
      }
      await rainAlongAll(cands);
      for (const c of cands) {
        const r = c.rain ? (c.rain.next1 >= 20 ? 10 : c.rain.next1 >= 10 ? 5 : 0) : 0;
        c.delay += r;
        c.eff = c.min + c.delay;
      }
      cands.sort(mode === "flood"
        ? (a, b) => a.closed - b.closed || a.flood - b.flood || a.min - b.min
        : (a, b) => a.closed - b.closed || a.eff - b.eff);
      routes = cands.slice(0, 4);
      chosen = 0;
      render();
      status("");
    } catch (e) {
      status("หาเส้นทางไม่ได้: " + e.message + " — ลองย้ายจุดให้อยู่บนถนน หรือลองใหม่อีกครั้ง");
    }
  }

  // ------------------------------------------------------------- render
  const HZC = { event: (h) => (h.color === "red" ? "#c62828" : "#e46c0a"), jam: () => "#d9a400", traffy: () => "#7b1fa2", gauge: () => "#0277bd" };
  function verdict(c) {
    if (mode === "flood") {
      if (c.closed) return ["ผ่านถนนปิด/ผ่านไม่ได้", "#c62828"];
      if (c.flood === 0) return ["ไม่พบรายงานน้ำท่วมบนเส้นทาง", "#2e7d32"];
      if (c.flood <= 3) return ["มีจุดน้ำท่วมเล็กน้อย", "#e46c0a"];
      return ["ผ่านหลายจุดน้ำท่วม", "#c62828"];
    }
    if (c.closed) return ["ผ่านถนนปิด", "#c62828"];
    if (c.delay >= 15) return ["อาจติดขัดมาก", "#c62828"];
    if (c.delay >= 5) return ["อาจติดขัดบางช่วง", "#e46c0a"];
    return ["ไม่พบรายงานรถติด", "#2e7d32"];
  }

  function camerasAlong(c) {
    const bb = bboxOf(c.line);
    return (DATA.cameras || []).filter((k) => k.live !== false && distToLine(k.lat, k.lon, c.line, bb) <= CAM_M);
  }
  function newsAlong(c) {
    const keys = c.roads.map((r) => r.replace(/^(ถนน|ถ\.)\s*/, "").trim()).filter((r) => r.length >= 4 && !/^\d+$/.test(r));
    return (DATA.news || []).filter((n) => hoursAgo(n.time) <= 24 && keys.some((k) => n.title.includes(k))).slice(0, 6);
  }
  function gmaps(c) {
    const pick = [0.25, 0.5, 0.75].map((f) => c.line[Math.floor(f * (c.line.length - 1))]);
    return `https://www.google.com/maps/dir/?api=1&origin=${A.lat},${A.lon}&destination=${B.lat},${B.lon}&travelmode=driving&waypoints=${pick.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join("%7C")}`;
  }

  function render() {
    lyr.routes.clearLayers(); lyr.hz.clearLayers(); lyr.cams.clearLayers();
    routes.forEach((c, i) => {
      if (i === chosen) return;
      L.polyline(c.line, { color: "#90a4ae", weight: 5, opacity: 0.8 }).on("click", () => { chosen = i; render(); }).addTo(lyr.routes);
    });
    const c = routes[chosen];
    L.polyline(c.line, { color: "#fff", weight: 10, opacity: 0.9 }).addTo(lyr.routes);
    L.polyline(c.line, { color: "#1a73e8", weight: 6, opacity: 0.95 }).addTo(lyr.routes);
    map.fitBounds(L.latLngBounds(c.line).pad(0.15));
    for (const h of c.hz) {
      L.marker([h.lat, h.lon], { zIndexOffset: 500, icon: L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9],
        html: `<div class="hz" style="background:${HZC[h.type](h)}">${h.type === "jam" ? "🚗" : h.type === "gauge" ? "~" : "!"}</div>` }) })
        .bindPopup(`<b>${esc(h.label)}</b><br><small>${esc(h.src)} · ${fmtTime(h.time)}</small>${h.id ? `<br><a href="https://share.traffy.in.th/teamchadchart/${encodeURIComponent(h.id)}" target="_blank" rel="noopener">ดูที่ Traffy</a>` : ""}`)
        .addTo(lyr.hz);
    }
    const cams = camerasAlong(c);
    for (const k of cams) {
      L.marker([k.lat, k.lon], { icon: L.divIcon({ className: "", iconSize: [22, 22], html: '<div class="cam-mini">📷</div>' }) })
        .bindPopup(`<div class="vid"><b>${esc(k.title)}</b><div data-cam="${esc(k.id)}"></div></div>`, { maxWidth: 300 })
        .on("popupopen", (e) => playCam(k, e.popup.getElement().querySelector("[data-cam]")))
        .addTo(lyr.cams);
    }
    const news = newsAlong(c);

    $("#results").innerHTML = routes.map((r, i) => {
      const [v, col] = verdict(r);
      const hzs = mode === "flood"
        ? `น้ำท่วม/ถนนปิด ${r.hz.filter((h) => h.type === "event").length} · Traffy ${r.hz.filter((h) => h.type === "traffy").length} · สถานีน้ำ ${r.hz.filter((h) => h.type === "gauge").length}`
        : `รถติด ${r.jams} · น้ำท่วม ${r.hz.filter((h) => h.type === "event").length} · ${r.rain ? `ฝนชั่วโมงหน้า ${r.rain.next1.toFixed(1)} มม.` : "ไม่มีข้อมูลฝน"}`;
      return `<div class="rcard${i === chosen ? " sel" : ""}" style="--rc:${col}" data-i="${i}">
        <div class="h"><b>${String.fromCharCode(65 + i)}. ${mode === "traffic" ? fmtMin(r.eff) : fmtMin(r.min)} · ${r.km.toFixed(1)} กม.</b><span class="badge">${esc(v)}</span></div>
        <div class="m">${esc(r.kind)}${mode === "traffic" && r.delay ? ` · เวลาปกติ ${fmtMin(r.min)} + อาจเสีย ${Math.round(r.delay)} นาที` : ""} · ${hzs}</div>
        <div class="roads">ผ่าน: ${esc(r.roads.slice(0, 8).join(" › ") || "–")}</div>
      </div>`;
    }).join("") + detail(c, cams, news);
    document.querySelectorAll(".rcard").forEach((el) => el.addEventListener("click", () => { chosen = +el.dataset.i; render(); }));
  }

  function detail(c, cams, news) {
    const hz = [...c.hz].sort((a, b) => b.flood - a.flood || b.delay - a.delay);
    return `<div class="detail">
      <div class="acts" style="margin:8px 0"><a class="primary" href="${gmaps(c)}" target="_blank" rel="noopener">นำทางด้วย Google Maps (ตามเส้นทางนี้)</a></div>
      <h4>จุดเสี่ยงบนเส้นทาง ${String.fromCharCode(65 + chosen)} (${hz.length})</h4>
      <ul>${hz.slice(0, 15).map((h) => `<li><span class="pill" style="background:${HZC[h.type](h)}">${h.type === "jam" ? "รถติด" : h.type === "traffy" ? "Traffy" : h.type === "gauge" ? "สถานีน้ำ" : h.color === "red" ? "แดง" : "น้ำขัง"}</span>
        ${esc(h.label.slice(0, 110))} <small>${fmtTime(h.time)}</small></li>`).join("") || "<li>ไม่พบรายงานบนเส้นทางในช่วง 6 ชม.</li>"}</ul>
      ${c.rain ? `<h4>ฝนตามเส้นทาง</h4><ul><li>ชั่วโมงหน้า สูงสุด ${c.rain.next1.toFixed(1)} มม. · 3 ชม. สะสมสูงสุด ${c.rain.next3.toFixed(1)} มม. · โอกาสฝนสูงสุด ${c.rain.prob}%</li></ul>` : ""}
      <h4>กล้อง CCTV ใกล้เส้นทาง (${cams.length})</h4>
      <ul>${cams.map((k) => `<li><a href="#" data-cam-open="${esc(k.id)}">${esc(k.title)}</a></li>`).join("") || "<li>ไม่มีกล้องที่เปิดใช้งานในระยะ 300 ม.</li>"}</ul>
      <h4>ข่าวที่กล่าวถึงถนนบนเส้นทาง (24 ชม.)</h4>
      <ul>${news.map((n) => `<li><a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a> <small>${fmtTime(n.time)}</small></li>`).join("") || "<li>ไม่พบข่าว</li>"}</ul>
    </div>`;
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-cam-open]");
    if (!a) return;
    e.preventDefault();
    lyr.cams.eachLayer((m) => { if (m.getPopup() && m.getPopup().getContent().includes(`data-cam="${a.dataset.camOpen}"`)) { map.setView(m.getLatLng(), 15); m.openPopup(); } });
  });

  let hls = null;
  function playCam(k, box) {
    if (hls) { hls.destroy(); hls = null; }
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.controls = true;
    box.replaceChildren(v);
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 10 });
      hls.on(Hls.Events.ERROR, (_, e) => { if (e.fatal) box.innerHTML = `<small>เปิดภาพสดไม่ได้ · <a href="${safeUrl(k.link)}" target="_blank" rel="noopener">เปิดที่ต้นทาง</a></small>`; });
      hls.loadSource(k.hls); hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    } else { v.src = k.hls; v.play().catch(() => {}); }
  }
  map.on("popupclose", () => { if (hls) { hls.destroy(); hls = null; } });

  // ------------------------------------------------------------- load
  async function load() {
    try {
      DATA = await (await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" })).json();
      $("#updated").textContent = `ข้อมูลน้ำท่วม/จราจร ${fmtTime(DATA.generated_at)}`;
      if (DATA.traffy) fetch(TRAFFY_URL + "?t=" + encodeURIComponent(DATA.generated_at)).then((r) => (r.ok ? r.json() : null)).then((j) => { TRAFFY = j; }).catch(() => {});
    } catch (e) {
      $("#updated").textContent = "โหลดข้อมูลไม่ได้: " + e.message;
    }
  }
  const qs = new URLSearchParams(location.search);
  const parse = (s) => { const [la, lo] = (s || "").split(",").map(Number); return isFinite(la) && isFinite(lo) && s ? { lat: la, lon: lo, label: `จุด (${la.toFixed(4)}, ${lo.toFixed(4)})` } : null; };
  A = parse(qs.get("o")); B = parse(qs.get("d"));
  setMode(mode);
  syncInputs(); drawEnds();
  load().then(() => { if (A && B) setTimeout(plan, TRAFFY ? 0 : 1500); });
})();
