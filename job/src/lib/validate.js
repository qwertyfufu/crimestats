/**
 * Runtime validation for location records and dataset metadata.
 *
 * Static types cannot help here: the real data defects this project has hit —
 * property-crime values that were silently wrong, NaN/null leaking out of a BLS
 * response — all arrived as correctly *shaped* JSON. These checks run against
 * actual values, at the boundaries where untrusted data enters: the refresh
 * script's output and the OTA fetch/cache.
 *
 * Coverage rule: every field the app renders is checked here. An optional field
 * may be absent, but if it is present it must be the right type and in range —
 * an object where the detail view expects a number throws during render, and an
 * empty or partial welfare block crashes `.toLocaleString()`.
 */

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inRange = (lo, hi) => (v) => isFiniteNum(v) && v >= lo && v <= hi;

// The jurisdictions the app knows how to draw. A remote payload of fifty
// arbitrary unique ids must not count as "all states covered".
export const STATE_IDS = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
]);
export const METRO_IDS = Object.freeze(['NYC', 'LAX', 'CHI', 'HOU', 'PHX', 'PHL', 'FTW', 'SEA', 'DEN', 'OKC', 'DET', 'MEM']);
const KNOWN = { state: new Set(STATE_IDS), metro: new Set(METRO_IDS) };

