/**
 * config.js
 * ---------
 * Central configuration for the whole pipeline. Every script imports this so
 * paths and tunables live in one place. Values can be overridden via a .env
 * file in the project root (see .env.example).
 */

require('./lib/env').load();
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'out');

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}
function envBool(name, fallback) {
  const v = process.env[name];
  if (v == null) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

module.exports = {
  paths: {
    dataDir: DATA_DIR,
    outDir: OUT_DIR,
    export: path.join(DATA_DIR, 'group_export.json'), // stage 1 output (raw)
    enriched: path.join(DATA_DIR, 'enriched.json'), // stage 2 output (LLM)
    grouped: path.join(DATA_DIR, 'grouped.json'), // stage 3 output (grouped)
    enrichCache: path.join(DATA_DIR, 'enrich_cache.json'), // LLM result cache
  },

  scrape: {
    // Open a visible Chrome window so you can watch WhatsApp Web load. Set
    // SCRAPE_HEADLESS=1 once it works reliably.
    headless: envBool('SCRAPE_HEADLESS', false),
    // How many recent group messages to try to load into memory before
    // bucketing them per participant. Higher = more text per person, slower.
    messageTarget: envInt('SCRAPE_MESSAGE_TARGET', 3000),
    // Max history-load rounds (each round pulls older messages into memory).
    scrollRounds: envInt('SCRAPE_SCROLL_ROUNDS', 25),
    // Pause between history-load rounds (ms) — gentler on WhatsApp Web.
    scrollDelayMs: envInt('SCRAPE_SCROLL_DELAY_MS', 700),
    // Pause between per-contact lookups (ms) — anti-ban / avoid rate limits.
    contactDelayMs: envInt('SCRAPE_CONTACT_DELAY_MS', 200),
    // How long to wait for the contact list to sync after login (ms).
    syncTimeoutMs: envInt('SCRAPE_SYNC_TIMEOUT_MS', 120000),
    // Pin the WhatsApp Web build to a known-good version. Without this the
    // client often hangs at "Loading 99%" before the `ready` event when the
    // library's bundled version drifts from live WhatsApp Web. Update the
    // version in the URL (or via WWEB_REMOTE_PATH) if it ever hangs again —
    // latest list: https://github.com/wppconnect-team/wa-version
    webRemotePath:
      process.env.WWEB_REMOTE_PATH ||
      'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1042455848-alpha.html',
  },

  llm: {
    provider: process.env.LLM_PROVIDER || 'gigachat',
    // GigaChat credentials / options (see .env.example).
    gigachat: {
      // Provide EITHER the ready-made base64 Authorization key...
      authKey: process.env.GIGACHAT_AUTH_KEY || '',
      // ...OR the Client ID + Client Secret separately — the client will
      // base64-encode "id:secret" for you.
      clientId: process.env.GIGACHAT_CLIENT_ID || '',
      clientSecret: process.env.GIGACHAT_CLIENT_SECRET || '',
      scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
      model: process.env.GIGACHAT_MODEL || 'GigaChat-Pro',
      // GigaChat uses Russian Ministry-of-Digital-Development root certs that
      // Node may not trust on Windows. Point this at the CA bundle, or set
      // GIGACHAT_INSECURE_TLS=1 to skip verification (less safe).
      caCertPath: process.env.GIGACHAT_CA_CERT || '',
      insecureTls: envBool('GIGACHAT_INSECURE_TLS', false),
      oauthUrl:
        process.env.GIGACHAT_OAUTH_URL ||
        'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
      apiUrl:
        process.env.GIGACHAT_API_URL ||
        'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
    },
    // How many members to enrich in parallel. Keep low to respect rate limits.
    concurrency: envInt('LLM_CONCURRENCY', 3),
    maxRetries: envInt('LLM_MAX_RETRIES', 4),
    requestTimeoutMs: envInt('LLM_TIMEOUT_MS', 60000),
    // Cap the text sent per member so prompts stay small/cheap.
    maxCharsPerMember: envInt('LLM_MAX_CHARS', 4000),
  },

  // Canonical category aliases for the grouping step. Map any synonym (lower
  // case) the LLM might emit to a single clean category name. Extend freely.
  categoryAliases: {
    'недвижимость': 'Недвижимость',
    'риелтор': 'Недвижимость',
    'realty': 'Недвижимость',
    'real estate': 'Недвижимость',
    'логистика': 'Логистика и ВЭД',
    'карго': 'Логистика и ВЭД',
    'грузоперевозки': 'Логистика и ВЭД',
    'ит': 'IT и разработка',
    'it': 'IT и разработка',
    'разработка': 'IT и разработка',
    'программист': 'IT и разработка',
    'маркетинг': 'Маркетинг и реклама',
    'smm': 'Маркетинг и реклама',
    'реклама': 'Маркетинг и реклама',
    'дизайн': 'Дизайн',
    'бьюти': 'Бьюти и здоровье',
    'красота': 'Бьюти и здоровье',
    'медицина': 'Бьюти и здоровье',
    'финансы': 'Финансы',
    'инвестиции': 'Финансы',
    'крипта': 'Финансы',
    'строительство': 'Строительство и ремонт',
    'ремонт': 'Строительство и ремонт',
    'образование': 'Образование',
    'обучение': 'Образование',
    'торговля': 'Торговля и товары',
    'продажи': 'Торговля и товары',
  },

  // Label used for members we couldn't classify (no text / silent members).
  unknownCategory: 'Неизвестно / нет данных',
};
