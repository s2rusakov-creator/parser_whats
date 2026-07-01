/**
 * lib/gigachat.js
 * ---------------
 * Minimal GigaChat (Sber) API client, dependency-free (Node https only).
 *
 * Handles the two-step auth GigaChat requires:
 *   1. Exchange the static "Authorization key" for a short-lived (~30 min)
 *      OAuth access token.
 *   2. Call the chat/completions endpoint with that bearer token.
 *
 * The token is cached and auto-refreshed before it expires. TLS quirks (Russian
 * Ministry-of-Digital-Development root certs that Node may not trust on Windows)
 * are handled via a configurable CA bundle or an explicit insecure fallback.
 */

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GigaChat {
  /**
   * @param {object} opts  config.llm.gigachat shape + { maxRetries, requestTimeoutMs }
   */
  constructor(opts) {
    // Accept either a ready base64 Authorization key, or Client ID + Secret
    // which we base64-encode as "id:secret" ourselves.
    this.authKey =
      opts.authKey ||
      (opts.clientId && opts.clientSecret
        ? Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')
        : '');
    this.scope = opts.scope || 'GIGACHAT_API_PERS';
    this.model = opts.model || 'GigaChat-Pro';
    this.oauthUrl = opts.oauthUrl;
    this.apiUrl = opts.apiUrl;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.requestTimeoutMs ?? 60000;

    this._token = null;
    this._tokenExpiresAt = 0; // unix ms

    // Build a shared HTTPS agent that knows how to trust GigaChat's TLS chain.
    const agentOpts = { keepAlive: true };
    if (opts.insecureTls) {
      agentOpts.rejectUnauthorized = false;
    } else if (opts.caCertPath) {
      try {
        // Split the bundle into individual PEM certs. Node's `ca` option only
        // uses the FIRST cert when given one concatenated buffer, so a
        // root+sub bundle must be passed as an array or verification fails
        // with "self-signed certificate in certificate chain".
        const pem = fs.readFileSync(opts.caCertPath, 'utf8');
        const certs = pem.match(
          /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
        );
        if (!certs || !certs.length) {
          throw new Error('no PEM certificates found in file');
        }
        agentOpts.ca = certs;
      } catch (err) {
        throw new Error(
          `Could not read GIGACHAT_CA_CERT at ${opts.caCertPath}: ${err.message}`
        );
      }
    }
    this.agent = new https.Agent(agentOpts);
  }

  /** Throw early with a clear message if the client isn't configured. */
  assertConfigured() {
    if (!this.authKey) {
      throw new Error(
        'GigaChat не настроен. В .env укажи либо GIGACHAT_AUTH_KEY (готовый base64), ' +
          'либо GIGACHAT_CLIENT_ID и GIGACHAT_CLIENT_SECRET.'
      );
    }
  }

  // ---- Low-level HTTPS POST -------------------------------------------------

  _post(urlStr, { headers, body }) {
    const url = new URL(urlStr);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      agent: this.agent,
      headers: {
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: this.timeoutMs,
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });
      req.write(payload);
      req.end();
    });
  }

  // ---- OAuth token ----------------------------------------------------------

  async _fetchToken() {
    this.assertConfigured();
    const res = await this._post(this.oauthUrl, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: crypto.randomUUID(),
        Authorization: `Basic ${this.authKey}`,
      },
      body: `scope=${encodeURIComponent(this.scope)}`,
    });

    if (res.status !== 200) {
      throw new Error(`GigaChat OAuth failed (HTTP ${res.status}): ${res.body}`);
    }
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (err) {
      throw new Error(`GigaChat OAuth returned non-JSON: ${res.body}`);
    }
    this._token = json.access_token;
    // expires_at is unix ms; refresh 60s early. Fall back to 25 min if absent.
    this._tokenExpiresAt = json.expires_at
      ? json.expires_at - 60000
      : Date.now() + 25 * 60 * 1000;
    return this._token;
  }

  async getToken() {
    if (this._token && Date.now() < this._tokenExpiresAt) return this._token;
    return this._fetchToken();
  }

  // ---- Chat -----------------------------------------------------------------

  /**
   * Send a chat completion. `messages` is an array of {role, content}.
   * Retries on transient errors (network, 429, 5xx, expired token).
   * Returns the assistant message string.
   */
  async chat(messages, { temperature = 0.1, maxTokens = 800 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const token = await this.getToken();
        const res = await this._post(this.apiUrl, {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: {
            model: this.model,
            messages,
            temperature,
            top_p: 0.9,
            n: 1,
            stream: false,
            max_tokens: maxTokens,
          },
        });

        if (res.status === 401) {
          // Token rejected/expired — force a refresh and retry.
          this._token = null;
          throw new Error('Unauthorized (token refresh needed)');
        }
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Transient GigaChat error HTTP ${res.status}: ${res.body}`);
        }
        if (res.status !== 200) {
          throw new Error(`GigaChat HTTP ${res.status}: ${res.body}`);
        }

        const json = JSON.parse(res.body);
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error(`Unexpected GigaChat response: ${res.body}`);
        }
        return content;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          const backoff = Math.min(2000 * 2 ** attempt, 15000);
          await sleep(backoff);
        }
      }
    }
    throw new Error(`GigaChat chat failed after retries: ${lastErr.message}`);
  }
}

/**
 * Best-effort JSON extraction from an LLM reply. Strips ```json fences and
 * grabs the first {...} block, then parses. Returns null on failure.
 */
function parseJsonLoose(text) {
  if (!text) return null;
  let s = text.trim();
  // Remove ``` or ```json fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // If there is leading/trailing prose, slice to the outermost braces.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  try {
    return JSON.parse(s);
  } catch (err) {
    return null;
  }
}

module.exports = { GigaChat, parseJsonLoose };
