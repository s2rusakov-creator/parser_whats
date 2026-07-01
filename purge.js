/**
 * purge.js
 * --------
 * Deletes locally stored personal data: the scraped export (phone numbers +
 * messages) and the generated exports. Run it when you're done with a batch so
 * PII isn't sitting on disk longer than needed.
 *
 * It deliberately does NOT touch .wwebjs_auth (your WhatsApp login) — removing
 * that logs you out and is a separate, explicit action (see the printed hint).
 *
 * Usage:  node purge.js   (or: npm run purge)
 */

const fs = require('fs');
const config = require('./config');

for (const dir of [config.paths.dataDir, config.paths.outDir]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('Удалены data/ и out/ — собранные номера, сообщения и выгрузки стёрты.');
console.log('');
console.log('Сессия WhatsApp (.wwebjs_auth) НЕ тронута.');
console.log('Чтобы ещё и выйти из аккаунта (и отвязать устройство):');
console.log('  Remove-Item -Recurse -Force .wwebjs_auth');
