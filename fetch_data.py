#!/usr/bin/env python3
"""Floodwatcher data fetcher: pulls public flood data for Greater Bangkok,
runs a rule-based risk assessment and writes floodwatcher/data/latest.json.

Stdlib only. Run every 15 min (see .github/workflows/floodwatcher.yml).
Every source is optional: a failure is recorded in `sources` and the
assessment continues with whatever is available.
"""
import email.utils
import gzip
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=7))
NOW = datetime.now(TZ)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "latest.json")
UA = "Floodwatcher/1.0 (+https://github.com/icyice1998/Flood)"

# Greater Bangkok bounding box: lat_min, lat_max, lon_min, lon_max
BBOX = (13.45, 14.20, 100.20, 100.95)
STALE_HOURS = 3

THAIWATER = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/"

# Assessment zones: (id, Thai name, English name, lat, lon, keywords for news matching)
ZONES = [
    ("bkk-inner", "กรุงเทพชั้นใน", "Inner Bangkok", 13.745, 100.515,
     ["พระนคร", "ปทุมวัน", "บางรัก", "สาทร", "ราชเทวี", "ดินแดง", "พญาไท", "Sukhumvit", "สุขุมวิท", "Silom", "สีลม"]),
    ("bkk-north", "กรุงเทพเหนือ", "North Bangkok", 13.855, 100.580,
     ["จตุจักร", "หลักสี่", "ดอนเมือง", "บางเขน", "สายไหม", "ลาดพร้าว", "Chatuchak", "Don Mueang"]),
    ("bkk-east", "กรุงเทพตะวันออก", "East Bangkok", 13.800, 100.740,
     ["มีนบุรี", "หนองจอก", "ลาดกระบัง", "คลองสามวา", "คันนายาว", "บึงกุ่ม", "Lat Krabang", "Min Buri"]),
    ("bkk-southeast", "กรุงเทพตะวันออกเฉียงใต้", "Southeast Bangkok", 13.690, 100.630,
     ["บางนา", "พระโขนง", "ประเวศ", "สวนหลวง", "วัฒนา", "คลองเตย", "Bang Na", "On Nut", "อ่อนนุช"]),
    ("bkk-thonburi", "ฝั่งธนบุรี", "Thonburi", 13.720, 100.470,
     ["ธนบุรี", "บางกอกน้อย", "บางกอกใหญ่", "คลองสาน", "ภาษีเจริญ", "ตลิ่งชัน", "บางพลัด", "Thonburi"]),
    ("bkk-southwest", "กรุงเทพตะวันตกเฉียงใต้", "Southwest Bangkok", 13.650, 100.420,
     ["บางขุนเทียน", "บางบอน", "จอมทอง", "ราษฎร์บูรณะ", "ทุ่งครุ", "หนองแขม", "บางแค", "Bang Khun Thian"]),
    ("nonthaburi", "นนทบุรี", "Nonthaburi", 13.860, 100.510,
     ["นนทบุรี", "ปากเกร็ด", "บางบัวทอง", "บางใหญ่", "Nonthaburi"]),
    ("pathum-thani", "ปทุมธานี", "Pathum Thani", 14.020, 100.600,
     ["ปทุมธานี", "รังสิต", "ธัญบุรี", "ลำลูกกา", "คลองหลวง", "Pathum Thani", "Rangsit"]),
    ("samut-prakan", "สมุทรปราการ", "Samut Prakan", 13.600, 100.620,
     ["สมุทรปราการ", "บางพลี", "พระประแดง", "บางบ่อ", "Samut Prakan", "Bang Phli"]),
    ("samut-sakhon", "สมุทรสาคร", "Samut Sakhon", 13.550, 100.280,
     ["สมุทรสาคร", "มหาชัย", "กระทุ่มแบน", "Samut Sakhon"]),
]
ZONE_RADIUS_KM = 9.0

