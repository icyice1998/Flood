#!/usr/bin/env python3
"""Floodwatcher data fetcher: pulls public flood data for Greater Bangkok,
assesses risk per district (เขต/อำเภอ) and per canal (คลอง), and writes
data/latest.json.

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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from news_filter import classify, strip_source
from places import districts_from_places

TZ = timezone(timedelta(hours=7))
NOW = datetime.now(TZ)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "latest.json")
DISTRICTS = os.path.join(HERE, "data", "districts.geojson")
UA = "Floodwatcher/1.0 (+https://github.com/icyice1998/Flood)"

# Greater Bangkok bounding box: lat_min, lat_max, lon_min, lon_max
BBOX = (13.45, 14.20, 100.20, 100.95)
STALE_HOURS = 3
NEARBY_KM = 4.0      # fallback radius when a district has no gauge of its own
RISE_M = 0.10        # canal rise between two runs that counts as "rising"
NEWS_MAX_AGE_H = 48      # kept for the page's time filter
NEWS_SCORE_H = 12        # only recent news counts towards a district's score

THAIWATER = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/"

NEWS_FEEDS = [
    ("news-google-th", "Google News (TH)",
     "https://news.google.com/rss/search?q=" + urllib.parse.quote(
         "(น้ำท่วม OR ท่วมขัง OR น้ำรอระบาย OR ระดับน้ำ OR ล้นตลิ่ง) (กรุงเทพ OR กทม OR นนทบุรี OR ปทุมธานี OR สมุทรปราการ) when:2d")
     + "&hl=th&gl=TH&ceid=TH:th"),
    ("news-google-en", "Google News (EN)",
     "https://news.google.com/rss/search?q=" + urllib.parse.quote("Bangkok (flood OR flooding OR \"water level\") when:2d")
     + "&hl=en-TH&gl=TH&ceid=TH:en"),
]
# Social feeds are RSS-only. Add more via FLOODWATCHER_SOCIAL_FEEDS="id|label|url;id|label|url"
SOCIAL_FEEDS = [
    ("social-reddit-bangkok", "Reddit r/Bangkok",
     "https://www.reddit.com/r/Bangkok/search.rss?q=flood+OR+flooding+OR+flooded&restrict_sr=1&sort=new&t=day"),
]

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


def record(source_id, label, url, ok, count=0, latest=None, error=None, stale=0, kind="measured", extra=None):
    sources[source_id] = {
        "id": source_id, "label": label, "url": url, "kind": kind, "ok": ok,
        "count": count, "latest": latest, "stale_records": stale, "error": error,
        "fetched_at": NOW.isoformat(timespec="seconds"), **(extra or {}),
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


def th(d, key):
    return ((d or {}).get(key) or {}).get("th")


# ---------------------------------------------------------------- districts

def load_districts():
    with open(DISTRICTS, encoding="utf-8") as f:
        gj = json.load(f)
    out = []
    for ft in gj["features"]:
        p = ft["properties"]
        g = ft["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        out.append({**p, "polys": polys})
    return out


def point_in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def district_of(districts, province, amphoe, lat, lon):
    """Match by ThaiWater's own geocode first, then by polygon."""
    for d in districts:
        if d["name"] == amphoe and d["province"] == province:
            return d["id"]
    for d in districts:
        for poly in d["polys"]:
            if point_in_ring(lon, lat, poly[0]) and not any(point_in_ring(lon, lat, h) for h in poly[1:]):
                return d["id"]
    return None


# ---------------------------------------------------------------- canals

CANAL_ALIASES = {"เปรมฯ": "เปรมประชากร", "ประเวศฯ": "ประเวศบุรีรมย์", "มหาสวัสดิ": "มหาสวัสดิ์"}
RIVER_STATIONS = {  # ThaiWater main stations that sit on a river, not a canal
    "กรมชลประทานสามเสน": "แม่น้ำเจ้าพระยา", "สะพานกรุงเทพ": "แม่น้ำเจ้าพระยา",
    "สะพานนวลฉวี": "แม่น้ำเจ้าพระยา", "เมืองสมุทรสาคร": "แม่น้ำท่าจีน", "ร.ร.บ้านสามพราน": "แม่น้ำท่าจีน",
}


