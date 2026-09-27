"""Camera AI scan for Floodwatcher.

Every run grabs one frame from each live traffic camera in Greater Bangkok
(Longdo Traffic list; streams by iTIC Foundation / Dept. of Highways) and asks
two open models what they see:

  * water on the road: CLIP zero-shot (open_clip ViT-L-14), comparing the frame
    with text prompts for dry / wet / flooded road and for a broken frame
  * vehicles: YOLO11s (COCO) counts cars, motorcycles, buses and trucks

The result is an estimate, not a measurement: every camera carries the frame
time, class probabilities, a confidence level and image-quality flags.
Writes data/cameras_ai.json. Frames are not stored.

    python scan_cameras.py
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "cameras_ai.json")
CAMERA_LIST = "https://traffic.longdo.com/camera.json"
BBOX = (13.45, 100.20, 14.20, 100.95)  # south, west, north, east
UA = "Floodwatcher/1.0 (+https://github.com/icyice1998/Flood)"
TZ = timezone(timedelta(hours=7))
NOW = datetime.now(TZ)

# Prompt groups; probabilities are summed per group after a softmax over all prompts
PROMPTS = {
    "dry": ["a traffic camera photo of a dry road",
            "a CCTV image of a dry highway with cars"],
    "wet": ["a traffic camera photo of wet shiny asphalt after rain, lane markings clearly visible",
            "a CCTV image of a highway on a rainy day with wet road surface",
            "a CCTV image of a road with a few small puddles"],
    "flood": ["a traffic camera photo of a street under flood water, road surface and lane markings hidden by water",
              "a CCTV image of cars wading through deep brown flood water",
              "a flooded road where water covers the whole street like a river"],
    "bad": ["a black screen with the text no signal",
            "a camera image blurred by raindrops on the lens",
            "a camera error message on a grey screen"],
}
CLIP_ARCH, CLIP_WEIGHTS = "ViT-L-14", "laion2b_s32b_b82k"
# A single frame is not enough: some views always look "watery" to the model. Each camera is
# compared with its own usual score (20th percentile of up to 7 days of scans).
HISTORY = os.path.join(HERE, "data", "cameras_ai_history.json")
HISTORY_MAX = 672          # 7 days of 15-minute scans
BASELINE_MIN_SCANS = 24    # 6 h before a camera can be called "flooded"
FLOODED_SCORE, FLOODED_EXCESS = 0.60, 0.35   # also needs the previous scan flagged
POSSIBLE_SCORE, POSSIBLE_EXCESS = 0.50, 0.25
BAD_MIN = 0.50
DARK = 55  # mean brightness (0-255) below which the frame counts as night
VEHICLES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
TRAFFIC = ((6, "light"), (16, "moderate"), (10**9, "heavy"))  # vehicles in frame


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def http_get(url, timeout=15, limit=4_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://traffic.longdo.com/"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit)


# ------------------------------------------------------------------ cameras & frames
def list_cameras():
    data = json.loads(http_get(CAMERA_LIST, timeout=30))
    cams = next(iter(data.values())) if isinstance(data, dict) else data
    out = []
    for c in cams:
        lat, lon = fnum(c.get("latitude")), fnum(c.get("longitude"))
        if lat is None or lon is None or not (BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]):
            continue
        img = c.get("imgurl") or ""
        hls = c.get("hls_url") or ""
        if "X.X.X.X" in img:
            img = ""
        if not (hls.startswith("https://") or img.startswith("http")):
            continue
        out.append({
            "id": c.get("camid"), "title": re.sub(r"^\([^)]*\)\s*", "", c.get("title") or "").strip(),
            "lat": lat, "lon": lon, "org": c.get("organization"),
            "hls": hls if hls.startswith("https://") else "", "img": img, "link": c.get("link") or "",
        })
    return out


FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    try:
        import imageio_ffmpeg
        FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        FFMPEG = None


def frame_from_hls(url):
    """Download the newest segment of an HLS stream and decode its first frame with ffmpeg."""
    if not FFMPEG:
        raise RuntimeError("ffmpeg not available")
    from urllib.parse import urljoin
    text = http_get(url, timeout=12).decode("utf-8", "ignore")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines:
        raise RuntimeError("empty playlist")
    if "#EXT-X-STREAM-INF" in text:  # master playlist: follow the first variant
        url = urljoin(url, lines[0])
        text = http_get(url, timeout=12).decode("utf-8", "ignore")
        lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
        if not lines:
            raise RuntimeError("empty variant playlist")
    seg = http_get(urljoin(url, lines[-1]), timeout=20, limit=8_000_000)
    p = subprocess.run([FFMPEG, "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1",
                        "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], input=seg, capture_output=True, timeout=40)
    if p.returncode or not p.stdout:
        raise RuntimeError((p.stderr.decode(errors="ignore").strip().splitlines() or ["no frame"])[-1][:120])
    return p.stdout


def grab(cam):
    """Return (jpeg bytes, source) or raise. Prefers the video stream, falls back to the still image."""
    errors = []
    if cam["hls"]:
        try:
            return frame_from_hls(cam["hls"]), "hls"
        except Exception as e:  # noqa: BLE001
            errors.append(f"hls: {e}")
    if cam["img"]:
        try:
            b = http_get(cam["img"])
            if b[:2] == b"\xff\xd8":
                return b, "jpeg"
            errors.append("jpeg: empty or not an image")
        except Exception as e:  # noqa: BLE001
            errors.append(f"jpeg: {e}")
    raise RuntimeError("; ".join(errors)[:200] or "no source")


def quality(img, digest, prev):
    """Image checks that do not need a model."""
    g = img.convert("L").resize((160, 90))
    st = ImageStat.Stat(g)
    bright, contrast = st.mean[0], st.stddev[0]
    flags = []
    if contrast < 12:
        flags.append("uniform")  # black/grey screen, lens covered
    if bright < DARK:
        flags.append("night")
    if prev and prev.get("hash") == digest:
        flags.append("frozen")  # same picture as the previous scan
    return round(bright), round(contrast), flags


# ------------------------------------------------------------------ models
class Models:
    def __init__(self):
        import open_clip
        import torch
        from ultralytics import YOLO
        self.torch = torch
        torch.set_num_threads(max(1, os.cpu_count() or 1))
        self.clip, _, self.pre = open_clip.create_model_and_transforms(CLIP_ARCH, pretrained=CLIP_WEIGHTS)
        self.clip.eval()
        tok = open_clip.get_tokenizer(CLIP_ARCH)
        self.groups, texts = [], []
        for g, ps in PROMPTS.items():
            for p in ps:
                self.groups.append(g)
                texts.append(p)
        with torch.no_grad():
            t = self.clip.encode_text(tok(texts))
            self.text = t / t.norm(dim=-1, keepdim=True)
        self.yolo = YOLO(os.environ.get("YOLO_WEIGHTS", os.path.expanduser("~/.cache/floodwatcher/yolo11s.pt")))

    def water(self, img):
        torch = self.torch
        with torch.no_grad():
            v = self.clip.encode_image(self.pre(img).unsqueeze(0))
            v = v / v.norm(dim=-1, keepdim=True)
            p = (100.0 * v @ self.text.T).softmax(dim=-1)[0].tolist()
        out = {g: 0.0 for g in PROMPTS}
        for g, x in zip(self.groups, p):
            out[g] += x
        return {g: round(x, 3) for g, x in out.items()}

    def vehicles(self, img):
        r = self.yolo.predict(img, conf=0.25, classes=list(VEHICLES), imgsz=960, verbose=False)[0]
        counts = {v: 0 for v in VEHICLES.values()}
        for c in r.boxes.cls.tolist():
            counts[VEHICLES[int(c)]] += 1
        return counts


def baseline_of(scores):
    if len(scores) < BASELINE_MIN_SCANS:
        return None
    return sorted(scores)[int(len(scores) * 0.2)] / 100


def judge(probs, flags, base, prev_flagged):
    """Status, confidence and the flood score used, from probabilities, image flags and camera history."""
    if "uniform" in flags or probs["bad"] >= BAD_MIN:
        return "unknown", "low", None
    usable = 1 - probs["bad"]
    score = probs["flood"] / usable
    excess = score - base if base is not None else None
    if base is not None and score >= FLOODED_SCORE and excess >= FLOODED_EXCESS and prev_flagged:
        status = "flooded"
    elif score >= POSSIBLE_SCORE and (excess is None or excess >= POSSIBLE_EXCESS):
        status = "possible"
    elif probs["wet"] > probs["dry"]:
        status = "wet"
    else:
        status = "dry"
    top = sorted((probs["dry"], probs["wet"], probs["flood"]), reverse=True)
    margin = (top[0] - top[1]) / usable
    conf = "high" if margin >= 0.4 else "medium" if margin >= 0.15 else "low"
    if status == "possible" and base is None:
        conf = "low"  # no history yet for this camera
    if "night" in flags or "frozen" in flags:
        conf = {"high": "medium", "medium": "low", "low": "low"}[conf]
    return status, conf, round(score, 3)


# ------------------------------------------------------------------ districts
def load_districts():
    try:
        gj = json.load(open(os.path.join(HERE, "data", "districts.geojson"), encoding="utf-8"))
    except OSError:
        return []
    out = []
    for f in gj["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        out.append((f["properties"].get("id") or f["properties"].get("name"), polys))
    return out


def in_ring(x, y, ring):
    inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def district_of(dists, lat, lon):
    for name, polys in dists:
        if any(in_ring(lon, lat, p[0]) and not any(in_ring(lon, lat, h) for h in p[1:]) for p in polys):
            return name
    return None


# ------------------------------------------------------------------ main
def main():
    t0 = time.time()
    try:
        prev = {c["id"]: c for c in json.load(open(OUT, encoding="utf-8")).get("cameras", [])}
    except (OSError, ValueError):
        prev = {}
    try:
        history = json.load(open(HISTORY, encoding="utf-8"))
    except (OSError, ValueError):
        history = {}
    cams = list_cameras()
    print(f"{len(cams)} cameras in Greater Bangkok", file=sys.stderr)

    def fetch(cam):
        try:
            b, src = grab(cam)
            return cam, b, src, None
        except Exception as e:  # noqa: BLE001
            return cam, None, None, str(e)

    with ThreadPoolExecutor(max_workers=8) as ex:
        frames = list(ex.map(fetch, cams))
    t_fetch = time.time() - t0

    models = Models()
    dists = load_districts()
    out = []
    for cam, b, src, err in frames:
        row = {k: cam[k] for k in ("id", "title", "lat", "lon", "org", "hls", "img", "link")}
        row["district"] = district_of(dists, cam["lat"], cam["lon"])
        row["checked"] = NOW.isoformat(timespec="minutes")
        if b is None:
            row.update(status="offline", confidence=None, error=err)
            out.append(row)
            continue
        try:
            img = Image.open(io.BytesIO(b)).convert("RGB")
        except Exception as e:  # noqa: BLE001
            row.update(status="offline", confidence=None, error=f"decode: {e}"[:200])
            out.append(row)
            continue
        if os.environ.get("FRAMES_DIR"):
            img.save(os.path.join(os.environ["FRAMES_DIR"], f"{cam['id']}.jpg"))
        digest = hashlib.sha1(np.asarray(img.resize((64, 36))).tobytes()).hexdigest()[:16]
        bright, contrast, flags = quality(img, digest, prev.get(cam["id"]))
        probs = models.water(img)
        if probs["bad"] >= BAD_MIN:
            flags = [f for f in flags if f != "night"] + ["no_signal"]
        hist = history.get(cam["id"], [])
        base = baseline_of(hist)
        was = prev.get(cam["id"], {})
        status, conf, score = judge(probs, flags, base, was.get("status") in ("flooded", "possible"))
        if score is not None and "frozen" not in flags:
            history[cam["id"]] = (hist + [round(score * 100)])[-HISTORY_MAX:]
        veh = models.vehicles(img) if status != "unknown" else None
        n = sum(veh.values()) if veh else None
        traffic = next(label for lim, label in TRAFFIC if n < lim) if veh else None
        row.update(source=src, frame_time=NOW.isoformat(timespec="minutes"), size=list(img.size),
                   status=status, confidence=conf, probs=probs, flood_score=score,
                   baseline=base, history_scans=len(history.get(cam["id"], [])), vehicles=veh, vehicle_total=n, traffic=traffic,
                   brightness=bright, contrast=contrast, flags=flags, hash=digest)
        # how long has this camera shown water?
        if status in ("flooded", "possible"):
            row["water_since"] = was.get("water_since") or row["frame_time"]
        out.append(row)

    order = {"flooded": 0, "possible": 1, "wet": 2, "dry": 3, "unknown": 4, "offline": 5}
    out.sort(key=lambda r: (order[r["status"]], -(r.get("probs") or {}).get("flood", 0)))
    summary = {k: sum(r["status"] == k for r in out) for k in order}
    payload = {
        "version": 1,
        "generated_at": NOW.isoformat(timespec="seconds"),
        "source": {"id": "longdo-cctv", "url": CAMERA_LIST,
                   "note": "Traffic cameras listed by Longdo Traffic; streams by iTIC Foundation and Dept. of Highways"},
        "method": {
            "water": f"open_clip {CLIP_ARCH} ({CLIP_WEIGHTS}) zero-shot; softmax over prompts, summed per group; "
                     "flood score compared with the camera's own 20th-percentile score over up to 7 days",
            "vehicles": "Ultralytics YOLO11s, COCO classes car/motorcycle/bus/truck, conf 0.25",
            "prompts": PROMPTS,
            "thresholds": {"flooded": [FLOODED_SCORE, FLOODED_EXCESS, "2 scans in a row"],
                           "possible": [POSSIBLE_SCORE, POSSIBLE_EXCESS], "bad_frame": BAD_MIN,
                           "baseline_min_scans": BASELINE_MIN_SCANS,
                           "night_brightness": DARK, "traffic": [list(t) for t in TRAFFIC[:-1]]},
            "evidence": "AI estimate from a single frame; not a measurement. Treat as reported (unconfirmed).",
        },
        "summary": summary,
        "timing_s": {"fetch": round(t_fetch, 1), "total": round(time.time() - t0, 1)},
        "cameras": out,
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)
    with open(HISTORY + ".tmp", "w", encoding="utf-8") as f:
        json.dump(history, f, separators=(",", ":"))
    os.replace(HISTORY + ".tmp", HISTORY)
    print(f"wrote {OUT}: {summary} in {payload['timing_s']}", file=sys.stderr)


if __name__ == "__main__":
    main()
