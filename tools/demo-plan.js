// node tools/demo-plan.js <out.html>
//
// The public sample plan: https://nomadding.com/demo/
//
// WHAT THIS IS. The marketing site needs to show a plan, and the only plan
// that existed was the owner's real one. This writes a fake one instead, from
// invented data, through exactly the product's own Download HTML path:
//
//   1. CityOps.shareKit.build turns trip-shaped input into a snapshot. It is
//      the same function the trip surface calls, loaded out of the SHIPPED
//      bytes (template.html) by the test harness, so the snapshot this emits
//      and the snapshot a real download carries are built by one code path.
//   2. share/index.html, the assembled share page, gets that snapshot baked
//      into its #share-data block. That is byte-for-byte what the trip
//      surface's buildFamilyShareHTML does with its embedded copy of the same
//      file; the only difference is that this runs in node.
//
// WHY THAT MATTERS. The share page is read-only by construction, and reusing
// it whole is what inherits the guarantee instead of re-asserting it: it ships
// no engine, renders no control that writes, holds no function that writes,
// and its CSP sets form-action 'none'. A hand-built marketing mock would have
// none of that, and would drift from the real product on the first redesign.
//
// WHAT IT DOES NOT DO. It creates no share row, needs no account, and touches
// no network. A page built this way has no token in it, so there is nothing
// for the page's fetch path to be reached BY: boot() reads the embedded block
// first and returns before it ever looks for a token.
//
// THE DATES MOVE. The share page compares the plan against the real today, so
// a sample with fixed dates slowly becomes an all-past trip. The stops here
// are generated as offsets from the day this runs, centred so the plan shows
// one finished stop, one the traveler is standing in, and two ahead. Re-run
// this every few months and commit the result; the offsets are the whole
// maintenance story.

const fs = require('fs');
const path = require('path');
const { loadCityOps } = require('../tests/harness');

const root = path.join(__dirname, '..');
const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node tools/demo-plan.js <out.html>');
  process.exit(1);
}

// ---- the invented traveler ----
//
// A first name and nothing else, which is all the page renders (the hero and
// the document title). No surname, no photograph, no contact, no home city:
// there is no real person for any of this to be about.
const TRAVELER = 'Mira';

// Offsets in days from the run date. Stop 2 straddles today on purpose.
function iso(offsetDays) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---- the route ----
//
// Four stops down the Adriatic. City names, countries and coordinates are
// public geography and are real so the map is not nonsense. Everything a
// person could be traced by is invented: the stays, the neighbourhoods, the
// carriers and the flight numbers are all made up, and no address appears
// anywhere in this file.
const LJUBLJANA = { in: -24, out: -11 };
const SPLIT     = { in: -11, out:  9 };
const KOTOR     = { in:   9, out: 26 };
const TIRANA    = { in:  26, out: 46 };

