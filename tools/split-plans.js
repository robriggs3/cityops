// node tools/split-plans.js [--dry]
//
// Dissolves a guide's composite "daily plan" items into individually
// controlled ones.
//
// Why this exists. Tirana's guide arrived with one item per day whose whole
// content was a packed note: "AM: Coolab day pass · PM: Ira Shehaj podology
// pedicure · Barber 919 · Eve: Era Blloku, arrive 18:00 sharp or queue".
// That reads fine and plans badly: the day is the unit, so moving the barber
// to Tuesday means retyping a sentence, and everything else in that sentence
// moves with it. The traveler asked for the opposite: Barber 919 is a thing
// he can move to a different day without touching Era Blloku or Monday.
//
// The transform has three dispositions per fragment, and every fragment gets
// exactly one:
//
//   merge   The fragment names a place that is ALREADY its own item somewhere
//           in the guide (Era Blloku is restaurants-06, Barber 919 is
//           services-04). That item becomes the single home for the plan
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
// Committed rather than run-and-deleted so the manifest below stays readable
// as the record of where each fragment went.

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

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

// ---- the Tirana spec -------------------------------------------------------
// One entry per fragment of the eight composite items (itinerary-01..08),
// including the two day-level meta notes that carried a constraint.

const TIRANA = {
  file: 'cities/tirana.json',
  dissolve: [
    'itinerary-01', 'itinerary-02', 'itinerary-03', 'itinerary-04',
    'itinerary-05', 'itinerary-06', 'itinerary-07', 'itinerary-08'
  ],
  merge: [
    // Sat 2026-08-22
    { from: '2026-08-22', fragment: 'Eve: Jarna Traditional Restaurant (4 min walk) or Oda',
      id: 'restaurants-01', when: 'Eve', noteAppend: 'Fallback: Oda.' },
    // Sun 2026-08-23
    { from: '2026-08-23', fragment: 'AM: Coffee at Streha', id: 'coffee-01', when: 'AM' },
    { from: '2026-08-23', fragment: 'AM: OSL Exchange open 10:00 if needed',
      id: 'money-10', day: '2026-08-23', when: 'AM, only if the cash pull came up short' },
    { from: '2026-08-23', fragment: 'PM: Skanderbeg Sq', id: 'activities-06', when: 'PM' },
    { from: '2026-08-23', fragment: 'PM: National History Museum mosaic',
      id: 'activities-09', when: 'PM, the exterior mosaic is the point' },
    { from: '2026-08-23', fragment: "PM: Bunk'Art 2", id: 'activities-04', when: 'PM' },
    { from: '2026-08-23', fragment: 'Eve: Pyramid at sunset', id: 'activities-05', when: 'Eve, at sunset' },
    { from: '2026-08-23', fragment: 'Eve: then Komiteti for raki', id: 'bars-01', when: 'Eve, raki' },
    // Mon 2026-08-24
    { from: '2026-08-24', fragment: 'AM: Coolab day pass',
      id: 'services-07', day: '2026-08-24', when: 'AM, day pass' },
    { from: '2026-08-24', fragment: 'PM: Ira Shehaj podology pedicure',
      id: 'services-03', day: '2026-08-24', when: 'PM, podology pedicure' },
    { from: '2026-08-24', fragment: 'PM: Barber 919',
      id: 'services-04', day: '2026-08-24', when: 'PM' },
    { from: '2026-08-24', fragment: 'Eve: Era Blloku, arrive 18:00 sharp or queue',
      id: 'restaurants-06', when: 'Eve, arrive 18:00 sharp' },
    // Tue 2026-08-25
    { from: '2026-08-25', fragment: 'AM: Pazari i Ri market run', id: 'activities-08', when: 'AM, market run' },
    { from: '2026-08-25', fragment: 'Eve: The Kitchen Blloku (tapas)', id: 'restaurants-08', when: 'Eve, tapas' },
    // Wed 2026-08-26
    { from: '2026-08-26', fragment: "AM: Ride to Bunk'Art 1 (2 hrs, 16°C inside)",
      id: 'activities-01', when: 'AM, ride out' },
    { from: '2026-08-26', fragment: 'PM: Dajti Ekspres cable car, 200 m away, same trip',
      id: 'activities-02', when: "PM, 200 m from Bunk'Art 1, same trip" },
    { from: '2026-08-26', fragment: 'Eve: Mullixhiu, reserve in advance',
      id: 'restaurants-03', when: 'Eve, reserve in advance' },
    // Thu 2026-08-27
    { from: '2026-08-27', fragment: 'AM: Coffee crawl: The Back Room', id: 'coffee-04', when: 'AM, coffee crawl 1 of 2' },
    { from: '2026-08-27', fragment: "AM: Frut'za", id: 'coffee-05', when: 'AM, coffee crawl 2 of 2' },
    { from: '2026-08-27', fragment: 'PM: House of Leaves', id: 'activities-03', when: 'PM' },
    { from: '2026-08-27', fragment: 'Eve: Taverna Peshkatari (seafood)', id: 'restaurants-04', when: 'Eve, seafood' },
    // Fri 2026-08-28
    { from: '2026-08-28', fragment: 'AM: Grand Park / lake loop walk', id: 'activities-07', when: 'AM, lake loop walk' },
    { from: '2026-08-28', fragment: 'Eve: Sky Club rotating bar at sunset, or repeat a favorite',
      id: 'bars-02', when: 'Eve, at sunset', noteAppend: 'Or skip it and repeat a favorite.' }
  ],
  create: [
    { from: '2026-08-22', fragment: 'PM: ATM pull #1', item: {
      id: 'itinerary-atm-pull-1', section: 'itinerary', status: 'plan',
      name: 'ATM pull #1', day: '2026-08-22', when: 'PM',
      note: '40,000 ALL. Union Bank ATM at Ring Center is the cheapest, 500 L flat fee.'
    } },
    { from: '2026-08-22', fragment: 'PM: groceries', item: {
      id: 'itinerary-groceries', section: 'itinerary', status: 'plan',
      name: 'Groceries', day: '2026-08-22', when: 'PM'
    } },
    { from: '2026-08-22', fragment: 'PM: settle in', item: {
      id: 'itinerary-settle-in', section: 'itinerary', status: 'plan',
      name: 'Settle in', day: '2026-08-22', when: 'PM'
    } },
    { from: '2026-08-25', fragment: 'PM: Work block', item: {
      id: 'itinerary-work-block-25', section: 'itinerary', status: 'plan',
      name: 'Work block', day: '2026-08-25', when: 'PM'
    } },
    { from: '2026-08-25', fragment: 'PM: laundry (in-unit washer, air dry)', item: {
      id: 'itinerary-laundry-25', section: 'itinerary', status: 'plan',
      name: 'Laundry load', day: '2026-08-25', when: 'PM',
      note: 'In-unit washer, air dry. Cycle guide is on the washer card under Services.'
    } },
    { from: '2026-08-27', fragment: 'PM: Work block', item: {
      id: 'itinerary-work-block-27', section: 'itinerary', status: 'plan',
      name: 'Work block', day: '2026-08-27', when: 'PM'
    } },
    { from: '2026-08-28', fragment: 'PM: ATM pull #2', item: {
      id: 'itinerary-atm-pull-2', section: 'itinerary', status: 'plan',
      name: 'ATM pull #2', day: '2026-08-28', when: 'PM',
      note: 'Before Aug 29. Ksamil ATMs run dry in peak August.'
    } },
    // Named two mutually exclusive venues, neither of them picked yet (the rate
    // is still an open WhatsApp task), so merging into either would invent a
    // decision. One movable slot, both venues still on the Services tab.
    { from: '2026-08-28', fragment: 'PM: deep tissue massage (Thai or Bliss)', item: {
      id: 'itinerary-massage-28', section: 'itinerary', status: 'plan',
      name: 'Deep tissue massage', day: '2026-08-28', when: 'PM',
      note: '90 minutes. Thai Massage Tirana or Bliss Spa, whichever confirms a rate. Both are on the Services tab.'
    } },
    { from: '2026-08-28', fragment: 'PM: pack', item: {
      id: 'itinerary-pack-28', section: 'itinerary', status: 'plan',
      name: 'Pack', day: '2026-08-28', when: 'PM'
    } }
  ],
  covered: [
    { from: '2026-08-22', fragment: 'AM: Arrive TIA 14:30 → taxi app to base', by: 'logistics-01',
      why: 'Arrival item already dated 2026-08-22 and carries the flight, the taxi apps, the fare and the ride time.' },
    { from: '2026-08-23', fragment: '(day note) Ira Shehaj and most exchange offices closed Sundays. Barber 919 IS open.',
      by: 'services-03 / services-04 / money-10',
      why: 'Each venue item already carries its own Sunday status in note and meta; a floating day note has no owner.' },
    { from: '2026-08-26', fragment: '(day constraint) Dajti Ekspres is CLOSED TUESDAYS. Wed is the slot.',
      by: 'activities-02',
      why: 'Dajti item note already says CLOSED TUESDAYS, hard constraint, and meta.closed_days lists it.' },
    { from: '2026-08-29', fragment: 'AM: Ride booked, leave 08:45 → bus terminal', by: 'logistics-02',
      why: 'Departure item already dated 2026-08-29 with leave_base_by 08:45 and the terminal.' },
    { from: '2026-08-29', fragment: 'PM: 09:45 Tisa Travel → Sarandë, arrive 14:00', by: 'logistics-02',
      why: 'Carried verbatim in the Departure item meta.legs.' },
    { from: '2026-08-29', fragment: 'Eve: 15:00 Trans Butrinti → Ksamil', by: 'logistics-02',
      why: 'Carried verbatim in the Departure item meta.legs.' }
  ],
  // The eight composite notes exactly as they stood before the split. Kept so
  // the completeness check (tests/run.js) can still prove that every fragment
  // of the original guide has a disposition, long after the composites
  // themselves are gone from cities/tirana.json. Several fragments carry more
  // than one stop behind an arrow or a "then", so the spec has MORE rows than
  // this yields fragments: that is the split doing its job.
  originalNotes: [
    "AM: Arrive TIA 14:30 → taxi app to base · PM: ATM pull #1 · groceries · settle in · Eve: Jarna Traditional Restaurant (4 min walk) or Oda",
    "AM: Coffee at Streha · OSL Exchange open 10:00 if needed · PM: Skanderbeg Sq → National History Museum mosaic → Bunk'Art 2 · Eve: Pyramid at sunset, then Komiteti for raki",
    "AM: Coolab day pass · PM: Ira Shehaj podology pedicure · Barber 919 · Eve: Era Blloku, arrive 18:00 sharp or queue",
    "AM: Pazari i Ri market run · PM: Work block · laundry (in-unit washer, air dry) · Eve: The Kitchen Blloku (tapas)",
    "AM: Ride to Bunk'Art 1 (2 hrs, 16°C inside) · PM: Dajti Ekspres cable car, 200 m away, same trip · Eve: Mullixhiu, reserve in advance",
    "AM: Coffee crawl: The Back Room → Frut'za · PM: Work block · House of Leaves · Eve: Taverna Peshkatari (seafood)",
    "AM: Grand Park / lake loop walk · PM: ATM pull #2 · deep tissue massage (Thai or Bliss) · pack · Eve: Sky Club rotating bar at sunset, or repeat a favorite",
    "AM: Ride booked, leave 08:45 → bus terminal · PM: 09:45 Tisa Travel → Sarandë, arrive 14:00 · Eve: 15:00 Trans Butrinti → Ksamil"
  ]
};

