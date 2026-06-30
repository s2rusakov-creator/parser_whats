/**
 * lib/env.js
 * ----------
 * Tiny dependency-free .env loader. Reads KEY=VALUE lines from a .env file in
 * the project root and copies them into process.env (without overwriting vars
 * that are already set in the real environment).
 *
 * We roll our own instead of pulling in `dotenv` to keep the project installable
 * with zero extra dependencies.
 */

const fs = require('fs');
const path = require('path');

function load(file) {
  const target = file || path.join(__dirname, '..', '.env');
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return false; // no .env file — that's fine
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding single/double quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

module.exports = { load };