const cities = [
  {
    id: 'ljubljana-' + iso(LJUBLJANA.in),
    name: 'Ljubljana', country: 'Slovenia',
    status: 'confirmed',
    checkIn: iso(LJUBLJANA.in), checkOut: iso(LJUBLJANA.out),
    lat: 46.0569, lng: 14.5058,
    accommodations: [
      { name: 'Riverside Apartment', city: 'Ljubljana', neighborhood: 'Old town',
        status: 'booked', checkIn: iso(LJUBLJANA.in), checkOut: iso(LJUBLJANA.out) }
    ]
  },
  {
    id: 'split-' + iso(SPLIT.in),
    name: 'Split', country: 'Croatia',
    status: 'confirmed',
    checkIn: iso(SPLIT.in), checkOut: iso(SPLIT.out),
    lat: 43.5081, lng: 16.4402,
    accommodations: [
      // Two stays inside one stop: the traveler moved across town mid-stay,
      // which is the shape the timeline exists to draw.
      { name: 'Harbour Studio', city: 'Split', neighborhood: 'Waterfront',
        status: 'booked', checkIn: iso(SPLIT.in), checkOut: iso(-2) },
      { name: 'Garden Guesthouse', city: 'Split', neighborhood: 'Above the centre',
        status: 'booked', checkIn: iso(-2), checkOut: iso(SPLIT.out) }
    ]
  },
  {
    id: 'kotor-' + iso(KOTOR.in),
    name: 'Kotor', country: 'Montenegro',
    status: 'confirmed',
    checkIn: iso(KOTOR.in), checkOut: iso(KOTOR.out),
    lat: 42.4247, lng: 18.7712,
    accommodations: [
      { name: 'Bay View Rooms', city: 'Kotor', neighborhood: 'Inside the walls',
        status: 'booked', checkIn: iso(KOTOR.in), checkOut: iso(KOTOR.out) }
    ]
  },
  {
    id: 'tirana-' + iso(TIRANA.in),
    name: 'Tirana', country: 'Albania',
    // Not booked yet, and it shows: a tentative stop with two stays still on
    // the shortlist is the honest half of what this app is for.
    status: 'tentative',
    checkIn: iso(TIRANA.in), checkOut: iso(TIRANA.out),
    lat: 41.3275, lng: 19.8187,
    accommodations: [
      { name: 'City Centre Loft', city: 'Tirana', neighborhood: 'Near the park',
        status: 'shortlisted', checkIn: iso(TIRANA.in), checkOut: iso(TIRANA.out) },
      { name: 'Courtyard Flat', city: 'Tirana', neighborhood: 'East side',
        status: 'shortlisted', checkIn: iso(TIRANA.in), checkOut: iso(TIRANA.out) }
    ]
  }
];

// ---- the legs between them ----
//
// Three modes so three different icons and labels are on the page. Carriers
// and numbers are invented: no real operator is named, and no real service is
// implied to run on these dates.
const transitions = [
  { cityId: cities[0].id, mode: 'bus', status: 'booked',
    fromCity: 'Ljubljana', toCity: 'Split',
    departureDate: iso(LJUBLJANA.out), departureTime: '07:30',
    arrivalDate: iso(LJUBLJANA.out), arrivalTime: '17:05',
    carrier: 'Coastal Coach', number: 'CC 118' },
  { cityId: cities[1].id, mode: 'ferry', status: 'booked',
    fromCity: 'Split', toCity: 'Kotor',
    departureDate: iso(SPLIT.out), departureTime: '08:00',
    arrivalDate: iso(SPLIT.out), arrivalTime: '15:40',
    carrier: 'Adriatic Line', number: 'AL 6' },
  { cityId: cities[2].id, mode: 'flight', status: 'tentative',
    fromCity: 'Kotor', toCity: 'Tirana',
    departureDate: iso(KOTOR.out), departureTime: '13:15',
    arrivalDate: iso(KOTOR.out), arrivalTime: '14:20',
    carrier: 'Adriatic Air', number: 'AD 214' }
];

