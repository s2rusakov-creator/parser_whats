/**
 * scrape.js
 * ---------
 * Logs into WhatsApp Web (via QR code), lets you pick a group, then exports
 * that group's participants + their profile "about"/status + recent messages
 * to data/group_export.json.
 *
 * Backed by whatsapp-web.js (Puppeteer automation of WhatsApp Web).
 *
 * Usage:
 *   npm install
 *   node scrape.js
 *
 * On first run, scan the QR code printed to the terminal with your phone
 * (WhatsApp > Settings > Linked Devices > Link a Device). The session is
 * cached in .wwebjs_auth/ so subsequent runs skip the QR step.
 *
 * NOTE: Automating WhatsApp Web is against WhatsApp's Terms of Service and may
 * get your number banned. Use on accounts/groups you own, at your own risk.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// ---- Config ---------------------------------------------------------------

// How many recent messages to pull per group (across all senders).
const MESSAGE_FETCH_LIMIT = 500;

const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'group_export.json');

// ---- Small helpers --------------------------------------------------------

/** Prompt the user for a line of input on the terminal. */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Safely pull the "about"/status text for a contact, tolerating failures. */
async function getAbout(contact) {
  try {
    // getAbout() is available on Contact in whatsapp-web.js; may be null if the
    // contact hides their status or it's unavailable.
    const about = await contact.getAbout();
    return about || null;
  } catch (err) {
    return null;
  }
}

// ---- Main -----------------------------------------------------------------

async function main() {
  // Ensure the output directory exists before we do any work.
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const client = new Client({
    // LocalAuth caches the session under .wwebjs_auth/ so you only scan once.
    authStrategy: new LocalAuth(),
    puppeteer: {
      // headless:false opens a real Chrome window so you can watch WhatsApp Web
      // load and see where it gets stuck. Set back to true once it works.
      headless: false,
      // These args make Puppeteer happier in restricted/headless environments.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  // --- Wire up client lifecycle events ---

  client.on('qr', (qr) => {
    console.log('\nScan this QR code with WhatsApp (Settings > Linked Devices):\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('Authenticated. Session cached for next time.');
  });

  // Shows sync progress (0-100%) while WhatsApp Web loads after auth. If this
  // stalls below 100, that's where the hang is.
  client.on('loading_screen', (percent, message) => {
    console.log(`Loading: ${percent}% ${message || ''}`);
  });

  client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
  });

  client.on('ready', async () => {
    try {
      await run(client);
    } catch (err) {
      console.error('\nError during export:', err);
    } finally {
      // Clean shutdown so the Node process can exit.
      await client.destroy();
      process.exit(0);
    }
  });

  console.log('Starting WhatsApp client... (this can take a few seconds)');
  await client.initialize();
}

/** Core export flow: list groups, pick one, dump participants + messages. */
async function run(client) {
  console.log('\nFetching your chats...');
  const chats = await client.getChats();
  const groups = chats.filter((chat) => chat.isGroup);

  if (groups.length === 0) {
    console.log('No groups found on this account.');
    return;
  }

  // Show the user a numbered list of groups to choose from.
  console.log('\nGroups found:\n');
  groups.forEach((group, i) => {
    const count = group.participants ? group.participants.length : '?';
    console.log(`  [${i + 1}] ${group.name}  (${count} participants)`);
  });

  const choice = await ask('\nEnter the number of the group to export: ');
  const index = parseInt(choice, 10) - 1;

  if (Number.isNaN(index) || index < 0 || index >= groups.length) {
    console.log('Invalid selection. Aborting.');
    return;
  }

  const group = groups[index];
  console.log(`\nExporting "${group.name}"...`);

  // --- 1. Pull recent messages once, then bucket them per participant. ---
  console.log(`Fetching up to ${MESSAGE_FETCH_LIMIT} recent messages...`);
  let messages = [];
  try {
    messages = await group.fetchMessages({ limit: MESSAGE_FETCH_LIMIT });
  } catch (err) {
    console.warn('Could not fetch messages:', err.message);
  }

  // Group message bodies by sender id (e.g. "1234567890@c.us").
  const messagesByAuthor = {};
  for (const msg of messages) {
    // For group chats, msg.author is the participant; fall back to msg.from.
    const authorId = msg.author || msg.from;
    if (!authorId) continue;
    if (!messagesByAuthor[authorId]) messagesByAuthor[authorId] = [];
    if (msg.body) {
      messagesByAuthor[authorId].push({
        body: msg.body,
        timestamp: msg.timestamp, // unix seconds
        type: msg.type,
      });
    }
  }

  // --- 2. Walk the participant list, enriching each with contact info. ---
  const participants = group.participants || [];
  console.log(`Enriching ${participants.length} participants...`);

  const members = [];
  for (const p of participants) {
    const contactId = p.id._serialized; // e.g. "1234567890@c.us"
    let contact;
    try {
      contact = await client.getContactById(contactId);
    } catch (err) {
      contact = null;
    }

    const member = {
      id: contactId,
      number: p.id.user, // bare phone number
      name: contact ? (contact.name || null) : null, // saved name (if in your contacts)
      pushname: contact ? (contact.pushname || null) : null, // self-set display name
      isAdmin: !!p.isAdmin || !!p.isSuperAdmin,
      about: contact ? await getAbout(contact) : null,
      messages: messagesByAuthor[contactId] || [],
    };
    members.push(member);
  }

  // --- 3. Assemble and write the export. ---
  const exportData = {
    exportedAt: new Date().toISOString(),
    group: {
      id: group.id._serialized,
      name: group.name,
      participantCount: participants.length,
    },
    messageFetchLimit: MESSAGE_FETCH_LIMIT,
    members,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(exportData, null, 2), 'utf8');
  console.log(`\nDone. Wrote ${members.length} members to ${OUTPUT_FILE}`);
  console.log('Next step: run "node match.js" to generate match suggestions.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
