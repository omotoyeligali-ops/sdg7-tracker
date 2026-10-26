/* SDG 7 Energy Tracker - all logic runs in the browser.
   Files it reads (all produced by the pipeline in /scripts):
     data/sdg7.json      UN SDG 7 data + population      (fetch_data.py)
     data/model.json     forecasts and back-test metrics  (build.py -> model/sdg7_model.py)
     data/business.json  four business lenses             (build.py -> model/business.py)
     data/kpis.json      app KPIs                         (build.py)
     data/kpi_history.csv  one row per pipeline run       (build.py)
   On a hosted site it can also call the UN API directly for fresh data. */

const UN_API = "https://unstats.un.org/sdgapi/v1/sdg";
const WORLD = "1";
const BASE_YEAR = 2015;
const TARGET_YEAR = 2030;
const CFG = window.SDG7_CONFIG || {};

const SERIES = {
  EG_ACS_ELEC:  { short: "Electricity access",  unit: "%",            kind: "access" },
  EG_EGY_CLEAN: { short: "Clean cooking",       unit: "%",            kind: "access" },
  EG_FEC_RNEW:  { short: "Renewable share",     unit: "%",            kind: "up" },
  EG_EGY_PRIM:  { short: "Energy intensity",    unit: "MJ per $",     kind: "efficiency" },
  EG_EGY_RNEW:  { short: "Renewable capacity",  unit: "W per person", kind: "up" },
};
const TECH = [["SOLAR", "Solar"], ["WIND", "Wind"], ["HYDROPOWER", "Hydropower"], ["BIOENERGY", "Bioenergy"], ["GEOTHERMAL", "Geothermal"]];
const STATUS_CLASS = { "Achieved": "done", "On track": "on", "At risk": "slow", "Off track": "off", "Rising": "on", "Falling": "off",
                       "Meeting 2.6%/yr": "on", "Improving slowly": "slow", "Getting worse": "off", "No data": "na", "Not enough data": "na" };

let DATA, MODEL, BIZ, KPIS, HISTORY = [], RUNS = [];
let chart = null;
const live = { forecasts: {}, fetchedAt: null };   // forecasts recomputed from live UN data
const state = { view: "overview", place: "404", series: "EG_ACS_ELEC", lens: "offgrid", weights: {},
                gSort: ["proj", 1], mSort: ["score", -1], gRows: [], mRows: [] };

/* ================================================================ helpers */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const name = c => DATA.areas[c] || c;
const regionOf = c => DATA.regionOf[c];
const goalIndicator = code => (DATA.series[code].indicator || "").split(",").find(i => i.startsWith("7.")) || DATA.series[code].indicator;

function points(obj, key) {          // compact [start, v, v, null, ...] -> [{year, value}]
  const raw = obj?.data?.[key];
  if (!raw) return [];
  const out = [];
  for (let i = 1; i < raw.length; i++) if (raw[i] !== null) out.push({ year: raw[0] + i - 1, value: raw[i] });
  return out;
}
const latest = pts => pts.length ? pts[pts.length - 1] : null;
const valueIn = (pts, y) => pts.find(p => p.year === y) || null;

