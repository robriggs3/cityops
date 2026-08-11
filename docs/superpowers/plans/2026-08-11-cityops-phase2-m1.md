# CityOps Phase 2 M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Execute task-by-task on branch `phase-2-m1`. Do NOT merge to main: the final gate is Rob's palette approval (screenshots), because main auto-deploys his daily tool.

**Goal:** The multi-city app shell: cityops.robriggs.com serves one app with a city switcher, add-city-by-paste, the wheres palette, and offline support, with the standalone-file path fully preserved.

**Architecture:** Extract the engine to `src/cityops.js` and the shell markup/CSS to `src/guide-shell.html` + `src/app-shell.html`; `tools/assemble.js` builds `template.html` (guide shell + engine) and `index.html` (app shell + engine). Both artifacts stay committed (no build step for users); a test fails on drift. The app shell adds an app-store layer (multi-city localStorage) ABOVE the untouched per-city engine: the engine still reads one city's data + state; the shell decides WHICH city and supplies data from the store instead of the embedded block.

**Tech stack:** unchanged. Vanilla ES5-style JS, Node-builtin tests, no npm, no CDN.

## Global constraints

- Spec: docs/superpowers/specs/2026-08-11-cityops-phase2-design.md (reread the M1 + palette + parallelism sections before each task).
- Branch `phase-2-m1` only. NEVER push main from this plan; never touch the deployed site until Rob approves the palette.
- No em-dashes in anything authored. No external dependencies. `node tests/run.js` green at every task end; commit per task.
- The existing 43 tests must keep passing UNMODIFIED except where a task explicitly says otherwise (engine extraction may adjust harness paths only).
- Existing localStorage state keys (`cityops.<cityId>.v1`) and schema v1 are frozen contracts.

## Task 1: Engine extraction + assembler

Create `src/cityops.js` containing EXACTLY the current `<script id="app">` body from template.html (the whole `var CityOps = ...` through `CityOps.init();`). Create `src/guide-shell.html` = template.html with the app script body replaced by the marker line `<!--CITYOPS_ENGINE-->` (keep the `<script id="app">` open/close tags around the marker) and the data block intact. Write `tools/assemble.js`:

```js
// node tools/assemble.js  : rebuilds template.html and index.html from src/
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'src', 'cityops.js'), 'utf8');
function build(shellName, outName) {
  const shell = fs.readFileSync(path.join(root, 'src', shellName), 'utf8');
  if (shell.indexOf('<!--CITYOPS_ENGINE-->') === -1) throw new Error('marker missing in ' + shellName);
  fs.writeFileSync(path.join(root, outName), shell.replace('<!--CITYOPS_ENGINE-->', () => engine));
  console.log('assembled ' + outName);
}
build('guide-shell.html', 'template.html');
if (fs.existsSync(path.join(root, 'src', 'app-shell.html'))) build('app-shell.html', 'index.html');
```

Run assemble; assert `git diff template.html` is EMPTY (byte-identical round trip proves the extraction was exact; fix until it is). Add to tests/run.js a sync test: read src/cityops.js and template.html, assert template.html contains the engine string verbatim. Re-embed both city HTMLs (they re-assemble from template). Harness note: tests/harness.js keeps reading template.html and must keep passing untouched. Commit: `refactor: extract engine to src/cityops.js with assembler, byte-identical`.

## Task 2: Palette + token names

In `src/guide-shell.html` ONLY (CSS block): replace the `:root` tokens with the wheres token NAMES and VALUES from the spec's mapping table, then update every `var(--...)` reference per that table (sand->bg, sea->accent, sea-deep->accent-hover, ink->text, muted->text-3, line->border-light, ok->green, flag->accent, gold->amber; badge classes late/day/eve to green-soft/amber-soft/blue-soft pairs; neutral badge to bg-softer; header gradient becomes accent to accent-hover). Also: `.warn`/`.errcard` use accent + accent-soft; `.backup` block border/label amber family; `.tag` accent on accent-soft; keep every selector and layout property untouched (colors only). Assemble, re-embed cities, tests green. Produce screenshots (Browser pane, 375px): old main vs new branch, yerevan dinner section + toolbar + a backup block, saved to .superpowers/sdd/palette-before.png/palette-after.png (screenshot via the browser tool, saved by the controller). Commit: `feat: adopt wheres design tokens (names + values), colors only`.

## Task 3: App shell