def canal_key(name):
    """'ค.ลาดพร้าว ถ.xx' / 'ปตร.คลองแสนแสบ' / 'คลองลาดพร้าว วัดบางบัว' -> 'คลองลาดพร้าว'."""
    if not name:
        return None
    if name in RIVER_STATIONS:
        return RIVER_STATIONS[name]
    if name.startswith("แม่น้ำ"):
        return name.split()[0]
    n = re.sub(r"^(?:ปตร\.|ส\.|สถานีสูบน้ำ|ประตูระบายน้ำ)\s*", "", name.strip())
    n = re.sub(r"^ค\.\s*", "คลอง", n)
    if not n.startswith("คลอง"):
        return None
    m = re.match(r"(?:คลอง|ค\.)?([^\s\-(]+)(?:\s+(\d+)\b)?", n[4:].strip())
    if not m:
        return None
    base = CANAL_ALIASES.get(m.group(1), m.group(1))
    # 'คลองหลอด 2' in Bang Na is a different canal from คลองหลอด in Phra Nakhon
    return "คลอง" + base + (" " + m.group(2) if m.group(2) else "")


def link_structures(gauges):
    """Pump stations/gates named after a canal ('ส.สามเสน', 'ปตร.พระยาสุเรนทร์') join that canal."""
    known = {g["canal"] for g in gauges if g.get("canal")}
    for g in gauges:
        if g.get("canal") or not g.get("name"):
            continue
        n = re.sub(r"^(?:ปตร\.|ส\.)\s*", "", g["name"])
        first = re.split(r"[\s\-(]", n, maxsplit=1)[0]
        if "คลอง" + first in known:
            g["canal"] = "คลอง" + first


def canal_status(value, warn, crit, bank):
    if value is None:
        return "unknown"
    if bank is not None and value >= bank:
        return "overbank"
    if crit is not None and value >= crit:
        return "critical"
    if warn is not None and value >= warn:
        return "warning"
    return "normal"


STATUS_ORDER = {"overbank": 3, "critical": 2, "warning": 1, "normal": 0, "unknown": -1}
STATUS_TH = {"overbank": "ล้นตลิ่ง", "critical": "เกินระดับวิกฤต", "warning": "เกินระดับเฝ้าระวัง",
             "normal": "ปกติ", "unknown": "ไม่มีข้อมูล"}


# ---------------------------------------------------------------- sources

def fetch_waterlevel(districts):
    sid, url = "thaiwater-waterlevel", THAIWATER + "waterlevel_load"
    try:
        data = json.loads(http_get(url))["waterlevel_data"]["data"]
    except Exception as e:  # noqa: BLE001
        record(sid, "ThaiWater แม่น้ำ/คลองหลัก", url, False, error=str(e)[:200])
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
        name = th(st, "tele_station_name")
        prov, amphoe = th(geo, "province_name"), th(geo, "amphoe_name")
        status = ("overbank" if pct >= 100 else "critical" if pct >= 90 else "warning" if pct >= 80 else "normal") \
            if pct is not None else "unknown"
        out.append({
            "id": st.get("tele_station_oldcode") or str(st.get("id")),
            "name": name, "name_en": (st.get("tele_station_name") or {}).get("en"),
            "lat": lat, "lon": lon, "province": prov, "amphoe": amphoe,
            "district": district_of(districts, prov, amphoe, lat, lon),
            "canal": canal_key(name),
            "agency": ((d.get("agency") or {}).get("agency_shortname") or {}).get("en"),
            "value": wl, "unit": "ม.รทก.",
            "rise_m": round(wl - prev, 3) if wl is not None and prev is not None else None,
            "bank_percent": pct, "to_bank_m": fnum(d.get("diff_wl_bank")),
            "status": status,
            "time": iso(ts), "flags": flags, "source_id": sid,
        })
    times = [s["time"] for s in out if s["time"]]
    record(sid, "ThaiWater แม่น้ำ/คลองหลัก", url, True, len(out), max(times) if times else None,
           stale=sum("stale" in s["flags"] for s in out))
    return out