NEWS_FEEDS = [
    ("news-google-th", "Google News (TH)",
     "https://news.google.com/rss/search?q=" + urllib.parse.quote("น้ำท่วม OR ฝนตกหนัก OR น้ำรอระบาย กรุงเทพ when:1d")
     + "&hl=th&gl=TH&ceid=TH:th"),
    ("news-google-en", "Google News (EN)",
     "https://news.google.com/rss/search?q=" + urllib.parse.quote("Bangkok flood OR flooding OR heavy rain when:1d")
     + "&hl=en-TH&gl=TH&ceid=TH:en"),
]
# Social feeds are RSS-only. Add more via FLOODWATCHER_SOCIAL_FEEDS="id|label|url;id|label|url"
SOCIAL_FEEDS = [
    ("social-reddit-bangkok", "Reddit r/Bangkok",
     "https://www.reddit.com/r/Bangkok/search.rss?q=flood+OR+flooding+OR+rain&restrict_sr=1&sort=new&t=day"),
]
FLOOD_WORDS = re.compile(r"น้ำท่วม|ท่วมขัง|น้ำรอระบาย|ฝนตกหนัก|ระดับน้ำ|ล้นตลิ่ง|flood|inundat|heavy rain|waterlog", re.I)
NEWS_MAX_AGE_H = 24

sources = {}


def log(msg):
    print(msg, file=sys.stderr)


def http_get(url, timeout=60, retries=2):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except Exception as e:  # noqa: BLE001 - any failure is recorded, never fatal
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def record(source_id, label, url, ok, count=0, latest=None, error=None, stale=0, kind="measured"):
    sources[source_id] = {
        "id": source_id, "label": label, "url": url, "kind": kind, "ok": ok,
        "count": count, "latest": latest, "stale_records": stale, "error": error,
        "fetched_at": NOW.isoformat(timespec="seconds"),
    }


def in_bbox(lat, lon):
    return lat is not None and lon is not None and BBOX[0] <= lat <= BBOX[1] and BBOX[2] <= lon <= BBOX[3]


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(a))


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def local_ts(s):
    """ThaiWater timestamps are Asia/Bangkok local time without offset."""
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    except (TypeError, ValueError):
        return None


def age_h(ts):
    return (NOW - ts).total_seconds() / 3600 if ts else None


def iso(ts):
    return ts.isoformat(timespec="minutes") if ts else None


# ---------------------------------------------------------------- sources

def fetch_waterlevel():
    sid, url = "thaiwater-waterlevel", THAIWATER + "waterlevel_load"
    try:
        data = json.loads(http_get(url))["waterlevel_data"]["data"]
    except Exception as e:  # noqa: BLE001
        record(sid, "ThaiWater water level", url, False, error=str(e)[:200])
        return []
    out = []
    for d in data:
        st = d.get("station") or {}
        lat, lon = fnum(st.get("tele_station_lat")), fnum(st.get("tele_station_long"))
        if not in_bbox(lat, lon):
            continue
        ts = local_ts(d.get("waterlevel_datetime"))
        wl, prev = fnum(d.get("waterlevel_msl")), fnum(d.get("waterlevel_msl_previous"))
        pct = fnum(d.get("storage_percent"))
        flags = []
        if wl is None:
            flags.append("missing_value")
        if ts is None or age_h(ts) > STALE_HOURS:
            flags.append("stale")
        if pct is not None and (pct < 0 or pct > 300):
            flags.append("out_of_range")
        geo = d.get("geocode") or {}
        out.append({
            "id": st.get("tele_station_oldcode") or str(st.get("id")),
            "name": (st.get("tele_station_name") or {}).get("th"),
            "name_en": (st.get("tele_station_name") or {}).get("en"),
            "lat": lat, "lon": lon,
            "province": (geo.get("province_name") or {}).get("th"),
            "amphoe": (geo.get("amphoe_name") or {}).get("th"),
            "agency": ((d.get("agency") or {}).get("agency_shortname") or {}).get("en"),
            "waterlevel_msl": wl,
            "rise_m": round(wl - prev, 3) if wl is not None and prev is not None else None,
            "bank_percent": pct,
            "to_bank_m": fnum(d.get("diff_wl_bank")),
            "situation_level": d.get("situation_level"),
            "time": iso(ts),
            "flags": flags,
            "source_id": sid,
        })
    times = [s["time"] for s in out if s["time"]]
    record(sid, "ThaiWater water level", url, True, len(out), max(times) if times else None,
           stale=sum("stale" in s["flags"] for s in out))
    return out


