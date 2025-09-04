# SwiftCMA MVP (CSV → CMA PDF)

A minimal, runnable MVP for SwiftCMA. Agents upload an MLS-exported CSV, map columns to canonical fields, preview the report, and generate a printer-friendly PDF.

## Features
- CSV upload (no MLS integration)
- Fuzzy header mapping → canonical fields
- Normalization + stats (avg sold price, $/sqft, DOM, median)
- HTML preview → PDF export (Puppeteer)
- Share link (static HTML) at `/r/:slug`

## Quick Start
```bash
npm i
npm run start   # http://localhost:3000
