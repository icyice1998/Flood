(() => {
  "use strict";
  const DATA_URL = "data/latest.json";
  const TRAFFY_URL = "data/traffy.json";
  const ROADS_URL = "data/roads.geojson";
  const CANALS_URL = "data/canals.geojson";
  const DISTRICTS_URL = "data/districts.geojson";
  const SNAP_M = 80;        // a report belongs to the nearest main road within this distance
  const SEG_M = 500;        // road ways drawn around each report
  const CELL = 0.005;       // grid cell (deg) for the road index, ~550 m
  const SKIP_ROAD = /ทางพิเศษ|ทางด่วน|ทางยกระดับ|motorway|expressway|ทางหลวงพิเศษ/i;
  const WATER = /น้ำ|ท่วม|ขัง|ระบาย|ท่อ|ฝน|แช่|จม|flood/i;
  const LV = {
    red: { th: "หลีกเลี่ยง", hex: "#c62828" },
    orange: { th: "ขับช้า ระวัง", hex: "#f0a500" },
    green: { th: "ใช้ได้ตามปกติ", hex: "#2e7d32" },
  };

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hoursAgo = (iso) => (Date.now() - new Date(iso)) / 3600000;
  const fmtClock = (iso) => new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  const fmtWhen = (iso) => new Date(iso).toLocaleString("th-TH", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  const fmtDate = (iso) => new Date(iso).toLocaleString("th-TH", { weekday: "long", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

  // BMA's six administrative zones; outer provinces grouped by province
  const ZONES = [
    ["กรุงเทพฯ กลาง", "พระนคร ป้อมปราบศัตรูพ่าย สัมพันธวงศ์ ปทุมวัน ราชเทวี บางรัก ดุสิต พญาไท ดินแดง ห้วยขวาง วังทองหลาง"],
    ["กรุงเทพฯ เหนือ", "จตุจักร บางซื่อ ลาดพร้าว หลักสี่ ดอนเมือง บางเขน สายไหม"],
    ["กรุงเทพฯ ตะวันออก", "บางกะปิ บึงกุ่ม คันนายาว สะพานสูง มีนบุรี คลองสามวา หนองจอก ลาดกระบัง"],
    ["กรุงเทพฯ ใต้", "คลองเตย วัฒนา บางคอแหลม ยานนาวา สาทร บางนา พระโขนง สวนหลวง ประเวศ"],
    ["กรุงธนบุรี เหนือ", "ธนบุรี คลองสาน บางกอกใหญ่ บางกอกน้อย บางพลัด ตลิ่งชัน ทวีวัฒนา ภาษีเจริญ"],
    ["กรุงธนบุรี ใต้", "จอมทอง ราษฎร์บูรณะ ทุ่งครุ บางขุนเทียน บางบอน บางแค หนองแขม"],
  ];
  const ZONE_OF = {};
  ZONES.forEach(([z, ds]) => ds.split(" ").forEach((d) => { ZONE_OF[d] = z; }));
  const ZONE_ORDER = [...ZONES.map((z) => z[0]), "นนทบุรี", "ปทุมธานี", "สมุทรปราการ", "สมุทรสาคร", "นอกพื้นที่"];
  const PAGE = 10, GROUP_SHOW = 5;
  const st = { q: "", level: "all", zone: "", groupBy: "zone", page: 1, open: new Set() };

  let DATA = null, TRAFFY = null, ROADS = null, DIST = null, grid = null, groups = [], sel = null;

  // ------------------------------------------------------------- map: plain schematic look, real tiles optional
  const map = L.map("map", { zoomSnap: 0.25 }).setView([13.78, 100.58], 11);
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, opacity: 0.55, attribution: "© OpenStreetMap" });
  map.createPane("base").style.zIndex = 250;
  const base = L.layerGroup().addTo(map);
  const lines = L.layerGroup().addTo(map);
  const nums = L.layerGroup().addTo(map);
  $("#basemap").addEventListener("change", (e) => (e.target.checked ? tiles.addTo(map) : map.removeLayer(tiles)));

  function drawBase(dist, canals) {
    if (dist) {
      L.geoJSON(dist, { pane: "base", interactive: false, style: { color: "#cfd6dd", weight: 0.8, fill: false } }).addTo(base);
      for (const f of dist.features) {
        if (f.properties.province !== "กรุงเทพมหานคร" && !/เมือง/.test(f.properties.name)) continue;
        L.tooltip({ permanent: true, direction: "center", className: "dist-label" }).setLatLng([f.properties.lat, f.properties.lon]).setContent(esc(f.properties.name)).addTo(base);
      }
    }
    if (canals) {
      L.geoJSON(canals, { pane: "base", interactive: false, filter: (f) => f.properties.name.startsWith("แม่น้ำ"),
        style: { color: "#9ecae1", weight: 7, opacity: 0.9 } }).addTo(base);
    }
  }
  // district labels only when zoomed in enough to read them
  map.on("zoomend", () => document.querySelectorAll(".dist-label").forEach((el) => { el.style.display = map.getZoom() >= 11 ? "" : "none"; }));

  // ------------------------------------------------------------- road index
  const kx = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
  function segDist(lat, lon, a, b) {
    const X = kx(lat), Y = 110570;
    const ax = (a[0] - lon) * X, ay = (a[1] - lat) * Y, bx = (b[0] - lon) * X, by = (b[1] - lat) * Y;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  }
  const lineDist = (lat, lon, coords) => { let m = Infinity; for (let i = 1; i < coords.length; i++) m = Math.min(m, segDist(lat, lon, coords[i - 1], coords[i])); return m; };
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function districtAt(lat, lon) {
    for (const f of (DIST && DIST.features) || []) {
      const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      if (polys.some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)))) return f.properties;
    }
    return null;
  }

  function buildGrid() {
    grid = new Map();
    ROADS.features.forEach((f, i) => {
      if (!f.properties.key || SKIP_ROAD.test(f.properties.name)) return;
      const seen = new Set();
      for (const [lon, lat] of f.geometry.coordinates) {
        const k = cellKey(lat, lon);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    });
  }
  function nearWays(lat, lon) {
    const out = new Set(), r = Math.floor(lat / CELL), c = Math.floor(lon / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const w of grid.get(`${r + i}:${c + j}`) || []) out.add(w);
    return out;
  }
  function snap(lat, lon) {
    let best = null, bd = SNAP_M;
    for (const i of nearWays(lat, lon)) {
      const d = lineDist(lat, lon, ROADS.features[i].geometry.coordinates);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ------------------------------------------------------------- reports → roads
  function reports(winH) {
    const out = [];
    for (const e of DATA.events || []) {
      const active = new Date(e.stop) >= Date.now();
      if (!active && hoursAgo(e.start) > winH) continue;
      const closed = e.kind === "roadclosed" || /\(ผ่านไม่ได้\)/.test(e.title);
      const jam = e.kind === "trafficjam";
      out.push({ lat: e.lat, lon: e.lon, time: e.start, active, src: e.source, official: e.official,
        pts: e.color === "green" ? 0 : closed || e.color === "red" ? 3 : jam ? 1 : 2,
        red: closed || e.color === "red", green: e.color === "green", depth: e.depth_cm || null,
        text: `${e.title}${e.km ? ` · กม. ${e.km}` : ""}${e.depth_cm ? ` (ลึก ~${e.depth_cm} ซม.)` : ""}`, kind: jam ? "jam" : "flood" });
    }
    for (const t of (TRAFFY && TRAFFY.reports) || []) {
      // Traffy's flood category also holds unrelated complaints; keep reports that talk about water
      if (t.state === "done" || hoursAgo(t.time) > winH || !WATER.test(t.text)) continue;
      out.push({ lat: t.lat, lon: t.lon, time: t.time, active: true, src: "Traffy Fondue", traffy: true,
        pts: (t.depth_cm || 0) >= 30 ? 2 : 1, red: false, green: false, depth: t.depth_cm || null, text: t.text, id: t.id, kind: "traffy" });
    }
    return out;
  }

  function analyse() {
    const winH = +$("#win").value;
    const byRoad = new Map();
    for (const r of reports(winH)) {
      const w = snap(r.lat, r.lon);
      if (w == null) continue;
      const key = ROADS.features[w].properties.key;
      if (!byRoad.has(key)) byRoad.set(key, { key, name: ROADS.features[w].properties.name, reps: [] });
      byRoad.get(key).reps.push(r);
    }
    groups = [];
    for (const g of byRoad.values()) {
      const lg = g.reps.filter((r) => !r.traffy), tr = g.reps.filter((r) => r.traffy);
      const score = lg.reduce((s, r) => s + r.pts, 0) + Math.min(8, tr.reduce((s, r) => s + r.pts, 0));
      const maxDepth = Math.max(0, ...g.reps.map((r) => r.depth || 0));
      const anyRed = g.reps.some((r) => r.red);
      const deep = g.reps.filter((r) => (r.depth || 0) >= 45).length;
      const n = g.reps.filter((r) => !r.green).length;
      const onlyGreen = lg.length && lg.every((r) => r.green) && !tr.length;
      // red needs corroboration: an official/red report, deep water reported twice, or many reports
      g.level = onlyGreen ? "green" : anyRed || deep >= 2 || score >= 10 ? "red" : score >= 4 && n >= 2 ? "orange" : null;
      if (!g.level) continue;
      const live = g.reps.filter((r) => r.active && !r.green);
      g.since = live.length ? live.map((r) => r.time).sort()[0] : null;
      g.lasting = g.since && hoursAgo(g.since) >= 3;
      g.score = score; g.maxDepth = maxDepth; g.nLongdo = lg.length; g.nTraffy = tr.length;
      g.nOfficial = lg.filter((r) => r.official).length;
      g.latest = g.reps.map((r) => r.time).sort().pop();
      // number sits on the report closest to all the others (medoid), so it stays on the road
      const pts = g.reps.slice(0, 60);
      let best = pts[0], bd = Infinity;
      for (const a of pts) {
        const d = pts.reduce((s2, b) => s2 + Math.hypot(a.lat - b.lat, a.lon - b.lon), 0);
        if (d < bd) { bd = d; best = a; }
      }
      g.at = [best.lat, best.lon];
      const home = districtAt(best.lat, best.lon);
      g.zone = home ? (home.province === "กรุงเทพมหานคร" ? ZONE_OF[home.name] || "กรุงเทพฯ กลาง" : home.province) : "นอกพื้นที่";
      g.districts = [...new Set(g.reps.map((r) => { const d = districtAt(r.lat, r.lon); return d && d.name; }).filter(Boolean))];
      groups.push(g);
    }
    const rank = { red: 0, orange: 1, green: 2 };
    groups.sort((a, b) => rank[a.level] - rank[b.level] || b.lasting - a.lasting || b.score - a.score);
    groups.forEach((g, i) => { g.n = i + 1; });
  }

  // ------------------------------------------------------------- render
  function segmentsFor(g) {
    const out = [];
    const ways = new Set();
    for (const r of g.reps) for (const i of nearWays(r.lat, r.lon)) ways.add(i);
    // also look one ring further out so segments extend ~SEG_M along the road
    for (const r of g.reps) {
      const rr = Math.floor(r.lat / CELL), cc = Math.floor(r.lon / CELL);
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const w of grid.get(`${rr + i}:${cc + j}`) || []) ways.add(w);
    }
    for (const i of ways) {
      const f = ROADS.features[i];
      if (f.properties.key !== g.key) continue;
      const c = f.geometry.coordinates;
      if (g.reps.some((r) => lineDist(r.lat, r.lon, c) <= SEG_M)) out.push(c.map(([lo, la]) => [la, lo]));
    }
    return out;
  }

  const matches = (g) => (st.level === "all" || g.level === st.level) && (!st.zone || g.zone === st.zone) &&
    (!st.q || g.name.includes(st.q) || g.zone.includes(st.q) || g.districts.some((d) => d.includes(st.q)));

  function render() {
    const red = groups.filter((g) => g.level === "red").length, orange = groups.filter((g) => g.level === "orange").length;
    const avoid = red + orange;
    $("#title").innerHTML = avoid ? `เลี่ยง <em>${avoid}</em> ถนนนี้ อาจมีน้ำท่วมขัง` : "ยังไม่พบถนนสายหลักที่ควรเลี่ยง";
    $("#lead").textContent = avoid
      ? `สีแดง ${red} สาย มีรายงานผ่านไม่ได้ น้ำลึก หรือรายงานจำนวนมาก · สีส้ม ${orange} สาย มีน้ำขัง ขับช้าและระวัง · ${groups.filter((g) => g.lasting && g.level !== "green").length} สาย มีรายงานต่อเนื่องเกิน 3 ชม. ควรใช้เส้นทางอื่นถ้าทำได้`
      : `ไม่มีรายงานน้ำท่วมบนถนนสายหลักในช่วง ${$("#win").value} ชม. ที่ผ่านมา`;
    renderControls();
    const shown = groups.filter(matches);
    drawMap(shown);
    renderList(shown);
  }

  function renderControls() {
    const byLevel = (lv) => groups.filter((g) => (lv === "all" || g.level === lv) && (!st.zone || g.zone === st.zone)).length;
    $("#lvl").innerHTML = [["all", "ทั้งหมด"], ["red", "แดง"], ["orange", "ส้ม"], ["green", "เขียว"]].map(([k, th]) =>
      `<button type="button" data-lv="${k}" aria-pressed="${st.level === k}">${th}<b>${byLevel(k)}</b></button>`).join("");
    const zs = ZONE_ORDER.map((z) => {
      const gs = groups.filter((g) => g.zone === z);
      return gs.length ? `<button type="button" data-zone="${esc(z)}" aria-pressed="${st.zone === z}">${esc(z)} <span class="r">${gs.filter((g) => g.level === "red").length}</span> / <span class="o">${gs.filter((g) => g.level === "orange").length}</span></button>` : "";
    }).join("");
    $("#zones").innerHTML = zs ? `${zs}<small class="note" style="align-self:center">แดง / ส้ม · กดเพื่อกรองพื้นที่</small>` : "";
  }

  function drawMap(shown) {
    lines.clearLayers(); nums.clearLayers();
    const bounds = [];
    for (const g of [...shown].reverse()) {
      const col = LV[g.level].hex;
      for (const seg of segmentsFor(g)) {
        L.polyline(seg, { color: "#fff", weight: 9, opacity: 0.9, interactive: false }).addTo(lines);
        L.polyline(seg, { color: col, weight: 5.5, opacity: 0.95, lineCap: "round" }).on("click", () => focus(g, false)).addTo(lines);
        bounds.push(...seg);
      }
      L.marker(g.at, { zIndexOffset: 1000 - g.n, icon: L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="num" style="background:${col}">${g.n}</div>` }) })
        .bindTooltip(`${g.n}. ${esc(g.name)}`, { direction: "top" }).on("click", () => focus(g, false)).addTo(nums);
    }
    if (bounds.length && !sel) map.fitBounds(L.latLngBounds(bounds).pad(0.08));
  }

  function card(g) {
    const col = LV[g.level].hex;
    const src = [g.nOfficial ? `กรมทางหลวง/iTIC ${g.nOfficial}` : "", g.nLongdo - g.nOfficial ? `ประชาชน (Longdo) ${g.nLongdo - g.nOfficial}` : "", g.nTraffy ? `Traffy ${g.nTraffy}` : ""].filter(Boolean).join(" · ");
    const sorted = [...g.reps].sort((a, b) => b.pts - a.pts || (a.time < b.time ? 1 : -1));
    const li = (r) => `<li>${esc(r.text.slice(0, 120))} <small>${esc(r.src)} · ${fmtClock(r.time)}${r.id ? ` · <a href="https://share.traffy.in.th/teamchadchart/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Traffy</a>` : ""}</small></li>`;
    return `<article class="road${sel === g.key ? " sel" : ""}" style="--c:${col}" data-key="${esc(g.key)}">
      <div class="num" style="background:${col}">${g.n}</div>
      <h3>${esc(g.name)}<span class="lv">${LV[g.level].th}</span>${st.groupBy !== "zone" ? `<span class="zone-tag">${esc(g.zone)}</span>` : ""}</h3>
      <div class="m">${src}${g.maxDepth ? ` · ลึกสุดที่แจ้ง ~${g.maxDepth} ซม.` : ""}${g.since ? ` · ${g.lasting ? "ต่อเนื่อง" : "เริ่มรายงาน"}ตั้งแต่ ${fmtWhen(g.since)}` : ""}${g.districts.length ? ` · เขต ${esc(g.districts.slice(0, 4).join(", "))}${g.districts.length > 4 ? " …" : ""}` : ""}</div>
      <ul>${sorted.slice(0, 2).map(li).join("")}</ul>
      ${sorted.length > 2 ? `<details class="all"><summary>ดูรายงานทั้งหมด (${sorted.length})</summary><ul>${sorted.slice(2, 40).map(li).join("")}</ul></details>` : ""}
    </article>`;
  }

  function renderList(shown) {
    const pager = $("#pager");
    pager.innerHTML = "";
    if (!shown.length) {
      $("#count").textContent = "";
      $("#list").innerHTML = `<p class="av-empty">ไม่มีถนนที่ตรงเงื่อนไข</p>`;
      return;
    }
    if (st.groupBy === "none") {
      const pages = Math.ceil(shown.length / PAGE);
      st.page = Math.min(Math.max(1, st.page), pages);
      const from = (st.page - 1) * PAGE;
      $("#count").textContent = `แสดง ${from + 1}–${Math.min(from + PAGE, shown.length)} จาก ${shown.length} สาย`;
      $("#list").innerHTML = shown.slice(from, from + PAGE).map(card).join("");
      if (pages > 1) {
        const btn = (p, label, dis) => `<button type="button" data-page="${p}"${dis ? " disabled" : ""}${p === st.page && !label ? ' aria-current="page"' : ""}>${label || p}</button>`;
        const nums2 = [];
        for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - st.page) <= 1) nums2.push(p); else if (nums2[nums2.length - 1] !== "…") nums2.push("…");
        pager.innerHTML = btn(st.page - 1, "‹ ก่อนหน้า", st.page === 1) + nums2.map((p) => (p === "…" ? "<span>…</span>" : btn(p))).join("") + btn(st.page + 1, "ถัดไป ›", st.page === pages);
      }
    } else {
      const keyOf = st.groupBy === "zone" ? (g) => g.zone : (g) => g.level;
      const order = st.groupBy === "zone" ? ZONE_ORDER : ["red", "orange", "green"];
      const titleOf = st.groupBy === "zone" ? (k) => k : (k) => `${k === "red" ? "🔴" : k === "orange" ? "🟠" : "🟢"} ${LV[k].th}`;
      const secs = order.map((k) => [k, shown.filter((g) => keyOf(g) === k)]).filter(([, gs]) => gs.length);
      $("#count").textContent = `${shown.length} สาย ใน ${secs.length} กลุ่ม`;
      $("#list").innerHTML = secs.map(([k, gs]) => {
        const more = st.open.has(k) ? gs.length : GROUP_SHOW;
        const r = gs.filter((g) => g.level === "red").length, o = gs.filter((g) => g.level === "orange").length;
        return `<details class="av-sec" open data-sec="${esc(k)}"><summary><span class="t">${esc(titleOf(k))}</span>
          <small>${gs.length} สาย${st.groupBy === "zone" ? ` · แดง ${r} · ส้ม ${o}` : ""}</small></summary>
          <div class="items">${gs.slice(0, more).map(card).join("")}
          ${gs.length > more ? `<button type="button" class="more" data-more="${esc(k)}">ดูอีก ${gs.length - more} สาย</button>` : ""}
          ${st.open.has(k) && gs.length > GROUP_SHOW ? `<button type="button" class="more" data-less="${esc(k)}">ย่อกลับ</button>` : ""}</div></details>`;
      }).join("");
    }
  }

  // one delegated handler for the list, controls and pager
  document.addEventListener("click", (e) => {
    const t = e.target;
    const b = t.closest("button");
    if (b && b.dataset.lv) { st.level = b.dataset.lv; st.page = 1; sel = null; render(); return; }
    if (b && b.dataset.zone !== undefined && b.closest("#zones")) { st.zone = st.zone === b.dataset.zone ? "" : b.dataset.zone; st.page = 1; sel = null; render(); return; }
    if (b && b.dataset.page) { st.page = +b.dataset.page; renderList(groups.filter(matches)); $("#count").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (b && b.dataset.more) { st.open.add(b.dataset.more); renderList(groups.filter(matches)); return; }
    if (b && b.dataset.less) { st.open.delete(b.dataset.less); renderList(groups.filter(matches)); document.querySelector(`[data-sec="${CSS.escape(b.dataset.less)}"]`)?.scrollIntoView({ block: "start" }); return; }
    const road = t.closest(".road");
    if (road && !t.closest("a") && !t.closest("details.all")) focus(groups.find((g) => g.key === road.dataset.key), true);
  });
  $("#q").addEventListener("input", () => { st.q = $("#q").value.trim(); st.page = 1; sel = null; render(); });
  $("#groupBy").addEventListener("change", () => { st.groupBy = $("#groupBy").value; st.page = 1; renderList(groups.filter(matches)); });

  // Make sure the road's card is on screen (right page / expanded group), then highlight it
  function reveal(g) {
    const shown = groups.filter(matches);
    if (!shown.includes(g)) { st.level = "all"; st.zone = ""; st.q = ""; $("#q").value = ""; renderControls(); }
    const list = groups.filter(matches);
    if (st.groupBy === "none") st.page = Math.floor(list.indexOf(g) / PAGE) + 1;
    else st.open.add(st.groupBy === "zone" ? g.zone : g.level);
    renderList(list);
  }

  function focus(g, scroll) {
    sel = g.key;
    const segs = segmentsFor(g).flat();
    map.fitBounds(L.latLngBounds(segs.length ? segs : [g.at]).pad(0.4), { maxZoom: 15 });
    if (!scroll) reveal(g);
    document.querySelectorAll(".road").forEach((el) => el.classList.toggle("sel", el.dataset.key === g.key));
    const cardEl = document.querySelector(`.road[data-key="${CSS.escape(g.key)}"]`);
    if (scroll) $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
    else if (cardEl) cardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  $("#win").addEventListener("change", () => { sel = null; analyse(); render(); });

  // ------------------------------------------------------------- load
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  (async () => {
    const [dist, canals] = await Promise.all([get(DISTRICTS_URL), get(CANALS_URL)]);
    DIST = dist;
    drawBase(dist, canals);
    DATA = await get(DATA_URL + "?t=" + Date.now());
    if (!DATA) { $("#updated").textContent = "โหลดข้อมูลไม่ได้"; return; }
    $("#updated").textContent = `อัปเดตจากรายงานล่าสุด · ${fmtDate(DATA.generated_at)} น. · กำลังโหลดตำแหน่งถนน…`;
    [TRAFFY, ROADS] = await Promise.all([DATA.traffy ? get(TRAFFY_URL + "?t=" + encodeURIComponent(DATA.generated_at)) : null, get(ROADS_URL)]);
    if (!ROADS) { $("#updated").textContent = "โหลดตำแหน่งถนนไม่ได้"; return; }
    $("#updated").textContent = `อัปเดตจากรายงานล่าสุด · ${fmtDate(DATA.generated_at)} น.`;
    buildGrid();
    analyse();
    render();
  })();
})();