def fetch_rain():
    sid, url = "thaiwater-rain", THAIWATER + "rain_24h"
    try:
        data = json.loads(http_get(url, timeout=90))["data"]
    except Exception as e:  # noqa: BLE001
        record(sid, "ThaiWater rain gauges", url, False, error=str(e)[:200])
        return []
    out = []
    for d in data:
        st = d.get("station") or {}
        lat, lon = fnum(st.get("tele_station_lat")), fnum(st.get("tele_station_long"))
        if not in_bbox(lat, lon):
            continue
        ts = local_ts(d.get("rainfall_datetime"))
        r1, r24 = fnum(d.get("rain_1h")), fnum(d.get("rain_24h"))
        flags = []
        if ts is None or age_h(ts) > STALE_HOURS:
            flags.append("stale")
        # >150 mm/h or >600 mm/24h in Bangkok is almost certainly a sensor fault
        if (r1 is not None and (r1 < 0 or r1 > 150)) or (r24 is not None and (r24 < 0 or r24 > 600)):
            flags.append("out_of_range")
        geo = d.get("geocode") or {}
        out.append({
            "id": st.get("tele_station_oldcode") or str(st.get("id")),
            "name": (st.get("tele_station_name") or {}).get("th"),
            "lat": lat, "lon": lon,
            "province": (geo.get("province_name") or {}).get("th"),
            "amphoe": (geo.get("amphoe_name") or {}).get("th"),
            "agency": ((d.get("agency") or {}).get("agency_shortname") or {}).get("en"),
            "rain_1h": r1, "rain_24h": r24,
            "time": iso(ts),
            "flags": flags,
            "source_id": sid,
        })
    times = [s["time"] for s in out if s["time"]]
    record(sid, "ThaiWater rain gauges", url, True, len(out), max(times) if times else None,
           stale=sum("stale" in s["flags"] for s in out))
    return out


def fetch_forecast():
    sid = "open-meteo-forecast"
    lats = ",".join(str(z[3]) for z in ZONES)
    lons = ",".join(str(z[4]) for z in ZONES)
    url = ("https://api.open-meteo.com/v1/forecast?latitude=" + lats + "&longitude=" + lons
           + "&hourly=precipitation,precipitation_probability&forecast_hours=12&timezone=Asia%2FBangkok")
    try:
        data = json.loads(http_get(url, timeout=90))
        if isinstance(data, dict):
            data = [data]
    except Exception as e:  # noqa: BLE001
        record(sid, "Open-Meteo precipitation forecast", url, False, error=str(e)[:200], kind="forecast")
        return {}
    out = {}
    for z, d in zip(ZONES, data):
        h = d.get("hourly") or {}
        out[z[0]] = [
            {"time": t, "mm": p, "prob": pr}
            for t, p, pr in zip(h.get("time", []), h.get("precipitation", []),
                                h.get("precipitation_probability", []))
        ]
    record(sid, "Open-Meteo precipitation forecast", url, True, len(out),
           NOW.isoformat(timespec="minutes"), kind="forecast")
    return out


def fetch_river():
    sid = "open-meteo-glofas"
    # Chao Phraya at Bangkok (Memorial Bridge) and upstream at Pathum Thani.
    # GloFAS cells are ~5 km; these coordinates resolve to main-channel cells.
    pts = [("chao-phraya-bkk", "เจ้าพระยา สะพานพุทธ", 13.739, 100.497),
           ("chao-phraya-ptt", "เจ้าพระยา ปทุมธานี", 14.020, 100.530)]
    url = ("https://flood-api.open-meteo.com/v1/flood?latitude=" + ",".join(str(p[2]) for p in pts)
           + "&longitude=" + ",".join(str(p[3]) for p in pts)
           + "&daily=river_discharge,river_discharge_max&past_days=3&forecast_days=7")
    try:
        data = json.loads(http_get(url))
        if isinstance(data, dict):
            data = [data]
    except Exception as e:  # noqa: BLE001
        record(sid, "GloFAS river discharge (Open-Meteo)", url, False, error=str(e)[:200], kind="forecast")
        return []
    out = []
    for p, d in zip(pts, data):
        dl = d.get("daily") or {}
        out.append({"id": p[0], "name": p[1], "lat": p[2], "lon": p[3],
                    "days": dl.get("time", []), "discharge": dl.get("river_discharge", []),
                    "source_id": sid})
    record(sid, "GloFAS river discharge (Open-Meteo)", url, True, len(out),
           NOW.isoformat(timespec="minutes"), kind="forecast")
    return out