function fmt(v, code) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (code === "EG_EGY_RNEW") return v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1);
  if (code === "EG_EGY_PRIM") return v.toFixed(2);
  return v.toFixed(1);
}
function people(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " bn";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " m";
  if (n >= 1e3) return Math.round(n / 1e3) + " k";
  return String(Math.round(n));
}
const money = m => m === null || m === undefined ? "—" : m >= 1000 ? "$" + (m / 1000).toFixed(1) + " bn" : "$" + m.toFixed(m >= 10 ? 0 : 1) + " m";
const pct = v => v === null || v === undefined ? "—" : Math.round(v * 100) + "%";
const signed = (v, code) => v === null || v === undefined ? "—" : (v > 0 ? "+" : "") + fmt(v, code);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function alpha(color, a) {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function track(event) {                                   // optional GoatCounter analytics
  try { if (window.goatcounter?.count) window.goatcounter.count({ path: event, event: true }); } catch {}
}

/* ================================================================ model (mirrors model/sdg7_model.py) */

const WINDOW = 10, PHI = 0.8, EPS = 0.005;

function ols(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}
const steps = (h, damped) => damped ? PHI * (1 - PHI ** h) / (1 - PHI) : h;

// Returns year -> forecast, or null. Same rules as fit() in the Python model.
function fitModel(model, pts, kind) {
  if (!pts.length) return null;
  const maxY = pts[pts.length - 1].year;
  const w = pts.filter(p => p.year > maxY - WINDOW);
  if (w.length < 3) return null;
  const xs = w.map(p => p.year), ys = w.map(p => p.value);
  const t0 = xs[xs.length - 1], last = ys[ys.length - 1], damped = model.startsWith("damped");
  let f;
  if (model === "naive") f = () => last;
  else if (model === "drift" || model === "damped") { const b = ols(xs, ys); f = t => last + b * steps(t - t0, damped); }
  else if (model === "logistic") {
    const lg = p => { const q = Math.min(Math.max(p / 100, EPS), 1 - EPS); return Math.log(q / (1 - q)); };
    const b = ols(xs, ys.map(lg)), l0 = lg(last);
    f = t => 100 / (1 + Math.exp(-(l0 + b * (t - t0))));
  } else if (model === "growth" || model === "damped_growth") {
    if (ys.some(v => v <= 0)) return null;
    const g = ols(xs, ys.map(Math.log));
    f = t => last * Math.exp(g * steps(t - t0, damped));
  } else return null;
  return kind === "pct" ? t => Math.min(100, Math.max(0, f(t))) : t => Math.max(0, f(t));
}

function computeForecast(code, key) {
  const sm = MODEL.series[code];
  const pts = points(DATA.series[code], key);
  if (pts.length < 3 || latest(pts).year < TARGET_YEAR - 15) return null;
  const f = fitModel(sm.chosen, pts, sm.kind);
  if (!f) return null;
  const last = latest(pts).year, q = sm.interval_q80, H = MODEL.horizon;
  const out = { from: last + 1, mid: [], lo: [], hi: [] };
  for (let y = last + 1; y <= TARGET_YEAR; y++) {
    const h = y - last, w = h <= H ? q[h] : q[H] * Math.sqrt(h / H), m = f(y);
    out.mid.push(m);
    if (sm.kind === "pct") { out.lo.push(Math.max(0, m - w)); out.hi.push(Math.min(100, m + w)); }
    else { out.lo.push(Math.max(0, m * (1 - w))); out.hi.push(m * (1 + w)); }
  }
  return out;
}

const forecast = (code, key) => live.forecasts[code + "@" + key] || MODEL.series[code]?.forecasts[key] || null;
function at2030(fc) {
  if (!fc || fc.from > TARGET_YEAR) return null;
  const i = TARGET_YEAR - fc.from;
  return { mid: fc.mid[i], lo: fc.lo[i], hi: fc.hi[i] };
}

function accessStatus(last, f) {               // mirrors access_status() in scripts/build.py
  if (last === null || last === undefined) return "No data";
  if (last >= 99) return "Achieved";
  if (f && f.mid >= 99) return "On track";
  if (f && f.hi >= 99) return "At risk";
  return "Off track";
}

function assess(code, key) {
  const pts = points(DATA.series[code], key);
  const last = latest(pts);
  const kind = SERIES[code].kind;
  if (!last) return { status: "No data", pts };
  const base = valueIn(pts, BASE_YEAR);
  const res = { pts, last, change: base ? last.value - base.value : null, f30: at2030(forecast(code, key)) };
  if (kind === "access") res.status = accessStatus(last.value, res.f30);
  else if (kind === "efficiency") {
    if (base && last.year > BASE_YEAR) {
      res.rate = (1 - Math.pow(last.value / base.value, 1 / (last.year - BASE_YEAR))) * 100;
      res.status = res.rate >= 2.6 ? "Meeting 2.6%/yr" : res.rate > 0 ? "Improving slowly" : "Getting worse";
    } else res.status = "Not enough data";
  } else res.status = res.change === null ? "Not enough data" : res.change > 0 ? "Rising" : "Falling";
  return res;
}
const pill = s => `<span class="pill ${STATUS_CLASS[s] || "na"}">${esc(s)}</span>`;

/* ================================================================ overview */

function renderOverview() {
  const k = KPIS.impact;
  $("ov-meta").textContent = `UN release ${KPIS.release} · data refreshed ${new Date(KPIS.data.fetched).toLocaleDateString()}`;
  const tiles = [
    ["People without electricity", people(k.people_without_electricity), `${k.world_electricity_year} · forecast ${people(k.people_without_electricity_2030)} in 2030`],
    ["World electricity access", k.world_electricity_pct.toFixed(1) + "%", `${k.world_electricity_year} · forecast ${k.world_electricity_2030.toFixed(1)}% in 2030`],
    ["People without clean cooking", people(k.people_without_clean_cooking), `${k.world_clean_cooking_year} · world access ${k.world_clean_cooking_pct.toFixed(0)}%`],
    ["Renewable share of energy", k.world_renewable_share_pct.toFixed(1) + "%", `World, ${k.world_renewable_share_year}`],
    ["Countries off track", String(k.countries_electricity["Off track"]), "for universal electricity by 2030"],
    ["Countries off track", String(k.countries_clean_cooking["Off track"]), "for universal clean cooking by 2030"],
  ];
  $("ov-kpis").innerHTML = tiles.map(([l, v, s]) => `<div class="kpi"><span class="kpi-label">${l}</span><span class="kpi-value">${v}</span><span class="kpi-sub">${s}</span></div>`).join("");
  $("ov-status-elec").innerHTML = statusBar(k.countries_electricity);
  $("ov-status-cook").innerHTML = statusBar(k.countries_clean_cooking);
  $("ov-top").innerHTML = Object.entries(BIZ).map(([lens, b]) => `
    <div class="top-block">
      <div class="top-head"><b>${esc(b.title)}</b><button class="link" data-lens="${lens}">Open</button></div>
      <ol class="top-list">${b.rows.slice(0, 5).map(r => `<li><button class="link plain" data-place="${r.code}">${esc(r.name)}</button><span class="num">${r.score.toFixed(0)}</span></li>`).join("")}</ol>
    </div>`).join("");
  $("ov-top").querySelectorAll("[data-lens]").forEach(b => b.addEventListener("click", () => { state.lens = b.dataset.lens; show("market"); }));
  $("ov-top").querySelectorAll("[data-place]").forEach(b => b.addEventListener("click", () => openPlace(b.dataset.place)));
}

function statusBar(counts) {
  const order = ["Achieved", "On track", "At risk", "Off track"];
  const total = order.reduce((s, k) => s + (counts[k] || 0), 0);
  return `<div class="stack" role="img" aria-label="${order.map(k => `${k} ${counts[k]}`).join(", ")}">` +
    order.map(k => counts[k] ? `<span class="seg ${STATUS_CLASS[k]}" style="flex:${counts[k]}" title="${k}: ${counts[k]}"></span>` : "").join("") +
    `</div><div class="stack-legend">` + order.map(k => `<span><i class="dot ${STATUS_CLASS[k]}"></i>${k} <b>${counts[k] || 0}</b></span>`).join("") +
    `</div><p class="meta small">${total} countries with data</p>`;
}

/* ================================================================ country profile */

function renderPicker() {
  const sel = $("country");
  const groups = {};
  for (const c of Object.keys(DATA.regionOf)) {
    if (!Object.values(DATA.series).some(s => s.data[c])) continue;
    (groups[DATA.regionOf[c]] ??= []).push(c);
  }
  let html = `<optgroup label="Aggregates"><option value="${WORLD}">World</option>` +
    DATA.sdgRegions.map(r => `<option value="${r}">${esc(name(r))}</option>`).join("") + `</optgroup>`;
  for (const r of DATA.sdgRegions) {
    const list = (groups[r] || []).sort((a, b) => name(a).localeCompare(name(b)));
    html += `<optgroup label="${esc(name(r))}">` + list.map(c => `<option value="${c}">${esc(name(c))}</option>`).join("") + `</optgroup>`;
  }
  sel.innerHTML = html;
  sel.addEventListener("change", () => { state.place = sel.value; $("live-msg").textContent = ""; renderProfile(); });
}

function openPlace(code, series) {
  state.place = code;
  if (series) state.series = series;
  show("profile");
  window.scrollTo(0, 0);
}

function renderProfile() {
  const p = state.place;
  $("country").value = p;
  const r = regionOf(p);
  const years = Object.keys(SERIES).map(c => latest(points(DATA.series[c], p))?.year).filter(Boolean);
  const pop = latest(points(DATA.population, p));
  const groups = (DATA.groups?.[p] || []).map(g => g.toUpperCase()).join(", ");
  $("place-meta").textContent = [r ? name(r) : null, pop ? `Population ${people(pop.value)} (${pop.year})` : null, groups || null,
    years.length ? `Latest UN data ${Math.max(...years)}` : "No SDG 7 data reported"].filter(Boolean).join(" · ");

  $("tiles").innerHTML = Object.entries(SERIES).map(([code, cfg]) => {
    const a = assess(code, p);
    const body = a.last
      ? `<div class="value">${fmt(a.last.value, code)}<small>${cfg.unit}</small></div>
         <div class="tfoot">${pill(a.status)}<span>${a.last.year}</span></div>
         <div class="tfoot">${a.f30 ? `<span>2030: <b>${fmt(a.f30.mid, code)}</b> (${fmt(a.f30.lo, code)}–${fmt(a.f30.hi, code)})</span>` : ""}
         ${a.change !== null ? `<span>${signed(a.change, code)} since ${BASE_YEAR}</span>` : ""}</div>`
      : `<div class="empty">No data reported</div>`;
    return `<button class="tile" role="listitem" data-code="${code}" aria-pressed="${code === state.series}">
      <span class="ind">Indicator ${goalIndicator(code)}</span><span class="label">${cfg.short}</span>${body}</button>`;
  }).join("");
  $("tiles").querySelectorAll(".tile").forEach(t => t.addEventListener("click", () => { state.series = t.dataset.code; renderProfile(); }));

  renderChart();
  renderPace();
  renderUrbanRural();
  renderTech();
  renderFinance();
}

function renderChart() {
  const code = state.series, p = state.place, cfg = SERIES[code], s = DATA.series[code], sm = MODEL.series[code];
  const a = assess(code, p), fc = forecast(code, p);
  const lines = [{ key: p, label: name(p), color: css("--series-country"), width: 3 }];
  const r = regionOf(p);
  if (r) lines.push({ key: r, label: name(r), color: css("--series-region"), width: 2 });
  if (p !== WORLD) lines.push({ key: WORLD, label: "World", color: css("--series-world"), width: 2, dash: [5, 4] });

  const yrs = new Set();
  lines.forEach(l => points(s, l.key).forEach(pt => yrs.add(pt.year)));
  if (fc) for (let y = fc.from - 1; y <= TARGET_YEAR; y++) yrs.add(y);
  const years = [...yrs].filter(y => y >= 2000).sort((x, y) => x - y);

  const datasets = lines.map(l => {
    const pts = points(s, l.key);
    return { label: l.label, borderColor: l.color, backgroundColor: l.color, borderWidth: l.width, borderDash: l.dash || [],
             pointRadius: 0, pointHoverRadius: 4, tension: .2, spanGaps: true, data: years.map(y => valueIn(pts, y)?.value ?? null) };
  });
  if (fc && a.last) {
    const idx = y => y - fc.from;
    const series = (arr, anchor) => years.map(y => y < fc.from - 1 ? null : y === fc.from - 1 ? anchor : arr[idx(y)] ?? null);
    const c = css("--series-country");
    datasets.push({ label: "80% range (low)", data: series(fc.lo, a.last.value), borderWidth: 0, pointRadius: 0, fill: false });
    datasets.push({ label: "80% range", data: series(fc.hi, a.last.value), borderWidth: 0, pointRadius: 0,
                    backgroundColor: alpha(c, .18), fill: "-1" });
    datasets.push({ label: "Forecast", data: series(fc.mid, a.last.value), borderColor: c, borderWidth: 2, borderDash: [3, 4], pointRadius: 0 });
  }
  if (cfg.kind === "access") datasets.push({ label: "Target 100%", borderColor: css("--good"), borderWidth: 1, borderDash: [1, 3], pointRadius: 0, data: years.map(() => 100) });

  $("chart-title").textContent = `${cfg.short} · ${name(p)}`;
  $("chart-sub").textContent = s.desc;
  $("legend").innerHTML = lines.map(l => `<span><i style="background:${l.color}" class="${l.dash ? "dash" : ""}"></i>${esc(l.label)}</span>`).join("") +
    (fc ? `<span><i class="band"></i>Forecast, 80% range</span>` : "");
  const modelName = { naive: "last value carried forward", drift: "recent trend", damped: "slowing recent trend", logistic: "S-curve trend",
                      growth: "constant growth", damped_growth: "slowing growth" }[sm.chosen];
  const m = sm.metrics[sm.chosen];
  $("chart-note").textContent = !a.last ? `${name(p)} has not reported this indicator to the UN.` :
    `Source: ${s.source || "UN SDG database"}. Forecast model: ${modelName} (selected by back-test; average error ` +
    `${sm.kind === "pct" ? m.mae.toFixed(1) + " points" : Math.round(m.mae * 100) + "%"} over 1–5 years).` +
    (a.f30 ? ` Central 2030 estimate: ${fmt(a.f30.mid, code)}${cfg.unit === "%" ? "%" : " " + cfg.unit}.` : "");

  const ink = css("--muted");
  if (chart) chart.destroy();
  chart = new Chart($("trend"), {
    type: "line", data: { labels: years, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false },
        tooltip: { filter: i => i.raw !== null && !["Target 100%", "80% range (low)"].includes(i.dataset.label),
          callbacks: { label: c => c.dataset.label === "80% range"
            ? ` 80% range: ${fmt(c.chart.data.datasets[c.datasetIndex - 1].data[c.dataIndex], code)}–${fmt(c.raw, code)}`
            : ` ${c.dataset.label}: ${fmt(c.raw, code)} ${cfg.unit}` } } },
      scales: { x: { grid: { display: false }, ticks: { color: ink, maxTicksLimit: 8 } },
                y: { grid: { color: css("--line") }, ticks: { color: ink }, beginAtZero: true, max: cfg.unit === "%" ? 100 : undefined,
                     title: { display: true, text: cfg.unit, color: ink } } },
    },
  });
}

