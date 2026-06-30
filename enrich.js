/**
 * enrich.js  (stage 2 of 4)
 * -------------------------
 * Reads data/group_export.json and, for every member that has any text
 * (pushname + about + their messages), asks the LLM (GigaChat) what that person
 * does for a living. Writes data/enriched.json.
 *
 * Output per member adds an `occupation` object:
 *   { occupation, category, services[], location, confidence, summary }
 *
 * Members with no text are kept but marked as unknown (confidence 0) so the
 * final export still accounts for everyone.
 *
 * Results are cached in data/enrich_cache.json keyed by a hash of the input
 * text, so re-running doesn't re-spend the API quota on unchanged members.
 *
 * Usage:  node enrich.js     (or: npm run enrich)
 */

const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const { GigaChat, parseJsonLoose } = require('./lib/gigachat');

// ---- Build the text blob we send to the LLM for one member ----------------

function memberText(m) {
  const parts = [];
  if (m.pushname) parts.push(`Имя в WhatsApp: ${m.pushname}`);
  if (m.name) parts.push(`Сохранённое имя: ${m.name}`);
  if (m.about && m.about.trim()) parts.push(`Статус: ${m.about.trim()}`);
  const msgs = (m.messages || []).map((x) => x.body).filter(Boolean);
  if (msgs.length) parts.push(`Сообщения:\n${msgs.join('\n')}`);
  let blob = parts.join('\n');
  if (blob.length > config.llm.maxCharsPerMember) {
    blob = blob.slice(0, config.llm.maxCharsPerMember);
  }
  return blob;
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

// ---- Prompt ---------------------------------------------------------------

const SYSTEM_PROMPT =
  'Ты аналитик. По тексту участника чата (имя, статус, сообщения) определи, ' +
  'чем человек занимается профессионально или какой у него бизнес. ' +
  'Отвечай СТРОГО одним JSON-объектом без пояснений и без markdown, по схеме:\n' +
  '{\n' +
  '  "occupation": "краткое чем занимается, напр. \'поставки товаров из Китая\'",\n' +
  '  "category": "одна обобщённая категория, напр. \'Логистика и ВЭД\', \'Недвижимость\', \'IT и разработка\'",\n' +
  '  "services": ["конкретные услуги/товары"],\n' +
  '  "location": "город/страна если есть, иначе \'\'",\n' +
  '  "confidence": 0.0,\n' +
  '  "summary": "одно короткое предложение"\n' +
  '}\n' +
  'confidence — насколько ты уверен (0..1). Если данных мало или не понятно, ' +
  'ставь низкий confidence и category "Неизвестно / нет данных". Не выдумывай.';

function buildMessages(text) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Текст участника:\n${text}` },
  ];
}

const UNKNOWN = (reason) => ({
  occupation: '',
  category: config.unknownCategory,
  services: [],
  location: '',
  confidence: 0,
  summary: reason || 'Недостаточно данных',
});

function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return UNKNOWN('Не удалось распарсить ответ');
  return {
    occupation: String(parsed.occupation || '').trim(),
    category: String(parsed.category || config.unknownCategory).trim() || config.unknownCategory,
    services: Array.isArray(parsed.services)
      ? parsed.services.map((s) => String(s).trim()).filter(Boolean)
      : [],
    location: String(parsed.location || '').trim(),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    summary: String(parsed.summary || '').trim(),
  };
}

// ---- Tiny concurrency limiter (no external deps) --------------------------

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// ---- Cache ----------------------------------------------------------------

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(config.paths.enrichCache, 'utf8'));
  } catch (err) {
    return {};
  }
}
function saveCache(cache) {
  fs.writeFileSync(config.paths.enrichCache, JSON.stringify(cache, null, 2), 'utf8');
}

// ---- Main -----------------------------------------------------------------

async function main() {
  if (!fs.existsSync(config.paths.export)) {
    console.error(`Not found: ${config.paths.export}. Run "node scrape.js" first.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(config.paths.export, 'utf8'));
  const members = data.members || [];
  console.log(`Loaded ${members.length} members.`);

  const client = new GigaChat({
    ...config.llm.gigachat,
    maxRetries: config.llm.maxRetries,
    requestTimeoutMs: config.llm.requestTimeoutMs,
  });
  try {
    client.assertConfigured();
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  const cache = loadCache();
  let llmCalls = 0;
  let cacheHits = 0;
  let skipped = 0;
  let done = 0;

  const enriched = await mapLimit(members, config.llm.concurrency, async (m) => {
    const text = memberText(m);
    if (!text.trim()) {
      skipped++;
      return { ...m, occupation: UNKNOWN('Нет текста (молчун/приватность)') };
    }

    const key = hashText(text);
    if (cache[key]) {
      cacheHits++;
      return { ...m, occupation: cache[key] };
    }

    let occupation;
    try {
      const reply = await client.chat(buildMessages(text));
      occupation = normalizeResult(parseJsonLoose(reply));
      cache[key] = occupation;
      llmCalls++;
    } catch (err) {
      occupation = UNKNOWN(`Ошибка LLM: ${err.message}`);
    }
    done++;
    if (done % 5 === 0) {
      process.stdout.write(`\r  classified ${done} via LLM...`);
      saveCache(cache); // periodic checkpoint
    }
    return { ...m, occupation };
  });

  process.stdout.write('\n');
  saveCache(cache);

  const output = {
    enrichedAt: new Date().toISOString(),
    sourceExportedAt: data.exportedAt || null,
    group: data.group || null,
    model: config.llm.gigachat.model,
    memberCount: enriched.length,
    members: enriched,
  };
  fs.writeFileSync(config.paths.enriched, JSON.stringify(output, null, 2), 'utf8');

  const classified = enriched.filter((m) => m.occupation.confidence > 0).length;
  console.log(`\nDone. Wrote ${config.paths.enriched}`);
  console.log(`  LLM calls: ${llmCalls}, cache hits: ${cacheHits}, no-text: ${skipped}`);
  console.log(`  classified with confidence>0: ${classified}/${enriched.length}`);
  console.log(`\nNext: node match.js  (group people by what they do)`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
