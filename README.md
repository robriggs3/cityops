# CityOps

## What this is

CityOps is a living city guide you operate, not just read. Each city is a
single HTML file: paste research data in once, then use the guide day to
day to plan, promote backups when a plan falls through, mark things done,
and archive what you're not using. No app to install, no server, no
account. One file per city that opens in any browser, works offline once
loaded, and installs to a phone home screen like a native app.

It grew out of a hand-built Batumi guide that worked well in the field.
This repo turns that into a reusable tool: any city becomes an operable
guide from AI-researched data, and every guide reads and writes the same
schema, so a future synced app can import any city's data losslessly.

## Quick start

1. Copy `template.html` to `<city>.html` (e.g. `yerevan.html`).
2. Fill in the header of `PROMPT.md` with the city, dates, accommodation,
   and traveler profile, then paste the whole prompt into Claude, ChatGPT,
   or any capable AI engine. It returns a single JSON code block.
3. Get that JSON into the file, either way:
   - Paste it directly into the `<script type="application/json"
     id="city-data">` block in `<city>.html`, or
   - Save it as `cities/<city>.json` and run
     `node tools/embed.js cities/<city>.json <city>.html`, which does the
     same paste for you.
4. Open `<city>.html` in a browser. That's the whole guide: no build
   step, no server. It works offline once loaded and is phone-friendly,
   so add it to your home screen for the trip.

## The workflow

Each place in the guide has a lifecycle: `plan` (the current pick),
`backup` (an alternative if the plan pick falls through), `done` (visited,
recedes but stays visible), and `archived` (out of the way, recoverable).
One-tap controls move items between these states, and every move is
undoable.

Days with dated items render as day cards, and you can drag to reorder
items within a day (keyboard reordering works too) if you want to change
the order you'd try things.

The **Share** toggle switches to a read-only view: plan and done items
only, grouped by day then section, backups and archived hidden, controls
hidden. It's meant for showing someone else your plan, and it prints
cleanly (`Cmd+P`) as a one-pager from that view.

**Export** downloads `<cityId>.cityops.json`: the canonical city data with
your live status changes and day order baked in. This file is the CityOps
app's import format: the future synced app is meant to read exactly this
export, so exporting now is forward-compatible even though nothing
consumes it yet. Round-tripping export back through the paste workflow is
lossless.

There's also an **Update data** box in the app for pasting corrected or
updated JSON on the go. It validates the paste, shows what changed, and
stores it as a local override rather than rewriting the file, so it flags
itself as "data updated in-app, paste into the file to make permanent."
The file on disk stays the source of truth.

## Schema reference

Full schema and design rationale: `docs/superpowers/specs/2026-08-10-cityops-phase1-design.md`
(section "Schema (v1)"). The generation prompt in `PROMPT.md` also carries
a copy of the example as a shape reference for whatever AI engine
generates a city's data.

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

`cities/batumi.json` is the reference dataset: 58 real items across six
sections (dinner, coffee, cowork, activities, services, practical),
extracted from the original Batumi guide. Read it alongside the schema
example if you want to see the shape at full scale.

## Live guides

The example guides run at https://robriggs3.github.io/cityops/ : Batumi
(the original field-tested city) and Yerevan (generated with PROMPT.md,
in daily use on the road right now). Open one on a phone to see what the
tool actually feels like: lifecycle buttons, day reordering, the calendar
view, section collapse.

## Status

Schema v1, MIT licensed, actively dogfooded on a live multi-city trip.
State (done marks, reorders, renames, preferences) saves per device via
localStorage; a synced multi-device app that imports this same schema is
the planned next phase. Issues and city files from other travelers are
welcome.