function renderPace() {
  const el = $("pace"), p = state.place, a = assess("EG_ACS_ELEC", p);
  if (!a.last) { el.innerHTML = `<p class="meta">No electricity access data for ${esc(name(p))}.</p>`; return; }
  if (a.last.value >= 99) { el.innerHTML = `<p class="pace-verdict">${esc(name(p))} already has universal electricity access (${fmt(a.last.value)}% in ${a.last.year}).</p>`; return; }
  const left = TARGET_YEAR - a.last.year, needed = (100 - a.last.value) / left;
  const pace = a.f30 ? (a.f30.mid - a.last.value) / left : 0;
  const ratio = pace > 0 ? needed / pace : Infinity;
  const pop = latest(points(DATA.population, p));
  const unserved = pop ? pop.value * (100 - a.last.value) / 100 : null;
  const arrival = pace > 0 ? Math.round(a.last.year + (100 - a.last.value) / pace) : null;
  const times = ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1);
  const verdict = pace <= 0 ? `Access is not rising. Reaching 100% by 2030 would need +${needed.toFixed(1)} points every year.`
    : ratio <= 1 ? `The forecast pace is enough to reach universal access by 2030.`
    : ratio <= 1.1 ? `The forecast pace only just reaches universal access by 2030, so any slowdown would miss the target.`
    : `Progress would need to be about ${times}× faster to reach 100% by 2030. ` + (arrival > 2100 ? `At the forecast pace it would not arrive this century.` : `At the forecast pace it arrives around ${arrival}.`);
  el.innerHTML = `
    ${unserved ? `<div class="pace-row"><span class="k">People without electricity (${a.last.year})</span><span class="v">${people(unserved)}</span></div>` : ""}
    <div class="pace-row"><span class="k">Gain needed each year to reach 100% by 2030</span><span class="v">+${needed.toFixed(1)} pts</span></div>
    <div class="pace-row"><span class="k">Forecast gain each year</span><span class="v">${pace >= 0 ? "+" : ""}${pace.toFixed(1)} pts</span></div>
    <p class="pace-verdict">${verdict}</p>`;
}