// ---- one city guide ----
//
// Attached to the stop the traveler is standing in, so the guide card opens on
// the city the page is already about. Written to show the thing the product is
// actually for: a rating, and a Must / Good / Skip verdict that names a
// specific dish or a specific version of the thing rather than reviewing the
// venue. Every place here is invented.
const guideRow = {
  city_id: cities[1].id,
  data: {
    schema: 1,
    city: {
      name: 'Split', country: 'Croatia',
      dates: { from: iso(SPLIT.in), to: iso(SPLIT.out) }
    },
    sections: [
      { id: 'dinner', label: 'Dinner', icon: '🍽️' },
      { id: 'coffee', label: 'Coffee', icon: '☕' },
      { id: 'do', label: 'Do', icon: '🧭' }
    ],
    items: [
      { id: 'konoba-anchor', section: 'dinner', status: 'plan',
        day: iso(-9), when: 'First night',
        name: 'Konoba Anchor',
        price: { text: '~25-35 EUR' },
        hours: { text: '17:00-24:00, closed Sunday' },
        note: 'Six tables and a chalkboard. Whatever came in that morning is what is on it.',
        tags: ['Book ahead'],
        rating: { stars: 4.7 },
        intel: { verdicts: [
          { tier: 'must', text: 'the grilled fish under the bell, ordered by weight at the counter' },
          { tier: 'skip', text: 'the tourist set menu on the board outside, which is a different kitchen' }
        ] },
        links: [] },
      { id: 'peka-house', section: 'dinner', status: 'backup',
        name: 'The Peka House',
        price: { text: '~30 EUR' },
        note: 'Needs ordering a day ahead. Worth the phone call if the weather turns.',
        rating: { stars: 4.4 },
        intel: { verdicts: [
          { tier: 'good', text: 'lamb peka for two, which is the whole reason to come here' }
        ] },
        links: [] },
      { id: 'stone-cafe', section: 'coffee', status: 'plan',
        when: 'Mornings',
        name: 'Stone Courtyard Cafe',
        price: { text: '~2 EUR' },
        hours: { text: '07:00-20:00 daily' },
        note: 'Sit down and pay after. Nobody is waiting for the table.',
        rating: { stars: 4.6 },
        intel: { verdicts: [
          { tier: 'must', text: 'a macchiato at a table in the courtyard, which is the local ritual' },
          { tier: 'skip', text: 'takeaway, which gets you a worse coffee and a strange look' }
        ] },
        links: [] },
      { id: 'palace-cellars', section: 'do', status: 'plan',
        day: iso(-7), when: 'Late afternoon',
        name: 'The palace cellars',
        price: { text: '~7 EUR' },
        hours: { text: '09:00-19:00' },
        note: 'Twenty minutes if you walk it, an hour if you read the boards.',
        rating: { stars: 4.5 },
        intel: { verdicts: [
          { tier: 'must', text: 'going in the last hour, when the tour groups have cleared out' }
        ] },
        links: [] },
      { id: 'hill-walk', section: 'do', status: 'plan',
        when: 'Any clear evening',
        name: 'The hill path above town',
        price: { text: 'Free' },
        note: 'Forty minutes up through the pines. Take water, there is none at the top.',
        rating: { stars: 4.8 },
        intel: { verdicts: [
          { tier: 'must', text: 'the north viewpoint at sunset, not the signposted one' },
          { tier: 'good', text: 'the loop back down the far side, which is longer and shadier' }
        ] },
        links: [] },
      { id: 'harbour-tour', section: 'do', status: 'backup',
        name: 'Harbour boat tour',
        price: { text: '~40 EUR' },
        note: 'Sold from a dozen kiosks along the front. They are all the same boat.',
        rating: { stars: 3.2 },
        intel: { verdicts: [
          { tier: 'skip', text: 'the three-island day trip, which is five hours for twenty minutes of swimming' }
        ] },
        links: [] }
    ]
  }
};

// ---- build the snapshot through the product's own function ----
const CityOps = loadCityOps();
const snapshot = CityOps.shareKit.build({
  travelerName: TRAVELER,
  generatedAt: new Date().toISOString(),
  cities: cities,
  transitions: transitions,
  // hideLodging is the "work link" mode, which blanks stay names. The sample
  // is the family-grade view on purpose: it has more on it to look at, and
  // every name in it is invented anyway.
  hideLodging: false,
  guideIds: [guideRow.city_id],
  guides: [guideRow],
  includeGuides: [guideRow.city_id]
});

