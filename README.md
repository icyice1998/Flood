# Floodwatcher กรุงเทพฯ

An open-data flood-watch map and dashboard for Greater Bangkok (Bangkok, Nonthaburi, Pathum Thani, Samut Prakan, Samut Sakhon).

Live page: https://icyice1998.github.io/Flood/

The dashboard tries to answer six questions: what is happening now, where, when, based on what evidence, how confident it is, and what people should do.

## Architecture

```
GitHub Actions (self-chaining, every 15 min)   GitHub Pages (static)
+---------------------------+                  +----------------------------+
| fetch_data.py (stdlib)    |  commits         | index.html + app.js        |
|  ThaiWater water level ---+--> data/         |  Leaflet + OpenStreetMap   |
|  ThaiWater rain gauges    |   latest.json -->|  RainViewer radar tiles    |
|  BMA canal gauges         |                  |  district map + alerts     |
|  GloFAS river discharge   |                  |  news/social, source health|
|  Google News RSS (TH/EN)  |                  +----------------------------+
|  Social RSS (Reddit, ...) |
|  GDACS alerts             |
|  -> QC -> district scoring|
+---------------------------+
```

| Source ID              | Data                                               | Kind      |
|------------------------|----------------------------------------------------|-----------|
| bma-canal              | ~280 BMA canal gauges vs bank/critical/warning     | measured  |
| thaiwater-waterlevel   | River/main-canal level, % of bank, change          | measured  |
| thaiwater-rain         | Rain 1 h / 24 h per gauge                          | measured  |
| open-meteo-forecast    | Hourly rain, next 12 h, per district               | forecast  |
| open-meteo-glofas      | Chao Phraya discharge, -3 to +7 days               | forecast  |
| news-google-th / -en   | Filtered headlines, last 12 h                      | news      |
| social-*               | Any RSS feed (see below)                           | social    |
| gdacs                  | Current GDACS events for Thailand                  | official  |
| RainViewer (client)    | Radar mosaic, past 2 h, animated                   | measured  |

District boundaries (`data/districts.geojson`, 72 areas: Bangkok's 50 khet plus
the amphoe of Nonthaburi, Pathum Thani, Samut Prakan and Samut Sakhon) are
© OpenStreetMap contributors (ODbL), simplified via Nominatim.

## Update schedule

GitHub's cron is best-effort and on a new repo may fire only every few hours.
`.github/workflows/floodwatcher.yml` therefore runs a loop: each run fetches
every 15 minutes for ~5.5 hours, then dispatches the next run itself. The cron
entry (every 30 min) is only a backup that restarts the chain if it breaks.
To stop updates, disable the workflow under Actions.

## Risk logic (per district)

Each district uses the gauges inside it; rain falls back to gauges within 4 km.

| Evidence                          | Threshold                                        | Points    |
|-----------------------------------|--------------------------------------------------|-----------|
| Rain 24 h (TMD classes)           | >35 / >90 mm                                     | 1 / 2     |
| Rain 1 h                          | >=20 / >=40 mm                                   | 1 / 2     |
| Worst canal/river gauge           | above warning / above critical / over bank       | 1 / 2 / 3 |
| Several gauges                    | >=2 over bank, or >=2-3 above critical           | +1        |
| Rising                            | >=10 cm since the previous run (15 min)          | 1         |
| Forecast rain, next 3 h           | >=10 / >=30 mm                                   | 1 / 2     |
| News/social naming the district   | >=1 in the last 12 h                             | 1         |

Levels: normal <3, watch 3-4, warning 5-7, severe >=8.
Confidence: high = fresh rain + water level + forecast and a local report;
medium = two fresh types; low = one.

Quality control: readings older than 3 h, missing or implausible are flagged,
greyed out and not scored. BMA gauges with placeholder thresholds (bank 0,
critical 0/warning -0.2) or contradictory ones (bank below critical) have those
thresholds dropped and are flagged `threshold_suspect`.

Canals: gauges are grouped by canal name (`ค.ลาดพร้าว ...`, `ปตร.คลองแสนแสบ`,
pump stations named after a canal). Each canal shows its worst gauge, counts
over bank/critical/warning, how many are rising, and the districts it crosses.

## News filter (`news_filter.py`)

Kept only if the headline reports rising water, active flooding or an official
warning. Dropped, with the reason counted on the page:

- opinion, columns, analysis, emotional or question headlines
- politics, meetings, officials' visits, troop/relief deployments
- water receding, clean-up, donations, compensation
- weather forecasts with no reported impact

Headlines are tied to districts by district name, canal name, or a major road or
landmark (`places.py`, e.g. Vibhavadi -> Din Daeng, Chatuchak, Lak Si, Don
Mueang). Run `python3 news_filter.py` to check the rules against examples.

The thresholds are a starting point. Calibrate them against past BMA ponding
reports before anyone relies on them.

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

Set it under Settings -> Secrets and variables -> Actions -> Variables. Items go through the same news filter and district matching.

## Next steps

- Scrape BMA DDS canal, gate and pump data from dds.bangkok.go.th (no public API).
- Add the GISTDA flood-extent Open API (needs an API key) to fill the "confirmed" group.
- Add tide data from the Hydrographic Department for Chao Phraya backwater.
- Break alerts down further to road level with a DEM-based ponding index.
- Push notifications (LINE Notify replacement, Telegram) when a district rises a level.

Disclaimer: experimental and not an official warning. Follow BMA (1555), DDPM (1784) and TMD.