function renderUrbanRural() {
  const p = state.place;
  let html = "";
  for (const code of ["EG_ACS_ELEC", "EG_EGY_CLEAN"]) {
    const u = latest(points(DATA.series[code], p + "|URBAN")), r = latest(points(DATA.series[code], p + "|RURAL"));
    if (!u && !r) continue;
    html += `<div class="subhead">${SERIES[code].short}${u ? `, ${u.year}` : ""}</div><div class="bars">` +
      [["Urban", u, ""], ["Rural", r, "alt"]].map(([lab, pt, cls]) => pt ? `
        <div class="bar-row"><span>${lab}</span><div class="bar-track"><div class="bar-fill ${cls}" style="width:${pt.value}%"></div></div>
        <span class="num">${fmt(pt.value)}%</span></div>` : "").join("") + `</div>`;
    if (u && r) html += `<p class="note">Rural households are ${Math.abs(u.value - r.value).toFixed(1)} points ${u.value >= r.value ? "behind" : "ahead"}.</p>`;
  }
  $("urbanrural").innerHTML = html || `<p class="meta">No urban/rural breakdown reported for ${esc(name(p))}.</p>`;
}

function renderTech() {
  const p = state.place, s = DATA.series.EG_EGY_RNEW;
  const rows = TECH.map(([k, lab]) => [lab, latest(points(s, p + "|" + k))]).filter(r => r[1] && r[1].value > 0);
  const total = latest(points(s, p));
  if (!rows.length) { $("techmix").innerHTML = `<p class="meta">No capacity data for ${esc(name(p))}.</p>`; return; }
  const max = Math.max(...rows.map(r => r[1].value));
  rows.sort((a, b) => b[1].value - a[1].value);
  $("techmix").innerHTML = `<div class="bars">` + rows.map(([lab, pt]) => `
    <div class="bar-row"><span>${lab}</span><div class="bar-track"><div class="bar-fill" style="width:${(pt.value / max) * 100}%"></div></div>
    <span class="num">${fmt(pt.value, "EG_EGY_RNEW")}</span></div>`).join("") + `</div>` +
    (total ? `<p class="note">All renewables: ${fmt(total.value, "EG_EGY_RNEW")} W per person in ${total.year}.</p>` : "");
}

function renderFinance() {
  const p = state.place, pts = points(DATA.series.EG_IFF_RANDN, p);
  if (!pts.length) { $("finance").innerHTML = `<p class="meta">Not reported for ${esc(name(p))}. This indicator covers developing countries.</p>`; return; }
  const last = latest(pts).year, recent = pts.filter(x => x.year > last - 5), total = recent.reduce((s, x) => s + x.value, 0);
  const max = Math.max(...recent.map(x => x.value), 1);
  const lens = BIZ.finance.rows.find(r => r.code === p);
  $("finance").innerHTML = `<div class="bars">` + recent.map(x => `
    <div class="bar-row"><span>${x.year}</span><div class="bar-track"><div class="bar-fill alt" style="width:${(x.value / max) * 100}%"></div></div>
    <span class="num">${money(x.value)}</span></div>`).join("") + `</div>
    <p class="note">${money(total)} in ${last - 4}–${last}` + (lens ? `, about $${lens.finance_per_person.toFixed(0)} per person without electricity. Finance-gap rank: ${lens.rank} of ${BIZ.finance.rows.length}.` : ".") + `</p>`;
}

/* ================================================================ market finder */

