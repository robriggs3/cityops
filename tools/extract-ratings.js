// node tools/extract-ratings.js cities/tirana.json [--dry-run]
//
// Lifts the rating prose the generation passes wrote into item notes
// ("4.8 stars across 442 reviews", "4.6★ across 5,545 reviews", "4.9★ (38)")
// into the structured `rating` field the app renders as a badge, and deletes
// the clause from the note where that can be done cleanly.
//
// Two rules carry the safety here, both deliberately conservative, because
// this rewrites researched guide text that nobody is going to re-read line by
// line:
//
//  1. AMBIGUOUS READINGS ARE NOT GUESSED. A range ("4.5 to 4.6 stars") gives
//     no rating at all; a ranged count ("roughly 230 to 250 reviews") gives
//     the stars with no count. Half a fact is fine; an invented fact is not.
//  2. THE NOTE IS ONLY EDITED WHEN THE CLAUSE IS A WHOLE SENTENCE. "4.7 stars
//     across 801 reviews." is a sentence that exists only to carry the number,
//     so it goes. "4.8 stars across 442 reviews, the highest-rated substantial
//     restaurant inside your walking radius" is a sentence that says something
//     else too, so it stays exactly as written and the item gets its rating
//     anyway. Never leave a sentence starting mid-clause with a lowercase word.
//
// The parsing half is pure and exported, so tests can cover the real note
// shapes from the shipped cities without touching the filesystem.

const fs = require('fs');

// A rating recovered from prose is a rating whose provenance is "whatever the
// generation pass found", with no date attached: no checked field is written,
// because nobody checked it on any particular day.
const PROSE_SOURCE = 'from generation research';

// Decimal points are protected before sentence splitting, so "4.8 stars" is
// one sentence and not two.
const DOT = '\u0001';

function protectDecimals(text) {
  return text.replace(/(\d)\.(\d)/g, '$1' + DOT + '$2');
}
function restoreDecimals(text) {
  return text.split(DOT).join('.');
}

// Splits into sentences, each keeping its own terminator AND its trailing
// whitespace, so joining the pieces back reproduces the input byte for byte.
// That is what makes "drop one sentence" a safe edit rather than a reflow.
function splitSentences(text) {
  const t = protectDecimals(String(text === null || text === undefined ? '' : text));
  const out = [];
  const re = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    out.push(restoreDecimals(m[0]));
  }
  return out;
}

