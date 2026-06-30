/**
 * view.js
 * -------
 * Zero-dependency local web viewer. Serves a single page that renders, from the
 * pipeline outputs:
 *   - Directions  (data/grouped.json)      -> people grouped by what they do
 *   - Members     (data/group_export.json) -> raw scraped members table
 *
 * JSON is re-read on every request, so re-running the pipeline and refreshing
 * shows fresh data.
 *
 * Usage:  node view.js              # http://localhost:5173
 *         PORT=8080 node view.js    # custom port (PowerShell: $env:PORT=8080; node view.js)
 */

const fs = require('fs');
const http = require('http');
const config = require('./config');

const PORT = parseInt(process.env.PORT, 10) || 5173;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

const PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>parser_whats</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f1115; color: #e6e6e6; }
  header { padding: 20px 24px; border-bottom: 1px solid #262b36; background: #151821; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header .sub { color: #8b93a7; font-size: 13px; }
  main { padding: 24px; max-width: 1000px; margin: 0 auto; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab { padding: 8px 16px; border: 1px solid #2b3140; border-radius: 8px; background: #1a1e28; color: #c7cdda; cursor: pointer; font-size: 14px; }
  .tab.active { background: #2563eb; border-color: #2563eb; color: #fff; }
  input.search { width: 100%; padding: 10px 12px; margin-bottom: 16px; background: #151821; border: 1px solid #262b36; border-radius: 8px; color: #e6e6e6; font-size: 14px; }
  .group { background: #151821; border: 1px solid #262b36; border-radius: 12px; margin-bottom: 14px; overflow: hidden; }
  .group > summary { list-style: none; cursor: pointer; padding: 14px 18px; display: flex; align-items: center; gap: 10px; font-weight: 600; }
  .group > summary::-webkit-details-marker { display: none; }
  .badge { background: #2563eb; color: #fff; border-radius: 999px; padding: 1px 10px; font-size: 13px; }
  .group .body { padding: 0 18px 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #232834; vertical-align: top; }
  th { color: #8b93a7; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .who { font-weight: 600; }
  .muted { color: #6b7280; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; background: #1d2e22; color: #7ee2a8; margin: 2px 4px 2px 0; }
  .conf { font-size: 12px; color: #8b93a7; }
  .empty { color: #8b93a7; text-align: center; padding: 48px 16px; }
  code { background: #1a1e28; padding: 1px 6px; border-radius: 5px; }
</style>
</head>
<body>
<header>
  <h1>parser_whats</h1>
  <div class="sub" id="subtitle">loading…</div>
</header>
<main>
  <div class="tabs">
    <div class="tab active" data-tab="directions">По направлениям</div>
    <div class="tab" data-tab="members">Участники</div>
  </div>
  <input class="search" id="search" placeholder="Поиск по имени / занятию / категории…" />
  <div id="content"></div>
</main>
<script>
const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let DATA = { export: null, grouped: null };
let TAB = 'directions';
let Q = '';

function subtitle() {
  const g = DATA.export && DATA.export.group;
  const el = document.getElementById('subtitle');
  if (!g) { el.textContent = 'Нет данных. Сначала: npm run scrape'; return; }
  const gr = DATA.grouped;
  const cats = gr ? gr.categoryCount : 0;
  const cls = gr ? gr.classifiedPeople : 0;
  el.innerHTML = esc(g.name) + ' · ' + (g.participantCount||0) + ' участников · '
    + cats + ' направлений · ' + cls + ' классифицировано';
}

function match(text) { return !Q || text.toLowerCase().includes(Q); }

function renderDirections() {
  const gr = DATA.grouped;
  if (!gr) return '<div class="empty">Нет группировки. Запусти <code>npm run enrich</code> и <code>npm run match</code>.</div>';
  const groups = (gr.groups||[]).map((g) => {
    const people = g.people.filter((p) =>
      match(p.label+' '+(p.occupation||'')+' '+g.category+' '+(p.services||[]).join(' ')));
    if (!people.length) return '';
    const rows = people.map((p) =>
      '<tr><td><div class="who">'+esc(p.label)+'</div><div class="muted">'+esc(p.number||'')+'</div></td>'+
      '<td>'+esc(p.occupation||p.summary||'—')+
        ((p.services||[]).length?'<div>'+p.services.map((s)=>'<span class="pill">'+esc(s)+'</span>').join('')+'</div>':'')+'</td>'+
      '<td>'+esc(p.location||'')+'</td>'+
      '<td class="conf">'+(p.confidence!=null?Math.round(p.confidence*100)+'%':'')+'</td></tr>').join('');
    return '<details class="group" open><summary>'+esc(g.category)+'<span class="badge">'+people.length+'</span></summary>'+
      '<div class="body"><table><thead><tr><th>Человек</th><th>Чем занимается</th><th>Локация</th><th>Увер.</th></tr></thead>'+
      '<tbody>'+rows+'</tbody></table></div></details>';
  }).join('');
  return groups || '<div class="empty">Ничего не найдено по запросу.</div>';
}

function renderMembers() {
  const exp = DATA.export;
  if (!exp || !exp.members || !exp.members.length)
    return '<div class="empty">Нет участников. Запусти <code>npm run scrape</code>.</div>';
  const rows = exp.members.filter((m) =>
    match((m.pushname||'')+' '+(m.name||'')+' '+(m.about||''))).map((m) => {
    const name = m.pushname || m.name || '(без имени)';
    const admin = m.isAdmin ? ' <span class="pill">admin</span>' : '';
    return '<tr><td><div class="who">'+esc(name)+admin+'</div><div class="muted">'+esc(m.number||m.id)+'</div></td>'+
      '<td>'+(m.about?esc(m.about):'<span class="muted">—</span>')+'</td>'+
      '<td>'+(m.messages||[]).length+'</td></tr>';
  }).join('');
  return '<div class="group"><div class="body"><table><thead><tr><th>Участник</th><th>Статус</th><th>Сообщений</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
}

function render() {
  subtitle();
  document.querySelectorAll('.tab').forEach((t)=>t.classList.toggle('active', t.dataset.tab===TAB));
  document.getElementById('content').innerHTML = TAB==='members' ? renderMembers() : renderDirections();
}

document.querySelectorAll('.tab').forEach((t)=>t.addEventListener('click',()=>{TAB=t.dataset.tab;render();}));
document.getElementById('search').addEventListener('input',(e)=>{Q=e.target.value.trim().toLowerCase();render();});

fetch('/api/data').then((r)=>r.json()).then((d)=>{DATA=d;render();})
  .catch(()=>{document.getElementById('content').innerHTML='<div class="empty">Не удалось загрузить данные.</div>';});
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/api/data') {
    const body = JSON.stringify({
      export: readJson(config.paths.export),
      grouped: readJson(config.paths.grouped),
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
  console.log(`parser_whats viewer at http://localhost:${PORT}`);
  console.log('Press Ctrl-C to stop.');
});