function setupMarket() {
  $("lens-picker").innerHTML = Object.entries(BIZ).map(([k, b]) => `
    <button class="lens" role="radio" data-lens="${k}" aria-checked="false">
      <span class="lens-title">${esc(b.title)}</span><span class="lens-q">${esc(b.question)}</span><span class="lens-who">For: ${esc(b.who)}</span>
    </button>`).join("");
  $("lens-picker").querySelectorAll(".lens").forEach(b => b.addEventListener("click", () => { state.lens = b.dataset.lens; track("lens-" + state.lens); renderMarket(true); }));
  $("m-region").innerHTML = `<option value="">All regions</option>` + DATA.sdgRegions.map(r => `<option value="${r}">${esc(name(r))}</option>`).join("");
  ["m-region", "m-group", "m-search", "a-hh", "a-spend", "a-share"].forEach(id => $(id).addEventListener("input", () => renderMarket()));
  $("weights-reset").addEventListener("click", () => { delete state.weights[state.lens]; renderMarket(true); });
  $("m-copy").addEventListener("click", e => copyCsv(e.target, marketCsv()));
  $("m-download").addEventListener("click", () => downloadCsv(marketCsv(), `sdg7-market-${state.lens}.csv`));
}

function lensWeights() {
  const comps = BIZ[state.lens].components;
  return state.weights[state.lens] ??= Object.fromEntries(Object.entries(comps).map(([k, c]) => [k, Math.round(c.weight * 100)]));
}

const COMP_FMT = {
  unserved_now: people, unserved_2030: people, finance_per_person: v => v === null ? "—" : "$" + v.toFixed(0),
  momentum: v => v === null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + " pts/yr",
  rural_gap: v => v === null ? "—" : v.toFixed(0) + " pts", urban_gap: v => v === null ? "—" : v.toFixed(0) + "%",
  off_track: v => v === null ? "—" : v.toFixed(0) + " pts", ren_share: v => v === null ? "—" : v.toFixed(0) + "%",
  cap_per_person: v => v === null ? "—" : Math.round(v).toLocaleString() + " W", cap_growth: v => v === null ? "—" : v.toFixed(1) + "%",
  intensity_impr: v => v === null ? "—" : v.toFixed(1) + "%", access: v => v === null ? "—" : v.toFixed(0) + "%",
};
const SHORT = { unserved_now: "Without access", unserved_2030: "Without access 2030", rural_gap: "Rural gap", urban_gap: "Urban unserved",
  momentum: "Momentum", ren_share: "Renewable share", cap_per_person: "Capacity / person", cap_growth: "Capacity growth",
  intensity_impr: "Efficiency gain", access: "Electricity", finance_per_person: "Finance per person", off_track: "2030 shortfall" };

function renderMarket(rebuildWeights) {
  const b = BIZ[state.lens], w = lensWeights(), comps = Object.keys(b.components);
  $("lens-picker").querySelectorAll(".lens").forEach(x => x.setAttribute("aria-checked", x.dataset.lens === state.lens));
  if (rebuildWeights || !$("weights").dataset.lens || $("weights").dataset.lens !== state.lens) {
    $("weights").dataset.lens = state.lens;
    $("weights").innerHTML = comps.map(k => `
      <div class="weight"><label for="w-${k}">${esc(b.components[k].label)}${b.components[k].direction === "low" ? " (lower is better)" : ""}</label>
      <div class="weight-row"><input type="range" id="w-${k}" min="0" max="100" step="5" value="${w[k]}"><output id="wo-${k}">${w[k]}</output></div></div>`).join("");
    comps.forEach(k => $("w-" + k).addEventListener("input", e => { w[k] = +e.target.value; $("wo-" + k).textContent = w[k]; renderMarket(); }));
  }
  const sizing = state.lens === "offgrid" || state.lens === "cooking";
  $("assumptions-box").hidden = !sizing;
  if (sizing && !$("a-spend").dataset.touched) $("a-spend").value = state.lens === "offgrid" ? 60 : 40;

  const hh = +$("a-hh").value || 4.5, spend = +$("a-spend").value || 0, share = (+$("a-share").value || 0) / 100;
  const region = $("m-region").value, group = $("m-group").value, q = $("m-search").value.trim().toLowerCase();
  const wsum = comps.reduce((s, k) => s + w[k], 0);

  let rows = b.rows.map(r => {
    let tot = 0, ws = 0;
    for (const k of comps) if (r.ranks[k] !== null && r.ranks[k] !== undefined) { tot += w[k] * r.ranks[k]; ws += w[k]; }
    const score = ws ? 100 * tot / ws : null;
    const pool = sizing && r.unserved_now ? r.unserved_now / hh * spend * share / 1e6 : null;
    return { ...r, score, pool };
  });
  rows.sort((a, c) => (c.score ?? -1) - (a.score ?? -1));
  rows.forEach((r, i) => (r.globalRank = i + 1));
  if (region) rows = rows.filter(r => regionOf(r.code) === region);
  if (group) rows = rows.filter(r => r.groups.includes(group));
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
  const [sk, sd] = state.mSort;
  rows.sort((a, c) => {
    const x = sk === "score" ? a.score : sk === "pool" ? a.pool : sk === "name" ? a.name : a[sk];
    const y = sk === "score" ? c.score : sk === "pool" ? c.pool : sk === "name" ? c.name : c[sk];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sd;
  });
  state.mRows = rows;

  const totalPeople = rows.reduce((s, r) => s + (r.unserved_now || 0), 0);
  const totalPool = rows.reduce((s, r) => s + (r.pool || 0), 0);
  $("m-summary").innerHTML = `<span class="chip"><b>${rows.length}</b> countries</span>` +
    (sizing ? `<span class="chip"><b>${people(totalPeople)}</b> people without ${state.lens === "offgrid" ? "electricity" : "clean cooking"}</span>
               <span class="chip">Revenue pool at your assumptions <b>${money(totalPool)}</b> a year</span>` : "") +
    (wsum ? "" : `<span class="chip warn">All weights are zero</span>`);

  const cols = [["globalRank", "#", "num"], ["name", "Country", ""], ["score", "Score", "num"], ...comps.map(k => [k, SHORT[k] || k, "num"])];
  if (sizing) cols.push(["pool", "Revenue pool / yr", "num"]);
  $("m-table").querySelector("thead").innerHTML = "<tr>" + cols.map(([k, l, c]) =>
    `<th data-sort="${k}" class="${c}" aria-sort="${sk === k ? (sd === 1 ? "ascending" : "descending") : "none"}">${l}</th>`).join("") + "</tr>";
  $("m-table").querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.sort === "globalRank" ? "score" : th.dataset.sort;
    state.mSort = state.mSort[0] === k ? [k, -state.mSort[1]] : [k, k === "name" ? 1 : -1];
    renderMarket();
  }));
  $("m-table").querySelector("tbody").innerHTML = rows.slice(0, 250).map(r => `
    <tr tabindex="0" data-code="${r.code}">
      <td class="num muted">${r.globalRank}</td>
      <td><span class="cname">${esc(r.name)}</span><span class="sub">${esc(r.region)}${r.groups.length ? " · " + r.groups.join(", ").toUpperCase() : ""}</span></td>
      <td class="num"><span class="score"><span class="score-bar" style="width:${r.score ?? 0}%"></span><span>${r.score === null ? "—" : r.score.toFixed(0)}</span></span></td>
      ${comps.map(k => `<td class="num">${(COMP_FMT[k] || (v => v))(r[k] ?? null)}</td>`).join("")}
      ${sizing ? `<td class="num">${money(r.pool)}</td>` : ""}
    </tr>`).join("") || `<tr><td colspan="${cols.length}" class="meta">No countries match these filters.</td></tr>`;
  $("m-table").querySelectorAll("tbody tr[data-code]").forEach(tr => {
    const open = () => openPlace(tr.dataset.code, state.lens === "cooking" ? "EG_EGY_CLEAN" : state.lens === "sourcing" ? "EG_EGY_RNEW" : "EG_ACS_ELEC");
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  });
}

