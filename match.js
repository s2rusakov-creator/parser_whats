/**
 * match.js  (stage 3 of 4)  — REBUILT
 * -----------------------------------
 * Previously this scored pairs of people by shared interests. The project's
 * goal changed: now it groups members by WHAT THEY DO.
 *
 * Reads data/enriched.json (produced by enrich.js), normalizes each member's
 * category against config.categoryAliases, buckets everyone into groups, and
 * writes data/grouped.json — clean "occupation direction -> people" structure
 * that export.js turns into a spreadsheet.
 *
 * Usage:  node match.js     (or: npm run match)
 */

const fs = require('fs');
const config = require('./config');

/** Map a raw LLM category onto a canonical one via the alias table. */
function canonicalCategory(raw) {
  const value = (raw || '').trim();
  if (!value) return config.unknownCategory;
  const alias = config.categoryAliases[value.toLowerCase()];
  return alias || value;
}

/** Display label for a member. */
function label(m) {
  return m.pushname || m.name || m.number || m.id;
}

function main() {
  if (!fs.existsSync(config.paths.enriched)) {
    console.error(`Not found: ${config.paths.enriched}. Run "node enrich.js" first.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(config.paths.enriched, 'utf8'));
  const members = data.members || [];
  console.log(`Loaded ${members.length} enriched members.`);

  // Bucket members by canonical category.
  const buckets = new Map();
  for (const m of members) {
    const occ = m.occupation || {};
    const category = canonicalCategory(occ.category);
    const person = {
      id: m.id,
      label: label(m),
      number: m.number,
      isAdmin: !!m.isAdmin,
      occupation: occ.occupation || '',
      services: occ.services || [],
      location: occ.location || '',
      confidence: occ.confidence || 0,
      summary: occ.summary || '',
    };
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(person);
  }

  // Build sorted group list: real categories first (by size), unknown last.
  const groups = [...buckets.entries()].map(([category, people]) => {
    people.sort((a, b) => b.confidence - a.confidence);
    return { category, count: people.length, people };
  });
  groups.sort((a, b) => {
    if (a.category === config.unknownCategory) return 1;
    if (b.category === config.unknownCategory) return -1;
    return b.count - a.count;
  });

  const known = groups.filter((g) => g.category !== config.unknownCategory);
  const classifiedPeople = known.reduce((n, g) => n + g.count, 0);

  const output = {
    groupedAt: new Date().toISOString(),
    group: data.group || null,
    memberCount: members.length,
    categoryCount: known.length,
    classifiedPeople,
    groups,
  };
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.paths.grouped, JSON.stringify(output, null, 2), 'utf8');

  // Console summary.
  console.log(`\nGrouped into ${known.length} categories (${classifiedPeople} people classified):\n`);
  for (const g of groups) {
    const tag = g.category === config.unknownCategory ? ' (не классифицировано)' : '';
    console.log(`  ${g.category}: ${g.count}${tag}`);
    g.people
      .filter((p) => p.confidence > 0)
      .slice(0, 5)
      .forEach((p) => {
        console.log(`     - ${p.label}: ${p.occupation || p.summary}`);
      });
  }
  console.log(`\nWrote ${config.paths.grouped}`);
  console.log(`Next: node export.js  (write Excel/CSV + JSON to out/)`);
}

main();