def parse_rss(sid, label, url, kind):
    try:
        root = ET.fromstring(http_get(url, timeout=30))
    except Exception as e:  # noqa: BLE001
        record(sid, label, url, False, error=str(e)[:200], kind=kind)
        return []
    atom = "{http://www.w3.org/2005/Atom}"
    items = list(root.iter("item")) or list(root.iter(atom + "entry"))
    out = []
    for it in items:
        title = (it.findtext("title") or it.findtext(atom + "title") or "").strip()
        link = it.findtext("link") or ""
        if not link:
            le = it.find(atom + "link")
            link = le.get("href") if le is not None else ""
        pub = it.findtext("pubDate") or it.findtext(atom + "updated") or it.findtext(atom + "published")
        ts = None
        if pub:
            try:
                ts = email.utils.parsedate_to_datetime(pub)
            except (TypeError, ValueError):
                try:
                    ts = datetime.fromisoformat(pub.replace("Z", "+00:00"))
                except ValueError:
                    ts = None
        if ts is None or age_h(ts) > NEWS_MAX_AGE_H or not FLOOD_WORDS.search(title):
            continue
        out.append({"title": title, "link": link.strip(), "source": it.findtext("source") or label,
                    "time": iso(ts.astimezone(TZ)), "kind": kind, "source_id": sid,
                    "zones": [z[0] for z in ZONES if any(k.lower() in title.lower() for k in z[5])]})
    times = [n["time"] for n in out]
    record(sid, label, url, True, len(out), max(times) if times else None, kind=kind)
    return out


def fetch_gdacs():
    sid, url = "gdacs", "https://www.gdacs.org/xml/rss.xml"
    g = "{http://www.gdacs.org}"
    try:
        root = ET.fromstring(http_get(url, timeout=30))
    except Exception as e:  # noqa: BLE001
        record(sid, "GDACS disaster alerts", url, False, error=str(e)[:200], kind="official")
        return []
    out = []
    for it in root.iter("item"):
        if it.findtext(g + "iso3") != "THA" or it.findtext(g + "iscurrent") != "true":
            continue
        out.append({"title": it.findtext("title"), "link": it.findtext("link"),
                    "level": it.findtext(g + "alertlevel"), "type": it.findtext(g + "eventtype"),
                    "from": it.findtext(g + "fromdate"), "to": it.findtext(g + "todate"),
                    "source_id": sid})
    record(sid, "GDACS disaster alerts", url, True, len(out), kind="official")
    return out


def social_feeds():
    feeds = list(SOCIAL_FEEDS)
    for spec in filter(None, os.environ.get("FLOODWATCHER_SOCIAL_FEEDS", "").split(";")):
        parts = spec.split("|", 2)
        if len(parts) == 3:
            feeds.append(tuple(parts))
    return feeds


# ---------------------------------------------------------------- assessment

LEVELS = [
    (0, "normal", "ปกติ", "Normal"),
    (3, "watch", "เฝ้าระวัง", "Watch"),
    (5, "warning", "เตือนภัย", "Warning"),
    (8, "severe", "อันตราย", "Severe"),
]
ADVICE = {
    "normal": ("ติดตามสถานการณ์ตามปกติ", "No action needed; keep monitoring."),
    "watch": ("เตรียมพร้อม ติดตามประกาศ กทม. และหลีกเลี่ยงจุดน้ำท่วมขังประจำ",
              "Be prepared, follow BMA announcements, avoid known ponding spots."),
    "warning": ("ย้ายรถและทรัพย์สินขึ้นที่สูง หลีกเลี่ยงการเดินทางในพื้นที่ เตรียมไฟฉาย/แบตสำรอง",
                "Move vehicles and valuables to higher ground, avoid travel in the area, prepare torch and power bank."),
    "severe": ("งดเดินทาง ตัดไฟชั้นล่างหากน้ำเข้าบ้าน โทร 1555 (กทม.) หรือ 1784 (ปภ.) หากต้องการความช่วยเหลือ",
               "Do not travel, cut ground-floor power if water enters, call 1555 (BMA) or 1784 (DDPM) for help."),
}