function marketCsv() {
  const b = BIZ[state.lens], comps = Object.keys(b.components), w = lensWeights();
  const sizing = state.lens === "offgrid" || state.lens === "cooking";
  const head = ["rank", "country", "area_code", "region", "un_groups", "score", ...comps, ...(sizing ? ["revenue_pool_musd_per_year"] : []),
                ...comps.map(k => "weight_" + k)];
  return toCsv([head, ...state.mRows.map(r => [r.globalRank, r.name, r.code, r.region, r.groups.join(";"), r.score?.toFixed(2),
    ...comps.map(k => r[k]), ...(sizing ? [r.pool?.toFixed(3)] : []), ...comps.map(k => w[k])])]);
}

/* ================================================================ gap finder */

function setupGaps() {
  $("g-indicator").innerHTML = Object.entries(SERIES).map(([c, cfg]) => `<option value="${c}">${cfg.short} (${goalIndicator(c)})</option>`).join("");
  $("g-region").innerHTML = `<option value="">All regions</option>` + DATA.sdgRegions.map(r => `<option value="${r}">${esc(name(r))}</option>`).join("");
  ["g-indicator", "g-region", "g-status", "g-search"].forEach(id => $(id).addEventListener("input", renderGaps));
  document.querySelectorAll("#g-table th").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    state.gSort = state.gSort[0] === k ? [k, -state.gSort[1]] : [k, 1];
    renderGaps();
  }));
  $("g-copy").addEventListener("click", e => copyCsv(e.target, gapsCsv()));
  $("g-download").addEventListener("click", () => downloadCsv(gapsCsv(), `sdg7-${$("g-indicator").value}.csv`));
}

function renderGaps() {
  const code = $("g-indicator").value, region = $("g-region").value, q = $("g-search").value.trim().toLowerCase();
  const kind = SERIES[code].kind;
  const statuses = kind === "access" ? ["Off track", "At risk", "On track", "Achieved"]
    : kind === "efficiency" ? ["Getting worse", "Improving slowly", "Meeting 2.6%/yr"] : ["Falling", "Rising"];
  const sel = $("g-status");
  if (sel.dataset.code !== code) {
    sel.dataset.code = code;
    sel.innerHTML = `<option value="">Any status</option>` + statuses.map(s => `<option>${s}</option>`).join("");
  }
  const status = sel.value;
  const all = Object.keys(DATA.regionOf).filter(c => DATA.series[code].data[c]).map(c => {
    const a = assess(code, c);
    return { code: c, name: name(c), region: name(regionOf(c)), latest: a.last?.value ?? null, year: a.last?.year,
             change: a.change, proj: a.f30?.mid ?? null, status: a.status };
  });
  let rows = region ? all.filter(r => regionOf(r.code) === region) : all.slice();
  const scope = rows.slice();
  if (status) rows = rows.filter(r => r.status === status);
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
  const [k, d] = state.gSort;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * d;
  });
  state.gRows = rows; state.gCode = code;
  document.querySelectorAll("#g-table th").forEach(th => th.setAttribute("aria-sort", th.dataset.sort === k ? (d === 1 ? "ascending" : "descending") : "none"));
  $("g-summary").innerHTML = `<span class="chip"><b>${scope.length}</b> countries${region ? " in " + esc(name(region)) : ""}</span>` +
    statuses.map(s => `<span class="chip">${pill(s)} <b>${scope.filter(r => r.status === s).length}</b></span>`).join("") +
    `<span class="chip">Showing <b>${rows.length}</b></span>`;
  const better = chg => chg === null || chg === 0 ? "" : (chg > 0) !== (kind === "efficiency") ? "pos" : "neg";
  const tbody = document.querySelector("#g-table tbody");
  tbody.innerHTML = rows.map(r => `
    <tr tabindex="0" data-code="${r.code}">
      <td>${esc(r.name)}</td><td>${esc(r.region)}</td>
      <td class="num">${fmt(r.latest, code)}<span class="yr">${r.year ?? ""}</span></td>
      <td class="num ${better(r.change)}">${signed(r.change, code)}</td>
      <td class="num">${fmt(r.proj, code)}</td>
      <td>${pill(r.status)}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="meta">No countries match these filters.</td></tr>`;
  tbody.querySelectorAll("tr[data-code]").forEach(tr => {
    const open = () => openPlace(tr.dataset.code, code);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  });
}

function gapsCsv() {
  const u = SERIES[state.gCode].unit;
  return toCsv([["country", "area_code", "region", `latest (${u})`, "year", "change_since_2015", "forecast_2030", "status"],
    ...state.gRows.map(r => [r.name, r.code, r.region, r.latest, r.year, r.change?.toFixed(2), r.proj?.toFixed(2), r.status])]);
}

/* ================================================================ app performance (KPIs) */

function daysSince(iso) { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }

