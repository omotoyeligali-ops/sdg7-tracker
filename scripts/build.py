"""
build.py - Step 2 of the pipeline: model, business scores, KPIs and CSV exports.

Reads   data/sdg7.json            (written by fetch_data.py)
Writes  data/model.json           forecasts + back-test metrics (read by the web app)
        data/business.json        four business lenses with scores (read by the web app)
        data/kpis.json            app KPIs: data, model, impact, pipeline (read by the web app)
        data/kpi_history.csv      one row per build, so KPIs can be tracked over time
        data/csv/*.csv            deliverable datasets (also stable URLs for Excel / Power BI)

Run:  pip install numpy  &&  python scripts/build.py
"""
import csv
import datetime
import json
import pathlib
import sys
import time

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from model import sdg7_model, business  # noqa: E402

DATA = ROOT / "data"
CSV = DATA / "csv"
LABELS = {
    "EG_ACS_ELEC": "Access to electricity (%)",
    "EG_EGY_CLEAN": "Access to clean cooking fuels and technology (%)",
    "EG_FEC_RNEW": "Renewable share of final energy consumption (%)",
    "EG_EGY_PRIM": "Energy intensity (MJ per 2021 PPP $)",
    "EG_EGY_RNEW": "Renewable capacity (W per person)",
    "EG_IFF_RANDN": "International clean-energy finance received (million 2023 US$)",
}


def access_status(latest, mid, hi):
    """Shared definition (mirrored in app.js `accessStatus`)."""
    if latest is None:
        return "No data"
    if latest >= 99:
        return "Achieved"
    if mid is not None and mid >= 99:
        return "On track"
    if hi is not None and hi >= 99:
        return "At risk"
    return "Off track"


