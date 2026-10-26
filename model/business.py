"""
business.py - turns SDG 7 data + forecasts into decision tools for businesses.

Four "lenses", each a ranked list of countries with a 0-100 score:

  offgrid   Off-grid power market      (solar home systems, mini-grids, PAYG solar)
  cooking   Clean cooking market       (LPG, e-cooking, improved cookstoves)
  sourcing  Green power sourcing       (where to site plants/data centres, renewable PPAs, Scope 2)
  finance   Clean-energy finance gap   (development finance, impact investors, blended finance)

Each score is a weighted sum of percentile ranks (0 = worst, 1 = best among countries with data).
The component values and ranks are exported so the web app can re-weight them live, and so
analysts can audit every score in the CSV.
"""
import numpy as np

from .sdg7_model import points

TARGET_YEAR = 2030

LENSES = {
    "offgrid": {
        "title": "Off-grid power market",
        "who": "Solar home system, mini-grid and PAYG solar companies; distributors",
        "question": "Where are the most people still without electricity, and where will they still be in 2030?",
        "components": {
            "unserved_now":  ("People without electricity (latest)", 0.45, "high"),
            "unserved_2030": ("People still without electricity in 2030 (forecast)", 0.30, "high"),
            "rural_gap":     ("Rural access gap, percentage points", 0.15, "high"),
            "momentum":      ("Access gain per year (market activity)", 0.10, "high"),
        },
    },
    "cooking": {
        "title": "Clean cooking market",
        "who": "LPG distributors, e-cooking and improved-cookstove makers, carbon-credit developers",
        "question": "Where do the most people still cook with polluting fuels?",
        "components": {
            "unserved_now":  ("People without clean cooking (latest)", 0.45, "high"),
            "unserved_2030": ("People without clean cooking in 2030 (forecast)", 0.30, "high"),
            "urban_gap":     ("Urban households without clean cooking, %", 0.15, "high"),
            "momentum":      ("Clean cooking gain per year", 0.10, "high"),
        },
    },
    "sourcing": {
        "title": "Green power sourcing",
        "who": "Manufacturers, data-centre and site-selection teams, corporate PPA buyers",
        "question": "Which countries offer the greenest, fastest-growing renewable power for operations?",
        "components": {
            "cap_per_person": ("Renewable capacity, W per person", 0.35, "high"),
            "cap_growth":     ("Renewable capacity growth, % per year (5 yr)", 0.20, "high"),
            "ren_share":      ("Renewable share of energy use, % (includes traditional biomass)", 0.25, "high"),
            "intensity_impr": ("Energy-intensity improvement, % per year since 2015", 0.10, "high"),
            "access":         ("Electricity access, % (grid maturity)", 0.10, "high"),
        },
    },
    "finance": {
        "title": "Clean-energy finance gap",
        "who": "Development finance institutions, impact investors, climate funds",
        "question": "Where is the energy-access need large but international clean-energy finance small?",
        "components": {
            "unserved_now":       ("People without electricity (latest)", 0.40, "high"),
            "finance_per_person": ("Clean-energy finance received per person without power, US$ (5 yr)", 0.40, "low"),
            "off_track":          ("Electricity-access shortfall in 2030, percentage points", 0.20, "high"),
        },
    },
}


def latest(series, key):
    y, v = points(series, key)
    return (int(y[-1]), float(v[-1])) if len(y) else (None, None)


def value_at(series, key, year):
    y, v = points(series, key)
    m = y == year
    return float(v[m][0]) if m.any() else None


def pop_at(data, code, year):
    """population in a year; extends the last 5-year growth rate if the year is beyond the data"""
    y, v = points(data["population"], code)
    if not len(y):
        return None
    if year in y:
        return float(v[y == year][0])
    if year < y[0]:
        return float(v[0])
    k = min(5, len(y) - 1)
    g = (v[-1] / v[-1 - k]) ** (1 / k) - 1 if k else 0
    return float(v[-1] * (1 + g) ** (year - y[-1]))


def forecast_2030(model, code, key):
    fc = model["series"][code]["forecasts"].get(key)
    if not fc:
        return None
    return fc["mid"][TARGET_YEAR - fc["from"]] if fc["from"] <= TARGET_YEAR else None


def access_features(data, model, code, c):
    s = data["series"][code]
    yr, last = latest(s, c)
    if last is None or yr < 2015:
        return None
    pop_now = pop_at(data, c, yr)
    f30 = forecast_2030(model, code, c)
    if f30 is None:
        f30 = last
    pop30 = pop_at(data, c, TARGET_YEAR)
    _, urb = latest(s, c + "|URBAN")
    _, rur = latest(s, c + "|RURAL")
    return {
        "year": yr, "latest_pct": round(last, 2), "forecast_2030_pct": round(f30, 2),
        "unserved_now": None if pop_now is None else round(pop_now * (100 - last) / 100),
        "unserved_2030": None if pop30 is None else round(pop30 * (100 - f30) / 100),
        "momentum": round((f30 - last) / (TARGET_YEAR - yr), 3) if yr < TARGET_YEAR else 0,
        "rural_gap": None if urb is None or rur is None else round(urb - rur, 2),
        "urban_gap": None if urb is None else round(100 - urb, 2),
    }