Create `src/app-shell.html`: head (meta viewport, title CityOps), the SAME CSS block as guide-shell (assembler keeps them in sync? No: to avoid double maintenance, extract CSS too: `src/cityops.css`, marker `/*CITYOPS_CSS*/` in both shells, assembler inlines it. Do this as step 1 of this task, byte-identical check again). Body: same wrap/notice/hdr/toolbar/main/foot/modal skeleton PLUS a `#citybar` div above hdr, NO city-data script block, engine script with marker, then an app-layer `<script id="appshell">` (authored in `src/app-shell.html` directly) that:

- Defines the store: localStorage `cityops.app.v1` = `{cities:{}, order:[], active:null}` with load/save + normalize; seeds on first run with the bundled example city (reuse template's example JSON, id `example-city-...`).
- Boot: instead of `CityOps.init()` reading `#city-data`, the app calls a new engine entry `CityOps.boot(cityJsonObject)` - ADD this to the engine (Task 3 touches src/cityops.js): `boot(data)` = the body of init() minus the data-block read, taking parsed data directly (init keeps working for standalone files; both share the internals). Engine change is additive only.
- Renders `#citybar`: current city name + dates (button) -> dropdown listing cities (name + date range) + `+ Add city` + `Remove city`. Switching sets `active`, updates `location.hash = '#city=' + cityId`, boots that city. On load: honor `#city=<id>` hash if present and known, else `active`, else first.
- Add city: modal (reuse modal styles) with textarea -> parse() -> on valid: derive cityId via cityId(); if exists, buttons `Replace` / `Keep both` (keep-both appends `-2` to city name before re-deriving id) / Cancel; store, set active, boot. On invalid: inline errors (same pattern as update modal).
- Remove city: typed-confirm modal (type the city name); removes from store AND clears `cityops.<cityId>.v1` state key; switches to first remaining city (or reseeds example if none).
- Export standalone guide: button in the existing toolbar (app only): builds a full standalone HTML by fetching nothing: the app embeds `src/guide-shell.html`?? NO fetch allowed offline. Simplest honest approach: the assembler inlines the ASSEMBLED template.html into the app shell as a `<script type="text/plain" id="guide-template">` block (base: template minus its example data block content, with the marker `__CITY_DATA__` in the data block); export = replace marker with JSON.stringify(city data merged via buildExport) and download as `<cityId>.html`. Assembler gains this step; size cost ~120KB in index.html, acceptable.
- The per-city Update-data modal and Export JSON keep working (they operate on the ACTIVE city; Update-data override applies to the active city's state as today).

Tests (pure, in tests/run.js via a second harness function loading the appshell script with stubs, or simpler: extract store logic into src/cityops.js as `CityOps.appStore` helpers (normalizeAppStore, addCity(store, data), removeCity(store, id), keepBothId(store, name)) so the EXISTING harness tests them): add/switch/remove/collision/keep-both/order/active/reseed. Browser verification: switcher, add via paste (use batumi.json), remove with typed confirm, hash deep link `#city=...` on load, standalone export downloads a working file (open it), per-city state isolation (done in one city does not leak to another). Commit per sub-step or once: `feat: multi-city app shell (store, switcher, add/remove, deep links, standalone export)`.

## Task 4: Service worker + offline

`sw.js` at repo root (authored directly, tiny): cache-first for `./` and `./index.html`, cache name versioned `cityops-app-v1` (bump manually per release in one constant), activate cleans old caches. App shell registers it (feature-detected, no-op on file://). Offline verification: load app, go offline (devtools network toggle unavailable in pane: verify via SW cache inspection + reload with server killed), app boots and cities render from localStorage. Commit: `feat: service worker, offline app shell`.

## Task 5: Verification, review, staging for Rob

Full suite + validate both cities + fresh-eyes pass against the spec's M1 section. Whole-branch review (subagent) on the branch diff vs main. Fix wave if needed. Then STOP: present Rob the palette screenshots + how to preview the branch app locally or via a temporary artifact publish of index.html (private). Rob approves palette -> merge main + set Pages custom domain to cityops.robriggs.com (requires his CNAME live) + verify https://cityops.robriggs.com serves the app + old github.io URLs redirect. DNS/custom-domain flip is its own checklist item AFTER approval.

## Out of scope for M1

Login/sync (M2), cross-link footer to wheres (announcement time), wheres UX pass, removing the old per-file guides from the repo (they stay as examples).
