# Model card: SDG 7 forecasting and market-scoring model

**Code:** `model/sdg7_model.py` (forecasts), `model/business.py` (scores) · **Run by:** `scripts/build.py`
**Outputs:** `data/model.json`, `data/business.json`, `data/csv/forecasts_to_2030.csv`, `data/csv/model_backtest_metrics.csv`, `data/csv/business_*.csv`
**Data:** UN Global SDG Indicators Database release 2026.Q3.G.01 (data to 2024); World Bank population (UN World Population Prospects)

## 1. Purpose

Forecast each country's Goal 7 indicators to 2030, with an honest uncertainty range, and turn the data into ranked lists for four business decisions. It is designed to be explainable to a non-specialist, cheap to rerun every week, and identical in Python (pipeline) and JavaScript (live refresh in the browser).

## 2. Forecasting model

### Candidate methods
All methods use the last 10 reported years and start from the latest real value, so a forecast never jumps away from the most recent data point.

| Method | How it forecasts | Used for |
|---|---|---|
| No change (naive) | Latest value carried forward | Baseline for every indicator |
| Recent trend (drift) | Latest value + least-squares yearly change | All |
| Slowing trend (damped) | Like drift, but each year keeps 80% of the previous year's change | All |
| S-curve (logistic) | Straight-line trend on the logit scale; flattens near 0% and 100% | % indicators |
| Constant growth | Latest value × least-squares growth rate | Energy intensity, renewable capacity |
| Slowing growth | Growth rate shrinks 20% a year | Energy intensity, renewable capacity |

### How the method is chosen (back-test)
1. Pretend it is 2014: fit every method on data up to 2014, forecast 2015–2019, compare with what the UN later reported.
2. Repeat from 2019 (forecast 2020–2024).
3. Score each method by mean absolute error (MAE) over all countries and horizons of 1–5 years.
4. Choose the lowest-MAE method for that indicator; if a simpler method is within 2%, choose the simpler one.

### Results (release 2026.Q3.G.01)

| Indicator | Chosen | MAE | Better than no-change | Within tolerance | 80% range hit rate |
|---|---|---|---|---|---|
| 7.1.1 Electricity access | Recent trend | 1.20 pts | 41% | 88% within ±3 pts | 87% |
| 7.1.2 Clean cooking | S-curve | 1.03 pts | 49% | 92% within ±3 pts | 90% |
| 7.2.1 Renewable share | No change | 2.06 pts | 0% | 77% within ±3 pts | 84% |
| 7.3.1 Energy intensity | No change | 8.8% | 0% | 70% within ±10% | 74% |
| 7.b.1 Renewable capacity | Slowing trend | 23% | 4% | 45% within ±10% | 87% |

The full table for every method is in `data/csv/model_backtest_metrics.csv`. The numbers are recomputed on every rebuild and shown live on the App performance page.

**Reading the results.** Access to electricity and clean cooking follow steady trends, and the model beats the no-change baseline by 41–49%. Renewable share and energy intensity do not: past trends did not predict the next five years better than "no change", so the model reports a flat forecast with a range rather than an invented trend. Renewable capacity is lumpy (big plants come online in single years), so its ranges are wide.

### Uncertainty ranges
For the chosen method, the 80th percentile of absolute back-test errors is measured at each horizon from 1 to 5 years (points for % indicators, relative error for others). Beyond 5 years the width grows with the square root of the horizon. **Calibration check:** ranges sized only from the 2014-based tests were applied to the 2019-based tests; the share of real outcomes inside the range is the "80% range hit rate" above (target 80%).

### Status labels (electricity and clean cooking)
- **Achieved**: latest value ≥ 99%
- **On track**: central 2030 forecast ≥ 99%
- **At risk**: central forecast < 99% but the top of the 80% range ≥ 99%
- **Off track**: otherwise

## 3. Business scoring model

Each lens scores countries 0–100 as a weighted average of **percentile ranks** (0 = lowest among countries with data, 1 = highest; tied values share their average rank). People counts are ranked on a log scale so that size matters without the largest countries swamping everything. Missing measures are skipped and the remaining weights are re-normalised; the `completeness` column shows how much of the weight had data.

| Lens | Measures (default weight) |
|---|---|
| Off-grid power market | People without electricity (45%), people without electricity in 2030 forecast (30%), rural access gap (15%), access gain per year (10%) |
| Clean cooking market | People without clean cooking (45%), in 2030 forecast (30%), urban households without clean cooking (15%), gain per year (10%) |
| Green power sourcing | Renewable capacity per person (35%), capacity growth over 5 years (20%), renewable share of energy (25%), energy-intensity improvement since 2015 (10%), electricity access (10%) |
| Clean-energy finance gap | People without electricity (40%), finance received per person without electricity, last 5 reported years, lower ranks higher (40%), 2030 shortfall in access (20%) |

Users can change every weight in the app; exported CSVs record the weights used.

**Market sizing** (off-grid and clean cooking): revenue pool = people without access ÷ people per household × annual spend per household × share reachable. Defaults (4.5 people, US$60 or US$40 a year, 10%) are illustrative and meant to be replaced with a company's own unit economics.

## 4. Limitations

- Trends are statistical extrapolations. They do not know about new policies, conflicts, price shocks or large projects.
- UN country data arrive with a 1–2 year lag, and values are revised; each release can change history.
- Indicator 7.2.1 (renewable share) includes traditional biomass such as firewood, so it is high in some low-income countries. The sourcing lens therefore weights installed capacity more heavily.
- Population comes from a second source (World Bank WDI), matched to UN codes through the UN M49 table; about 20 small territories have no population figure and are left out of people-based measures.
- Finance flows (7.a.1) cover international public finance to developing countries only; private investment is not included.
- Scores are relative rankings for screening, not investment advice. Use them to choose where to look closer.

## 5. Maintenance

The scheduled GitHub Actions job reruns the back-test, model choice, ranges, scores and KPIs whenever the UN publishes a new release, so the model re-learns from new data automatically. Each run appends a line to `data/kpi_history.csv`, making accuracy drift visible over time.
