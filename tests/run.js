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

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
