"""
fetch_data.py - Step 1 of the pipeline: download the source data.

Sources
  * UN Global SDG Indicators Database API (six Goal 7 series)
  * World Bank WDI API, total population (SP.POP.TOTL, built on UN World Population Prospects)
  * data/raw/m49.json: UN M49 country codes -> ISO3 + LDC/LLDC/SIDS flags (static reference)

Output
  data/sdg7.json  one compact file the web app and the model both read

Run:  pip install requests  &&  python scripts/fetch_data.py
Exit code 0 = new data written, 3 = UN release unchanged (nothing to do; use --force to rebuild anyway).
"""
import datetime
import json
import math
import pathlib
import sys
import time

import requests

UN_API = "https://unstats.un.org/sdgapi/v1/sdg"
WB_POP = "https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL"
PAGE_SIZE = 25000
FIRST_YEAR = 2000
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "sdg7.json"
M49 = ROOT / "data" / "raw" / "m49.json"

SERIES = [
    "EG_ACS_ELEC",   # 7.1.1 Access to electricity (%), urban/rural split
    "EG_EGY_CLEAN",  # 7.1.2 Clean cooking fuels and technology (%), urban/rural split
    "EG_FEC_RNEW",   # 7.2.1 Renewable share of final energy consumption (%)
    "EG_EGY_PRIM",   # 7.3.1 Energy intensity (MJ per 2021 PPP $ of GDP)
    "EG_EGY_RNEW",   # 7.b.1 Installed renewable capacity (W per person), by technology
    "EG_IFF_RANDN",  # 7.a.1 International public finance for clean energy (million 2023 US$)
]
TECH_KEEP = {"SOLAR", "WIND", "HYDROPOWER", "BIOENERGY", "GEOTHERMAL"}
TECH_ONLY_TOTAL = {"EG_IFF_RANDN"}   # for finance flows keep only the all-technology total


def get(url, **params):
    for attempt in range(4):                     # the UN API is slow and sometimes times out
        try:
            r = requests.get(url, params=params, timeout=600)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            if attempt == 3:
                raise
            print(f"  retrying after error: {e}", flush=True)
            time.sleep(10 * (attempt + 1))


def un(path, **params):
    return get(f"{UN_API}/{path}", **params)


def sdg_regions():
    tree = un("GeoArea/Tree")
    world = next(t for t in tree if t["geoAreaName"] == "World (total) by SDG regions")
    region_of, regions, names = {}, [], {}

    def walk(node, region):
        if node["type"] == "Country":
            region_of[str(node["geoAreaCode"])] = region
        for child in node.get("children") or []:
            walk(child, region)

    for region in world["children"]:
        code = str(region["geoAreaCode"])
        regions.append(code)
        names[code] = region["geoAreaName"]
        walk(region, code)
    return regions, region_of, names


def all_rows(code):
    first = un("Series/Data", seriesCode=code, pageSize=PAGE_SIZE)
    rows = list(first["data"])
    for page in range(2, first["totalPages"] + 1):
        rows += un("Series/Data", seriesCode=code, pageSize=PAGE_SIZE, page=page)["data"]
    return rows


def row_key(code, row):
    """'404' = Kenya total; '404|URBAN', '404|SOLAR' = breakdowns. None = not used."""
    dims = row.get("dimensions") or {}
    key = row["geoAreaCode"]
    loc = dims.get("Location")
    if loc and loc != "ALLAREA":
        key += "|" + loc
    tech = dims.get("Type of renewable technology")
    if tech and tech != "ALL":
        if code in TECH_ONLY_TOTAL or tech not in TECH_KEEP:
            return None
        key += "|" + tech
    return key


def compact(points):
    """[(year, value), ...] -> [first_year, v, v, None, v, ...] (one slot per year)."""
    points = sorted(points)
    start = points[0][0]
    out = [start] + [None] * (points[-1][0] - start + 1)
    for year, value in points:
        out[year - start + 1] = value
    return out


def fetch_series(code, names):
    rows = all_rows(code)
    buckets, seen = {}, set()
    for row in rows:
        try:
            value = float(row["value"])
        except (TypeError, ValueError):
            continue
        year = int(row["timePeriodStart"])
        key = row_key(code, row)
        if math.isnan(value) or year < FIRST_YEAR or key is None:
            continue
        # some series are listed under two indicators, so each row arrives twice
        if (key, year) in seen:
            continue
        seen.add((key, year))
        names.setdefault(row["geoAreaCode"], row["geoAreaName"])
        buckets.setdefault(key, []).append((year, round(value, 2)))
    first = rows[0]
    return {
        "desc": first["seriesDescription"],
        "indicator": ",".join(sorted({i for r in rows for i in r["indicator"]})),
        "units": first["attributes"].get("Units"),
        "source": first.get("source"),
        "rows": len(rows),
        "data": {k: compact(v) for k, v in buckets.items()},
    }


def population(m49):
    """World Bank total population, re-keyed from ISO3 to UN M49 codes."""
    meta, rows = get(WB_POP, format="json", date=f"{FIRST_YEAR}:2100", per_page=20000)
    iso_to_m49 = {v["iso3"]: k for k, v in m49.items()}
    iso_to_m49["WLD"] = "1"
    iso_to_m49["XKX"] = "412"   # Kosovo: World Bank code XKX, UN M49 412
    pts = {}
    for r in rows:
        code = iso_to_m49.get(r["countryiso3code"])
        if code and r["value"] is not None:
            pts.setdefault(code, []).append((int(r["date"]), int(r["value"])))
    return meta.get("lastupdated"), {k: compact(v) for k, v in pts.items()}


def main(force=False):
    t0 = time.time()
    releases = {s["code"]: s["release"] for s in un("Series/List", allreleases="false")}
    release = releases.get(SERIES[0], "")
    if OUT.exists() and not force:
        old = json.loads(OUT.read_text(encoding="utf-8"))
        if old.get("release") == release:
            print(f"UN release {release} is already in data/sdg7.json - nothing to do.")
            sys.exit(3)

    m49 = json.loads(M49.read_text(encoding="utf-8"))
    regions, region_of, names = sdg_regions()
    out = {
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "release": release,
        "areas": names,
        "sdgRegions": regions,
        "regionOf": {},
        "groups": {k: [g for g in ("ldc", "lldc", "sids") if v.get(g)] for k, v in m49.items()},
        "series": {},
    }
    for code in SERIES:
        print(f"Downloading {code} ...", flush=True)
        out["series"][code] = fetch_series(code, names)
        print(f"  {len(out['series'][code]['data'])} area series")
    out["regionOf"] = {c: r for c, r in region_of.items() if c in names}

    print("Downloading population (World Bank) ...", flush=True)
    pop_updated, pop = population(m49)
    out["population"] = {"source": "World Bank WDI SP.POP.TOTL (UN World Population Prospects)",
                         "updated": pop_updated, "data": pop}
    out["fetchSeconds"] = round(time.time() - t0)

    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"Saved {OUT} ({OUT.stat().st_size / 1024:.0f} KB) in {out['fetchSeconds']} s")


if __name__ == "__main__":
    main(force="--force" in sys.argv)
