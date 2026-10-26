"""
sdg7_model.py - forecasting model for SDG 7 indicators.

What it does
  1. For each indicator it tries several simple, explainable trend models.
  2. It back-tests them: pretend it is 2014 (and again 2019), fit on the data known then,
     forecast the next 5 years, and compare with what the UN actually reported.
  3. It keeps the model with the lowest error for that indicator, and measures how wide
     the 80% uncertainty band needs to be from those real errors.
  4. It refits the winner on all data and forecasts every country and region to 2030.

Only numpy is needed. The same model maths is mirrored in app.js (function `fitModel`)
so the web app can forecast fresh data pulled live from the UN API.
"""
import numpy as np

WINDOW = 10            # years of history each fit uses
HORIZON = 5            # back-test horizon in years
ORIGINS = (2014, 2019) # back-test origins: train on data <= origin, test origin+1..origin+5
TARGET_YEAR = 2030
EPS = 0.005            # keeps logit finite at 0% / 100%

PHI = 0.8              # damping factor: each extra year keeps 80% of the previous year's trend

# indicator -> (value type, candidate models, tolerance used for the "within tolerance" KPI)
#   naive          last value carried forward
#   drift          last value + recent yearly change (straight line)
#   damped         like drift, but the yearly change shrinks by PHI each year
#   logistic       straight line on the logit scale -> S-curve that flattens near 0% and 100%
#   growth         last value x constant recent growth rate
#   damped_growth  like growth, but the growth rate shrinks by PHI each year
SPEC = {
    "EG_ACS_ELEC":  ("pct", ["naive", "drift", "damped", "logistic"], 3.0),
    "EG_EGY_CLEAN": ("pct", ["naive", "drift", "damped", "logistic"], 3.0),
    "EG_FEC_RNEW":  ("pct", ["naive", "drift", "damped", "logistic"], 3.0),
    "EG_EGY_PRIM":  ("pos", ["naive", "drift", "damped", "growth", "damped_growth"], 0.10),
    "EG_EGY_RNEW":  ("pos", ["naive", "drift", "damped", "growth", "damped_growth"], 0.10),
}
SIMPLICITY = ["naive", "drift", "damped", "logistic", "growth", "damped_growth"]


# ---------------------------------------------------------------- helpers
def points(series, key):
    """compact [start, v, v, None, ...] -> (years, values) numpy arrays"""
    raw = series["data"].get(key)
    if not raw:
        return np.array([]), np.array([])
    start = raw[0]
    yv = [(start + i, v) for i, v in enumerate(raw[1:]) if v is not None]
    if not yv:
        return np.array([]), np.array([])
    y, v = zip(*yv)
    return np.array(y, dtype=float), np.array(v, dtype=float)


def _ols(x, y):
    x0 = x - x.mean()
    den = (x0 ** 2).sum()
    slope = (x0 * (y - y.mean())).sum() / den if den else 0.0
    return y.mean() - slope * x.mean(), slope


def _steps(h, damped):
    """effective number of trend steps after h years (sum of PHI^i when damped)"""
    h = np.asarray(h, dtype=float)
    if not damped:
        return h
    return PHI * (1 - PHI ** h) / (1 - PHI)


def fit(model, years, values, kind):
    """Fit one model on the last WINDOW years, anchored at the latest observation.
    Returns a function year -> forecast, or None if the model cannot be fitted."""
    keep = years > years.max() - WINDOW
    x, y = years[keep], values[keep]
    if len(x) < 3:
        return None
    t0, last = x[-1], y[-1]
    damped = model.startswith("damped")
    if model == "naive":
        f = lambda t: np.full(np.shape(t), last, dtype=float)
    elif model in ("drift", "damped"):
        _, b = _ols(x, y)
        f = lambda t: last + b * _steps(np.asarray(t, dtype=float) - t0, damped)
    elif model == "logistic":
        p = np.clip(y / 100, EPS, 1 - EPS)
        _, b = _ols(x, np.log(p / (1 - p)))
        l0 = np.log(np.clip(last / 100, EPS, 1 - EPS) / (1 - np.clip(last / 100, EPS, 1 - EPS)))
        f = lambda t: 100 / (1 + np.exp(-(l0 + b * (np.asarray(t, dtype=float) - t0))))
    elif model in ("growth", "damped_growth"):
        if (y <= 0).any():
            return None
        _, g = _ols(x, np.log(y))
        f = lambda t: last * np.exp(g * _steps(np.asarray(t, dtype=float) - t0, damped))
    else:
        raise ValueError(model)
    if kind == "pct":
        return lambda t: np.clip(f(t), 0, 100)
    return lambda t: np.maximum(f(t), 0)


def _err(kind, actual, pred):
    """error in the unit we judge the indicator by: points for %, relative for the rest"""
    if kind == "pct":
        return pred - actual
    return (pred - actual) / np.where(actual == 0, np.nan, actual)


