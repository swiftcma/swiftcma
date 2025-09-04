// server.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';
import { customAlphabet } from 'nanoid';
import puppeteer from 'puppeteer';
import ejs from 'ejs';
import { suggestMapping, normalizeRow } from './src/utils/fuzzyMap.js';
import { computeStats } from './src/utils/stats.js';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'data', 'uploads');
const reportDir = path.join(__dirname, 'data', 'reports');
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, `${nanoid()}${path.extname(file.originalname) || '.csv'}`)
});
const upload = multer({ storage });

// In-memory stores (replace with DB later)
const uploads = new Map();
const reports = new Map();
const mappings = new Map();

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Upload CSV
app.post('/api/uploads', upload.single('file'), (req, res) => {
  try {
    const filePath = req.file.path;
    const csvText = fs.readFileSync(filePath, 'utf8');
    const records = parse(csvText, { columns: true, skip_empty_lines: true });
    if (!records.length) return res.status(400).json({ error: 'Empty CSV' });
    const headers = Object.keys(records[0]);
    const suggestedMap = suggestMapping(headers);
    const uploadId = path.basename(filePath, path.extname(filePath));
    uploads.set(uploadId, { path: filePath, headers, rows: records });
    return res.json({ uploadId, headers, suggestedMap });
  } catch (e) {
    res.status(500).json({ error: 'Upload parse failed' });
  }
});

// Save mapping
app.post('/api/mappings', (req, res) => {
  const { uploadId, mapJson } = req.body;
  if (!uploadId || !mapJson) return res.status(400).json({ error: 'uploadId and mapJson required' });
  mappings.set(uploadId, mapJson);
  res.json({ ok: true });
});

// Generate report
app.post('/api/reports', async (req, res) => {
  try {
    const { uploadId, mapping, subject } = req.body;
    const up = uploads.get(uploadId);
    if (!up) return res.status(404).json({ error: 'Upload not found' });
    const finalMap = mapping || mappings.get(uploadId) || suggestMapping(up.headers);
    const comps = up.rows.map(r => normalizeRow(r, finalMap)).filter(c => c.address);
    if (!comps.length) return res.status(400).json({ error: 'No valid comps after mapping' });
    const marketStats = computeStats(comps);

    const reportId = nanoid();
    const shareSlug = nanoid();
    const reportData = {
      reportId, shareSlug, createdAt: new Date().toISOString(),
      subject: subject || {}, comps, marketStats,
      branding: {
        agentName: subject?.agentName || 'Your Name',
        agentPhone: subject?.agentPhone || '',
        logoUrl: subject?.logoUrl || 'https://via.placeholder.com/160x40?text=SwiftCMA',
        accent: subject?.accent || '#0ea5e9'
      }
    };

    const tplPath = path.join(__dirname, 'src/templates/report.ejs');
    const html = await ejs.renderFile(tplPath, reportData, { async: true });
    fs.writeFileSync(path.join(reportDir, `${shareSlug}.html`), html, 'utf8');

    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfPath = path.join(reportDir, `${reportId}.pdf`);
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '1in', right: '1in', bottom: '1in', left: '1in' } });
    await browser.close();

    reports.set(reportId, { ...reportData, pdfPath, shareUrl: `/r/${shareSlug}` });
    return res.json({ reportId, shareUrl: `/r/${shareSlug}`, pdfPath: `/reports/${reportId}.pdf` });
  } catch (e) {
    res.status(500).json({ error: 'Report generation failed' });
  }
});

app.get('/api/reports/:id', (req, res) => {
  const r = reports.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.get('/r/:slug', (req, res) => {
  const file = path.join(reportDir, `${req.params.slug}.html`);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.sendFile(file);
});

app.get('/reports/:pdf', (req, res) => {
  const file = path.join(reportDir, req.params.pdf);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.sendFile(file);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SwiftCMA running on http://localhost:${PORT}`));
