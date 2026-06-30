/**
 * match.js
 * --------
 * Reads data/group_export.json, extracts simple signals (interests, skills,
 * locations) from each member's messages + profile "about", and produces
 * ranked match suggestions between members based on shared signals.
 *
 * Writes results to data/matches.json.
 *
 * The extraction here is intentionally simple and keyword-based. See the
 * `extractSignals` function for a clearly-marked TODO where you could swap in
 * an LLM call for far better, context-aware extraction.
 *
 * Usage:
 *   node match.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const INPUT_FILE = path.join(DATA_DIR, 'group_export.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'matches.json');

// How many top matches to keep per member in the output.
const TOP_N_PER_MEMBER = 5;

// ---- Keyword dictionaries -------------------------------------------------
// Each category maps a canonical signal -> list of trigger keywords/phrases.
// Lowercased, matched as whole words/substrings against message + about text.

const INTEREST_KEYWORDS = {
  music: ['music', 'guitar', 'piano', 'singing', 'band', 'spotify', 'concert'],
  fitness: ['gym', 'running', 'marathon', 'yoga', 'workout', 'cycling', 'crossfit'],
  gaming: ['gaming', 'gamer', 'playstation', 'xbox', 'nintendo', 'steam', 'valorant'],
  cooking: ['cooking', 'recipe', 'baking', 'foodie', 'chef'],
  travel: ['travel', 'traveling', 'backpacking', 'flights', 'trip', 'wanderlust'],
  photography: ['photography', 'photographer', 'camera', 'lightroom'],
  reading: ['reading', 'books', 'novel', 'bookworm', 'kindle'],
  startups: ['startup', 'founder', 'entrepreneur', 'saas', 'venture', 'vc'],
  finance: ['investing', 'stocks', 'crypto', 'trading', 'finance', 'bitcoin'],
};

const SKILL_KEYWORDS = {
  javascript: ['javascript', 'js', 'node', 'nodejs', 'react', 'typescript'],
  python: ['python', 'pandas', 'numpy', 'django', 'flask'],
  design: ['design', 'figma', 'ux', 'ui', 'photoshop', 'illustrator'],
  'data-science': ['data science', 'machine learning', 'ml', 'ai', 'deep learning'],
  marketing: ['marketing', 'seo', 'ads', 'growth', 'branding'],
  writing: ['writing', 'copywriting', 'editor', 'blogging', 'journalism'],
  devops: ['devops', 'kubernetes', 'docker', 'aws', 'terraform'],
};

// Common location/city keywords. Extend as needed for your group.
const LOCATION_KEYWORDS = {
  london: ['london'],
  'new-york': ['new york', 'nyc', 'manhattan', 'brooklyn'],
  'san-francisco': ['san francisco', 'sf', 'bay area'],
  berlin: ['berlin'],
  dubai: ['dubai'],
  istanbul: ['istanbul'],
  baku: ['baku'],
  remote: ['remote', 'wfh'],
};

// ---- Signal extraction ----------------------------------------------------

/**
 * Match a text blob against a keyword dictionary and return the set of
 * canonical signals found.
 */
function matchKeywords(text, dictionary) {
  const found = new Set();
  for (const [signal, keywords] of Object.entries(dictionary)) {
    for (const kw of keywords) {
      // Substring match is good enough for a keyword heuristic. For whole-word
      // accuracy you'd use a regex with word boundaries.
      if (text.includes(kw)) {
        found.add(signal);
        break;
      }
    }
  }
  return found;
}

/**
 * Extract interest/skill/location signals from a single member.
 *
 * TODO(LLM): Replace (or augment) this keyword heuristic with an LLM call.
 * Pass the member's `about` + concatenated `messages` to a model and ask it to
 * return structured JSON like:
 *   { interests: [...], skills: [...], location: "...", bio: "..." }
 * An LLM will handle synonyms, context, multilingual text, and implicit
 * signals far better than the static dictionaries above. Keep this function's
 * return shape identical so the rest of the pipeline is unchanged.
 */