# ---------------------------------------------------------------- back-test
def backtest(series_obj, code, countries):
    kind, models, tol = SPEC[code]
    rows = []   # (model, origin, horizon, err)
    for key in countries:
        years, vals = points(series_obj, key)
        if len(years) == 0:
            continue
        for origin in ORIGINS:
            train = years <= origin
            test = (years > origin) & (years <= origin + HORIZON)
            if train.sum() < 3 or test.sum() == 0:
                continue
            for m in models:
                f = fit(m, years[train], vals[train], kind)
                if f is None:
                    continue
                e = _err(kind, vals[test], f(years[test]))
                for h, err in zip(years[test] - origin, e):
                    if np.isfinite(err):
                        rows.append((m, origin, int(h), float(err)))
    return rows


def summarise(rows, code):
    kind, models, tol = SPEC[code]
    out = {}
    for m in models:
        e = np.array([r[3] for r in rows if r[0] == m])
        if len(e) == 0:
            continue
        out[m] = {
            "n": int(len(e)),
            "mae": float(np.mean(np.abs(e))),
            "rmse": float(np.sqrt(np.mean(e ** 2))),
            "bias": float(np.mean(e)),
            "within_tol": float(np.mean(np.abs(e) <= tol)),
        }
    naive = out.get("naive", {}).get("mae")
    for m in out:
        out[m]["skill_vs_naive"] = float(1 - out[m]["mae"] / naive) if naive else None
    return out


def choose(summary):
    """lowest MAE wins; prefer the simpler model when it is within 2% of the best"""
    best = min(summary, key=lambda m: summary[m]["mae"])
    for m in SIMPLICITY:
        if m in summary and summary[m]["mae"] <= summary[best]["mae"] * 1.02:
            return m
    return best


def interval_widths(rows, model, origins):
    """80th percentile of |error| by horizon 1..5 (points for %, relative for others)."""
    q = {}
    for h in range(1, HORIZON + 1):
        e = [abs(r[3]) for r in rows if r[0] == model and r[2] == h and r[1] in origins]
        q[h] = float(np.percentile(e, 80)) if e else None
    return q


def coverage(rows, model, q_from_first, kind):
    """Share of second-fold errors inside bands estimated from the first fold only (calibration)."""
    hits = [abs(r[3]) <= q_from_first[r[2]] for r in rows
            if r[0] == model and r[1] == ORIGINS[1] and q_from_first.get(r[2]) is not None]
    return float(np.mean(hits)) if hits else None


def width_at(q, h):
    if h <= HORIZON:
        return q[max(1, h)]
    return q[HORIZON] * np.sqrt(h / HORIZON)   # widen beyond the tested horizon


# ---------------------------------------------------------------- forecast
def run(data):
    """Back-test, choose, and forecast every indicator. Returns a JSON-ready dict."""
    countries = list(data["regionOf"].keys())
    result = {"window": WINDOW, "horizon": HORIZON, "origins": list(ORIGINS),
              "target_year": TARGET_YEAR, "series": {}}
    for code, (kind, models, tol) in SPEC.items():
        s = data["series"][code]
        rows = backtest(s, code, countries)
        summary = summarise(rows, code)
        chosen = choose(summary)
        q_all = interval_widths(rows, chosen, ORIGINS)
        q_first = interval_widths(rows, chosen, ORIGINS[:1])
        cov = coverage(rows, chosen, q_first, kind)

        fc = {}
        for key in s["data"]:
            if "|" in key:
                continue                         # forecast totals only, not breakdowns
            years, vals = points(s, key)
            if len(years) < 3 or years.max() < TARGET_YEAR - 15:
                continue
            f = fit(chosen, years, vals, kind)
            if f is None:
                continue
            last = int(years.max())
            ys = np.arange(last + 1, TARGET_YEAR + 1)
            if len(ys) == 0:
                continue
            mid = f(ys)
            w = np.array([width_at(q_all, int(y - last)) for y in ys])
            if kind == "pct":
                lo, hi = np.clip(mid - w, 0, 100), np.clip(mid + w, 0, 100)
            else:
                lo, hi = np.maximum(mid * (1 - w), 0), mid * (1 + w)
            fc[key] = {"from": last + 1,
                       "mid": [round(float(v), 2) for v in mid],
                       "lo": [round(float(v), 2) for v in lo],
                       "hi": [round(float(v), 2) for v in hi]}
        result["series"][code] = {
            "kind": kind, "tolerance": tol, "candidates": models, "chosen": chosen,
            "metrics": summary, "interval_q80": q_all, "interval_coverage_80": cov,
            "forecasts": fc,
        }
        print(f"{code}: chose {chosen}  MAE={summary[chosen]['mae']:.3f}  "
              f"skill vs naive={summary[chosen]['skill_vs_naive']:.0%}  "
              f"80% band coverage={cov if cov is None else round(cov, 2)}  forecasts={len(fc)}")
    return result