// ---- and bake it into the assembled share page ----
//
// Same replacement, same escaping and the same "</" guard as
// buildFamilyShareHTML in the trip surface. "\/" is a valid JSON escape for
// "/", so escaping every "</" cannot change what the JSON parses to, and it
// makes it impossible for the data to close the script element it sits in.
const page = fs.readFileSync(path.join(root, 'share', 'index.html'), 'utf8');
const json = JSON.stringify(snapshot, null, 1).replace(/<\//g, '<\\/');
const marker = /(<script type="application\/json" id="share-data">)[\s\S]*?(<\/script>)/;
if (!marker.test(page)) throw new Error('share-data block not found in share/index.html');
let out = page.replace(marker, function (m, open, close) {
  return open + '\n' + json + '\n' + close;
});
if (out === page) throw new Error('the snapshot did not go in');

// ---- then take the network out of it ----
//
// A baked page never reaches its fetch: boot() reads the embedded block first
// and returns before it looks for a token. That is an argument about control
// flow, though, and this page is going on a public marketing site, so the
// argument is replaced with a fact. The account origin and the publishable key
// come out, and the policy that used to allow that one origin is closed to
// 'none', which means the browser itself would refuse a request rather than
// this file being trusted not to make one.
//
// Every substitution asserts it hit something. If the share shell is reworded
// upstream, this fails the build instead of quietly publishing a live endpoint.
function must(text, find, replace, what) {
  if (text.indexOf(find) === -1) {
    throw new Error('could not neutralise ' + what + ': the share shell no longer contains "' +
      find.slice(0, 60) + '". Re-read src/share-shell.html and update tools/demo-plan.js.');
  }
  return text.split(find).join(replace);
}

out = must(out,
  "connect-src https://ggscdbbvqmqiyguiccrf.supabase.co;",
  "connect-src 'none';",
  'the connect-src policy');
out = must(out,
  "  url: 'https://ggscdbbvqmqiyguiccrf.supabase.co',",
  "  url: '',",
  'the account origin');
out = must(out,
  "  anon: 'sb_publishable_j3oRAQ-3889fkN26FtaE7g_jMyx1Lda'",
  "  anon: ''",
  'the publishable key');
out = must(out,
  "      form-action 'none' and confines connect-src to the one Supabase origin,",
  "      form-action 'none' and, in this frozen sample copy, connect-src 'none',",
  'the connect-src note');
out = must(out,
  '//      The single call this page makes is rpc/get_share, which is a read.',
  '//      This copy makes no call at all: its snapshot is baked into the file.',
  'the one-call note');

// ---- refuse to write a page that is not read-only ----
//
// Cheap, and it is the assertion the whole exercise rests on. A future change
// to the share shell that added a form, a write endpoint or an editor engine
// would otherwise be published on the marketing site without anyone noticing.
const mustNotContain = [
  ['<form', 'a form element'],
  ['<input', 'an input'],
  ['<textarea', 'a text area'],
  ['contenteditable', 'an editable region'],
  ['localStorage', 'browser storage'],
  ['CityOps.init', 'the editor engine']
];
mustNotContain.forEach(function (pair) {
  if (out.indexOf(pair[0]) !== -1) {
    throw new Error('the sample plan would ship ' + pair[1] + ' (' + pair[0] + '). ' +
      'The share page is supposed to be read-only by construction; fix that before publishing.');
  }
});
// No share token can be in here, and no live endpoint or key either.
if (/[0-9a-f]{32}/.test(json)) throw new Error('the snapshot looks like it carries a token');
if (out.indexOf('__SHARE_DATA__') !== -1) throw new Error('the data marker survived');
if (out.indexOf('supabase.co') !== -1) throw new Error('a supabase origin survived neutralisation');
if (out.indexOf('sb_publishable') !== -1) throw new Error('a publishable key survived neutralisation');
// And nothing of the owner's, which is the whole reason this file exists.
['robriggs', 'Rob Riggs', 'wheres.', 'robs-travel'].forEach(function (needle) {
  if (out.indexOf(needle) !== -1) {
    throw new Error('the sample plan carries "' + needle + '", which is exactly what it replaces');
  }
});

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, out);
console.log('wrote ' + outPath + ': ' + snapshot.cities.length + ' stops, ' +
  snapshot.transitions.length + ' legs, ' + snapshot.guides.length + ' guide(s), ' +
  (out.length / 1024).toFixed(0) + 'KB');