def level_for(score):
    lv = LEVELS[0]
    for row in LEVELS:
        if score >= row[0]:
            lv = row
    return lv


def assess(zone, water, rain, forecast, news):
    zid, name_th, name_en, zlat, zlon, _ = zone
    ev = {"measured": [], "forecast": [], "reported": [], "confirmed": []}
    score = 0
    fresh_kinds = set()

    near_rain = [r for r in rain if km(zlat, zlon, r["lat"], r["lon"]) <= ZONE_RADIUS_KM
                 and "out_of_range" not in r["flags"]]
    usable = [r for r in near_rain if "stale" not in r["flags"]]
    if usable:
        fresh_kinds.add("rain")
        top24 = max(usable, key=lambda r: r["rain_24h"] or 0)
        top1 = max(usable, key=lambda r: r["rain_1h"] or 0)
        r24, r1 = top24["rain_24h"] or 0, top1["rain_1h"] or 0
        # TMD classes: heavy 35.1-90 mm/24h, very heavy >90 mm/24h
        pts24 = 2 if r24 > 90 else 1 if r24 > 35 else 0
        # BMA drains are designed for ~60 mm/h; ponding often starts well below that
        pts1 = 2 if r1 >= 40 else 1 if r1 >= 20 else 0
        score += pts24 + pts1
        ev["measured"].append({
            "text": f"ฝนสะสม 24 ชม. สูงสุด {r24:.1f} มม. ({top24['name']})",
            "text_en": f"Max 24 h rain {r24:.1f} mm at {top24['name']}",
            "points": pts24, "time": top24["time"], "source_id": top24["source_id"], "station": top24["id"]})
        ev["measured"].append({
            "text": f"ฝน 1 ชม. ล่าสุดสูงสุด {r1:.1f} มม. ({top1['name']})",
            "text_en": f"Max last-hour rain {r1:.1f} mm at {top1['name']}",
            "points": pts1, "time": top1["time"], "source_id": top1["source_id"], "station": top1["id"]})

    near_wl = [w for w in water if km(zlat, zlon, w["lat"], w["lon"]) <= ZONE_RADIUS_KM
               and w["bank_percent"] is not None and not {"stale", "out_of_range"} & set(w["flags"])]
    if near_wl:
        fresh_kinds.add("water")
        top = max(near_wl, key=lambda w: w["bank_percent"])
        pct = top["bank_percent"]
        over = sum(1 for w in near_wl if w["bank_percent"] >= 100)
        # One overtopped gauge can be local (tidal gate); two or more is a pattern
        pts = 3 if over >= 2 else 2 if over == 1 or pct >= 90 else 1 if pct >= 80 else 0
        rising = [w for w in near_wl if (w["rise_m"] or 0) >= 0.05]
        score += pts + (1 if rising else 0)
        ev["measured"].append({
            "text": f"ระดับน้ำ {top['name']} {pct:.0f}% ของตลิ่ง",
            "text_en": f"Water level at {top['name_en'] or top['name']}: {pct:.0f}% of bank",
            "points": pts, "time": top["time"], "source_id": top["source_id"], "station": top["id"]})
        if rising:
            r = max(rising, key=lambda w: w["rise_m"])
            ev["measured"].append({
                "text": f"น้ำกำลังขึ้น {r['name']} +{r['rise_m']:.2f} ม. จากค่าก่อนหน้า",
                "text_en": f"Rising at {r['name_en'] or r['name']}: +{r['rise_m']:.2f} m since last reading",
                "points": 1, "time": r["time"], "source_id": r["source_id"], "station": r["id"]})

    peak = None
    fc = forecast.get(zid) or []
    if fc:
        fresh_kinds.add("forecast")
        next3 = sum((h["mm"] or 0) for h in fc[:3])
        next12 = sum((h["mm"] or 0) for h in fc)
        pts = 2 if next3 >= 30 else 1 if next3 >= 10 else 0
        score += pts
        wet = [h for h in fc if (h["mm"] or 0) >= 1]
        if wet:
            peak_h = max(wet, key=lambda h: h["mm"])
            peak = {"start": wet[0]["time"], "peak": peak_h["time"], "peak_mm": peak_h["mm"]}
        ev["forecast"].append({
            "text": f"คาดการณ์ฝน 3 ชม. ข้างหน้า {next3:.1f} มม. (12 ชม. {next12:.1f} มม.)",
            "text_en": f"Forecast rain next 3 h {next3:.1f} mm (12 h {next12:.1f} mm)",
            "points": pts, "time": fc[0]["time"], "source_id": "open-meteo-forecast"})

    zn = [n for n in news if zid in n["zones"]]
    if zn:
        score += 1
        for n in zn[:3]:
            ev["reported"].append({"text": n["title"], "link": n["link"], "points": 0,
                                   "time": n["time"], "source_id": n["source_id"]})
        ev["reported"][0]["points"] = 1

    lv = level_for(score)
    # Confidence rises with independent, fresh evidence types that agree
    agree = sum(1 for k in ("rain", "water", "forecast") if k in fresh_kinds)
    confidence = "high" if agree >= 3 and zn else "medium" if agree >= 2 else "low"
    return {
        "id": zid, "name": name_th, "name_en": name_en, "lat": zlat, "lon": zlon,
        "radius_km": ZONE_RADIUS_KM, "score": score, "level": lv[1], "level_th": lv[2], "level_en": lv[3],
        "confidence": confidence, "window": peak, "evidence": ev,
        "advice": ADVICE[lv[1]][0], "advice_en": ADVICE[lv[1]][1],
        "note": "ยังไม่มีการยืนยันผลกระทบด้วย CCTV/ดาวเทียม" if not ev["confirmed"] else None,
    }


