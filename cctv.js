// BMA traffic (สจส.) and Bangkok flood cameras. Frames come from cctv.maholan.net, which proxies
// bmatraffic.com and the other city feeds over https; data/cctv.json holds the list and AI flood flags.
window.CCTV = (() => {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ORG = {
    "กทม. (สจส.)": "#1e88e5", "กทม. (เฝ้าระวังน้ำท่วม)": "#00897b", "สำนักการระบายน้ำ กทม.": "#3949ab",
    "กรมทางหลวง": "#f9a825", "iTIC": "#8e24aa", "นนทบุรี": "#6d4c41", "กรมทรัพยากรน้ำ": "#0277bd", "อื่นๆ": "#78909c",
  };
  const LV = { minor: "ท่วมเล็กน้อย", moderate: "ท่วมปานกลาง", severe: "ท่วมหนัก" };
  const REFRESH_MS = 15000;
  let base = "https://cctv.maholan.net", data = null;

  async function load() {
    const r = await fetch("data/cctv.json?t=" + Math.floor(Date.now() / 300000));
    if (!r.ok) throw new Error("cctv.json HTTP " + r.status);
    data = await r.json();
    base = data.base || base;
    data.cameras.forEach((c) => { c.ai = data.ai[c.id] || null; });
    return data;
  }
  const snap = (id) => `${base}/api/snap/${encodeURIComponent(id)}?t=${Math.floor(Date.now() / REFRESH_MS)}`;
  const viewer = (id) => `${base}/?cam=${encodeURIComponent(id)}`;
  const aiText = (a) => a ? `💧 AI: ${LV[a.level] || a.level} · มั่นใจ ${Math.round((a.conf || 0) * 100)}%` : "";

  function popupHtml(c) {
    return `<div class="cam-pop"><b>${esc(c.name)}</b><br><small>${esc(c.org)}${c.district ? " · " + esc(c.district) : ""}</small>
      ${c.ai ? `<div class="cc-ai">${aiText(c.ai)}<br><small>${esc(c.ai.note)} · ${esc((c.ai.at || "").slice(11, 16))} น.</small></div>` : ""}
      <div class="cam-video cc-frame"><img alt="${esc(c.name)}" referrerpolicy="no-referrer"><div class="cam-msg">กำลังโหลดภาพ…</div></div>
      <small><span class="cc-time">ภาพนิ่ง อัปเดตทุก ${REFRESH_MS / 1000} วิ</span> · <a href="${viewer(c.id)}" target="_blank" rel="noopener">ดูเต็มจอ ↗</a><br>
      ภาพผ่าน <a href="${base}/" target="_blank" rel="noopener">cctv.maholan.net</a> (BMA Traffic / กทม.)</small></div>`;
  }

  // Refresh the frame while the popup is open; returns a stop function
  function play(c, root) {
    const img = root.querySelector(".cc-frame img"), msg = root.querySelector(".cc-frame .cam-msg"), ts = root.querySelector(".cc-time");
    let fails = 0, got = false, timer = null;
    img.onload = () => { got = true; fails = 0; msg.hidden = true; if (ts) ts.textContent = "ภาพล่าสุด " + new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
    img.onerror = () => { if (++fails >= 2 && !got) { msg.hidden = false; msg.textContent = "กล้องนี้ไม่มีภาพตอนนี้ (ออฟไลน์หรือต้นทางปิด)"; } };
    const tick = () => { if (!document.hidden) img.src = snap(c.id); };
    tick();
    timer = setInterval(tick, REFRESH_MS);
    return () => { clearInterval(timer); img.onload = img.onerror = null; img.removeAttribute("src"); };
  }

  // Canvas dots for the cameras plus a 💧 pin for each AI flood flag; popups refresh the frame while open
  function layer(map, cams, { pane = "cctvPane", aiPane = "cctvAiPane" } = {}) {
    if (!map.getPane(pane)) map.createPane(pane).style.zIndex = 620;
    if (!map.getPane(aiPane)) map.createPane(aiPane).style.zIndex = 640;
    const renderer = L.canvas({ pane, padding: 0.3 });
    const group = L.layerGroup(), markers = {};
    let stop = null;
    const wire = (m, c) => {
      m.bindPopup(() => popupHtml(c), { maxWidth: 360, minWidth: 260, autoPanPadding: [20, 20] });
      m.on("popupopen", (e) => { if (stop) stop(); stop = play(c, e.popup.getElement()); });
      m.on("popupclose", () => { if (stop) { stop(); stop = null; } });
      return m;
    };
    cams.forEach((c) => {
      const m = wire(L.circleMarker([c.lat, c.lon], { renderer, pane, radius: 5, weight: 1.2, color: "#fff", fillColor: ORG[c.org] || ORG["อื่นๆ"], fillOpacity: 0.95 }), c);
      m.bindTooltip(esc(c.name), { direction: "top", offset: [0, -4] });
      m.addTo(group);
      markers[c.id] = m;
      if (c.ai) {
        const p = wire(L.marker([c.lat, c.lon], { pane: aiPane, zIndexOffset: 1000, title: aiText(c.ai),
          icon: L.divIcon({ className: "", iconSize: [40, 20], iconAnchor: [20, 10], html: `<div class="cc-ai-pin ${c.ai.level}">💧AI</div>` }) }), c);
        p.addTo(group);
        markers[c.id] = p;
      }
    });
    return { group, markers };
  }

  const km = (a, b, c, d) => {
    const R = 6371, r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const near = (lat, lon, maxKm, max) => (data ? data.cameras : [])
    .map((c) => ({ c, d: km(lat, lon, c.lat, c.lon) })).filter((x) => x.d <= maxKm).sort((a, b) => a.d - b.d).slice(0, max);

  return { load, snap, viewer, popupHtml, play, layer, near, km, ORG, LV, aiText, esc, get data() { return data; } };
})();
