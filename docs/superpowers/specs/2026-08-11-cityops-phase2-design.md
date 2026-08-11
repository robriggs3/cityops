# CityOps Phase 2: Design Spec (M1 app shell + M2 sync)

Date: 2026-08-11 (Tue)
Owner: Rob Riggs
Status: awaiting Rob's spec review
Prior art: Phase 1 spec (2026-08-10), shipped and in field use; PRD Phase 2 section.

## Goal

One memorable URL, any device, all cities:

1. https://cityops.robriggs.com is the app. No per-file paths.
2. Switch between cities from a header switcher.
3. Create a new city in-app by pasting PROMPT.md output.
4. Logged in (magic link), cities and live state sync across devices. Logged
   out, everything still works per device.

## Decisions already made (with Rob, 2026-08-11)

- Domain: cityops.robriggs.com. Rob adds one CNAME; app stays on GitHub Pages.
- M1 (shell, no login) ships first, targeted before Sat 2026-08-15 departure;
  M2 (sync) lands during the Yerevan week. Split explicitly approved.
- No Lovable. Same repo, same hand-built engine, Supabase direct.
- Color scheme: adopt wheres.robriggs.com's palette CONCEPTUALLY (cool grey
  ground, white cards, crimson accent, soft semantic tints) onto cityops's
  existing layout, which Rob prefers structurally. Colors only; cityops
  typography (system stack) unchanged in this phase.
- Launch cross-linking: cityops footer links wheres.robriggs.com and vice
  versa, at announcement time (post-Yerevan-dogfood).
- Out of scope here: wheres.robriggs.com UX improvements (separate
  workstream, tracked below), Places enrichment (Phase 3), multi-user
  collaboration, native apps.

## Palette mapping (wheres -> cityops)

Source of truth read from wheres.robriggs.com on 2026-08-11:

```
--bg:#cccccc  --bg-card:#ffffff  --bg-soft:#bdbdbd  --bg-softer:#e8e8e8
--border:#a8a8a8  --border-light:#d0d0d0
--text:#242424  --text-2:#4a4a4a  --text-3:#666666
--accent:#c72027  --accent-hover:#9c181d  --accent-soft:#f3d1d3
--green:#2d7d34/--green-soft:#d4e8d5   --blue:#2c5d8a/--blue-soft:#d3e0ee
--amber:#8a6d00/--amber-soft:#ede1be
```

Semantic mapping in template.css terms (replace values, keep every selector):

| cityops token/use | today | becomes |
|---|---|---|
| `--sand` page ground | #f5efe3 | `--bg` #cccccc |
| card ground | #ffffff | #ffffff (unchanged) |
| `--sea` / `--sea-deep` (header gradient, map pills, links, h2) | teal | `--accent` #c72027 / `--accent-hover` #9c181d |
| `--ink` / `--muted` text | #1a2530 / #5c6b78 | `--text` #242424 / `--text-3` #666666 |
| `--line` borders | #e2ddd2 | `--border-light` #d0d0d0 |
| `--ok` + `.late` badge | green family | `--green` #2d7d34 on `--green-soft` #d4e8d5 |
| `.day` badge (daytime-only warning) | red family | `--amber` #8a6d00 on `--amber-soft` #ede1be |
| `.eve` badge | blue family | `--blue` #2c5d8a on `--blue-soft` #d3e0ee |
| `--flag` warnings, archive hover | #c1462f | `--accent` #c72027 |
| `--gold` backup blocks | #c8892a | `--amber` #8a6d00 with `--amber-soft` tint |
| neutral hours badge | #ececec | `--bg-softer` #e8e8e8 |

Rationale for the two judgment calls: `.day` moves from red to amber because
in the wheres system red is THE accent, and a red badge would read as a
button; amber is its warning tint. Backup blocks move from gold to the amber
family for the same reason. Acceptance: side-by-side screenshots at phone
width, Rob approves the look before it ships (it changes his daily tool).

## M1: the app shell (no login)

### What the root URL serves

`index.html` becomes the app (the current landing list retires; README and
repo remain the developer-facing front door). Anonymous first-run loads a
bundled example city so a stranger sees a working guide, with an obvious
"Add your city" path. Rob's real data lives in his browser (and from M2, his
account), never in the repo.

### City store

- New localStorage key `cityops.app.v1`: `{ cities: {cityId: cityJson},
  order: [cityId], active: cityId }`.
- Per-city live state REUSES the existing `cityops.<cityId>.v1` keys and
  state shape unchanged. Everything shipped this week (day slots, moves,
  titles, collapse, view mode, stay override) works per city with zero
  migration.
- Switcher UI in the header: current city name + chevron -> simple list
  (name + dates), plus "Add city" and "Remove city" (typed-confirm; removing
  a city also clears its state key).
- Add city = the existing paste modal generalized: paste schema-v1 JSON,
  validate (same validate()), diff/preview, save as new city, switch to it.
  Duplicate cityId: offer replace-or-keep-both (keep-both suffixes the id).
- Export per city unchanged (single .cityops.json). "Export standalone
  guide" also offered: template + embedded data as a downloadable .html
  (embed.js logic ported into the app), preserving the PRD trust feature.

### Offline (non-negotiable)

Minimal service worker: cache-first for the app shell (index.html + nothing
external), network-independent city data (localStorage). No CDN
dependencies, same as today. The SW is versioned with the app and updates on
next online load.

### Structure