def main():
    water = fetch_waterlevel()
    rain = fetch_rain()
    forecast = fetch_forecast()
    river = fetch_river()
    news = []
    for sid, label, url in NEWS_FEEDS:
        news += parse_rss(sid, label, url, "news")
    for sid, label, url in social_feeds():
        news += parse_rss(sid, label, url, "social")
    seen, deduped = set(), []
    for n in sorted(news, key=lambda n: n["time"], reverse=True):
        key = re.sub(r"\W+", "", n["title"].split(" - ")[0].lower())
        if key not in seen:
            seen.add(key)
            deduped.append(n)
    gdacs = fetch_gdacs()

    zones = [assess(z, water, rain, forecast, deduped) for z in ZONES]
    order = {r[1]: i for i, r in enumerate(LEVELS)}
    zones.sort(key=lambda z: (-order[z["level"]], -z["score"]))

    payload = {
        "generated_at": NOW.isoformat(timespec="seconds"),
        "bbox": BBOX,
        "method": {
            "version": 1,
            "levels": {r[1]: f"score >= {r[0]}" for r in LEVELS},
            "stale_hours": STALE_HOURS,
            "zone_radius_km": ZONE_RADIUS_KM,
            "disclaimer": ("ระบบทดลอง ใช้กฎอย่างง่าย ไม่ใช่ประกาศทางการ โปรดตรวจสอบกับ กทม. / ปภ. / กรมอุตุฯ"),
        },
        "zones": zones,
        "stations": {"water": water, "rain": rain},
        "river": river,
        "news": deduped[:40],
        "official": gdacs,
        "sources": list(sources.values()),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    ok = sum(s["ok"] for s in sources.values())
    log(f"wrote {OUT}: {len(zones)} zones, {len(water)} water, {len(rain)} rain, "
        f"{len(deduped)} news, sources ok {ok}/{len(sources)}")
    for z in zones:
        log(f"  {z['level']:8} score={z['score']} conf={z['confidence']:6} {z['name_en']}")
    # Fail the job only if every core measured source is down
    if not water and not rain:
        sys.exit(1)


if __name__ == "__main__":
    main()
