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

If a "Traveler interests" block appears below this line, treat it as part of
the profile: it lists what this traveler seeks out, what to avoid, and any
notes that change what a good pick means. App users get that block filled in
automatically by Build my prompt; if you are editing this file by hand and
want the interests section, write the block yourself in the same shape.

---

## What I need

Research this city and return a single guide covering eight sections:
dinner, breakfast, lunch, coffee, coworking, activities, services, and
practical notes. Add a ninth section, interests, only when a Traveler
interests block appears in the header above.
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

### Breakfast

2 to 3 plan picks plus a few backups. Opening time is the deciding factor:
the traveler starts work in the morning, so a breakfast place that opens
at 10:00 is a backup at best. Favor what actually opens 07:00 to 08:30
(local breakfast spots, bakeries, early brunch), near the accommodation or
on the work-morning route. State the opening time prominently in the note.
No day assignments; breakfast repeats daily.

### Lunch

3 to 4 plan picks plus 3 to 5 backups. The realistic use is a late lunch
around 14:00 to 15:00 when the work morning ends, either near the
accommodation, in the center, or on the way to that day's activity. Favor
light-to-medium local options over heavy sit-down meals (the big meal is
dinner); include at least one near-accommodation option and one center
option, plus a market or street-food option if the city has a real one.
No day assignments.

### Coffee

2 to 3 specialty coffee picks (good espresso, not just "has coffee"), plus
a few backups. These are for the workday, so weight toward places near the
accommodation or on the routine commute, with reliable hours in the
morning. If a coffee pick doubles as the breakfast answer, say so in both
sections rather than duplicating the item.

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

### Interests

Include this section ONLY if a "Traveler interests" block appears in the
header above. If there is no such block, skip this section entirely and
return the eight sections listed above.

