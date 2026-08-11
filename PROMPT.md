# CityOps generation prompt

This is the prompt Rob pastes into Claude, ChatGPT, or any capable AI engine
to generate a city guide. Fill in the header, paste the whole file (header
plus everything below it) into a fresh chat, and the response should be a
single JSON code block ready to drop into `template.html`'s `city-data`
block, or to save as `cities/<city>.json` and run through
`node tools/embed.js cities/<city>.json <city>.html`.

Copy this file per trip, fill in the header, delete this line, and go.

---

## Trip details

- **City:** [city name]
- **Country:** [country, ISO 2-letter code if you know it, e.g. GE, AM]
- **Dates:** [arrival date] to [departure date], ISO format (YYYY-MM-DD)
- **Accommodation:** [name of hotel/apartment/building], [full address]
- **Arrival transport:** [flight/train/etc, arrival time if known]
- **Departure transport:** [flight/train/etc, departure time if known]

## Traveler profile

Solo traveler. Works mornings, roughly until 14:00, so mornings are off
limits for anything besides coffee near the accommodation. Explores in the
afternoon. Dinner window is 19:00 to 21:00. Walks a lot rather than taking
short rides, but uses Bolt-class ride apps for anything too far to walk.
Avoids heavy food late at night. Plans one trip into the city center per
day, not more: pick the single best anchor for that day rather than
scattering multiple center trips across it.

[Add anything trip-specific here: dietary constraints, mobility notes,
known allergies, budget ceiling, anyone traveling along, anything else
that changes what "a good pick" means this time.]

---

## What I need

Research this city and return a single guide covering six sections:
dinner, coffee, coworking, activities, services, and practical notes.
Use real, current information: actual restaurants and cafes that exist
right now, with real review counts and ratings where you can find them,
not generic or made-up suggestions.

### Dinner

One plan pick per evening of the stay, each assigned to a specific ISO
date within the stay range. Match the pick to what that day's activity
plan likely is (a beach day suggests something different from an Old Town
walking day). Add 5 to 8 backup picks across the whole stay, not tied to a
specific date, covering a spread of cuisines and price points in case a
plan pick is closed, full, or wrong on the day.

### Coffee

2 to 3 specialty coffee picks (good espresso, not just "has coffee"), plus
a few backups. These are for the workday, so weight toward places near the
accommodation or on the routine commute, with reliable hours in the
morning.

### Coworking

The best bookable coworking space (day pass or drop-in), the option
nearest to the accommodation even if it's not the best space, and a few
backups. Note weekend hours explicitly: many coworking spaces have
reduced or closed weekend hours, and a workday plan that assumes normal
hours on a Saturday will fail.

### Activities

One anchor activity per full day of the stay (the single center trip for
that day), plus a list of free/anytime options that don't need a
specific day (a park, a viewpoint, a walk), plus backups. Flag each
activity as daytime-only or evening-suited, since the traveler profile
above only frees up afternoons and evenings.

### Services

Laundry, massage or grooming, and a 24-hour or late grocery option near
the accommodation. These don't need day assignments.

### Practical

Not individual place picks: a short set of notes covering the daily
rhythm this city rewards, cash-vs-card norms, any scam or overcharging
pattern that shows up repeatedly in reviews (tourist-price menus, meter
tricks, "the card machine is broken" cash-only pushes), which ride/transit
apps actually work here, and any beach, terrain, or walkability notes
worth knowing before the first day.

## Quality rules

These are lessons from a prior guide (Batumi) that produced bad or
unusable links and missed real risks. Follow them exactly.

- **Real Maps links only.** Every place needs a real Google Maps link.
  Prefer the `?cid=` permalink form when you can find or construct it
  (`https://maps.google.com/?cid=<id>`) since it points at the exact
  listing rather than a search. If you cannot get a `cid` link, a normal
  Google Maps search/place URL is acceptable, but never fabricate one.
- **Never invent URLs.** If you are not confident a URL is real, do not
  include it. This applies to maps links, websites, and phone numbers
  alike: a wrong link is worse than a missing one.
- **No website is normal.** Plenty of good, real places (especially small
  restaurants and services) have no website. When that's the case, do not
  leave the place without a way to contact it: use a `tel:` link with the
  real phone number instead. A missing website is not a signal of low
  quality and should not push a place out of consideration.
