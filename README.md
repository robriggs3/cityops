# CityOps

**A living city guide you operate, not just read.**

[![tests](https://github.com/robriggs3/cityops/actions/workflows/test.yml/badge.svg)](https://github.com/robriggs3/cityops/actions/workflows/test.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-0-2d7d34)
![no build step](https://img.shields.io/badge/build%20step-none-2d7d34)
[![license](https://img.shields.io/badge/license-MIT-2c5d8a)](LICENSE)

AI engines produce good city research in minutes, but the output is a wall
of text you re-scroll all week while the real trip mutates around it:
plans reorder, options die ("full tonight"), backups get promoted, and
half the value is discovered on the ground. CityOps owns the layer between
AI research and the actual week: a guide with a working memory.

**Live app:** [app.nomadding.com](https://app.nomadding.com) ·
**Example guide:** [example.html](https://app.nomadding.com/example.html) ·
**Deep dive:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

This public repo ships the app plus one bundled example city. The real
city guides it was built around (and field-tested on) are personal travel
data and live out-of-repo by design, in a private deployment of the same
code.

| Planner | Review-verified intel |
|---|---|
| ![Planner at phone width: day cards with lifecycle controls](docs/media/planner.png) | ![A restaurant card with must/good/skip dish verdicts and tips](docs/media/intel.png) |

## What it does

- **One file per city, or one app for all of them.** A guide is a single
  self-contained HTML file: opens from a bookmark, works offline, installs
  to a phone home screen. The hosted app wraps the same engine with a city
  switcher, profiles, and cross-device sync, and can export any city back
  to a standalone file: your data always has an exit.
- **A lifecycle, not a list.** Every place is `plan`, `backup`, `done`, or
  `archived`, with one-tap moves and undos. Days are chronological slots;
  drag a day's content elsewhere and the dates stay put while the plan
  reorders. Rename items, collapse sections, collapse whole days once they
  are done; everything persists.
- **AI-native, at zero marginal cost.** The app assembles complete
  research prompts (city, dates, your interest profile, an output
  contract) for your own Claude/ChatGPT session, then merges the returned
  JSON with hard guarantees: existing items and your progress are never
  overwritten. It can also run those prompts in the app against your own
  Anthropic API key, in which case the prompt and the reply travel between
  your device and Anthropic's API, billed to your key.
- **Review-verified intel.** Cards carry `must / good / skip` verdicts on
  specific dishes and specifics-of-the-thing (which route, which seats,
  which add-on), plus tips and a source line. A real pass on a lived-in
  guide produced 25 items with 73 verdicts, built from per-dish review
  data, and corrected the guide's own prose in four places.
- **Local-first sync.** Optional magic-link login puts cities, progress,
  and your profile behind your account with row-level security. Offline
  and logged-out modes are fully functional; sync reconciles newest-wins
  when you reconnect.

## Quick start (no account, no install)

1. Copy `template.html` to `<city>.html` (e.g. `lisbon.html`).
2. Fill in the header of [`PROMPT.md`](PROMPT.md) with the city, dates,
   accommodation, and traveler profile, then paste the whole prompt into
   Claude, ChatGPT, or any capable AI engine. It returns a single JSON
   code block.
3. Get that JSON into the file, either way:
   - Paste it into the `<script type="application/json" id="city-data">`
     block in `<city>.html`, or
   - Save it as `cities/<city>.json` and run
     `node tools/embed.js cities/<city>.json <city>.html`.
4. Open the file. That's the whole guide: no build step, no server,
   offline once loaded, phone-friendly.

Or skip the file entirely: open the
[app](https://app.nomadding.com), tap the city name, **+ Add city**,
and either paste generated JSON or start a blank city from a name and
dates. **Build my prompt** assembles step 2 for you, with your saved
interest profile included.

## The workflow

Each place has a lifecycle: `plan` (the current pick), `backup` (the
alternative when plan A falls through), `done` (visited; recedes but
stays visible as the trip record), and `archived` (out of the way,
recoverable). One-tap controls move items between states; every move is
undoable, and controls only render where the action is valid.

Days render as chronological slot cards, including empty days, so
anything can be dragged or moved onto any date of the stay. **Share**
flips to a clean read-only view (prints as a one-pager). **Export**
downloads schema-valid JSON with your live changes baked in; the round
trip back through paste is lossless by test. **Update data** and
**Enrich** accept pasted JSON on the go: Update data replaces a city's
research wholesale, Enrich merges a delta (new interest matches, or an
intel pass) without touching anything you've done.

Somewhere recommended over dinner goes in by hand from the **+** on any
section header, and the card that appears carries an **Ask Claude**
control that looks the place up and ranks it against the rest of that
section: "ranks 2nd of your 11 dinner picks". The header carries a
single row of highlights above the city's facts: today's sunset,
computed on the device from the city's coordinates with no network call,
and up to four **pinned** items, so the tap-water rule sits in the header
instead of eleven screens down the Info tab.

## Engineering notes, briefly

The short version of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):

- ~2,000-line dependency-free engine + app shell, assembled into
  committed artifacts by a one-command assembler; CI fails if artifacts
  drift from source.
- Canonical data and live state never mix, which makes re-imports, AI
  deltas, and sync structurally unable to destroy user progress.
- Sync is Supabase over raw `fetch` (no SDK): magic-link auth, epoch-ms
  newer-wins reconcile, flush-on-hide, RLS-only security with anonymous
  access revoked and verified.
- Two surfaces, one app: the guide side (`index.html`, what to do in a
  city) and the trip side (`/trip/`, stops, stays and travel legs)
  share an origin, a session, and a credential store. Both are assembled
  from `src/` by the same assembler, so the drift guard covers both.
- A third, public surface: `/share/`, a read-only snapshot of a trip
  (optionally with chosen city guides) at an unguessable token, for
  people with no account. Anonymous readers get exactly one door, the
  `get_share(token)` security-definer function; the `shares` table itself
  grants nothing to `anon`, so enumeration is impossible and a rotated
  token dies instantly. What a snapshot may contain is a fixed field list
  in the engine (`CityOps.shareKit`), pure and unit tested: no costs, no
  booking confirmations, no paid flags, no private notes, no addresses.
- Credentials never live in synced data. The Anthropic key keeps its own
  localStorage entry with its own ISO stamp and syncs as a stamped
  sidecar on the profile row. No export, snapshot or published page can
  carry one.
- The AI integration is a prompt contract: `PROMPT.md` doubles as
  documentation and machine-readable source, sliced by landmark into
  generated prompts; the merge path is validation-gated and
  prototype-safe.
- Billing is enforced in the DATABASE, not the UI.
  `has_active_entitlement(uid)` is a security-definer helper checked in
  the `WITH CHECK` of every write policy on `cities`, `city_state`,
  `planahead` and `shares`. Reads and deletes stay own-rows, so a lapsed
  account keeps everything it made, can still export it, and can still
  delete it; what pauses is write-sync, one-tap AI and publishing a
  share link. The same decision is mirrored in the engine
  (`CityOps.entitlementKit`, pure and unit tested) for one purpose only:
  saying why before a refusal happens, never after. Stripe reaches the
  project through one Payment Link per tier and one edge function
  (`supabase/functions/stripe-webhook`) whose signature check IS its
  inbound auth gate.
- 447 tests on Node built-ins; the harness tests the exact bytes that
  ship. Every feature landed through a written spec, plan, and
  independent review (committed under `docs/superpowers/`), a workflow
  run with AI agents doing implementation and adversarial review under
  human product direction.

## Schema

Schema v1 is the contract across standalone guides, the app, exports, and
the generation prompt. Three forms, by audience:

- **[schema/cityops.schema.json](schema/cityops.schema.json)**: formal JSON
  Schema (draft 2020-12) for machine validation, including the Enrich delta
  payload shape. Both shipped city datasets validate against it.
- **Runtime validator**: `validate()` / `validateItem()` / `validateIntel()`
  at the top of [src/cityops.js](src/cityops.js), the enforcement boundary
  for every entry path (paste, delta merge, sync pull). Deliberately a
  permissive subset of the JSON Schema; the schema file's description
  documents exactly which constraints are advisory.
- **[PROMPT.md](PROMPT.md)'s output contract**: the same rules phrased for
  an AI engine generating data.

The shape in one glance:

```json
{
  "schema": 1,
  "city": {"name": "Yerevan", "country": "AM",
           "dates": {"from": "2026-08-15", "to": "2026-08-22"}},
  "sections": [{"id": "dinner", "label": "Dinner", "icon": "🍽️"}],
  "items": [{
    "id": "buzand-cafe", "section": "dinner", "status": "plan",
    "day": "2026-08-16", "name": "Buzand Cafe Restaurant",
    "price": {"text": "~4,000-12,000 AMD / $11-33"},
    "note": "4.8 stars across 442 reviews ...",
    "hours": {"text": "10:00-23:00 daily", "class": "late"},
    "links": [{"kind": "map", "label": "Open in Maps", "href": "https://maps.google.com/?cid=..."}],
    "intel": {"verdicts": [{"tier": "must", "text": "The Italian side of the menu"}],
              "tips": ["Ask for the outdoor patio"],
              "source": "Yandex per-dish review data, Aug 2026"},
    "place_id": null, "verified": null
  }]
}
```

## Roadmap

Built and shipped in phases, each gated on evidence from real use:
single-file guides (phase 1), the multi-city app with sync and a custom
domain (phase 2), profiles + intel + delta enrichment (phase 3a). Next:
a bridge from the companion itinerary tracker (one tap scaffolds a city
from a trip stop), server-side enrichment when usage justifies the cost,
and Places-API verification. Full history in `docs/superpowers/`.

## License

MIT. The example city data is real, field-checked research; treat prices
and hours as snapshots of when they were verified.