When the block is present, add a ninth section with `"id": "interests"`,
`"label": "My interests"`, `"icon": "⭐"`, and fill it with 3 to 6 plan picks
plus 3 to 5 backups that match the listed interests, weighted toward the ones
listed first (the order is the traveler's priority order). Rules:

- Real, specific places or events only, same standard as every other
  section: a named climbing gym, a named jazz venue with the night it
  actually has live music, not "the city has a climbing scene".
- Never suggest anything that matches the Avoid list, and apply the Notes
  the same way you apply the traveler profile.
- No `day` assignments unless the pick only happens on a specific date
  (a weekly jam night, a match, a market day). Then use the ISO date inside
  the stay range and say why in `when`.
- If an interest simply does not exist in this city, say so plainly in a
  practical note ("no bouldering gym in the city; nearest is 90 minutes
  away in X") rather than forcing a weak pick to fill the slot. A short,
  honest section beats a padded one.
- Do not duplicate a place that already appears in another section. If the
  best match for an interest is already the coffee or dinner pick, say so
  in that item's note instead of listing it twice.

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
- **Ratings go in the `rating` field, never buried in the note.** A rating
  with a real review count is useful signal, and the app renders it as a
  badge on the card, so emit it as structured data:
  `"rating": {"stars": 4.8, "count": 5545, "source": "Google Maps, Aug
  2026"}`. Do not also write "4.8 stars, 5,545 reviews" into `note`; the
  note is for what the number does not say. Don't round up, don't guess a
  count, and omit `rating` entirely for a place you could not look up.

### Intel

`intel` is the optional block that tells the traveler what to actually order
or do once they are there. It is worth more than another paragraph of
description, and it is worth nothing at all if it is invented. Rules:

<!-- RULES:INTEL -->
- **Restaurants and cafes:** name 2 to 4 specific dishes or drinks with a
  `must`, `good`, or `skip` verdict. Only include a dish that multiple
  reviewers name specifically. One person's favourite is not a verdict, and
  "the food is great" is not a dish. A `skip` needs the same support: say
  what is wrong with it in the same short line ("seafood platter: frozen,
  priced for tourists").
- **Activities and services:** 1 to 3 verdicts on the specifics that change
  the visit (which route, wing, seat, entrance, add-on, or time of day is
  the one worth having, and which is the one people regret), plus 1 to 3
  tips: queue timing, cash-only, where the real entrance is, what to book.
- **Always a source line.** One line naming where the intel came from and
  roughly when, e.g. `"Aggregated from Google and TripAdvisor reviews,
  mid-2026"`. Unverifiable intel is then visibly labeled as such.
- **Omit `intel` entirely rather than pad it.** An item with nothing
  review-verified to say gets no `intel` field at all. A thin, invented or
  generic intel block is worse than none: the traveler acts on these.
<!-- /RULES:INTEL -->

## Output contract

Respond with **a single ```json fenced code block, and nothing else**. No
prose before or after it, no explanation, no markdown headers, no second code
block, nothing outside the fence. The JSON must be valid against schema v1
(below) with these rules:

- Top level `"schema": 1`.
- `city.dates.from` and `city.dates.to` match the trip dates given above.
- `sections` covers the eight sections above, in this order: `dinner`,
  `breakfast`, `lunch`, `coffee`, `cowork`, `activities`, `services`,
  `practical`. Use exactly these `id` values so the guide renders
  correctly. Breakfast and lunch items never carry a `day` field; they
  repeat daily. When a Traveler interests block is present, `interests` is
  the ninth and last section, so the full order is `dinner`, `breakfast`,
  `lunch`, `coffee`, `cowork`, `activities`, `services`, `practical`,
  `interests`.

<!-- CONTRACT:ITEM -->
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
- `intel` is optional on any item. When present it is an object with any of
  `verdicts`, `tips`, and `source`, and nothing else:
  - `verdicts`: array of `{"tier": "must" | "good" | "skip", "text": "..."}`,
    text non-empty and naming the specific dish, route, seat or add-on.
  - `tips`: array of short non-empty strings.
  - `source`: one line of provenance.
  Include `intel` only where reviews support it; omit otherwise.
- `rating` is optional on any item and is the ONLY place a rating belongs
  (never prose in `note`). When present it is an object with any of:
  - `stars`: required, a number from 0 to 5, one decimal (`4.8`).
  - `count`: the review count as a whole number, no separators (`5545`).
    Omit it rather than guess or round one.
  - `source`: where the number came from and roughly when
    (`"Google Maps, Aug 2026"`).
  - `checked`: the date you looked it up, `YYYY-MM-DD`.
  Omit `rating` entirely for a place whose rating you could not verify.
- Every item's `section` matches one of the section ids you defined.
- Every item has a unique `id` (a short slug, e.g. `"brasserie"`), a
  `name`, and a `links` array. Place items must have at least a `map`
  link. Practical-section note items may have an empty array.
- **One item is one thing the traveler does.** Never emit a per-day
  summary item that packs a whole day into one note (`"name": "Mon
  2026-08-24"`, `"note": "AM: coworking day pass · PM: pedicure · barber
  · Eve: dinner at Era"`). The app plans by moving individual items
  between days, so a packed day is one immovable block: rescheduling the
  barber means retyping a sentence, and everything else in that sentence
  moves with it. Split it instead:
  - Each stop that is a place gets its own item in its own section
    (dinner, coffee, activities, services) carrying the `day`. Reference
    a place from at most one item; never repeat a place as both a venue
    item and a plan entry.
  - Each stop that is not a place (a work block, a laundry load, a cash
    withdrawal, a market run, packing) gets its own small item with its
    own `day`, in whichever section fits, or `practical` if none does.
  - Use `when` for the slot inside the day (`"AM"`, `"PM, arrive 18:00
    sharp"`), which is what the AM/PM/Eve prefixes were doing.
<!-- /CONTRACT:ITEM -->

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
    "note": "The room everyone books for a last night; reserve.",
    "rating": {"stars": 4.8, "count": 1216, "source": "Google Maps, Aug 2026"},
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
  follows or precedes, or the slot inside the day: `"AM"`, `"Eve, reserve
  in advance"`). Use it for dinner plan picks and for anything whose
  position inside a day matters.
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
- `rating`, when you have it, sits alongside `note` on the item and is
  where every rating belongs: `stars` (0-5), optional `count`, optional
  `source`, optional `checked` date. The app shows it as a badge on the
  card, so a rating written into the note instead is a rating the traveler
  cannot see at a glance.
- `intel`, when you have it, sits alongside `note` on the item:

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

Fill in the header above, paste this whole file into the chat, and return
only the JSON.

## Re-run prompts

These three prompts run against a city you already have. They return a PARTIAL
payload (a delta) that gets merged into the existing guide, so the traveler's
progress, renames and day arrangement all survive. The app builds them for
you from the Enrich button; by hand, copy the block you want, paste the trip
header and the current item list under it, and send that.

A delta is never a whole guide. Never re-list an item that already exists,
never restate `city` or `dates`, and never emit `"status": "done"` or
`"archived"`.

### Interests delta

Adds new items matching the traveler's interests to a city that already
exists. Requires a Traveler interests block.

<!-- RERUN:INTERESTS -->
A delta is never a whole guide. Never re-list an item that already exists,
never restate `city` or `dates`, and never emit `"status": "done"` or
`"archived"`.

Research this city for the traveler interests listed above and return ONLY
new items that match them. The city, its dates and the traveler profile are
given above; the items the guide already holds are listed below, by id.

Rules:

- Return 3 to 6 new plan picks and up to 5 new backups, weighted toward the
  interests listed first.
- Never return an item whose id is already in the list below, and never
  return the same place under a new id. New ids must be short slugs and
  unique against that list.
- Put them in the `interests` section (`{"id": "interests", "label": "My
  interests", "icon": "⭐"}`). Include that section object in `sections`
  ONLY if the list below shows the guide does not have it yet. If some picks
  belong in an existing section (a restaurant that is genuinely a dinner
  pick), use that existing section id instead.
- Every item follows the same rules as a full guide: real place, real Maps
  link, no invented URLs, prices in local currency and USD, `place_id` and
  `verified` both null, `status` either `plan` or `backup`, `day` only when
  the pick only works on a specific date inside the stay.
- Skip anything on the Avoid list, and apply the Notes.
- If an interest has no real match in this city, leave it out and say
  nothing: do not pad the delta with weak picks.

Respond with only a JSON code block in this shape, no prose:

```json
{
  "schema": 1,
  "delta": true,
  "sections": [{"id": "interests", "label": "My interests", "icon": "⭐"}],
  "items": [
    {
      "id": "new-slug",
      "section": "interests",
      "status": "plan",
      "name": "Real Place Name",
      "note": "Why it matches, with rating and review count if you have it.",
      "price": {"text": "~2500 AMD / $6"},
      "hours": {"text": "10:00-22:00 daily", "class": "late"},
      "tags": [],
      "links": [{"kind": "map", "label": "Open in Maps", "href": "https://maps.google.com/?cid=..."}],
      "place_id": null,
      "verified": null
    }
  ]
}
```

`sections` is optional: omit it entirely when the section already exists.
`items` is required and holds new items only.
<!-- /RERUN:INTERESTS -->

### Intel pass

Adds the `intel` block (verdicts, tips, source) to items the guide already
holds. It changes nothing else about them.

<!-- RERUN:INTEL -->
A delta is never a whole guide. Never re-list an item that already exists,
never restate `city` or `dates`, and never emit `"status": "done"` or
`"archived"`.

Research the items listed below, by id, and return review-verified intel for
as many of them as you can support. Do not return new items, do not rewrite
names, notes, prices, hours or links, and do not return anything for an id
that is not in the list.

Follow the Intel quality rules above exactly:

- Restaurants and cafes: 2 to 4 named dishes with `must`, `good` or `skip`
  verdicts, only where multiple reviewers name the dish specifically.
- Activities and services: 1 to 3 verdicts on the specifics that change the
  visit, plus 1 to 3 practical tips.
- Always a one-line `source`.
- Leave an item out of the payload entirely rather than pad it. Covering
  half the list with real intel is the correct outcome; covering all of it
  with invented intel is not.

Respond with only a JSON code block in this shape, no prose:

```json
{
  "schema": 1,
  "delta": true,
  "intel": {
    "item-id-from-the-list": {
      "verdicts": [
        {"tier": "must", "text": "Adjarian khachapuri, the boat with the egg"},
        {"tier": "skip", "text": "The seafood platter: frozen, priced for tourists"}
      ],
      "tips": ["Go before 13:00 or after 15:00 to skip the queue"],
      "source": "Aggregated from Google and TripAdvisor reviews, mid-2026"
    }
  }
}
```

Keys of `intel` are existing item ids. Anything else in the payload is
ignored.
<!-- /RERUN:INTEL -->

### Ratings refresh

Refreshes the `rating` block (stars, review count, source, date checked) on
items the guide already holds, and may attach one short notable-review
takeaway per item while it is reading those reviews anyway. It changes
nothing else about them, and it is the pass to run when the guide is a few
weeks old and you are choosing between two places tonight.

<!-- RERUN:RATINGS -->
A delta is never a whole guide. Never re-list an item that already exists,
never restate `city` or `dates`, and never emit `"status": "done"` or
`"archived"`.

For each item listed below, look up its CURRENT Google Maps rating and review
count, and return them keyed by the item's id. Rules:

- **Look it up. Never guess, never carry a number forward from memory.** The
  whole value of this pass is that the number is current.
- **Omit any item you cannot verify.** A short payload of real ratings is the
  correct answer; a complete one with invented numbers is worthless and
  actively misleading, because the traveler chooses where to eat with it.
- **Match the right place.** These are specific venues in one city, and
  chains and same-name places in other districts are the usual way this goes
  wrong. If you cannot tell which branch the item means, leave it out.
- `stars` is a number from 0 to 5 with one decimal (`4.8`). `count` is the
  review count as a whole number with no separators (`5545`); omit `count`
  rather than round or estimate one.
- `source` names where the number came from and when, e.g.
  `"Google Maps, Aug 2026"`. `checked` is today's date as `YYYY-MM-DD`.
- Do not return new items, and do not rewrite names, notes, prices, hours or
  links. Do not return anything for an id that is not in the list.

### Notable reviews (optional, at most one per item)

While you are reading an item's reviews for the number, you may also return
**one** short takeaway that a reviewer actually makes, in an `intel` block
keyed by the same item id. Rules:

- **At most one per item, and only when it would change a decision.** "Book
  the terrace, the indoor room is loud" is worth a line. "Lovely staff" is
  not. Skip the item entirely rather than pad it.
- **One sentence, under about 18 words, in the traveler's voice.** No star
  counts (the rating block already carries those), no quotation marks, no
  reviewer names.
- **It must come from reviews you actually read.** The same bar as the number:
  an omitted takeaway is the correct answer, an invented one is worse than
  nothing, because it reads exactly like the verified ones.
- **`intel` REPLACES an item's whole existing intel block.** The item list
  below echoes any intel an item already holds on indented lines under it. If
  you add a takeaway to such an item, you must repeat those existing verdicts,
  tips and source **verbatim** in your `intel` block alongside your new tip,
  or they are deleted. If you have nothing to add for an item, leave it out of
  `intel` entirely and its existing intel is untouched.
- Your takeaway goes in `tips`. Do not invent `verdicts` here: a verdict tier
  is the intel pass's job, and this pass has not done that work.

Respond with only a JSON code block in this shape, no prose:

```json
{
  "schema": 1,
  "delta": true,
  "ratings": {
    "item-id-from-the-list": {
      "stars": 4.8,
      "count": 5545,
      "source": "Google Maps, Aug 2026",
      "checked": "2026-08-25"
    }
  },
  "intel": {
    "another-item-id": {
      "tips": ["Reviewers say the terrace is the quiet half; ask for it when you book."],
      "source": "Google Maps reviews, Aug 2026"
    }
  }
}
```

Keys of `ratings` and of `intel` are existing item ids. `intel` is optional
and may name a different, smaller set of items than `ratings` does. Anything
else in the payload is ignored.
<!-- /RERUN:RATINGS -->