function extractSignals(member) {
  const messageText = (member.messages || []).map((m) => m.body || '').join(' ');
  const blob = `${member.about || ''} ${messageText}`.toLowerCase();

  return {
    interests: [...matchKeywords(blob, INTEREST_KEYWORDS)],
    skills: [...matchKeywords(blob, SKILL_KEYWORDS)],
    locations: [...matchKeywords(blob, LOCATION_KEYWORDS)],
  };
}

// ---- Matching -------------------------------------------------------------

/** Count shared items between two arrays and return the overlap list. */
function overlap(a, b) {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/**
 * Score the connection between two members. Weighting reflects that a shared
 * niche skill is a stronger connection signal than a shared broad interest,
 * and a shared location is a useful (but weaker) tiebreaker.
 */
function scorePair(sigA, sigB) {
  const sharedInterests = overlap(sigA.interests, sigB.interests);
  const sharedSkills = overlap(sigA.skills, sigB.skills);
  const sharedLocations = overlap(sigA.locations, sigB.locations);

  const score =
    sharedSkills.length * 3 +
    sharedInterests.length * 2 +
    sharedLocations.length * 1;

  return { score, sharedInterests, sharedSkills, sharedLocations };
}

/** Human-readable display label for a member. */
function label(member) {
  return member.name || member.pushname || member.number || member.id;
}

// ---- Main -----------------------------------------------------------------

function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    console.error('Run "node scrape.js" first to generate it.');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const members = data.members || [];
  console.log(`Loaded ${members.length} members from ${INPUT_FILE}`);

  // 1. Extract signals once per member.
  const enriched = members.map((m) => ({
    id: m.id,
    label: label(m),
    number: m.number,
    signals: extractSignals(m),
  }));

  // 2. Score every unique pair.
  const pairs = [];
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i];
      const b = enriched[j];
      const result = scorePair(a.signals, b.signals);
      if (result.score > 0) {
        pairs.push({
          a: { id: a.id, label: a.label },
          b: { id: b.id, label: b.label },
          score: result.score,
          sharedSkills: result.sharedSkills,
          sharedInterests: result.sharedInterests,
          sharedLocations: result.sharedLocations,
        });
      }
    }
  }

  // 3. Sort all pairs by score (strongest connections first).
  pairs.sort((x, y) => y.score - x.score);

  // 4. Build a per-member "top suggestions" view for easy browsing.
  const suggestionsByMember = {};
  for (const member of enriched) {
    const related = pairs
      .filter((p) => p.a.id === member.id || p.b.id === member.id)
      .map((p) => {
        const other = p.a.id === member.id ? p.b : p.a;
        return {
          with: other,
          score: p.score,
          sharedSkills: p.sharedSkills,
          sharedInterests: p.sharedInterests,
          sharedLocations: p.sharedLocations,
        };
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, TOP_N_PER_MEMBER);

    suggestionsByMember[member.id] = {
      label: member.label,
      signals: member.signals,
      topMatches: related,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sourceExportedAt: data.exportedAt || null,
    group: data.group || null,
    memberCount: enriched.length,
    rankedPairs: pairs, // global ranking, strongest first
    suggestionsByMember, // per-person top matches
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  console.log(`\nFound ${pairs.length} connected pairs.`);
  if (pairs.length > 0) {
    console.log('\nTop 5 connections:');
    pairs.slice(0, 5).forEach((p, i) => {
      const shared = [...p.sharedSkills, ...p.sharedInterests, ...p.sharedLocations].join(', ');
      console.log(`  ${i + 1}. ${p.a.label} <-> ${p.b.label}  (score ${p.score}: ${shared})`);
    });
  }
  console.log(`\nWrote results to ${OUTPUT_FILE}`);
}

main();