def fetch_canals(districts, previous):
    sid, url = "bma-canal", THAIWATER + "canal_waterlevel"
    try:
        data = json.loads(http_get(url))["data"]
    except Exception as e:  # noqa: BLE001
        record(sid, "สำนักการระบายน้ำ กทม. ระดับน้ำคลอง (ผ่าน ThaiWater)", url, False, error=str(e)[:200])
        return []
    out = []
    for d in data:
        st = d.get("station") or {}
        lat, lon = fnum(st.get("canal_lat")), fnum(st.get("canal_long"))
        if not in_bbox(lat, lon):
            continue
        ts = local_ts(d.get("canal_datetime"))
        v, outside = fnum(d.get("canal_value")), fnum(d.get("canal_out"))
        bank, warn, crit = fnum(st.get("bank")), fnum(st.get("warning_level")), fnum(st.get("critical_level"))
        raw = {"bank": bank, "critical": crit, "warning": warn}
        sid_ = st.get("canal_oldcode") or str(st.get("id"))
        flags = []
        # Some BMA gauges carry placeholder thresholds (bank 0 / critical 0 / warning -0.2)
        # or contradictory ones (bank below critical). Drop those rather than trust them.
        if bank is not None and bank <= 0:
            bank = None
        if crit is not None and warn is not None and crit <= 0 and warn < 0:
            crit = warn = None
        if bank is not None and crit is not None and bank < crit:
            bank = None
        if raw != {"bank": bank, "critical": crit, "warning": warn}:
            flags.append("threshold_suspect")
        if v is None:
            flags.append("missing_value")
        if ts is None or age_h(ts) > STALE_HOURS:
            flags.append("stale")
        if v is not None and (v < -4 or v > 5 or (bank is not None and v > bank + 2)):
            flags.append("out_of_range")
        if bank is None and crit is None and warn is None:
            flags.append("no_threshold")
        # Rise since the previous run (only if that reading is newer than 90 min ago)
        rise = None
        p = previous.get(sid_)
        if p and v is not None and p.get("value") is not None and p.get("time") and ts:
            pt = datetime.fromisoformat(p["time"])
            if pt < ts and (ts - pt) <= timedelta(minutes=90):
                rise = round(v - p["value"], 2)
        geo = d.get("geocode") or {}
        name = th(st, "canal_name")
        prov, amphoe = th(geo, "province_name"), th(geo, "amphoe_name")
        kind = "pump" if name and name.startswith("ส.") else "gate" if name and name.startswith("ปตร") else "canal"
        out.append({
            "id": sid_, "name": name, "lat": lat, "lon": lon, "province": prov, "amphoe": amphoe,
            "district": district_of(districts, prov, amphoe, lat, lon),
            "canal": canal_key(name), "kind": kind,
            "value": v, "outside": outside if kind != "canal" and outside else None, "unit": "ม.รทก.",
            "bank": bank, "warning": warn, "critical": crit,
            "to_bank_m": round(bank - v, 2) if bank is not None and v is not None else None,
            "thresholds_raw": raw if "threshold_suspect" in flags else None,
            "status": "unknown" if {"stale", "out_of_range", "missing_value", "no_threshold"} & set(flags)
                      else canal_status(v, warn, crit, bank),
            "rise_m": rise, "time": iso(ts), "flags": flags, "source_id": sid,
        })
    times = [s["time"] for s in out if s["time"]]
    record(sid, "สำนักการระบายน้ำ กทม. ระดับน้ำคลอง (ผ่าน ThaiWater)", url, True, len(out),
           max(times) if times else None, stale=sum("stale" in s["flags"] for s in out))
    return out


def fetch_rain(districts):
    sid, url = "thaiwater-rain", THAIWATER + "rain_24h"
    try:
        data = json.loads(http_get(url, timeout=90))["data"]
    except Exception as e:  # noqa: BLE001
        record(sid, "ThaiWater สถานีวัดฝน", url, False, error=str(e)[:200])
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
        prov, amphoe = th(geo, "province_name"), th(geo, "amphoe_name")
        out.append({
            "id": st.get("tele_station_oldcode") or str(st.get("id")),
            "name": th(st, "tele_station_name"), "lat": lat, "lon": lon,
            "province": prov, "amphoe": amphoe,
            "district": district_of(districts, prov, amphoe, lat, lon),
            "agency": ((d.get("agency") or {}).get("agency_shortname") or {}).get("en"),
            "rain_1h": r1, "rain_24h": r24,
            "time": iso(ts), "flags": flags, "source_id": sid,
        })
    times = [s["time"] for s in out if s["time"]]
    record(sid, "ThaiWater สถานีวัดฝน", url, True, len(out), max(times) if times else None,
           stale=sum("stale" in s["flags"] for s in out))
    return out


