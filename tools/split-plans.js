// Library: dissolves a guide's composite "daily plan" items into individually
// controlled ones.
//
// Why this exists. A generated guide can arrive with one item per day whose
// whole content is a packed note: "AM: coworking day pass · PM: errand ·
// barber · Eve: dinner, arrive 18:00 sharp or queue". That reads fine and
// plans badly: the day is the unit, so moving the barber to Tuesday means
// retyping a sentence, and everything else in that sentence moves with it.
// The traveler wants the opposite: each stop is a thing that moves on its
// own without touching the rest of the day.
//
// The transform has three dispositions per fragment, and every fragment gets
// exactly one:
//
//   merge   The fragment names a place that is ALREADY its own item somewhere
//           in the guide. That item becomes the single home for the plan
//           entry: it keeps its id, gains the day if it had none, and gains
//           the fragment's extra instruction as `when` / an appended note.
//           Never a second copy: a duplicate is two things to move and two
//           places to be wrong.
//   create  The fragment is an activity with no place item to attach to (work
//           blocks, laundry, ATM pulls, groceries, packing). It becomes a new
//           item in the plan section, with its own id and day.
//   covered The fragment is already carried, in full, by an item this
//           transform is not allowed to churn (the Logistics arrival and
//           departure items, which were always individual). Recorded in the
//           manifest, no edit.
//
// The composite item itself is then REMOVED, not archived: it has no content
// left that is not somewhere better. Per-item state (status, renames, day
// moves) keyed to a dissolved id is orphaned in the traveler's local store and
// ignored on load; every surviving item keeps its id exactly, so the state
// that matters survives.
//
// The city-specific split specs live with the private city data, out of this
// repo; this module carries the reusable pieces a spec runs through.

// ---- pure: fragment parsing ------------------------------------------------

// Splits a composite daily-plan note into its fragments, carrying the AM / PM
// / Eve phase forward across fragments that do not restate it (only the first
// fragment of a run is prefixed, so "PM: Work block · laundry" is two PM
// fragments, not one PM and one unphased). Returns [{ phase, text }] with
// phase null for anything before the first prefix. Blank input yields [].
const PHASE_RE = /^(AM|PM|Eve|Evening|Night|Midday)\s*:\s*/i;

function parseFragments(note) {
  if (typeof note !== 'string') return [];
  var out = [];
  var phase = null;
  note.split('·').forEach(function (raw) {
    var text = raw.trim();
    if (!text) return;
    var m = text.match(PHASE_RE);
    if (m) {
      phase = m[1];
      text = text.slice(m[0].length).trim();
      if (!text) return;
    }
    out.push({ phase: phase, text: text });
  });
  return out;
}

// ---- pure: the transform ---------------------------------------------------

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// Applies a split spec to a city dataset and returns a NEW dataset. Throws on
// anything that would silently produce a wrong guide: a dissolve target that
// is not there, a merge target that is not there, a created id that already
// exists, a created item pointing at a section the guide does not declare.
// Every one of those means the spec and the data have drifted apart, and a
// half-applied split is worse than no split.
function applySplit(data, spec) {
  var out = clone(data);
  var items = out.items;
  var byId = {};
  items.forEach(function (it) { byId[it.id] = it; });
  var secIds = {};
  (out.sections || []).forEach(function (s) { secIds[s.id] = 1; });

  var dissolve = spec.dissolve || [];
  dissolve.forEach(function (id) {
    if (!byId[id]) throw new Error('dissolve target not found: ' + id);
  });

  (spec.merge || []).forEach(function (m) {
    var it = byId[m.id];
    if (!it) throw new Error('merge target not found: ' + m.id);
    if (m.day) it.day = m.day;
    if (m.when) it.when = m.when;
    if (m.noteAppend) {
      var base = typeof it.note === 'string' ? it.note.trim() : '';
      if (base.indexOf(m.noteAppend) === -1) {
        it.note = base ? base + ' ' + m.noteAppend : m.noteAppend;
      }
    }
  });

  var created = (spec.create || []).map(function (c) {
    var it = clone(c.item);
    if (byId[it.id]) throw new Error('created id collides with an existing item: ' + it.id);
    if (!secIds[it.section]) throw new Error('created item ' + it.id + ' references unknown section ' + it.section);
    byId[it.id] = it;
    return it;
  });

  // New items take the slot the composites vacated, so the section stays where
  // a reader of the file expects it rather than piling up at the end.
  var firstIdx = items.length;
  dissolve.forEach(function (id) {
    var i = items.findIndex(function (x) { return x.id === id; });
    if (i !== -1 && i < firstIdx) firstIdx = i;
  });
  var kept = items.filter(function (it) { return dissolve.indexOf(it.id) === -1; });
  var insertAt = Math.min(firstIdx, kept.length);
  out.items = kept.slice(0, insertAt).concat(created, kept.slice(insertAt));
  return out;
}

// Flattens the spec into one manifest row per fragment, for the report.
function manifest(spec) {
  var rows = [];
  (spec.merge || []).forEach(function (m) {
    rows.push({
      day: m.from, fragment: m.fragment, disposition: 'merge', target: m.id,
      detail: (m.day ? 'day set ' + m.day + '; ' : '') + (m.when ? 'when "' + m.when + '"' : '') +
        (m.noteAppend ? '; note += "' + m.noteAppend + '"' : '')
    });
  });
  (spec.create || []).forEach(function (c) {
    rows.push({
      day: c.from, fragment: c.fragment, disposition: 'create', target: c.item.id,
      detail: c.item.name + ' on ' + c.item.day + (c.item.when ? ' (' + c.item.when + ')' : '')
    });
  });
  (spec.covered || []).forEach(function (c) {
    rows.push({ day: c.from, fragment: c.fragment, disposition: 'covered', target: c.by, detail: c.why });
  });
  rows.sort(function (a, b) {
    if (a.day === b.day) return 0;
    return a.day < b.day ? -1 : 1;
  });
  return rows;
}

module.exports = {
  parseFragments: parseFragments,
  applySplit: applySplit,
  manifest: manifest
};
