// server.js — SwiftCMA MVP (hardened)
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { parse as csvParseSync } from 'csv-parse/sync';
import { customAlphabet } from 'nanoid';
import puppeteer from 'puppeteer';
import ejs from 'ejs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// ---- Render / deployment friendly settings ----
app.set('trust proxy', 1);
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Storage paths ----
const uploadDir = path.join(__dirname, 'data', 'uploads');
const reportDir = path.join(__dirname, 'data', 'reports');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });

// ---- Simple ID helper ----
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

// ---- Multer storage for file uploads ----
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, `${nanoid()}${path.extname(file.originalname) || '.csv'}`)
});
const upload = multer({ storage });

// ---- In-memory stores (swap for DB later) ----
const uploads = new Map();   // uploadId -> { path, headers, rows }
const reports = new Map();   // reportId -> { ...data }
const mappings = new Map();  // uploadId -> mapJson

// ---- Fuzzy mapping + stats helpers ----
const synonyms = {
  address: ['property address','street address','address','addr'],
  list_price: ['list price','listprice','asking price'],
  sold_price: ['sold price','sale price','closed price','price sold'],
  beds: ['bedrooms','beds','br'],
  baths: ['bathrooms','baths','ba','bath'],
  sqft: ['sqft','living area','square feet','square footage','above grade sqft'],
  dom: ['dom','cdom','days on market','cumulative days on market'],
  status: ['status','sale status','prop status'],
  photo_url: ['photo url','primary photo','image url'],
  year_built: ['year built','yr built','built'],
  lot_sqft: ['lot sqft','lot size','lot area'],
  distance_mi: ['distance','distance (mi)','mi']
};

const numericCanon = new Set([
  'list_price','sold_price','sqft','beds','baths','dom','year_built','lot_sqft','distance_mi'
]);

function norm(s='') { return s.toString().trim().toLowerCase().replace(/[^a-z0-9]+/g,''); }

function suggestMapping(headers=[]) {
  const map = {};
  headers.forEach(h => {
    const nh = norm(h);
    let best = null;
    for (const [key, syns] of Object.entries(synonyms)) {
      if (syns.some(s => nh.includes(norm(s)))) { best = key; break; }
    }
    // reasonable fallbacks
    if (!best) {
      if (nh.includes('price') && !nh.includes('list')) best = 'sold_price';
      else if (nh.includes('list') && nh.includes('price')) best = 'list_price';
      else if (nh.includes('sqft') || nh.includes('square')) best = 'sqft';
      else if (nh.includes('bed')) best = 'beds';
      else if (nh.includes('bath')) best = 'baths';
      else if (nh.includes('dom')) best = 'dom';
      else if (nh.includes('status')) best = 'status';
    }
    map[h] = best || null;
  });
  return map;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = v.toString().replace(/[\$,]/g,'').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(row, map) {
  const out = {};
  for (const [hdr, key] of Object.entries(map || {})) {
    if (!key) continue;
    let val = row[hdr];
    if (numericCanon.has(key)) val = toNumber(val);
    out[key] = val ?? null;
  }
  return out;
}

function computeStats(comps=[]) {
  const sold = comps.filter(c => c.sold_price && c.sqft);
  const soldPrices = sold.map(c => c.sold_price).sort((a,b)=>a-b);
  const avgSold = soldPrices.length ? Math.round(soldPrices.reduce((a,b)=>a+b,0)/soldPrices.length) : null;
  const ppsf = sold.map(c => c.sold_price/(c.sqft||1)).filter(Boolean);
  const avgPpsf = ppsf.length ? Math.round(ppsf.reduce((a,b)=>a+b,0)/ppsf.length) : null;
  const doms = comps.map(c => c.dom).filter(v => Number.isFinite(v));
  const avgDom = doms.length ? Math.round(doms.reduce((a,b)=>a+b,0)/doms.length) : null;
  const median = soldPrices.length ? soldPrices[Math.floor(soldPrices.length/2)] : null;
  return {
    avgSoldPrice: avgSold,
    avgPricePerSqft: avgPpsf,
    avgDOM: avgDom,
    suggestedListLow: median ? Math.round(median*0.95) : null,
    suggestedListHigh: median ? Math.round(median*1.08) : null
  };
}

// ---- Health check ----
app.get('/healthz', (_, res) => res.json({ ok: true }));

// ---- Root UI ----
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- Helper: robust CSV/XLSX ingestion ----
async function readTabularFile(filePath, originalName) {
  const lower = (originalName || '').toLowerCase();

  // optional XLSX support (only if dependency is installed)
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    try {
      const xlsxMod = await import('xlsx'); // requires "xlsx" in package.json
      const wb = xlsxMod.readFile(filePath, { cellDates: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const csvText = xlsxMod.utils.sheet_to_csv(sheet, { FS: ',', RS: '\n' });
      return parseCsvString(csvText);
    } catch (e) {
      // fall through and try as text CSV anyway
      console.warn('XLSX parse failed or xlsx not installed, trying as text CSV:', e?.message);
    }
  }

  // Read as text CSV
  let csvText = fs.readFileSync(filePath, 'utf8');
  // strip BOM
  if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

  return parseCsvString(csvText);
}

function parseCsvString(csvText) {
  // try comma first
  try {
    const recs = csvParseSync(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      bom: true,
      delimiter: ','
    });
    if (recs && recs.length) return recs;
  } catch (e) {
    // ignore and try semicolon
  }
  // try semicolon
  try {
    const recs = csvParseSync(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      bom: true,
      delimiter: ';'
    });
    if (recs && recs.length) return recs;
  } catch (e) {
    // final throw with context
    const preview = csvText.slice(0, 500);
    const err = new Error(`CSV parse failed. Preview: ${preview}`);
    err.code = 'CSV_PARSE_FAILED';
    throw err;
  }
  // no rows
  const preview = csvText.slice(0, 500);
  const err = new Error(`CSV contained no rows. Preview: ${preview}`);
  err.code = 'CSV_EMPTY';
  throw err;
}

