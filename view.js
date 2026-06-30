/**
 * view.js
 * -------
 * A tiny zero-dependency web viewer for the scraped group and generated
 * matches. Starts a local HTTP server (no npm installs — uses only Node's
 * built-in http/fs) and serves a single page that renders:
 *
 *   - the group export   (data/group_export.json)  -> members table
 *   - the match results  (data/matches.json)       -> ranked connections
 *
 * The JSON files are re-read on every request, so re-running scrape/match and
 * refreshing the browser shows fresh data.
 *
 * Usage:
 *   node view.js              # then open http://localhost:5173
 *   PORT=8080 node view.js    # custom port
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA_DIR = path.join(__dirname, 'data');
const EXPORT_FILE = path.join(DATA_DIR, 'group_export.json');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');
const PORT = parseInt(process.env.PORT, 10) || 5173;

/** Read + parse a JSON file, returning null if missing or unparseable. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

// ---- HTML page ------------------------------------------------------------
// Self-contained: markup + styles + a little client JS that fetches /api/data
// and renders it. Kept dependency-free on purpose.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>contacts-viewer</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1115; color: #e6e6e6;
  }
  header { padding: 20px 24px; border-bottom: 1px solid #262b36; background: #151821; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header .sub { color: #8b93a7; font-size: 13px; }
  main { padding: 24px; max-width: 1000px; margin: 0 auto; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab {
    padding: 8px 16px; border: 1px solid #2b3140; border-radius: 8px;
    background: #1a1e28; color: #c7cdda; cursor: pointer; font-size: 14px;
  }
  .tab.active { background: #2563eb; border-color: #2563eb; color: #fff; }
  .card {
    background: #151821; border: 1px solid #262b36; border-radius: 12px;
    padding: 16px 18px; margin-bottom: 14px;
  }
  .empty { color: #8b93a7; text-align: center; padding: 48px 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #232834; vertical-align: top; }
  th { color: #8b93a7; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .pill {
    display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px;
    background: #1e2738; color: #93b4ff; margin: 2px 4px 2px 0;
  }
  .pill.skill { background: #1d2e22; color: #7ee2a8; }
  .pill.loc { background: #2e2a1d; color: #e2cd7e; }
  .admin { background: #3a1d2e; color: #ff9bc4; }
  .muted { color: #6b7280; }
  .score { font-weight: 700; color: #fff; background: #2563eb; border-radius: 6px; padding: 2px 8px; }
  .pair { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .pair .who { font-weight: 600; }
  .pair .arrow { color: #6b7280; }
  .row-meta { color: #8b93a7; font-size: 13px; margin-top: 6px; }
  code { background: #1a1e28; padding: 1px 6px; border-radius: 5px; font-size: 13px; }
  a { color: #6ea8ff; }
</style>
</head>
<body>
<header>
  <h1>contacts-viewer</h1>
  <div class="sub" id="subtitle">loading…</div>
</header>
<main>
  <div class="tabs">
    <div class="tab active" data-tab="matches">Matches</div>
    <div class="tab" data-tab="members">Members</div>
  </div>
  <div id="content"></div>
</main>

<script>
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let DATA = { export: null, matches: null };
let TAB = 'matches';

function renderSubtitle() {
  const g = DATA.export && DATA.export.group;
  const el = document.getElementById('subtitle');
  if (!g) { el.textContent = 'No export found. Run "npm run scrape" first.'; return; }
  const when = DATA.export.exportedAt ? new Date(DATA.export.exportedAt).toLocaleString() : '?';
  el.innerHTML = esc(g.name) + ' &middot; ' + (g.participantCount || 0) + ' participants &middot; exported ' + esc(when);
}

function pills(items, cls) {
  if (!items || !items.length) return '<span class="muted">—</span>';
  return items.map((i) => '<span class="pill ' + (cls || '') + '">' + esc(i) + '</span>').join('');
}

function renderMembers() {
  const exp = DATA.export;
  if (!exp || !exp.members || !exp.members.length) {
    return '<div class="empty">No members. Run <code>npm run scrape</code> to create data/group_export.json.</div>';
  }
  const rows = exp.members.map((m) => {
    const name = m.name || m.pushname || '(no name)';
    const admin = m.isAdmin ? ' <span class="pill admin">admin</span>' : '';
    const msgs = (m.messages || []).length;
    return '<tr>' +
      '<td><div class="who">' + esc(name) + admin + '</div>' +
        '<div class="row-meta">' + esc(m.number || m.id) + '</div></td>' +
      '<td>' + (m.about ? esc(m.about) : '<span class="muted">—</span>') + '</td>' +
      '<td>' + msgs + '</td></tr>';
  }).join('');
  return '<div class="card"><table>' +
    '<thead><tr><th>Member</th><th>About</th><th>Messages</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

function renderMatches() {
  const m = DATA.matches;
  if (!m) {
    return '<div class="empty">No matches yet. Run <code>npm run match</code> after scraping.</div>';
  }
  const pairs = m.rankedPairs || [];
  if (!pairs.length) {
    return '<div class="empty">Match ran, but found <b>0 connected pairs</b>.<br>' +
      'This group has no shared interest/skill/location signals in member profiles or messages.</div>';
  }
  return pairs.map((p) => {
    const shared =
      pills(p.sharedSkills, 'skill') + pills(p.sharedInterests, '') + pills(p.sharedLocations, 'loc');
    return '<div class="card">' +
      '<div class="pair">' +
        '<span class="score">' + p.score + '</span>' +
        '<span class="who">' + esc(p.a.label) + '</span>' +
        '<span class="arrow">&harr;</span>' +
        '<span class="who">' + esc(p.b.label) + '</span>' +
      '</div>' +
      '<div class="row-meta">' + shared + '</div>' +
    '</div>';
  }).join('');
}

function render() {
  renderSubtitle();
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === TAB));
  document.getElementById('content').innerHTML =
    TAB === 'members' ? renderMembers() : renderMatches();
}

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => { TAB = t.dataset.tab; render(); }));

fetch('/api/data')
  .then((r) => r.json())
  .then((d) => { DATA = d; render(); })
  .catch(() => { document.getElementById('content').innerHTML =
    '<div class="empty">Failed to load data.</div>'; });
</script>
</body>
</html>`;

// ---- Server ---------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === '/api/data') {
    // Re-read on every request so refreshing picks up new scrape/match runs.
    const body = JSON.stringify({
      export: readJson(EXPORT_FILE),
      matches: readJson(MATCHES_FILE),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`contacts-viewer running at http://localhost:${PORT}`);
  console.log('Press Ctrl-C to stop.');
});
