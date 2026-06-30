# contacts-viewer

Scrape a WhatsApp group and connect its members based on signals extracted from
their messages and profiles. Built on
[`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js)
(Puppeteer-driven WhatsApp Web automation with QR-code login).

This is a clean starting point: `scrape.js` exports a group, and `match.js`
turns that export into ranked "you two should connect" suggestions.

## ⚠️ Terms of Service caveat

Automating WhatsApp Web is **against WhatsApp's Terms of Service**, and using it
can get your phone number **banned**. `whatsapp-web.js` is an unofficial library
and is not affiliated with or endorsed by WhatsApp. Only use this on accounts
and groups you own or have explicit permission to export, and treat exported
member data (phone numbers, messages, profile text) responsibly. You use this at
your own risk.

## Setup

Requires Node.js 18+.

```bash
npm install
```

This installs `whatsapp-web.js` and `qrcode-terminal`. `whatsapp-web.js` pulls
in its own bundled Puppeteer (which downloads a Chromium build), so the first
install may take a minute. If you'd rather use a system Chrome, install
`puppeteer` separately and point the client at your executable via the
`puppeteer.executablePath` option in `scrape.js`.

## Step 1 — Scrape a group

```bash
npm run scrape   # or: node scrape.js
```

What happens:

1. The client boots and prints a **QR code** to your terminal.
2. On your phone, open **WhatsApp → Settings → Linked Devices → Link a Device**
   and scan the code. The session is cached in `.wwebjs_auth/`, so future runs
   skip the QR step.
3. Once linked, the script lists all your groups in a numbered menu.
4. Enter the number of the group you want to export.
5. It pulls each participant's number, saved name, self-set push name, profile
   **about/status** (where available), admin flag, and their **recent messages**
   in that group.

Output is written to **`data/group_export.json`**.

## Step 2 — Generate matches

```bash
npm run match   # or: node match.js
```

This reads `data/group_export.json`, extracts simple **interest / skill /
location** signals from each member's `about` + messages, scores every pair by
overlap (skills weighted highest, then interests, then location), and writes
ranked suggestions to **`data/matches.json`**. It also prints the top
connections to the terminal.

## How matching works (and how to improve it)

Extraction is currently **keyword/heuristic-based** — static dictionaries in
`match.js` (`INTEREST_KEYWORDS`, `SKILL_KEYWORDS`, `LOCATION_KEYWORDS`). Edit
those to fit your group's vocabulary.

The `extractSignals()` function carries a clear **`TODO(LLM)`** marker: swap the
keyword matching for an LLM call that takes a member's profile + messages and
returns structured `{ interests, skills, location, bio }`. Keep its return shape
the same and the rest of the pipeline needs no changes.

## File structure

```
contacts-viewer/
├── package.json          # deps + npm scripts (scrape, match)
├── scrape.js             # QR login, group picker, export to data/group_export.json
├── match.js              # signal extraction + ranked matches to data/matches.json
├── README.md
└── data/                 # created on first run
    ├── group_export.json # raw scraped export
    └── matches.json      # ranked match suggestions
```

`.wwebjs_auth/` (cached login session) is also created on first run — keep it
private and out of version control.