function renderPerf() {
  const k = KPIS, ds = daysSince(k.data.fetched), lastRun = RUNS[RUNS.length - 1];
  const elec = k.model.EG_ACS_ELEC, cook = k.model.EG_EGY_CLEAN;
  const covAll = Object.values(k.data.series);
  const coverage = covAll.reduce((s, c) => s + c.countries_current, 0) / covAll.reduce((s, c) => s + c.countries_total, 0);
  const tiles = [
    ["Data freshness", `${ds} day${ds === 1 ? "" : "s"}`, `since last refresh · UN release ${k.release}`, ds <= 8 ? "on" : ds <= 35 ? "slow" : "off"],
    ["UN release check", live.release ? (live.release === k.release ? "Up to date" : "New release") : "Not checked", live.release ? `Live UN API reports ${live.release}` : "Works on the hosted site", live.release ? (live.release === k.release ? "on" : "slow") : "na"],
    ["Electricity forecast error", `${elec.mae.toFixed(1)} pts`, `${pct(elec.skill_vs_naive)} better than no-change guess`, elec.skill_vs_naive > 0.2 ? "on" : "slow"],
    ["Clean cooking forecast error", `${cook.mae.toFixed(1)} pts`, `${pct(cook.skill_vs_naive)} better than no-change guess`, cook.skill_vs_naive > 0.2 ? "on" : "slow"],
    ["80% range reliability", pct(elec.interval_coverage_80), "of real outcomes fell inside the range (target 80%)", Math.abs(elec.interval_coverage_80 - .8) <= .1 ? "on" : "slow"],
    ["Current-data coverage", pct(coverage), "country-indicator pairs with data in the last 3 years", coverage >= .7 ? "on" : "slow"],
    ["Observations", k.data.observations.toLocaleString(), `${Object.keys(k.data.series).length} UN series + population · build ${k.pipeline.build_seconds}s`, "na"],
    lastRun ? ["Last scheduled check", `${daysSince(lastRun.checked_utc)} day${daysSince(lastRun.checked_utc) === 1 ? "" : "s"} ago`,
      `${lastRun.outcome} · ${RUNS.filter(r => r.outcome === "failed").length} failed of ${RUNS.length} runs`,
      lastRun.outcome === "failed" ? "off" : daysSince(lastRun.checked_utc) <= 8 ? "on" : "slow"]
      : ["Last scheduled check", "None yet", "Runs weekly once hosted on GitHub", "na"],
  ];
  $("perf-kpis").innerHTML = tiles.map(([l, v, s, st]) => `<div class="kpi"><span class="kpi-label">${l}</span><span class="kpi-value">${v}</span>
    <span class="kpi-sub">${st !== "na" ? `<i class="dot ${st}"></i>` : ""}${s}</span></div>`).join("");

  $("perf-cov").innerHTML = `<thead><tr><th>Indicator</th><th class="num">Rows from UN</th><th class="num">Countries</th><th class="num">Latest year</th><th class="num">Countries with recent data</th></tr></thead><tbody>` +
    Object.entries(k.data.series).map(([c, v]) => `<tr><td>${esc(v.label)}</td><td class="num">${(v.rows_from_un ?? 0).toLocaleString()}</td>
    <td class="num">${v.countries}/${v.countries_total}</td><td class="num">${v.latest_year}</td><td class="num">${v.countries_current} (${pct(v.countries_current / v.countries_total)})</td></tr>`).join("") + "</tbody>";

  const mname = { naive: "No change", drift: "Recent trend", damped: "Slowing trend", logistic: "S-curve", growth: "Constant growth", damped_growth: "Slowing growth" };
  $("perf-model").innerHTML = `<thead><tr><th>Indicator</th><th>Chosen model</th><th class="num">Average error</th><th class="num">Better than no-change</th><th class="num">Within tolerance</th><th class="num">80% range hit rate</th><th class="num">Tests</th></tr></thead><tbody>` +
    Object.entries(k.model).map(([c, m]) => `<tr><td>${esc(m.label)}</td><td>${mname[m.chosen] || m.chosen}</td>
      <td class="num">${m.unit === "points" ? m.mae.toFixed(2) + " pts" : Math.round(m.mae * 100) + "%"}</td>
      <td class="num ${m.skill_vs_naive > 0.05 ? "pos" : ""}">${pct(m.skill_vs_naive)}</td>
      <td class="num">${pct(m.within_tol)} <span class="yr">±${m.unit === "points" ? m.tolerance + " pts" : m.tolerance * 100 + "%"}</span></td>
      <td class="num">${pct(m.interval_coverage_80)}</td><td class="num">${m.n.toLocaleString()}</td></tr>`).join("") + "</tbody>";

  const h = HISTORY.slice(-12).reverse();
  $("perf-hist").innerHTML = `<thead><tr><th>Run (UTC)</th><th>UN release</th><th class="num">Observations</th><th class="num">World electricity</th><th class="num">Without electricity</th><th class="num">Off-track countries</th><th class="num">Model error</th></tr></thead><tbody>` +
    (h.map(r => `<tr><td>${esc(r.built.replace("T", " ").slice(0, 16))}</td><td>${esc(r.release)}</td><td class="num">${(+r.observations).toLocaleString()}</td>
      <td class="num">${(+r.world_electricity_pct).toFixed(1)}%</td><td class="num">${people(+r.people_without_electricity)}</td>
      <td class="num">${r.countries_off_track_electricity}</td><td class="num">${(+r.mae_electricity_pts).toFixed(2)} pts</td></tr>`).join("") ||
      `<tr><td colspan="7" class="meta">No runs recorded yet.</td></tr>`) + "</tbody>";

  const defs = [
    ["Data freshness", "Days since the pipeline last downloaded data from the UN. Green within 8 days (the scheduled job runs weekly)."],
    ["UN release check", "The page asks the UN API which data release is current and compares it with the release this site was built from."],
    ["Forecast error (MAE)", "Average absolute difference between the forecast and what the UN later reported, 1 to 5 years ahead, across all countries. In percentage points for % indicators, relative error for the others."],
    ["Better than no-change", "How much smaller the error is than simply assuming nothing changes (skill score = 1 − MAE ÷ MAE of the no-change guess). Zero means the trend adds nothing."],
    ["Within tolerance", "Share of back-test forecasts within ±3 points (or ±10% for non-% indicators)."],
    ["80% range hit rate", "Ranges were sized from 2014-based tests and checked against 2019-based tests. A well-calibrated range contains about 80% of real outcomes."],
    ["Current-data coverage", "Share of country × indicator pairs whose latest value is no more than 2 years older than the newest year the UN has for that indicator."],
    ["Last scheduled check", "When the weekly job last asked the UN for a new release, its outcome (updated, no-change or failed) and the failure count across all runs."],
    ["Usage", "Page views and feature use (market lenses opened, CSV exports) are tracked in GoatCounter when it is switched on in config.js."],
  ];
  $("perf-defs").innerHTML = defs.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("");
}

