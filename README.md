# parser_whats

Scrape a WhatsApp group, figure out **what each member does** (their job /
business) from their profile and messages, **group people by occupation**, and
**export** the result to Excel/CSV/JSON. Built on
[`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js)
(Puppeteer-driven WhatsApp Web automation with QR login) and
[GigaChat](https://developers.sber.ru/portal/products/gigachat-api) for the
classification step.

## ⚠️ Terms of Service caveat

Automating WhatsApp Web is **against WhatsApp's Terms of Service** and can get
your number **banned**. `whatsapp-web.js` is unofficial and not affiliated with
WhatsApp. Only use this on groups you own or have explicit permission to export,
keep the exported data (phone numbers, messages, profiles) private, and use at
your own risk. The viewer/output contain personal data — keep the repo private.

## The pipeline

```
node scrape.js   →  data/group_export.json   raw: profiles + messages
node enrich.js   →  data/enriched.json        LLM: what each person does
node match.js    →  data/grouped.json         grouped by occupation
node export.js   →  out/people.{xlsx,csv,json}  shareable output
node view.js     →  http://localhost:5173     browse in the browser
```

Each stage reads the previous stage's file, so you can re-run any step alone.

## Setup

Requires Node.js 18+.

```bash
npm install
cp .env.example .env   # then fill in GIGACHAT_AUTH_KEY (PowerShell: copy .env.example .env)
```

`whatsapp-web.js` pulls in a bundled Chromium on first install (can take a
minute). `exceljs` is an *optional* dependency — installed it gives you a
formatted `.xlsx`; without it you still get CSV + JSON.

## Easiest: the web panel (`npm start`)

```bash
npm start        # then open http://localhost:5173
```

A light-theme control panel that does the whole flow in the browser:

1. **Log in** — scan the QR shown on the page (also printed to the terminal).
2. **Pick a group** — your groups load as a searchable list; click **Парсить**.
3. **Watch progress** — scrape → classify → group → export, with a live log.
4. **Browse results** — people grouped by what they do, with CSV/JSON/XLSX
   download buttons.

The panel runs the same pipeline as the CLI below, so you still need
`GIGACHAT_AUTH_KEY` in `.env` for the classify step. Prefer the CLI? It's all
still here — use the steps below. Use the panel **or** the CLI at a time (they
share one WhatsApp session).

## Step 1 — Scrape (`npm run scrape`)

1. A **QR code** prints to the terminal. On your phone:
   **WhatsApp → Settings → Linked Devices → Link a Device** and scan it. The
   session is cached in `.wwebjs_auth/`, so later runs skip the QR.
2. The script **waits for contacts to sync** (so self-set names populate), then
   lists your groups in a numbered menu. Pick one.
3. It **loads message history into memory** (configurable target), then exports
   each participant's number, names, status, admin flag, and their messages to
   `data/group_export.json`.
4. A **data-quality summary** prints (how many have names / status / messages).
   If everything is empty, the group is silent/privacy-locked — pick a more
   active group. This is a WhatsApp limitation, not a bug.

## Step 2 — Classify occupations (`npm run enrich`)

Sends each member's text (name + status + messages) to **GigaChat**, which
returns structured `{ occupation, category, services, location, confidence,
summary }`. Results are cached in `data/enrich_cache.json`, so re-runs don't
re-spend quota. Members with no text are kept and marked unknown.

Needs `GIGACHAT_AUTH_KEY` in `.env` (see [.env.example](.env.example)). Get the
key in the Sber GigaChat cabinet. If Node rejects GigaChat's TLS on Windows,
set `GIGACHAT_CA_CERT` to the Russian root CA bundle, or `GIGACHAT_INSECURE_TLS=1`
as a quick (less safe) fallback.

## Step 3 — Group (`npm run match`)

Buckets everyone by category, normalizing synonyms via `categoryAliases` in
[config.js](config.js) (e.g. "риелтор" and "недвижимость" → one group). Writes
`data/grouped.json` and prints a per-category summary.

> `match.js` was rebuilt: it used to score pairs of people by shared interests;
> now it groups people by what they do, which is the project's actual goal.

## Step 4 — Export (`npm run export`)

Writes to `out/`:
- `people.json` — full structured data
- `people.csv` — flat table, UTF-8 BOM (opens cleanly in Excel with Cyrillic)
- `people.xlsx` — multi-sheet workbook (summary + "all" + one sheet per
  category), **only if `exceljs` is installed**

Run the last three steps at once: `npm run pipeline`.

## Viewer (`npm run view`)

Local, dependency-free page at `http://localhost:5173`: people grouped by
direction with search, plus a raw members tab. Re-reads files on every request.
Custom port (PowerShell): `$env:PORT=8080; node view.js`.

## Configuration

All tunables live in [config.js](config.js) and can be overridden via `.env`
(message target, scroll rounds, LLM concurrency, model, category aliases, …).

## File structure

```
parser_whats/
├── config.js              # central config (paths, tunables, category aliases)
├── .env.example           # copy to .env; GigaChat key + overrides
├── lib/
│   ├── env.js             # tiny .env loader (no dotenv dep)
│   └── gigachat.js        # GigaChat client: OAuth token + chat + retries
├── scrape.js              # stage 1: sync, load history, export members
├── enrich.js              # stage 2: LLM classification (+ cache)
├── match.js               # stage 3: group by occupation
├── export.js              # stage 4: xlsx/csv/json
├── view.js                # local web viewer
└── data/ , out/           # created on first run (gitignored)
```

`.wwebjs_auth/` (login session), `data/`, `out/`, and `.env` are gitignored —
keep them private.