def write_csv(name, header, rows):
    CSV.mkdir(parents=True, exist_ok=True)
    with open(CSV / name, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return len(rows)


def fc_2030(model, code, key):
    fc = model["series"].get(code, {}).get("forecasts", {}).get(key)
    if not fc or fc["from"] > 2030:
        return None, None, None
    i = 2030 - fc["from"]
    return fc["mid"][i], fc["lo"][i], fc["hi"][i]


def main():
    t0 = time.time()
    data = json.loads((DATA / "sdg7.json").read_text(encoding="utf-8"))
    areas, region_of = data["areas"], data["regionOf"]
    regions = set(data["sdgRegions"])

    def area_type(c):
        return "World" if c == "1" else "Country" if c in region_of else "SDG region" if c in regions else "Other group"

    # ---------- 1. model ----------
    print("Running model back-test and forecasts ...")
    model = sdg7_model.run(data)
    model["built"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    model["release"] = data["release"]
    (DATA / "model.json").write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")

    # ---------- 2. business lenses ----------
    print("Scoring business lenses ...")
    biz = business.build(data, model)
    (DATA / "business.json").write_text(json.dumps(biz, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    # ---------- 3. CSV exports ----------
    print("Writing CSV files ...")
    n_obs = 0
    obs_rows = []
    for code, s in data["series"].items():
        for key, raw in s["data"].items():
            area, _, breakdown = key.partition("|")
            for i, v in enumerate(raw[1:]):
                if v is None:
                    continue
                obs_rows.append([code, area, areas.get(area, area), area_type(area),
                                 areas.get(region_of.get(area, ""), ""), breakdown or "TOTAL", raw[0] + i, v])
    n_obs = write_csv("sdg7_observations.csv",
                      ["series_code", "area_code", "area_name", "area_type", "sdg_region", "breakdown", "year", "value"],
                      obs_rows)
    write_csv("series_dictionary.csv",
              ["series_code", "indicator", "series", "un_description", "unit", "source", "rows_from_api"],
              [[c, s["indicator"], LABELS[c], s["desc"], s["units"], s["source"], s.get("rows")]
               for c, s in data["series"].items()] +
              [["SP.POP.TOTL", "", "Population, total", "World Bank WDI", "people", data["population"]["source"], None]])

    pop_rows = []
    for c, raw in data["population"]["data"].items():
        for i, v in enumerate(raw[1:]):
            if v is not None:
                pop_rows.append([c, areas.get(c, c), raw[0] + i, v])
    write_csv("population.csv", ["area_code", "area_name", "year", "population"], pop_rows)

    fc_rows = []
    for code, sm in model["series"].items():
        for key, fc in sm["forecasts"].items():
            for i, y in enumerate(range(fc["from"], 2031)):
                fc_rows.append([code, LABELS[code], key, areas.get(key, key), area_type(key), y,
                                fc["mid"][i], fc["lo"][i], fc["hi"][i], sm["chosen"]])
    write_csv("forecasts_to_2030.csv",
              ["series_code", "series", "area_code", "area_name", "area_type", "year", "forecast", "lower_80",
               "upper_80", "model"], fc_rows)

    met_rows = []
    for code, sm in model["series"].items():
        for m, mt in sm["metrics"].items():
            met_rows.append([code, LABELS[code], m, m == sm["chosen"], mt["n"], round(mt["mae"], 4),
                             round(mt["rmse"], 4), round(mt["bias"], 4), round(mt["within_tol"], 4),
                             None if mt["skill_vs_naive"] is None else round(mt["skill_vs_naive"], 4),
                             "percentage points" if sm["kind"] == "pct" else "relative error"])
    write_csv("model_backtest_metrics.csv",
              ["series_code", "series", "model", "chosen", "n_tests", "mae", "rmse", "bias", "share_within_tolerance",
               "skill_vs_naive", "error_unit"], met_rows)

    latest_rows = []
    for c in sorted(region_of, key=lambda c: areas.get(c, c)):
        row = [c, areas.get(c, c), areas.get(region_of[c], ""), ";".join(data.get("groups", {}).get(c, []))]
        y, v = sdg7_model.points(data["population"], c)
        row += [int(v[-1]) if len(v) else None]
        any_data = False
        for code in ["EG_ACS_ELEC", "EG_EGY_CLEAN", "EG_FEC_RNEW", "EG_EGY_PRIM", "EG_EGY_RNEW"]:
            yy, vv = sdg7_model.points(data["series"][code], c)
            mid, lo, hi = fc_2030(model, code, c)
            last = float(vv[-1]) if len(vv) else None
            any_data |= last is not None
            row += [last, int(yy[-1]) if len(yy) else None, mid]
            if code in ("EG_ACS_ELEC", "EG_EGY_CLEAN"):
                row += [access_status(last, mid, hi)]
        if any_data:
            latest_rows.append(row)
    write_csv("country_latest.csv",
              ["area_code", "country", "sdg_region", "un_groups", "population",
               "electricity_pct", "electricity_year", "electricity_2030_forecast", "electricity_status",
               "clean_cooking_pct", "clean_cooking_year", "clean_cooking_2030_forecast", "clean_cooking_status",
               "renewable_share_pct", "renewable_share_year", "renewable_share_2030_forecast",
               "energy_intensity_mj_per_usd", "energy_intensity_year", "energy_intensity_2030_forecast",
               "renewable_capacity_w_per_person", "renewable_capacity_year", "renewable_capacity_2030_forecast"],
              latest_rows)

    for lens, b in biz.items():
        comps = list(b["components"])
        extra = [k for k in ("year", "latest_pct", "forecast_2030_pct", "finance_5yr_musd", "finance_years")
                 if any(k in r for r in b["rows"])]
        header = ["rank", "area_code", "country", "sdg_region", "un_groups", "score", "completeness"] + comps + extra + \
                 [f"rank_{c}" for c in comps]
        rows = [[r["rank"], r["code"], r["name"], r["region"], ";".join(r["groups"]), r["score"], r["completeness"]] +
                [r.get(c) for c in comps] + [r.get(k) for k in extra] + [r["ranks"].get(c) for c in comps]
                for r in b["rows"]]
        write_csv(f"business_{lens}.csv", header, rows)

    # ---------- 4. KPIs ----------
    print("Computing KPIs ...")
    countries = list(region_of)
    elec_rows = [r for r in latest_rows]
    status_e = [r[8] for r in elec_rows]
    status_c = [r[12] for r in elec_rows]
    off = biz["offgrid"]["rows"]
    cook = biz["cooking"]["rows"]

    coverage = {}
    for code, s in data["series"].items():
        have = [c for c in countries if c in s["data"]]
        last_years = [s["data"][c][0] + len(s["data"][c]) - 2 for c in have]
        newest = max(last_years) if last_years else None
        coverage[code] = {
            "label": LABELS[code], "rows_from_un": s.get("rows"),
            "countries": len(have), "countries_total": len(countries),
            "latest_year": newest,
            "countries_current": sum(1 for y in last_years if newest and y >= newest - 2),
        }

    w = lambda code, key="1": sdg7_model.points(data["series"][code], key)
    wy, wv = w("EG_ACS_ELEC")
    ry, rv = w("EG_FEC_RNEW")
    cy, cv = w("EG_EGY_CLEAN")
    world_mid, _, _ = fc_2030(model, "EG_ACS_ELEC", "1")
    built = datetime.datetime.now(datetime.timezone.utc)
    kpis = {
        "built": built.isoformat(timespec="seconds"),
        "release": data["release"],
        "data": {
            "fetched": data["generated"],
            "population_updated": data["population"].get("updated"),
            "observations": n_obs,
            "series": coverage,
        },
        "model": {
            code: {"label": LABELS[code], "chosen": sm["chosen"], "unit": "points" if sm["kind"] == "pct" else "relative",
                   "tolerance": sm["tolerance"],
                   "mae": round(sm["metrics"][sm["chosen"]]["mae"], 4),
                   "skill_vs_naive": round(sm["metrics"][sm["chosen"]]["skill_vs_naive"], 4),
                   "within_tol": round(sm["metrics"][sm["chosen"]]["within_tol"], 4),
                   "interval_coverage_80": None if sm["interval_coverage_80"] is None else round(sm["interval_coverage_80"], 4),
                   "n": sm["metrics"][sm["chosen"]]["n"], "forecasts": len(sm["forecasts"])}
            for code, sm in model["series"].items()
        },
        "impact": {
            "world_electricity_pct": float(wv[-1]), "world_electricity_year": int(wy[-1]),
            "world_electricity_2030": world_mid,
            "world_clean_cooking_pct": float(cv[-1]), "world_clean_cooking_year": int(cy[-1]),
            "world_renewable_share_pct": float(rv[-1]), "world_renewable_share_year": int(ry[-1]),
            "people_without_electricity": int(sum(r["unserved_now"] for r in off)),
            "people_without_electricity_2030": int(sum(r["unserved_2030"] or 0 for r in off)),
            "people_without_clean_cooking": int(sum(r["unserved_now"] for r in cook)),
            "countries_electricity": {s: status_e.count(s) for s in ["Achieved", "On track", "At risk", "Off track"]},
            "countries_clean_cooking": {s: status_c.count(s) for s in ["Achieved", "On track", "At risk", "Off track"]},
        },
        "pipeline": {"fetch_seconds": data.get("fetchSeconds"), "build_seconds": None,
                     "csv_files": sorted(p.name for p in CSV.glob("*.csv"))},
    }
    kpis["pipeline"]["build_seconds"] = round(time.time() - t0, 1)
    (DATA / "kpis.json").write_text(json.dumps(kpis, indent=1), encoding="utf-8")

    # ---------- 5. KPI history (one row per build) ----------
    hist = DATA / "kpi_history.csv"
    header = ["built", "release", "observations", "world_electricity_pct", "people_without_electricity",
              "people_without_clean_cooking", "countries_off_track_electricity", "countries_off_track_cooking",
              "mae_electricity_pts", "skill_electricity", "mae_cooking_pts", "skill_cooking", "build_seconds"]
    new = [kpis["built"], data["release"], n_obs, kpis["impact"]["world_electricity_pct"],
           kpis["impact"]["people_without_electricity"], kpis["impact"]["people_without_clean_cooking"],
           kpis["impact"]["countries_electricity"]["Off track"], kpis["impact"]["countries_clean_cooking"]["Off track"],
           kpis["model"]["EG_ACS_ELEC"]["mae"], kpis["model"]["EG_ACS_ELEC"]["skill_vs_naive"],
           kpis["model"]["EG_EGY_CLEAN"]["mae"], kpis["model"]["EG_EGY_CLEAN"]["skill_vs_naive"],
           kpis["pipeline"]["build_seconds"]]
    exists = hist.exists()
    with open(hist, "a", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        if not exists:
            wr.writerow(header)
        wr.writerow(new)

    print(f"Done in {kpis['pipeline']['build_seconds']} s: {n_obs:,} observations, "
          f"{len(fc_rows):,} forecast rows, {sum(len(b['rows']) for b in biz.values())} business scores.")


if __name__ == "__main__":
    main()
