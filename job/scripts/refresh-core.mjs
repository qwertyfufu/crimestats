// CrimeStats USA — the data refresh as a transaction.
//
// Pure, network-free core used by scripts/refresh-data.mjs and by the tests.
// The previous refresh mutated one shared overlay as each source ran and wrote
// src/live-baked.js BEFORE validating anything, so:
//   - a rejected refresh still overwrote the data the next APK ships with;
//   - a source that failed half-way (BLS batch 2) left batch 1's new values
//     mixed with old ones, while the log said the metric was "unchanged";
//   - skipped sources (Census and FBI, then thought to need keys) left no trace, and
//     the metadata still read as a clean, fully fresh refresh.
//
// Now each source returns a STAGED result without touching anything. A source
// is applied only if it covers every jurisdiction and the dataset it produces
// passes validation; otherwise it is recorded as failed and its previous values
// stand. Nothing is written until the finished dataset validates, and both
// output files are written to temporaries and renamed into place together,
// stamped with a shared generation id so a torn write is detectable.

import { writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { STATE_ROWS, METRO_ROWS, mergeRows, BASE_VINTAGES } from '../src/data.js';
import { validateDataset, sanitizeMeta, seriesVintageProblems, STATE_IDS } from '../src/lib/validate.js';

// ---- Months -----------------------------------------------------------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_NUM = Object.fromEntries(MONTH_FULL.map((m, i) => [m, i + 1]));
export const periodOf = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
export const monthLabel = (p) => `${MON[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;
export const monthLong = (p) => `${MONTH_FULL[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`;

/** The n calendar months ending at `end`, oldest first. */
export function monthWindow(end, n) {
  let y = Number(end.slice(0, 4)), m = Number(end.slice(5));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift(periodOf(y, m));
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

/**
 * A fixed calendar window ending at `end`, keeping only months that have a
 * value. A month the source never published stays a GAP -- the old code took
 * "the last 24 values", which silently closed up BLS's unpublished October 2025
 * and let 24 points be labelled as 25 months.
 */
export function windowSeries(obs, end, n = 24) {
  const window = monthWindow(end, n);
  const periods = window.filter(p => Number.isFinite(obs.get(p)));
  return {
    periods,
    values: periods.map(p => obs.get(p)),
    span: periods.length ? [monthLabel(periods[0]), monthLabel(periods[periods.length - 1])] : undefined,
    gaps: window.filter(p => p >= (periods[0] || '9999') && !Number.isFinite(obs.get(p)))
  };
}

/**
 * A yearly series over the `n` calendar years ending at `end` (a 'YYYY'
 * string). A year with no value inside the range stays a GAP, exactly as a
 * missing month does -- Census never released standard 2020 one-year ACS
 * estimates, and the chart must show that rather than draw across it.
 */
export function yearSeries(byYear, end, n) {
  const window = Array.from({ length: n }, (_, i) => String(Number(end) - n + 1 + i));
  const periods = window.filter(y => Number.isFinite(byYear.get(y)));
  return {
    periods,
    values: periods.map(y => byYear.get(y)),
    gaps: window.filter(y => y >= (periods[0] || '9999') && !Number.isFinite(byYear.get(y)))
  };
}

const requireAllStates = (states, source) => {
  const missing = STATE_IDS.filter(id => !states[id]);
  if (missing.length) throw new Error(`${source}: no usable data for ${missing.length} jurisdiction(s): ${missing.slice(0, 8).join(',')}`);
};
const requireOnePeriod = (byId, source) => {
  const periods = new Set(Object.values(byId));
  if (periods.size !== 1) throw new Error(`${source}: jurisdictions end on different periods (${[...periods].sort().join(', ')})`);
  return [...periods][0];
};

// ---- Parsers: raw API payload -> staged result --------------------------------
// Each returns { states, metros?, meta?, vintages?, gaps?, period } or throws.

/** BLS LAUS. `series` is the concatenated Results.series from every batch. */
export function parseBLS(series, abbrBySeriesId) {
  const states = {}, latestById = {}, gaps = new Set();
  for (const s of series || []) {
    const abbr = abbrBySeriesId[s.seriesID];
    if (!abbr) continue;
    const obs = new Map();
    for (const d of s.data || []) {
      // Drop annual averages (M13); a non-numeric value ('-') is a month BLS
      // did not publish, and must stay visible as a gap, not vanish.
      if (!/^M(0[1-9]|1[0-2])$/.test(d.period)) continue;
      const v = parseFloat(d.value);
      if (Number.isFinite(v)) obs.set(periodOf(d.year, Number(d.period.slice(1))), v);
    }
    if (!obs.size) continue;
    const end = [...obs.keys()].sort().at(-1);
    const w = windowSeries(obs, end, 24);
    if (w.values.length < 12) continue;
    w.gaps.forEach(g => gaps.add(g));
    latestById[abbr] = end;
    states[abbr] = {
      unemployment: obs.get(end),
      unemploymentSeries: w.values,
      unemploymentPeriods: w.periods,
      unemploymentSpan: w.span
    };
  }
  requireAllStates(states, 'BLS');
  const end = requireOnePeriod(latestById, 'BLS');
  return { states, meta: { unemploymentPeriod: monthLong(end) }, gaps: { unemployment: [...gaps].sort() }, period: monthLong(end) };
}

/**
 * CDC VSRR provisional overdose deaths (12-month-ending counts).
 * CDC reports New York State EXCLUDING New York City under 'NY', and the city as
 * 'YC'. The old code divided the 'NY' count by (state pop - NYC pop) and stored
 * it on the New York STATE record, so "New York" silently meant the state minus
 * its largest city. Here the two are summed for matching months and divided by
 * the full state population, so the label and the geography agree.
 */
export function parseCDC(rows, { nycPopulation }) {
  if (!Array.isArray(rows)) throw new Error('CDC: unexpected response');
  const byJur = {};
  for (const r of rows) {
    const month = MONTH_NUM[r.month];
    const count = parseFloat(String(r.data_value ?? '').replace(/,/g, ''));
    if (!month || !Number.isFinite(count)) continue;
    const p = periodOf(r.year, month);
    (byJur[r.state] ||= new Map()).set(p, {
      count,
      complete: parseFloat(r.percent_complete),
      pending: parseFloat(r.percent_pending_investigation)
    });
  }
  // Recombine New York: state-excluding-NYC + NYC, only where both reported.
  if (byJur.NY && byJur.YC) {
    const ny = new Map();
    for (const [p, a] of byJur.NY) {
      const b = byJur.YC.get(p);
      if (b) ny.set(p, { count: a.count + b.count, complete: Math.min(a.complete, b.complete), pending: Math.max(a.pending, b.pending) });
    }
    byJur.NY = ny;
  } else {
    delete byJur.NY; // cannot form a statewide figure; coverage check will fail loudly
  }

  const pop = Object.fromEntries(STATE_ROWS.map(s => [s.id, s.population]));
  const states = {}, latestById = {}, gaps = new Set();
  let minComplete = 100, maxPending = 0;
  for (const id of STATE_IDS) {
    const m = byJur[id];
    if (!m || !m.size) continue;
    const end = [...m.keys()].sort().at(-1);
    const rate = (c) => Math.round((c / pop[id]) * 100000);
    const obs = new Map([...m].map(([p, x]) => [p, rate(x.count)]));
    const w = windowSeries(obs, end, 24);
    if (w.values.length < 12) continue;
    w.gaps.forEach(g => gaps.add(g));
    latestById[id] = end;
    const last = m.get(end);
    if (Number.isFinite(last.complete)) minComplete = Math.min(minComplete, last.complete);
    if (Number.isFinite(last.pending)) maxPending = Math.max(maxPending, last.pending);
    states[id] = { overdoseRate: obs.get(end), overdoseSeries: w.values, overdosePeriods: w.periods, overdoseSpan: w.span };
  }
  requireAllStates(states, 'CDC');
  const end = requireOnePeriod(latestById, 'CDC');
  const metros = {};
  const yc = byJur.YC && byJur.YC.get(end);
  if (yc && nycPopulation) metros.NYC = { overdoseRate: Math.round((yc.count / nycPopulation) * 100000) };
  return {
    states, metros,
    meta: {
      overdosePeriod: `12 months ending ${monthLabel(end)}`,
      overdoseCompleteness: { minPercentComplete: Math.round(minComplete * 10) / 10, maxPendingPct: Math.round(maxPending * 10) / 10 }
    },
    gaps: { overdose: [...gaps].sort() },
    period: `12 months ending ${monthLabel(end)}`
  };
}

const NCHS_STATE_KEY = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district_of_columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new_hampshire', NJ: 'new_jersey', NM: 'new_mexico', NY: 'new_york',
  NC: 'north_carolina', ND: 'north_dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode_island', SC: 'south_carolina', SD: 'south_dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west_virginia', WI: 'wisconsin', WY: 'wyoming'
};
/** CDC NCHS age-adjusted rates. `rowByField` maps our field -> the newest row for that cause. */
export function parseNCHS(rowByField) {
  const states = {}, quarterByField = {};
  for (const [field, r] of Object.entries(rowByField)) {
    if (!r) throw new Error(`NCHS: no rows for ${field}`);
    quarterByField[field] = r.year_and_quarter;
    for (const [id, key] of Object.entries(NCHS_STATE_KEY)) {
      const v = parseFloat(r['rate_' + key]);
      if (Number.isFinite(v)) (states[id] ||= {})[field] = v;
    }
  }
  const fields = Object.keys(rowByField);
  const incomplete = STATE_IDS.filter(id => !fields.every(f => Number.isFinite(states[id]?.[f])));
  if (incomplete.length) throw new Error(`NCHS: missing a cause for ${incomplete.slice(0, 8).join(',')}`);
  const q = requireOnePeriod(quarterByField, 'NCHS');
  return { states, meta: { nchsPeriod: q }, period: q };
}

// Fields whose values come from a table the source republishes every year.
// History windows: crime starts at 2020, the last year before the FBI's
// reporting-system changeover; income starts at 2019, before the pandemic gap.
export const HISTORY_YEARS = { violentCrime: 6, income: 6 };

/**
 * Census ACS 1-year median household income (table B19013), several vintages.
 * `tables` maps year -> a table whose first row is a header naming the
 * B19013_001E column and either GEO_ID (data.census.gov, '0400000US15') or
 * state (api.census.gov, '15'). A vintage Census never released (2020) is
 * simply absent from `tables` and becomes a declared gap.
 */
export function parseACSIncome(tables, abbrByFips, { years = HISTORY_YEARS.income } = {}) {
  const byId = {};
  for (const [year, rows] of Object.entries(tables || {})) {
    if (!Array.isArray(rows) || rows.length < 2) throw new Error(`Census ${year}: non-tabular response`);
    const head = rows[0], iE = head.indexOf('B19013_001E');
    const iG = head.indexOf('GEO_ID') >= 0 ? head.indexOf('GEO_ID') : head.indexOf('state');
    if (iE < 0 || iG < 0) throw new Error(`Census ${year}: income or geography column missing`);
    for (const r of rows.slice(1)) {
      const id = abbrByFips[String(r[iG]).slice(-2)], v = parseInt(r[iE], 10);
      if (!(id && v > 0)) continue;
      if (byId[id]?.has(String(year))) throw new Error(`Census ${year}: two rows for ${id}`);
      (byId[id] ||= new Map()).set(String(year), v);
    }
  }
  const latestById = {}, states = {}, gaps = new Set();
  for (const [id, m] of Object.entries(byId)) latestById[id] = [...m.keys()].sort().at(-1);
  for (const [id, m] of Object.entries(byId)) {
    const w = yearSeries(m, latestById[id], years);
    w.gaps.forEach(g => gaps.add(g));
    states[id] = { income: m.get(latestById[id]), incomeSeries: w.values, incomePeriods: w.periods };
  }
  requireAllStates(states, 'Census');
  const y = requireOnePeriod(latestById, 'Census');
  return { states, vintages: { income: `ACS ${y}` }, gaps: { income: [...gaps].sort() }, period: `ACS ${y}` };
}

/**
 * FBI estimated crimes by state (the CDE "estimated_crimes_1979_YYYY" table).
 * `rows` are objects with year, state_abbr, state_name, population,
 * violent_crime, property_crime and caveats. Rates are per 100,000 and rounded
 * the way the app shows them, so the chart ends exactly on the headline.
 *
 * The FBI revises earlier years in every release (48 states' 2024 figures moved
 * between the 2024 and 2025 tables), so history always comes from the SAME
 * table as the headline -- never spliced onto an older one.
 */
export function parseFBIEstimates(rows, { years = HISTORY_YEARS.violentCrime } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('FBI: empty estimates table');
  // A row is identified by its state NAME, cross-checked against its
  // abbreviation. The 2025 table files North Dakota's 2022 row under 'NC' (name
  // "North Dakota", population 779,261); trusting the abbreviation overwrote
  // North Carolina's 2022 rate with North Dakota's and left North Dakota with a
  // false gap. A disagreement is reported; a second row for the same state and
  // year fails the source; so does a population out of line with the state's
  // other years.
  const idByName = Object.fromEntries(STATE_ROWS.map(r => [r.name, r.id]));
  const byId = {}, nameById = {}, rawCaveat = {}, popById = {}, warnings = [];
  // Only the history window is read; the table goes back to 1979.
  const maxYear = Math.max(...rows.map(r => Number(String(r.year ?? '').trim())).filter(Number.isFinite));
  const firstYear = maxYear - years + 1;
  for (const r of rows) {
    const abbr = String(r.state_abbr ?? '').trim(), y = String(r.year ?? '').trim();
    if (!(Number(y) >= firstYear)) continue;
    const rawName = String(r.state_name ?? '').trim();
    const named = idByName[rawName.replace(/[\d,]+$/, '').trim()];
    const id = named || (STATE_IDS.includes(abbr) ? abbr : undefined);
    // A blank, null or whitespace cell is missing, not zero (Number(' ') === 0).
    const count = (v) => { const t = String(v ?? '').trim().replace(/,/g, ''); return t === '' ? NaN : Number(t); };
    const pop = count(r.population), vc = count(r.violent_crime), pc = count(r.property_crime);
    if (!id || !/^\d{4}$/.test(y) || !(pop > 0) || !Number.isFinite(vc) || !Number.isFinite(pc)) continue;
    if (named && abbr && abbr !== named) warnings.push(`${y} row labelled ${abbr} is ${rawName.replace(/[\d,]+$/, '').trim()}; filed under ${named}`);
    if (byId[id]?.has(y)) throw new Error(`FBI: two rows for ${id} ${y}`);
    (byId[id] ||= new Map()).set(y, { vc: Math.round((vc / pop) * 100000), pc: Math.round((pc / pop) * 100000) });
    (popById[id] ||= {})[y] = pop;
    (nameById[id] ||= {})[y] = rawName;
    (rawCaveat[id] ||= {})[y] = String(r.caveats ?? '').trim();
  }
  for (const [id, pops] of Object.entries(popById)) {
    const sorted = Object.values(pops).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
    const odd = Object.entries(pops).filter(([, p]) => Math.abs(p / median - 1) > 0.1).map(([y]) => y);
    if (odd.length) throw new Error(`FBI: ${id} population out of line with its other years in ${odd.join(',')}`);
  }
  const latestById = {};
  for (const [id, m] of Object.entries(byId)) latestById[id] = [...m.keys()].sort().at(-1);
  const end = Object.keys(latestById).length ? requireOnePeriod(latestById, 'FBI') : null;

  // Footnotes, latest year only. The FBI marks a state's NAME with a footnote
  // number ("Florida3") and stores the footnote's text, prefixed with that
  // number, in the caveats column of whichever row it lands on ("3 Limited data
  // for 2025 were available for Florida and North Dakota" sits on North
  // Dakota's row). Reading only a state's own caveat cell would show North
  // Dakota's warning and silently drop Florida's.
  const footnote = {}, plain = {};
  for (const id of Object.keys(byId)) {
    const text = rawCaveat[id]?.[end];
    if (!text) continue;
    const m = text.match(/^(\d+)\s+([\s\S]+)$/);
    if (m) footnote[m[1]] = m[2].trim(); else plain[id] = text;
  }
  const notes = {};
  for (const id of Object.keys(byId)) {
    const refs = (nameById[id]?.[end] || '').match(/[A-Za-z.)](\d+(?:,\d+)*)$/)?.[1]?.split(',') || [];
    const texts = [plain[id], ...refs.map(n => footnote[n])].filter(Boolean);
    if (texts.length) notes[id] = [...new Set(texts)].join(' ');
  }

  const states = {}, gaps = new Set();
  for (const [id, m] of Object.entries(byId)) {
    const vcByYear = new Map([...m].map(([y, x]) => [y, x.vc]));
    const w = yearSeries(vcByYear, end, years);
    w.gaps.forEach(g => gaps.add(g));
    const last = m.get(end);
    states[id] = {
      violentCrime: last.vc,
      propertyCrime: last.pc,
      violentCrimeSeries: w.values,
      violentCrimePeriods: w.periods,
      // Always set, so a note from an earlier release cannot survive the merge.
      fbiNote: notes[id]
    };
  }
  requireAllStates(states, 'FBI');
  return {
    states,
    vintages: { violentCrime: `FBI ${end}`, propertyCrime: `FBI ${end}` },
    gaps: { violentCrime: [...gaps].sort() },
    warnings,
    period: `FBI ${end}`
  };
}

/**
 * BLS CPI-U, U.S. city average, all items (CUUR0000SA0), as annual averages.
 * Used only to state income change after inflation. A year counts only when
 * all twelve months were published: BLS never published October 2025, so 2025
 * has no annual figure here rather than an eleven-month one.
 */
export function parseCPI(series) {
  const s = (series || []).find(x => x.seriesID === 'CUUR0000SA0');
  if (!s) throw new Error('CPI: series CUUR0000SA0 missing');
  const byYear = {};
  for (const d of s.data || []) {
    if (!/^M(0[1-9]|1[0-2])$/.test(d.period)) continue;
    const v = parseFloat(d.value);
    if (Number.isFinite(v)) (byYear[d.year] ||= {})[d.period] = v;
  }
  const cpiAnnual = {};
  for (const [y, months] of Object.entries(byYear)) {
    const v = Object.values(months);
    if (v.length === 12) cpiAnnual[y] = Math.round((v.reduce((a, b) => a + b, 0) / 12) * 1000) / 1000;
  }
  const full = Object.keys(cpiAnnual).sort();
  if (full.length < 2) throw new Error('CPI: fewer than two complete years');
  return { meta: { cpiAnnual }, period: `CPI-U ${full[0]}–${full.at(-1)}` };
}

// ---- Orchestration ------------------------------------------------------------
// Fields earlier versions wrote that must not survive into a new overlay.
// ---- Figures that replaced the old unverified estimates (2026-10-13) ----------
// docs/verification-2026-10-13.md has the check that retired the estimates.

const STATE_BY_NAME = Object.fromEntries(STATE_ROWS.map(r => [r.name, r.id]));
export const ppSlug = (name) => name.toLowerCase().replace(/ /g, '-');

/**
 * Planned Parenthood's own health-centre directory: one page per state at
 * plannedparenthood.org/health-center/<slug>, each listing its centres as links
 * health-center/<slug>/<city>/<zip>/<name-and-id>. Entries named "virtual" are
 * telehealth services, counted apart from buildings. No government body
 * publishes this count; the organisation's own list is the primary source.
 * `pages` maps slug -> page HTML; every state must be present.
 */
export function parsePPDirectory(pages, { retrieved }) {
  const states = {};
  let total = 0;
  for (const r of STATE_ROWS) {
    const slug = ppSlug(r.name), html = pages[slug];
    // The page title names its state, so a redirect or an error page cannot pass.
    if (typeof html !== 'string' || !html.includes(`Health Centers - ${r.name} - Planned Parenthood`)) throw new Error(`Planned Parenthood: no directory page for ${r.name}`);
    const links = [...new Set(html.match(new RegExp(`health-center/${slug}/[a-z0-9-]+/[0-9]+/[a-z0-9-]+`, 'g')) || [])];
    const virtual = links.filter(l => /virtual|telehealth|online|-vc-/.test(l)).length;
    states[r.id] = { ppCenters: links.length - virtual, ppVirtual: virtual };
    total += links.length - virtual;
  }
  // The page layout changing would show as a collapse to near zero, not as data.
  if (total < 200 || total > 1000) throw new Error(`Planned Parenthood: ${total} centres in total is implausible; the directory layout may have changed`);
  const label = monthLong(retrieved.slice(0, 7));
  return { states, meta: { ppPeriod: label }, vintages: { ppCenters: `Planned Parenthood directory, ${label}` }, period: label };
}

/**
 * ICE Detention Statistics workbook, "Facilities FYxx" sheet: one row per
 * facility with its average daily population split by classification level
 * (Level A-D, which add up to the facility's ADP). Summed by the facility's
 * state, that is how many people ICE held there on an average day: counted
 * where they are held, not where they were arrested. The sheet leaves out hold
 * rooms, hospitals, hotels, ORR and MIRP sites. `grid` is the sheet as rows of
 * { column letter: value }.
 */
export function parseICEFacilities(grid, { sheetName = '' } = {}) {
  const h = grid.findIndex(r => String(r.A || '').trim() === 'Name' && String(r.D || '').trim() === 'State');
  if (h < 0) throw new Error('ICE: no Name/State header row on the facilities sheet');
  const levels = Object.keys(grid[h]).filter(k => /^Level [A-D]$/.test(String(grid[h][k]).trim()));
  if (levels.length !== 4) throw new Error(`ICE: expected Level A-D columns, found ${levels.length}`);
  const dated = grid.slice(0, h).map(r => String(r.A || '')).find(a => /Data Source/i.test(a))?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  const fy = String(sheetName).match(/FY\s?(\d{2})\b/)?.[1];
  if (!dated || !fy) throw new Error('ICE: could not read the fiscal year or data date');
  // Facilities outside the 51 are counted by ICE but not shown by the app.
  const known = new Set([...STATE_IDS, 'PR', 'GU', 'MP', 'VI', 'AS']);
  const byState = {}, unknown = new Set();
  for (const r of grid.slice(h + 1)) {
    const name = String(r.A || '').trim(), st = String(r.D || '').trim();
    if (!name || !st) continue;
    if (!known.has(st)) { unknown.add(st); continue; }
    // A text cell such as "1,050" must not count as nothing (Argon F7).
    const adp = levels.reduce((a, k) => {
      const raw = String(r[k] ?? '').trim();
      if (!raw) return a;
      const n = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new Error(`ICE: unreadable population "${raw}" at ${name}`);
      return a + n;
    }, 0);
    byState[st] = (byState[st] || 0) + adp;
  }
  if (unknown.size) throw new Error(`ICE: unknown state code ${[...unknown].slice(0, 5).join(', ')}; the sheet may have changed`);
  const states = Object.fromEntries(STATE_IDS.map(id => [id, { iceDetained: Math.round(byState[id] || 0) }]));
  const total = Object.values(states).reduce((a, s) => a + s.iceDetained, 0);
  if (total < 1000 || total > 300000) throw new Error(`ICE: ${total} people held in total is implausible`);
  const [, mm, dd, yyyy] = dated;
  const label = `FY20${fy}, data to ${MON[Number(mm) - 1]} ${Number(dd)}, ${yyyy}`;
  return { states, meta: { icePeriod: label }, vintages: { iceDetained: `ICE ${label}` }, period: label };
}

/**
 * USDA FNS SNAP National Data Bank, one fiscal-year workbook (FYxx.xlsx inside
 * snap-zip-fy69tocurrent). Regional sheets list each state's name on its own
 * row, then its months, then a "Total" row whose column D is the year's benefit
 * cost in dollars. Only a complete year (twelve months for every state) is
 * accepted. `sheets` maps sheet name -> grid.
 */
export function parseSNAPYear(sheets, { fy }) {
  const cost = {}, months = {}, sum = {};
  const num = (v) => Number(String(v ?? '').replace(/,/g, ''));
  for (const grid of Object.values(sheets)) {
    let cur = null;
    for (const r of grid) {
      const a = String(r.A || '').trim();
      if (STATE_BY_NAME[a]) {
        // A second block for a state (a summary or footnote row) is ambiguous: refuse it.
        if (months[STATE_BY_NAME[a]] !== undefined) throw new Error(`SNAP FY${fy}: ${a} appears twice`);
        cur = STATE_BY_NAME[a]; months[cur] = 0; sum[cur] = 0; continue;
      }
      if (!cur) continue;
      // FNS lists all twelve months from the start; unreported ones are blank.
      if (/^[A-Z][a-z]{2} \d{4}$/.test(a) && num(r.D) > 0) { months[cur]++; sum[cur] += num(r.D); }
      else if (a === 'Total') { cost[cur] = num(r.D); cur = null; }
    }
  }
  const missing = STATE_IDS.filter(id => !Number.isFinite(cost[id]) || cost[id] <= 0);
  if (missing.length) throw new Error(`SNAP FY${fy}: no annual total for ${missing.slice(0, 8).join(',')}`);
  const short = STATE_IDS.filter(id => months[id] !== 12);
  if (short.length) throw new Error(`SNAP FY${fy}: not a complete year (${short[0]} has ${months[short[0]]} months)`);
  // The Total row must be the sum of the months, or a column has moved.
  const off = STATE_IDS.filter(id => Number.isFinite(cost[id]) && Math.abs(cost[id] - sum[id]) > 1000);
  if (off.length) throw new Error(`SNAP FY${fy}: the Total for ${off[0]} is not the sum of its months`);
  const states = Object.fromEntries(STATE_IDS.map(id => [id, { snapBenefits: Math.round(cost[id]) }]));
  const label = `FY${fy}`;
  return { states, meta: { snapPeriod: label }, vintages: { snapBenefits: `USDA ${label}` }, period: label };
}

// City median household income, Census ACS 1-year table B19013 at place level
// (Argon F8: the city incomes were hand-entered with no source). `rows` is the
// data.census.gov table for all places; the 12 cities are picked by GEO_ID.
export const PLACE_GEO = {
  NYC: '1600000US3651000', LAX: '1600000US0644000', CHI: '1600000US1714000', HOU: '1600000US4835000',
  PHX: '1600000US0455000', PHL: '1600000US4260000', FTW: '1600000US4827000', SEA: '1600000US5363000',
  DEN: '1600000US0820000', OKC: '1600000US4055000', DET: '1600000US2622000', MEM: '1600000US4748000'
};
export function parseACSCityIncome(rows, { year }) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error(`Census cities ${year}: non-tabular response`);
  const head = rows[0], iE = head.indexOf('B19013_001E'), iG = head.indexOf('GEO_ID');
  if (iE < 0 || iG < 0) throw new Error(`Census cities ${year}: income or geography column missing`);
  const metros = {};
  for (const [id, geo] of Object.entries(PLACE_GEO)) {
    const hits = rows.filter(r => r[iG] === geo);
    if (hits.length !== 1) throw new Error(`Census cities ${year}: ${hits.length ? 'two rows' : 'no row'} for ${id}`);
    const v = parseInt(hits[0][iE], 10);
    if (!(v > 10000 && v < 500000)) throw new Error(`Census cities ${year}: implausible income for ${id}`);
    metros[id] = { income: v };
  }
  const label = `ACS ${year}`;
  return { metros, meta: { cityIncomePeriod: label }, vintages: { cityIncome: label }, period: label };
}

const LEGACY_RECORD_FIELDS = ['confidence'];
const LEGACY_META_FIELDS = ['sources', 'incomeVintage'];

export function seedOverlay(previous = {}) {
  const clean = (bucket) => Object.fromEntries(Object.entries(bucket || {}).map(([id, r]) => {
    const copy = { ...r };
    LEGACY_RECORD_FIELDS.forEach(f => delete copy[f]);
    return [id, copy];
  }));
  const meta = { ...(previous.meta || {}) };
  LEGACY_META_FIELDS.forEach(f => delete meta[f]);
  return { meta, states: clean(previous.states), metros: clean(previous.metros) };
}

export function applyStaged(overlay, staged) {
  const out = structuredClone(overlay);
  for (const bucket of ['states', 'metros']) {
    for (const [id, fields] of Object.entries(staged[bucket] || {})) out[bucket][id] = { ...(out[bucket][id] || {}), ...fields };
  }
  Object.assign(out.meta, staged.meta || {});
  if (staged.vintages) out.meta.vintages = { ...(out.meta.vintages || {}), ...staged.vintages };
  if (staged.gaps) out.meta.seriesGaps = { ...(out.meta.seriesGaps || {}), ...staged.gaps };
  return out;
}

export function buildOutputs(overlay) {
  const full = {
    schema: 2,
    meta: overlay.meta,
    states: mergeRows(STATE_ROWS, overlay.states),
    metros: mergeRows(METRO_ROWS, overlay.metros)
  };
  const liveBaked = '// AUTO-GENERATED by scripts/refresh-data.mjs — do not edit by hand.\n'
    + '// Overlay of live-fetched fields merged over the base data in data.js.\n'
    + 'export default ' + JSON.stringify(overlay, null, 2) + ';\n';
  return { full, files: { 'src/live-baked.js': liveBaked, 'crimestats-data.json': JSON.stringify(full) } };
}

export function validateOutputs(full) {
  const s = validateDataset(full.states, { min: 51, kind: 'state', requireAll: true });
  const m = validateDataset(full.metros, { min: 1, kind: 'metro', requireAll: true });
  const meta = sanitizeMeta(full.meta);
  const labels = seriesVintageProblems(full.states, { ...BASE_VINTAGES, ...full.meta?.vintages });
  return [...s.problems, ...m.problems, ...meta.problems, ...labels];
}

/**
 * Run every source, apply only the ones that fully succeed, and return the
 * finished outputs plus any validation problems. Writes nothing.
 * sources: [{ name, run: async () => staged | { skipped: reason } }]
 */
export async function runRefresh({ sources, previous = {}, now = new Date(), log = () => {}, secrets = [] }) {
  const today = now.toISOString().slice(0, 10);
  // A failure reason is stored in the data (and so in the APK, the repo and the
  // About page). Some APIs quote the key back in their errors -- BLS answers a
  // rejected key with "The key:<key> provided by the User is invalid" -- so
  // every key value is blanked out of a reason before it is kept or printed.
  const keys = secrets.filter(k => typeof k === 'string' && k.length >= 4);
  const redact = (text) => keys.reduce((t, k) => t.split(k).join('[key hidden]'), String(text));
  let overlay = seedOverlay(previous);
  const status = { ...(previous.meta?.sourceStatus || {}) };

  for (const { name, run } of sources) {
    const prev = status[name] || {};
    const carry = { retrieved: prev.retrieved, period: prev.period };
    let staged;
    try {
      staged = await run();
    } catch (e) {
      status[name] = { status: 'failed', attempted: today, ...carry, reason: redact(e.message || e).slice(0, 160) };
      log(`${name}: FAILED — ${status[name].reason}; previous values stand`);
      continue;
    }
    if (staged?.skipped) {
      status[name] = { status: 'skipped', attempted: today, ...carry, reason: redact(staged.skipped) };
      log(`${name}: skipped — ${status[name].reason}`);
      continue;
    }
    // Apply this source alone to a copy and validate before accepting it, so a
    // bad value from one source can neither ship nor block the others.
    const trial = applyStaged(overlay, staged);
    const problems = validateOutputs(buildOutputs(trial).full);
    if (problems.length) {
      status[name] = { status: 'failed', attempted: today, ...carry, reason: `rejected by validation: ${problems[0]}`.slice(0, 160) };
      log(`${name}: REJECTED — ${problems.length} problem(s), e.g. ${problems[0]}`);
      continue;
    }
    overlay = trial;
    status[name] = { status: 'ok', attempted: today, retrieved: today, period: staged.period };
    log(`${name}: ok (${staged.period})`);
    for (const w of staged.warnings || []) log(`${name}: note — ${w}`);
  }

  for (const v of Object.values(status)) for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  overlay.meta.sourceStatus = status;
  const notOk = Object.entries(status).filter(([, s]) => s.status !== 'ok').map(([n]) => n);
  if (notOk.length) overlay.meta.staleSources = notOk; else delete overlay.meta.staleSources;
  // "updated" is the most recent SUCCESSFUL retrieval -- not the date the
  // script happened to run. If every source failed, it does not move.
  const retrieved = Object.values(status).map(s => s.retrieved).filter(Boolean).sort();
  overlay.meta.updated = retrieved.at(-1) || previous.meta?.updated || today;
  overlay.meta.attempted = today;
  overlay.meta.generation = `${today}-${randomBytes(3).toString('hex')}`;

  const outputs = buildOutputs(overlay);
  return { overlay, outputs, status, problems: validateOutputs(outputs.full) };
}

/** Write every file to a temporary, then rename all into place. */
export function commitOutputs(files, root, fs = { writeFileSync, renameSync }) {
  const tmp = Object.keys(files).map(rel => [join(root, rel), `${join(root, rel)}.tmp-${process.pid}`]);
  tmp.forEach(([, t], i) => fs.writeFileSync(t, Object.values(files)[i]));
  tmp.forEach(([final, t]) => fs.renameSync(t, final));
}

/**
 * The whole transaction: refresh, then write both files only if the finished
 * dataset validates. Returns the runRefresh result plus { written }.
 */
export async function refreshAndCommit({ root, fs, ...opts }) {
  const result = await runRefresh(opts);
  if (result.problems.length) return { ...result, written: false };
  commitOutputs(result.outputs.files, root, fs);
  return { ...result, written: true };
}
