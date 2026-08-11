# CityOps Phase 1: Design Spec

Date: 2026-08-10 (Mon)
Owner: Rob Riggs
Deadline: Friday 2026-08-14, complete. Yerevan guide working on Rob's phone before the Sat 2026-08-15 departure.
Status: awaiting Rob's spec review

## Goal

Turn the field-proven Batumi single-file guide into a reusable per-city planning tool:

1. Plan travel better, per city: any city becomes an operable guide (reorder, promote backups, mark done, archive) from pasted AI research.
2. Export data into cityops: every guide reads and writes the cityops schema v1, so the future synced app imports guide data losslessly from day one.

Scope is PRD Phase 1, finished. Bonus items (plan-ahead bridge, public repo push, Places enrichment) are explicitly out of this spec.

## Decisions already made

- Single file per city with an embedded JSON block (approach A). No build step, no fetch, no paired files. A guide remains one HTML file that airdrops, installs to home screen, and works offline.
- Personal-first: local repo at `~/claude/developer/cityops`, not pushed to GitHub this week. README drafted now, polished at publish time.
- Schema is PRD schema v1 verbatim plus a `"schema": 1` version field.
- Canonical city data and live user state are separated (JSON block vs localStorage) so re-pasting updated city data never wipes the week's state.

## Repo layout

```
cityops/
  template.html            the renderer + empty/example data block
  cities/
    batumi.json            extracted from batumi-guide-v5.html, reference dataset
    yerevan.json           generated Thu/Fri via PROMPT.md
  batumi.html              template + batumi.json pasted in (working guide)
  yerevan.html             template + yerevan.json pasted in (the Friday deliverable)
  PROMPT.md                the AI generation prompt
  README.md                draft: what this is, the paste workflow, schema reference
  docs/superpowers/specs/  this spec
  docs/superpowers/plans/  implementation plan (next step)
```

`cities/*.json` are kept even though the data is embedded in each city HTML: they are the canonical datasets, the future app's import fixtures, and what the repo ships as examples.

## Schema (v1)

Exactly the PRD section 6 schema, with `"schema": 1` at the top level:

```json
{
  "schema": 1,
  "city": {
    "name": "Batumi", "country": "GE",
    "dates": {"from": "2026-08-08", "to": "2026-08-15"},
    "accommodation": {"name": "Example Stay D2", "lat": 41.64, "lng": 41.61},
    "currency": {"code": "GEL", "usd": 0.37},
    "notes": ["Bolt works well", "~2.2km south of Old Town"]
  },
  "sections": [
    {"id": "dinner", "label": "Dinner", "icon": "🍽️"}
  ],
  "items": [{
    "id": "brasserie",
    "section": "dinner",
    "status": "plan",
    "day": "2026-08-13",
    "when": "Old Town office day",
    "name": "Brasserie 1900",
    "price": {"text": "~80–120 GEL / $30–44"},
    "note": "4.8★ ... reserve.",
    "hours": {"text": "12:00–23:00 daily", "class": "late"},
    "tags": ["Book ahead"],
    "links": [
      {"kind": "map", "label": "Open in Maps", "href": "https://maps.google.com/?cid=..."},
      {"kind": "web", "label": "brasserie1900.ge", "href": "https://brasserie1900.ge"},
      {"kind": "tel", "label": "Book", "href": "tel:+995511222252"}
    ],
    "place_id": null,
    "verified": null
  }]
}
```

Field rules:

- `status`: one of `plan | backup | archived | done`. The JSON block carries the authored starting status; live status lives in localStorage (see State).
- `day`: ISO date or absent. The renderer derives labels ("Thu 13"); no weekday strings in data.
- `hours.class`: one of `late | day | eve` (drives the badge color, as in v5). Optional.
- `links[].kind`: `map | web | tel`; renders the corresponding pill style from v5.
- `place_id`, `verified`: always present, `null` in Phase 1 (Phase 3 fills them).
- City-level `warnings`/practical prose: modeled as a section (e.g. `{"id":"practical","label":"Practical","icon":"💡"}`) whose items are note-only cards, not as new schema surface area.

## Template architecture

One HTML file, three parts:

