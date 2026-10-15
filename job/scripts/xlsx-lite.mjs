// Minimal .xlsx reader: enough to read plain tables out of a workbook.
//
// The FBI publishes its state estimates as `estimated_crimes_1979_YYYY.csv`,
// but the file is actually an Excel workbook (a zip of XML). ICE and USDA
// publish workbooks with several sheets. This reads them with node's zlib alone
// rather than adding a spreadsheet dependency. Supports stored and deflated
// entries, shared strings and inline strings; formulas and dates are out of
// scope and unneeded (cached values are read as strings).

import { inflateRawSync } from 'zlib';

/** Map of entry name -> Buffer for every file in a zip archive. */
export function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = inflateRawSync(raw);
    else throw new Error(`zip entry ${name}: unsupported compression method ${method}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');
// Phonetic runs (<rPh>, East Asian reading aids) are not part of the cell's text.
const textOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join('');

const sharedStrings = (files) => files['xl/sharedStrings.xml']
  ? [...files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]))
  : [];

// One worksheet's XML as rows of { column letter: string value }.
function gridOf(xml, shared) {
  const grid = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // Attributes may come in any order (`<c t="s" r="B2">` is valid).
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, attrs, body = ''] = c;
      const col = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      if (!col) continue;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      cells[col] = type === 's' ? shared[Number(v)] ?? ''
        : type === 'inlineStr' ? textOf(body)
        : v !== undefined ? unescapeXml(v) : '';
    }
    grid.push(cells);
  }
  return grid;
}

// Worksheet names in workbook order, each with its file inside the zip.
function sheetFiles(files) {
  const wb = files['xl/workbook.xml']?.toString('utf8') || '';
  const rels = files['xl/_rels/workbook.xml.rels']?.toString('utf8') || '';
  const target = Object.fromEntries([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(m => [
    m[1].match(/\bId="([^"]+)"/)?.[1], m[1].match(/\bTarget="([^"]+)"/)?.[1]
  ]));
  return [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m => {
    const name = unescapeXml(m[1].match(/\bname="([^"]*)"/)?.[1] || '');
    const t = target[m[1].match(/\br:id="([^"]+)"/)?.[1]] || '';
    return { name, file: t.startsWith('/') ? t.slice(1) : t.startsWith('xl/') ? t : `xl/${t}` };
  });
}

/** Names of the workbook's worksheets, in order. */
export const sheetNames = (buf) => sheetFiles(unzip(buf)).map(s => s.name);

/**
 * Rows of one named worksheet as { column letter: value } (names compare
 * trimmed; `match` may also be a RegExp). Throws if no sheet matches.
 */
export function readSheetGrid(buf, match) {
  const files = unzip(buf);
  const want = (n) => match instanceof RegExp ? match.test(n) : n.trim() === String(match).trim();
  const sheet = sheetFiles(files).find(s => want(s.name));
  if (!sheet || !files[sheet.file]) throw new Error(`workbook has no sheet ${match}`);
  return gridOf(files[sheet.file].toString('utf8'), sharedStrings(files));
}

/**
 * Rows of the workbook's first worksheet as objects keyed by the header row.
 * Missing cells are ''. Values are strings; the caller converts numbers.
 */
export function readFirstSheet(buf) {
  const files = unzip(buf);
  const sheetName = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))[0];
  if (!sheetName) throw new Error('workbook has no worksheet');
  const grid = gridOf(files[sheetName].toString('utf8'), sharedStrings(files));
  if (!grid.length) return [];
  const header = grid[0];
  const cols = Object.keys(header);
  return grid.slice(1).map(cells => Object.fromEntries(cols.map(col => [String(header[col]).trim(), cells[col] ?? ''])));
}