// The stars token: "4.8 stars", "4.8 star", "4.6★", "5.0★". Anchored on a
// word/bracket boundary so a house number or a price never reads as a rating.
const STARS_RE = /(^|[\s(\u2014-])(\d(?:\.\d)?)\s*(?:★|stars?\b)/i;

// A range ("4.5 to 4.6 stars") immediately before the matched number: the
// reading is genuinely two numbers and picking one would be inventing a
// precision the research did not have.
const RANGE_BEFORE_RE = /\d(?:\.\d)?\s+to\s+$/i;

// The review count, read from whatever follows the stars token. Covers every
// shape the three shipped guides actually use:
//   " (38)."                        parenthetical
//   " across 442 reviews"           across
//   ", 252 reviews"                 bare comma
//   " and 1,833 reviews"            and
//   " on only 7 reviews"            on only / but only
//   " across roughly 1,000 reviews" roughly / about / around / ~
//   " across 317 Google reviews"    named source
//   " across 250 ratings"           ratings, not reviews
// Group 1 is the parenthetical count, group 2 the plain one, group 3 the
// "to N" tail that marks the count itself as a range.
const COUNT_RE = new RegExp(
  '^[\\s,]*(?:' +
    '\\(\\s*(\\d[\\d,]*)\\s*\\)' +
    '|(?:across|and|on|but|from|over|with)?\\s*(?:only\\s+)?' +
      '(?:roughly\\s+|about\\s+|around\\s+|~\\s*)?' +
      '(\\d[\\d,]*)(\\s+to\\s+\\d[\\d,]*)?\\s+' +
      '(?:google\\s+|yandex\\s+|tripadvisor\\s+)?(?:reviews?|ratings?)\\b' +
  ')', 'i');

// Finds the first rating in one piece of text. Returns null when there is
// none, or when the reading is a range (rule 1 above).
// { stars, count|null, start, end } where [start, end) is the clause span:
// the stars token plus its count, and nothing else.
function findRating(text) {
  const s = String(text === null || text === undefined ? '' : text);
  const m = STARS_RE.exec(s);
  if (!m) return null;
  const lead = m[1] ? m[1].length : 0;
  const start = m.index + lead;
  const end = m.index + m[0].length;
  if (RANGE_BEFORE_RE.test(s.slice(0, start))) return null;
  const stars = parseFloat(m[2]);
  if (!isFinite(stars) || stars < 0 || stars > 5) return null;
  const tail = s.slice(end, end + 80);
  const cm = COUNT_RE.exec(tail);
  if (!cm) return { stars: stars, count: null, start: start, end: end };
  // A ranged count is dropped, but the stars stay: the clause span still
  // covers the words, so a whole-sentence removal still removes all of it.
  const raw = cm[1] || cm[2];
  const count = cm[3] ? null : parseInt(String(raw).replace(/,/g, ''), 10);
  return {
    stars: stars,
    count: (typeof count === 'number' && isFinite(count)) ? count : null,
    start: start,
    end: end + cm[0].length
  };
}

// What is left of a sentence once the rating clause is cut out. A sentence
// that reduces to nothing but punctuation and brackets was only ever carrying
// the number, and is the one case where the note is edited.
const RESIDUE_RE = /^[\s.,;:()\[\]\u2014\u2013-]*$/;

// The pure half. Returns:
//   { rating: {stars, count?, source} | null, note: string|null, removed: bool }
// `note` is the note to write back (null means delete the field entirely,
// which only happens when the whole note was the rating sentence); `removed`
// says whether the prose was edited.
function extractRating(note) {
  const original = (typeof note === 'string') ? note : '';
  const hit = findRating(original);
  if (!hit) return { rating: null, note: original || null, removed: false };

  const rating = { stars: hit.stars };
  if (hit.count !== null) rating.count = hit.count;
  rating.source = PROSE_SOURCE;

  const sentences = splitSentences(original);
  let cutIndex = -1;
  let seen = 0;
  for (let i = 0; i < sentences.length; i++) {
    const sLen = sentences[i].length;
    const within = hit.start >= seen && hit.start < seen + sLen;
    if (within) {
      const local = findRating(sentences[i]);
      if (local) {
        const residue = sentences[i].slice(0, local.start) + sentences[i].slice(local.end);
        if (RESIDUE_RE.test(residue)) cutIndex = i;
      }
      break;
    }
    seen += sLen;
  }
  if (cutIndex === -1) return { rating: rating, note: original, removed: false };

  const kept = sentences.slice(0, cutIndex).concat(sentences.slice(cutIndex + 1)).join('');
  const trimmed = kept.replace(/\s+$/, '');
  return { rating: rating, note: trimmed ? trimmed : null, removed: true };
}

// ---- CLI ----
function run(argv) {
  const args = argv.filter(function (a) { return a !== '--dry-run'; });
  const dryRun = argv.indexOf('--dry-run') !== -1;
  const file = args[0];
  if (!file) {
    console.error('usage: node tools/extract-ratings.js <city.json> [--dry-run]');
    process.exit(1);
  }
  const raw = fs.readFileSync(file, 'utf8');
  // The shipped cities disagree about a trailing newline; follow whatever
  // this file already does so the diff is the ratings and nothing else.
  const eof = /\n$/.test(raw) ? '\n' : '';
  const data = JSON.parse(raw);
  const stats = { items: data.items.length, ratings: 0, withCount: 0, notesCleaned: 0, notesDropped: 0, already: 0 };
  data.items.forEach(function (it) {
    if (it.rating) { stats.already++; return; }
    const res = extractRating(it.note);
    if (!res.rating) return;
    it.rating = res.rating;
    stats.ratings++;
    if (typeof res.rating.count === 'number') stats.withCount++;
    if (res.removed) {
      stats.notesCleaned++;
      if (res.note === null) { delete it.note; stats.notesDropped++; }
      else it.note = res.note;
    }
  });
  if (!dryRun) fs.writeFileSync(file, JSON.stringify(data, null, 2) + eof);
  console.log(file + ': ' + stats.ratings + ' ratings from ' + stats.items + ' items (' +
    stats.withCount + ' with a review count), ' + stats.notesCleaned + ' notes cleaned' +
    (stats.notesDropped ? ' (' + stats.notesDropped + ' emptied and removed)' : '') +
    (stats.already ? ', ' + stats.already + ' already had one' : '') +
    (dryRun ? ' [dry run, nothing written]' : ''));
}

if (require.main === module) run(process.argv.slice(2));

module.exports = { extractRating, findRating, splitSentences, PROSE_SOURCE };