def cagr(series, key, years):
    y, v = points(series, key)
    if len(y) < 2:
        return None
    end_y, end_v = y[-1], v[-1]
    m = y <= end_y - years
    if not m.any():
        return None
    s_y, s_v = y[m][-1], v[m][-1]
    if s_v <= 0 or end_v <= 0:
        return None
    return float(((end_v / s_v) ** (1 / (end_y - s_y)) - 1) * 100)


def pct_rank(values, higher_is_better=True):
    """percentile rank in 0..1 (ties share their average rank); None stays None"""
    idx = [i for i, v in enumerate(values) if v is not None]
    out = [None] * len(values)
    if not idx:
        return out
    arr = np.array([values[i] for i in idx], dtype=float)
    order = arr.argsort(kind="mergesort")
    ranks = np.empty(len(arr))
    ranks[order] = np.arange(len(arr), dtype=float)
    for v in np.unique(arr):                      # average rank for tied values
        m = arr == v
        if m.sum() > 1:
            ranks[m] = ranks[m].mean()
    ranks = ranks / max(len(arr) - 1, 1)
    if not higher_is_better:
        ranks = 1 - ranks
    for j, i in enumerate(idx):
        out[i] = round(float(ranks[j]), 4)
    return out


def build(data, model):
    countries = [c for c in data["regionOf"] if c in data["population"]["data"]]
    feats = {lens: [] for lens in LENSES}

    for c in countries:
        base = {"code": c, "name": data["areas"].get(c, c),
                "region": data["areas"].get(data["regionOf"][c], ""),
                "groups": data.get("groups", {}).get(c, []),
                "population": pop_at(data, c, latest(data["population"], c)[0] or 2024)}

        e = access_features(data, model, "EG_ACS_ELEC", c)
        if e and e["unserved_now"] and e["unserved_now"] > 0:
            feats["offgrid"].append({**base, **e})

        k = access_features(data, model, "EG_EGY_CLEAN", c)
        if k and k["unserved_now"] and k["unserved_now"] > 0:
            feats["cooking"].append({**base, **k})

        ren_y, ren = latest(data["series"]["EG_FEC_RNEW"], c)
        cap_y, cap = latest(data["series"]["EG_EGY_RNEW"], c)
        prim = data["series"]["EG_EGY_PRIM"]
        p_y, p_last = latest(prim, c)
        p15 = value_at(prim, c, 2015)
        impr = None
        if p_last and p15 and p_y > 2015:
            impr = (1 - (p_last / p15) ** (1 / (p_y - 2015))) * 100
        acc_y, acc = latest(data["series"]["EG_ACS_ELEC"], c)
        if ren is not None and cap is not None and (ren_y or 0) >= 2018:
            feats["sourcing"].append({**base, "ren_share": ren, "ren_year": ren_y,
                                      "cap_per_person": cap, "cap_year": cap_y,
                                      "cap_growth": cagr(data["series"]["EG_EGY_RNEW"], c, 5),
                                      "intensity_impr": None if impr is None else round(impr, 2),
                                      "access": acc})

        iff = data["series"]["EG_IFF_RANDN"]
        y, v = points(iff, c)
        if e and e["unserved_now"] and e["unserved_now"] >= 10000 and len(y):
            recent = v[y > y.max() - 5]
            fin = float(recent.sum())
            feats["finance"].append({**base, "unserved_now": e["unserved_now"],
                                     "finance_5yr_musd": round(fin, 2),
                                     "finance_years": f"{int(y.max()) - 4}-{int(y.max())}",
                                     "finance_per_person": round(fin * 1e6 / e["unserved_now"], 2),
                                     "off_track": round(max(0.0, 100 - e["forecast_2030_pct"]), 2),
                                     "latest_pct": e["latest_pct"], "year": e["year"]})

    out = {}
    for lens, rows in feats.items():
        comps = LENSES[lens]["components"]
        for comp, (_, _, direction) in comps.items():
            vals = [r.get(comp) for r in rows]
            if comp in ("unserved_now", "unserved_2030"):
                vals = [None if v is None else np.log10(max(v, 1)) for v in vals]   # size matters on a log scale
            ranks = pct_rank(vals, direction == "high")
            for r, rk in zip(rows, ranks):
                r.setdefault("ranks", {})[comp] = rk
        for r in rows:
            tot = wsum = 0.0
            for comp, (_, w, _) in comps.items():
                if r["ranks"].get(comp) is not None:
                    tot += w * r["ranks"][comp]
                    wsum += w
            r["score"] = round(100 * tot / wsum, 1) if wsum else None
            r["completeness"] = round(wsum / sum(w for _, w, _ in comps.values()), 2)
        rows.sort(key=lambda r: -(r["score"] or 0))
        for i, r in enumerate(rows, 1):
            r["rank"] = i
        out[lens] = {**{k: v for k, v in LENSES[lens].items() if k != "components"},
                     "components": {k: {"label": l, "weight": w, "direction": d}
                                    for k, (l, w, d) in comps.items()},
                     "rows": rows}
    return out
