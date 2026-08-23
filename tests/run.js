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
  assert.deepEqual(r.summary, { added: 2, skipped: 0, sectionsAdded: 1, intelApplied: 1, intelSkipped: 0 });
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
    { added: 0, skipped: 2, sectionsAdded: 0, intelApplied: 1, intelSkipped: 0 });
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
    { added: 0, skipped: 0, sectionsAdded: 0, intelApplied: 0, intelSkipped: 0 });
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
  '<' + '!-- /RERUN:INTEL -->'
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
  ['RULES:INTEL', 'CONTRACT:ITEM', 'RERUN:INTERESTS', 'RERUN:INTEL'].forEach((name) => {
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

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
