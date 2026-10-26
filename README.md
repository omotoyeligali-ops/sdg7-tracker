# SDG 7 Energy Tracker

A free, self-updating web app built on the UN's official data for **Sustainable Development Goal 7: Affordable and Clean Energy**. It tracks every country, forecasts each indicator to 2030 with a measured error range, and turns the data into ranked lists for real business decisions.

---

## Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | **Data used (CSV)** | `data/csv/` (listed below) |
| 2 | **Model** | `model/sdg7_model.py`, `model/business.py`, `model/MODEL_CARD.md`; outputs in `data/model.json` and `data/csv/forecasts_to_2030.csv` |
| 3 | **Utility link** | `https://<your-github-username>.github.io/sdg7-tracker/` once deployed (steps in section 6) |
| 4 | **Front end** | `index.html`, `style.css`, `app.js`, `config.js` |

### Data files (`data/csv/`)

| File | Contents |
|---|---|
| `sdg7_observations.csv` | Every UN observation used: series, country/region, breakdown (urban, rural, solar …), year, value (≈88,000 rows) |
| `series_dictionary.csv` | What each series code means, its UN indicator, unit and source agency |
| `population.csv` | Population by country and year (World Bank, from UN World Population Prospects) |
| `country_latest.csv` | One row per country: latest value, 2030 forecast and status for each indicator |
| `forecasts_to_2030.csv` | Model forecasts with 80% lower/upper bounds for every country and region |
| `model_backtest_metrics.csv` | Accuracy of every candidate model for every indicator |
| `business_offgrid.csv`, `business_cooking.csv`, `business_sourcing.csv`, `business_finance.csv` | Ranked scores for the four business lenses, with every measure and rank |

Once hosted, every CSV has a stable public URL (e.g. `https://<user>.github.io/sdg7-tracker/data/csv/country_latest.csv`) that Excel (*Data → From Web*), Power BI, Tableau or Google Sheets (`=IMPORTDATA(url)`) can load and refresh on a schedule.

---

## 1. Business problems it solves

| Lens | Who uses it | Decision it supports |
|---|---|---|
| **Off-grid power market** | Solar home system, mini-grid and PAYG solar companies; distributors | Which countries to enter or expand in, and how big the revenue pool is at your price and reach |
| **Clean cooking market** | LPG distributors, e-cooking and cookstove makers, carbon-credit developers | Where the largest clean-cooking gaps are, now and in 2030 |
| **Green power sourcing** | Manufacturers, data-centre and site-selection teams, corporate PPA buyers | Which countries offer the most and fastest-growing renewable power for operations and Scope 2 targets |
| **Clean-energy finance gap** | Development finance institutions, impact investors, climate funds | Where need is high but international clean-energy finance received is low |

In the **Market finder** each lens ranks every country 0–100. You can change the weight of each measure to match your strategy, filter by region or UN group (least developed, landlocked, small island states), set your own market-sizing assumptions, and export the result. The **Country profile** gives the due-diligence view; the **Gap finder** lists every country's status on any indicator.

## 2. KPIs

### Impact KPIs (Overview page)
People without electricity (now and forecast 2030) · World electricity access and 2030 forecast · People without clean cooking · Renewable share of energy · Countries off track for universal electricity and for clean cooking.

### App performance KPIs (App performance page)

| KPI | Definition | Target |
|---|---|---|
| Data freshness | Days since data were last downloaded from the UN | ≤ 8 days |
| UN release check | Live comparison of the UN's current release with the one the site was built from | Up to date |
| Last scheduled check | When the weekly job last ran, its outcome, and failures across all runs | ≤ 8 days, 0 failures |
| Forecast error (MAE) | Average miss over 1–5 years in back-tests | Electricity ≤ 1.5 pts |
| Better than no-change | 1 − MAE ÷ MAE of assuming nothing changes | > 20% for access indicators |
| Within tolerance | Share of back-test forecasts within ±3 pts (or ±10%) | ≥ 85% for access indicators |
| 80% range hit rate | Share of real outcomes inside the range | 70–90% |
| Current-data coverage | Country × indicator pairs with data in the last 3 years | ≥ 70% |
| Usage (optional) | Page views, lenses opened, CSV exports (GoatCounter) | Your own targets |

Every rebuild appends a row to `data/kpi_history.csv` and every scheduled check appends to `data/run_log.csv`, so performance can be tracked over time.

