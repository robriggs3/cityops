# CityOps Architecture

A tour of the engineering decisions, written for someone evaluating the
codebase. The whole system is ~2,000 lines of dependency-free ES5-style
JavaScript plus 1,800 lines of app shell, with 107 unit tests that run on
Node built-ins alone. There is no build step, no framework, no npm
install, and no bundler, on purpose. This document explains why, and what
that constraint bought.

## 1. The single-file contract

The product began as one hand-written HTML file used in the field for a
week. That file's properties turned out to be the product: it opens from
a bookmark, works offline on hotel wifi, installs to a phone home screen,
and can be handed to anyone as a single attachment. Those properties are
preserved as a hard contract:

- `template.html` is a complete app: CSS, renderer, and a
  `<script type="application/json" id="city-data">` block that is the only
  per-city edit. Paste city JSON in, open the file, done.
- The hosted multi-city app (`index.html`) is the same engine wrapped in a
  shell (city switcher, sync, profile). Standalone guides exported from the
  app contain zero app-shell code: no sync, no network, no UI the file
  cannot honor. A test greps the assembled template for shell symbols and
  fails on any leak.

### The assembler

One engine, two artifacts, no drift: `src/cityops.js` (engine),
`src/guide-shell.html` and `src/app-shell.html` (markup + per-surface CSS)
are assembled by `tools/assemble.js` into `template.html` and `index.html`,
which are committed. Users never run a build; contributors run one command.
CI runs the assembler and fails on `git diff --exit-code`, so the committed
artifacts provably match `src/`. The extraction itself was landed as a
byte-identical refactor: the first assembled `template.html` had to equal
the previous hand-maintained file exactly before anything else changed.

The app also embeds the assembled template inside itself as an escaped
`text/plain` block, so "Export standalone guide" can write a complete,
working offline file with no network access. A test round-trips the
escape and asserts byte-equality with `template.html`.

## 2. Data vs state

Canonical city data (the researched guide) and live user state (what the
traveler did with it) never mix:

- Data: schema v1 JSON, validated on every entry path. The app never
  mutates it in place.
- State: a per-city object (`itemStatus`, `itemDay`, `itemTitle`,
  `dayOrder`, `dayItemOrder`, `sectionItemOrder`, `collapsedSections`,
  `collapsedPlanDays`, `pinned`, `tab`, `viewMode`, `stayOverride`,
  `dataOverride`) stored under its own key and merged at render time.
  State wins per item; stale state for removed items is ignored
  silently. `normalizeState` fills in every key a state written by an
  older build is missing, which is what lets the whole object be the
  sync payload: a new feature adds a key, and last month's saved state
  reads as "that feature has not been used yet" rather than as an error.

This split is what makes every risky operation safe by construction:
re-pasting updated city data, applying an AI-generated delta, or syncing
a newer copy from another device can never erase a done-mark or a
reorder, because those live in a different object that the operation
does not touch.

Export inverts the merge: `buildExport` bakes live statuses, day
assignments, and renames into a schema-valid JSON file, and a test
asserts the full round trip (export, re-import, export) is deep-equal.
That file is the interchange contract between standalone guides, the
app, and the sync backend.

## 3. Days are slots

The scheduling model treats dates as fixed chronological slots and item
groups as content that occupies them. Reordering moves content between
slots and relabels; the dates never shuffle. Two details worth noting:

- Migration safety: the arrangement stored per section lists group keys
  in display order. Keys absent from the stored arrangement sit on their
  own date, and arranged keys fill remaining slots in order. Default
  behavior is content-on-its-own-date, and arrangements saved before
  empty-day slots existed keep content exactly where the user left it
  when the slot model gained empty days.
- Displayed-date mapping: after reorders, the date a user sees and the
  internal group occupying it differ. Every picker ("promote to which
  day?", "move to which day?") resolves the tapped date to the group the
  user is looking at, not the internal key, via one shared helper.

## 4. Offline first, sync second

The app is fully functional logged out and offline: localStorage is the
source of truth, a minimal service worker caches the shell, and sync is
an optional layer that reconciles when a session exists.

Sync is Supabase without the SDK: four `fetch` calls against GoTrue and
PostgREST (magic-link OTP, token refresh, select, upsert), keeping the
zero-dependency rule. Design points:

- Newer-wins per city, compared as epoch milliseconds, never as strings
  (PostgREST returns `+00:00`, clients write `Z`; string comparison would
  ping-pong forever).
- A null read is never treated as an empty server, and the first pull
  takes an explicit push baseline, so a fresh device can never blow away
  a good server copy. The bundled example city is stamped with EPOCH so a
  pristine seed always loses a reconcile to any real row.
- Edits flush on `visibilitychange: hidden` and `pagehide`, closing the
  mobile app-switch window where a debounce timer would never fire.
- Remote rows are untrusted input: validated against the same schema
  rules as pasted data, with the row's own id cross-checked, before they
  touch the store.
- Security is RLS-only: the publishable key ships in the client by
  design, every table is own-rows-only with `user_id` defaulting to
  `auth.uid()` server-side, anonymous access is revoked outright, and the
  final review verified anonymous reads fail against the live project.

Accepted v1 limits are documented rather than hidden: last-write-wins per
city (single-user tool), client clocks drive timestamps (bounded by NTP
skew), city removal does not propagate across devices yet.

## 5. AI at zero marginal cost

The AI layer is a prompt contract, not an API bill. `PROMPT.md` is
simultaneously human documentation and machine-readable source: landmark
comments (`RERUN:INTERESTS`, `RERUN:INTEL`, `RULES:INTEL`,
`CONTRACT:ITEM`) let the app slice exact instruction blocks into
generated prompts. The app assembles a complete prompt (city header,
traveler profile, current item inventory, output contract), the user runs
it in their own AI chat, and pastes the JSON back.

The paste lands in `mergeDelta`, whose invariants carry the safety:

- New items are held to the identical validation bar as full-city data
  (shared validators, byte-identical error strings).
- Existing items are never overwritten; duplicates are skipped and
  counted. The only mutable field on an existing item is `intel`, and
  only via an explicit intel map.
- Lookup maps are prototype-safe (`Object.create(null)` +
  `hasOwnProperty`), closing a reviewed prototype-pollution vector where
  a hostile delta keyed `__proto__` could have painted content onto every
  card.
- The function reads no user state, mutates no inputs, and returns
  either a merged copy plus a summary or errors and nothing.

When revenue justifies server-side AI, the swap point is one function:
the paste box becomes a fetch, and the profile, prompt assembly, merge,
and rendering are unchanged.

## 6. Verification culture

- 107 tests on Node built-ins; the harness extracts the engine script
  from the assembled template and evaluates it with stubbed DOM globals,
  so pure logic is tested in the exact bytes that ship.
- Every feature landed through a written spec, a written plan, an
  implementing agent, and an independent reviewing agent, with findings
  fixed before merge; the specs and plans are committed under
  `docs/superpowers/`. Two reviewer catches that mattered: the
  prototype-pollution hole above, and a timestamp-dialect bug that would
  have made sync oscillate.
- Real-world data is part of the test surface: the shipped example
  cities are field-used guides, and the CI validates them against the
  schema on every push.