/* ================================================================ live data from the UN API */

async function checkRelease() {
  if (!CFG.liveReleaseCheck) return;
  try {
    const list = await fetch(`${UN_API}/Series/List?allreleases=false`).then(r => r.json());
    live.release = list.find(s => s.code === "EG_ACS_ELEC")?.release;
    if (live.release && live.release !== DATA.release) {
      const b = $("banner");
      b.innerHTML = `<div class="wrap">The UN has published data release <b>${esc(live.release)}</b> (this site uses ${esc(DATA.release)}). ` +
        `The scheduled update will rebuild the site; meanwhile use <b>Refresh from UN now</b> on any country profile for the newest figures.</div>`;
      b.hidden = false;
    }
    if (state.view === "perf") renderPerf();
  } catch { /* offline, or running inside a sandbox that blocks outside calls */ }
}

async function refreshLive() {
  const p = state.place, btn = $("live-refresh"), msg = $("live-msg");
  btn.disabled = true; msg.textContent = `Fetching ${name(p)} from the UN API…`;
  try {
    const codes = [...Object.keys(SERIES), "EG_IFF_RANDN"];
    const results = await Promise.all(codes.map(c =>
      fetch(`${UN_API}/Series/Data?seriesCode=${c}&areaCode=${p}&pageSize=2000`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })));
    let added = 0, changed = 0;
    results.forEach((res, i) => {
      const code = codes[i], buckets = {}, seen = new Set();
      for (const row of res.data) {
        const v = parseFloat(row.value), y = +row.timePeriodStart;
        if (!isFinite(v) || y < 2000) continue;
        const d = row.dimensions || {}, tech = d["Type of renewable technology"];
        let key = row.geoAreaCode;
        if (d.Location && d.Location !== "ALLAREA") key += "|" + d.Location;
        if (tech && tech !== "ALL") { if (code === "EG_IFF_RANDN" || !TECH.some(t => t[0] === tech)) continue; key += "|" + tech; }
        if (seen.has(key + "@" + y)) continue;
        seen.add(key + "@" + y);
        (buckets[key] ??= []).push([y, Math.round(v * 100) / 100]);
      }
      for (const [key, pts] of Object.entries(buckets)) {
        const old = new Map(points(DATA.series[code], key).map(x => [x.year, x.value]));
        pts.sort((a, b) => a[0] - b[0]);
        for (const [y, v] of pts) { if (!old.has(y)) added++; else if (old.get(y) !== v) changed++; }
        const arr = [pts[0][0], ...Array(pts[pts.length - 1][0] - pts[0][0] + 1).fill(null)];
        pts.forEach(([y, v]) => (arr[y - pts[0][0] + 1] = v));
        DATA.series[code].data[key] = arr;
      }
      if (MODEL.series[code]) { const f = computeForecast(code, p); if (f) live.forecasts[code + "@" + p] = f; }
    });
    live.fetchedAt = new Date();
    msg.textContent = `Live UN data loaded ${live.fetchedAt.toLocaleTimeString()}: ${added} new and ${changed} revised values; forecasts recalculated.`;
    track("live-refresh");
    renderProfile();
  } catch (e) {
    msg.textContent = "Could not reach the UN API from here. Live refresh works on the hosted site (it is blocked inside previews).";
  } finally { btn.disabled = false; }
}

/* ================================================================ CSV + navigation */

const toCsv = rows => rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
async function copyCsv(btn, text) {
  const label = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; track("csv-copy"); }
  catch { btn.textContent = "Copy blocked. Use Download"; }
  setTimeout(() => (btn.textContent = label), 1800);
}
function downloadCsv(text, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  track("csv-download");
}

function show(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== "view-" + view));
  ({ overview: renderOverview, profile: renderProfile, market: () => renderMarket(true), gaps: renderGaps, perf: renderPerf })[view]();
  track("view-" + view);
}

function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map(l => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

async function start() {
  if (CFG.goatcounter) {
    const s = document.createElement("script");
    s.async = true; s.src = "https://gc.zgo.at/count.js"; s.dataset.goatcounter = CFG.goatcounter;
    document.head.appendChild(s);
  }
  try {
    const get = f => fetch(f).then(r => { if (!r.ok) throw new Error(f); return r; });
    [DATA, MODEL, BIZ, KPIS] = await Promise.all(["data/sdg7.json", "data/model.json", "data/business.json", "data/kpis.json"].map(f => get(f).then(r => r.json())));
    HISTORY = await get("data/kpi_history.csv").then(r => r.text()).then(parseCsv).catch(() => []);
    RUNS = await get("data/run_log.csv").then(r => r.text()).then(parseCsv).catch(() => []);
  } catch (e) {
    $("status").textContent = "Could not load the data files. If you opened index.html straight from your disk, start a local server instead (see README).";
    return;
  }
  $("status").hidden = true;
  $("data-date").textContent = `UN release ${DATA.release}, downloaded ${new Date(DATA.generated).toLocaleDateString()}.`;
  renderPicker();
  setupMarket();
  setupGaps();
  $("a-spend").addEventListener("input", e => (e.target.dataset.touched = "1"));
  $("live-refresh").addEventListener("click", refreshLive);
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => show(t.dataset.view)));
  const hash = location.hash.slice(1);
  show(["overview", "profile", "market", "gaps", "perf"].includes(hash) ? hash : "overview");
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.view === "profile" && renderChart());
  checkRelease();
}
start();
