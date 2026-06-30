/**
 * export.js  (stage 4 of 4)
 * -------------------------
 * Reads data/grouped.json and writes shareable output to out/:
 *   - out/people.json   full structured data
 *   - out/people.csv    flat table (opens in Excel/Sheets, zero deps)
 *   - out/people.xlsx   multi-sheet workbook  (only if `exceljs` is installed)
 *
 * The xlsx step is optional so the pipeline works with no extra dependencies;
 * install exceljs (npm i exceljs) to also get a formatted workbook with a sheet
 * per category plus a summary sheet.
 *
 * Usage:  node export.js     (or: npm run export)
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const COLUMNS = [
  'category',
  'name',
  'number',
  'occupation',
  'services',
  'location',
  'confidence',
  'isAdmin',
  'summary',
];

/** Flatten grouped data into one row per person. */
function toRows(grouped) {
  const rows = [];
  for (const g of grouped.groups || []) {
    for (const p of g.people || []) {
      rows.push({
        category: g.category,
        name: p.label,
        number: p.number,
        occupation: p.occupation,
        services: (p.services || []).join('; '),
        location: p.location,
        confidence: p.confidence,
        isAdmin: p.isAdmin ? 'yes' : '',
        summary: p.summary,
      });
    }
  }
  return rows;
}

// ---- CSV ------------------------------------------------------------------

function csvCell(value) {
  const s = String(value == null ? '' : value);
  // Prefix phone numbers with a tab-safe guard so Excel keeps the leading +.
  const needsQuote = /[",\n]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

function writeCsv(rows, file) {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(COLUMNS.map((c) => csvCell(r[c])).join(','));
  }
  // BOM so Excel detects UTF-8 (important for Cyrillic).
  fs.writeFileSync(file, '﻿' + lines.join('\r\n'), 'utf8');
}

// ---- XLSX (optional) ------------------------------------------------------

async function writeXlsx(grouped, rows, file) {
  let ExcelJS;
  try {
    ExcelJS = require('exceljs');
  } catch (err) {
    return false; // not installed — skip silently, CSV/JSON already written
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'parser_whats';

  // Summary sheet.
  const summary = wb.addWorksheet('Сводка');
  summary.columns = [
    { header: 'Категория', key: 'category', width: 30 },
    { header: 'Человек', key: 'count', width: 12 },
  ];
  for (const g of grouped.groups || []) {
    summary.addRow({ category: g.category, count: g.count });
  }
  summary.getRow(1).font = { bold: true };

  // "Все" sheet with every person.
  const all = wb.addWorksheet('Все');
  all.columns = COLUMNS.map((c) => ({ header: c, key: c, width: c === 'summary' ? 40 : 18 }));
  all.getRow(1).font = { bold: true };
  for (const r of rows) all.addRow({ ...r, number: String(r.number) });

  // One sheet per category (Excel sheet names: <=31 chars, no special chars).
  const used = new Set();
  for (const g of grouped.groups || []) {
    let name = g.category.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28);
    let n = name || 'Прочее';
    let i = 2;
    while (used.has(n)) n = `${name} ${i++}`;
    used.add(n);
    const ws = wb.addWorksheet(n);
    ws.columns = COLUMNS.filter((c) => c !== 'category').map((c) => ({
      header: c,
      key: c,
      width: c === 'summary' ? 40 : 18,
    }));
    ws.getRow(1).font = { bold: true };
    for (const p of g.people || []) {
      ws.addRow({
        name: p.label,
        number: String(p.number),
        occupation: p.occupation,
        services: (p.services || []).join('; '),
        location: p.location,
        confidence: p.confidence,
        isAdmin: p.isAdmin ? 'yes' : '',
        summary: p.summary,
      });
    }
  }

  await wb.xlsx.writeFile(file);
  return true;
}

// ---- Main -----------------------------------------------------------------

async function main() {
  if (!fs.existsSync(config.paths.grouped)) {
    console.error(`Not found: ${config.paths.grouped}. Run "node match.js" first.`);
    process.exit(1);
  }

  const grouped = JSON.parse(fs.readFileSync(config.paths.grouped, 'utf8'));
  const rows = toRows(grouped);

  fs.mkdirSync(config.paths.outDir, { recursive: true });
  const jsonFile = path.join(config.paths.outDir, 'people.json');
  const csvFile = path.join(config.paths.outDir, 'people.csv');
  const xlsxFile = path.join(config.paths.outDir, 'people.xlsx');

  fs.writeFileSync(jsonFile, JSON.stringify(grouped, null, 2), 'utf8');
  writeCsv(rows, csvFile);
  const xlsxWritten = await writeXlsx(grouped, rows, xlsxFile);

  console.log(`Exported ${rows.length} people across ${grouped.categoryCount} categories:`);
  console.log(`  ${jsonFile}`);
  console.log(`  ${csvFile}`);
  if (xlsxWritten) {
    console.log(`  ${xlsxFile}`);
  } else {
    console.log('  (xlsx skipped — run "npm i exceljs" for a formatted workbook)');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