module.exports = {
  parseFragments: parseFragments,
  applySplit: applySplit,
  manifest: manifest,
  TIRANA: TIRANA
};

// ---- CLI -------------------------------------------------------------------

if (require.main === module) {
  const dry = process.argv.indexOf('--dry') !== -1;
  const spec = TIRANA;
  const file = path.join(root, spec.file);
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  const have = spec.dissolve.filter(function (id) {
    return data.items.some(function (it) { return it.id === id; });
  });

  const rows = manifest(spec);
  rows.forEach(function (r) {
    console.log(r.day + '  ' + r.disposition.toUpperCase().padEnd(7) + '  ' +
      r.fragment + '\n            -> ' + r.target + (r.detail ? ': ' + r.detail : ''));
  });
  console.log('\nfragments: ' + rows.length +
    ' (merge ' + (spec.merge || []).length +
    ', create ' + (spec.create || []).length +
    ', covered ' + (spec.covered || []).length + ')' +
    '\ncomposites dissolved: ' + spec.dissolve.length);

  if (!have.length) {
    console.log('\n' + spec.file + ' has no composite items left; already split, nothing written.');
    process.exit(0);
  }
  if (have.length !== spec.dissolve.length) {
    console.error('\npartial state: only ' + have.length + ' of ' + spec.dissolve.length +
      ' composites present. Refusing to write.');
    process.exit(1);
  }

  const out = applySplit(data, spec);

  // Validate through the same engine the app enforces, never a local copy.
  const { loadCityOps } = require('../tests/harness');
  const C = loadCityOps();
  const errors = C.validate(out);
  if (errors.length) {
    console.error('\ntransform produced an invalid guide:\n- ' + errors.join('\n- '));
    process.exit(1);
  }

  if (dry) {
    console.log('\n--dry: validated, nothing written.');
    process.exit(0);
  }
  // No trailing newline: matches how cities/tirana.json is already stored, so
  // the diff is the transform and nothing else.
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('\nwrote ' + spec.file);
}
