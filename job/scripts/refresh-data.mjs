#!/usr/bin/env node
// CrimeStats USA — live data refresh.
//
// Fetches from public APIs and, only if the finished dataset validates, writes:
//   src/live-baked.js       overlay baked into the next app build
//   crimestats-data.json    full dataset for tier-2 (OTA) hosting
//
// All the logic that decides what is accepted lives in refresh-core.mjs, which is
// network-free and tested. This file only fetches raw payloads and hands them over.
//
// Every source is keyless: BLS LAUS and CPI, CDC VSRR, CDC NCHS, Census ACS
// (through data.census.gov) and the FBI's estimated-crimes table (through the
// Crime Data Explorer's download service). BLS_API_KEY, if present, only makes
// the BLS requests larger. Keys load from <project>/.env and never enter the APK.
//
// Census and FBI were long recorded as needing keys. They do on their
// documented APIs (api.census.gov; api.usa.gov/crime/fbi/cde, whose state
// estimate endpoint now returns 404). The routes used here are the ones the
// agencies' own websites use -- official data, but undocumented, so a change on
// their side shows up as a FAILED source in the About page, never as bad data.
//
// Usage: node scripts/refresh-data.mjs [--snapshot] [--ice-file <workbook.xlsx>]
//   --snapshot  also rewrite tests/fixtures/ from the same payloads, so the
//               source-table checks follow a new FBI or Census release.
//   --ice-file  read ICE's detention statistics from a workbook you downloaded
//               in a browser. ice.gov refuses many scripted downloads (HTTP
//               403), and then the ICE source fails and its old values stand.

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { METRO_ROWS, STATE_ROWS } from '../src/data.js';
import {
  parseBLS, parseCDC, parseNCHS, parseACSIncome, parseFBIEstimates, parseCPI, HISTORY_YEARS, refreshAndCommit,
  parsePPDirectory, parseICEFacilities, parseSNAPYear, ppSlug
} from './refresh-core.mjs';
import { readFirstSheet, readSheetGrid, sheetNames, unzip } from './xlsx-lite.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\S+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11',
  FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21',
  LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30',
  NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
  VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56'
};
const ABBR_BY_FIPS = Object.fromEntries(Object.entries(FIPS).map(([a, f]) => [f, a]));
const raw = {};   // payloads kept for --snapshot
const year = new Date().getFullYear();
const getJSON = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch {
    const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    throw new Error(`${new URL(url).host} returned non-JSON (HTTP ${res.status}, ${res.url.split('?')[0]}): ${snippet}`);
  }
};

// ---- Sources: fetch raw payloads, let the core decide ---------------------------
// Says plainly whether the user's key was picked up (API-KEYS.md step 4).
const BLS_KEY = process.env.BLS_API_KEY;
console.log(BLS_KEY ? 'BLS: using BLS_API_KEY from .env (API v2)' : 'BLS: no BLS_API_KEY (keyless API v1, 25 requests a day)');

async function bls() {
  const key = BLS_KEY;
  const ids = Object.fromEntries(Object.entries(FIPS).map(([abbr, f]) => [`LASST${f}0000000000003`, abbr]));
  const all = Object.keys(ids), size = key ? 50 : 10, series = [];
  const url = `https://api.bls.gov/publicAPI/${key ? 'v2' : 'v1'}/timeseries/data/`;
  for (let i = 0; i < all.length; i += size) {
    const body = { seriesid: all.slice(i, i + size), startyear: String(year - 2), endyear: String(year) };
    if (key) body.registrationkey = key;
    const json = await getJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // Any failed batch fails the whole source: nothing from earlier batches is kept.
    if (json.status !== 'REQUEST_SUCCEEDED') throw new Error('BLS batch rejected: ' + JSON.stringify(json.message).slice(0, 100));
    series.push(...json.Results.series);
  }
  return parseBLS(series, ids);
}