def fetch_forecast(districts):
    sid = "open-meteo-forecast"
    lats = ",".join(str(d["lat"]) for d in districts)
    lons = ",".join(str(d["lon"]) for d in districts)
    url = ("https://api.open-meteo.com/v1/forecast?latitude=" + lats + "&longitude=" + lons
           + "&hourly=precipitation,precipitation_probability&forecast_hours=12&timezone=Asia%2FBangkok")
    label = "Open-Meteo พยากรณ์ฝนรายชั่วโมง"
    try:
        data = json.loads(http_get(url, timeout=90))
        if isinstance(data, dict):
            data = [data]
    except Exception as e:  # noqa: BLE001
        record(sid, label, url[:120] + "…", False, error=str(e)[:200], kind="forecast")
        return {}
    out = {}
    for d, fc in zip(districts, data):
        h = fc.get("hourly") or {}
        out[d["id"]] = [{"time": t, "mm": p, "prob": pr} for t, p, pr in
                        zip(h.get("time", []), h.get("precipitation", []), h.get("precipitation_probability", []))]
    record(sid, label, url[:120] + "…", True, len(out), NOW.isoformat(timespec="minutes"), kind="forecast")
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
        record(sid, "GloFAS อัตราการไหลแม่น้ำ (Open-Meteo)", url, False, error=str(e)[:200], kind="forecast")
        return []
    out = []
    for p, d in zip(pts, data):
        dl = d.get("daily") or {}
        out.append({"id": p[0], "name": p[1], "lat": p[2], "lon": p[3],
                    "days": dl.get("time", []), "discharge": dl.get("river_discharge", []), "source_id": sid})
    record(sid, "GloFAS อัตราการไหลแม่น้ำ (Open-Meteo)", url, True, len(out),
           NOW.isoformat(timespec="minutes"), kind="forecast")
    return out


def place_matchers(districts, canal_names):
    """Regexes that tie a headline to districts and canals."""
    dist = []
    for d in districts:
        # 'พระนคร' must not match 'พระนครศรีอยุธยา'
        th_rx = re.escape(d["name"]) + (r"(?!ศรีอยุธยา)" if d["name"] == "พระนคร" else "")
        en_rx = r"\b" + re.escape(d["name_en"]) + r"\b" if d.get("name_en") else None
        dist.append((d["id"], re.compile(th_rx + (("|" + en_rx) if en_rx else ""), re.I)))
    canals = [(c, re.compile(re.escape(c) + "|" + re.escape(c.replace("คลอง", "ค.", 1)))) for c in canal_names if c]
    return dist, canals


def parse_rss(sid, label, url, kind, dist_rx, canal_rx, rejected):
    try:
        root = ET.fromstring(http_get(url, timeout=30))
    except Exception as e:  # noqa: BLE001
        record(sid, label, url, False, error=str(e)[:200], kind=kind)
        return []
    atom = "{http://www.w3.org/2005/Atom}"
    items = list(root.iter("item")) or list(root.iter(atom + "entry"))
    out, dropped = [], 0
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
        if ts is None or age_h(ts) > NEWS_MAX_AGE_H:
            continue
        keep, cats, reason = classify(title)
        if not keep:
            dropped += 1
            rejected[reason] = rejected.get(reason, 0) + 1
            continue
        clean = strip_source(title)
        canals = [c for c, rx in canal_rx if rx.search(clean)]
        # Remove canal names first so 'คลองลาดพร้าว' does not tag district ลาดพร้าว
        rest = clean
        for c, rx in canal_rx:
            rest = rx.sub(" ", rest)
        districts = [d for d, rx in dist_rx if rx.search(rest)]
        via = {d: place for d, place in districts_from_places(rest).items() if d not in districts}
        out.append({"title": title, "link": link.strip(), "source": it.findtext("source") or label,
                    "time": iso(ts.astimezone(TZ)), "kind": kind, "source_id": sid,
                    "categories": cats, "districts": districts + list(via), "via": via, "canals": canals})
    times = [n["time"] for n in out]
    record(sid, label, url, True, len(out), max(times) if times else None, kind=kind, extra={"filtered_out": dropped})
    return out


# Longdo Traffic incident feed: flood / traffic reports from Dept. of Highways, iTIC staff and the public
EV_RED = re.compile(r"รถติด|ติดขัด|ติดสะสม|ผ่านไม่ได้|สัญจรไม่ได้|ไม่สามารถผ่าน|รถเล็ก\S{0,8}(?:ห้าม|งด|ไม่ควร|ผ่านไม่)|"
                    r"ปิดการจราจร|ปิดถนน|ปิดเส้นทาง|heavy traffic|impassable|road closed", re.I)