// ---- Upload CSV (hardened) ----
app.post('/api/uploads', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const records = await readTabularFile(filePath, req.file.originalname);

    if (!records || !records.length) {
      return res.status(400).json({
        error: 'CSV contained no data rows',
        hint: 'Export as CSV (comma-delimited) and ensure header row is present.'
      });
    }

    const headers = Object.keys(records[0] || {});
    if (!headers.length) {
      return res.status(400).json({
        error: 'CSV has no headers',
        hint: 'First row must be a header row.'
      });
    }

    const suggestedMap = suggestMapping(headers);
    const uploadId = path.basename(filePath, path.extname(filePath));
    uploads.set(uploadId, { path: filePath, headers, rows: records });

    return res.json({
      uploadId,
      headers,
      suggestedMap,
      rowCount: records.length
    });
  } catch (e) {
    console.error('Upload parse error:', e);
    const status = (e.code === 'CSV_PARSE_FAILED' || e.code === 'CSV_EMPTY') ? 400 : 500;
    res.status(status).json({
      error: 'Upload parse failed',
      detail: e?.message
    });
  }
});

// ---- Save mapping for an upload (optional) ----
app.post('/api/mappings', (req, res) => {
  const { uploadId, mapJson } = req.body || {};
  if (!uploadId || !mapJson) {
    return res.status(400).json({ error: 'uploadId and mapJson required' });
  }
  mappings.set(uploadId, mapJson);
  res.json({ ok: true });
});

// ---- Generate report (HTML + PDF + share) ----
app.post('/api/reports', async (req, res) => {
  try {
    const { uploadId, mapping, subject } = req.body || {};
    const up = uploads.get(uploadId);
    if (!up) return res.status(404).json({ error: 'Upload not found' });

    const finalMap = mapping || mappings.get(uploadId) || suggestMapping(up.headers);
    const comps = up.rows.map(r => normalizeRow(r, finalMap)).filter(c => c.address);
    if (!comps.length) {
      return res.status(400).json({
        error: 'No valid comps after mapping',
        hint: 'Map at least address and a price field (Sold or List).'
      });
    }

    const marketStats = computeStats(comps);
    const reportId = nanoid();
    const shareSlug = nanoid();

    const reportData = {
      reportId,
      shareSlug,
      createdAt: new Date().toISOString(),
      subject: subject || { address: 'Unknown', beds: '', baths: '', sqft: '' },
      comps,
      marketStats,
      branding: {
        agentName: subject?.agentName || 'Your Name',
        agentPhone: subject?.agentPhone || '',
        logoUrl: subject?.logoUrl || 'https://via.placeholder.com/160x40?text=SwiftCMA',
        accent: subject?.accent || '#0ea5e9'
      }
    };

    // Render HTML via EJS template
    const tplPath = path.join(__dirname, 'src', 'templates', 'report.ejs');
    const html = await ejs.renderFile(tplPath, reportData, { async: true });

    // Save shareable HTML
    const shareHtmlPath = path.join(reportDir, `${shareSlug}.html`);
    fs.writeFileSync(shareHtmlPath, html, 'utf8');

    // Puppeteer launch options for Render
    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfPathAbs = path.join(reportDir, `${reportId}.pdf`);
    await page.pdf({
      path: pdfPathAbs,
      format: 'A4',
      printBackground: true,
      margin: { top: '1in', right: '1in', bottom: '1in', left: '1in' }
    });
    await browser.close();

    const apiPdfPath = `/reports/${reportId}.pdf`;
    const apiShareUrl = `/r/${shareSlug}`;

    reports.set(reportId, { ...reportData, pdfPath: apiPdfPath, shareUrl: apiShareUrl });
    return res.json({ reportId, shareUrl: apiShareUrl, pdfPath: apiPdfPath });
  } catch (e) {
    console.error('Report generation failed:', e);
    res.status(500).json({ error: 'Report generation failed', detail: e?.message });
  }
});

// ---- Report JSON ----
app.get('/api/reports/:id', (req, res) => {
  const r = reports.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// ---- Share link (public read-only HTML) ----
app.get('/r/:slug', (req, res) => {
  const file = path.join(reportDir, `${req.params.slug}.html`);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.sendFile(file);
});

// ---- Serve generated PDFs ----
app.get('/reports/:pdf', (req, res) => {
  const file = path.join(reportDir, req.params.pdf);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.sendFile(file);
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SwiftCMA running on http://localhost:${PORT}`);
  console.log('Health check: GET /healthz');
});
