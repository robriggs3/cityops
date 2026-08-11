# CityOps Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Batumi single-file guide into a reusable template (renderer + embedded cityops schema v1 JSON) with item lifecycle, export/import, share/print view, a generation prompt, and a working Yerevan guide by Friday 2026-08-14.

**Architecture:** One `template.html` per the approved spec: static CSS ported from the v5 guide, a `<script type="application/json" id="city-data">` block holding the city JSON, and a dependency-free `<script id="app">` exposing a `CityOps` object of pure functions (parse/validate, state merge, export) plus DOM rendering. Live state lives in localStorage keyed by city; the JSON block is never mutated. Node tests eval the app script out of `template.html` via a tiny harness, so pure logic is unit-tested without any framework.

**Tech Stack:** Vanilla HTML/CSS/JS (ES5-style, matching v5). Node built-ins only for tests (`node:assert`, `fs`). No npm, no build step, no dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-cityops-phase1-design.md`. Reread it before starting.
- Repo: `/Users/robriggs/claude/developer/cityops`. Local only. NEVER push, never add a remote.
- No external dependencies, no CDN links, no npm. A city guide is one self-contained HTML file that works from `file://` offline.
- No em-dash characters anywhere: code, comments, commits, docs, UI copy (Rob's standing rule). Use colons, commas, or hyphens.
- Schema is v1 from the spec, `"schema": 1` required. Statuses: `plan | backup | archived | done`. `hours.class`: `late | day | eve`. `links[].kind`: `map | web | tel`. `place_id` and `verified` always present, null.
- localStorage key: `cityops.<cityId>.v1` where cityId = slug(city.name) + '-' + city.dates.from.
- The JSON data block is canonical and never mutated by the app. All live changes go to localStorage.
- Controls only render for states where the action is valid: no dead buttons (Rob's standing UX rule).
- Tests: `node tests/run.js` must pass at the end of every task. Commit per task.
- The app script MUST be exactly `<script id="app">` and define a global `var CityOps` (the test harness extracts and evals it).

---

### Task 1: Repo scaffolding, test harness, core pure logic

**Files:**
- Create: `reference/batumi-guide-v5.html` (copy of `/Users/robriggs/Downloads/batumi-guide-v5.html`)
- Create: `template.html`
- Create: `tests/harness.js`
- Create: `tests/run.js`

**Interfaces:**
- Produces: `CityOps.parse(text) -> {data|null, errors: string[]}`, `CityOps.validate(data) -> string[]`, `CityOps.cityId(data) -> string`, `CityOps.slug(s) -> string`, `CityOps.dayLabel(iso) -> "Thu 13"`, `CityOps.STATUSES`, and harness `loadCityOps()` used by every later test.

- [ ] **Step 1: Copy the reference guide into the repo**

```bash
mkdir -p /Users/robriggs/claude/developer/cityops/reference /Users/robriggs/claude/developer/cityops/tests /Users/robriggs/claude/developer/cityops/cities /Users/robriggs/claude/developer/cityops/tools
cp "/Users/robriggs/Downloads/batumi-guide-v5.html" /Users/robriggs/claude/developer/cityops/reference/batumi-guide-v5.html
```

- [ ] **Step 2: Write the harness and the first failing tests**

`tests/harness.js`:

```js
// Extracts the <script id="app"> block from template.html and evals it in Node.
// DOM globals are stubbed so CityOps.init() bails out and only pure logic loads.
const fs = require('fs');
const path = require('path');

function loadCityOps() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'template.html'), 'utf8');
  const m = html.match(/<script id="app">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No <script id="app"> block in template.html');
  const stubDoc = { getElementById: function () { return null; }, addEventListener: function () {} };
  const fn = new Function('document', 'window', 'localStorage',
    m[1] + '\nreturn CityOps;');
  return fn(stubDoc, undefined, undefined);
}
module.exports = { loadCityOps };
```

`tests/run.js`:

```js
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

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
```

- [ ] **Step 3: Run tests, verify they fail for the right reason**

Run: `cd /Users/robriggs/claude/developer/cityops && node tests/run.js`
Expected: throws `No <script id="app"> block in template.html` (template does not exist yet).

- [ ] **Step 4: Write template.html skeleton with the core logic**

`template.html` (complete file at this stage; CSS and rendering come in Tasks 3 and 4):

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CityOps Guide</title>
<style>
  /* CSS ported in Task 3 */
</style>
</head>
<body>
<div class="wrap">
  <div id="notice"></div>
  <header id="hdr"></header>
  <div class="toolbar" id="toolbar"></div>
  <main id="main"></main>
  <div class="foot" id="foot"></div>
</div>
<div id="modal"></div>

<script type="application/json" id="city-data">
{
  "schema": 1,
  "city": {
    "name": "Example City", "country": "XX",
    "dates": {"from": "2026-01-01", "to": "2026-01-07"},
    "accommodation": {"name": "Example Stay", "lat": 0, "lng": 0},
    "currency": {"code": "USD", "usd": 1},
    "notes": ["Replace this block with generated city JSON"]
  },
  "sections": [
    {"id": "dinner", "label": "Dinner", "icon": "🍽️"}
  ],
  "items": [{
    "id": "example",
    "section": "dinner",
    "status": "plan",
    "day": "2026-01-02",
    "when": "First evening",
    "name": "Example Restaurant",
    "price": {"text": "~$20"},
    "note": "Replace me. This item exists so the empty template renders.",
    "hours": {"text": "12:00-23:00 daily", "class": "late"},
    "tags": [],
    "links": [],
    "place_id": null,
    "verified": null
  }]
}
</script>

<script id="app">
var CityOps = (function () {
  'use strict';

  var STATUSES = ['plan', 'backup', 'archived', 'done'];

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function cityId(data) {
    return slug(data.city.name) + '-' + data.city.dates.from;
  }
  function dayLabel(iso) {
    var d = new Date(iso + 'T12:00:00');
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return names[d.getDay()] + ' ' + d.getDate();
  }

  function validate(data) {
    var errors = [];
    if (!data || typeof data !== 'object') return ['Root is not an object'];
    if (data.schema !== 1) errors.push('schema must be 1');
    if (!data.city || !data.city.name) errors.push('city.name required');
    if (!data.city || !data.city.dates || !data.city.dates.from || !data.city.dates.to) {
      errors.push('city.dates.from and city.dates.to required');
    }
    if (!Array.isArray(data.sections) || !data.sections.length) {
      errors.push('sections[] required');
    } else {
      data.sections.forEach(function (s, i) {
        if (!s.id || !s.label) errors.push('sections[' + i + '] needs id and label');
      });
    }
    if (!Array.isArray(data.items)) {
      errors.push('items[] required');
    } else {
      var secIds = {};
      (data.sections || []).forEach(function (s) { secIds[s.id] = 1; });
      var seen = {};
      data.items.forEach(function (it, i) {
        var ref = 'items[' + i + ']' + (it && it.id ? ' (' + it.id + ')' : '');
        if (!it.id) errors.push(ref + ' needs id');
        else if (seen[it.id]) errors.push('duplicate item id "' + it.id + '"');
        else seen[it.id] = 1;
        if (!it.name) errors.push(ref + ' needs name');
        if (!secIds[it.section]) errors.push(ref + ' unknown section "' + it.section + '"');
        if (STATUSES.indexOf(it.status) === -1) errors.push(ref + ' bad status "' + it.status + '"');
        if (it.day && !/^\d{4}-\d{2}-\d{2}$/.test(it.day)) errors.push(ref + ' day must be YYYY-MM-DD');
      });
    }
    return errors;
  }

  function parse(text) {
    var data;
    try { data = JSON.parse(text); }
    catch (e) { return { data: null, errors: ['JSON parse error: ' + e.message] }; }
    var errors = validate(data);
    return { data: errors.length ? null : data, errors: errors };
  }

  function init() {
    var el = document.getElementById('city-data');
    if (!el) return; // Node test harness path: pure logic only
    // Rendering wired up in Task 4.
  }

  return {
    STATUSES: STATUSES, slug: slug, cityId: cityId, dayLabel: dayLabel,
    validate: validate, parse: parse, init: init
  };
})();
CityOps.init();
</script>
</body>
</html>
```

- [ ] **Step 5: Run tests, verify all pass**

Run: `node tests/run.js`
Expected: `6 passed, 0 failed` (approximately; every test PASS, zero FAIL, exit 0).

- [ ] **Step 6: Commit**

```bash
cd /Users/robriggs/claude/developer/cityops && git add -A && git commit -m "feat: template skeleton, test harness, schema parse/validate + city id + day labels"
```

---

### Task 2: State model (localStorage store, status transitions, view model)

**Files:**
- Modify: `template.html` (inside the `CityOps` IIFE, before the `return`)
- Modify: `tests/run.js` (append tests before the final summary lines)

**Interfaces:**
- Consumes: `validate`, `dayLabel`, `STATUSES` from Task 1.
- Produces: `CityOps.emptyState() -> {itemStatus:{}, dayOrder:{}, dataOverride:null, updated:null}`, `CityOps.makeStore(id, storage) -> {persistent, load(), save(st)}`, `CityOps.effectiveStatus(item, state) -> status`, `CityOps.effectiveData(base, state) -> data`, `CityOps.setStatus(state, id, to) -> state`, `CityOps.TRANSITIONS`, `CityOps.viewModel(data, state) -> [{section, days:[{iso,label,items}], undated, backups, archived}]`.

- [ ] **Step 1: Append failing tests to tests/run.js** (insert before the `console.log(pass + ...)` line; same placement for all later tasks)

```js
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
test('viewModel groups by section: days ordered, backups split out', () => {
  const vm = C.viewModel(GOOD, C.emptyState());
  assert.equal(vm.length, 2);
  const dinner = vm[0];
  // days in first-appearance order from items[]: brasserie (Aug 13) then tanini (Aug 10)
  assert.deepEqual(dinner.days.map(d => d.iso), ['2026-08-13', '2026-08-10']);
  assert.equal(dinner.days[0].label, 'Thu 13');
  assert.deepEqual(dinner.backups.map(i => i.id), ['sisters']);
  assert.equal(dinner.archived.length, 0);
  assert.deepEqual(vm[1].undated.map(i => i.id), ['nord']);
});
test('viewModel honors saved dayOrder, ignores unknown days', () => {
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-10', '2026-08-13', '2026-01-01'];
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(vm[0].days.map(d => d.iso), ['2026-08-10', '2026-08-13']);
});
test('viewModel keeps done items in place, moves archived out', () => {
  const st = C.emptyState();
  C.setStatus(st, 'brasserie', 'done');
  C.setStatus(st, 'tanini', 'archived');
  const vm = C.viewModel(GOOD, st);
  assert.deepEqual(vm[0].days.map(d => d.iso), ['2026-08-13']);
  assert.equal(vm[0].days[0].items[0].id, 'brasserie');
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
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node tests/run.js`
Expected: Task 1 tests PASS; new tests FAIL with `C.makeStore is not a function` etc.

- [ ] **Step 3: Implement in template.html** (inside the IIFE; `makeStore` takes the storage object as a parameter so tests can inject a fake; the browser caller passes the real `localStorage` in Task 4)

```js
  var TRANSITIONS = {
    plan:     [{ to: 'done', label: '✓ Done' }, { to: 'backup', label: '↓ Backup' }, { to: 'archived', label: '✕ Archive' }],
    backup:   [{ to: 'plan', label: '↑ Promote' }, { to: 'archived', label: '✕ Archive' }],
    done:     [{ to: 'plan', label: '↩ Undo' }],
    archived: [{ to: 'backup', label: '↩ Restore' }]
  };

  function emptyState() {
    return { itemStatus: {}, dayOrder: {}, dataOverride: null, updated: null };
  }

  function makeStore(id, storage) {
    var key = 'cityops.' + id + '.v1';
    var mem = null;
    var ok = true;
    try {
      storage.setItem(key + '.t', '1');
      storage.removeItem(key + '.t');
    } catch (e) { ok = false; }
    if (!storage) ok = false;
    return {
      persistent: ok,
      load: function () {
        if (mem) return JSON.parse(JSON.stringify(mem));
        if (!ok) return emptyState();
        try {
          var raw = storage.getItem(key);
          return raw ? JSON.parse(raw) : emptyState();
        } catch (e) { return emptyState(); }
      },
      save: function (st) {
        st.updated = new Date().toISOString();
        mem = JSON.parse(JSON.stringify(st));
        if (ok) {
          try { storage.setItem(key, JSON.stringify(st)); } catch (e) { ok = false; }
        }
      }
    };
  }

  function setStatus(state, id, to) {
    if (STATUSES.indexOf(to) === -1) throw new Error('bad status "' + to + '"');
    state.itemStatus[id] = to;
    return state;
  }

  function effectiveStatus(it, state) {
    return state.itemStatus[it.id] || it.status;
  }

  function effectiveData(base, state) {
    if (state.dataOverride && !validate(state.dataOverride).length) return state.dataOverride;
    return base;
  }

  function viewModel(data, state) {
    return data.sections.map(function (sec) {
      var items = data.items.filter(function (it) { return it.section === sec.id; });
      var active = items.filter(function (it) {
        var s = effectiveStatus(it, state);
        return s === 'plan' || s === 'done';
      });
      var dayed = active.filter(function (it) { return it.day; });
      var undated = active.filter(function (it) { return !it.day; });
      var appear = [];
      dayed.forEach(function (it) { if (appear.indexOf(it.day) === -1) appear.push(it.day); });
      var order = (state.dayOrder[sec.id] || []).filter(function (d) { return appear.indexOf(d) !== -1; });
      appear.forEach(function (d) { if (order.indexOf(d) === -1) order.push(d); });
      return {
        section: sec,
        days: order.map(function (iso) {
          return { iso: iso, label: dayLabel(iso), items: dayed.filter(function (it) { return it.day === iso; }) };
        }),
        undated: undated,
        backups: items.filter(function (it) { return effectiveStatus(it, state) === 'backup'; }),
        archived: items.filter(function (it) { return effectiveStatus(it, state) === 'archived'; })
      };
    });
  }
```

Note the guard: `makeStore(id, null)` must not throw. Put the `if (!storage) ok = false;` check BEFORE the try block (order in the final code: check null first, then probe with try). Extend the `return` object of the IIFE with: `emptyState, makeStore, setStatus, effectiveStatus, effectiveData, viewModel, TRANSITIONS`.

- [ ] **Step 4: Run tests, verify all pass**

Run: `node tests/run.js`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: state store, status transitions, section/day view model"
```

---

### Task 3: CSS port from v5 + cityops additions

**Files:**
- Modify: `template.html` (replace the `/* CSS ported in Task 3 */` style block)

**Interfaces:**
- Consumes: class names used by the v5 guide (`.wrap, header, .chip, h2, .card, .daycard, .hd, .bd, .row, .hours, .late/.day/.eve, .maplink, .weblink, .phonelink, .tag, .backup, .bt, .callout, .warn, .lead, .foot, .grip, .dragging, .shifting, .dropline, .reorderbar`).
- Produces: those classes plus new ones the renderer (Task 4+) uses: `.ctl-row, .ctl, .item-done, .donemark, .arch-details, .toolbar, .flag, .errcard, .modal-wrap, .modal, .mrow, .diff, body.share, @media print`.

- [ ] **Step 1: Port the v5 CSS**

Copy the entire contents of the `<style>` element from `reference/batumi-guide-v5.html` (lines 8-107 of that file, everything between `<style>` and `</style>`) into template.html's style block, verbatim.

- [ ] **Step 2: Append the cityops additions below the ported CSS**

```css
  /* --- cityops additions --- */
  .ctl-row{display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;}
  .ctl{font:inherit; font-size:.74rem; font-weight:700; color:var(--sea-deep);
    background:#fff; border:1.5px solid var(--line); border-radius:20px;
    padding:4px 11px; cursor:pointer;}
  .ctl:hover{border-color:var(--sea);}
  .ctl.to-done:hover{border-color:var(--ok); color:var(--ok);}
  .ctl.to-archived:hover{border-color:var(--flag); color:var(--flag);}
  .item-done{opacity:.55;}
  .donemark{color:var(--ok); font-weight:800; margin-right:6px;}
  .arch-details{margin:2px 0 22px;}
  .arch-details summary{font-size:.72rem; font-weight:800; letter-spacing:.6px;
    text-transform:uppercase; color:var(--muted); cursor:pointer; padding:6px 0;}
  .arch-details .card, .arch-details .daycard{opacity:.7;}
  .toolbar{display:flex; gap:8px; flex-wrap:wrap; margin:0 0 16px; align-items:center;}
  .toolbar button{font:inherit; font-weight:700; color:var(--sea-deep); background:#fff;
    border:1.5px solid var(--line); border-radius:20px; padding:5px 13px;
    cursor:pointer; font-size:.8rem;}
  .toolbar button:hover{border-color:var(--sea);}
  .toolbar .flag{font-size:.74rem; color:var(--gold); font-weight:700;}
  .errcard{background:#fbe9e4; border-left:4px solid var(--flag); border-radius:10px;
    padding:14px 16px; margin:20px 0; font-size:.9rem;}
  .errcard b{color:var(--flag);}
  #notice{font-size:.78rem; color:var(--muted); margin:8px 0;}
  .when-line{font-size:.8rem; color:var(--muted); font-style:italic; margin-top:2px;}
  .modal-wrap{position:fixed; inset:0; background:rgba(26,37,48,.5); display:flex;
    align-items:center; justify-content:center; padding:16px; z-index:100;}
  .modal{background:#fff; border-radius:14px; padding:18px; max-width:640px;
    width:100%; max-height:85vh; overflow:auto;}
  .modal textarea{width:100%; min-height:200px; font-family:ui-monospace,Menlo,monospace;
    font-size:.78rem; border:1px solid var(--line); border-radius:8px; padding:10px;}
  .modal .mrow{display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;}
  .modal .diff{font-size:.8rem; color:var(--muted); margin-top:8px; white-space:pre-line;}
  body.share .ctl-row, body.share .grip, body.share .reorderbar{display:none;}
  @media print{
    .toolbar, .ctl-row, .grip, .reorderbar, #notice{display:none !important;}
    body{background:#fff;}
    .daycard, .card{box-shadow:none; break-inside:avoid;}
    header{background:var(--sea-deep) !important; -webkit-print-color-adjust:exact;}
  }
```

- [ ] **Step 3: Verify tests still pass and the file renders**

Run: `node tests/run.js` (all PASS), then open `template.html` in the Browser pane (`file:///Users/robriggs/claude/developer/cityops/template.html`) and confirm: sand background, no console errors. The page body is still empty of content (renderer lands in Task 4).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: port v5 CSS, add lifecycle/toolbar/modal/share/print styles"
```

---

### Task 4: DOM renderer (header, sections, cards, lifecycle controls)

**Files:**
- Modify: `template.html` (rendering functions inside the IIFE + real `init`)
- Modify: `tests/run.js` (append)

**Interfaces:**
- Consumes: `viewModel`, `effectiveData`, `effectiveStatus`, `makeStore`, `TRANSITIONS`, `setStatus`, `dayLabel`, `cityId`, `parse`.
- Produces: `CityOps.fmtRange(dates) -> "Aug 8-15, 2026"`; working page: `CityOps.init()` renders the full guide and re-renders on every status change. Task 5+ rely on `render()` being callable via an internal `rerender()` and on day card containers having class `days` with `data-sec="<sectionId>"` and each day card `data-day="<iso>"`.

- [ ] **Step 1: Append failing test for fmtRange**

```js
// Task 4: rendering helpers
test('fmtRange formats a stay', () => {
  assert.equal(C.fmtRange({ from: '2026-08-08', to: '2026-08-15' }), 'Aug 8-15, 2026');
  assert.equal(C.fmtRange({ from: '2026-08-28', to: '2026-09-04' }), 'Aug 28 - Sep 4, 2026');
});
```

Run: `node tests/run.js`. Expected: new test FAILS (`C.fmtRange is not a function`).

- [ ] **Step 2: Implement fmtRange and the renderer inside the IIFE**

```js
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function fmtRange(d) {
    var a = new Date(d.from + 'T12:00:00');
    var b = new Date(d.to + 'T12:00:00');
    if (a.getMonth() === b.getMonth()) {
      return MONTHS[a.getMonth()] + ' ' + a.getDate() + '-' + b.getDate() + ', ' + b.getFullYear();
    }
    return MONTHS[a.getMonth()] + ' ' + a.getDate() + ' - ' + MONTHS[b.getMonth()] + ' ' + b.getDate() + ', ' + b.getFullYear();
  }

  // ---- DOM rendering (browser only) ----
  var ctx = null; // { base, store }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function linkPill(l) {
    var a = document.createElement('a');
    a.href = l.href;
    if (l.kind === 'map') { a.className = 'maplink'; a.target = '_blank'; a.textContent = '📍 ' + l.label; }
    else if (l.kind === 'web') { a.className = 'weblink'; a.target = '_blank'; a.textContent = '🌐 ' + l.label; }
    else { a.className = 'phonelink'; a.textContent = '📞 ' + l.label; }
    return a;
  }

  function onStatus(id, to) {
    var st = ctx.store.load();
    setStatus(st, id, to);
    ctx.store.save(st);
    rerender();
  }

  function itemBody(it, status, showWhen) {
    var frag = document.createDocumentFragment();
    var h3 = el('h3');
    if (status === 'done') h3.appendChild(el('span', 'donemark', '✓'));
    h3.appendChild(document.createTextNode(it.name));
    if (it.price) h3.appendChild(el('span', 'price', it.price.text));
    frag.appendChild(h3);
    if (showWhen && it.when) frag.appendChild(el('p', 'when-line', it.when));
    if (it.tags && it.tags.length) {
      var tp = el('p');
      it.tags.forEach(function (t) { tp.appendChild(el('span', 'tag', t)); });
      frag.appendChild(tp);
    }
    if (it.note) frag.appendChild(el('p', null, it.note));
    var row = el('div', 'row');
    if (it.hours) row.appendChild(el('span', 'hours ' + (it.hours.class || 'day'), it.hours.text));
    (it.links || []).forEach(function (l) { row.appendChild(linkPill(l)); });
    if (row.children.length) frag.appendChild(row);
    var ctl = el('div', 'ctl-row');
    (TRANSITIONS[status] || []).forEach(function (t) {
      var b = el('button', 'ctl to-' + t.to, t.label);
      b.type = 'button';
      b.onclick = function () { onStatus(it.id, t.to); };
      ctl.appendChild(b);
    });
    if (ctl.children.length) frag.appendChild(ctl);
    return frag;
  }

  function renderCard(it, status) {
    var card = el('div', 'card' + (status === 'done' ? ' item-done' : ''));
    card.appendChild(itemBody(it, status, true));
    return card;
  }

  function renderDayCard(day, state) {
    var dc = el('div', 'daycard');
    dc.dataset.day = day.iso;
    var hd = el('div', 'hd');
    hd.appendChild(el('span', 'd', day.label));
    if (day.items.length === 1 && day.items[0].when) hd.appendChild(el('span', 't', day.items[0].when));
    dc.appendChild(hd);
    day.items.forEach(function (it) {
      var status = effectiveStatus(it, state);
      var bd = el('div', 'bd' + (status === 'done' ? ' item-done' : ''));
      bd.appendChild(itemBody(it, status, day.items.length > 1));
      dc.appendChild(bd);
    });
    return dc;
  }

  function renderHeader(data) {
    var c = data.city;
    var h = document.getElementById('hdr');
    h.innerHTML = '';
    h.appendChild(el('h1', null, c.name));
    var sub = fmtRange(c.dates) + (c.accommodation && c.accommodation.name ? ' · ' + c.accommodation.name : '');
    h.appendChild(el('div', 'sub', sub));
    var facts = el('div', 'facts');
    if (c.currency && c.currency.code !== 'USD') {
      facts.appendChild(el('span', 'chip', c.currency.code + ' = $' + c.currency.usd));
    }
    (c.notes || []).forEach(function (n) { facts.appendChild(el('span', 'chip', n)); });
    h.appendChild(facts);
    document.title = c.name + ' Guide · ' + fmtRange(c.dates);
  }

  function renderSection(sv, state) {
    var frag = document.createDocumentFragment();
    var h2 = el('h2');
    if (sv.section.icon) h2.appendChild(el('span', 'ic', sv.section.icon));
    h2.appendChild(document.createTextNode(' ' + sv.section.label));
    frag.appendChild(h2);
    if (sv.days.length) {
      var days = el('div', 'days');
      days.dataset.sec = sv.section.id;
      sv.days.forEach(function (d) { days.appendChild(renderDayCard(d, state)); });
      frag.appendChild(days);
    }
    sv.undated.forEach(function (it) { frag.appendChild(renderCard(it, effectiveStatus(it, state))); });
    if (sv.backups.length) {
      var bk = el('div', 'backup');
      bk.appendChild(el('div', 'bt', '↩ Backups: if Plan A is full, closed, or you want a change'));
      sv.backups.forEach(function (it) { bk.appendChild(renderCard(it, 'backup')); });
      frag.appendChild(bk);
    }
    if (sv.archived.length) {
      var det = el('details', 'arch-details');
      det.appendChild(el('summary', null, 'Archived (' + sv.archived.length + ')'));
      sv.archived.forEach(function (it) { det.appendChild(renderCard(it, 'archived')); });
      frag.appendChild(det);
    }
    return frag;
  }

  function rerender() {
    var state = ctx.store.load();
    var data = effectiveData(ctx.base, state);
    renderHeader(data);
    renderToolbar(data, state);
    var main = document.getElementById('main');
    main.innerHTML = '';
    viewModel(data, state).forEach(function (sv) { main.appendChild(renderSection(sv, state)); });
    var foot = document.getElementById('foot');
    foot.textContent = 'cityops · schema v1 · state saved on this device';
    var notice = document.getElementById('notice');
    notice.textContent = ctx.store.persistent ? '' :
      'Private mode: changes hold for this session only and are not saved.';
  }

  function renderToolbar(data, state) {
    var tb = document.getElementById('toolbar');
    tb.innerHTML = '';
    // Export / Update data / Share buttons attach in Tasks 6-8.
    if (state.dataOverride) {
      tb.appendChild(el('span', 'flag', 'Data updated in-app: export and paste into the file to make permanent'));
    }
  }

  function renderError(errors) {
    var main = document.getElementById('main');
    main.innerHTML = '';
    var card = el('div', 'errcard');
    var b = el('b', null, 'This guide\'s city data has a problem.');
    card.appendChild(b);
    errors.forEach(function (m) { card.appendChild(el('p', null, m)); });
    card.appendChild(el('p', null, 'Fix the JSON inside the <script id="city-data"> block and reload.'));
    main.appendChild(card);
  }

  function init() {
    var elData = document.getElementById('city-data');
    if (!elData) return; // Node test harness path
    var res = parse(elData.textContent);
    if (!res.data) { renderError(res.errors); return; }
    var store = makeStore(cityId(res.data), (typeof localStorage !== 'undefined') ? localStorage : null);
    ctx = { base: res.data, store: store };
    rerender();
  }
```

Add `fmtRange` to the IIFE's return object. Keep `renderToolbar` minimal for now; later tasks extend it.

Note for the harness: `typeof localStorage !== 'undefined'` is not enough because the harness passes `localStorage` as an undefined parameter, making `typeof` return 'undefined': correct, `makeStore(..., null)` path is taken, but init already returned at the `!elData` guard, so this line never runs in Node. No change needed.

- [ ] **Step 3: Run tests and verify the rendered page**

Run: `node tests/run.js`. Expected: all PASS.
Open `file:///Users/robriggs/claude/developer/cityops/template.html` in the Browser pane and verify with read_page/screenshot:
- Header shows "Example City", "Jan 1-7, 2026 · Example Stay", chip with the note.
- One Dinner section with one day card "Fri 2", the example item, hours badge, ✓ Done / ↓ Backup / ✕ Archive buttons.
- Click ✓ Done: card dims, shows ✓, single ↩ Undo button. Reload the page: done state persists.
- Click ↩ Undo, then ↓ Backup: item moves to the Backups block with ↑ Promote / ✕ Archive.
- ✕ Archive: item moves into "Archived (1)" disclosure; ↩ Restore returns it to Backups.
- No console errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: full renderer with header, day cards, lifecycle controls, error card"
```

---

### Task 5: Drag reorder for day cards (pointer + keyboard), per section

**Files:**
- Modify: `template.html`

**Interfaces:**
- Consumes: `.days[data-sec]` containers and `.daycard[data-day]` cards from Task 4; `ctx.store` state shape `dayOrder: {sectionId: [iso...]}`.
- Produces: drag/keyboard reorder persisting to `state.dayOrder[sec]`; a reorder bar with reset per the v5 pattern, rendered only when a section has 2+ day cards.

- [ ] **Step 1: Implement**

Port the v5 pointer-drag script (reference/batumi-guide-v5.html lines 442-587) with these changes, adding inside the IIFE and calling `attachReorder()` at the end of `rerender()`:

```js
  function saveDayOrder(sec, isos) {
    var st = ctx.store.load();
    st.dayOrder[sec] = isos;
    ctx.store.save(st);
  }

  function attachReorder() {
    var lists = document.querySelectorAll('.days');
    Array.prototype.forEach.call(lists, function (list) {
      var sec = list.dataset.sec;
      var cards = function () { return Array.prototype.slice.call(list.querySelectorAll('.daycard')); };
      if (cards().length < 2) return;

      var bar = el('div', 'reorderbar');
      var status = el('span', null, 'Drag the ⠿ handle to reorder days. Saved on this device.');
      var reset = el('button', null, 'Reset to date order');
      reset.type = 'button';
      reset.onclick = function () {
        var st = ctx.store.load();
        delete st.dayOrder[sec];
        ctx.store.save(st);
        rerender();
      };
      bar.appendChild(status);
      bar.appendChild(reset);
      list.parentNode.insertBefore(bar, list);

      cards().forEach(function (card) {
        var g = el('div', 'grip');
        g.setAttribute('role', 'button');
        g.setAttribute('tabindex', '0');
        g.setAttribute('aria-label', 'Reorder this day. Use arrow up and arrow down keys.');
        g.innerHTML = '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
          '<circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>' +
          '<circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>' +
          '<circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>';
        card.appendChild(g);
      });

      var drag = null;
      list.addEventListener('pointerdown', function (e) {
        var grip = e.target.closest('.grip');
        if (!grip) return;
        var card = grip.closest('.daycard');
        if (!card) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        drag = { card: card, grip: grip, startY: e.clientY };
        card.classList.add('dragging');
      });
      window.addEventListener('pointermove', function (e) {
        if (!drag || !list.contains(drag.card)) return;
        e.preventDefault();
        var y = e.clientY;
        drag.card.style.transform = 'translateY(' + (y - drag.startY) + 'px) scale(1.015)';
        var others = cards().filter(function (c) { return c !== drag.card; });
        for (var i = 0; i < others.length; i++) {
          var r = others[i].getBoundingClientRect();
          var mid = r.top + r.height / 2;
          var after = drag.card.compareDocumentPosition(others[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
          if (after && y > mid) {
            drag.card.style.transform = '';
            list.insertBefore(others[i], drag.card);
            drag.startY = y;
            drag.card.style.transform = 'scale(1.015)';
            return;
          }
          if (!after && y < mid) {
            drag.card.style.transform = '';
            list.insertBefore(drag.card, others[i]);
            drag.startY = y;
            drag.card.style.transform = 'scale(1.015)';
            return;
          }
        }
      }, { passive: false });
      function endDrag(e) {
        if (!drag || !list.contains(drag.card)) return;
        drag.card.classList.remove('dragging');
        drag.card.style.transform = '';
        try { drag.grip.releasePointerCapture(e.pointerId); } catch (err) {}
        drag = null;
        saveDayOrder(sec, cards().map(function (c) { return c.dataset.day; }));
      }
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);

      list.addEventListener('keydown', function (e) {
        var grip = e.target.closest('.grip');
        if (!grip) return;
        var card = grip.closest('.daycard');
        if (e.key === 'ArrowUp' && card.previousElementSibling) {
          e.preventDefault();
          list.insertBefore(card, card.previousElementSibling);
          grip.focus();
          saveDayOrder(sec, cards().map(function (c) { return c.dataset.day; }));
        } else if (e.key === 'ArrowDown' && card.nextElementSibling) {
          e.preventDefault();
          list.insertBefore(card.nextElementSibling, card);
          grip.focus();
          saveDayOrder(sec, cards().map(function (c) { return c.dataset.day; }));
        }
      });
    });
  }
```

Known simplification vs v5: window-level pointer listeners are re-added per rerender. Guard against duplicates by naming the handlers and storing them on `ctx` the first time, or simpler: attach the window listeners once at init (not in attachReorder) and have them no-op when `drag` is null. Implement the latter: hoist `drag` and the two window listeners out of the per-list closure into module scope, keyed by current list (`drag = {card, grip, startY, list, cards}`), and only bind them once in `init()`.

- [ ] **Step 2: Verify in browser**

The example template has one day card, so temporarily duplicate the example item in the data block with `"id": "example2", "day": "2026-01-03"` (revert after checking). Open the page and verify: reorder bar appears, dragging the grip swaps the two day cards, order survives reload, "Reset to date order" restores and survives reload. Keyboard: focus grip, arrow down/up moves the card. Revert the temporary item.

Run: `node tests/run.js`. Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: per-section day drag reorder with keyboard fallback, persisted day order"
```

---

### Task 6: Export (merged JSON download) with lossless round trip

**Files:**
- Modify: `template.html`
- Modify: `tests/run.js` (append)

**Interfaces:**
- Consumes: `viewModel`, `effectiveStatus`, `effectiveData`, `cityId`.
- Produces: `CityOps.buildExport(data, state) -> data'` (statuses baked in, items reordered to live view order); Export button in the toolbar downloading `<cityId>.cityops.json`.

- [ ] **Step 1: Append failing tests**

```js
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
test('buildExport applies live day order to item order', () => {
  const st = C.emptyState();
  st.dayOrder.dinner = ['2026-08-10', '2026-08-13'];
  const out = C.buildExport(GOOD, st);
  const dinnerDayed = out.items.filter(i => i.section === 'dinner' && i.day);
  assert.deepEqual(dinnerDayed.map(i => i.id), ['tanini', 'brasserie']);
});
test('export round trip is lossless', () => {
  const st = C.emptyState();
  C.setStatus(st, 'brasserie', 'done');
  C.setStatus(st, 'nord', 'archived');
  st.dayOrder.dinner = ['2026-08-10', '2026-08-13'];
  const exported = C.buildExport(GOOD, st);
  const reimported = C.parse(JSON.stringify(exported)).data;
  const again = C.buildExport(reimported, C.emptyState());
  assert.deepEqual(again, exported);
});
```

Run: `node tests/run.js`. Expected: new tests FAIL (`C.buildExport is not a function`).

- [ ] **Step 2: Implement buildExport + Export button**

Inside the IIFE (and add `buildExport` to the return object):

```js
  function buildExport(data, state) {
    var out = JSON.parse(JSON.stringify(data));
    out.items.forEach(function (it) { it.status = effectiveStatus(it, state); });
    var vm = viewModel(out, { itemStatus: {}, dayOrder: state.dayOrder || {}, dataOverride: null });
    var rank = {};
    var r = 0;
    vm.forEach(function (sv) {
      sv.days.forEach(function (d) { d.items.forEach(function (it) { rank[it.id] = r++; }); });
      sv.undated.forEach(function (it) { rank[it.id] = r++; });
      sv.backups.forEach(function (it) { rank[it.id] = r++; });
      sv.archived.forEach(function (it) { rank[it.id] = r++; });
    });
    out.items.sort(function (a, b) {
      var ra = (rank[a.id] !== undefined) ? rank[a.id] : 1e9;
      var rb = (rank[b.id] !== undefined) ? rank[b.id] : 1e9;
      return ra - rb;
    });
    return out;
  }
```

Why the round trip works: `viewModel` orders days by saved `dayOrder` first, then first-appearance order in `items[]`. Export writes items in that order, so re-importing and exporting with empty state reproduces it exactly.

In `renderToolbar`, add before the override flag:

```js
    var exp = el('button', null, 'Export JSON');
    exp.type = 'button';
    exp.id = 'btn-export';
    exp.onclick = function () {
      var st = ctx.store.load();
      var out = buildExport(effectiveData(ctx.base, st), st);
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = cityId(out) + '.cityops.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    };
    tb.appendChild(exp);
```

- [ ] **Step 3: Run tests, verify in browser**

Run: `node tests/run.js`. Expected: all PASS.
Browser: click Export JSON on the template page; a `example-city-2026-01-01.cityops.json` file downloads and contains the example data with current statuses.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: lossless export of live-merged city JSON"
```

---

### Task 7: In-app data update (paste box, validation, diff, override layer)

**Files:**
- Modify: `template.html`
- Modify: `tests/run.js` (append)

**Interfaces:**
- Consumes: `parse`, `effectiveData`, `ctx.store`; `state.dataOverride` from Task 2.
- Produces: `CityOps.diffSummary(oldData, newData) -> string` (e.g. `"2 added, 1 removed, 38 unchanged"`); "Update data" toolbar button opening a modal with textarea + Apply + Revert-to-file + Cancel; valid pastes stored in `state.dataOverride`; header flag from Task 4 becomes visible.

- [ ] **Step 1: Append failing test**

```js
// Task 7: diff summary
test('diffSummary counts added and removed item ids', () => {
  const next = clone(GOOD);
  next.items = next.items.filter(i => i.id !== 'nord');
  next.items.push({ id: 'new-cafe', section: 'coffee', status: 'plan',
    name: 'New Cafe', links: [], place_id: null, verified: null });
  assert.equal(C.diffSummary(GOOD, next), '1 added, 1 removed, 3 unchanged');
});
```

Run: `node tests/run.js`. Expected: FAIL.

- [ ] **Step 2: Implement diffSummary and the modal**

```js
  function diffSummary(oldData, newData) {
    var oldIds = {};
    oldData.items.forEach(function (i) { oldIds[i.id] = 1; });
    var added = 0, unchanged = 0;
    newData.items.forEach(function (i) {
      if (oldIds[i.id]) { unchanged++; delete oldIds[i.id]; } else { added++; }
    });
    var removed = Object.keys(oldIds).length;
    return added + ' added, ' + removed + ' removed, ' + unchanged + ' unchanged';
  }

  function openUpdateModal() {
    var wrap = el('div', 'modal-wrap');
    var box = el('div', 'modal');
    box.appendChild(el('h3', null, 'Update city data'));
    box.appendChild(el('p', 'diff', 'Paste schema v1 JSON. It is stored on this device as an override; the file itself is not changed. Export and paste into the file to make it permanent.'));
    var ta = document.createElement('textarea');
    box.appendChild(ta);
    var msg = el('div', 'diff', '');
    box.appendChild(msg);
    var row = el('div', 'mrow');
    var apply = el('button', 'ctl', 'Apply');
    apply.type = 'button';
    apply.onclick = function () {
      var res = parse(ta.value);
      if (!res.data) { msg.textContent = 'Invalid:\n' + res.errors.join('\n'); return; }
      var st = ctx.store.load();
      var current = effectiveData(ctx.base, st);
      var summary = diffSummary(current, res.data);
      st.dataOverride = res.data;
      ctx.store.save(st);
      wrap.remove();
      rerender();
      document.getElementById('notice').textContent = 'Data updated: ' + summary + '.';
    };
    var revert = el('button', 'ctl', 'Revert to file data');
    revert.type = 'button';
    var hasOverride = !!ctx.store.load().dataOverride;
    if (hasOverride) {
      revert.onclick = function () {
        var st = ctx.store.load();
        st.dataOverride = null;
        ctx.store.save(st);
        wrap.remove();
        rerender();
      };
    } else {
      revert.disabled = true;
      revert.title = 'No in-app override is active';
    }
    var cancel = el('button', 'ctl', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = function () { wrap.remove(); };
    row.appendChild(apply); row.appendChild(revert); row.appendChild(cancel);
    box.appendChild(row);
    wrap.appendChild(box);
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    document.getElementById('modal').appendChild(wrap);
  }
```

In `renderToolbar`, after the export button:

```js
    var upd = el('button', null, 'Update data');
    upd.type = 'button';
    upd.onclick = openUpdateModal;
    tb.appendChild(upd);
```

Add `diffSummary` to the return object.

- [ ] **Step 3: Run tests, verify in browser**

Run: `node tests/run.js`. Expected: all PASS.
Browser: Update data → paste the example JSON with the item renamed and one item added → Apply. Verify: notice shows "1 added, 0 removed, 1 unchanged", renamed content renders, toolbar shows the override flag, reload keeps the override. Revert to file data restores the original. Paste `{bad` shows the JSON error inline, modal stays open. With no override active, "Revert to file data" is disabled with a tooltip (no dead-looking-but-clickable button).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: in-app data update with validation, diff summary, override layer"
```

---

### Task 8: Share/print view

**Files:**
- Modify: `template.html`
- Modify: `tests/run.js` (append)

**Interfaces:**
- Consumes: `effectiveStatus`, `dayLabel`, `viewModel` ordering rules.
- Produces: `CityOps.shareModel(data, state) -> {days: [{iso, label, entries: [{sec, it, status}]}], undated: [{sec, it, status}]}` (plan + done only, days chronological, entries in section order); Share toggle button rendering the read-only view; body gets class `share`.

- [ ] **Step 1: Append failing tests**

```js
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
```

Run: `node tests/run.js`. Expected: FAIL.

- [ ] **Step 2: Implement shareModel and the share render**

```js
  function shareModel(data, state) {
    var byDay = {};
    var undated = [];
    data.sections.forEach(function (sec) {
      data.items.forEach(function (it) {
        if (it.section !== sec.id) return;
        var s = effectiveStatus(it, state);
        if (s !== 'plan' && s !== 'done') return;
        var entry = { sec: sec, it: it, status: s };
        if (it.day) {
          if (!byDay[it.day]) byDay[it.day] = [];
          byDay[it.day].push(entry);
        } else {
          undated.push(entry);
        }
      });
    });
    var isos = Object.keys(byDay).sort();
    return {
      days: isos.map(function (iso) { return { iso: iso, label: dayLabel(iso), entries: byDay[iso] }; }),
      undated: undated
    };
  }

  var shareOn = false;

  function renderShare() {
    var state = ctx.store.load();
    var data = effectiveData(ctx.base, state);
    var sm = shareModel(data, state);
    var main = document.getElementById('main');
    main.innerHTML = '';
    sm.days.forEach(function (d) {
      var dc = el('div', 'daycard');
      var hd = el('div', 'hd');
      hd.appendChild(el('span', 'd', d.label));
      dc.appendChild(hd);
      d.entries.forEach(function (e) {
        var bd = el('div', 'bd' + (e.status === 'done' ? ' item-done' : ''));
        var h3 = el('h3');
        if (e.status === 'done') h3.appendChild(el('span', 'donemark', '✓'));
        h3.appendChild(document.createTextNode(e.it.name));
        if (e.it.price) h3.appendChild(el('span', 'price', e.it.price.text));
        bd.appendChild(h3);
        var meta = (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label + (e.it.when ? ' · ' + e.it.when : '');
        bd.appendChild(el('p', 'when-line', meta));
        if (e.it.hours) {
          var row = el('div', 'row');
          row.appendChild(el('span', 'hours ' + (e.it.hours.class || 'day'), e.it.hours.text));
          bd.appendChild(row);
        }
        dc.appendChild(bd);
      });
      main.appendChild(dc);
    });
    if (sm.undated.length) {
      var h2 = el('h2', null, 'Anytime');
      main.appendChild(h2);
      sm.undated.forEach(function (e) {
        var card = el('div', 'card' + (e.status === 'done' ? ' item-done' : ''));
        var h3 = el('h3');
        if (e.status === 'done') h3.appendChild(el('span', 'donemark', '✓'));
        h3.appendChild(document.createTextNode(e.it.name));
        if (e.it.price) h3.appendChild(el('span', 'price', e.it.price.text));
        card.appendChild(h3);
        card.appendChild(el('p', 'when-line', (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label));
        main.appendChild(card);
      });
    }
  }
```

In `renderToolbar`, add a Share button FIRST (before Export), always rendered:

```js
    var share = el('button', null, shareOn ? 'Back to planner' : 'Share view');
    share.type = 'button';
    share.id = 'btn-share';
    share.onclick = function () {
      shareOn = !shareOn;
      document.body.classList.toggle('share', shareOn);
      if (shareOn) { renderToolbar(effectiveData(ctx.base, ctx.store.load()), ctx.store.load()); renderShare(); }
      else { rerender(); }
    };
    tb.appendChild(share);
```

In `renderToolbar`, wrap the Export and Update buttons in `if (!shareOn) { ... }` so share view shows only the toggle. Add `shareModel` to the return object.

- [ ] **Step 3: Run tests, verify in browser**

Run: `node tests/run.js`. Expected: all PASS.
Browser: Share view shows day-grouped read-only cards, no buttons on cards, no backups/archived. Print preview (⌘P in the Browser pane or `window.print()` check via screenshot of the share view) shows clean cards, no toolbar. Toggle back restores the planner with state intact.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: read-only share/print view grouped by day"
```

---

### Task 9: Batumi extraction (cities/batumi.json + batumi.html + parity check)

**Files:**
- Create: `cities/batumi.json`
- Create: `batumi.html`
- Create: `tools/embed.js`
- Modify: `tests/run.js` (append)

**Interfaces:**
- Consumes: schema v1; `reference/batumi-guide-v5.html` as the source of truth for content.
- Produces: the canonical Batumi dataset; `tools/embed.js <city.json> <out.html>` writes template.html with the data block replaced (automation of the manual paste, not a required build step); `tests/validate-city.js` reusable for Yerevan.

- [ ] **Step 1: Write tools/embed.js and tests/validate-city.js**

`tools/embed.js`:

```js
// Optional convenience: node tools/embed.js cities/batumi.json batumi.html
// Equivalent to manually pasting the JSON into template.html's city-data block.
const fs = require('fs');
const path = require('path');
const [, , jsonPath, outPath] = process.argv;
if (!jsonPath || !outPath) {
  console.error('usage: node tools/embed.js <city.json> <out.html>');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const json = fs.readFileSync(jsonPath, 'utf8').trim();
if (json.indexOf('</script') !== -1) { console.error('JSON contains </script'); process.exit(1); }
const out = tpl.replace(
  /(<script type="application\/json" id="city-data">)[\s\S]*?(<\/script>)/,
  function (m, open, close) { return open + '\n' + json + '\n' + close; }
);
if (out === tpl) { console.error('city-data block not found'); process.exit(1); }
fs.writeFileSync(outPath, out);
console.log('wrote ' + outPath);
```

`tests/validate-city.js`:

```js
// node tests/validate-city.js cities/batumi.json
const fs = require('fs');
const { loadCityOps } = require('./harness');
const C = loadCityOps();
const res = C.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (res.data) {
  const st = { plan: 0, backup: 0, archived: 0, done: 0 };
  res.data.items.forEach(i => st[i.status]++);
  console.log('VALID ' + C.cityId(res.data) + ': ' + res.data.items.length + ' items (' +
    Object.keys(st).map(k => st[k] + ' ' + k).join(', ') + '), ' +
    res.data.sections.length + ' sections');
} else {
  console.error('INVALID:\n- ' + res.errors.join('\n- '));
  process.exit(1);
}
```

- [ ] **Step 2: Transcribe cities/batumi.json from the reference guide**

Read `reference/batumi-guide-v5.html` end to end and transcribe EVERY card, backup list item, callout, and warn box into schema v1. Mapping rules:

- City block: name Batumi, country GE, dates 2026-08-08 to 2026-08-15, accommodation Example Stay D2 (lat 41.64, lng 41.61), currency GEL 0.37, notes from the header chips ("Bolt works well", "Cards widely OK", "~2.2km south of Old Town").
- Sections (in this order): `dinner` 🍽️ Dinner, `coffee` ☕ Coffee, `cowork` 💻 Coworking, `activities` 🏛️ Activities, `services` 🧺 Services, `practical` 💡 Practical.
- Each v5 dinner day card → one item, `status: "plan"`, `day` = the real ISO date (Sun 9 = 2026-08-09 ... Sat 15 = 2026-08-15), `when` = the day card's subtitle text, name/price/note/hours/links transcribed exactly. The Sat 15 "Depends on the flight-vs-train call" card is an item with no price and no links.
- The Thursday lunch note (Adjarian Khachapuri) becomes its own item: `day: "2026-08-13"`, tags `["Lunch"]`, its map link, note including "cash only, closes 21:00".
- Each backup-list `<li>` → one item with `status: "backup"` in its section: bold text = name, remainder = note, any hours stated go in `hours.text`. The two "Skip:" entries (European Square Restaurant; Aquapark Beach from activities) become items with `status: "archived"` and a note explaining why (pre-archived = "decided against").
- Coffee cards (Nord, Kopi, Urban Roastery) and cowork cards (Locus, LendSpace), activities (Botanical Garden, Makhuntseti, Argo Cable Car, Boulevard, Ali & Nino, Gonio) and services (Harmony Laundry, Thai massage: split into Infinity and Siam as two items) → `status: "plan"`, no `day` (undated cards) EXCEPT keep the day hints as tags (e.g. `["Tue"]` on Botanical Garden, `["Wed", "Best day"]` on Makhuntseti). Ali & Nino has the "Done ✓" tag in v5: give it `status: "done"` (the lifecycle in action).
- The khinkali callout, websites callout, warn box (departure decision, work window), and the Practical card paragraphs (rhythm, cash, overcharging, beach, weekend crowding) → items in `practical`, name = short title (e.g. "On khinkali", "Saturday departure decision"), note = the prose, no links except where the original had them.
- Every Google Maps link keeps its exact `?cid=` URL. Every `tel:` keeps its exact number. Item ids: short slugs (`heart-of-batumi`, `tanini`, `blue-wave`, `riverside-makhuntseti`, `brasserie-1900`, `adjarian-khachapuri`, ...). All items get `"place_id": null, "verified": null`.

- [ ] **Step 3: Validate and build batumi.html**

```bash
node tests/validate-city.js cities/batumi.json
node tools/embed.js cities/batumi.json batumi.html
```

Expected: `VALID batumi-2026-08-08: ...` with roughly 45-55 items across 6 sections, then `wrote batumi.html`.

- [ ] **Step 4: Append a parity regression test**

```js
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
```

Run: `node tests/run.js`. Expected: all PASS (adjust the id list only if your chosen slugs differ, and then keep test and data consistent).

- [ ] **Step 5: Visual parity check**

Open `file:///Users/robriggs/claude/developer/cityops/batumi.html` and `file:///Users/robriggs/claude/developer/cityops/reference/batumi-guide-v5.html` side by side (two tabs, phone width 375px). Verify section by section: every v5 card, backup, and callout has a counterpart; hours badges and pills match; dinner day cards appear Sun 9 through Sat 15; Ali & Nino renders dimmed with ✓; the two Skip entries are in Archived disclosures. Fix any transcription gaps found.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Batumi dataset extracted to schema v1, batumi.html built, embed/validate tools"
```

---

### Task 10: PROMPT.md and README.md

**Files:**
- Create: `PROMPT.md`
- Create: `README.md`

**Interfaces:**
- Consumes: schema v1, the paste workflow, `tools/embed.js`.
- Produces: the generation prompt used for Yerevan in Task 11; a draft README (personal-repo quality; publish polish is out of scope this week).

- [ ] **Step 1: Write PROMPT.md**

Structure (write it out fully, first person Rob pasting into an AI engine):

1. **Fill-in header:** city, country, exact dates, accommodation name + address, arrival/departure transport, then the traveler profile paragraph: works mornings (roughly until 14:00), explores afternoons, dinner 19:00-21:00, solo, walks a lot, uses Bolt-class ride apps, avoids heavy food late, one trip into the center per day.
2. **Research instructions:** find per section: Dinner (one plan pick per evening of the stay assigned to ISO dates, matched to that day's likely activity, plus 5-8 backups), Coffee (2-3 specialty picks + backups), Coworking (best bookable + nearest-to-home + backups, note weekend hours), Activities (one anchor per full day + free anytime options + backups; flag DAYTIME vs evening-friendly), Services (laundry, massage/grooming, 24h grocery), Practical (rhythm, cash norms, scams/overcharging patterns from reviews, transit apps, beach/terrain notes).
3. **Quality rules (the Batumi lessons):** real Google Maps links (prefer `?cid=` permalinks); when a place has no real website use a `tel:` link instead and never invent URLs; flag early closers (before 22:00) and weekend crowding; mark book-ahead places; prices in local currency and USD; note review-verified scam patterns; ratings + review counts in the note where meaningful.
4. **Output contract:** respond with ONLY a JSON code block, valid against the schema, `"schema": 1`, every item with `"place_id": null, "verified": null`, statuses only `plan`/`backup`, `day` only ISO dates inside the stay, `hours.class` one of `late` (open past 22:00), `day` (daytime only), `eve` (evening-suited). Then paste the full schema example from the spec (the Brasserie example) as the shape reference.

- [ ] **Step 2: Write README.md**

Sections: What this is (a living city guide you operate, not just read: one HTML file per city); Quick start (1. copy template.html to `<city>.html`, 2. paste PROMPT.md + your details into Claude or any AI engine, 3. paste the returned JSON into the `city-data` block, or run `node tools/embed.js cities/<city>.json <city>.html`, 4. open the file, phone-friendly, works offline); The workflow (plan/backup/done/archived, drag days, Share view, Export JSON = the cityops app import format); Schema reference (link to the spec, inline the example); Status: personal tool, schema v1, not yet published.

- [ ] **Step 3: Sanity check + commit**

Confirm no em-dashes: `grep -n '—' PROMPT.md README.md` returns nothing.

```bash
git add -A && git commit -m "docs: generation prompt (Batumi lessons baked in) + README draft"
```

---

### Task 11: Yerevan guide (data generation + build + verification)

**Files:**
- Create: `cities/yerevan.json`
- Create: `yerevan.html`

**Interfaces:**
- Consumes: PROMPT.md rules, schema v1, `tools/embed.js`, `tests/validate-city.js`.
- Produces: the Friday deliverable: a working Yerevan guide.

**Rob inputs needed first (ask if not already known in-thread):** exact Yerevan dates (arrival Sat 2026-08-15; departure date), accommodation name/address, arrival mode (the Batumi flight-vs-train decision). If accommodation is still unbooked by Thursday, generate with a central placeholder anchor (Republic Square), note it in `city.notes`, and regenerate the header when Rob books.

- [ ] **Step 1: Research and generate cities/yerevan.json**

Execute PROMPT.md yourself with web search as the research tool (WebSearch/WebFetch at execution time): live hours, ratings, review counts, real Google Maps links, current prices in AMD + USD. Follow every quality rule in PROMPT.md. AMD rate: verify current (~1 USD = 385-400 AMD as of mid-2026, check). Assign dinner days to the actual stay dates. Include a Practical section covering: GG/Yandex ride apps (Bolt is not the player there, verify current state), cash vs card norms, drinking-water pulpulaks, August heat pattern, taxi-from-Zvartnots or train-station arrival notes matching Rob's arrival mode.

- [ ] **Step 2: Validate and build**

```bash
node tests/validate-city.js cities/yerevan.json
node tools/embed.js cities/yerevan.json yerevan.html
node tests/run.js
```

Expected: VALID with 35+ items across 6 sections; `wrote yerevan.html`; all tests PASS.

- [ ] **Step 3: Browser verification**

Open `yerevan.html` at phone width: header correct (dates, accommodation, AMD chip), dinner day cards for every night, all sections populated, lifecycle buttons work, export downloads `yerevan-2026-08-15.cityops.json` (date per actual arrival), Share view clean.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Yerevan guide generated via PROMPT.md"
```

---

### Task 12: Phone verification + Friday close-out (Rob-facing)

**Files:** none (verification and handoff)

- [ ] **Step 1: Full test + fresh-eyes pass**

Run `node tests/run.js` (all PASS). Reread the spec's Testing/verification list (items 1-6) and check each one explicitly. Fix anything that fails before involving Rob.

- [ ] **Step 2: Hand both files to Rob with explicit phone steps**

Send Rob `batumi.html` and `yerevan.html` (SendUserFile) with instructions per his explicit-specifics rule: get the file onto the phone the same way batumi-guide-v5.html got there (AirDrop or iCloud Drive → open in Safari), then verify on the phone: cards render, tapping ✓ Done sticks after closing and reopening Safari, a map pill opens the Google Maps app, drag reorder works with a finger, Share view is readable. Ask for a yes/no on each.

- [ ] **Step 3: Log completion**

On Rob's confirmation, commit any fixes and note Phase 1 complete (STATE-on-ship rule): update the repo README status line with the completion date. Bonus scope (plan-ahead bridge, public push) only starts after this checkbox.

---

## Self-review notes (already applied)

- Spec coverage: schema (T1), state separation + stale-id tolerance (T2), v5 visual grammar (T3), renderer + lifecycle + no-dead-buttons (T4), drag reorder (T5), lossless export (T6), override import path (T7), share/print (T8), Batumi parity (T9), PROMPT + README (T10), Yerevan (T11), phone acceptance (T12). Print CSS lives in T3, exercised in T8.
- Round-trip losslessness depends on `viewModel` using first-appearance day order (NOT date-sorted): this is intentional and tested in T2/T6. Generated data should list dayed items chronologically so the default view is chronological.
- `makeStore` null-storage guard must run before the probe try block (T2 note).
- Window-level drag listeners bind once at init, not per rerender (T5 note).