EV_GREEN = re.compile(r"ลดลง|แห้งแล้ว|น้ำแห้ง|คลี่คลาย|ผ่านได้ปกติ|สัญจรได้ปกติ|กลับมาสัญจร|receding|passable", re.I)
EV_DEPTH = re.compile(r"(\d{1,3})\s*(?:ซม|ซ\.ม|เซนติเมตร|cm)", re.I)
EV_KINDS = {"flood", "trafficjam", "roadclosed"}
EV_PREFIX = re.compile(r"^(?:น้ำท่วม(?:ขัง)?|รถติด|ถนนปิด|ปิดถนน|การจราจรติดขัด)\s*")


def road_key(name):
    n = re.sub(r"^(?:ถนน|ถ\.)\s*", "", (name or "").strip())
    return re.sub(r"\s+", "", n)


def fetch_events(districts):
    sid, url = "longdo-events", "https://event.longdo.com/feed/json"
    label = "เหตุการณ์บนถนน Longdo Traffic (กรมทางหลวง / iTIC / ประชาชน)"
    try:
        data = json.loads(http_get(url, timeout=40))
    except Exception as e:  # noqa: BLE001
        record(sid, label, url, False, error=str(e)[:200], kind="reported")
        return []
    raw = []
    for e in data:
        kind = e.get("icon")
        lat, lon = fnum(e.get("latitude")), fnum(e.get("longitude"))
        if kind not in EV_KINDS or not in_bbox(lat, lon):
            continue
        try:
            start = datetime.fromisoformat(e["start"]).replace(tzinfo=TZ)
            stop = datetime.fromisoformat(e["stop"]).replace(tzinfo=TZ)
        except (KeyError, ValueError):
            continue
        # active now, or started within the last 6 h
        if stop < NOW - timedelta(minutes=30) and (NOW - start) > timedelta(hours=6):
            continue
        raw.append((e, kind, lat, lon, start, stop))

    jams = [(lat, lon) for e, kind, lat, lon, *_ in raw if kind == "trafficjam"]
    out = []
    for e, kind, lat, lon, start, stop in raw:
        text = f"{e.get('title', '')} {e.get('description', '')}"
        depth = max((int(m) for m in EV_DEPTH.findall(text)), default=None)
        contrib = e.get("contributor") or ""
        official = contrib == "DOH Admin" or contrib.startswith("itic.")
        src = "กรมทางหลวง" if contrib == "DOH Admin" else "เจ้าหน้าที่ iTIC" if contrib.startswith("itic.") else "ประชาชน (ผ่าน iTIC/Longdo)"
        if kind == "roadclosed" or EV_RED.search(text) or (depth or 0) >= 30:
            color = "red"
        elif kind == "trafficjam":
            color = "yellow"
        elif EV_GREEN.search(text):
            color = "green"
        else:
            color = "orange"
        # flooding with a traffic-jam report within 300 m counts as heavy
        if kind == "flood" and color == "orange" and any(km(lat, lon, a, b) <= 0.3 for a, b in jams):
            color = "red"
        title = e.get("title") or ""
        road = EV_PREFIX.sub("", title).strip()
        out.append({
            "id": e.get("eid"), "kind": kind, "color": color, "title": title,
            "text": re.sub(r"\s+", " ", e.get("description") or "")[:300],
            "lat": round(lat, 6), "lon": round(lon, 6),
            "start": iso(start), "stop": iso(stop), "official": official, "source": src,
            "road": road, "road_key": road_key(road), "depth_cm": depth,
            "district": district_of(districts, None, None, lat, lon), "source_id": sid,
        })
    out.sort(key=lambda x: x["start"], reverse=True)
    record(sid, label, url, True, len(out), out[0]["start"] if out else None, kind="reported",
           extra={"official": sum(x["official"] for x in out), "red": sum(x["color"] == "red" for x in out)})
    return out