async function cdc() {
  const url = 'https://data.cdc.gov/resource/xkb8-kh2a.json'
    + '?indicator=' + encodeURIComponent('Number of Drug Overdose Deaths')
    + '&$where=' + encodeURIComponent(`year >= '${year - 3}'`)
    + '&$limit=50000';
  const nyc = METRO_ROWS.find(m => m.id === 'NYC');
  return parseCDC(await getJSON(url), { nycPopulation: nyc?.population });
}

const NCHS_CAUSES = { firearmRate: 'Firearm-related injury', suicideRate: 'Suicide', homicideRate: 'Homicide' };
async function nchs() {
  const rowByField = {};
  for (const [field, cause] of Object.entries(NCHS_CAUSES)) {
    const url = 'https://data.cdc.gov/resource/489q-934x.json'
      + '?cause_of_death=' + encodeURIComponent(cause)
      + '&rate_type=' + encodeURIComponent('Age-adjusted')
      + '&time_period=' + encodeURIComponent('12 months ending with quarter')
      // newest quarters publish national figures before state breakdowns
      + '&$where=' + encodeURIComponent('rate_alabama IS NOT NULL')
      + '&$order=year_and_quarter DESC&$limit=1';
    rowByField[field] = (await getJSON(url))?.[0];
  }
  return parseNCHS(rowByField);
}

