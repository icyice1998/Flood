# Floodwatcher กรุงเทพฯ

An open-data flood-watch map and dashboard for Greater Bangkok (Bangkok, Nonthaburi, Pathum Thani, Samut Prakan, Samut Sakhon).

Live page: https://icyice1998.github.io/Flood/

The dashboard tries to answer six questions: what is happening now, where, when, based on what evidence, how confident it is, and what people should do.

## Architecture

```
GitHub Actions (cron */15)                     GitHub Pages (static)
+---------------------------+                  +----------------------------+
| fetch_data.py (stdlib)    |  commits         | index.html + app.js        |
|  ThaiWater water level ---+--> data/         |  Leaflet + OpenStreetMap   |
|  ThaiWater rain gauges    |   latest.json -->|  RainViewer radar tiles    |
|  Open-Meteo forecast      |                  |  zone alerts + evidence    |
|  GloFAS river discharge   |                  |  news/social, source health|
|  Google News RSS (TH/EN)  |                  +----------------------------+
|  Social RSS (Reddit, ...) |
|  GDACS alerts             |
|  -> QC -> zone scoring    |
+---------------------------+
```

| Source ID              | Data                                  | Kind      |
|------------------------|---------------------------------------|-----------|
| thaiwater-waterlevel   | Canal/river level, % of bank, change  | measured  |
| thaiwater-rain         | Rain 1 h / 24 h per gauge             | measured  |
| open-meteo-forecast    | Hourly rain, next 12 h, per zone      | forecast  |
| open-meteo-glofas      | Chao Phraya discharge, -3 to +7 days  | forecast  |
| news-google-th / -en   | Flood-keyword headlines, last 24 h    | news      |
| social-*               | Any RSS feed (see below)              | social    |
| gdacs                  | Current GDACS events for Thailand     | official  |
| RainViewer (client)    | Radar mosaic, past 2 h, animated      | measured  |

## Risk logic

Each zone covers a radius of about 9 km. It collects evidence from nearby stations and scores it:

| Evidence                 | Threshold                                   | Points |
|--------------------------|---------------------------------------------|--------|
| Rain 24 h (TMD classes)  | >35 / >90 mm                                | 1 / 2  |
| Rain 1 h                 | >=20 / >=40 mm                              | 1 / 2  |
| Water level vs bank      | >=80% / >=90% or 1 overtopped / >=2 overtopped | 1 / 2 / 3 |
| Rising                   | >=5 cm since the previous reading           | 1      |
| Forecast rain, next 3 h  | >=10 / >=30 mm                              | 1 / 2  |
| News/social mention      | >=1 in the last 24 h naming the zone        | 1      |

Levels: normal <3, watch 3-4, warning 5-7, severe >=8.

Confidence depends on how many independent, fresh evidence types agree:
- high: rain, water level and forecast are all fresh, plus a local report
- medium: two fresh types
- low: one fresh type

Quality control:
- Readings older than 3 h are flagged `stale`.
- Implausible values are flagged `out_of_range`.
- Missing values are flagged.
- Flagged readings are shown grey on the map and excluded from scoring.

Every evidence item carries its `source_id`, station ID and timestamp. Items are grouped as measured, forecast, reported (unverified) and confirmed. Confirmed stays empty until a CCTV or satellite verification step exists.

The thresholds are a starting point. Calibrate them against past BMA ponding reports before anyone relies on them.

## Run locally

```
python3 fetch_data.py
python3 -m http.server 8000
```

## Adding social feeds

Direct scraping of Facebook and X needs paid APIs and runs against their terms of service. Any RSS bridge can be added instead with a repository variable:

```
FLOODWATCHER_SOCIAL_FEEDS = id|Label|https://example.org/feed.rss;id2|Label 2|https://...
```

Set it under Settings -> Secrets and variables -> Actions -> Variables. Items are kept only if the title matches flood keywords. Items are linked to zones by district or road names.

## Next steps

- Scrape BMA DDS canal, gate and pump data from dds.bangkok.go.th (no public API).
- Add the GISTDA flood-extent Open API (needs an API key) to fill the "confirmed" group.
- Add tide data from the Hydrographic Department for Chao Phraya backwater.
- Break alerts down to district (khet) and road level with a DEM-based ponding index.
- Push notifications (LINE Notify replacement, Telegram) when a zone rises a level.

Disclaimer: experimental and not an official warning. Follow BMA (1555), DDPM (1784) and TMD.