def fetch_cameras(districts):
    """Traffic CCTV listed by Longdo Traffic (streams hosted by iTIC Foundation / Dept. of Highways).
    Keeps Greater Bangkok cameras with a real stream URL and probes each HLS playlist."""
    sid, url = "longdo-cctv", "https://traffic.longdo.com/camera.json"
    label = "กล้อง CCTV (Longdo Traffic / iTIC / กรมทางหลวง)"
    try:
        data = json.loads(http_get(url, timeout=30))
        cams = next(iter(data.values())) if isinstance(data, dict) else data
    except Exception as e:  # noqa: BLE001
        record(sid, label, url, False, error=str(e)[:200], kind="cctv")
        return []
    picked = []
    for c in cams:
        lat, lon = fnum(c.get("latitude")), fnum(c.get("longitude"))
        hls = c.get("hls_url") or ""
        if not in_bbox(lat, lon) or not hls.startswith("https://") or "X.X.X.X" in (c.get("imgurl") or ""):
            continue
        picked.append((c, lat, lon, hls))

    def probe(item):
        try:
            req = urllib.request.Request(item[3], headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                return r.read(64).startswith(b"#EXTM3U")
        except Exception:  # noqa: BLE001 - offline camera
            return False

    with ThreadPoolExecutor(max_workers=12) as ex:
        live = list(ex.map(probe, picked))
    out = []
    for (c, lat, lon, hls), ok in zip(picked, live):
        title = re.sub(r"^\([^)]*\)\s*", "", c.get("title") or "").strip()
        out.append({
            "id": c.get("camid"), "title": title, "lat": lat, "lon": lon,
            "org": c.get("organization"), "hls": hls, "link": c.get("link"),
            "district": district_of(districts, None, None, lat, lon),
            "live": ok, "checked": NOW.isoformat(timespec="minutes"), "source_id": sid,
        })
    record(sid, label, url, True, len(out), NOW.isoformat(timespec="minutes"), kind="cctv",
           extra={"live": sum(live)})
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
                    "from": it.findtext(g + "fromdate"), "to": it.findtext(g + "todate"), "source_id": sid})
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


def usable(x):
    return not {"stale", "out_of_range", "missing_value"} & set(x["flags"])


def local_or_near(items, d):
    own = [x for x in items if x.get("district") == d["id"] and usable(x)]
    if own:
        return own, False
    near = [x for x in items if usable(x) and km(d["lat"], d["lon"], x["lat"], x["lon"]) <= NEARBY_KM]
    return near, bool(near)


