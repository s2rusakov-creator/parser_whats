/**
 * lib/whatsapp.js
 * ---------------
 * Singleton that owns the whatsapp-web.js client for the web control panel
 * (server.js). It tracks connection state, exposes the QR for browser login,
 * lists groups, and scrapes a chosen group into data/group_export.json while
 * reporting progress.
 *
 * The terminal CLI (scrape.js) still works independently; use one or the other
 * at a time — they share the same cached session (.wwebjs_auth/).
 */

const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optional: render the QR as an <img> in the browser if `qrcode` is installed.
// Falls back to the terminal QR (always printed) when the package is absent.
let QRCode = null;
try {
  QRCode = require('qrcode');
} catch (err) {
  /* optional */
}

async function getAbout(contact) {
  try {
    return (await contact.getAbout()) || null;
  } catch (err) {
    return null;
  }
}

async function loadHistory(chat, target, rounds, delayMs, onProgress) {
  let messages = [];
  for (let i = 0; i < rounds; i++) {
    try {
      messages = await chat.fetchMessages({ limit: target });
    } catch (err) {
      break;
    }
    onProgress && onProgress(`Загрузка сообщений: ${messages.length}/${target}`);
    if (messages.length >= target) break;
    if (typeof chat.loadEarlierMessages === 'function') {
      try {
        await chat.loadEarlierMessages();
      } catch (err) {
        break;
      }
    } else {
      break;
    }
    await sleep(delayMs);
  }
  return messages;
}

class WhatsAppManager {
  constructor() {
    this.state = 'idle'; // idle | starting | qr | authenticated | loading | ready | error
    this.qr = null;
    this.qrDataUrl = null;
    this.loadingPercent = 0;
    this.error = null;
    this.client = null;

    this.job = {
      running: false,
      groupName: null,
      steps: ['scrape', 'enrich', 'match', 'export'],
      stepIndex: -1,
      step: null,
      log: [],
      done: false,
      error: null,
      stats: null,
    };
  }

  start() {
    if (this.client) return;
    this.state = 'starting';
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    });

    this.client.on('qr', async (qr) => {
      this.qr = qr;
      this.state = 'qr';
      try {
        qrcodeTerminal.generate(qr, { small: true });
      } catch (err) {
        /* ignore */
      }
      if (QRCode) {
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 288 });
        } catch (err) {
          this.qrDataUrl = null;
        }
      }
    });
    this.client.on('authenticated', () => {
      this.state = 'authenticated';
      this.qr = null;
      this.qrDataUrl = null;
    });
    this.client.on('loading_screen', (p) => {
      this.state = 'loading';
      this.loadingPercent = Number(p) || 0;
    });
    this.client.on('ready', () => {
      this.state = 'ready';
    });
    this.client.on('auth_failure', (m) => {
      this.state = 'error';
      this.error = String(m);
    });
    this.client.on('disconnected', (r) => {
      this.state = 'error';
      this.error = `disconnected: ${r}`;
    });

    this.client.initialize().catch((e) => {
      this.state = 'error';
      this.error = e.message;
    });
  }

  status() {
    return {
      state: this.state,
      loadingPercent: this.loadingPercent,
      qrDataUrl: this.qrDataUrl,
      qrImageAvailable: !!QRCode,
      error: this.error,
      job: {
        running: this.job.running,
        groupName: this.job.groupName,
        steps: this.job.steps,
        stepIndex: this.job.stepIndex,
        step: this.job.step,
        log: this.job.log.slice(-40),
        done: this.job.done,
        error: this.job.error,
        stats: this.job.stats,
      },
    };
  }

  log(line) {
    this.job.log.push(line);
    if (this.job.log.length > 500) this.job.log.shift();
  }

  async getGroups() {
    if (this.state !== 'ready') throw new Error('WhatsApp ещё не готов');
    const chats = await this.client.getChats();
    return chats
      .filter((c) => c.isGroup)
      .map((g) => ({
        id: g.id._serialized,
        name: g.name || '(без названия)',
        participantCount: (g.participants || []).length,
      }))
      .sort((a, b) => b.participantCount - a.participantCount);
  }

  async scrapeGroup(groupId, onProgress) {
    const chats = await this.client.getChats();
    const group = chats.find((c) => c.isGroup && c.id._serialized === groupId);
    if (!group) throw new Error('Группа не найдена');

    onProgress(`Открываю "${group.name}", загружаю историю...`);
    const messages = await loadHistory(
      group,
      config.scrape.messageTarget,
      config.scrape.scrollRounds,
      config.scrape.scrollDelayMs,
      onProgress
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

    const participants = group.participants || [];
    const members = [];
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      const contactId = p.id._serialized;
      let contact = null;
      try {
        contact = await this.client.getContactById(contactId);
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
      if ((i + 1) % 10 === 0 || i + 1 === participants.length) {
        onProgress(`Участники: ${i + 1}/${participants.length}`);
      }
      if (config.scrape.contactDelayMs) await sleep(config.scrape.contactDelayMs);
    }

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
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    fs.writeFileSync(config.paths.export, JSON.stringify(exportData, null, 2), 'utf8');

    const usable = members.filter(
      (m) => m.pushname || (m.about && m.about.trim()) || m.messages.length
    ).length;
    const stats = {
      members: members.length,
      messages: messages.length,
      usable,
      withMsgs: members.filter((m) => m.messages.length).length,
    };
    onProgress(
      `Собрано: ${stats.members} участников, ${stats.messages} сообщений, годных для анализа ${stats.usable}.`
    );
    return stats;
  }
}

module.exports = new WhatsAppManager();
