# CityOps Phase 3a: Interest Profile + Item Intel (Design Spec)

Date: 2026-08-12 (Wed)
Owner: Rob Riggs
Status: awaiting Rob's spec review
Prior art: Phase 1 + Phase 2 specs (shipped, in field use). PRD Phase 3 covers enrichment; this is its zero-cost first slice.

## Goal

Two features Rob asked for on 2026-08-12:

1. **Interest profile.** Build/update a personal profile of interests; the AI finds matching places and activities in a new city, or ADDS them to an existing city on re-run (a delta merge that never disturbs the traveler's progress).
2. **Item intel.** Restaurants carry review-sourced recommendations for specific menu items (can't miss / worth it / don't bother). Non-restaurant items get the same structure as hacks, advice, and tier calls.

## Decisions already made (with Rob, 2026-08-12)

- **Zero incremental cost.** No in-app AI calls, no server-side API key, no new backend. "Our AI" = the traveler's own AI engine via the paste workflow, exactly as PROMPT.md works today. Rob: "until people are willing to pay for it, doesn't make sense to incur additional cost." Architecture keeps in-app AI (Supabase edge function + Anthropic API) as a future button-swap: profile model, merge logic, schema, and render are identical either way.
- Both features ship together; the profile syncs with the account (it is user data, not device preference).
- Existing cities are re-enrichable: the delta merge is the core mechanic, not a nice-to-have.
- Standing rules apply: no invented facts (review-verified only, uncertainty flagged), no em-dashes, no dependencies, standalone guides stay clean of app-only concerns.

## Feature 1: Interest profile

### Model

Stored in the app store as `profile` (synced via a third Supabase row kind, see Sync). Shape:

```json
{
  "schema": 1,
  "interests": ["climbing gyms", "live jazz", "board game cafes", "specialty coffee", "third-wave barbers"],
  "avoid": ["nightclubs", "guided bus tours"],
  "notes": "Vegetarian most days. Happy to walk 30+ minutes. Prefers small venues.",
  "updated": "2026-08-12T10:00:00Z"
}
```

- `interests`: free-text list, one interest per entry, order = priority. Kept short by design (the UI nudges toward 5-12; more dilutes the research).
- `avoid`: things the AI should not surface.
- `notes`: anything that changes what "a good pick" means (diet, mobility, budget). This REPLACES the manual bracket in PROMPT.md's traveler-profile block for app users; the file-only user still edits PROMPT.md by hand.

### UI (app-only)

- New "Profile" entry in the city dropdown action row (next to Sign in). Opens a modal: interests as a chip list with add/remove (Enter adds; tap a chip's x removes), avoid list the same, notes textarea, Save / Cancel. Dense; matches existing modal language.
- Signed-in copy: "Saved to your account." Signed-out copy: "Saved in this browser." (Same sync-aware pattern as Add city.)

### How the profile reaches the AI (zero-cost path)

- **New city:** the "Add city" modal gains a **Build my prompt** button: it assembles PROMPT.md's text with the city header AND the profile block pre-filled and copies it to the clipboard (with a fallback textarea for copy on iOS). The traveler pastes it into their AI, gets JSON, pastes it back. Interests become a ninth section `{"id":"interests","label":"My interests","icon":"⭐"}` in generated output when the profile is non-empty.
- **Existing city (re-run):** on any city, a new toolbar action **Enrich** opens a modal with two prompt builders:
  1. **Interests delta**: a prompt that includes the profile, the city header, the CURRENT item ids/names (so the AI does not re-suggest them), and an output contract for a PARTIAL payload: `{"schema":1,"delta":true,"sections":[...optional new sections...],"items":[...new items only...]}`.
  2. **Intel pass** (feature 2): a prompt that includes the current items (id + name + section) and asks for `{"schema":1,"delta":true,"intel":{"<itemId>": {...intel block...}}}` covering as many items as the AI can verify.
  Both are copied to clipboard; the traveler pastes results into the same Enrich modal's paste box.

### Delta merge (the core mechanic)

`CityOps.mergeDelta(cityData, delta) -> {data, summary}` (pure, unit-tested):

- Validates the delta: `schema:1`, `delta:true`; every new item passes the same per-item validation as validate() (unique id vs existing + within delta, known section either existing or introduced in `delta.sections`, status plan/backup only, place_id/verified null).
- Adds `delta.sections` not already present (appended after existing sections; an existing section id in the delta is ignored, not overwritten).
- Adds `delta.items`; an item whose id already exists is SKIPPED (never overwritten) and counted in the summary.
- Applies `delta.intel` per id onto existing items' `intel` field (this is the ONE thing that may update an existing item, and only that field).
- Never touches `city`, `dates`, existing items' other fields, or any live state.
- Summary: `{added: n, skipped: n, sectionsAdded: n, intelApplied: n}` shown in the notice.
- Result data goes through the same path as Update data: stored as the city's new canonical data (app store) and pushed by sync as a data row. Live state is untouched, so every done-mark, reorder, rename, and collapse survives by construction.

## Feature 2: Item intel

### Schema addition (optional field, backward compatible)

```json
"intel": {
  "verdicts": [
    {"tier": "must", "text": "Adjarian khachapuri, the boat with the egg"},
    {"tier": "good", "text": "Pkhali plate to share"},
    {"tier": "skip", "text": "The seafood platter: frozen, priced for tourists"}
  ],
  "tips": [
    "Go before 13:00 or after 15:00 to skip the queue",
    "Cash only despite the sign; ATM two doors down"
  ],
  "source": "Aggregated from Google and TripAdvisor reviews, mid-2026"
}
```

- `verdicts[].tier`: `must | good | skip` (rendered as green / neutral / amber tags: reuse the badge families; "skip" is amber not red, red is the accent). Applies to menu items for restaurants; to specific things (exhibits, routes, seats, add-ons, timings) for everything else.
- `tips[]`: short hacks/advice strings.
- `source`: one line of provenance; the prompt requires it, so unverifiable intel is visibly labeled.
- Validation: optional; if present, tiers must be from the enum, arrays of non-empty strings; a bad intel block fails validation like any other malformed field.
- Export/round-trip: intel is data, so it round-trips losslessly with no changes to buildExport.

### Rendering (engine, so standalone guides get it too)

- Below the note, a compact **Intel** strip: verdict tags inline (tier tag + text), tips as a tight bulleted list, source line in the small muted style. Collapsed by default behind a one-line "Intel: 3 verdicts, 2 tips" toggle when there are more than 2 entries total, expanded inline when tiny (density rule).
- Share view: verdicts shown (they are the useful bit when handing a plan to someone), tips omitted, source omitted.
- Calendar view: same as planner.

### PROMPT.md changes

- New "Intel" quality rules block: for every restaurant, name 2-4 specific dishes with must/good/skip verdicts ONLY where reviews repeatedly and specifically support them (dish named by multiple reviewers); for activities/services, 1-3 verdicts on specifics (which route/section/seat/time/add-on) plus 1-3 tips; always include the source line; leave `intel` out entirely rather than pad it.
- Traveler profile block gains the profile fields (interests / avoid / notes) with a note that app users get this pre-filled by Build my prompt.
- Output contract: interests section id + rules; intel schema; the two delta output contracts (partial payload shapes) documented in a new "Re-run prompts" section that Enrich builds from.

## Sync (M2 extension)

- New Supabase table `profile` (user_id pk/unique, data jsonb, updated_at), same RLS pattern as cities (own rows only, anon revoked). One row per user.
- Sync engine treats it as a third kind with the same newer-wins reconcile; pull on the same triggers; push on Save (debounced through the existing path).
- Migration: pure addition; nothing changes for cities/city_state.

## Explicitly out of scope (this slice)

- In-app AI calls (Phase 3b, gated on revenue). The Enrich modal's copy says so honestly: "This builds a prompt for your own AI. In-app research is planned for a future version."
- Google Places enrichment, affiliate links (PRD Phase 3 proper).
- Sharing profiles between users; multi-traveler profiles.

## Testing

- Pure: profile normalize; mergeDelta (adds, skips duplicates, adds sections once, applies intel to existing ids only, rejects invalid deltas, never mutates input, live-state untouched by construction); intel validation (enum, shapes, optional); export round-trip with intel present; prompt builder assembles the profile block and current-item list correctly (string assertions).
- Browser: profile modal (add/remove chips, save, reload persistence, sync-aware copy); Build my prompt copies text containing the profile; Enrich modal paste of a valid delta merges and shows the summary; a delta with a duplicate id is skipped and reported; intel renders on a card and in share view; standalone export contains intel and NO profile/enrich UI.
- Data: apply an intel pass to yerevan.json's dinner section (real research, review-verified) so the feature ships with real content for Rob's actual week; validator green; no em-dashes.

## Milestones

- 3a.1: schema + validation + intel render + PROMPT.md rules (engine + template; standalone guides benefit).
- 3a.2: profile model + modal + Build my prompt + profile sync table.
- 3a.3: Enrich modal + delta prompt builders + mergeDelta + summary notice.
- 3a.4: real intel pass on Yerevan (and interests delta if Rob fills his profile in time), review, ship.