async function cpi() {
  // Uses the key too: CPI went through keyless v1 even with a key, spending the
  // 25-a-day allowance the key was meant to lift.
  const body = { seriesid: ['CUUR0000SA0'], startyear: String(year - 8), endyear: String(year) };
  if (BLS_KEY) body.registrationkey = BLS_KEY;
  const json = await getJSON(`https://api.bls.gov/publicAPI/${BLS_KEY ? 'v2' : 'v1'}/timeseries/data/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (json.status !== 'REQUEST_SUCCEEDED') throw new Error('BLS CPI rejected: ' + JSON.stringify(json.message).slice(0, 100));
  raw.cpi = json.Results.series;
  return parseCPI(json.Results.series);
}

// data.census.gov's table API: the same ACS 1-year tables as api.census.gov,
// without a key. Verified 2026-10-01: its 2023 values equal the published ACS
// brief (tests/fixtures/acs2023-income.json) for all 51 jurisdictions.
async function census() {
  const tableURL = (y) => `https://data.census.gov/api/access/data/table?id=ACSDT1Y${y}.B19013&g=010XX00US$0400000`;
  const fetchYear = async (y) => {
    const res = await fetch(tableURL(y));
    const json = await res.json().catch(() => null);
    // An unreleased vintage (2020, or this year's before September) is a 400
    // "There is no table" -- absent, not an error. Anything else fails the source.
    if (res.status === 400 && /no table/i.test(json?.description || '')) return null;
    if (!res.ok || !Array.isArray(json?.response?.data)) throw new Error(`data.census.gov ${y}: HTTP ${res.status}`);
    return json.response.data;
  };
  const tables = {};
  let latest = null;
  for (const y of [year - 1, year - 2, year - 3]) {
    const t = await fetchYear(y);
    if (t) { tables[y] = t; latest = y; break; }
  }
  if (!latest) throw new Error('no ACS 1-year vintage found in the last three years');
  for (let y = latest - HISTORY_YEARS.income + 1; y < latest; y++) {
    const t = await fetchYear(y);
    if (t) tables[y] = t;
  }
  raw.acs = tables;
  return parseACSIncome(tables, ABBR_BY_FIPS);
}

// The FBI's state estimates, as published on the CDE downloads page. The file
// name carries the latest data year, so it is read from the page's catalogue
// rather than guessed. The ".csv" is really an .xlsx workbook.
async function fbi() {
  const CDE = 'https://cde.ucr.cjis.gov/LATEST';
  const catalogue = await (await fetch(`${CDE}/webapp/assets/JSON/downloads/downloads.json`)).text();
  const keys = [...new Set(catalogue.match(/additional-datasets\/srs\/estimated_crimes_1979_\d{4}\.csv/g) || [])].sort();
  if (!keys.length) throw new Error('CDE catalogue no longer lists estimated_crimes_1979_YYYY.csv');
  const key = keys.at(-1);
  const signed = await getJSON(`${CDE}/s3/signedurl?key=${encodeURIComponent(key)}`);
  if (!signed?.[key]) throw new Error(`CDE would not sign ${key}`);
  const res = await fetch(signed[key]);
  if (!res.ok) throw new Error(`estimated crimes download: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const rows = readFirstSheet(buf);
  raw.fbi = { key, sha256: createHash('sha256').update(buf).digest('hex'), rows };
  return parseFBIEstimates(rows);
}

// Sites that turn away non-browser clients get a browser's user agent.
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

// Planned Parenthood's directory, one page per state, fetched slowly.
async function pp() {
  const pages = {};
  for (const r of STATE_ROWS) {
    const slug = ppSlug(r.name);
    const res = await fetch(`https://www.plannedparenthood.org/health-center/${slug}`, { headers: BROWSER });
    if (!res.ok) throw new Error(`plannedparenthood.org/${slug}: HTTP ${res.status}`);
    pages[slug] = await res.text();
    await sleep(800);
  }
  return parsePPDirectory(pages, { retrieved: today });
}

// ICE's detention statistics: the newest fiscal-year workbook linked from the
// detention-management page, or a workbook given with --ice-file.
async function ice() {
  const i = process.argv.indexOf('--ice-file');
  let buf;
  if (i > 0 && process.argv[i + 1]) buf = readFileSync(process.argv[i + 1]);
  else {
    const page = await fetch('https://www.ice.gov/detain/detention-management', { headers: BROWSER });
    if (!page.ok) throw new Error(`ice.gov refused the statistics page (HTTP ${page.status}); download the workbook in a browser and pass --ice-file`);
    const links = [...new Set((await page.text()).match(/\/doclib\/detention\/FY\d{2}_detentionStats\d*\.xlsx/g) || [])];
    const newest = links.sort((a, b) => a.match(/FY(\d{2})/)[1] - b.match(/FY(\d{2})/)[1]).at(-1);
    if (!newest) throw new Error('ice.gov no longer links an FYxx_detentionStats workbook');
    const res = await fetch(`https://www.ice.gov${newest}`, { headers: BROWSER });
    if (!res.ok) throw new Error(`ice.gov refused ${newest.split('/').pop()} (HTTP ${res.status}); pass --ice-file`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  const sheetName = sheetNames(buf).find(n => /^\s*Facilities FY\d{2}/.test(n));
  if (!sheetName) throw new Error('ICE workbook has no "Facilities FYxx" sheet');
  return parseICEFacilities(readSheetGrid(buf, sheetName), { sheetName });
}

// USDA's SNAP National Data Bank: the newest complete fiscal year.
async function snap() {
  const res = await fetch('https://www.fns.usda.gov/sites/default/files/resource-files/snap-zip-fy69tocurrent-9.zip', { headers: BROWSER });
  if (!res.ok) throw new Error(`fns.usda.gov SNAP archive: HTTP ${res.status}`);
  const zip = unzip(Buffer.from(await res.arrayBuffer()));
  const years = Object.keys(zip).filter(n => /^FY\d{2}\.xlsx$/.test(n)).sort().reverse();
  let lastErr;
  for (const name of years.slice(0, 2)) {   // the newest year is usually still partial
    const buf = zip[name];
    const sheets = Object.fromEntries(sheetNames(buf).filter(n => /RO$/.test(n.trim())).map(n => [n, readSheetGrid(buf, n)]));
    try { return parseSNAPYear(sheets, { fy: `20${name.slice(2, 4)}` }); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('SNAP archive has no fiscal-year workbooks');
}

function writeSnapshot(today) {
  const fx = (name) => join(ROOT, 'tests/fixtures', name);
  if (raw.fbi) {
    const cols = ['year', 'state_abbr', 'state_name', 'population', 'violent_crime', 'property_crime', 'caveats'];
    const last = Math.max(...raw.fbi.rows.map(r => Number(r.year)).filter(Number.isFinite));
    const keep = raw.fbi.rows.filter(r => Number(r.year) > last - HISTORY_YEARS.violentCrime - 1);
    const q = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    writeFileSync(fx('fbi-estimated-crimes.csv'), [
      `# FBI Crime Data Explorer, "${raw.fbi.key.split('/').pop()}" (Summary Reporting System estimates).`,
      `# Downloaded ${today} via https://cde.ucr.cjis.gov/LATEST/s3/signedurl?key=${raw.fbi.key}`,
      `# The download is an .xlsx workbook despite its name; sha256 of that file: ${raw.fbi.sha256}`,
      `# Trimmed to ${last - HISTORY_YEARS.violentCrime}-${last} and to the columns the app uses. Rows are otherwise verbatim, including the`,
      '# footnote markers the FBI appends to state names ("Florida3") and the numbered caveats they refer to.',
      cols.join(','), ...keep.map(r => cols.map(c => q(String(r[c] ?? ''))).join(','))
    ].join('\n') + '\n');
  }
  if (raw.acs) writeFileSync(fx('acs1-b19013.json'), JSON.stringify({
    source: "U.S. Census Bureau, ACS 1-year table B19013 (median household income in the past 12 months, in that year's dollars), states",
    url: 'https://data.census.gov/api/access/data/table?id=ACSDT1Y{YEAR}.B19013&g=010XX00US$0400000',
    retrieved: today,
    note: 'Verbatim response.data tables. A year Census did not release (2020) is absent. Includes Puerto Rico, which the app ignores.',
    tables: raw.acs
  }));
  if (raw.cpi) writeFileSync(fx('bls-cpi-u.json'), JSON.stringify({
    source: 'BLS CPI-U, U.S. city average, all items, not seasonally adjusted (CUUR0000SA0), public API v1',
    retrieved: today,
    // Independent of this script's arithmetic: annual averages as BLS prints them.
    published_annual_averages: { 2019: 255.657, 2024: 313.689 },
    series: raw.cpi
  }));
  console.log(`snapshot: rewrote tests/fixtures for ${Object.keys(raw).join(', ') || 'nothing (no yearly source succeeded)'}`);
}

// ---- Run ------------------------------------------------------------------------
let previous = {};
try { previous = (await import('../src/live-baked.js')).default || {}; } catch { /* first run */ }

const { outputs, status, problems, written } = await refreshAndCommit({
  root: ROOT,
  sources: [
    { name: 'BLS', run: bls }, { name: 'CDC', run: cdc }, { name: 'NCHS', run: nchs },
    { name: 'Census', run: census }, { name: 'FBI', run: fbi }, { name: 'CPI', run: cpi },
    { name: 'PP', run: pp }, { name: 'ICE', run: ice }, { name: 'SNAP', run: snap }
  ],
  previous,
  // Never let a key reach the stored failure reasons (see runRefresh).
  secrets: ['BLS_API_KEY', 'BEA_API_KEY', 'HUD_API_TOKEN', 'CENSUS_API_KEY', 'FBI_API_KEY'].map(k => process.env[k]),
  log: (msg) => console.log(msg)
});

const notOk = Object.entries(status).filter(([, s]) => s.status !== 'ok');
if (notOk.length) {
  console.log('\nNot refreshed this run (previous values stand):');
  for (const [n, s] of notOk) console.log(`  ${n}: ${s.status} — ${s.reason}${s.retrieved ? ` (last good ${s.retrieved})` : ''}`);
}

if (!written) {
  console.error(`\nVALIDATION FAILED — ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 20)) console.error('  - ' + p);
  console.error('\nNothing was written. Both output files are unchanged.');
  process.exit(1);
}
console.log(`\nwrote src/live-baked.js and crimestats-data.json atomically (generation ${outputs.full.meta.generation})`);
if (process.argv.includes('--snapshot')) writeSnapshot(new Date().toISOString().slice(0, 10));
console.log(`validated: ${outputs.full.states.length} states + ${outputs.full.metros.length} metros`);