- **Flag early closers.** Any place that closes before 22:00 needs that
  called out (in `hours.text` and by not marking it `late` in
  `hours.class`), so a dinner plan doesn't quietly assume a place is
  still open for a late seating when it isn't.
- **Flag weekend crowding.** If reviews or listed hours suggest a place
  gets noticeably busier or behaves differently on weekends, say so in
  the note.
- **Mark book-ahead places.** If reservations are recommended or required
  (busy, small, high-rated), add a `"Book ahead"` tag.
- **Prices in both currencies.** Every price should read in local
  currency and USD, e.g. `"~80-120 GEL / $30-44"`. Use a reasonable
  current exchange rate; don't need to cite a source for it.
- **Surface review-verified scam or overcharge patterns.** If reviews
  repeatedly describe a specific overcharging or scam pattern (fake bill
  padding, no-menu-price tourist upsell, meter manipulation), note it,
  either on the specific place or in the Practical section if it's a
  citywide pattern. Don't invent a risk that isn't backed by what you
  found; don't soften one that reviews clearly support.
- **Ratings and review counts in the note where they matter.** A rating
  with a real review count (e.g. `4.8 stars, 5,545 reviews`) is useful
  signal; include it in the `note` field when you have it. Don't
  round up or guess a count.

## Output contract

Respond with **only a JSON code block**. No prose before or after it, no
explanation, no markdown headers, nothing outside the code block. The JSON
must be valid against schema v1 (below) with these rules:

- Top level `"schema": 1`.
- `city.dates.from` and `city.dates.to` match the trip dates given above.
- Every item has `"place_id": null` and `"verified": null`. Those fields
  are filled by a later phase, never by this prompt.
- `status` on every generated item is either `"plan"` or `"backup"` only.
  Never emit `"done"` or `"archived"`: those are states the traveler sets
  later, in the app.
- `day`, when present, is an ISO date (`YYYY-MM-DD`) that falls inside the
  stay range (`city.dates.from` to `city.dates.to` inclusive). Backups and
  anytime items omit `day` entirely rather than guessing one.
- `hours.class`, when present, is one of:
  - `"late"`: open past 22:00.
  - `"day"`: daytime only (closes at or before roughly 18:00, or is
    otherwise not suited to an evening visit).
  - `"eve"`: evening-suited but not necessarily late (a dinner spot that
    closes at 22:00, for example).
- `sections` covers the six sections above, in this order: `dinner`,
  `coffee`, `cowork`, `activities`, `services`, `practical`. Use exactly
  these `id` values so the guide renders correctly.
- Every item's `section` matches one of the section ids you defined.
- Every item has a unique `id` (a short slug, e.g. `"brasserie"`), a
  `name`, and a `links` array. Place items must have at least a `map`
  link. Practical-section note items may have an empty array.

### Schema v1 shape reference

This is the schema example, taken directly from the CityOps design spec
(`docs/superpowers/specs/2026-08-10-cityops-phase1-design.md`, section
"Schema (v1)"). It shows the exact shape to produce, not literal content
to copy.

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
    "price": {"text": "~80-120 GEL / $30-44"},
    "note": "4.8 stars ... reserve.",
    "hours": {"text": "12:00-23:00 daily", "class": "late"},
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

Field notes:

- `sections[]` needs one entry per section actually used, each with `id`,
  `label`, and an `icon` emoji.
- `city.notes` is a short list of chip-worthy facts (ride app that works,
  distance from center, cash vs card norm) surfaced in the guide header.
- `when` is optional, free text tying an item to the day's plan (what it
  follows or precedes). Use it for dinner plan picks.
- `price` is optional but should be included whenever you have real
  price information, in the `text` field, in the local-currency-plus-USD
  format described above.
- `tags` is an array of short strings; use it for `"Book ahead"` and
  similar flags, empty array if none apply.
- `links[].kind` is `map`, `web`, or `tel`; use `tel` for phone-only
  contact links per the no-invented-URLs rule above.
- `city.accommodation.lat`/`lng` should be your best estimate for the
  accommodation address given above, not left at 0. Approximate from the
  address is fine; this doesn't need to be survey-precise.

Fill in the header above, paste this whole file into the chat, and return
only the JSON.
