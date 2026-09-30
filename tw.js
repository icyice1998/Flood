// Shared ThaiWater (HII/สสน.) loaders for the national pages. The public API sends CORS headers for
// this site's origin, so the browser reads it live; nothing is cached server-side.
window.TW = (() => {
  "use strict";
  const API = "https://api-v3.thaiwater.net/api/v1/thaiwater30/";
  const num = (x) => (x == null || x === "" ? null : +x);
  const th = (o) => (o && (o.th || o.en)) || "";
  // ThaiWater rate-limits bursts (HTTP 429), so requests go one at a time and a 429 is retried with backoff
  let queue = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetchRetry(path) {
    for (const wait of [0, 3000, 10000, 30000]) {
      if (wait) await sleep(wait);
      // 5-minute cache key: quick reloads share the browser cache, data still refreshes
      const r = await fetch(API + path + (path.includes("?") ? "&" : "?") + "t=" + Math.floor(Date.now() / 300000));
      if (r.status === 429 || r.status === 503) continue;
      if (!r.ok) throw new Error(`ThaiWater ${path}: HTTP ${r.status}`);
      return r.json();
    }
    throw new Error("ThaiWater ไม่ว่าง (HTTP 429) ลองใหม่อีกครั้งภายหลัง");
  }
  const get = (path) => {
    const job = queue.then(() => fetchRetry(path));
    queue = job.catch(() => {});
    return job;
  };
  const daysOld = (d) => (Date.now() - new Date(String(d).slice(0, 10) + "T00:00:00+07:00")) / 86400000;

  // River and canal telemetry: % of bank capacity, level, previous level, discharge
  async function waterlevel() {
    const j = await get("public/waterlevel_load");
    return (j.waterlevel_data && j.waterlevel_data.data || []).map((r) => {
      const s = r.station || {};
      const msl = num(r.waterlevel_msl), prev = num(r.waterlevel_msl_previous);
      return {
        id: s.id, code: s.tele_station_oldcode || "", name: th(s.tele_station_name),
        lat: s.tele_station_lat, lon: s.tele_station_long, river: r.river_name || "",
        basin: r.basin ? th(r.basin.basin_name) : "", region: r.geocode ? th(r.geocode.area_name) : "",
        province: r.geocode ? th(r.geocode.province_name) : "",
        pct: num(r.storage_percent), msl, diff: num(r.diff_wl_bank),
        trend: msl != null && prev != null ? +(msl - prev).toFixed(2) : null, time: r.waterlevel_datetime, q: num(r.discharge),
      };
    }).filter((x) => x.lat && x.lon && x.pct != null && inThailand(x));
  }

  // Dams and reservoirs (RID/EGAT via ThaiWater): large (daily), medium, small telemetered
  async function dams() {
    const j = await get("analyst/dam");
    const d = j.data || {};
    const base = (r, kind) => ({
      kind, id: r.dam && r.dam.id, name: th(r.dam && r.dam.dam_name) || th(r.dam && r.dam.smalldam_name),
      lat: r.dam && (r.dam.dam_lat ?? r.dam.tele_station_lat), lon: r.dam && (r.dam.dam_long ?? r.dam.tele_station_long),
      basin: r.basin ? th(r.basin.basin_name) : "", region: r.geocode ? th(r.geocode.area_name) : "",
      province: r.geocode ? th(r.geocode.province_name) : "",
    });
    const latest = new Map();
    for (const r of d.dam_daily || []) {
      const k = r.dam && r.dam.id;
      if (!latest.has(k) || r.dam_date > latest.get(k).dam_date) latest.set(k, r);
    }
    const large = [...latest.values()].map((r) => Object.assign(base(r, "large"), {
      pct: num(r.dam_storage_percent), storage: num(r.dam_storage), cap: num(r.dam && (r.dam.normal_storage || r.dam.max_storage)),
      max: num(r.dam && r.dam.max_storage), inflow: num(r.dam_inflow), release: num(r.dam_released), spill: num(r.dam_spilled),
      usable: num(r.dam_uses_water), usablePct: num(r.dam_uses_water_percent), date: r.dam_date,
    }));
    const medium = (d.dam_medium || []).filter((r) => r.dam_date && daysOld(r.dam_date) <= 7).map((r) => Object.assign(base(r, "medium"), {
      pct: num(r.dam_storage_percent), storage: num(r.dam_storage), cap: num(r.dam && r.dam.normal_storage), date: r.dam_date,
    }));
    const small = (d.dam_small_tele || []).filter((r) => r.smalldam_datetime && daysOld(r.smalldam_datetime) <= 7).map((r) => Object.assign(base(r, "small"), {
      name: th(r.dam && r.dam.smalldam_name), lat: r.dam && r.dam.tele_station_lat, lon: r.dam && r.dam.tele_station_long,
      pct: num(r.percent_storage), storage: num(r.volume), date: r.smalldam_datetime,
    }));
    const ok = (x) => x.lat && x.lon && x.pct != null && inThailand(x);
    // Some large dams are listed twice (RID and EGAT records); keep the one with a real % and the latest date
    const byName = new Map();
    for (const x of large.filter(ok)) {
      const y = byName.get(x.name);
      const better = !y || (y.pct <= 0 && x.pct > 0) || (x.pct > 0 === y.pct > 0 && x.date > y.date);
      if (better) byName.set(x.name, x);
    }
    return { large: [...byName.values()], medium: medium.filter(ok), small: small.filter(ok) };
  }

  // Rain gauges, last 24 h
  async function rain24() {
    const j = await get("public/rain_24h");
    return (j.data || []).map((r) => ({
      name: th(r.station && r.station.tele_station_name), lat: r.station && r.station.tele_station_lat, lon: r.station && r.station.tele_station_long,
      mm: num(r.rain_24h), h1: num(r.rain_1h), time: r.rainfall_datetime,
      province: r.geocode ? th(r.geocode.province_name) : "", region: r.geocode ? th(r.geocode.area_name) : "",
    })).filter((x) => x.lat && x.lon && x.mm != null && inThailand(x));
  }

  // Colour classes
  const RIVER = [
    { max: 10, th: "น้อยวิกฤต", hex: "#a1887f" }, { max: 30, th: "น้อย", hex: "#d7ccc8" }, { max: 70, th: "ปกติ", hex: "#66bb6a" },
    { max: 100, th: "มาก", hex: "#1e88e5" }, { max: Infinity, th: "ล้นตลิ่ง", hex: "#c62828" },
  ];
  // RID reservoir bands (% of normal storage)
  const DAM = [
    { max: 30, th: "น้อย", hex: "#ffb74d" }, { max: 50, th: "ค่อนข้างน้อย", hex: "#fff176" }, { max: 80, th: "ปานกลาง", hex: "#81c784" },
    { max: 100, th: "มาก", hex: "#42a5f5" }, { max: Infinity, th: "เกินความจุ", hex: "#c62828" },
  ];
  const RAIN = [
    { max: 0.1, th: "ไม่มีฝน", hex: "#eceff1" }, { max: 10, th: "เล็กน้อย", hex: "#90caf9" }, { max: 35, th: "ปานกลาง", hex: "#42a5f5" },
    { max: 90, th: "หนัก", hex: "#f57c00" }, { max: Infinity, th: "หนักมาก", hex: "#c62828" },
  ];
  // ThaiWater also lists a few stations across the border
  const inThailand = (x) => !/สาธารณรัฐ|พม่า|เมียนมา|ลาว|กัมพูชา|มาเลเซีย/.test(x.region + x.province);
  const cls = (scale, v) => scale.find((c) => v < c.max) || scale[scale.length - 1];
  return { API, waterlevel, dams, rain24, RIVER, DAM, RAIN, cls, inThailand };
})();
