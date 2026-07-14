// Minimal, dependency-free .xlsx reader — enough to pull rows out of an Excel workbook without adding
// SheetJS (which ships a high-severity advisory on npm) or any other package. An .xlsx is a ZIP of
// XML parts; we inflate the parts we need (sharedStrings + each worksheet) with Node's built-in zlib
// and parse the cells with small regexes. Values come back as strings/numbers/booleans; DATE cells are
// numeric serials — the caller converts the columns it knows are dates via serialToISODate().
const fs = require('fs');
const zlib = require('zlib');

// --- read the ZIP central directory and inflate each entry ---
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a .xlsx (zip end-of-central-directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const dir = [];
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    dir.push({ name, method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const files = {};
  for (const e of dir) {
    if (buf.readUInt32LE(e.localOff) !== 0x04034b50) continue;
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const comp = buf.subarray(start, start + e.compSize);
    files[e.name] = e.method === 0 ? comp : zlib.inflateRawSync(comp);
  }
  return files;
}

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let t = '', tm; const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    while ((tm = tRe.exec(m[1]))) t += tm[1];
    out.push(unescapeXml(t));
  }
  return out;
}

const colIndex = (ref) => {
  let n = 0; for (const ch of ref.replace(/[0-9]+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// worksheet XML -> array of rows (each a sparse array of cell values)
function parseSheet(xml, strs) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || '', body = cm[2] || '';
      const refM = attrs.match(/r="([A-Z]+)\d+"/); if (!refM) continue;
      const ci = colIndex(refM[1]);
      const t = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
      let val = null;
      if (t === 'inlineStr') { const im = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/); val = im ? unescapeXml(im[1]) : ''; }
      else {
        const vm = body.match(/<v>([\s\S]*?)<\/v>/); const raw = vm ? vm[1] : null;
        if (raw == null) val = null;
        else if (t === 's') val = strs[Number(raw)] ?? '';
        else if (t === 'str') val = unescapeXml(raw);
        else if (t === 'b') val = raw === '1';
        else val = Number(raw);
      }
      cells[ci] = val;
    }
    rows.push(cells);
  }
  return rows;
}

// Excel serial date -> 'YYYY-MM-DD' (1900 date system; epoch 1899-12-30 handles the 1900 leap quirk).
function serialToISODate(serial) {
  if (serial == null || serial === '') return null;
  if (typeof serial === 'string') { const d = new Date(serial); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  const ms = Date.UTC(1899, 11, 30) + Math.round(Number(serial)) * 86400000;
  const d = new Date(ms);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Read a workbook -> { sheetNames:[...], sheets: { name: rows[][] } }
function readWorkbook(pathOrBuf) {
  const buf = Buffer.isBuffer(pathOrBuf) ? pathOrBuf : fs.readFileSync(pathOrBuf);
  const files = unzip(buf);
  const strs = sharedStrings(files['xl/sharedStrings.xml'] && files['xl/sharedStrings.xml'].toString('utf8'));
  // map sheet name -> r:id via workbook.xml, then r:id -> target via workbook.xml.rels
  const wb = (files['xl/workbook.xml'] || Buffer.from('')).toString('utf8');
  const rels = (files['xl/_rels/workbook.xml.rels'] || Buffer.from('')).toString('utf8');
  const relMap = {};
  let rm; const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  while ((rm = relRe.exec(rels))) relMap[rm[1]] = rm[2].replace(/^\/?xl\//, '').replace(/^\//, '');
  const sheetNames = [], sheets = {};
  let sm; const shRe = /<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g;
  while ((sm = shRe.exec(wb))) {
    const name = unescapeXml(sm[1]);
    const target = relMap[sm[2]];
    const key = target && (files['xl/' + target] ? 'xl/' + target : Object.keys(files).find((k) => k.endsWith(target)));
    if (!key || !files[key]) continue;
    sheetNames.push(name);
    sheets[name] = parseSheet(files[key].toString('utf8'), strs);
  }
  return { sheetNames, sheets };
}

module.exports = { readWorkbook, serialToISODate };
