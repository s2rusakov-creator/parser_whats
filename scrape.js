/**
 * scrape.js  (stage 1 of 4)
 * -------------------------
 * Logs into WhatsApp Web (QR), lets you pick a group, then exports each
 * participant's profile (number, names, "about"/status, admin flag) AND their
 * recent messages in that group to data/group_export.json.
 *
 * Compared to a naive export, this version:
 *   - waits for the contact list to finish syncing (so pushname/about populate),
 *   - actively loads message history into memory before reading it (otherwise
 *     fetchMessages returns almost nothing on a fresh session),
 *   - is resilient to per-contact failures, paces requests, and
 *   - prints a data-quality summary so you immediately see how much was caught.
 *
 * Usage:  node scrape.js     (or: npm run scrape)
 *
 * NOTE: Automating WhatsApp Web violates WhatsApp's ToS and can get your number
 * banned. Use only on groups you own/have permission to export. At your own risk.
 */

const fs = require('fs');
const readline = require('readline');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Small helpers --------------------------------------------------------

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getAbout(contact) {
  try {
    const about = await contact.getAbout();
    return about || null;
  } catch (err) {
    return null;
  }
}

/**
 * Wait until WhatsApp Web has synced the contact list, so that pushname/about
 * are actually available. On a cold session these are empty for a while.
 */
async function waitForSync(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  while (Date.now() < deadline) {
    let count = 0;
    try {
      const contacts = await client.getContacts();
      count = contacts.length;
    } catch (err) {
      /* not ready yet */
    }
    // Consider it synced once we have a non-trivial, stable contact count.
    if (count > 0 && count === lastCount) {
      console.log(`Contacts synced (${count}).`);
      return;
    }
    if (count > 0) console.log(`Syncing contacts... (${count})`);
    lastCount = count;
    await sleep(2500);
  }
  console.warn('Sync wait timed out — continuing with whatever is available.');
}

/**
 * Load older messages of a chat into memory, then return up to `target`.
 * whatsapp-web.js only exposes messages already loaded in WhatsApp Web's store,
 * so we repeatedly pull history before reading.
 */
async function loadHistory(chat, target, rounds, delayMs) {
  let messages = [];
  for (let i = 0; i < rounds; i++) {
    try {
      messages = await chat.fetchMessages({ limit: target });
    } catch (err) {
      console.warn(`  fetchMessages failed: ${err.message}`);
      break;
    }
    process.stdout.write(`\r  loaded ${messages.length}/${target} messages...`);
    if (messages.length >= target) break;

    if (typeof chat.loadEarlierMessages === 'function') {
      try {
        await chat.loadEarlierMessages();
      } catch (err) {
        break; // no more history available
      }
    } else {
      break; // library version can't load more; use what we have
    }
    await sleep(delayMs);
  }
  process.stdout.write('\n');
  return messages;
}

// ---- Main -----------------------------------------------------------------

async function main() {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: config.scrape.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    console.log('\nScan this QR with WhatsApp (Settings > Linked Devices):\n');
    qrcode.generate(qr, { small: true });
  });
  client.on('authenticated', () => console.log('Authenticated. Session cached.'));
  client.on('loading_screen', (p, m) => console.log(`Loading: ${p}% ${m || ''}`));
  client.on('auth_failure', (m) => console.error('Authentication failed:', m));

  client.on('ready', async () => {
    try {
      await run(client);
    } catch (err) {
      console.error('\nError during export:', err);
    } finally {
      await client.destroy();
      process.exit(0);
    }
  });

  console.log('Starting WhatsApp client... (this can take a few seconds)');
  await client.initialize();
}

async function run(client) {
  console.log('\nWaiting for contacts to sync...');
  await waitForSync(client, config.scrape.syncTimeoutMs);

  console.log('Fetching your chats...');
  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);
  if (groups.length === 0) {
    console.log('No groups found on this account.');
    return;
  }

  console.log('\nGroups found:\n');
  groups.forEach((g, i) => {
    const count = g.participants ? g.participants.length : '?';
    console.log(`  [${i + 1}] ${g.name}  (${count} participants)`);
  });

  const choice = await ask('\nEnter the number of the group to export: ');
  const index = parseInt(choice, 10) - 1;
  if (Number.isNaN(index) || index < 0 || index >= groups.length) {
    console.log('Invalid selection. Aborting.');
    return;
  }

  const group = groups[index];
  console.log(`\nExporting "${group.name}"...`);

  // --- 1. Load + bucket messages by sender. ---
  console.log(`Loading message history (target ${config.scrape.messageTarget})...`);
  const messages = await loadHistory(
    group,
    config.scrape.messageTarget,
    config.scrape.scrollRounds,
    config.scrape.scrollDelayMs
  );

  const messagesByAuthor = {};
  for (const msg of messages) {
    const authorId = msg.author || msg.from;
    if (!authorId || !msg.body) continue;
    (messagesByAuthor[authorId] ||= []).push({
      body: msg.body,
      timestamp: msg.timestamp,
      type: msg.type,
    });
  }

  // --- 2. Enrich each participant. ---
  const participants = group.participants || [];
  console.log(`Enriching ${participants.length} participants...`);

  const members = [];
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    const contactId = p.id._serialized;
    let contact = null;
    try {
      contact = await client.getContactById(contactId);
    } catch (err) {
      /* tolerate */
    }

    members.push({
      id: contactId,
      number: p.id.user,
      name: contact ? contact.name || null : null,
      pushname: contact ? contact.pushname || null : null,
      isAdmin: !!p.isAdmin || !!p.isSuperAdmin,
      about: contact ? await getAbout(contact) : null,
      messages: messagesByAuthor[contactId] || [],
    });

    process.stdout.write(`\r  ${i + 1}/${participants.length}`);
    if (config.scrape.contactDelayMs) await sleep(config.scrape.contactDelayMs);
  }
  process.stdout.write('\n');

  // --- 3. Assemble + write. ---
  const exportData = {
    exportedAt: new Date().toISOString(),
    group: {
      id: group.id._serialized,
      name: group.name,
      participantCount: participants.length,
    },
    messageFetchTarget: config.scrape.messageTarget,
    messagesLoaded: messages.length,
    members,
  };
  fs.writeFileSync(config.paths.export, JSON.stringify(exportData, null, 2), 'utf8');

  // --- 4. Data-quality summary. ---
  const withPush = members.filter((m) => m.pushname).length;
  const withAbout = members.filter((m) => m.about && m.about.trim()).length;
  const withMsgs = members.filter((m) => m.messages.length).length;
  const usable = members.filter(
    (m) => m.pushname || (m.about && m.about.trim()) || m.messages.length
  ).length;

  console.log(`\nDone. Wrote ${members.length} members to ${config.paths.export}`);
  console.log('--- Data quality ---');
  console.log(`  messages loaded:     ${messages.length}`);
  console.log(`  with pushname:       ${withPush}/${members.length}`);
  console.log(`  with about/status:   ${withAbout}/${members.length}`);
  console.log(`  with >=1 message:    ${withMsgs}/${members.length}`);
  console.log(`  usable for matching: ${usable}/${members.length}`);
  if (usable === 0) {
    console.log(
      '\n  No usable signal. Either the group is silent / privacy-locked,\n' +
        '  or sync was incomplete. Try a more active group or re-run.'
    );
  } else {
    console.log(`\nNext: node enrich.js  (classify what each person does)`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