const REQUIRED = [
  { field: 'id', test: (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4, msg: 'id must be a 2-4 char code' },
  { field: 'name', test: (v) => typeof v === 'string' && v.length > 1, msg: 'name must be a non-empty string' },
  { field: 'population', test: (v) => isFiniteNum(v) && v > 1000, msg: 'population must be a number > 1000' },
  { field: 'political', test: (v) => v === 'Red' || v === 'Blue', msg: "political must be 'Red' or 'Blue'" },
  { field: 'violentCrime', test: inRange(0, 10000), msg: 'violentCrime must be 0-10000 per 100k' },
  { field: 'propertyCrime', test: inRange(0, 20000), msg: 'propertyCrime must be 0-20000 per 100k' },
  { field: 'income', test: (v) => isFiniteNum(v) && v > 10000 && v < 500000, msg: 'income must be a plausible median' },
  {
    field: 'demographics',
    test: (v) => isPlainObject(v) && Object.keys(v).length > 0 && Object.values(v).every(inRange(0, 100)),
    msg: 'demographics must be a non-empty object of 0-100 shares'
  }
];

// Optional scalars: absent is fine, present must be a number in range.
const OPTIONAL_NUMBERS = {
  unemployment: inRange(0, 50),
  overdoseRate: inRange(0, 500),
  poverty: inRange(0, 100),
  urbanPct: inRange(0, 100),
  education: inRange(0, 100),
  homicideRate: inRange(0, 200),
  firearmRate: inRange(0, 200),
  suicideRate: inRange(0, 200),
  margin2024: inRange(-100, 100),
  // Unverified estimates (no source), shown only behind the switch:
  ppClinics: inRange(0, 100000),
  iceDetainers: inRange(0, 1e7),
  // Their sourced replacements (docs/verification-2026-10-13.md):
  ppCenters: (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
  ppVirtual: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  iceDetained: (v) => Number.isInteger(v) && v >= 0 && v <= 1e6,
  snapBenefits: inRange(0, 1e11)
};

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;
// Each series carries its own period per value (YYYY-MM monthly, YYYY yearly),
// so a period the source never published shows as a gap instead of being
// silently closed up. `headline` is the field shown above the chart: the
// series must END on that exact value, or the card would print one number and
// draw a line to another.
const SERIES = [
  { values: 'unemploymentSeries', periods: 'unemploymentPeriods', span: 'unemploymentSpan', format: PERIOD, range: inRange(0, 50), headline: 'unemployment' },
  { values: 'overdoseSeries', periods: 'overdosePeriods', span: 'overdoseSpan', format: PERIOD, range: inRange(0, 500), headline: 'overdoseRate' },
  { values: 'violentCrimeSeries', periods: 'violentCrimePeriods', format: YEAR, range: inRange(0, 10000), headline: 'violentCrime' },
  { values: 'incomeSeries', periods: 'incomePeriods', format: YEAR, range: (v) => isFiniteNum(v) && v > 10000 && v < 500000, headline: 'income' }
];

// Optional short strings: absent is fine, present must be a modest string.
const OPTIONAL_STRINGS = { fbiNote: 400 };

const validWelfare = (w) => isPlainObject(w)
  && isFiniteNum(w.total) && w.total >= 0
  && isFiniteNum(w.perCapita) && w.perCapita >= 0
  && isPlainObject(w.breakdown) && Object.keys(w.breakdown).length > 0
  && Object.values(w.breakdown).every(inRange(0, 100));

/**
 * Returns an array of human-readable problems; empty means the record is usable.
 * Pass { kind: 'state' | 'metro' } to also require a known jurisdiction id.
 */
export function validateRecord(rec, { kind } = {}) {
  if (!isPlainObject(rec)) return ['record is not an object'];
  const id = typeof rec.id === 'string' ? rec.id : '?';
  const problems = [];
  const bad = (field, msg) => problems.push(`${id}.${field}: ${msg} (got ${JSON.stringify(rec[field])?.slice(0, 60)})`);

  for (const { field, test, msg } of REQUIRED) if (!test(rec[field])) bad(field, msg);
  if (kind && KNOWN[kind] && !KNOWN[kind].has(rec.id)) bad('id', `not a known ${kind}`);

  for (const [field, test] of Object.entries(OPTIONAL_NUMBERS)) {
    if (rec[field] !== undefined && rec[field] !== null && !test(rec[field])) bad(field, 'must be a number in range');
  }

  for (const [field, max] of Object.entries(OPTIONAL_STRINGS)) {
    if (rec[field] !== undefined && rec[field] !== null && !(typeof rec[field] === 'string' && rec[field].length <= max)) bad(field, `must be a string of at most ${max} characters`);
  }

  for (const { values, periods, span, format, range, headline } of SERIES) {
    const v = rec[values];
    if (v !== undefined) {
      // A single non-finite value draws a false plunge to zero; reject the series.
      if (!Array.isArray(v)) bad(values, 'must be an array');
      else if (!v.every(isFiniteNum)) bad(values, 'contains non-finite values');
      else if (!v.every(range)) bad(values, 'contains a value out of range');
      else if (v.length && rec[headline] !== v[v.length - 1]) bad(values, `must end on the ${headline} shown above it (${rec[headline]})`);
    }
    const p = rec[periods];
    if (p !== undefined) {
      if (!Array.isArray(p) || !p.every(x => typeof x === 'string' && format.test(x))) bad(periods, `must be ${format === YEAR ? 'YYYY' : 'YYYY-MM'} strings`);
      else if (!Array.isArray(v) || p.length !== v.length) bad(periods, `must have one period per value (${p.length} vs ${Array.isArray(v) ? v.length : 'none'})`);
      else if (p.some((x, i) => i > 0 && x <= p[i - 1])) bad(periods, 'must be strictly increasing');
    }
    const s = rec[span];
    if (s !== undefined && !(Array.isArray(s) && s.length === 2 && s.every(x => typeof x === 'string'))) bad(span, 'must be two labels');
  }

  if (rec.welfare !== undefined && rec.welfare !== null && !validWelfare(rec.welfare)) bad('welfare', 'must have numeric total, perCapita and breakdown');
  return problems;
}

/**
 * Validates a whole dataset. Returns { records, problems } — invalid records are
 * dropped so one bad row cannot poison the app. Duplicate ids keep the first.
 * With { requireAll: true } and a kind, every known id must survive validation.
 */
export function validateDataset(records, { min = 1, kind, requireAll = false } = {}) {
  if (!Array.isArray(records)) return { records: [], problems: ['dataset is not an array'] };
  const problems = [];
  const seen = new Set();
  const good = records.filter((rec) => {
    const p = validateRecord(rec, { kind });
    problems.push(...p);
    if (p.length) return false;
    if (seen.has(rec.id)) { problems.push(`${rec.id}: duplicate id`); return false; }
    seen.add(rec.id);
    return true;
  });
  if (good.length < min) problems.push(`only ${good.length} valid records, expected at least ${min}`);
  if (requireAll && kind && KNOWN[kind]) {
    const missing = [...KNOWN[kind]].filter(x => !seen.has(x));
    if (missing.length) problems.push(`missing ${kind}s: ${missing.join(',')}`);
  }
  return { records: good, problems };
}

/**
 * A yearly history must end in the year its label names: a payload that kept
 * "ACS 2024" but shifted the periods back a year would pair the wrong CPI years
 * and print a wrong after-inflation change under a correct-looking label.
 * Returns problems; empty means every state's history agrees with `vintages`.
 */
export const SERIES_VINTAGE = { violentCrimePeriods: 'violentCrime', incomePeriods: 'income' };
export function seriesVintageProblems(states, vintages = {}) {
  const problems = [];
  for (const [periods, metric] of Object.entries(SERIES_VINTAGE)) {
    const year = String(vintages[metric] ?? '').match(/\b(\d{4})\b/)?.[1];
    for (const s of states || []) {
      const p = s?.[periods];
      if (Array.isArray(p) && p.length && p[p.length - 1] !== year) problems.push(`${s.id}.${periods}: ends ${p[p.length - 1]} but is labelled ${vintages[metric] ?? '(no label)'}`);
    }
  }
  return problems;
}

// ---- Metadata --------------------------------------------------------------
// Metadata is rendered in the About page and the share stamp, so it is
// sanitized field by field: only known keys of the right type survive.
const META_STRINGS = ['unemploymentPeriod', 'overdosePeriod', 'nchsPeriod', 'ppPeriod', 'icePeriod', 'snapPeriod', 'updated', 'attempted', 'generation', 'sources', 'incomeVintage'];
const STATUS = new Set(['ok', 'failed', 'skipped']);

export function sanitizeMeta(meta) {
  const out = {};
  const problems = [];
  if (!isPlainObject(meta)) return { meta: out, problems: ['meta is not an object'] };
  for (const k of META_STRINGS) {
    if (meta[k] === undefined) continue;
    if (typeof meta[k] === 'string' && meta[k].length < 200) out[k] = meta[k];
    else problems.push(`meta.${k}: must be a short string`);
  }
  if (meta.staleSources !== undefined) {
    if (Array.isArray(meta.staleSources) && meta.staleSources.every(x => typeof x === 'string')) out.staleSources = meta.staleSources;
    else problems.push('meta.staleSources: must be an array of strings');
  }
  if (meta.vintages !== undefined) {
    if (isPlainObject(meta.vintages) && Object.values(meta.vintages).every(x => typeof x === 'string')) out.vintages = meta.vintages;
    else problems.push('meta.vintages: must map metric -> label');
  }
  if (meta.sourceStatus !== undefined) {
    const ok = isPlainObject(meta.sourceStatus) && Object.values(meta.sourceStatus).every(s => isPlainObject(s)
      && STATUS.has(s.status)
      && ['period', 'retrieved', 'attempted', 'reason'].every(k => s[k] === undefined || typeof s[k] === 'string'));
    if (ok) out.sourceStatus = meta.sourceStatus;
    else problems.push('meta.sourceStatus: malformed');
  }
  if (meta.seriesGaps !== undefined) {
    const g = meta.seriesGaps;
    if (isPlainObject(g) && Object.values(g).every(a => Array.isArray(a) && a.every(x => typeof x === 'string' && (PERIOD.test(x) || YEAR.test(x))))) out.seriesGaps = g;
    else problems.push('meta.seriesGaps: must map series -> YYYY-MM or YYYY list');
  }
  if (meta.cpiAnnual !== undefined) {
    const c = meta.cpiAnnual;
    if (isPlainObject(c) && Object.keys(c).length > 0 && Object.entries(c).every(([y, v]) => YEAR.test(y) && inRange(50, 2000)(v))) out.cpiAnnual = c;
    else problems.push('meta.cpiAnnual: must map YYYY -> index value');
  }
  if (meta.overdoseCompleteness !== undefined) {
    const c = meta.overdoseCompleteness;
    if (isPlainObject(c) && inRange(0, 100)(c.minPercentComplete) && inRange(0, 100)(c.maxPendingPct)) out.overdoseCompleteness = c;
    else problems.push('meta.overdoseCompleteness: malformed');
  }
  return { meta: out, problems };
}