**Turn on usage tracking:** create a free site at [goatcounter.com](https://www.goatcounter.com), then put its URL in `config.js` (`goatcounter: "https://yourname.goatcounter.com/count"`). The app records views of each page, which business lens is opened, live refreshes and CSV exports.

## 3. How it stays up to date

```
          every Monday (GitHub Actions)                       in the browser
 UN SDG API ──► fetch_data.py ──► build.py ──► commit ──► GitHub Pages ──► app.js
 World Bank      (skips if no      (model, scores,                          │  checks UN release on load
                  new release)      KPIs, CSVs)                             └─ "Refresh from UN now" pulls one
                                                                               country live and re-forecasts it
```

1. **Scheduled pipeline** (`.github/workflows/refresh-and-deploy.yml`): every Monday it asks the UN API which release is current. If it is new, it downloads all series, re-runs the back-test (so the model re-learns), re-scores the lenses, rebuilds the CSVs and KPIs, commits, and redeploys. If not, it logs the check. GitHub emails you if a run fails. You can also run it any time from the Actions tab.
2. **Live in the browser:** when the page opens it checks the UN's current release and shows a banner if newer data exist. On any country profile, **Refresh from UN now** downloads that country's latest figures directly from the UN and recalculates its forecasts with the same model (the browser model reproduces the Python model to within 0.005).

## 4. Project layout

```
sdg7-tracker/
├── index.html, style.css, app.js, config.js     front end
├── data/
│   ├── sdg7.json            UN data + population (what the app reads)
│   ├── model.json           forecasts + accuracy
│   ├── business.json        business lenses
│   ├── kpis.json            KPIs
│   ├── kpi_history.csv      KPI history, one row per rebuild
│   ├── run_log.csv          every scheduled check
│   ├── csv/                 deliverable datasets
│   └── raw/m49.json         UN country codes (static reference)
├── model/
│   ├── sdg7_model.py        forecasting + back-test
│   ├── business.py          business scoring
│   └── MODEL_CARD.md        how the model works, results, limits
├── scripts/
│   ├── fetch_data.py        step 1: download
│   ├── build.py             step 2: model, scores, KPIs, CSVs
│   └── log_run.py           records each scheduled run
└── .github/workflows/refresh-and-deploy.yml
```

## 5. How it was built, step by step

You can repeat this for any of the 17 goals.

**Step 1. Find the data.** The UN SDG data portal (<https://unstats.un.org/sdgs/dataportal>) organises each goal into targets (7.1 …), indicators (7.1.1 …) and data series (`EG_ACS_ELEC` …). The same data is in a free, keyless API (documentation: <https://unstats.un.org/sdgapi/swagger/>):

| You want | Call |
|---|---|
| Goal structure | `/v1/sdg/Goal/7/Target/List?includechildren=true` |
| All series codes | `/v1/sdg/Series/List?allreleases=false` (also tells you the current release) |
| One series' data | `/v1/sdg/Series/Data?seriesCode=EG_ACS_ELEC&pageSize=25000` |
| One country only | add `&areaCode=404` (Kenya) |
| Country → region | `/v1/sdg/GeoArea/Tree` |

All start with `https://unstats.un.org/sdgapi`. Paste them into a browser to see the JSON. The UN SDG database has no total-population series, so population comes from the World Bank API (`api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json`), matched to UN country codes with the UN M49 table.

**Step 2. Inspect before coding.** Values arrive as text (`"76.2"`, `"NaN"`). Breakdowns sit in `dimensions` (`Location`: urban/rural; `Type of renewable technology`: solar, wind …), so filter them. Countries and regions are mixed together (World = `1`). Big series come in pages. One series (`EG_EGY_RNEW`) belongs to two indicators and every row arrives twice, so de-duplicate.

**Step 3. Download once, compactly** (`scripts/fetch_data.py`). A free static host only serves files, and the UN API takes about a minute per series, so the pipeline saves one compact JSON file. Each history is stored as `[firstYear, v, v, null, v …]`.

**Step 4. Build and test a model** (`model/sdg7_model.py`). Try several simple methods, back-test them on years the model has not seen, keep the most accurate, and size the uncertainty range from the real errors. Always compare against a "no change" baseline: it showed that two indicators have no predictable trend, which is a finding, not a failure.

**Step 5. Turn data into decisions** (`model/business.py`). For each business question, pick measures, convert them to percentile ranks so different units can be combined, and weight them. Export the components so every score can be audited.

**Step 6. Define KPIs and log them** (`scripts/build.py`). Decide what "working well" means (fresh data, accurate forecasts, coverage) and write it to a file on every run.

**Step 7. Build the front end** (`index.html`, `style.css`, `app.js`). Plain HTML, CSS and JavaScript plus Chart.js from a CDN. No build tools.

**Step 8. Automate** (`.github/workflows/refresh-and-deploy.yml`) and host (section 6).

### Run it on your computer

```bash
pip install requests numpy
python scripts/fetch_data.py --force   # 5–8 minutes; omit --force to skip when nothing changed
python scripts/build.py                # about a second
python -m http.server 8000             # then open http://localhost:8000
```

## 6. Host it free with automatic updates (GitHub Pages)

1. Create a free account at <https://github.com>.
2. **New repository** → name it `sdg7-tracker` → **Public** → Create.
3. On the new repository page click **uploading an existing file**, drag in everything inside this folder, and **Commit changes**.
   The `.github` folder is hidden on Mac and Windows. If it does not upload, create it on GitHub: **Add file → Create new file**, name it `.github/workflows/refresh-and-deploy.yml`, and paste the file's contents.
4. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
5. **Actions** tab → **Refresh UN data and deploy** → **Run workflow** (tick *force* the first time).
6. After a few minutes the site is live at `https://<your-username>.github.io/sdg7-tracker/`. That is your utility link.

From then on it refreshes every Monday by itself. To change the schedule, edit the `cron` line in the workflow.

---

**Sources:** United Nations Statistics Division, Global SDG Indicators Database (custodians: World Bank, WHO, IEA, IRENA, UNSD, OECD); World Bank World Development Indicators (population). Forecasts and scores are statistical screening tools, not official projections or investment advice.
