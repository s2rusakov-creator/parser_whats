/**
 * server.js  — web control panel
 * ------------------------------
 * One place to do everything from the browser:
 *   1. Log in to WhatsApp (QR shown on the page).
 *   2. See your groups, click one to parse.
 *   3. Watch progress (scrape -> classify -> group -> export).
 *   4. Browse people grouped by what they do; download the export.
 *
 * The WhatsApp client lives in lib/whatsapp.js. The classify/group/export steps
 * run as child processes (enrich.js, match.js, export.js) so this reuses the
 * exact same tested pipeline.
 *
 * Usage:  node server.js   (or: npm start)  ->  http://localhost:5173
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const config = require('./config');
const wa = require('./lib/whatsapp');

const PORT = parseInt(process.env.PORT, 10) || 5173;

// ---- Pipeline job ---------------------------------------------------------

function runNode(script) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [script], { cwd: __dirname });
    const pump = (buf) =>
      String(buf)
        .split(/\r?\n/)
        .forEach((l) => l.trim() && wa.log(l.trim()));
    cp.stdout.on('data', pump);
    cp.stderr.on('data', pump);
    cp.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} завершился с кодом ${code}`))
    );
    cp.on('error', reject);
  });
}

async function runParse(groupId, groupName) {
  const job = wa.job;
  if (job.running) return;
  Object.assign(job, {
    running: true,
    done: false,
    error: null,
    log: [],
    groupName,
    stepIndex: 0,
    step: 'scrape',
    stats: null,
  });

  try {
    wa.log(`▶ Парсинг группы «${groupName}»`);
    job.stats = await wa.scrapeGroup(groupId, (m) => wa.log(m));

    if (job.stats.usable === 0) {
      throw new Error(
        'В группе нет данных для анализа (все молчат / скрыты). Выбери активную группу.'
      );
    }

    job.stepIndex = 1;
    job.step = 'enrich';
    wa.log('▶ Классификация занятий (GigaChat)…');
    await runNode('enrich.js');

    job.stepIndex = 2;
    job.step = 'match';
    wa.log('▶ Группировка по направлениям…');
    await runNode('match.js');

    job.stepIndex = 3;
    job.step = 'export';
    wa.log('▶ Выгрузка (Excel/CSV/JSON)…');
    await runNode('export.js');

    job.step = 'done';
    job.done = true;
    wa.log('✓ Готово. Результат ниже и в папке out/.');
  } catch (e) {
    job.error = e.message;
    wa.log(`✗ Ошибка: ${e.message}`);
  } finally {
    job.running = false;
  }
}

// ---- HTTP helpers ---------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (err) {
        resolve({});
      }
    });
  });
}

const DOWNLOADS = {
  csv: { file: 'people.csv', type: 'text/csv; charset=utf-8' },
  json: { file: 'people.json', type: 'application/json; charset=utf-8' },
  xlsx: {
    file: 'people.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
};

// ---- Server ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (url === '/api/status') {
    return sendJson(res, 200, wa.status());
  }
  if (url === '/api/groups') {
    try {
      return sendJson(res, 200, { groups: await wa.getGroups() });
    } catch (err) {
      return sendJson(res, 409, { error: err.message });
    }
  }
  if (url === '/api/parse' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.groupId) return sendJson(res, 400, { error: 'groupId required' });
    if (wa.job.running) return sendJson(res, 409, { error: 'Уже идёт парсинг' });
    runParse(body.groupId, body.groupName || body.groupId); // fire and forget
    return sendJson(res, 200, { ok: true });
  }
  if (url === '/api/results') {
    try {
      const data = JSON.parse(fs.readFileSync(config.paths.grouped, 'utf8'));
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 404, { error: 'нет результатов' });
    }
  }
  if (url.startsWith('/download/')) {
    const key = url.slice('/download/'.length);
    const d = DOWNLOADS[key];
    const file = d && path.join(config.paths.outDir, d.file);
    if (!d || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': d.type,
      'Content-Disposition': `attachment; filename="${d.file}"`,
    });
    return fs.createReadStream(file).pipe(res);
  }

  res.writeHead(404);
  res.end('Not found');
});

// Bind to loopback only by default: the panel has no auth and exposes group
// data, scraping control, and PII downloads. Binding to all interfaces would
// let anyone on your Wi-Fi/LAN reach it. Set HOST=0.0.0.0 to override on purpose.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  wa.start(); // boot WhatsApp client immediately
  console.log(`\n  parser_whats панель → http://localhost:${PORT}  (только этот компьютер)`);
  console.log('  (QR для входа появится в браузере и здесь в терминале)\n');
});

// ---- Front-end page (light theme, Data-Dense Dashboard) -------------------

const PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>parser_whats</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --primary:#1E40AF; --on-primary:#FFFFFF; --secondary:#3B82F6; --accent:#D97706;
    --bg:#F8FAFC; --surface:#FFFFFF; --fg:#1E3A8A; --text:#1E293B; --text-muted:#64748B;
    --muted:#E9EEF6; --border:#DBEAFE; --destructive:#DC2626; --ok:#16A34A; --ring:#1E40AF;
    --radius:12px; --shadow:0 1px 2px rgba(15,23,42,.06),0 4px 16px rgba(15,23,42,.06);
  }
  * { box-sizing:border-box; }
  html,body { margin:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.55 "Fira Sans",system-ui,"Segoe UI",sans-serif; }
  code,.mono { font-family:"Fira Code",ui-monospace,monospace; }
  a { color:var(--primary); }
  header {
    position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between;
    padding:14px 24px; background:rgba(255,255,255,.85); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border);
  }
  .brand { font-family:"Fira Code",monospace; font-weight:600; font-size:18px; color:var(--fg); display:flex; align-items:center; gap:10px; }
  .brand .dot { width:10px; height:10px; border-radius:50%; background:var(--accent); }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:6px 12px; border-radius:999px; font-size:13px; font-weight:500; border:1px solid var(--border); background:var(--surface); }
  .pill .led { width:8px; height:8px; border-radius:50%; background:var(--text-muted); }
  .pill.ready .led { background:var(--ok); } .pill.ready { color:var(--ok); border-color:#BBF7D0; background:#F0FDF4; }
  .pill.busy .led { background:var(--accent); animation:pulse 1.2s infinite; } .pill.busy { color:var(--accent); border-color:#FDE68A; background:#FFFBEB; }
  .pill.err .led { background:var(--destructive); } .pill.err { color:var(--destructive); border-color:#FECACA; background:#FEF2F2; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  main { max-width:960px; margin:0 auto; padding:24px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:20px; margin-bottom:18px; }
  .card h2 { margin:0 0 4px; font-size:16px; color:var(--fg); font-weight:600; }
  .card .hint { color:var(--text-muted); font-size:13px; margin-bottom:14px; }
  .center { text-align:center; }
  .qr { width:288px; height:288px; border-radius:10px; border:1px solid var(--border); background:#fff; padding:8px; }
  .spinner { width:34px; height:34px; border:3px solid var(--muted); border-top-color:var(--primary); border-radius:50%; animation:spin .8s linear infinite; margin:8px auto; }
  @keyframes spin { to{ transform:rotate(360deg) } }
  .progress-bar { height:8px; background:var(--muted); border-radius:999px; overflow:hidden; margin-top:8px; }
  .progress-bar > i { display:block; height:100%; background:var(--primary); transition:width .3s ease; }
  input.search { width:100%; padding:11px 14px; border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--text); font-size:14px; }
  input.search:focus { outline:2px solid var(--ring); outline-offset:1px; }
  .group-row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:12px 14px; border-radius:10px; border:1px solid transparent; transition:background .15s,border-color .15s; }
  .group-row:hover { background:#F1F6FF; border-color:var(--border); }
  .group-row .info { min-width:0; }
  .group-row .name { font-weight:500; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .group-row .count { font-size:12.5px; color:var(--text-muted); font-family:"Fira Code",monospace; }
  .btn { display:inline-flex; align-items:center; gap:7px; min-height:40px; padding:9px 16px; border-radius:10px; border:1px solid var(--primary); background:var(--primary); color:var(--on-primary); font:inherit; font-weight:500; font-size:14px; cursor:pointer; transition:filter .15s,opacity .15s; }
  .btn:hover { filter:brightness(1.08); } .btn:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  .btn.ghost { background:var(--surface); color:var(--primary); }
  .btn.sm { min-height:36px; padding:7px 13px; font-size:13px; }
  .steps { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
  .step { display:flex; align-items:center; gap:8px; padding:7px 12px; border-radius:999px; font-size:13px; background:var(--muted); color:var(--text-muted); }
  .step.active { background:#FFFBEB; color:var(--accent); border:1px solid #FDE68A; }
  .step.done { background:#F0FDF4; color:var(--ok); border:1px solid #BBF7D0; }
  .step .ic { width:16px; height:16px; }
  .log { font-family:"Fira Code",monospace; font-size:12.5px; line-height:1.7; background:#0F172A; color:#CBD5E1; border-radius:10px; padding:12px 14px; max-height:220px; overflow:auto; white-space:pre-wrap; }
  .log .ok { color:#4ADE80; } .log .err { color:#F87171; } .log .run { color:#FBBF24; }
  details.group { border:1px solid var(--border); border-radius:10px; margin-bottom:10px; overflow:hidden; background:var(--surface); }
  details.group > summary { list-style:none; cursor:pointer; padding:12px 16px; display:flex; align-items:center; gap:10px; font-weight:600; color:var(--fg); }
  details.group > summary::-webkit-details-marker { display:none; }
  .badge { background:var(--primary); color:#fff; border-radius:999px; padding:1px 10px; font-size:12.5px; font-family:"Fira Code",monospace; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:9px 12px; border-top:1px solid var(--muted); vertical-align:top; font-size:13.5px; }
  th { color:var(--text-muted); font-weight:500; font-size:11.5px; text-transform:uppercase; letter-spacing:.04em; }
  tr:hover td { background:#F8FBFF; }
  .tag { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11.5px; background:#F0FDF4; color:#15803D; margin:2px 4px 2px 0; }
  .num { font-family:"Fira Code",monospace; color:var(--text-muted); font-size:12px; }
  .downloads { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
  .empty { text-align:center; color:var(--text-muted); padding:40px 16px; }
  .warn { background:#FFFBEB; border:1px solid #FDE68A; color:#92400E; border-radius:10px; padding:12px 14px; font-size:13.5px; }
  .hidden { display:none; }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot"></span>parser_whats</div>
  <div class="pill" id="statusPill"><span class="led"></span><span id="statusText">подключение…</span></div>
</header>
<main>
  <div id="connect" class="card center hidden"></div>
  <div id="groupsCard" class="card hidden">
    <h2>Ваши группы</h2>
    <div class="hint">Выбери группу для парсинга. Собираются профили и сообщения, затем определяется, кто чем занимается.</div>
    <input class="search" id="groupSearch" placeholder="Поиск группы…" aria-label="Поиск группы" />
    <div id="groupList" style="margin-top:12px"></div>
  </div>
  <div id="jobCard" class="card hidden">
    <h2 id="jobTitle">Парсинг</h2>
    <div class="steps" id="steps"></div>
    <div class="log" id="log" aria-live="polite"></div>
  </div>
  <div id="resultsCard" class="card hidden">
    <h2>Результат по направлениям</h2>
    <div class="downloads" id="downloads"></div>
    <input class="search" id="resultSearch" placeholder="Поиск по имени / занятию…" aria-label="Поиск по результату" />
    <div id="results" style="margin-top:12px"></div>
  </div>
</main>
<script>
const esc = (s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $ = (id)=>document.getElementById(id);
const STEP_LABELS = { scrape:'Сбор', enrich:'Классификация', match:'Группировка', export:'Выгрузка' };
let GROUPS=[]; let RESULTS=null; let groupsLoaded=false; let lastJobDone=false; let gQuery=''; let rQuery='';

const CHECK='<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 10.5l4 4 8-9"/></svg>';
const SPIN='<span class="spinner" style="width:15px;height:15px;border-width:2px;margin:0"></span>';

function setStatus(cls, text){
  const p=$('statusPill'); p.className='pill '+cls; $('statusText').textContent=text;
}

function renderConnect(st){
  const c=$('connect');
  if(st.state==='ready'){ c.classList.add('hidden'); return; }
  c.classList.remove('hidden');
  if(st.state==='qr'){
    const img = st.qrDataUrl
      ? '<img class="qr" alt="QR-код для входа в WhatsApp" src="'+st.qrDataUrl+'">'
      : '<div class="warn">QR не удалось отрисовать в браузере. Он напечатан в терминале — отсканируй оттуда. Для картинки здесь: <code>npm i qrcode</code></div>';
    c.innerHTML='<h2>Вход в WhatsApp</h2><div class="hint">Телефон → Настройки → Связанные устройства → Привязать устройство, и отсканируй код.</div>'+img;
  } else if(st.state==='error'){
    c.innerHTML='<h2 style="color:var(--destructive)">Ошибка подключения</h2><div class="warn">'+esc(st.error||'неизвестно')+'</div>';
  } else {
    const pct = st.state==='loading' ? st.loadingPercent+'%' : '';
    c.innerHTML='<h2>Подключение к WhatsApp</h2><div class="spinner"></div><div class="hint">'+
      (st.state==='loading'?('Синхронизация… '+pct):'Запуск клиента…')+'</div>'+
      (st.state==='loading'?'<div class="progress-bar"><i style="width:'+st.loadingPercent+'%"></i></div>':'');
  }
}

function renderGroups(){
  const list=$('groupList');
  const items=GROUPS.filter(g=>!gQuery||g.name.toLowerCase().includes(gQuery));
  if(!items.length){ list.innerHTML='<div class="empty">Групп не найдено.</div>'; return; }
  list.innerHTML=items.map(g=>
    '<div class="group-row"><div class="info"><div class="name">'+esc(g.name)+'</div>'+
    '<div class="count">'+g.participantCount+' участников</div></div>'+
    '<button class="btn sm" data-id="'+esc(g.id)+'" data-name="'+esc(g.name)+'">Парсить</button></div>'
  ).join('');
  list.querySelectorAll('button[data-id]').forEach(b=>b.addEventListener('click',()=>startParse(b.dataset.id,b.dataset.name)));
}

async function startParse(id,name){
  document.querySelectorAll('#groupList button').forEach(b=>b.disabled=true);
  await fetch('/api/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:id,groupName:name})});
}

function renderJob(job){
  const card=$('jobCard');
  if(job.stepIndex<0 && !job.done && !job.running){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('jobTitle').textContent = 'Парсинг' + (job.groupName?': '+job.groupName:'');
  $('steps').innerHTML = job.steps.map((s,i)=>{
    let cls='step', ic='';
    if(job.done||i<job.stepIndex){ cls+=' done'; ic=CHECK; }
    else if(i===job.stepIndex && job.running){ cls+=' active'; ic=SPIN; }
    return '<div class="'+cls+'">'+ic+'<span>'+(STEP_LABELS[s]||s)+'</span></div>';
  }).join('');
  const logEl=$('log');
  const atBottom = logEl.scrollTop+logEl.clientHeight >= logEl.scrollHeight-30;
  logEl.innerHTML = job.log.map(l=>{
    let c=''; if(l.startsWith('✓')) c='ok'; else if(l.startsWith('✗')) c='err'; else if(l.startsWith('▶')) c='run';
    return '<div class="'+c+'">'+esc(l)+'</div>';
  }).join('');
  if(atBottom) logEl.scrollTop=logEl.scrollHeight;
}

function renderResults(){
  const card=$('resultsCard');
  if(!RESULTS){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('downloads').innerHTML =
    ['xlsx','csv','json'].map(k=>'<a class="btn ghost sm" href="/download/'+k+'">Скачать '+k.toUpperCase()+'</a>').join('');
  const groups=(RESULTS.groups||[]).map(g=>{
    const people=g.people.filter(p=>!rQuery||(p.label+' '+(p.occupation||'')+' '+g.category+' '+(p.services||[]).join(' ')).toLowerCase().includes(rQuery));
    if(!people.length) return '';
    const rows=people.map(p=>
      '<tr><td><div>'+esc(p.label)+'</div><div class="num">'+esc(p.number||'')+'</div></td>'+
      '<td>'+esc(p.occupation||p.summary||'—')+((p.services||[]).length?'<div>'+p.services.map(s=>'<span class="tag">'+esc(s)+'</span>').join('')+'</div>':'')+'</td>'+
      '<td>'+esc(p.location||'')+'</td><td class="num">'+(p.confidence!=null?Math.round(p.confidence*100)+'%':'')+'</td></tr>').join('');
    return '<details class="group" open><summary>'+esc(g.category)+'<span class="badge">'+people.length+'</span></summary>'+
      '<table><thead><tr><th>Человек</th><th>Чем занимается</th><th>Локация</th><th>Увер.</th></tr></thead><tbody>'+rows+'</tbody></table></details>';
  }).join('');
  $('results').innerHTML = groups || '<div class="empty">Ничего не найдено.</div>';
}

async function loadGroups(){ const r=await fetch('/api/groups'); const d=await r.json(); GROUPS=d.groups||[]; groupsLoaded=true; renderGroups(); }
async function loadResults(){ try{ const r=await fetch('/api/results'); if(r.ok){ RESULTS=await r.json(); renderResults(); } }catch(e){} }

async function tick(){
  try{
    const st=await (await fetch('/api/status')).json();
    // status pill
    if(st.state==='ready'){ setStatus('ready','подключено'); }
    else if(st.state==='error'){ setStatus('err','ошибка'); }
    else { setStatus('busy', st.state==='qr'?'ждёт QR':(st.state==='loading'?'синхронизация':'подключение')); }
    if(st.job && st.job.running) setStatus('busy','парсинг…');

    renderConnect(st);
    if(st.state==='ready'){
      $('groupsCard').classList.remove('hidden');
      if(!groupsLoaded && !(st.job&&st.job.running)) loadGroups();
    } else {
      $('groupsCard').classList.add('hidden');
    }
    renderJob(st.job||{stepIndex:-1});
    if(st.job && st.job.done && !lastJobDone){ lastJobDone=true; loadResults(); groupsLoaded=false; }
    if(st.job && !st.job.done) lastJobDone=false;
  }catch(e){ setStatus('err','нет связи с сервером'); }
}

$('groupSearch').addEventListener('input',e=>{gQuery=e.target.value.trim().toLowerCase(); renderGroups();});
$('resultSearch').addEventListener('input',e=>{rQuery=e.target.value.trim().toLowerCase(); renderResults();});
tick(); setInterval(tick,1300);
</script>
</body>
</html>`;