def assess(d, rain, gauges, forecast, news, events=()):
    ev = {"measured": [], "forecast": [], "reported": [], "confirmed": []}
    score = 0
    fresh = set()

    rs, near = local_or_near(rain, d)
    if rs:
        fresh.add("rain")
        top24 = max(rs, key=lambda r: r["rain_24h"] or 0)
        top1 = max(rs, key=lambda r: r["rain_1h"] or 0)
        r24, r1 = top24["rain_24h"] or 0, top1["rain_1h"] or 0
        # TMD classes: heavy 35.1-90 mm/24h, very heavy >90 mm/24h
        p24 = 2 if r24 > 90 else 1 if r24 > 35 else 0
        # BMA drains are designed for ~60 mm/h; ponding often starts well below that
        p1 = 2 if r1 >= 40 else 1 if r1 >= 20 else 0
        score += p24 + p1
        tag = " (สถานีใกล้เคียง)" if near else ""
        ev["measured"].append({"text": f"ฝนสะสม 24 ชม. สูงสุด {r24:.1f} มม. ที่ {top24['name']}{tag}",
                               "points": p24, "time": top24["time"], "source_id": top24["source_id"], "station": top24["id"]})
        ev["measured"].append({"text": f"ฝน 1 ชม. ล่าสุดสูงสุด {r1:.1f} มม. ที่ {top1['name']}{tag}",
                               "points": p1, "time": top1["time"], "source_id": top1["source_id"], "station": top1["id"]})

    gs = [g for g in gauges if g.get("district") == d["id"] and usable(g) and g["status"] != "unknown"]
    if gs:
        fresh.add("water")
        worst = max(gs, key=lambda g: (STATUS_ORDER[g["status"]], -(g["to_bank_m"] if g.get("to_bank_m") is not None else 9)))
        n_over = sum(g["status"] == "overbank" for g in gs)
        n_crit = sum(g["status"] in ("overbank", "critical") for g in gs)
        n_warn = sum(g["status"] != "normal" for g in gs)
        pts = {"overbank": 3, "critical": 2, "warning": 1}.get(worst["status"], 0)
        if n_over >= 2 or (n_crit >= 3 and pts < 3) or (n_crit >= 2 and pts < 2):
            pts += 1  # several gauges beyond critical/bank is a pattern, not a single sensor
        score += pts
        if worst.get("bank_percent") is not None:
            detail = f"{worst['bank_percent']:.0f}% ของตลิ่ง"
        else:
            detail = f"{worst['value']:.2f} ม. (ตลิ่ง {worst['bank'] if worst['bank'] is not None else '–'} ม.)"
        ev["measured"].append({
            "text": f"ระดับน้ำ: {n_over} จุดล้นตลิ่ง, {n_crit} จุดเกินวิกฤต, {n_warn}/{len(gs)} จุดเกินเฝ้าระวัง · "
                    f"หนักสุด {worst['name']} {detail} ({STATUS_TH[worst['status']]})",
            "points": pts, "time": worst["time"], "source_id": worst["source_id"], "station": worst["id"]})
        rising = [g for g in gs if (g.get("rise_m") or 0) >= RISE_M]
        if rising:
            r = max(rising, key=lambda g: g["rise_m"])
            score += 1
            ev["measured"].append({"text": f"น้ำกำลังขึ้น {len(rising)} จุด · มากสุด {r['name']} +{r['rise_m']:.2f} ม.",
                                   "points": 1, "time": r["time"], "source_id": r["source_id"], "station": r["id"]})

    window = None
    fc = forecast.get(d["id"]) or []
    if fc:
        fresh.add("forecast")
        next3 = sum((h["mm"] or 0) for h in fc[:3])
        next12 = sum((h["mm"] or 0) for h in fc)
        pts = 2 if next3 >= 30 else 1 if next3 >= 10 else 0
        score += pts
        wet = [h for h in fc if (h["mm"] or 0) >= 1]
        if wet:
            peak = max(wet, key=lambda h: h["mm"])
            window = {"start": wet[0]["time"], "peak": peak["time"], "peak_mm": peak["mm"]}
        ev["forecast"].append({"text": f"คาดการณ์ฝน 3 ชม. ข้างหน้า {next3:.1f} มม. (12 ชม. {next12:.1f} มม.)",
                               "points": pts, "time": fc[0]["time"], "source_id": "open-meteo-forecast"})

    dn = [n for n in news if d["id"] in n["districts"]]
    if dn:
        score += 1
        for i, n in enumerate(dn[:3]):
            via = n.get("via", {}).get(d["id"])
            ev["reported"].append({"text": strip_source(n["title"]) + (f" (จับคู่จาก: {via})" if via else ""),
                                   "link": n["link"], "points": 1 if i == 0 else 0,
                                   "time": n["time"], "source_id": n["source_id"], "categories": n["categories"]})

    # Road incident reports inside the district: Dept. of Highways / iTIC staff count as confirmed
    de = [e for e in events if e["district"] == d["id"] and e["kind"] != "trafficjam" and e["color"] != "green"]
    off = [e for e in de if e["official"]]
    pub = [e for e in de if not e["official"]]
    if off:
        pts = 3 if len(off) >= 3 else 2
        score += pts
        for i, e in enumerate(off[:3]):
            ev["confirmed"].append({"text": f"{e['title']} — {e['source']}" + (f" (ลึก ~{e['depth_cm']} ซม.)" if e["depth_cm"] else ""),
                                    "points": pts if i == 0 else 0, "time": e["start"], "source_id": e["source_id"], "station": e["id"]})
    if len(pub) >= 2 and not off:
        score += 1
    for i, e in enumerate(pub[:3]):
        ev["reported"].append({"text": f"{e['title']} — {e['source']}", "points": 1 if (i == 0 and len(pub) >= 2 and not off) else 0,
                               "time": e["start"], "source_id": e["source_id"], "station": e["id"]})

    lv = level_for(score)
    agree = len({"rain", "water", "forecast"} & fresh)
    confidence = "high" if (agree >= 3 and (dn or off)) or (agree >= 2 and off) else "medium" if agree >= 2 else "low"
    notes = []
    if "water" not in fresh:
        notes.append("ไม่มีสถานีวัดระดับน้ำที่ใช้งานได้ในเขตนี้")
    if not ev["confirmed"]:
        notes.append("ยังไม่มีรายงานยืนยันจากกรมทางหลวง/iTIC ในเขตนี้ — ดูกล้อง CCTV ใกล้เคียงประกอบ")
    return {
        "id": d["id"], "name": d["name"], "name_en": d["name_en"], "province": d["province"],
        "lat": d["lat"], "lon": d["lon"], "score": score,
        "level": lv[1], "level_th": lv[2], "level_en": lv[3], "confidence": confidence, "window": window,
        "gauges": len(gs), "evidence": ev, "advice": ADVICE[lv[1]][0], "advice_en": ADVICE[lv[1]][1], "notes": notes,
    }