1. `<script type="application/json" id="city-data">…</script>`: the pasted city JSON. The only per-city edit.
2. Static CSS ported from v5 (same visual grammar: header chips, day cards, card pills, hours badges, backup blocks, callouts).
3. Vanilla JS renderer, no dependencies:
   - Parse the data block. On parse failure, render a visible error card naming the JSON error line instead of a blank page.
   - Render header from `city` (name, dates, chips from notes/currency).
   - Render each section in `sections[]` order:
     - Items with `day` render as date-ordered day cards, drag-reorderable with the v5 pointer logic and keyboard fallback.
     - Items without `day` render as a plain card list.
     - `backup`-status items render collapsed in a "Backups" block under their section.
     - `archived` items render inside a collapsed "Archived" disclosure at the section bottom (out of the way, recoverable). `done` items stay in place, receded (dimmed, ✓ badge).
   - Card controls (one tap each, no menus): ✓ Done, ↩ Promote (backup→plan), ✕ Archive, and undo of each (Done→plan, plan→backup, unarchive). Controls only render for states where the action is valid: no dead buttons.

## State model

- Canonical data: the embedded JSON block. Never mutated by the app.
- Live state: localStorage key `cityops.<cityId>.v1` where `cityId` is a slug of `city.name` + `dates.from` (e.g. `batumi-2026-08-08`), holding `{itemStatus: {id: status}, dayOrder: [...], updated: iso}`.
- Render = JSON block merged with live state; live state wins per item.
- Items present in state but absent from a re-pasted data block are ignored silently (data update dropped an item: its stale state must not error).
- localStorage failure (private mode): app still works for the session in memory; a one-line notice appears, same pattern as v5.

## Print/share view

A "Share" toggle in the header switches to a read-only render: plan + done items only, grouped by day then section, backups and archived omitted, controls hidden. Print CSS (`@media print`) produces a clean one-pager from that view. Toggle back returns to the full app. No separate file, no server.

## Export / import

- Export button → downloads `<cityId>.cityops.json`: the canonical JSON with live state merged in (statuses updated, `dayOrder` applied to `day` ordering, `schema: 1` intact). This file is the cityops app-import contract.
- Import: primary path is paste-into-the-data-block (documented in README). Convenience path: an "Update data" box in the UI that accepts pasted JSON, validates it against the field rules above, shows what changed (item count added/removed), and rewrites nothing on disk: it stores the pasted JSON in localStorage as an override layer, flagged in the header ("data updated in-app; paste into file to make permanent"). Keeps the file authoritative while allowing on-the-ground fixes from the phone.
- Export → re-import must be lossless for all schema fields.

## PROMPT.md

The generation prompt, structured as: paste city + dates + accommodation + traveler profile, get back schema-valid JSON only. Bakes in the Batumi lessons:

- Work-mornings / explore-afternoons / dinner 19:00–21:00 profile, late-friendly flags where that assumption might not hold.
- Real Google Maps CID links per item; `tel:` pills where no real website exists (a missing website is normal, not a quality signal); never invent URLs.
- Early-closer and weekend-crowding flags; book-ahead tags; tourist-overcharging warnings where reviews support them.
- Prices in local currency + USD; `hours.class` assignment rules.
- Day assignments as ISO dates within the stay; backups per section; a Practical section.
- Output contract: JSON only, valid against schema v1, `place_id`/`verified` null.

## Yerevan (acceptance)

Thu/Fri: run PROMPT.md for Yerevan against the actual Aug 15+ dates and accommodation, save `cities/yerevan.json`, paste into `yerevan.html`, verify on the phone. The dogfood is the acceptance test.

## Testing / verification

1. Batumi parity: `batumi.html` rendered from `cities/batumi.json` matches v5 content 1:1 (every card, pill, backup, callout present; visual grammar preserved). Checked side by side at phone width.
2. Lifecycle: each status transition works, persists across reload, and survives a data-block re-paste.
3. Export/import round trip: export from a live-modified guide, paste back, byte-identical state.
4. Broken JSON in the data block shows the error card, not a blank page.
5. Share/print view renders clean at phone width and via ⌘P.
6. Yerevan guide functional on Rob's phone before Friday EOD.

## Milestones (Mon 8/10 → Fri 8/14)

- Mon–Tue: template.html (renderer + state + lifecycle), batumi.json extraction, Batumi parity check.
- Wed: export/import, share/print view, error handling polish.
- Thu: PROMPT.md, README draft, generate Yerevan, load and verify.
- Fri: buffer, phone verification, fixes from real use. Bonus work only if this is done.

## Out of scope (Phase 1)

Plan-ahead bridge, public GitHub push, Places API enrichment, affiliate links, days-as-first-class objects (moving an item between days is a data edit, not a drag, this week), multi-device sync, PWA manifest/service worker (file:// home-screen install already covers it).