The repo grows an `app/` build? No. Keep the no-build principle:
`index.html` is authored directly, sharing the CityOps engine by INCLUDING
template.html's script? Also no (two copies drift). Decision: extract the
engine to `cityops.js` (single authored file, no modules, no build);
`template.html` and `index.html` both inline it AT EMBED TIME via
tools/embed.js, which becomes the single assembler for: standalone city
files (template + engine + data) and the app (shell + engine). The engine
file is the only place logic lives; embed.js is still optional for users
(the README paste path keeps working because template.html in the repo is
kept assembled, refreshed by a tools/assemble step run before commit; a test
asserts template.html and cityops.js are in sync so drift fails the suite).

### Migration note (accepted)

github.io and cityops.robriggs.com are different origins; device state does
not carry over automatically. Rob's bridge: Export on the old URL, Add-city
paste on the new one (2 minutes per city, one time). M2 makes this moot.

## M2: sync (Supabase)

### Principles

Local-first: the device store is authoritative for reads; sync reconciles.
The app must be fully usable logged out, offline, and mid-flight. Post-2026
portal discipline applies: RLS-first, no service-role key anywhere near the
client, anon key only.

### Supabase

- New dedicated free-tier project (NOT c4score, NOT the client portal).
- Auth: magic link (email), session persisted; login is optional.
- Tables:
  - `cities`: id uuid pk, user_id uuid not null default auth.uid(),
    city_id text not null, data jsonb not null, updated_at timestamptz,
    unique(user_id, city_id)
  - `city_state`: same shape with `state jsonb` (the exact device state
    object; collapsedSections/viewMode ride along = "profile preferences").
- RLS on both: select/insert/update/delete where user_id = auth.uid().
  No public access. Advisors check before launch.

### Sync model (v1, deliberately simple)

- Granularity: whole `data` and whole `state` per city, compared by
  `updated_at` (state already stamps `updated`).
- On login/connect: pull all rows; for each city, newer timestamp wins
  (both directions); ties keep local. Show a one-line notice when a pull
  overwrote local ("Synced: Yerevan updated from your other device").
- On every local save while online+logged in: debounced push (2s).
- Offline: saves queue implicitly (local IS the queue: next connect pushes
  anything whose updated_at is newer than the server's).
- Known limitation, accepted for v1: concurrent edits on two devices within
  the same window are last-write-wins per city, not merged. Fine for one
  human. Field-merge is a later phase if it ever hurts.

### Security acceptance

- get_advisors clean on the new project before DNS announcement.
- Anon key is public by design; RLS is the boundary; a test evidences that
  an anonymous client cannot read another user's rows.

## Launch checklist (after M1, refined after M2)

1. Rob adds DNS: `cityops.robriggs.com CNAME robriggs3.github.io.`
2. Repo Pages custom domain set to cityops.robriggs.com, enforce HTTPS.
3. Old github.io URLs keep working (Pages redirects project URLs to the
   custom domain).
4. Cross-links: cityops footer -> wheres.robriggs.com; wheres hero/footer ->
   cityops.robriggs.com (wheres edit is a 2-line change, done at
   announcement time).
5. Announcement waits for Yerevan field days (decided 2026-08-11).

## Parallelism with wheres.robriggs.com (direction, decided 2026-08-11)

Rob's goal: the two apps run as parallel as possible; full integration is
an open future option, deferred to the engineering call. The call: parallel
codebases, converging surfaces. Concretely in this phase:

1. Shared token language: cityops adopts not just wheres's palette VALUES
   but its custom-property NAMES (--bg, --bg-card, --accent, --accent-soft,
   --text/-2/-3, --border/-light, --green/-soft, --blue/-soft,
   --amber/-soft). Restyling either app later means editing one token block
   that reads identically in both.
2. Cross-navigation ships with the app (not just at announcement): a quiet
   header/footer link each way once wheres side is edited.
3. Deep links: the app honors a `#city=<cityId>` hash (select that city on
   load, update hash on switch), so wheres city rows can link straight into
   the matching cityops city. This is the first plank of the PRD Phase 3
   bridge.
4. Full integration decision point: revisit after the Phase 3 plan-ahead
   bridge (stop export -> scaffolded city; done-items -> trip record) has
   run for a real leg. If the bridge feels like friction rather than glue,
   merging becomes the answer; the shared tokens and schema keep that step
   small.

## Tracked separately (not this spec)

- wheres.robriggs.com UX improvements: Rob wants a pass on it after cityops
  launch. Its own small spec when we get there.
- Phase 3 (PRD): Places enrichment, affiliate links, plan-ahead bridge.

## Testing

- Engine extraction: sync-assertion test (template.html contains exactly
  cityops.js) + full existing suite (42) keeps passing untouched.
- App shell: pure logic tests for the city store (add/switch/remove/rename
  collision, active pointer, order); browser verification checklist at
  phone width for switcher/add/remove/export/palette.
- Sync: unit tests for reconcile decisions (newer-wins matrix, tie, missing
  rows both sides); live two-browser-profile verification before Rob relies
  on it.
- Palette: side-by-side screenshots (old/new) for Rob's approval; contrast
  spot-checks (amber-on-soft, accent-on-grey) at WCAG AA for body-size text.

## Milestones

- M1 (target: before Sat 2026-08-15 departure): engine extraction, app
  shell, palette, SW, DNS live at cityops.robriggs.com.
- M2 (target: during Yerevan week, no fixed day): Supabase project, auth,
  sync, security acceptance, cross-device verification.
- Launch/announce + cross-links + wheres UX pass: after field validation.