def summarize_canals(gauges, news, district_names):
    groups = {}
    for g in gauges:
        if not g.get("canal"):
            continue
        groups.setdefault(g["canal"], []).append(g)
    out = []
    for name, gs in groups.items():
        ok = [g for g in gs if usable(g) and g["status"] != "unknown"]
        worst = max(ok, key=lambda g: (STATUS_ORDER[g["status"]], -(g["to_bank_m"] if g.get("to_bank_m") is not None else 9))) if ok else None
        rising = [g for g in ok if (g.get("rise_m") or 0) >= RISE_M]
        out.append({
            "name": name,
            "status": worst["status"] if worst else "unknown",
            "gauges": len(gs), "reporting": len(ok),
            "overbank": sum(g["status"] == "overbank" for g in ok),
            "critical": sum(g["status"] in ("overbank", "critical") for g in ok),
            "warning": sum(g["status"] != "normal" for g in ok),
            "rising": len(rising),
            "worst": {k: worst.get(k) for k in ("id", "name", "value", "bank", "to_bank_m", "bank_percent", "time", "status")} if worst else None,
            "districts": sorted({district_names.get(g["district"], g["amphoe"]) for g in gs if g.get("district") or g.get("amphoe")}),
            "news": sum(1 for n in news if name in n["canals"]),
        })
    out.sort(key=lambda c: (-STATUS_ORDER[c["status"]], -c["critical"], -c["warning"], c["name"]))
    return out


def load_previous():
    try:
        with open(OUT, encoding="utf-8") as f:
            prev = json.load(f)
        return {g["id"]: g for g in prev.get("stations", {}).get("canal", [])}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def main():
    districts = load_districts()
    previous = load_previous()
    rivers = fetch_waterlevel(districts)
    canals = fetch_canals(districts, previous)
    rain = fetch_rain(districts)
    forecast = fetch_forecast(districts)
    river = fetch_river()

    link_structures(canals + rivers)
    canal_names = sorted({g["canal"] for g in canals + rivers if g.get("canal")}, key=len, reverse=True)
    dist_rx, canal_rx = place_matchers(districts, canal_names)
    rejected = {}
    news = []
    for sid, label, url in NEWS_FEEDS:
        news += parse_rss(sid, label, url, "news", dist_rx, canal_rx, rejected)
    for sid, label, url in social_feeds():
        news += parse_rss(sid, label, url, "social", dist_rx, canal_rx, rejected)
    seen, deduped = set(), []
    for n in sorted(news, key=lambda n: n["time"], reverse=True):
        key = re.sub(r"\W+", "", strip_source(n["title"]).lower())[:60]
        if key not in seen:
            seen.add(key)
            deduped.append(n)
    gdacs = fetch_gdacs()
    cameras = fetch_cameras(districts)
    events = fetch_events(districts)

    gauges = canals + rivers
    recent = [n for n in deduped if age_h(datetime.fromisoformat(n["time"])) <= NEWS_SCORE_H]
    assessed = [assess(d, rain, gauges, forecast, recent, events) for d in districts]
    order = {r[1]: i for i, r in enumerate(LEVELS)}
    assessed.sort(key=lambda z: (-order[z["level"]], -z["score"], z["name"]))
    names = {d["id"]: d["name"] for d in districts}

    payload = {
        "version": 2,
        "generated_at": NOW.isoformat(timespec="seconds"),
        "bbox": BBOX,
        "method": {
            "levels": {r[1]: f"score >= {r[0]}" for r in LEVELS},
            "stale_hours": STALE_HOURS, "nearby_km": NEARBY_KM, "rise_m": RISE_M,
            "news_max_age_h": NEWS_MAX_AGE_H, "news_score_h": NEWS_SCORE_H,
            "disclaimer": "ระบบทดลอง ใช้กฎอย่างง่าย ไม่ใช่ประกาศทางการ โปรดตรวจสอบกับ กทม. / ปภ. / กรมอุตุฯ",
        },
        "districts": assessed,
        "canals": summarize_canals(gauges, deduped, names),
        "stations": {"canal": canals, "river": rivers, "rain": rain},
        "river": river,
        "news": deduped[:200],
        "news_filtered": rejected,
        "official": gdacs,
        "cameras": cameras,
        "events": events,
        "sources": list(sources.values()),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    ok = sum(s["ok"] for s in sources.values())
    counts = {r[1]: sum(z["level"] == r[1] for z in assessed) for r in LEVELS}
    log(f"wrote {OUT}: {len(assessed)} districts {counts}, {len(payload['canals'])} canals, "
        f"{len(canals)} canal gauges, {len(rivers)} river gauges, {len(rain)} rain, "
        f"{len(deduped)} news kept, filtered {rejected}, sources ok {ok}/{len(sources)}")
    # Fail the job only if every core measured source is down
    if not canals and not rivers and not rain:
        sys.exit(1)


if __name__ == "__main__":
    main()
