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

  // Intel validation lives in one place so validate() (whole guide) and
  // mergeDelta() (intel pass payload) can never drift apart. `ref` is the
  // caller's prefix, already ending in the separator it wants, e.g.
  // "items[3] (nord) intel:" or 'intel["nord"]:'.
  function validateIntel(intel, ref, errors) {
    if (!intel || typeof intel !== 'object' || Array.isArray(intel)) {
      errors.push(ref + ' must be an object');
      return;
    }
    if (intel.verdicts !== undefined) {
      if (!Array.isArray(intel.verdicts)) {
        errors.push(ref + ' verdicts must be an array');
      } else {
        intel.verdicts.forEach(function (v, vi) {
          if (!v || typeof v !== 'object' || ['must', 'good', 'skip'].indexOf(v.tier) === -1) {
            errors.push(ref + ' verdicts[' + vi + '] tier must be must|good|skip');
          }
          if (!v || typeof v.text !== 'string' || !v.text.trim()) {
            errors.push(ref + ' verdicts[' + vi + '] needs non-empty text');
          }
        });
      }
    }
    if (intel.tips !== undefined) {
      if (!Array.isArray(intel.tips)) {
        errors.push(ref + ' tips must be an array');
      } else {
        intel.tips.forEach(function (t, ti) {
          if (typeof t !== 'string' || !t.trim()) {
            errors.push(ref + ' tips[' + ti + '] must be a non-empty string');
          }
        });
      }
    }
    if (intel.source !== undefined && typeof intel.source !== 'string') {
      errors.push(ref + ' source must be a string');
    }
  }

  // Structured ratings, validated in one place for the same reason intel is:
  // validate() (whole guide) and mergeDelta() (both new items and the ratings
  // map) have to agree byte for byte on what a rating is. `ref` is the
  // caller's prefix, already ending in its separator, e.g.
  // "items[3] (nord) rating:" or 'ratings["nord"]:'.
  //
  // stars is the only required field. count, source and checked are optional
  // and each may be omitted or null: a rating carried over from generation
  // research has a source but no checked date, and a rating a traveler has
  // only half of is still worth showing.
  function validateRating(r, ref, errors) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(ref + ' must be an object');
      return;
    }
    if (typeof r.stars !== 'number' || !isFinite(r.stars) || r.stars < 0 || r.stars > 5) {
      errors.push(ref + ' stars must be a number from 0 to 5');
    }
    if (r.count !== undefined && r.count !== null) {
      if (typeof r.count !== 'number' || !isFinite(r.count) || r.count < 0 || Math.floor(r.count) !== r.count) {
        errors.push(ref + ' count must be a whole number, 0 or more');
      }
    }
    if (r.source !== undefined && r.source !== null && typeof r.source !== 'string') {
      errors.push(ref + ' source must be a string');
    }
    if (r.checked !== undefined && r.checked !== null && !isIso(r.checked)) {
      errors.push(ref + ' checked must be YYYY-MM-DD');
    }
  }

  // The per-item rules, shared by validate() and mergeDelta() for exactly the
  // same reason. `statuses` is the allowed status list (a whole guide allows
  // all four; a delta may only introduce plan and backup, since done and
  // archived are states the traveler sets later in the app) and `statusHint`
  // is appended to that one error so the delta case explains itself. `seen`
  // is the caller's duplicate-id map, mutated as ids are accepted.
  function validateItem(it, ref, secIds, seen, errors, statuses, statusHint) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      errors.push(ref + ' is not an object');
      return;
    }
    if (!it.id) errors.push(ref + ' needs id');
    else if (Object.prototype.hasOwnProperty.call(seen, it.id)) errors.push('duplicate item id "' + it.id + '"');
    else seen[it.id] = 1;
    if (!it.name) errors.push(ref + ' needs name');
    if (!Object.prototype.hasOwnProperty.call(secIds, it.section)) errors.push(ref + ' unknown section "' + it.section + '"');
    if (statuses.indexOf(it.status) === -1) {
      errors.push(ref + ' bad status "' + it.status + '"' + (statusHint || ''));
    }
    if (it.day && !/^\d{4}-\d{2}-\d{2}$/.test(it.day)) errors.push(ref + ' day must be YYYY-MM-DD');
    if (it.intel !== undefined && it.intel !== null) validateIntel(it.intel, ref + ' intel:', errors);
    if (it.rating !== undefined && it.rating !== null) validateRating(it.rating, ref + ' rating:', errors);
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
      var secIds = Object.create(null);
      (data.sections || []).forEach(function (s) { secIds[s.id] = 1; });
      var seen = Object.create(null);
      data.items.forEach(function (it, i) {
        var ref = 'items[' + i + ']' + (it && it.id ? ' (' + it.id + ')' : '');
        validateItem(it, ref, secIds, seen, errors, STATUSES, null);
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

  // ---- delta merge ----
  // The core re-run mechanic: a PARTIAL payload from a second AI pass is folded
  // into a city that already exists, without disturbing anything the traveler
  // has done. Pure: it reads no state, touches no storage, mutates neither
  // argument, and returns a fresh deep clone. Live planning state (done marks,
  // reorders, renames) survives by construction, because it is keyed by item id
  // in a separate store this function never sees.
  //
  // Rules, all of them deliberate:
  // - errors non-empty means NO merge at all: data is null and the caller shows
  //   the list. A half-applied delta would be impossible to reason about.
  // - A delta may only introduce plan and backup items. done and archived are
  //   traveler states, never generated ones.
  // - An id that already exists is SKIPPED, never overwritten, and counted. That
  //   is what makes a re-run safe to repeat: running the same delta twice is a
  //   no-op, not a clobber. A duplicate id WITHIN one delta is an error, since
  //   that is a malformed payload rather than an overlap with existing work.
  // - delta.sections with an id that already exists is ignored, not overwritten
  //   (the traveler may have renamed a section, and a re-run must not undo it).
  // - delta.intel replaces the whole intel block on an item that exists after
  //   the merge (existing or just added); an unknown id is counted in
  //   intelSkipped, not treated as an error, because an AI naming an item the
  //   traveler has since removed is expected, not broken.
  // - delta.ratings works exactly like delta.intel, one map entry per item id,
  //   replacing the whole rating block. Replacement (not merge) is what makes
  //   a ratings refresh mean anything: a rating is a reading taken on a date,
  //   and half of last month's reading mixed with half of this month's is a
  //   number nobody took. Re-applying the SAME rating therefore replaces it
  //   and counts as applied, not skipped: ratingsSkipped counts only ids the
  //   merged guide does not have.
  // - city, city.dates and every other field of every existing item are never
  //   touched. intel and rating are the only two fields an existing item can
  //   gain here.
  var DELTA_STATUSES = ['plan', 'backup'];
  var DELTA_STATUS_HINT = ' (a delta may only add plan or backup items)';

  function emptyDeltaSummary() {
    return { added: 0, skipped: 0, sectionsAdded: 0, intelApplied: 0, intelSkipped: 0,
      ratingsApplied: 0, ratingsSkipped: 0 };
  }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function mergeDelta(cityData, delta) {
    var errors = [];
    if (!cityData || typeof cityData !== 'object' || Array.isArray(cityData)) {
      return { data: null, summary: emptyDeltaSummary(), errors: ['No city data to merge into'] };
    }
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
      return { data: null, summary: emptyDeltaSummary(), errors: ['Delta is not an object'] };
    }
    if (delta.schema !== 1) errors.push('schema must be 1');
    if (delta.delta !== true) {
      errors.push('delta must be true: this is a partial payload, not a whole guide');
    }

    // Sections first: a new item may legitimately reference a section this same
    // delta introduces, so the allowed-section set has to include them.
    var newSections = [];
    if (delta.sections !== undefined && delta.sections !== null) {
      if (!Array.isArray(delta.sections)) {
        errors.push('sections must be an array');
      } else {
        delta.sections.forEach(function (s, i) {
          if (!s || typeof s !== 'object' || Array.isArray(s) || !s.id || !s.label) {
            errors.push('sections[' + i + '] needs id and label');
          } else {
            newSections.push(s);
          }
        });
      }
    }

    var secIds = Object.create(null);
    (Array.isArray(cityData.sections) ? cityData.sections : []).forEach(function (s) {
      if (s && s.id) secIds[s.id] = 1;
    });
    newSections.forEach(function (s) { secIds[s.id] = 1; });

    // Object.create(null) plus an own-property check, for the same reason the
    // intel/ratings lookup below uses them. This one was a plain {} until an
    // item id could come from a HUMAN typing a name: "Constructor" slugs to
    // "constructor", which every plain object inherits, so the item read as
    // already present and was counted as skipped rather than added. The delta
    // was reported as applied and nothing was added.
    var existingIds = Object.create(null);
    (Array.isArray(cityData.items) ? cityData.items : []).forEach(function (it) {
      if (it && it.id) existingIds[it.id] = 1;
    });

    var toAdd = [];
    var skipped = 0;
    if (delta.items !== undefined && delta.items !== null) {
      if (!Array.isArray(delta.items)) {
        errors.push('items must be an array');
      } else {
        var seen = Object.create(null);
        delta.items.forEach(function (it, i) {
          var ref = 'items[' + i + ']' + (it && it.id ? ' (' + it.id + ')' : '');
          var before = errors.length;
          validateItem(it, ref, secIds, seen, errors, DELTA_STATUSES, DELTA_STATUS_HINT);
          if (errors.length !== before) return;
          if (Object.prototype.hasOwnProperty.call(existingIds, it.id)) { skipped++; return; }
          toAdd.push(it);
        });
      }
    }

    var intelMap = null;
    if (delta.intel !== undefined && delta.intel !== null) {
      if (typeof delta.intel !== 'object' || Array.isArray(delta.intel)) {
        errors.push('intel must be an object keyed by item id');
      } else {
        intelMap = delta.intel;
        Object.keys(intelMap).forEach(function (id) {
          validateIntel(intelMap[id], 'intel["' + id + '"]:', errors);
        });
      }
    }

    var ratingsMap = null;
    if (delta.ratings !== undefined && delta.ratings !== null) {
      if (typeof delta.ratings !== 'object' || Array.isArray(delta.ratings)) {
        errors.push('ratings must be an object keyed by item id');
      } else {
        ratingsMap = delta.ratings;
        Object.keys(ratingsMap).forEach(function (id) {
          validateRating(ratingsMap[id], 'ratings["' + id + '"]:', errors);
        });
      }
    }

    if (errors.length) return { data: null, summary: emptyDeltaSummary(), errors: errors };

    var summary = emptyDeltaSummary();
    summary.skipped = skipped;
    var out = deepClone(cityData);
    if (!Array.isArray(out.sections)) out.sections = [];
    if (!Array.isArray(out.items)) out.items = [];

    // Same prototype-safe pair as existingIds above: a section id of
    // "constructor" would otherwise read as already present.
    var haveSec = Object.create(null);
    out.sections.forEach(function (s) { if (s && s.id) haveSec[s.id] = 1; });
    newSections.forEach(function (s) {
      if (Object.prototype.hasOwnProperty.call(haveSec, s.id)) return;
      haveSec[s.id] = 1;
      out.sections.push(deepClone(s));
      summary.sectionsAdded++;
    });

    toAdd.forEach(function (it) {
      var copy = deepClone(it);
      // Both fields belong to a later verification phase, never to a prompt.
      // An absent one is normalized to null so every item in the merged guide
      // has the same shape.
      if (copy.place_id === undefined) copy.place_id = null;
      if (copy.verified === undefined) copy.verified = null;
      out.items.push(copy);
      summary.added++;
    });

    // One id map for both passes. Object.create(null) plus an own-property
    // check is what closes the prototype-pollution vector a hostile delta
    // keyed "__proto__" would otherwise open (it would paint content onto
    // every card); the ratings map is held to the identical bar.
    if (intelMap || ratingsMap) {
      var byId = Object.create(null);
      out.items.forEach(function (it) { if (it && it.id) byId[it.id] = it; });
      if (intelMap) {
        Object.keys(intelMap).forEach(function (id) {
          if (!Object.prototype.hasOwnProperty.call(byId, id)) { summary.intelSkipped++; return; }
          byId[id].intel = deepClone(intelMap[id]);
          summary.intelApplied++;
        });
      }
      if (ratingsMap) {
        Object.keys(ratingsMap).forEach(function (id) {
          if (!Object.prototype.hasOwnProperty.call(byId, id)) { summary.ratingsSkipped++; return; }
          byId[id].rating = deepClone(ratingsMap[id]);
          summary.ratingsApplied++;
        });
      }
    }

    return { data: out, summary: summary, errors: [] };
  }

  // ---- Add one place by hand ----
  // Owner scenario, Aug 2026: "i was at dinner my first night, met a couple,
  // they highly recommended a restaurant, and i'd like to run it into the
  // system for consideration and comparison to our other options."
  //
  // Deliberately NOT a second way to write an item. This builds a one-item
  // DELTA in exactly the shape an AI pass returns, and the caller hands it to
  // mergeDelta like any other. So a hand-typed place goes through the same
  // validateItem, the same duplicate-id rule, the same prototype-safe merge
  // and the same plan/backup-only status restriction as everything else, and
  // there is still exactly one function in this file that adds an item to a
  // guide.
  //
  // The id is slugged from the name and suffixed until it is free, because a
  // human typing "Oda" twice means two restaurants far more often than it
  // means a mistake, and mergeDelta would silently SKIP the second one as an
  // existing id. A name that slugs to nothing at all (an all-Cyrillic or
  // all-Greek name, which this route through the Balkans will produce) falls
  // back to "place", which is ugly and unique, and the traveler never sees an
  // id anyway.
  var PLACE_ID_FALLBACK = 'place';

  // Telling a MAP link from a plain website, for the icon the card draws.
  // Matching on the HOST (with a leading-dot boundary) rather than anywhere in
  // the string is what stops "evil.example/?x=google.com/maps" being filed as
  // a map. Two shapes, because Google's share sheet hands out both: a host
  // that is a map and nothing else, and a host that is a map only on its map
  // PATH.
  var MAP_ONLY_HOST_RE = /^(maps\.[a-z0-9.-]+|maps\.app\.goo\.gl)$/;
  var MAP_PATH_HOST_RE = /(^|\.)(google\.[a-z.]+|goo\.gl|openstreetmap\.org|osm\.org|apple\.com)$/;
  var MAP_PATH_RE = /^\/(maps|place|local)(\/|\?|$)/;

  // 'map' | 'web' | null. null means "not something a browser can open as a
  // web page", which is the only case the Add-a-place form rejects: a tel: or
  // a bare "pizzarte" would both be accepted by safeHref (one is a real
  // scheme, the other is a relative URL) and neither is a research link.
  function researchLinkKind(raw) {
    var s = trimStr(raw);
    if (!s) return null;
    if (!safeHref(s)) return null;
    var probe = s.replace(/[\u0000-\u0020]/g, '');
    if (!/^https?:\/\//i.test(probe)) return null;
    var rest = probe.replace(/^https?:\/\//i, '');
    var cut = rest.search(/[\/?#]/);
    var host = (cut === -1 ? rest : rest.slice(0, cut)).toLowerCase();
    var path = cut === -1 ? '/' : rest.slice(cut);
    var at = host.lastIndexOf('@');        // strip any userinfo before the host
    if (at !== -1) host = host.slice(at + 1);
    var port = host.indexOf(':');
    if (port !== -1) host = host.slice(0, port);
    if (!host) return null;
    if (MAP_ONLY_HOST_RE.test(host)) return 'map';
    if (MAP_PATH_HOST_RE.test(host) && MAP_PATH_RE.test(path)) return 'map';
    return 'web';
  }

  function freePlaceId(cityData, name) {
    var taken = Object.create(null);
    (cityData && Array.isArray(cityData.items) ? cityData.items : []).forEach(function (it) {
      if (it && it.id) taken[it.id] = 1;
    });
    var base = slug(name) || PLACE_ID_FALLBACK;
    function free(id) { return !Object.prototype.hasOwnProperty.call(taken, id); }
    if (free(base)) return base;
    // Unbounded rather than capped at a few hundred. A capped loop needs a
    // fallback, the obvious fallback is a timestamp, and two adds inside one
    // millisecond would then produce the same id and mergeDelta would SKIP
    // the second one silently, which is precisely the failure this function
    // exists to prevent. Counting up cannot collide, and the loop is bounded
    // in practice by the number of items already in the guide.
    for (var n = 2; ; n++) {
      var cand = base + '-' + n;
      if (free(cand)) return cand;
    }
  }

  // Returns {delta, id, errors}. errors is the caller-facing list for the
  // things a FORM can get wrong (no name, no section, a section this city
  // does not have); everything else is left to mergeDelta, which is the one
  // that actually decides. delta is null whenever errors is non-empty.
  //
  // `note` is where the recommendation itself lands ("recommended by a couple
  // at dinner"), and it is also what the single-place research pass quotes
  // back to the AI, which is why it is plain free text and not a tag.
  function newPlaceDelta(cityData, fields) {
    var f = fields || {};
    var errors = [];
    var name = trimStr(f.name);
    var section = trimStr(f.section);
    var status = trimStr(f.status) || 'plan';
    var note = trimStr(f.note);
    var day = trimStr(f.day);
    // Optional research link (owner ask 2026-08-27: the single-place pass
    // "couldn't find info on Pizzarté"). A small independent restaurant with
    // no web presence is unsearchable by name; a Google Maps pin or the
    // place's own site is the one thing that makes it findable. It is stored
    // as a real links[] entry so the card renders it like any other link, and
    // it is quoted to Claude as a research hint (see buildPlacePassPrompt).
    var link = trimStr(f.link);
    var linkKind = link ? researchLinkKind(link) : null;
    if (link && !linkKind) {
      errors.push('That link is not a web address Nomadding can open. Paste a link starting with http:// or https://.');
    }
    if (!name) errors.push('A name is required.');
    var secIds = Object.create(null);
    (cityData && Array.isArray(cityData.sections) ? cityData.sections : []).forEach(function (s) {
      if (s && s.id) secIds[s.id] = 1;
    });
    if (!section) errors.push('Pick a section.');
    else if (!Object.prototype.hasOwnProperty.call(secIds, section)) {
      errors.push('This city has no section "' + section + '".');
    }
    if (DELTA_STATUSES.indexOf(status) === -1) {
      errors.push('A new place starts as plan or backup.');
    }
    if (day && !isIso(day)) errors.push('The day must be YYYY-MM-DD.');
    if (errors.length) return { delta: null, id: null, errors: errors };
    var id = freePlaceId(cityData, name);
    var item = { id: id, section: section, status: status, name: name, links: [] };
    if (linkKind) {
      // Labelled the way the guide's own generated links are, so the card's
      // link row reads the same whether the place came from Claude or from a
      // paste: an icon and a short word, not a raw URL.
      item.links.push({ kind: linkKind, label: linkKind === 'map' ? 'Map' : 'Website', href: link });
    }
    if (note) item.note = note;
    if (day) item.day = day;
    // Stamped so the card, the More sheet and the research prompt can all
    // tell a hand-typed place from a researched one without keeping a second
    // list somewhere. It is also the honest reason its card carries no rating
    // badge: nobody has looked it up yet.
    item.added_by = 'traveler';
    return { delta: { schema: 1, delta: true, items: [item] }, id: id, errors: [] };
  }

  // Icon-only controls (Phase 3, feature 5): `aria` is the accessible name and
  // title tooltip on every button; `label` is set ONLY on the destructive
  // Archive transition, where a visible text label stays alongside the icon
  // so a mistap is less likely. The `to` semantics are unchanged from the
  // original text-button version: only the presentation changed.
  var TRANSITIONS = {
    plan:     [{ to: 'done', icon: '✓', aria: 'Mark done' },
               { to: 'backup', icon: '↓', aria: 'Move to backup' },
               { to: 'archived', icon: '✕', aria: 'Archive', label: 'Archive' }],
    backup:   [{ to: 'plan', icon: '↑', aria: 'Promote to plan' },
               { to: 'archived', icon: '✕', aria: 'Archive', label: 'Archive' }],
    done:     [{ to: 'plan', icon: '↩', aria: 'Undo, back to plan' }],
    archived: [{ to: 'backup', icon: '↩', aria: 'Restore to backup' }]
  };

  // Phase 3: Today / Guide / Calendar. viewMode of null is a distinct sentinel
  // from any of the three named modes: it means "the traveler has never
  // explicitly chosen a view", which is what lets effectiveViewMode() pick
  // Today automatically for a guide whose stay covers today. The moment the
  // traveler taps any of the three tabs, setViewMode stamps one of the named
  // values and that explicit choice persists from then on, exactly like every
  // other per-device preference here.
  var VIEW_MODES = ['type', 'day', 'today'];

  function emptyState() {
    return { itemStatus: {}, itemDay: {}, itemTitle: {}, dayOrder: {}, dayItemOrder: {},
      sectionItemOrder: {},
      collapsedSections: {}, collapsedPlanDays: {}, viewMode: null, tab: null,
      pinned: [], archived: null,
      dataOverride: null, stayOverride: null, updated: null };
  }

  function normalizeState(st) {
    if (!st || typeof st !== 'object') return emptyState();
    st.itemStatus = st.itemStatus || {};
    st.itemDay = st.itemDay || {};
    st.dayOrder = st.dayOrder || {};
    // Per-item order WITHIN one Plan-tab day (see the dayItemOrder block
    // below). Absent in every state written before this feature shipped, so
    // it is filled in here exactly like the maps above: an old state simply
    // reads as "no day has been arranged by hand yet".
    st.dayItemOrder = st.dayItemOrder || {};
    // Per-item order WITHIN one section tab (Eat & Drink, Do, Services). The
    // mirror image of dayItemOrder: that one is keyed by date and spans every
    // section, this one is keyed by section and spans every date. Absent in
    // every state written before this feature shipped, filled in here the same
    // way, so an old state simply reads as "no section arranged by hand yet".
    st.sectionItemOrder = st.sectionItemOrder || {};
    st.collapsedSections = st.collapsedSections || {};
    // Phase 4: per-day collapse state for the Plan tab's "remaining days" list,
    // the same tri-state pattern as collapsedSections (explicit true/false
    // wins, absent falls back to a computed default). A separate map because
    // Plan groups by DATE across every section, not by section id.
    st.collapsedPlanDays = st.collapsedPlanDays || {};
    st.itemTitle = st.itemTitle || {};
    // The header highlights row's pinned item ids, in pin order (see the
    // PIN_CAP block). An ARRAY, so anything that is not one (absent in every
    // state written before this feature shipped, or garbage from a hand-edited
    // payload) resets to empty rather than being coerced: a half-understood
    // pin list is worth less than no pins at all, and re-pinning is one tap.
    // Deduped and capped here too, so a state that arrives over sync from a
    // build with a different cap can never render a five-chip row.
    st.pinned = pinnedIds(st);
    // Past-city override (see the archiveKit block below). Tri-state, and the
    // ONLY valid values are true, false and null: anything else (absent in
    // every state written before this shipped, or garbage off a hand-edited
    // payload) reads as null, which means "no override, decide from the
    // dates". Lives on the state object rather than the app store on purpose:
    // the state object is what syncs (city_state rows), so archiving Batumi
    // on the phone archives it on the laptop, while store.order and
    // store.active stay device-local the way they always have.
    if (st.archived !== true && st.archived !== false) st.archived = null;
    // null always means "unset" and is left alone (see VIEW_MODES comment
    // above). A value that is present but neither null nor one of the three
    // named modes (a stray "bogus" string, or garbage from an old build) is
    // corrected to 'type' rather than silently reset to "unset": the state
    // object DID carry an opinion, it was just not a valid one.
    if (st.viewMode !== null && VIEW_MODES.indexOf(st.viewMode) === -1) {
      st.viewMode = Object.prototype.hasOwnProperty.call(st, 'viewMode') ? 'type' : null;
    }
    // Phase 4: which of the five tabs is active. Same "null means never
    // chosen" convention as viewMode, except there is no auto-detection here
    // (effectiveTab() just falls back to 'plan', the fixed default landing
    // tab): a present-but-invalid value is corrected to 'plan' rather than
    // left to silently misbehave.
    if (Object.prototype.hasOwnProperty.call(st, 'tab')) {
      if (st.tab !== null && TAB_IDS.indexOf(st.tab) === -1) st.tab = 'plan';
    } else {
      st.tab = null;
    }
    if (!('dataOverride' in st)) st.dataOverride = null;
    if (!('stayOverride' in st)) st.stayOverride = null;
    return st;
  }

  function makeStore(id, storage) {
    var key = 'cityops.' + id + '.v1';
    var mem = null;
    var ok = true;
    if (!storage) ok = false;
    try {
      storage.setItem(key + '.t', '1');
      storage.removeItem(key + '.t');
    } catch (e) { ok = false; }
    return {
      persistent: ok,
      load: function () {
        if (mem) return normalizeState(JSON.parse(JSON.stringify(mem)));
        if (!ok) return emptyState();
        try {
          var raw = storage.getItem(key);
          return raw ? normalizeState(JSON.parse(raw)) : emptyState();
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

  // Every one of the per-item state maps is a plain object, so a key that
  // Object.prototype already answers to reads back as an inherited function
  // instead of "not set". That was harmless while item ids came only from an
  // AI's generated slugs; it stopped being harmless the moment a traveler
  // could type a name and have it slugged into an id. "Constructor" is a
  // plausible bar name. Before this guard, its card's effectiveStatus was the
  // Object constructor, which matches none of plan/backup/done/archived, so
  // the item was written to the guide correctly and then rendered on no tab
  // at all. One reader for every such lookup, so the next map added cannot
  // reintroduce it.
  function ownProp(map, key) {
    return (map && Object.prototype.hasOwnProperty.call(map, key)) ? map[key] : undefined;
  }

  function effectiveStatus(it, state) {
    return ownProp(state.itemStatus, it.id) || it.status;
  }

  function effectiveDay(it, state) {
    if (state.itemDay && Object.prototype.hasOwnProperty.call(state.itemDay, it.id)) {
      return ownProp(state.itemDay, it.id) || null;
    }
    return it.day || null;
  }

  function setDay(state, id, iso) {
    if (iso !== null && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('bad day "' + iso + '"');
    state.itemDay[id] = iso;
    return state;
  }

  function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  function stayDates(dates) {
    var out = [];
    var d = new Date(dates.from + 'T12:00:00');
    var end = new Date(dates.to + 'T12:00:00');
    while (d <= end && out.length < 60) {
      var m = d.getMonth() + 1;
      var day = d.getDate();
      out.push(d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day);
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function effectiveData(base, state) {
    if (state.dataOverride && !validate(state.dataOverride).length) return state.dataOverride;
    return base;
  }

  function effectiveDates(data, state) {
    var o = state.stayOverride;
    if (o && isIso(o.from) && isIso(o.to) && o.from <= o.to) return o;
    return data.city.dates;
  }

  function effectiveName(it, state) {
    return ownProp(state.itemTitle, it.id) || it.name;
  }

  function setTitle(state, id, title) {
    state.itemTitle = state.itemTitle || {};
    var t = (title === null || title === undefined) ? '' : String(title).replace(/^\s+|\s+$/g, '');
    if (t) state.itemTitle[id] = t;
    else delete state.itemTitle[id];
    return state;
  }

  function setViewMode(state, mode) {
    if (VIEW_MODES.indexOf(mode) === -1) throw new Error('bad view mode "' + mode + '"');
    state.viewMode = mode;
    return state;
  }

  // Local (not UTC) YYYY-MM-DD for "today", so a stay's from/to (also local
  // calendar dates) compare correctly. nowMs is an injection point for tests;
  // real callers omit it and get the device's actual clock.
  function todayIso(nowMs) {
    var d = (typeof nowMs === 'number') ? new Date(nowMs) : new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function addDaysIso(iso, n) {
    var d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  // ---- Sunset (pure, no network, no timezone database) ----
  // The header's one automatic highlight. Owner ask, Aug 2026: "add a few
  // highlights to the header ... example: sunset time". A traveler on the
  // ground plans the evening around it, and a guide that already knows where
  // the city is should not need a network round trip to answer it.
  //
  // NOAA's solar position algorithm, the same one the NOAA Solar Calculator
  // publishes, at the standard sunset zenith of 90.833 degrees (0.833 being
  // atmospheric refraction plus the sun's own apparent radius, which is why
  // sunset is the moment the sun's UPPER limb touches the horizon, not its
  // centre). Two passes: the first locates sunset roughly so the second can
  // evaluate the sun's declination and the equation of time AT sunset rather
  // than at midnight, which is worth about a minute in late summer.
  //
  // Verified against api.met.no (the Norwegian Meteorological Institute's
  // sunrise API) for all four of this repo's cities plus an equinox, a
  // solstice, a southern-hemisphere case and a polar case: agreement is
  // within one minute everywhere, which is NOAA's own stated accuracy below
  // 72 degrees of latitude. See tests/run.js for the table.
  var SUNSET_ZENITH = 90.833;
  function degToRad(d) { return d * Math.PI / 180; }
  function radToDeg(r) { return r * 180 / Math.PI; }

  // Julian Day at 00:00 UTC of a YYYY-MM-DD, by the standard Gregorian
  // formula. Deliberately arithmetic rather than Date-based: a Date would
  // drag the device's timezone into a calculation that has no business
  // knowing it, and this same function has to give the same answer on a
  // phone in Tirana and a laptop in Denver.
  function julianDayUtc(iso) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
    if (m <= 2) { y -= 1; m += 12; }
    var a = Math.floor(y / 100);
    var b = 2 - a + Math.floor(a / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + b - 1524.5;
  }
  function julianCentury(jd) { return (jd - 2451545) / 36525; }

  // Obliquity of the ecliptic, corrected for nutation. Shared by the
  // declination and the equation of time, which is why it is its own step.
  function obliquityCorrected(t) {
    var e0 = 23 + (26 + ((21.448 - t * (46.815 + t * (0.00059 - t * 0.001813)))) / 60) / 60;
    return e0 + 0.00256 * Math.cos(degToRad(125.04 - 1934.136 * t));
  }
  function geomMeanLongSun(t) {
    var l = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    return l < 0 ? l + 360 : l;
  }
  function geomMeanAnomalySun(t) { return 357.52911 + t * (35999.05029 - 0.0001537 * t); }
  function earthOrbitEccentricity(t) { return 0.016708634 - t * (0.000042037 + 0.0000001267 * t); }

  // Minutes by which apparent solar time runs ahead of mean solar time.
  // Around 4 minutes fast in late August, which is exactly the size of error
  // a naive "noon plus half the day length" sunset would carry.
  function equationOfTime(t) {
    var y = Math.tan(degToRad(obliquityCorrected(t)) / 2);
    y = y * y;
    var l0 = degToRad(geomMeanLongSun(t));
    var m = degToRad(geomMeanAnomalySun(t));
    var e = earthOrbitEccentricity(t);
    var v = y * Math.sin(2 * l0) - 2 * e * Math.sin(m) + 4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) - 1.25 * e * e * Math.sin(2 * m);
    return radToDeg(v) * 4;
  }

  function sunDeclination(t) {
    var m = geomMeanAnomalySun(t);
    var c = Math.sin(degToRad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
      Math.sin(degToRad(2 * m)) * (0.019993 - 0.000101 * t) +
      Math.sin(degToRad(3 * m)) * 0.000289;
    var apparent = geomMeanLongSun(t) + c - 0.00569 -
      0.00478 * Math.sin(degToRad(125.04 - 1934.136 * t));
    return radToDeg(Math.asin(Math.sin(degToRad(obliquityCorrected(t))) *
      Math.sin(degToRad(apparent))));
  }

  // Half the sun's arc above the sunset altitude, in degrees. null when the
  // sun never reaches that altitude in either direction: midnight sun and
  // polar night both land here, and both mean "this city has no sunset today",
  // which is a real answer rather than an error.
  function sunsetHourAngle(lat, decl) {
    var x = Math.cos(degToRad(SUNSET_ZENITH)) /
      (Math.cos(degToRad(lat)) * Math.cos(degToRad(decl))) -
      Math.tan(degToRad(lat)) * Math.tan(degToRad(decl));
    if (!(x >= -1 && x <= 1)) return null;
    return radToDeg(Math.acos(x));
  }

  // Sunset as MINUTES AFTER 00:00 UTC on the given date, or null where there
  // is no sunset. Can legitimately fall outside 0..1440 (a far-eastern city's
  // sunset belongs to the previous UTC day, a far-western one to the next);
  // callers add it to a UTC midnight Date and let that normalize.
  //
  // Longitude is EAST-positive here, the sign convention every one of this
  // repo's city files uses. NOAA's own published JavaScript is west-positive,
  // so the two differ by a sign on lng and this is the one place worth saying
  // so out loud.
  function sunsetUtcMinutes(iso, lat, lng) {
    if (!isIso(iso)) return null;
    if (typeof lat !== 'number' || !isFinite(lat) || lat < -90 || lat > 90) return null;
    if (typeof lng !== 'number' || !isFinite(lng) || lng < -180 || lng > 180) return null;
    var jd = julianDayUtc(iso);
    var t = julianCentury(jd);
    var ha = sunsetHourAngle(lat, sunDeclination(t));
    if (ha === null) return null;
    var mins = 720 - 4 * lng - equationOfTime(t) + 4 * ha;
    // Second pass at the sunset instant itself, not at UTC midnight.
    var t2 = julianCentury(jd + mins / 1440);
    ha = sunsetHourAngle(lat, sunDeclination(t2));
    if (ha === null) return null;
    return 720 - 4 * lng - equationOfTime(t2) + 4 * ha;
  }

  // Where the city IS, for sunset purposes only, at city scale: two venues on
  // opposite sides of Tirana differ by under two seconds of sunset, so any
  // point inside the city is as good as any other. Two sources, in order:
  //
  //   1. city.accommodation.lat/lng, which Batumi, Yerevan and Ksamil carry.
  //   2. the first item holding meta.coords, which is how Tirana's real guide
  //      carries the same fact (its apartment item does, its city block does
  //      not). Without this fallback the one city the owner is standing in
  //      would be the one city with no sunset chip.
  //
  // The city's own UTC offset in MINUTES, from an optional `city.utc_offset`,
  // or null when the city does not state one.
  //
  // A fixed number rather than a zone name, and that is defensible precisely
  // because a CityOps city is one stay: a week in Tiranë is entirely inside
  // CEST, a week in Batumi entirely inside Georgia's year-round UTC+4. A stay
  // that straddled a DST changeover would be off by an hour on the far side
  // of it, which is the one case worth knowing about and is not one this
  // route has. Shipping the IANA database to avoid it would cost more than
  // the whole app.
  //
  // Without it the chip falls back to the DEVICE clock, which is right in the
  // case the feature exists for (a traveler standing in the city) and wrong
  // when a guide for somewhere else is opened from home. That fallback is why
  // this is optional rather than required: a guide generated by someone
  // else's AI pass still gets a sunset, it just gets the reader's clock.
  // WHOLE minutes, and that check is not pedantry: 5.5 is what someone writes
  // for India or Nepal while thinking in hours, and a fractional offset came
  // out of the formatter below as a chip reading "17:00.5". A value that is
  // not a whole number of minutes is a value whose author meant something
  // else, so it is refused and the device clock takes over, which at least
  // says whose clock it is.
  function cityUtcOffsetMinutes(data) {
    var v = (data && data.city) ? data.city.utc_offset : undefined;
    if (typeof v !== 'number' || !isFinite(v)) return null;
    if (Math.floor(v) !== v) return null;
    if (v < -840 || v > 840) return null;   // the real world spans UTC-12..+14
    return v;
  }

  // null when neither exists, and the caller then omits the chip rather than
  // guessing a location from the country name.
  function cityLatLng(data) {
    function ok(lat, lng) {
      return typeof lat === 'number' && isFinite(lat) && lat >= -90 && lat <= 90 &&
        typeof lng === 'number' && isFinite(lng) && lng >= -180 && lng <= 180;
    }
    var c = (data && data.city) ? data.city : null;
    var acc = c && c.accommodation;
    if (acc && ok(acc.lat, acc.lng)) return { lat: acc.lat, lng: acc.lng };
    var items = (data && Array.isArray(data.items)) ? data.items : [];
    for (var i = 0; i < items.length; i++) {
      var co = items[i] && items[i].meta && items[i].meta.coords;
      if (co && ok(co.lat, co.lng)) return { lat: co.lat, lng: co.lng };
    }
    return null;
  }

  // Pure decision for which of the three views to show when the traveler has
  // never explicitly picked one (state.viewMode === null, see the VIEW_MODES
  // comment above): Today when the device's today falls inside the stay
  // (adjusted dates if any), Guide otherwise. An explicit prior choice always
  // wins, even if the date no longer supports it: this only ever fires once,
  // on a state that has never had a view chosen.
  function effectiveViewMode(data, state, nowIso) {
    if (state.viewMode === 'type' || state.viewMode === 'day' || state.viewMode === 'today') return state.viewMode;
    var now = nowIso || todayIso();
    var range = effectiveDates(data, state);
    return (now >= range.from && now <= range.to) ? 'today' : 'type';
  }

  function keyForDisplayedDate(data, state, secId, iso) {
    // Pickers speak in DISPLAYED dates. After reorders, the group occupying
    // the slot for a date may be keyed by a different date; joining a day
    // means joining whatever group the user SEES on that date.
    var sv = null;
    viewModel(data, state).forEach(function (v) { if (v.section.id === secId) sv = v; });
    if (sv) {
      for (var i = 0; i < sv.days.length; i++) {
        if (sv.days[i].iso === iso) return sv.days[i].key;
      }
    }
    return iso;
  }

  // The pure model behind the per-item day picker: every date of the stay,
  // each carrying the section slot key a move would actually write (the same
  // keyForDisplayedDate indirection the picker has always used), plus a
  // `current` flag on the date this item already sits on.
  //
  // `current` exists so the renderer can take that one date OUT of the tap
  // targets. Tapping the day you are already on is an action that cannot
  // succeed: it rewrites the same value, re-renders, and looks exactly like
  // a control that did nothing. On a phone, where there is no hover tooltip
  // to explain the icon in the first place, one such no-op tap is enough to
  // conclude the whole feature is broken. Matching on KEY (not iso) is
  // deliberate: after a slot reorder an item's stored day-key can differ
  // from the date it renders under, and "the day you are on" means the one
  // you SEE it under.
  function dayMoveOptions(data, state, it) {
    var cur = effectiveDay(it, state);
    var currentIso = null;
    var options = stayDates(effectiveDates(data, state)).map(function (iso) {
      var key = keyForDisplayedDate(data, state, it.section, iso);
      var isCurrent = !!cur && key === cur;
      if (isCurrent) currentIso = iso;
      return { iso: iso, label: dayLabel(iso), key: key, current: isCurrent };
    });
    return {
      options: options,
      currentIso: currentIso,
      currentLabel: currentIso ? dayLabel(currentIso) : null,
      hasDay: !!cur
    };
  }

  function calendarModel(data, state) {
    var byIso = {};
    var undated = [];
    var vms = viewModel(data, state);
    vms.forEach(function (sv) {
      sv.days.forEach(function (d) {
        if (!byIso[d.iso]) byIso[d.iso] = [];
        d.items.forEach(function (it) {
          byIso[d.iso].push({ sec: sv.section, it: it, status: effectiveStatus(it, state) });
        });
      });
      sv.undated.forEach(function (it) {
        undated.push({ sec: sv.section, it: it, status: effectiveStatus(it, state) });
      });
    });
    var isos = Object.keys(byIso).sort();
    return {
      days: isos.map(function (iso) { return { iso: iso, label: dayLabel(iso), entries: byIso[iso] }; }),
      undated: undated,
      sections: vms
    };
  }

  // A guide's "open tasks" home, if it has one: a section whose id or label
  // marks it as a task/to-do list (Tirana's real guide calls it "tasks" /
  // "Open items": packing, errands, "book the train", never a place to eat
  // or see). Matched loosely (id or label containing "task") rather than a
  // single fixed id, since schema v1 does not reserve a section id for this;
  // most guides have no such section at all, and that is fine: todayModel's
  // tasks bucket is simply empty for them, not filled with every undated
  // restaurant recommendation in the guide.
  function isTaskSection(sec) {
    return !!sec && (sec.id === 'tasks' || /task/i.test(sec.label || ''));
  }

  // ---- Phase 4: tabs (Plan / Eat & Drink / Do / Services / Info) ----
  // Replaces the Today/Guide/Calendar view switch with five fixed tabs. A
  // section maps to exactly one tab; the mapping has to work for BOTH data
  // shapes seen in the wild: the PROMPT.md schema (dinner, breakfast, lunch,
  // coffee, cowork, activities, services, practical, interests) and the
  // freeform sections a traveler's own AI pass invents (Tirana's real guide:
  // base, money, transport, itinerary, restaurants, coffee, bars, activities,
  // services, laundry, safety, logistics, context, corrections, tasks).
  var TABS = [
    { id: 'plan', label: 'Plan' },
    { id: 'eat', label: 'Eat & Drink' },
    { id: 'do', label: 'Do' },
    { id: 'services', label: 'Services' },
    { id: 'info', label: 'Info' }
  ];
  var TAB_IDS = TABS.map(function (t) { return t.id; });

  var EAT_SECTION_IDS = ['dinner', 'breakfast', 'lunch', 'coffee', 'restaurants', 'bars'];
  var DO_SECTION_IDS = ['activities', 'interests'];
  // cowork moved here from EAT_SECTION_IDS (owner decision 2026-08-26).
  // A coworking space is a nomad utility, not a meal: filing it under Eat &
  // Drink put "day pass, 1500 ALL, fast wifi" between two dinner cards. A
  // sixth tab was the alternative and it loses: five tab chips plus the More
  // control already fill a 390px row, so Services becomes the utilities tab
  // (laundry, barber, coworking) rather than the tab bar growing.
  var SERVICE_SECTION_IDS = ['services', 'laundry', 'cowork'];
  // Info's own explicit ids are checked BEFORE the generic services keyword
  // fallback below, on purpose: Tirana's real "safety" section is labeled
  // "Health & safety", and a naive keyword match on "health" would misfile a
  // reference section as a services listing. Known ids always win; the
  // keyword fallback only fires for a section this list has never heard of.
  var INFO_SECTION_IDS = ['base', 'money', 'transport', 'safety', 'practical', 'logistics', 'context', 'corrections'];
  var SERVICE_KEYWORD_RE = /service|laundry|health|beauty|barber|massage/;

  function tabForSection(sec) {
    if (!sec) return 'info';
    var id = String(sec.id || '').toLowerCase();
    var label = String(sec.label || '').toLowerCase();
    if (isTaskSection(sec)) return 'plan';
    if (id === 'itinerary' || /itinerary|daily.?plan/.test(label)) return 'plan';
    if (EAT_SECTION_IDS.indexOf(id) !== -1) return 'eat';
    if (DO_SECTION_IDS.indexOf(id) !== -1) return 'do';
    if (SERVICE_SECTION_IDS.indexOf(id) !== -1) return 'services';
    if (INFO_SECTION_IDS.indexOf(id) !== -1) return 'info';
    if (SERVICE_KEYWORD_RE.test(id) || SERVICE_KEYWORD_RE.test(label)) return 'services';
    return 'info'; // fallback bucket: an unrecognized section is reference, not a todo
  }

  function setTab(state, tabId) {
    if (TAB_IDS.indexOf(tabId) === -1) throw new Error('bad tab "' + tabId + '"');
    state.tab = tabId;
    return state;
  }

  // Plan is the fixed default landing tab: unlike the old viewMode, there is
  // no date-based auto-detection here (Plan's own Today block already covers
  // that).
  function effectiveTab(state) {
    return (state && state.tab && TAB_IDS.indexOf(state.tab) !== -1) ? state.tab : 'plan';
  }

  // ---- Per-day collapse in the Plan tab's day list ----
  // Same tri-state read as isSectionCollapsed: an explicit override wins,
  // otherwise a computed default. That default was a flat "expanded" from
  // 2026-08-25 (owner feedback: every day open on page load), and it now has
  // one exception, below. The traveler's own explicit choice still sticks
  // either way, which is what collapsedPlanDays persists.

  // A day the traveler has finished with, and which is behind them.
  // Owner ask 2026-08-27: "auto-collapse past days when all activities have
  // been accomplished". Three conditions, all of them required:
  //   - the day is STRICTLY before today. Today and every day ahead stay
  //     expanded whatever their contents, because the point of the Plan tab
  //     is what is still coming.
  //   - it has at least one item. An empty past day has nothing to
  //     congratulate you for, and a header reading "0 done" is worse than the
  //     empty group it replaced.
  //   - every one of those items is settled: done, or archived. (Day groups
  //     drop archived items today, so in practice this reads "all done"; the
  //     archived arm is there so the rule stays true if that ever changes,
  //     rather than quietly meaning something different.)
  // `entries` are planModel's per-day rows, each {sec, it, status}.
  function planDayAutoCollapsed(iso, entries, todayIsoStr) {
    if (!iso || !todayIsoStr || iso >= todayIsoStr) return false;
    var list = Array.isArray(entries) ? entries : [];
    if (!list.length) return false;
    for (var i = 0; i < list.length; i++) {
      var s = list[i] && list[i].status;
      if (s !== 'done' && s !== 'archived') return false;
    }
    return true;
  }

  function planDayDoneCount(entries) {
    var n = 0;
    (Array.isArray(entries) ? entries : []).forEach(function (e) {
      if (e && (e.status === 'done' || e.status === 'archived')) n++;
    });
    return n;
  }

  // Tri-state read, same shape as isSectionCollapsed: the traveler's own
  // explicit choice always wins, and absent falls back to the computed
  // default. `auto` is that default (planDayAutoCollapsed above); omitting it
  // keeps the old behaviour of "expanded", which is what every caller that
  // does not group by date wants.
  function isPlanDayCollapsed(state, iso, auto) {
    var explicit = ownProp(state.collapsedPlanDays, iso);
    if (explicit === true || explicit === false) return explicit;
    return auto === true;
  }

  // Toggling back to whatever the default currently is DELETES the override
  // rather than writing it, so collapsedPlanDays only ever holds genuine
  // departures. That matters more now than it did when the default was always
  // "expanded": a past day the traveler expanded by hand keeps a stored false
  // (it is a real departure), but re-collapsing it lets the auto rule own it
  // again, so finishing one more item on an older day still folds it away.
  function togglePlanDay(state, iso, auto) {
    state.collapsedPlanDays = state.collapsedPlanDays || {};
    var next = !isPlanDayCollapsed(state, iso, auto);
    if (next === (auto === true)) delete state.collapsedPlanDays[iso];
    else state.collapsedPlanDays[iso] = next;
    return state;
  }

  // "Put this day on screen", used by the two places that must show a card
  // sitting on a folded day (a highlight-chip reveal, and a drop onto a
  // collapsed day). Not togglePlanDay: on an auto-collapsed day a toggle that
  // deletes the override would leave the day folded again on the next render,
  // which is exactly the invisible-result failure both callers exist to avoid.
  function expandPlanDay(state, iso, auto) {
    state.collapsedPlanDays = state.collapsedPlanDays || {};
    if (auto === true) state.collapsedPlanDays[iso] = false;
    else delete state.collapsedPlanDays[iso];
    return state;
  }

  // ---- Plan tab: the order of the items INSIDE one day ----
  // state.dayItemOrder maps a DISPLAYED date to the item ids sitting on it, in
  // the order the traveler dragged them into. Keyed by date, not by a
  // section's day-key, because the Plan tab groups by date ACROSS sections: a
  // real Tirana Monday mixes a cowork block, a nail appointment, a barber and
  // a dinner, and the order that matters is the order of the DAY, not the
  // order of any one section. (state.dayOrder, the older map, is a different
  // thing entirely: it arranges whole day SLOTS inside one section.)
  //
  // Not baked into buildExport on purpose; see the note there.
  function dayItemOrderFor(state, iso) {
    var m = state && state.dayItemOrder;
    var list = (m && Object.prototype.hasOwnProperty.call(m, iso)) ? m[iso] : null;
    return Array.isArray(list) ? list : [];
  }

  // Pure. `entries` are one day's {sec, it, status} rows in their default
  // order (section order, then the guide's own item order); `order` is that
  // day's saved id list. Ids the saved order names come first, in that order;
  // anything it has never heard of (an item just assigned to this day from
  // another tab, or a brand new guide item) keeps its default position at the
  // end rather than jumping to the top.
  //
  // Ids in `order` that are not on this day are ignored, not pruned: an item
  // dragged away, deleted from the guide, or archived leaves its id behind,
  // and a day the traveler arranged weeks ago must not lose that arrangement
  // because one of its items left. Stale ids cost one array scan and nothing
  // else.
  // Where an item sits in its day, as minutes-of-day, derived ONLY from the
  // `when` field (never the note or hours text: those describe the venue's
  // schedule, not the traveler's). An explicit clock time in `when` wins
  // ("leave 08:45" -> 525); otherwise the daypart word maps to a nominal
  // hour: am/morning/breakfast 09:00, midday/lunch/noon 12:00, unknown
  // 13:00 (mid-afternoon default keeps unhinted items between lunch and
  // the evening), pm/afternoon 15:00, eve/evening/dinner/night 19:30.
  var DAYPART_RANKS = [
    { re: /\b(?:am|morning|breakfast)\b/, min: 540 },
    { re: /\b(?:midday|lunch|noon)\b/, min: 720 },
    { re: /\b(?:pm|afternoon)\b/, min: 900 },
    { re: /\b(?:eve|evening|dinner|night|sunset)\b/, min: 1170 }
  ];

  function whenClock(when) {
    if (typeof when !== 'string' || !when) return 780;
    var w = when.toLowerCase();
    var t = w.match(/\b(\d{1,2}):(\d{2})\b/);
    if (t) {
      var h = parseInt(t[1], 10);
      var m = parseInt(t[2], 10);
      if (h >= 0 && h < 24 && m >= 0 && m < 60) return h * 60 + m;
    }
    for (var i = 0; i < DAYPART_RANKS.length; i++) {
      if (DAYPART_RANKS[i].re.test(w)) return DAYPART_RANKS[i].min;
    }
    return 780;
  }

  function orderDayItems(entries, order) {
    var list = entries || [];
    // The DEFAULT order of a day is chronological: a stable sort on the
    // items' whenClock, so AM coffee precedes the PM work block precedes
    // the Eve table. A custom drag order (below) still overrides entirely;
    // this only decides where things sit before the traveler rearranges.
    var indexed = (entries || []).map(function (e, i) { return { e: e, i: i }; });
    indexed.sort(function (a, b) {
      var ca = whenClock(a.e.it && a.e.it.when);
      var cb = whenClock(b.e.it && b.e.it.when);
      return ca === cb ? a.i - b.i : ca - cb;
    });
    list = indexed.map(function (x) { return x.e; });
    var out;
    if (!order || !order.length || list.length < 2) {
      out = list.slice();
    } else {
      var byId = Object.create(null);
      list.forEach(function (e) { byId[e.it.id] = e; });
      out = [];
      var taken = Object.create(null);
      order.forEach(function (id) {
        if (Object.prototype.hasOwnProperty.call(byId, id) && !taken[id]) {
          taken[id] = 1;
          out.push(byId[id]);
        }
      });
      list.forEach(function (e) { if (!taken[e.it.id]) out.push(e); });
    }
    // Done items sink to the bottom of their day so the top of a day is
    // always what is still to do. The partition is stable on both sides:
    // drag order is preserved within each band, and un-marking done returns
    // an item to its ordered place among the active ones.
    var active = [];
    var done = [];
    out.forEach(function (e) { (e.status === 'done' ? done : active).push(e); });
    return active.concat(done);
  }

  // Writes one day's arrangement. Duplicates and non-strings are dropped (a
  // DOM read is the caller in practice, and a duplicated id there would
  // silently drop an item from the day). An empty result deletes the key
  // rather than storing [], so dayItemOrder only ever holds real arrangements
  // and a day reset by hand goes back to the guide's own order.
  function setDayItemOrder(state, iso, ids) {
    if (!isIso(iso)) throw new Error('bad day "' + iso + '"');
    state.dayItemOrder = state.dayItemOrder || {};
    var clean = [];
    (ids || []).forEach(function (id) {
      if (typeof id === 'string' && id && clean.indexOf(id) === -1) clean.push(id);
    });
    if (clean.length) state.dayItemOrder[iso] = clean;
    else delete state.dayItemOrder[iso];
    return state;
  }

  // ---- Section tabs: the order of the items INSIDE one section ----
  // state.sectionItemOrder maps a section id to the item ids in it, in the
  // order the traveler dragged them into. Deliberately a separate key space
  // from dayItemOrder rather than a reuse of it: the two answer different
  // questions about the same item. dayItemOrder answers "what order does
  // Tuesday run in", across every section; this answers "what order do the
  // dinners read in", across every date. An item that is fourth on Tuesday
  // can perfectly well be first in Dinner, and one map cannot hold both.
  function sectionItemOrderFor(state, secId) {
    var m = state && state.sectionItemOrder;
    var list = (m && Object.prototype.hasOwnProperty.call(m, secId)) ? m[secId] : null;
    return Array.isArray(list) ? list : [];
  }

  // Same contract as setDayItemOrder: duplicates and non-strings dropped, an
  // empty result deletes the key so a section reset by hand goes back to the
  // chronological default rather than freezing whatever it looked like.
  function setSectionItemOrder(state, secId, ids) {
    if (typeof secId !== 'string' || !secId) throw new Error('bad section "' + secId + '"');
    state.sectionItemOrder = state.sectionItemOrder || {};
    var clean = [];
    (ids || []).forEach(function (id) {
      if (typeof id === 'string' && id && clean.indexOf(id) === -1) clean.push(id);
    });
    if (clean.length) state.sectionItemOrder[secId] = clean;
    else delete state.sectionItemOrder[secId];
    return state;
  }

  // Pure. `entries` are one section's {it, dayIso, status} rows in the guide's
  // own order; `order` is that section's saved id list. Three stages, the same
  // shape orderDayItems has, so the two tabs behave identically under the
  // hand:
  //   1. a chronological DEFAULT. A section spans the whole trip rather than
  //      one day, so dated items lead in date order (and within one date by
  //      whenClock, exactly as Plan orders that date), then the undated ones
  //      keep the guide's order: "sometime this trip" has no place on a
  //      timeline, and hoisting it to either end would be an invention.
  //   2. the traveler's own arrangement on top, ids it has never heard of
  //      keeping their default position at the end rather than jumping up.
  //   3. done items sunk to the bottom of the section, stable on both sides,
  //      so the top of a section is always what is still in play.
  function orderSectionItems(entries, order) {
    var indexed = (entries || []).map(function (e, i) { return { e: e, i: i }; });
    indexed.sort(function (a, b) {
      var da = a.e.dayIso || '';
      var db = b.e.dayIso || '';
      if (!da !== !db) return da ? -1 : 1;
      if (da && da !== db) return da < db ? -1 : 1;
      if (da) {
        var ca = whenClock(a.e.it && a.e.it.when);
        var cb = whenClock(b.e.it && b.e.it.when);
        if (ca !== cb) return ca - cb;
      }
      return a.i - b.i;
    });
    var list = indexed.map(function (x) { return x.e; });
    var out;
    if (!order || !order.length || list.length < 2) {
      out = list.slice();
    } else {
      var byId = Object.create(null);
      list.forEach(function (e) { byId[e.it.id] = e; });
      out = [];
      var taken = Object.create(null);
      order.forEach(function (id) {
        if (Object.prototype.hasOwnProperty.call(byId, id) && !taken[id]) {
          taken[id] = 1;
          out.push(byId[id]);
        }
      });
      list.forEach(function (e) { if (!taken[e.it.id]) out.push(e); });
    }
    var active = [];
    var done = [];
    out.forEach(function (e) { (e.status === 'done' ? done : active).push(e); });
    return active.concat(done);
  }

  // The Plan tab's model: today's day-assigned items (any section), every
  // other day of the stay in chronological order with whatever is assigned
  // to it (also any section: a dinner reservation and an itinerary stop both
  // count, exactly like todayModel), and the guide's open/done tasks. Built
  // on the same viewModel() every other view reads, so assigning an item to a
  // day from ANY tab shows up here immediately with no separate bookkeeping.
  // nowIso is an injection point for tests; real callers omit it.
  function planModel(data, state, nowIso) {
    var today = nowIso || todayIso();
    var vms = viewModel(data, state);
    var range = effectiveDates(data, state);
    var byIso = {};
    vms.forEach(function (sv) {
      sv.days.forEach(function (d) {
        if (!byIso[d.iso]) byIso[d.iso] = [];
        d.items.forEach(function (it) {
          byIso[d.iso].push({ sec: sv.section, it: it, status: effectiveStatus(it, state) });
        });
      });
    });
    var stayIsos = stayDates(range);
    var otherDays = stayIsos.filter(function (iso) { return iso !== today; }).map(function (iso) {
      var items = orderDayItems(byIso[iso] || [], dayItemOrderFor(state, iso));
      return { iso: iso, label: dayLabel(iso), items: items,
        // What the day header needs to render itself compactly when it folds:
        // how many of its items are settled, and whether it folds by default.
        done: planDayDoneCount(items),
        past: iso < today,
        auto: planDayAutoCollapsed(iso, items, today) };
    });
    // Three task buckets, one per outcome a task can reach: still open, done,
    // and declined. Declined is the EXISTING archived status, not a fourth
    // one: "we are not doing that" and "put it away" are the same fact about
    // an item, and giving them separate values would mean two ways to say it,
    // two things to migrate and two places for them to disagree. The Plan tab
    // is simply the one surface that reads archived tasks back out, since a
    // task section never renders in any other tab (tabForSection sends it
    // here), so before this bucket existed a declined task vanished.
    //
    // sv.undated holds only plan/backup/done items, so archived tasks are read
    // from sv.archived, which viewModel already separates out.
    var openTasks = [], doneTasks = [], declinedTasks = [];
    vms.forEach(function (sv) {
      if (!isTaskSection(sv.section)) return;
      sv.undated.forEach(function (it) {
        var s = effectiveStatus(it, state);
        if (s === 'plan') openTasks.push({ sec: sv.section, it: it, status: s });
        else if (s === 'done') doneTasks.push({ sec: sv.section, it: it, status: s });
      });
      // Every archived item in a task section lands here, dated or not. A
      // task carrying a day is unusual but possible (the traveler used Change
      // day on one), and filtering those out would make declining such a task
      // the one move in the app with no way back: the day groups drop archived
      // items, and no other tab renders a task section at all.
      sv.archived.forEach(function (it) {
        declinedTasks.push({ sec: sv.section, it: it, status: 'archived' });
      });
    });
    return {
      todayIso: today,
      inRange: today >= range.from && today <= range.to,
      // Today is a day like any other here: it is the one the traveler
      // rearranges most, so it reads its own saved order too.
      today: orderDayItems(byIso[today] || [], dayItemOrderFor(state, today)),
      days: otherDays,
      openTasks: openTasks,
      doneTasks: doneTasks,
      declinedTasks: declinedTasks
    };
  }

  // One day's computed collapse default, looked up through the same planModel
  // the renderer reads, so a caller that only has an iso in hand cannot get a
  // different answer from the one on screen.
  function planDayAutoFor(data, state, iso) {
    var pm = planModel(data, state);
    for (var i = 0; i < pm.days.length; i++) {
      if (pm.days[i].iso === iso) return !!pm.days[i].auto;
    }
    return false;
  }

  // Phase 3, feature 4: the "what matters today" view. Three buckets, all
  // sourced from the same viewModel() the Guide and Calendar views already
  // use, so a reorder or a status change shows up identically everywhere:
  //   - today: every active item whose displayed day is today, from any
  //     section (an itinerary stop and a dinner reservation both count).
  //   - tasks: active, UNDATED, status-plan items from the guide's tasks
  //     section (see isTaskSection above). NOT every undated recommendation
  //     in the guide: a 106-item guide has dozens of undated restaurant
  //     picks that are not to-dos, and dumping all of them into "Today"
  //     would recreate the very wall-of-cards problem this view exists to
  //     fix.
  //   - upNext: the same today-style bucket for tomorrow, kept small (no
  //     status controls are shown for it in the renderer) since it is a
  //     preview, not a worklist.
  // nowIso is an injection point for tests; real callers omit it.
  function todayModel(data, state, nowIso) {
    var today = nowIso || todayIso();
    var tomorrow = addDaysIso(today, 1);
    var vms = viewModel(data, state);
    var todays = [], tasks = [], upNext = [];
    vms.forEach(function (sv) {
      sv.days.forEach(function (d) {
        if (d.iso === today) {
          d.items.forEach(function (it) { todays.push({ sec: sv.section, it: it, status: effectiveStatus(it, state) }); });
        } else if (d.iso === tomorrow) {
          d.items.forEach(function (it) { upNext.push({ sec: sv.section, it: it, status: effectiveStatus(it, state) }); });
        }
      });
      if (isTaskSection(sv.section)) {
        sv.undated.forEach(function (it) {
          if (effectiveStatus(it, state) === 'plan') tasks.push({ sec: sv.section, it: it, status: 'plan' });
        });
      }
    });
    var range = effectiveDates(data, state);
    return {
      todayIso: today,
      inRange: today >= range.from && today <= range.to,
      today: todays, tasks: tasks, upNext: upNext
    };
  }

  // Phase 3, feature 2: large guides (the 106-item Tirana guide that prompted
  // this work) render as one endless column unless sections start collapsed.
  // `totalItems` is the GUIDE's total item count (data.items.length), not the
  // section's own count: "more than about 30 items" describes the whole
  // guide, so a small guide never auto-collapses even if all its items sit in
  // one section. The 'base' section is the one exception (it is small and
  // holds the accommodation, so it stays open by default regardless of guide
  // size). `totalItems` is optional so every existing caller (and the
  // existing unit test) that never passed it keeps the old small-guide
  // default of "open".
  // Owner feedback 2026-08-26: "default to all accordions be expanded on
  // default". So this now returns false for every section at every guide
  // size. The size-based auto-collapse it replaces was well meant (a 200-item
  // Tirana guide opened as a wall) but it hid content the traveler had asked
  // to see, and it made the SAME section behave differently in two cities for
  // reasons nobody could see on screen. The wall is answered instead by the
  // Collapse all link the section renderers now draw once per tab, which is a
  // choice the traveler makes and which sticks (it writes the same explicit
  // overrides a tap on one section header writes).
  //
  // The 30-item threshold constant is gone with it; a dead number sitting
  // here would read as "size-based collapse is still a thing". The two
  // ARGUMENTS stay: every caller still passes them, toggleSection still runs
  // its "back to the default" comparison through here, and nothing
  // downstream has to change if a future default ever depends on size again.
  function defaultSectionCollapsed(secId, totalItems) {
    return false;
  }

  // Expand all / Collapse all, as a pure state write. Explicit per-section
  // choices are what this sets: it goes through exactly the arithmetic
  // toggleSection uses, so "Expand all" (which now matches the default)
  // DELETES the overrides rather than writing a wall of `false`, and the map
  // only ever holds genuine departures from the default.
  function setSectionsCollapsed(state, secIds, collapsed, totalItems) {
    state.collapsedSections = state.collapsedSections || {};
    (Array.isArray(secIds) ? secIds : []).forEach(function (id) {
      if (!id) return;
      if (collapsed === defaultSectionCollapsed(id, totalItems)) delete state.collapsedSections[id];
      else state.collapsedSections[id] = !!collapsed;
    });
    return state;
  }

  // The Plan tab's twin of the above, over dates instead of section ids.
  // `autos` maps iso -> that day's computed default (planDayAutoCollapsed).
  // Without it every default is "expanded", which is exactly what this did
  // before past days could fold themselves away. With it, Expand all writes a
  // real `false` on a day that would otherwise re-collapse itself, so the link
  // does what it says on a stay whose first half is already behind you.
  function setPlanDaysCollapsed(state, isos, collapsed, autos) {
    state.collapsedPlanDays = state.collapsedPlanDays || {};
    (Array.isArray(isos) ? isos : []).forEach(function (iso) {
      if (!iso) return;
      var auto = !!(autos && Object.prototype.hasOwnProperty.call(autos, iso) && autos[iso]);
      if (!!collapsed === auto) delete state.collapsedPlanDays[iso];
      else state.collapsedPlanDays[iso] = !!collapsed;
    });
    return state;
  }

  // Tri-state read: an explicit true/false in collapsedSections always wins
  // (the traveler's own choice, remembered); absent falls back to the
  // computed default above.
  function isSectionCollapsed(state, secId, totalItems) {
    var explicit = ownProp(state.collapsedSections, secId);
    if (explicit === true || explicit === false) return explicit;
    return defaultSectionCollapsed(secId, totalItems);
  }

  // Flips the EFFECTIVE state (default included) and stores the result
  // explicitly, EXCEPT when the new value matches the computed default again,
  // in which case the key is dropped so collapsedSections only ever grows
  // with genuine overrides. That last case is also what keeps the original
  // small-guide test (`toggleSection(st, 'dinner')` collapses, toggling
  // again deletes the key) passing unchanged: with no totalItems, the
  // default is always "open", so toggling twice returns to no override.
  function toggleSection(state, secId, totalItems) {
    state.collapsedSections = state.collapsedSections || {};
    var next = !isSectionCollapsed(state, secId, totalItems);
    if (next === defaultSectionCollapsed(secId, totalItems)) delete state.collapsedSections[secId];
    else state.collapsedSections[secId] = next;
    return state;
  }

  // ---- Past cities (state.archived) ----
  // Owner ask 2026-08-26: "need the ability to archive cities previously
  // visited in cityops page (take cue from plan-ahead page)". The trip page
  // already groups stops you have left under one collapsed "Past" disclosure
  // and fades them; the city switcher does the same here.
  //
  // Three states, in the same tri-state shape collapsedSections uses:
  //   true   the traveler archived it by hand (early, before the dates ran out)
  //   false  the traveler kept it active by hand (its dates have passed but
  //          they are still using it, e.g. writing up a city after leaving)
  //   null   no opinion: decide from the stay's end date
  //
  // `isActive` is the one rule that overrides the DATE but never the
  // traveler: the city you are looking at right now does not slide into a
  // collapsed group under your cursor on the day your stay ends. An explicit
  // `true` still archives it, because that was a deliberate tap.
  function cityArchiveMode(state) {
    var v = state && state.archived;
    if (v === true) return 'archived';
    if (v === false) return 'active';
    return 'auto';
  }

  function setCityArchived(state, v) {
    state.archived = (v === true || v === false) ? v : null;
    return state;
  }

  // `dates` is the EFFECTIVE stay range ({from, to}), so a stayOverride the
  // traveler set in Edit dates is what this reads, not the shipped data.
  function cityIsPast(state, dates, todayIso, isActive) {
    var mode = cityArchiveMode(state);
    if (mode === 'archived') return true;
    if (mode === 'active') return false;
    if (isActive) return false;
    var to = dates && dates.to;
    if (typeof to !== 'string' || !to) return false;
    return to < String(todayIso || '');
  }

  // What one tap should do next, given where a city stands. Returned as a
  // named intent rather than a boolean so the switcher's control can label
  // itself from this and never offer an action that does nothing: a city
  // already in Past offers Restore, everything else offers Archive.
  function nextArchiveValue(state, dates, todayIso, isActive) {
    if (cityIsPast(state, dates, todayIso, isActive)) {
      // Restoring a city whose dates have genuinely passed needs the explicit
      // `false`, or the date rule would simply re-archive it on the next
      // render. Restoring one that is only archived by hand can go back to
      // 'auto', which keeps the state object free of overrides that say the
      // same thing the dates already say.
      var byDate = (dates && typeof dates.to === 'string' && dates.to < String(todayIso || ''));
      return (byDate && !isActive) ? false : null;
    }
    return true;
  }

  // ---- Pinned highlights (state.pinned) ----
  // Owner ask, Aug 2026: "add the ability to bump up specific info for
  // example, from the info tab, summarized for brevity". A pin promotes one
  // item into the header's highlights row as a short chip; tapping the chip
  // goes back to the full card.
  //
  // An ARRAY, not a map, and that is the whole design: the order the traveler
  // pinned things in is the order the row reads in, and a map would throw it
  // away. It rides the sync payload for free, like every other key on the
  // state object, and normalizeState fills it in for a state written before
  // this shipped (absent simply reads as "nothing pinned yet"), the same
  // upgrade path collapsedSections and dayItemOrder already use.
  //
  // The cap is four. One row that never wraps is the whole point of the
  // feature, a 390px phone fits about four chips of this size before the row
  // has to scroll sideways, and a highlights row you have to scroll to read
  // has stopped highlighting anything. At the cap the pin control on OTHER
  // cards is disabled and says why, rather than silently failing or silently
  // evicting the oldest pin.
  var PIN_CAP = 4;

  function pinnedIds(state) {
    var list = (state && Array.isArray(state.pinned)) ? state.pinned : [];
    var out = [];
    var seen = Object.create(null);
    list.forEach(function (id) {
      if (typeof id !== 'string' || !id) return;
      if (Object.prototype.hasOwnProperty.call(seen, id)) return;
      seen[id] = 1;
      out.push(id);
    });
    return out.slice(0, PIN_CAP);
  }

  function isPinned(state, id) { return pinnedIds(state).indexOf(id) !== -1; }

  // True when tapping the pin on this item would actually do something: an
  // already-pinned item can always be UNpinned, and an unpinned one only
  // while there is room. The UI reads this to disable and explain, never to
  // let a tap fail.
  function canTogglePin(state, id) {
    if (isPinned(state, id)) return true;
    return pinnedIds(state).length < PIN_CAP;
  }

  function togglePin(state, id) {
    var list = pinnedIds(state);
    var at = list.indexOf(id);
    if (at !== -1) list.splice(at, 1);
    else if (list.length < PIN_CAP) list.push(id);
    state.pinned = list;
    return state;
  }

  // The pinned items, in pin order, as they exist in the CURRENT data. An id
  // the guide no longer has is dropped rather than rendered as an empty chip
  // or treated as an error: a data update or an Enrich re-run can retire an
  // item under a pin, and the same forgiving rule mergeDelta uses for an
  // unknown intel id applies here.
  function pinnedItems(data, state) {
    var byId = Object.create(null);
    (data && Array.isArray(data.items) ? data.items : []).forEach(function (it) {
      if (it && it.id) byId[it.id] = it;
    });
    var out = [];
    pinnedIds(state).forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(byId, id)) out.push(byId[id]);
    });
    return out;
  }

  // The chip's whole visible text, from a name and a note. The Info tab's
  // real data decided the rules: its names are already short and punchy
  // ("Tap water", "Fares", "Pay in lek") and the substance lives in the note,
  // so a chip showing the name alone highlights nothing.
  //
  //   - the note is cut at its first sentence or ` · ` clause, because that
  //     is where these notes put the headline fact;
  //   - when that fragment already starts with the name (Tirana's "Fares" /
  //     "Fares rise ~5% after 22:00"), the name is dropped rather than
  //     stuttered back;
  //   - the result is capped at PIN_CHIP_MAX characters with a single-glyph
  //     ellipsis, and a name that alone fills most of the budget simply gets
  //     no note appended: below PIN_CHIP_MIN_CLAUSE characters of room the
  //     note contributes half a word and an ellipsis, which is noise wearing
  //     a separator.
  var PIN_CHIP_MAX = 44;
  var PIN_CHIP_MIN_CLAUSE = 12;

  function firstNoteClause(note) {
    var s = trimStr(note).replace(/\s+/g, ' ');
    if (!s) return '';
    var cut = s.length;
    var dot = s.search(/[.!?](\s|$)/);
    if (dot !== -1) cut = Math.min(cut, dot + 1);
    var mid = s.indexOf(' · ');
    if (mid !== -1) cut = Math.min(cut, mid);
    return s.slice(0, cut).replace(/[.\s]+$/, '');
  }

  function pinChipText(name, note) {
    var n = trimStr(name).replace(/\s+/g, ' ');
    var clause = firstNoteClause(note);
    var text = n;
    if (clause) {
      if (n && clause.toLowerCase().indexOf(n.toLowerCase()) === 0) text = clause;
      else if (!n) text = clause;
      else if (n.length + 3 + PIN_CHIP_MIN_CLAUSE <= PIN_CHIP_MAX) text = n + ' · ' + clause;
    }
    if (!text) return '';
    if (text.length <= PIN_CHIP_MAX) return text;
    return text.slice(0, PIN_CHIP_MAX - 1).replace(/[\s·]+$/, '') + '…';
  }

  function setStayDates(state, from, to) {
    if (!isIso(from) || !isIso(to)) throw new Error('dates must be YYYY-MM-DD');
    if (from > to) throw new Error('from must not be after to');
    state.stayOverride = { from: from, to: to };
    return state;
  }

  function viewModel(data, state) {
    return data.sections.map(function (sec) {
      var items = data.items.filter(function (it) { return it.section === sec.id; });
      var active = items.filter(function (it) {
        var s = effectiveStatus(it, state);
        return s === 'plan' || s === 'done';
      });
      var dayed = active.filter(function (it) { return effectiveDay(it, state); });
      var undated = active.filter(function (it) { return !effectiveDay(it, state); });
      // Day cards are SLOTS: the dates always render in chronological order, and
      // reordering moves a card's CONTENT into a different date slot. A card's
      // stable identity (key) is its group's effective day in the data; the date
      // it renders under (iso) is the chronological slot it currently occupies.
      // Sections with any dayed item get a slot for EVERY date in the stay, so
      // empty days are visible and are valid drag targets.
      var keys = [];
      dayed.forEach(function (it) {
        var d = effectiveDay(it, state);
        if (keys.indexOf(d) === -1) keys.push(d);
      });
      var range = null;
      if (keys.length) {
        range = effectiveDates(data, state);
        stayDates(range).forEach(function (d) { if (keys.indexOf(d) === -1) keys.push(d); });
      }
      var slots = keys.slice().sort();
      // Keys absent from the saved arrangement sit on their own date's slot;
      // arranged keys fill the remaining slots in saved order. Default (no
      // arrangement) is therefore content-on-its-own-date, and saved orders
      // from before empty slots existed keep content where the user left it.
      var stated = [];
      (ownProp(state.dayOrder, sec.id) || []).forEach(function (k) {
        if (keys.indexOf(k) !== -1 && stated.indexOf(k) === -1) stated.push(k);
      });
      var slotKey = {};
      keys.forEach(function (k) {
        if (stated.indexOf(k) === -1) slotKey[k] = k;
      });
      var si = 0;
      stated.forEach(function (k) {
        while (slotKey[slots[si]] !== undefined) si++;
        slotKey[slots[si]] = k;
      });
      return {
        section: sec,
        days: slots.map(function (iso) {
          var key = slotKey[iso];
          return {
            key: key, iso: iso, label: dayLabel(iso),
            outside: range ? (iso < range.from || iso > range.to) : false,
            items: dayed.filter(function (it) { return effectiveDay(it, state) === key; })
          };
        }),
        undated: undated,
        backups: items.filter(function (it) { return effectiveStatus(it, state) === 'backup'; }),
        archived: items.filter(function (it) { return effectiveStatus(it, state) === 'archived'; })
      };
    });
  }

  function shareModel(data, state) {
    // Share view uses the same slot-assigned dates the planner shows.
    var byDay = {};
    var undated = [];
    viewModel(data, state).forEach(function (sv) {
      sv.days.forEach(function (d) {
        d.items.forEach(function (it) {
          if (!byDay[d.iso]) byDay[d.iso] = [];
          byDay[d.iso].push({ sec: sv.section, it: it, status: effectiveStatus(it, state) });
        });
      });
      sv.undated.forEach(function (it) {
        undated.push({ sec: sv.section, it: it, status: effectiveStatus(it, state) });
      });
    });
    var isos = Object.keys(byDay).sort();
    return {
      days: isos.map(function (iso) { return { iso: iso, label: dayLabel(iso), entries: byDay[iso] }; }),
      undated: undated
    };
  }

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function fmtRange(d) {
    var a = new Date(d.from + 'T12:00:00');
    var b = new Date(d.to + 'T12:00:00');
    if (a.getMonth() === b.getMonth()) {
      return MONTHS[a.getMonth()] + ' ' + a.getDate() + '-' + b.getDate() + ', ' + b.getFullYear();
    }
    return MONTHS[a.getMonth()] + ' ' + a.getDate() + ' - ' + MONTHS[b.getMonth()] + ' ' + b.getDate() + ', ' + b.getFullYear();
  }

  // ---- multi-city app store (used by the app shell, not by standalone files) ----
  // Shape: { cities: {cityId: cityJson}, order: [cityId], active: cityId|null,
  //          updatedAt: {cityId: iso} }.
  // Pure helpers only: reading and writing localStorage stays in the app shell.
  //
  // updatedAt is the per-city stamp for city DATA (the pasted/blank JSON). Live
  // planning state has its own stamp inside the per-city state object (updated),
  // written by makeStore().save. Cities carried over from before M2 have no
  // stamp: they are backfilled with EPOCH so that a device with a real server
  // copy wins the reconcile, while a city that exists nowhere else still pushes
  // (EPOCH beats "no row at all"). See docs in .superpowers/sdd/m2-client-report.md.
  var EPOCH_ISO = '1970-01-01T00:00:00.000Z';

  function normalizeAppStore(raw) {
    var src = (raw && typeof raw === 'object') ? raw : {};
    var srcCities = (src.cities && typeof src.cities === 'object') ? src.cities : {};
    var cities = {};
    Object.keys(srcCities).forEach(function (id) {
      var d = srcCities[id];
      if (d && d.city && d.city.name && d.city.dates) cities[id] = d;
    });
    var order = [];
    var seen = {};
    (Array.isArray(src.order) ? src.order : []).forEach(function (id) {
      if (!seen[id] && Object.prototype.hasOwnProperty.call(cities, id)) { seen[id] = 1; order.push(id); }
    });
    Object.keys(cities).forEach(function (id) {
      if (!seen[id]) { seen[id] = 1; order.push(id); }
    });
    var active = (typeof src.active === 'string' && order.indexOf(src.active) !== -1)
      ? src.active : (order.length ? order[0] : null);
    var srcStamps = (src.updatedAt && typeof src.updatedAt === 'object') ? src.updatedAt : {};
    var updatedAt = {};
    order.forEach(function (id) {
      var v = srcStamps[id];
      updatedAt[id] = (typeof v === 'string' && v) ? v : EPOCH_ISO;
    });
    // The interest profile rides in the app store (one per user, not per city)
    // and is normalized on every load. Nothing else in the engine reads it: it
    // is handed to the prompt builders and pushed by the shell's sync layer.
    return { cities: cities, order: order, active: active, updatedAt: updatedAt, profile: normalizeProfile(src.profile) };
  }

  // iso: pass the REMOTE stamp when applying a pulled city, so the pull does not
  // look like a fresh local edit and immediately push back. Omit it for genuine
  // local edits (add/paste/replace/blank), which stamp now.
  function appAddCity(store, data, iso) {
    var s = normalizeAppStore(store);
    var id = cityId(data);
    var replaced = Object.prototype.hasOwnProperty.call(s.cities, id);
    s.cities[id] = data;
    if (s.order.indexOf(id) === -1) s.order.push(id);
    s.updatedAt[id] = (typeof iso === 'string' && iso) ? iso : new Date().toISOString();
    return { store: s, cityId: id, replaced: replaced };
  }

  function appRemoveCity(store, id) {
    var s = normalizeAppStore(store);
    delete s.cities[id];
    delete s.updatedAt[id];
    s.order = s.order.filter(function (x) { return x !== id; });
    if (s.order.indexOf(s.active) === -1) s.active = s.order.length ? s.order[0] : null;
    return s;
  }

  // Keep-both renames the incoming city so cityId() derives a fresh id.
  function keepBothName(name) {
    return String(name) + ' 2';
  }

  function blankCity(name, country, from, to) {
    if (!name || !String(name).replace(/^\s+|\s+$/g, '')) throw new Error('city name required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('dates must be YYYY-MM-DD');
    if (from > to) throw new Error('start date must not be after end date');
    return {
      schema: 1,
      city: {
        name: String(name).replace(/^\s+|\s+$/g, ''),
        country: (country || '').toUpperCase().slice(0, 3),
        dates: { from: from, to: to },
        notes: []
      },
      sections: [
        { id: 'dinner', label: 'Dinner', icon: '🍽️' },
        { id: 'breakfast', label: 'Breakfast', icon: '🍳' },
        { id: 'lunch', label: 'Lunch', icon: '🥙' },
        { id: 'coffee', label: 'Coffee', icon: '☕' },
        { id: 'cowork', label: 'Coworking', icon: '💻' },
        { id: 'activities', label: 'Activities', icon: '🏛️' },
        { id: 'services', label: 'Services', icon: '🧺' },
        { id: 'practical', label: 'Practical', icon: '💡' }
      ],
      items: [{
        id: 'getting-started',
        section: 'practical',
        status: 'plan',
        name: 'Fill this city with real data',
        note: 'This is a blank scaffold. Run PROMPT.md for this city (see the README), then paste the generated JSON via the Update data button to fill every section. Until then you can adjust dates and plan the shape of the stay.',
        tags: [],
        links: [],
        place_id: null,
        verified: null
      }]
    };
  }

  // ---- Which city am I in right now? (pure) ----
  // Owner ask 2026-08-28: "on page load, load current city (based on
  // date/time)". Boot used to restore whichever city was last open, which on
  // a travel morning is the city he has just left.
  //
  // `metas` is one row per city the store holds: {id, from, to, archived}.
  // from/to are the EFFECTIVE stay dates (a stayOverride set in Edit dates
  // already applied by the caller) and `archived` is the resolved Past flag.
  // Taking both pre-resolved keeps this function pure and leaves "which dates
  // count" and "what counts as archived" with the two helpers that already
  // own those rules, effectiveDates and cityIsPast, rather than forking them.
  //
  // The rules, in order:
  //   1. a stay that CONTAINS today wins. On a travel day two of them do
  //      (Tirana runs to the 29th, Ksamil starts on the 29th), and the later
  //      `from` takes it: arrival beats departure, because the city being
  //      landed in is the one the guide is needed for.
  //   2. otherwise the next stay AHEAD: the smallest `from` after today.
  //   3. otherwise null, and boot keeps its existing behaviour (the stored
  //      active city, then the first city in order).
  // An exact tie on `from` keeps the earlier row, so the caller's order is
  // the tiebreak and the answer is stable across loads.
  //
  // Both sides are LOCAL calendar dates: `todayIsoStr` comes from todayIso(),
  // which formats the device clock in local time on purpose. Do not reach for
  // toISOString() here, that is UTC, and it would hand a traveler east of
  // Greenwich yesterday's city for the whole evening. Cities carry a
  // utc_offset for the sunset maths and it is deliberately unused: he is
  // standing in the city, so the device's own date is already the right one.
  function pickCurrentCity(metas, todayIsoStr) {
    var today = todayIsoStr || todayIso();
    var live = (Array.isArray(metas) ? metas : []).filter(function (m) {
      return m && typeof m.id === 'string' && m.id && !m.archived
        && isIso(m.from) && isIso(m.to) && m.from <= m.to;
    });
    var here = null;
    live.forEach(function (m) {
      if (m.from <= today && today <= m.to && (!here || m.from > here.from)) here = m;
    });
    if (here) return here.id;
    var next = null;
    live.forEach(function (m) {
      if (m.from > today && (!next || m.from < next.from)) next = m;
    });
    return next ? next.id : null;
  }

  // Pure start-city resolution, in precedence order: an explicit #city= hash
  // (when it names a city this device still holds) always wins, then the
  // calendar's answer from pickCurrentCity, then the stored active city, then
  // the first city in order, then null when the store is empty. Extracted so
  // the app shell's boot-target logic is unit-testable without a DOM.
  //
  // autoId sits BELOW the hash and ABOVE store.active by design: a deep link
  // is an explicit request and must never be overridden, while a plain load
  // carries no request at all, and on that load the calendar knows better
  // than a stale active city does. autoId is optional, so a caller that has
  // no calendar answer (or does not want one) gets the old behaviour.
  function resolveStartCity(store, hashId, autoId) {
    if (hashId && Object.prototype.hasOwnProperty.call(store.cities, hashId)) return hashId;
    if (autoId && Object.prototype.hasOwnProperty.call(store.cities, autoId)) return autoId;
    if (store.active && Object.prototype.hasOwnProperty.call(store.cities, store.active)) return store.active;
    return store.order.length ? store.order[0] : null;
  }

  // Feature 3: whether the bundled example city should be visible. Rule: it
  // shows by default when there are no real (non-seed) cities yet; once a
  // real city exists it hides everywhere unless the traveler's "Show example
  // city" profile toggle is on. `ids` is the app store's order (or any list
  // of city ids); `seedId` names the one id that counts as "the example", so
  // this stays pure and app-shell decides what its seed id actually is.
  function exampleCityVisible(ids, seedId, showExampleToggle) {
    var hasReal = (Array.isArray(ids) ? ids : []).some(function (id) { return id !== seedId; });
    return !hasReal || !!showExampleToggle;
  }

  // ---- interest profile + prompt assembly (pure) ----
  // The profile is app-only user data (it syncs as a third row kind), but its
  // shape and the prompt string assembly live in the engine so both are unit
  // testable in Node and so nothing about them depends on the DOM. The engine
  // itself never reads the profile: it is carried in the app store, handed to
  // the prompt builders, and pushed by the app shell's sync layer.
  var PROFILE_CAP = 30;        // entries per list; more dilutes the research
  var PROFILE_NOTES_CAP = 2000;

  function trimStr(v) {
    return (typeof v === 'string') ? v.replace(/^\s+|\s+$/g, '') : '';
  }

  // ---- planning factors (Phase 2) ----
  // A factor is a named travel dimension (walkability, nightlife, ...) with an
  // importance level on a fixed five-point scale. Seeded factors and
  // user-added custom ones share the same shape; nothing here distinguishes
  // them at read time (the `custom` flag is informational only, for the UI to
  // label "your own" entries, never checked by validation or the prompt).
  var FACTOR_LEVELS = ['blocker', 'very important', 'medium', 'low', 'not important'];

  // Seeded on first use of the profile editor (app-shell decides "first use";
  // the engine just describes what a sensible starting set looks like). Level
  // defaults to 'medium' so a traveler who never touches a seeded factor is
  // not silently telling the AI it's a blocker or a non-issue.
  var DEFAULT_FACTOR_LABELS = [
    'Food scene', 'Walkability', 'Safety', 'Work-friendly cafes',
    'Nature access', 'Nightlife', 'Transit quality'
  ];

  // A fresh array of fresh objects every call: callers mutate factor objects
  // in place (editing a level), so handing out one shared array would let one
  // user's edit corrupt every future "first open" default.
  function defaultFactors() {
    return DEFAULT_FACTOR_LABELS.map(function (label) {
      return { label: label, level: 'medium', custom: false };
    });
  }

  // Trims, drops anything without a real label or a level on the fixed scale,
  // dedupes by label (case-insensitive, first spelling wins, same rule as
  // normalizeProfileList), assigns a slug id (deduped against itself), and
  // caps the list. A dropped/invalid entry is simply absent, not corrected:
  // this is normalize-on-read, not a validator with error messages.
  function normalizeFactors(v) {
    var out = [];
    var seenLabel = {};
    var seenId = {};
    (Array.isArray(v) ? v : []).forEach(function (f) {
      if (!f || typeof f !== 'object') return;
      var label = trimStr(f.label);
      if (!label) return;
      var key = label.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(seenLabel, key)) return;
      if (FACTOR_LEVELS.indexOf(f.level) === -1) return;
      if (out.length >= PROFILE_CAP) return;
      seenLabel[key] = 1;
      var id = slug(label) || 'factor';
      var base = id, n = 2;
      while (Object.prototype.hasOwnProperty.call(seenId, id)) { id = base + '-' + n; n++; }
      seenId[id] = 1;
      out.push({ id: id, label: label, level: f.level, custom: !!f.custom });
    });
    return out;
  }

  // Trims, drops empties, dedupes case-insensitively keeping the FIRST spelling
  // (order is priority, so the earlier entry is the one the traveler meant),
  // and caps the list.
  function normalizeProfileList(v) {
    var out = [];
    var seen = {};
    (Array.isArray(v) ? v : []).forEach(function (x) {
      var t = trimStr(x);
      if (!t) return;
      var k = t.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(seen, k)) return;
      seen[k] = 1;
      if (out.length < PROFILE_CAP) out.push(t);
    });
    return out;
  }

  function normalizeProfile(raw) {
    var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
      schema: 1,
      interests: normalizeProfileList(src.interests),
      avoid: normalizeProfileList(src.avoid),
      factors: normalizeFactors(src.factors),
      notes: trimStr(src.notes).slice(0, PROFILE_NOTES_CAP),
      // Feature 3 (example-city visibility): explicit user override, off by
      // default. Lives on the profile so it persists and syncs the same way
      // everything else here does; the app shell is the only reader.
      showExample: src.showExample === true,
      updated: (typeof src.updated === 'string' && src.updated) ? src.updated : null
    };
  }

  // Empty means "nothing for the AI to work with": the stamp does not count.
  // showExample is a display preference, not research input, so it never
  // counts toward "empty" either.
  function profileIsEmpty(p) {
    var n = normalizeProfile(p);
    return !n.interests.length && !n.avoid.length && !n.notes && !n.factors.length;
  }

  var INTERESTS_SECTION = { id: 'interests', label: 'My interests', icon: '⭐' };

  // The landmark lines buildCityPrompt edits in PROMPT.md. Named here so the
  // unit tests can build a small fake template carrying the same landmarks
  // instead of the whole file.
  var PROMPT_COPY_LINE = 'Copy this file per trip, fill in the header, delete this line, and go.';

  // Trip-details bullets, matched by their label. `span` means the bullet has
  // more placeholders than values (accommodation name plus address), so the
  // whole bracket span is replaced by the single value rather than leaving a
  // dangling placeholder behind.
  var HEADER_BULLETS = [
    { label: 'City', keys: ['name'] },
    { label: 'Country', keys: ['country'] },
    { label: 'Dates', keys: ['from', 'to'] },
    { label: 'Accommodation', keys: ['accommodation'], span: true },
    { label: 'Arrival transport', keys: ['arrival'] },
    { label: 'Departure transport', keys: ['departure'] }
  ];

  function fillHeaderLine(line, rule, header) {
    var vals = rule.keys.map(function (k) { return trimStr(header ? header[k] : ''); });
    if (rule.span) {
      if (!vals[0]) return line;
      var first = line.indexOf('[');
      var last = line.lastIndexOf(']');
      if (first === -1 || last < first) return line;
      return line.slice(0, first) + vals[0] + line.slice(last + 1);
    }
    var i = 0;
    // An empty value leaves its placeholder in place, so a half-filled header
    // still reads as a prompt the traveler can finish by hand.
    return line.replace(/\[[^\][]*\]/g, function (m) {
      var v = vals[i++];
      return v ? v : m;
    });
  }

  // Planning-factor lines for the Traveler interests block. `blocker` factors
  // read as hard exclusions (the AI must not offer a weak pick on that
  // dimension); the rest read as weighted preferences, strongest first.
  // 'not important' factors are left out entirely: the traveler said this
  // dimension does not matter, and a "no preference" line would only be
  // noise the AI has to read past.
  var FACTOR_WEIGHT_ORDER = ['very important', 'medium', 'low'];

  function factorsBlockLines(factors) {
    var b = [];
    var blockers = factors.filter(function (f) { return f.level === 'blocker'; });
    var weighted = FACTOR_WEIGHT_ORDER.reduce(function (acc, level) {
      return acc.concat(factors.filter(function (f) { return f.level === level; }));
    }, []);
    if (blockers.length) {
      b.push('Hard exclusions: treat these as non-negotiable. If a pick is ' +
        'weak on one of these, do not suggest it at all, even as a backup:', '');
      blockers.forEach(function (f) { b.push('- ' + f.label); });
      b.push('');
    }
    if (weighted.length) {
      b.push('Weighted preferences, strongest first (favor picks that score ' +
        'well here over ones that do not, but these are not disqualifying):', '');
      weighted.forEach(function (f) { b.push('- ' + f.label + ' (' + f.level + ')'); });
      b.push('');
    }
    return b;
  }

  // `lead` is the one instruction line that only makes sense in a whole-guide
  // prompt (where the Interests research section is part of the file). The
  // delta builder shares this formatter and passes no lead, because its own
  // re-run block already says where the new items go.
  function interestsBlockLines(p, lead) {
    var b = ['## Traveler interests', ''];
    if (lead) b.push(lead, '');
    if (p.interests.length) {
      b.push('Interests, in priority order:', '');
      p.interests.forEach(function (x) { b.push('- ' + x); });
      b.push('');
    }
    if (p.avoid.length) {
      b.push('Avoid, do not suggest any of these:', '');
      p.avoid.forEach(function (x) { b.push('- ' + x); });
      b.push('');
    }
    if (p.factors && p.factors.length) b = b.concat(factorsBlockLines(p.factors));
    if (p.notes) b.push('Notes: ' + p.notes, '');
    return b;
  }

  // The block belongs after the traveler-profile bracket paragraph and before
  // the rule that closes the header, so it reads as part of who is travelling.
  // Falls back to the "What I need" heading, then to the end of the text, so a
  // reshaped template still gets the block rather than silently losing it.
  function insertInterestsBlock(lines, block) {
    var start = -1, i;
    for (i = 0; i < lines.length; i++) {
      if (/^##\s+Traveler profile\s*$/.test(lines[i])) { start = i; break; }
    }
    var at = -1;
    if (start !== -1) {
      for (i = start + 1; i < lines.length; i++) {
        if (lines[i] === '---') { at = i; break; }
        if (/^##\s/.test(lines[i])) break;
      }
    }
    if (at === -1) {
      for (i = 0; i < lines.length; i++) {
        if (/^##\s+What I need\s*$/.test(lines[i])) { at = i; break; }
      }
    }
    if (at === -1) return lines.concat([''], block);
    return lines.slice(0, at).concat(block, lines.slice(at));
  }

  // The trip-specific paragraph is a bracket span that wraps across several
  // lines in PROMPT.md ("[Add anything trip-specific here: ... this time.]"),
  // so it cannot be filled line-by-line like HEADER_BULLETS: this operates on
  // the whole joined text and replaces from the opening marker through the
  // next "]". An empty note leaves the placeholder in place, same convention
  // as every other optional header field.
  var TRIP_NOTES_MARK = '[Add anything trip-specific here';

  function fillTripNotes(text, notes) {
    var n = trimStr(notes);
    if (!n) return text;
    var start = text.indexOf(TRIP_NOTES_MARK);
    if (start === -1) return text;
    var end = text.indexOf(']', start);
    if (end === -1) return text;
    return text.slice(0, start) + n + text.slice(end + 1);
  }

  // Pure string assembly: fills PROMPT.md's Trip details bullets from `header`
  // ({name, country, from, to, accommodation, arrival, departure, notes}, all
  // optional strings), drops the "copy this file" instruction line, fills the
  // trip-specific bracket paragraph from header.notes, and inserts the
  // Traveler interests block when the profile has anything in it.
  function buildCityPrompt(templateText, header, profile) {
    var text = (templateText === null || templateText === undefined) ? '' : String(templateText);
    var lines = text.split('\n');
    var out = [];
    var inTrip = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === PROMPT_COPY_LINE) {
        // Drop the instruction and the blank line under it, so no gap is left.
        if (lines[i + 1] === '') i++;
        continue;
      }
      if (/^##\s/.test(line)) inTrip = /^##\s+Trip details\s*$/.test(line);
      if (inTrip && line.indexOf('- **') === 0) {
        for (var r = 0; r < HEADER_BULLETS.length; r++) {
          if (line.indexOf('- **' + HEADER_BULLETS[r].label + ':**') === 0) {
            line = fillHeaderLine(line, HEADER_BULLETS[r], header);
            break;
          }
        }
      }
      out.push(line);
    }
    var joined = fillTripNotes(out.join('\n'), header && header.notes);
    out = joined.split('\n');
    var p = normalizeProfile(profile);
    if (!profileIsEmpty(p)) {
      out = insertInterestsBlock(out, interestsBlockLines(p, INTERESTS_LEAD));
    }
    return out.join('\n');
  }

  // ---- re-run (delta) prompt builders ----
  // Both build a self-contained prompt for the traveler's own AI out of three
  // things: fixed instruction text sliced verbatim from PROMPT.md between HTML
  // comment landmarks, the city they already have, and (for interests) their
  // profile. Nothing is invented here and nothing is paraphrased: PROMPT.md
  // stays the single source of prompt wording, and these functions only choose
  // which parts of it to include and in what order.
  //
  // A missing landmark throws rather than silently building a prompt with a
  // hole in it. The app shows the message inline; it means the build shipped an
  // older PROMPT.md than the engine expects.
  function sliceLandmark(templateText, name) {
    var text = (templateText === null || templateText === undefined) ? '' : String(templateText);
    // Built by concatenation on purpose: a literal HTML comment opener in
    // engine source would put the tokenizer into script-data-escaped state
    // inside the app's embedded copy of the guide template (the assembler
    // rejects it outright).
    var mark = '<' + '!--';
    var open = mark + ' ' + name + ' -->';
    var close = mark + ' /' + name + ' -->';
    var a = text.indexOf(open);
    var b = text.indexOf(close);
    if (a === -1 || b === -1 || b < a) {
      throw new Error('The prompt template in this build has no ' + name +
        ' block. Update PROMPT.md from the repo and rebuild.');
    }
    return text.slice(a + open.length, b).replace(/^\n+/, '').replace(/\n+$/, '');
  }

  // The city, as the AI needs to see it in a re-run: enough to know where and
  // when, and nothing else. Fields the city does not carry are left out rather
  // than emitted empty.
  function cityHeaderLines(data) {
    var c = (data && data.city) ? data.city : {};
    var d = c.dates || {};
    var b = ['## The city', ''];
    b.push('- **City:** ' + trimStr(c.name));
    if (trimStr(c.country)) b.push('- **Country:** ' + trimStr(c.country));
    if (trimStr(d.from) || trimStr(d.to)) {
      b.push('- **Dates:** ' + trimStr(d.from) + ' to ' + trimStr(d.to));
    }
    var acc = (c.accommodation && trimStr(c.accommodation.name)) ? trimStr(c.accommodation.name) : '';
    if (acc) b.push('- **Accommodation:** ' + acc);
    b.push('');
    return b;
  }

  // One line per item, in the compact form both re-run blocks refer to.
  function itemListLines(items) {
    var b = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!it || !it.id) return;
      b.push('- ' + it.id + ' | ' + trimStr(it.section) + ' | ' + trimStr(it.name));
    });
    return b;
  }

  var INTERESTS_LEAD = 'Add a ninth section for these interests as described under Interests below.';

  // Assembly order, top to bottom:
  //   1. one header line saying what this run is
  //   2. the city block (name, country, dates, accommodation name)
  //   3. the Traveler interests block, same formatter buildCityPrompt uses
  //   4. the RERUN:INTERESTS instructions, verbatim from PROMPT.md
  //   5. the existing-item list the re-run block refers to as "below"
  //   6. the CONTRACT:ITEM rules, verbatim, so the AI has the item shape
  // Step 6 is the item-level half of PROMPT.md's output contract only: the
  // whole-guide half (city, dates, the eight-section list) would tell the AI to
  // emit exactly what a delta must never contain.
  function buildInterestsDeltaPrompt(templateText, cityData, profile) {
    var rerun = sliceLandmark(templateText, 'RERUN:INTERESTS');
    var contract = sliceLandmark(templateText, 'CONTRACT:ITEM');
    var p = normalizeProfile(profile);
    var out = ['You are extending an existing Nomadding city guide.', ''];
    out = out.concat(cityHeaderLines(cityData));
    if (!profileIsEmpty(p)) out = out.concat(interestsBlockLines(p, null));
    out.push('## What I need', '', rerun, '');
    out.push('## Existing items (do not re-suggest these)', '');
    out = out.concat(itemListLines(cityData && cityData.items));
    out.push('');
    out.push('## Item shape', '', contract, '');
    return out.join('\n');
  }

  // The full-coverage cousin of the interests delta: one pass that researches
  // the city across every category a traveler plans around (eat, see, do,
  // services) and distributes the picks into the sections they belong to,
  // rather than clustering them into one interests bucket. Same assembly as the
  // interests delta so the two read alike; the difference is entirely in the
  // RERUN:RESEARCH instructions this pulls instead of RERUN:INTERESTS.
  function buildResearchAllPrompt(templateText, cityData, profile) {
    var rerun = sliceLandmark(templateText, 'RERUN:RESEARCH');
    var contract = sliceLandmark(templateText, 'CONTRACT:ITEM');
    var p = normalizeProfile(profile);
    var out = ['You are extending an existing Nomadding city guide with a full-coverage research pass.', ''];
    out = out.concat(cityHeaderLines(cityData));
    if (!profileIsEmpty(p)) out = out.concat(interestsBlockLines(p, null));
    out.push('## What I need', '', rerun, '');
    out.push('## Existing items (do not re-suggest these)', '');
    out = out.concat(itemListLines(cityData && cityData.items));
    out.push('');
    out.push('## Item shape', '', contract, '');
    return out.join('\n');
  }

  // Assembly order, top to bottom:
  //   1. one header line saying what this run is
  //   2. the city block
  //   3. the Intel quality rules, verbatim, BEFORE the instructions that say
  //      "follow the Intel quality rules above"
  //   4. the RERUN:INTEL instructions, verbatim
  //   5. the item list the re-run block refers to as "below", archived items
  //      omitted (nobody needs intel on something already put away)
  //   6. the coverage instruction
  function buildIntelPassPrompt(templateText, cityData) {
    var rules = sliceLandmark(templateText, 'RULES:INTEL');
    var rerun = sliceLandmark(templateText, 'RERUN:INTEL');
    var items = (cityData && Array.isArray(cityData.items) ? cityData.items : [])
      .filter(function (it) { return it && it.status !== 'archived'; });
    var out = ['You are adding review-verified intel to an existing Nomadding city guide.', ''];
    out = out.concat(cityHeaderLines(cityData));
    out.push('## Intel quality rules', '', rules, '');
    out.push('## What I need', '', rerun, '');
    out.push('## Items', '');
    out = out.concat(itemListLines(items));
    out.push('');
    out.push('Cover as many of these as you can verify from real reviews. ' +
      'Leave out the ones you cannot: a partial payload of real intel is the ' +
      'correct answer, a complete one of invented intel is not.', '');
    return out.join('\n');
  }

  // The ratings pass may also return ONE notable-review takeaway per item, and
  // it delivers that through the existing `intel` delta map, whose merge rule
  // is REPLACE-the-whole-block (see mergeDelta). So the prompt has to show the
  // model what an item's intel already says, or a takeaway added to a place
  // that already carries intel would quietly delete the verdicts and tips the
  // intel pass earned. These lines are that echo: they exist so the contract
  // can honestly say "repeat what is here, verbatim, alongside your new tip".
  // Only items that HAVE intel cost any lines at all.
  function ratingsItemLines(items) {
    var b = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!it || !it.id) return;
      b.push('- ' + it.id + ' | ' + trimStr(it.section) + ' | ' + trimStr(it.name));
      var intel = it.intel;
      if (!intel || typeof intel !== 'object') return;
      (intel.verdicts || []).forEach(function (v) {
        if (v && v.text) b.push('    existing verdict (' + trimStr(v.tier) + '): ' + trimStr(v.text));
      });
      (intel.tips || []).forEach(function (t) {
        if (t) b.push('    existing tip: ' + trimStr(t));
      });
      if (intel.source) b.push('    existing intel source: ' + trimStr(intel.source));
    });
    return b;
  }

  // Assembly order, top to bottom:
  //   1. one header line saying what this run is
  //   2. the city block
  //   3. the RERUN:RATINGS instructions, verbatim from PROMPT.md
  //   4. the item list, PLAN and BACKUP items only, each with whatever intel
  //      it already carries echoed underneath it
  // Done and archived items are left out on purpose: a rating refresh exists
  // to help the traveler choose between places still in play, and neither a
  // meal already eaten nor a place already put away is one of those.
  function buildRatingsPassPrompt(templateText, cityData) {
    var rerun = sliceLandmark(templateText, 'RERUN:RATINGS');
    var items = (cityData && Array.isArray(cityData.items) ? cityData.items : [])
      .filter(function (it) { return it && (it.status === 'plan' || it.status === 'backup'); });
    var out = ['You are refreshing the Google Maps ratings on an existing Nomadding city guide.', ''];
    out = out.concat(cityHeaderLines(cityData));
    out.push('## What I need', '', rerun, '');
    out.push('## Items', '');
    out = out.concat(ratingsItemLines(items));
    out.push('');
    out.push('Each `- ` line above is `id | section | name`. Indented lines under ' +
      'an item are the intel it already holds, shown so you can repeat it ' +
      'verbatim if you add a review takeaway to that item. Return a rating ' +
      'only for the ones you can actually look up: an omitted item is the ' +
      'correct answer, an invented number is not.', '');
    return out.join('\n');
  }

  // One roster line per rival: id, name, and whatever is known about how good
  // it is. This is the half of the single-place prompt that makes the answer
  // a COMPARISON rather than a review. An item with neither a rating nor
  // intel is still listed, marked "not researched yet", because the AI has to
  // be able to say "your list is only half checked" instead of ranking
  // against a silence it mistook for a bad score.
  function rosterLines(items, state) {
    var b = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!it || !it.id) return;
      var bits = [];
      var r = it.rating;
      if (r && typeof r.stars === 'number') {
        bits.push(r.stars + '★' + (typeof r.count === 'number' ? ' (' + r.count + ')' : ''));
      }
      var st = state ? effectiveStatus(it, state) : it.status;
      if (st) bits.push(st);
      b.push('- ' + it.id + ' | ' + trimStr(state ? effectiveName(it, state) : it.name) +
        (bits.length ? ' | ' + bits.join(' | ') : ''));
      var intel = it.intel;
      var said = false;
      if (intel && typeof intel === 'object') {
        // Array.isArray rather than `|| []`: this is exported on promptKit,
        // so a caller can hand it data that never went through validate(),
        // and `"oops".forEach` throwing here would take the whole render with
        // it. A malformed intel block should cost its own lines, nothing else.
        (Array.isArray(intel.verdicts) ? intel.verdicts : []).forEach(function (v) {
          if (v && v.text) { said = true; b.push('    verdict (' + trimStr(v.tier) + '): ' + trimStr(v.text)); }
        });
        (Array.isArray(intel.tips) ? intel.tips : []).forEach(function (t) {
          if (t) { said = true; b.push('    tip: ' + trimStr(t)); }
        });
      }
      if (!said && !(r && typeof r.stars === 'number')) b.push('    not researched yet');
    });
    return b;
  }

  // Assembly order, top to bottom:
  //   1. one header line saying what this run is
  //   2. the city block
  //   3. THE PLACE: the one item this whole prompt is about, with the
  //      traveler's own note about it (who recommended it, and what they said)
  //   4. the RERUN:PLACE instructions, verbatim from PROMPT.md
  //   5. the rest of that item's SECTION, with ratings and intel, which is
  //      the list the verdict has to rank against
  //
  // Scoped to the item's own section on purpose. The owner's question is "is
  // this better than my other dinner options", not "is this better than the
  // laundry", and a roster of all 107 Tirana items would bury the seven that
  // matter. Done and archived rivals stay in the list, unlike the ratings
  // pass: a place already eaten at is exactly the yardstick worth ranking a
  // new recommendation against.
  // The item's own map/website links, as bare hrefs, for a prompt to quote.
  // Only what a browser could open: a tel: number is not a research hint.
  function researchLinks(item) {
    var out = [];
    ((item && Array.isArray(item.links)) ? item.links : []).forEach(function (l) {
      if (!l || (l.kind !== 'map' && l.kind !== 'web')) return;
      var h = trimStr(l.href);
      if (h && safeHref(h) && out.indexOf(h) === -1) out.push(h);
    });
    return out;
  }

  function buildPlacePassPrompt(templateText, cityData, item, state) {
    var rerun = sliceLandmark(templateText, 'RERUN:PLACE');
    if (!item || !item.id) throw new Error('No place to research.');
    var secId = item.section;
    var sec = null;
    (cityData && Array.isArray(cityData.sections) ? cityData.sections : []).forEach(function (s) {
      if (s && s.id === secId) sec = s;
    });
    var others = (cityData && Array.isArray(cityData.items) ? cityData.items : [])
      .filter(function (it) { return it && it.id && it.id !== item.id && it.section === secId; });
    var name = trimStr(state ? effectiveName(item, state) : item.name);
    var out = ['You are checking one place a traveler added by hand to an existing Nomadding city guide.', ''];
    out = out.concat(cityHeaderLines(cityData));
    out.push('## The place', '');
    out.push('- **Item id:** ' + item.id);
    out.push('- **Name as the traveler typed it:** ' + name);
    out.push('- **Section:** ' + (sec ? trimStr(sec.label) + ' (' + secId + ')' : trimStr(secId)));
    if (trimStr(item.note)) out.push('- **The traveler\'s note:** ' + trimStr(item.note).replace(/\s+/g, ' '));
    if (trimStr(item.day)) out.push('- **Pencilled in for:** ' + trimStr(item.day));
    // The research hint. A small independent place is often unfindable by
    // name alone (the run that prompted this could not find Pizzarté in
    // Tirana), so when the traveler pasted a map pin or the place's own site
    // while adding it, the pass is TOLD to start there rather than left to
    // search a name that returns nothing.
    var hints = researchLinks(item);
    if (hints.length) {
      out.push('- **The user provided this link for the place:** ' + hints.join(' , '));
      out.push('  Start from that link. It is the traveler\'s own reference for this exact ' +
        'place, so prefer what it says over a search result for a similar name, and say so ' +
        'in `source`. If the link is dead or is plainly a different place, say that in `tips` ' +
        'rather than guessing.');
    }
    out.push('');
    out.push('## What I need', '', rerun, '');
    out.push('## Others already in this section', '');
    if (others.length) {
      out = out.concat(rosterLines(others, state));
      out.push('');
      out.push('Each `- ` line above is `id | name | rating | status`, with any intel ' +
        'this guide already holds indented under it. There are ' + others.length +
        ' of them. Rank the new place against exactly this list and nothing else, ' +
        'and return your answer keyed by the item id given under "The place".', '');
    } else {
      out.push('There are none: this is the first place in this section, so there is ' +
        'nothing to rank it against. Say so in `tips` and give the rating and ' +
        'verdict on their own.', '');
    }
    return out.join('\n');
  }

  // ---- the trip surface's door back to the guides (pure) ----
  // Owner report 2026-08-27: "my 'now' city is showing an archived city. also
  // fix the city I'm navigated to when clicking 'city guides'."
  //
  // The trip half knows its own stops; the guide half knows which guides
  // exist. The chip and the Cities door both have to answer one question from
  // those two facts: WHICH GUIDE should this open? It has to be answered
  // against the guides as they exist NOW, so a guide that was removed (its
  // row is gone) or archived (a city the traveler has left) is not a
  // destination, even when the stop covering today names it.
  //
  // Lives here, not in the trip shell, for two reasons: the engine already
  // ships into the trip surface, and a pure function here is one the Node tests can
  // reach. The shell keeps the fetch and the DOM.

  // cityops' own id shape: slug(name) + '-' + arrival date.
  function guideIdFor(name, fromIso) {
    var s = slug(String(name || ''));
    if (!s || !fromIso) return '';
    return s + '-' + fromIso;
  }

  // One stop -> the id of a LIVE guide for it, or '' when there is none.
  // Exact match first (same city, same arrival). Then the same city on a
  // different date, nearest wins: Rob shifts a check-in by a day far more
  // often than he visits the same city twice, and a guide for "Ohrid, arrived
  // the 3rd" is still the right guide when the stop now says the 4th.
  //
  // `index` is {ids: [...], archived: {id: true}}. An archived id is skipped
  // exactly like a missing one: it is a city he has left, so it is never what
  // "where am I going next" should open.
  function liveGuideIdForStop(stop, index) {
    var ids = (index && Array.isArray(index.ids)) ? index.ids : [];
    if (!ids.length) return '';
    var archived = (index && index.archived && typeof index.archived === 'object') ? index.archived : {};
    function live(id) {
      return !!id && ids.indexOf(id) !== -1 &&
        !(Object.prototype.hasOwnProperty.call(archived, id) && archived[id]);
    }
    var name = stop && stop.name;
    var s = slug(String(name || ''));
    if (!s) return '';
    var exact = guideIdFor(name, stop && stop.checkIn);
    if (live(exact)) return exact;
    var prefix = s + '-';
    var siblings = ids.filter(function (id) { return id.indexOf(prefix) === 0 && live(id); });
    if (!siblings.length) return '';
    var want = isoMs(stop && stop.checkIn);
    if (want === null) return siblings[0];
    var best = siblings[0], bestGap = Infinity;
    siblings.forEach(function (id) {
      var at = isoMs(id.slice(prefix.length));
      var gap = (at === null) ? Infinity : Math.abs(at - want);
      if (gap < bestGap) { bestGap = gap; best = id; }
    });
    return best;
  }

  // The whole resolution, as one decision.
  //
  //   stops       the trip's own city list ({name, checkIn, checkOut}, any
  //               order, any amount of junk in it)
  //   index       {ids, archived} as above
  //   todayIsoStr today
  //
  // Returns { when, stop, guideId, kind }:
  //   kind 'guide'  guideId names a live guide; open it. `when` is 'NOW' when
  //                 that stop covers today, 'NEXT' when it is ahead.
  //   kind 'plan'   there is a stop worth naming but no live guide anywhere
  //                 ahead; the door opens the guide half so one can be added.
  //   kind 'root'   there is nothing dated to say anything about; the door
  //                 opens the guide half on whatever city it was last showing.
  //
  // The order is deliberate: the stop you are STANDING IN first, then the
  // ones ahead of you in date order. The case that fixed the order: a traveler
  // standing in a city whose own guide has been removed, with the next stop
  // starting in two days. The door lands on the NEXT stop's guide, which is
  // the one they would actually want open, rather than on nothing.
  // (The worked example here used to name the owner's real city and dates on a
  // real day. It was the shipped bytes of a public app saying where one person
  // was sleeping that week; generalised 2026-09-01.)
  function resolveGuideDoor(stops, index, todayIsoStr) {
    var today = todayIsoStr || todayIso();
    var named = (Array.isArray(stops) ? stops : []).filter(function (c) {
      return c && typeof c.name === 'string' && trimStr(c.name);
    });
    var here = null;
    named.forEach(function (c) {
      if (here) return;
      if (c.checkIn && c.checkOut && c.checkIn <= today && c.checkOut > today) here = c;
    });
    var ahead = named.filter(function (c) { return c.checkIn && c.checkIn > today; })
      .sort(function (a, b) { return a.checkIn < b.checkIn ? -1 : (a.checkIn > b.checkIn ? 1 : 0); });
    var order = (here ? [{ stop: here, when: 'NOW' }] : [])
      .concat(ahead.map(function (c) { return { stop: c, when: 'NEXT' }; }));
    for (var i = 0; i < order.length; i++) {
      var id = liveGuideIdForStop(order[i].stop, index);
      if (id) return { when: order[i].when, stop: order[i].stop, guideId: id, kind: 'guide' };
    }
    // Nothing ahead has a guide. Still name the stop rather than go quiet: a
    // door that opens the guide half so one can be written is a real answer,
    // and it is the one this app already offered on a stop card.
    if (order.length) {
      return { when: order[0].when, stop: order[0].stop, guideId: '', kind: 'plan' };
    }
    return { when: null, stop: null, guideId: '', kind: 'root' };
  }

  // ---- AI response parsing (pure) ----
  // Ported from tools/city-input.js so the CLI's .md-ingest path and the
  // in-app "generate with Claude" path (Phase 2) share one rule for finding
  // the city JSON in a chat response, rather than keeping two copies that can
  // drift. tools/city-input.js now calls this via the same loadCityOps()
  // harness it already used for parse()/validate().
  //
  // Matches a markdown fence: an opening line of ``` plus an optional
  // language tag and nothing else, then the body, then a closing line of
  // ``` and nothing else. Both delimiters are anchored to their own line
  // (multiline ^/$) so a closing ``` is never confused with the next fence's
  // OPENING ``` when a response contains more than one fenced block (e.g. a
  // ```bash setup snippet before the ```json guide): a naive "``` ... ```"
  // regex with no line anchor matches leftmost-first and would swallow the
  // second fence's own opening marker as if it were the first fence's close.
  var FENCE_RE = /^```[ \t]*(\w*)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

  // Returns the trimmed text of the first fenced block that parses as JSON,
  // or null if the text has no fenced block that does. Never throws: an
  // unparseable candidate fence is skipped, not reported, since a later fence
  // (or none at all) is just as valid an outcome.
  function extractJsonBlock(md) {
    FENCE_RE.lastIndex = 0;
    var m;
    var text = String(md === null || md === undefined ? '' : md);
    while ((m = FENCE_RE.exec(text)) !== null) {
      var body = m[2].replace(/^\s+|\s+$/g, '');
      try { JSON.parse(body); return body; }
      catch (e) { /* not this fence (e.g. a ```bash block before the JSON one) */ }
    }
    return null;
  }

  // Shared wording for "the response had no parseable JSON block": the CLI
  // shows it verbatim, the app shows it verbatim too (with its own Retry
  // button alongside, since the app can re-ask automatically).
  var RETRY_INSTRUCTION =
    'Ask the chat to reply again with: "reply with the full city guide as a ' +
    'single ```json code block and nothing else after it."';

  // True only when parse() failed for exactly one reason: the text was not
  // valid JSON at all. Schema errors (bad status, unknown section, etc.)
  // produce a different, longer errors list and are never mistaken for this.
  // Shared by the paste path (better failure copy) and fetchTextToCity below,
  // so both classify a syntax failure the same way.
  function isJsonSyntaxError(errors) {
    return Array.isArray(errors) && errors.length === 1 && /^JSON parse error:/.test(errors[0]);
  }

  // Turns arbitrary fetched text into a city, same contract as parse() plus a
  // `kind` tag the caller uses to pick failure copy. Two entry transports feed
  // this: a URL pointing straight at city JSON, and a URL pointing at a raw
  // .md guide (JSON wrapped in a ```json fence, same shape Claude/ChatGPT
  // replies produce). Try the direct parse first since that is the common
  // case (this site's own cities/<file>.json); only fall back to fence
  // extraction when the direct parse failed on JSON syntax specifically, so a
  // schema error on a well-formed JSON file is never masked by a fence search.
  // kind is one of:
  //   'ok'       - data is a valid city, ready for commitFromForm
  //   'not-json' - no parseable JSON found, direct or fenced
  //   'invalid'  - JSON parsed fine but failed schema validation
  function fetchTextToCity(text) {
    var direct = parse(text);
    if (direct.data) return { data: direct.data, errors: [], kind: 'ok' };
    if (!isJsonSyntaxError(direct.errors)) {
      return { data: null, errors: direct.errors, kind: 'invalid' };
    }
    var block = extractJsonBlock(text);
    if (block === null) return { data: null, errors: direct.errors, kind: 'not-json' };
    // extractJsonBlock only ever returns a fence body that already parsed as
    // JSON once (see its own try/catch), so parse() here can only still fail
    // on schema, never on syntax.
    var viaFence = parse(block);
    if (viaFence.data) return { data: viaFence.data, errors: [], kind: 'ok' };
    return { data: null, errors: viaFence.errors, kind: 'invalid' };
  }

  // ==========================================================================
  // Tolerant intake (pure). ONE door for every paste box in the product.
  // ==========================================================================
  // Owner report 2026-09-05: "i need to be able to paste md file content into
  // the city plan creator, or enrichment, or wherever. currently it's asking
  // for json and it's very picky with format."
  //
  // The workflow this exists for: the app builds a prompt, the traveler pastes
  // it into Claude.ai or ChatGPT, and pastes the answer back. What comes back
  // is only sometimes the single fenced JSON block the prompt asked for. It is
  // just as often prose with the JSON buried in it, JSON with one trailing
  // comma, a block a chat client re-typed with curly quotes, or a perfectly
  // good city guide written as markdown headings and bullets. Every one of
  // those used to be refused with a parser exception.
  //
  // THREE LAYERS, CHEAPEST FIRST:
  //   1. structured  - raw JSON, fenced JSON, JSON embedded in prose, then a
  //                    named repair pass. Offline, instant, free.
  //   2. markdown    - a deterministic markdown-to-schema-v1 extractor.
  //                    Offline, instant, free.
  //   3. AI          - the shells offer a Convert with Claude button (and a
  //                    copy-a-conversion-prompt path for an account with no
  //                    transport) built from conversionPrompt() below. Costs
  //                    money, so it is a tap the traveler makes, never a tap
  //                    the app makes for them.
  //
  // WHAT THIS LAYER IS NOT ALLOWED TO DO, and the reason a future reader will
  // otherwise be tempted: TOLERANCE BELONGS AT INTAKE, NEVER AT THE MERGE
  // BOUNDARY. Whatever comes out of here goes through the SAME validate /
  // validateItem / mergeDelta path a hand-typed payload has always gone
  // through, with the same guarantees: an existing item is skipped and never
  // overwritten, ids stay unique, the id maps stay prototype-safe. If a guide
  // is ever refused for a reason that feels too strict, the fix is a new
  // NAMED rule in here, never a loosened check over there. The whole point of
  // one intake door is that the merge door did not have to move.

  // Characters this file must recognise in pasted text but must never itself
  // ship (the repo bans the em-dash outright, and the smart quotes only ever
  // appear here as things to repair). Built from code points so the source
  // stays clean and greppable.
  var CH_EMDASH = String.fromCharCode(8212);
  var CH_ENDASH = String.fromCharCode(8211);
  var CH_MIDDOT = String.fromCharCode(183);
  var CH_BULLET = String.fromCharCode(8226);
  var CH_LDQUO = String.fromCharCode(8220);
  var CH_RDQUO = String.fromCharCode(8221);
  var CH_LSQUO = String.fromCharCode(8216);
  var CH_RSQUO = String.fromCharCode(8217);
  var CH_STAR = String.fromCharCode(9733);
  var CH_STAR_OUTLINE = String.fromCharCode(9734);

  // ---- layer 1a: finding candidate JSON text ----

  // Every fenced block in the text, in order, opening and closing markers
  // anchored to their own lines for the reason FENCE_RE above already
  // documents. Unlike extractJsonBlock this returns them ALL and parses none:
  // the caller decides which candidate wins, and gets to try each one twice
  // (once clean, once repaired).
  function fenceBodies(text) {
    var out = [];
    FENCE_RE.lastIndex = 0;
    var m;
    while ((m = FENCE_RE.exec(text)) !== null) {
      var body = m[2].replace(/^\s+|\s+$/g, '');
      if (body) out.push(body);
    }
    return out;
  }

  // The outermost balanced object in a run of prose: from the first `{` to the
  // `}` that closes it. String-aware, so a brace inside a string value (a note
  // that says "the {sic}") cannot end the scan early, and escape-aware, so a
  // literal backslash-quote inside a string cannot end the string early.
  // Returns null when the text has no `{`, or when the braces never balance.
  function embeddedObject(text) {
    var start = text.indexOf('{');
    if (start === -1) return null;
    var depth = 0;
    var inStr = false;
    var esc = false;
    for (var i = start; i < text.length; i++) {
      var c = text.charAt(i);
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  // ---- layer 1b: the repair rules ----
  // Five rules, each one a failure this repo has actually seen come out of a
  // chat window, each one named in the result so a report can say what was
  // repaired. NOTHING here is a regex free-for-all: three of the five run
  // inside a single string-aware scanner precisely so a repair cannot reach
  // into a string value and change what a note SAYS.
  //
  // The refusal rule that makes the rest safe: a repair may change SYNTAX and
  // never MEANING. Where the two cannot be told apart the pass refuses and
  // the text falls through to the markdown layer, which is why single curly
  // quotes are deliberately not repaired (see below).

  // Rule "leading-json-word": a bare `json` left over from a fence marker the
  // traveler's copy took the backticks off, e.g. "json\n{ ... }".
  function stripJsonWord(text, fired) {
    var m = /^\s*json\s*\r?\n?/i.exec(text);
    if (!m) return text;
    var rest = text.slice(m[0].length);
    if (rest.charAt(0) !== '{' && rest.charAt(0) !== '[') return text;
    fired.push('leading-json-word');
    return rest;
  }

  // Rule "markdown-emphasis": a chat that bolded or italicised the whole
  // block, or an opening fence whose closing fence never arrived (which is
  // what a truncated copy off a phone looks like). Only symmetric wrappers,
  // and only when what is left starts like JSON.
  function stripWrappers(text, fired) {
    var t = text;
    var changed = false;
    var guard = 0;
    while (guard++ < 8) {
      var before = t;
      t = t.replace(/^\s+|\s+$/g, '');
      // An opening fence with no close: the fence extractor could not see it
      // because it is not a pair, but the body underneath is still the answer.
      var open = /^```[ \t]*\w*[ \t]*\r?\n/.exec(t);
      if (open && t.indexOf('\n```') === -1) { t = t.slice(open[0].length); }
      // A trailing lone fence marker, same story from the other end.
      t = t.replace(/\r?\n?```[ \t]*$/, '');
      // Symmetric emphasis runs. Matched pairs only: `**{...}**` is a wrapper,
      // `**{...}` is a fragment and is left alone.
      var em = /^([*_`]{1,3})([\s\S]*)\1$/.exec(t);
      if (em && /^\s*[{[]/.test(em[2])) t = em[2];
      if (t === before) break;
      changed = true;
    }
    if (changed && t !== text.replace(/^\s+|\s+$/g, '')) fired.push('markdown-emphasis');
    return t;
  }

  // Rules "trailing-comma", "smart-quotes" and "unescaped-newline", in ONE
  // string-aware pass because all three need to know whether the cursor is
  // inside a JSON string, and three separate regex passes over the same text
  // would each have to guess.
  //
  // smart-quotes: a curly double quote in STRUCTURAL position (outside any
  // string) is a delimiter a chat client substituted, so it becomes a straight
  // quote and its partner does too; a curly quote INSIDE a string is content
  // (an apostrophe in "Joe's Bar") and is left exactly as it is. Single curly
  // quotes are deliberately NOT treated as delimiters in any position: the
  // closing one is indistinguishable from an apostrophe, so repairing them
  // would be guessing at meaning. That is the refusal this pass exists to make
  // rather than the repair it is tempted to make.
  //
  // unescaped-newline: a raw line break between an opening quote and its close
  // is invalid JSON and is the single most common thing a chat window emits
  // for a long note. It becomes an escaped newline, which preserves the text.
  //
  // Returns null when the scan ends INSIDE a string, because at that point the
  // repair has lost track of where strings begin and end, and a repair that is
  // lost is a repair that invents.
  function repairScan(text, fired) {
    var out = [];
    var inStr = false;
    var smart = false;      // this string opened with a curly quote
    var esc = false;
    var hitComma = false, hitSmart = false, hitNewline = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inStr) {
        if (esc) { out.push(c); esc = false; continue; }
        if (c === '\\') { out.push(c); esc = true; continue; }
        if (smart && c === CH_RDQUO) { out.push('"'); inStr = false; smart = false; continue; }
        if (smart && c === '"') { out.push('\\"'); continue; }
        if (!smart && c === '"') { out.push('"'); inStr = false; continue; }
        if (c === '\n') { out.push('\\n'); hitNewline = true; continue; }
        if (c === '\r') { hitNewline = true; continue; }
        if (c === '\t') { out.push('\\t'); continue; }
        out.push(c);
        continue;
      }
      if (c === '"') { out.push(c); inStr = true; smart = false; continue; }
      if (c === CH_LDQUO) { out.push('"'); inStr = true; smart = true; hitSmart = true; continue; }
      // A stray closing curly quote outside a string is the partner of an
      // opener this scan already turned straight; treat it as a delimiter too.
      if (c === CH_RDQUO) { out.push('"'); inStr = true; smart = true; hitSmart = true; continue; }
      if (c === ',') {
        var j = i + 1;
        while (j < text.length && /\s/.test(text.charAt(j))) j++;
        var next = text.charAt(j);
        if (next === '}' || next === ']') { hitComma = true; continue; }
        out.push(c);
        continue;
      }
      out.push(c);
    }
    if (inStr) return null;
    if (hitComma) fired.push('trailing-comma');
    if (hitSmart) fired.push('smart-quotes');
    if (hitNewline) fired.push('unescaped-newline');
    return out.join('');
  }

  // One candidate, all five rules. Returns {text, repairs} or null when the
  // pass refused. Never called on text that already parses: the caller tries
  // every candidate clean first, so a repair can never win over a clean read.
  function repairCandidate(text) {
    var fired = [];
    var t = stripWrappers(String(text), fired);
    t = stripJsonWord(t, fired);
    var scanned = repairScan(t, fired);
    if (scanned === null) return null;
    return { text: scanned, repairs: fired };
  }

  // ---- layer 1: structured intake ----
  // Candidate order is the order of confidence: the whole text, then each
  // fenced block in document order, then the outermost balanced object in the
  // surrounding prose. Every candidate is tried CLEAN first and only then
  // REPAIRED, so a reply carrying one clean block and one mangled one always
  // lands on the clean one.
  //
  // route is one of 'json' (the paste was JSON and nothing else), 'fence'
  // (it came out of a code block) or 'embedded' (it was surrounded by prose).
  // The shells use route plus repairs to decide whether to preview before
  // committing: a clean 'json' paste behaves exactly as it always did.
  function readStructured(text) {
    var raw = String(text === null || text === undefined ? '' : text);
    var trimmed = raw.replace(/^\s+|\s+$/g, '');
    if (!trimmed) return null;
    var candidates = [{ text: trimmed, route: 'json' }];
    fenceBodies(raw).forEach(function (b) { candidates.push({ text: b, route: 'fence' }); });
    var emb = embeddedObject(raw);
    if (emb && emb !== trimmed) candidates.push({ text: emb, route: 'embedded' });
    var i, data;
    for (i = 0; i < candidates.length; i++) {
      try { data = JSON.parse(candidates[i].text); }
      catch (e) { continue; }
      if (data && typeof data === 'object') {
        return { data: data, route: candidates[i].route, repairs: [] };
      }
    }
    for (i = 0; i < candidates.length; i++) {
      var fixed = repairCandidate(candidates[i].text);
      if (!fixed) continue;
      if (!fixed.repairs.length) continue;   // nothing changed, so nothing new to try
      try { data = JSON.parse(fixed.text); }
      catch (e2) { continue; }
      if (data && typeof data === 'object') {
        return { data: data, route: candidates[i].route, repairs: fixed.repairs };
      }
    }
    // Last resort inside layer 1: prose around a block that only balances once
    // its own repairs are applied (a trailing comma before the closing brace
    // is the common one). Re-scan for the embedded object in the repaired
    // whole text rather than repairing an object we could not find.
    var wholeFixed = repairCandidate(trimmed);
    if (wholeFixed && wholeFixed.repairs.length) {
      var emb2 = embeddedObject(wholeFixed.text);
      if (emb2) {
        try {
          var d2 = JSON.parse(emb2);
          if (d2 && typeof d2 === 'object') {
            return { data: d2, route: 'embedded', repairs: wholeFixed.repairs };
          }
        } catch (e3) { /* refused: fall through to the markdown layer */ }
      }
    }
    return null;
  }

  // ---- layer 2: markdown to schema v1 ----
  // Deterministic, offline and CONSERVATIVE. It reads the shape these guides
  // actually take (see PROMPT.md: eight or nine named sections, a place per
  // bullet, hours and price and a map link on the same line) and nothing it
  // cannot read confidently becomes a guessed field: it becomes note text.
  //
  // Three things it will NEVER produce, because each one is a fact about the
  // world rather than a fact about the text:
  //   - a `day` it did not read as a literal ISO date;
  //   - a status other than plan or backup;
  //   - a rating that is not anchored to an explicit stars/out-of-five/review
  //     marker, so a price of 4.6 can never become a rating of 4.6.
  // It also never emits hours.class, which would mean deciding from a closing
  // time whether an evening suits, and never invents a link.

  // The section ids PROMPT.md asks for, and the words a chat actually writes
  // above them. An unrecognised heading keeps its own words and gets a slug
  // id: an extra section is a section the traveler can see and rename, while a
  // heading forced into the wrong id is data in the wrong tab.
  var MD_SECTIONS = [
    { id: 'dinner', label: 'Dinner', icon: '🍽️', words: ['dinner', 'dinners', 'evening meal', 'evening meals', 'supper'] },
    { id: 'breakfast', label: 'Breakfast', icon: '🥐', words: ['breakfast', 'breakfasts', 'brunch'] },
    { id: 'lunch', label: 'Lunch', icon: '🥗', words: ['lunch', 'lunches'] },
    { id: 'coffee', label: 'Coffee', icon: '☕', words: ['coffee', 'cafe', 'cafes', 'coffee shops', 'espresso', 'specialty coffee'] },
    { id: 'cowork', label: 'Coworking', icon: '💻', words: ['cowork', 'coworking', 'co-working', 'work spaces', 'workspaces', 'coworking spaces'] },
    { id: 'activities', label: 'Activities', icon: '🗺️', words: ['activities', 'activity', 'things to do', 'sights', 'attractions', 'day trips', 'see and do'] },
    { id: 'services', label: 'Services', icon: '🧺', words: ['services', 'service', 'laundry', 'errands', 'admin'] },
    { id: 'practical', label: 'Practical', icon: '📌', words: ['practical', 'practical notes', 'practicalities', 'logistics', 'getting around', 'good to know', 'notes'] },
    { id: 'interests', label: 'My interests', icon: '⭐', words: ['interests', 'my interests', 'personal interests'] }
  ];

  // Words that mean "the picks below are the fallback ones". A heading or a
  // standalone bold label carrying one of these switches the status of what
  // follows to backup, which is the only status besides plan this layer can
  // ever produce.
  var MD_BACKUP_WORDS = ['backup', 'backups', 'back-up', 'alternate', 'alternates', 'alternative',
    'alternatives', 'fallback', 'fallbacks', 'if closed', 'in reserve', 'reserves', 'runners up',
    'runners-up', 'also considered', 'other options'];
  var MD_PLAN_WORDS = ['plan', 'plans', 'plan picks', 'picks', 'main picks', 'top picks', 'the picks'];

  function mdNormalize(s) {
    return String(s || '')
      .replace(/[*_`~]/g, '')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .toLowerCase();
  }

  function mdMatchesAny(norm, words) {
    for (var i = 0; i < words.length; i++) {
      if (norm === words[i]) return true;
      if (norm.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  function mdSectionFor(headingText) {
    var norm = mdNormalize(headingText);
    if (!norm) return null;
    for (var i = 0; i < MD_SECTIONS.length; i++) {
      if (mdMatchesAny(norm, MD_SECTIONS[i].words)) {
        return { id: MD_SECTIONS[i].id, label: MD_SECTIONS[i].label, icon: MD_SECTIONS[i].icon };
      }
    }
    var id = slug(headingText.replace(/[*_`#]/g, ''));
    if (!id) return null;
    return { id: id, label: String(headingText).replace(/[*_`#]/g, '').replace(/^\s+|\s+$/g, ''), icon: '📍' };
  }

  // Every markdown link and bare URL on a line, classified by where it points.
  // `map` is decided by host, never by the label, because a chat writes
  // "Map" over a plain website link as often as not.
  var MAP_HOSTS = /(^|\.)(google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl|openstreetmap\.org|osm\.org|maps\.apple\.com)/i;
  function mdLinks(line) {
    var links = [];
    var seen = Object.create(null);
    function push(kind, label, href) {
      if (Object.prototype.hasOwnProperty.call(seen, href)) return;
      seen[href] = 1;
      links.push({ kind: kind, label: label, href: href });
    }
    function kindOf(href) {
      if (/^tel:/i.test(href)) return 'tel';
      if (MAP_HOSTS.test(href.replace(/^https?:\/\//i, '')) || /google\.[a-z.]+\/maps/i.test(href)) return 'map';
      return 'web';
    }
    var re = /\[([^\]]*)\]\((\s*[^)\s]+)\s*\)/g;
    var m;
    while ((m = re.exec(line)) !== null) {
      var href = m[2].replace(/^\s+|\s+$/g, '');
      if (!/^(https?:|tel:|mailto:)/i.test(href)) continue;
      var kind = kindOf(href);
      var label = m[1].replace(/^\s+|\s+$/g, '') || (kind === 'map' ? 'Open in Maps' : href);
      push(kind, label, href);
    }
    var bare = /(^|[\s(<])((?:https?:\/\/|tel:)[^\s)<>\]]+)/g;
    while ((m = bare.exec(line)) !== null) {
      var h = m[2].replace(/[.,;:]+$/, '');
      var k = kindOf(h);
      push(k, k === 'map' ? 'Open in Maps' : (k === 'tel' ? 'Call' : h.replace(/^https?:\/\//i, '').replace(/\/$/, '')), h);
    }
    return links;
  }

  // A link's own words already live in links[], so the whole construct comes
  // out of the note rather than leaving "Map Site" trailing off the end of a
  // sentence. Nothing else about the line is touched.
  function mdStripLinks(line) {
    return line
      .replace(/\[([^\]]*)\]\(\s*(?:https?:|tel:|mailto:)[^)\s]*\s*\)/g, '')
      .replace(/(?:https?:\/\/|tel:)[^\s)<>\]]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:])/g, '$1');
  }

  // A price is a currency symbol or code next to a number, optionally a range.
  // Anchored to the currency, never to a bare number, so "4.6" cannot become a
  // price any more than it can become a rating.
  var PRICE_RE = new RegExp(
    '(~|about |around |approx\\.? )?' +
    '(?:[$' + String.fromCharCode(8364) + String.fromCharCode(163) + String.fromCharCode(165) +
    String.fromCharCode(8382) + String.fromCharCode(8377) + ']\\s?\\d[\\d.,]*' +
    '(?:\\s?[-' + CH_ENDASH + CH_EMDASH + ']\\s?[$' + String.fromCharCode(8364) + String.fromCharCode(163) +
    String.fromCharCode(165) + String.fromCharCode(8382) + String.fromCharCode(8377) + ']?\\d[\\d.,]*)?' +
    '|\\d[\\d.,]*(?:\\s?[-' + CH_ENDASH + CH_EMDASH + ']\\s?\\d[\\d.,]*)?\\s?' +
    '(?:EUR|USD|GBP|GEL|ALL|AMD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|TRY|RON|BGN|MKD|RSD)\\b)', 'i');

  function mdPrice(text) {
    var m = PRICE_RE.exec(text);
    if (!m) return null;
    var t = m[0].replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').replace(/[.,]+$/, '');
    return t ? { text: t } : null;
  }

  // Hours are a clock range, or an explicit "opens"/"closes" plus a clock.
  // Whatever day words sit immediately after the range ride along, because
  // "12:00-23:00 daily" and "12:00-23:00 Tue to Sun" are different facts.
  var HOURS_CLOCK = '\\d{1,2}[:.]\\d{2}\\s?(?:am|pm)?';
  var HOURS_DAYWORD = '(?:daily|every day|weekdays|weekends' +
    '|monday|tuesday|wednesday|thursday|friday|saturday|sunday' +
    '|mon|tues|tue|thurs|thur|thu|wed|fri|sat|sun)';
  var HOURS_RANGE = '\\b' + HOURS_CLOCK + '\\s?[-' + CH_ENDASH + CH_EMDASH + 'to]{1,3}\\s?' + HOURS_CLOCK;
  var HOURS_RE = new RegExp(
    HOURS_RANGE +
    '(?:\\s?,\\s?' + HOURS_RANGE + ')*' +
    '(?:\\s*,?\\s*(?:closed\\s+)?' + HOURS_DAYWORD +
    '(?:\\s*(?:[-' + CH_ENDASH + ']|to|and|,)\\s*' + HOURS_DAYWORD + ')*)?', 'i');
  var OPENS_RE = /\b(opens?|closes?)\s+(?:at\s+)?\d{1,2}[:.]\d{2}\s?(?:am|pm)?/i;

  function mdHours(text) {
    var m = HOURS_RE.exec(text);
    if (m) return { text: m[0].replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') };
    m = OPENS_RE.exec(text);
    if (m) return { text: m[0].replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') };
    return null;
  }

  // A rating is only ever read when the number is ANCHORED: a stars word, a
  // star glyph, or an explicit out-of-five. A bare decimal is never a rating,
  // which is the rule that stops a price, a distance or a walk time becoming
  // one. The review count needs its own anchor for the same reason.
  var RATING_RE = new RegExp(
    '(?:[' + CH_STAR + CH_STAR_OUTLINE + ']\\s*(\\d(?:\\.\\d)?)' +
    '|(\\d(?:\\.\\d)?)\\s*(?:\\/\\s*5|out of 5|[' + CH_STAR + CH_STAR_OUTLINE + ']|\\bstars?\\b)' +
    '|\\brating[:\\s]+(\\d(?:\\.\\d)?)\\b)', 'i');
  var COUNT_RE = /(\d[\d,. ]*)\s*(?:reviews?|ratings?)\b/i;
  var COUNT_AFTER_RE = /\(\s*(\d[\d,. ]*)\s*\)/;

  function mdRating(text) {
    var m = RATING_RE.exec(text);
    if (!m) return null;
    var stars = parseFloat(m[1] || m[2] || m[3]);
    if (!(typeof stars === 'number') || isNaN(stars) || stars < 0 || stars > 5) return null;
    var out = { stars: stars };
    var after = text.slice(m.index + m[0].length);
    var cm = COUNT_RE.exec(text) || COUNT_AFTER_RE.exec(after);
    if (cm) {
      var n = parseInt(String(cm[1]).replace(/[,. ]/g, ''), 10);
      if (!isNaN(n) && n >= 0) out.count = n;
    }
    return out;
  }

  var ISO_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

  // Names: the confident forms first, a separator split second, the whole
  // short line third, and NOTHING after that. A line this cannot name is not
  // guessed at; the caller turns it into note text on the item above it.
  var NAME_SEPARATORS = [' ' + CH_EMDASH + ' ', ' ' + CH_ENDASH + ' ', ' ' + CH_MIDDOT + ' ',
    ' - ', ' | ', ': ', ' ' + CH_BULLET + ' '];

  // The hyphen goes LAST in the class: written between _ and the en-dash it is
  // a RANGE spanning every letter, and the whole note gets stripped away.
  var LEAD_RE = new RegExp('^[\\s:.,;>*_' + CH_ENDASH + CH_EMDASH + CH_MIDDOT + CH_BULLET + '-]*');
  function mdStripLead(text) { return String(text).replace(LEAD_RE, ''); }

  function mdItemName(text) {
    var t = String(text).replace(/^\s+|\s+$/g, '');
    if (!t) return null;
    var bold = /^(?:\*\*|__)([^*_]{1,90}?)(?:\*\*|__)\s*(.*)$/.exec(t);
    if (bold) {
      var bn = bold[1].replace(/[\s:.,;]+$/, '').replace(/^\s+|\s+$/g, '');
      if (bn) return { name: bn, rest: mdStripLead(bold[2]) };
    }
    var link = /^\[([^\]]{1,90})\]\([^)]*\)\s*(.*)$/.exec(t);
    if (link) {
      var ln = link[1].replace(/^\s+|\s+$/g, '');
      if (ln) return { name: ln, rest: mdStripLead(link[2]) };
    }
    for (var i = 0; i < NAME_SEPARATORS.length; i++) {
      var at = t.indexOf(NAME_SEPARATORS[i]);
      if (at > 0 && at <= 90) {
        var n = t.slice(0, at).replace(/[*_`]/g, '').replace(/^\s+|\s+$/g, '');
        if (n) return { name: n, rest: t.slice(at + NAME_SEPARATORS[i].length).replace(/^\s+|\s+$/g, '') };
      }
    }
    var plain = t.replace(/[*_`]/g, '').replace(/^\s+|\s+$/g, '');
    if (plain && plain.length <= 60 && !/[.!?]\s/.test(plain)) return { name: plain, rest: '' };
    return null;
  }

  var BULLET_RE = new RegExp('^(\\s*)(?:[-*+' + CH_BULLET + ']|\\d+[.)])\\s+(.*)$');
  var HEADING_RE = /^(#{1,6})\s+(.*)$/;
  var BOLD_LINE_RE = /^\s*(?:\*\*|__)([^*_]+?)\s*(:?)\s*(?:\*\*|__)\s*(:?)\s*$/;

  // The extractor proper. `opts.header` (name, country, from, to) is what the
  // caller already knows: the Add city form's fields, or the city an Update
  // data is replacing. Anything the header does not supply is looked for in
  // the markdown itself, and a trip whose dates cannot be found anywhere is
  // reported as exactly that rather than given invented ones.
  function markdownToCity(text, opts) {
    opts = opts || {};
    var header = opts.header || {};
    var lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
    var sections = [];
    var sectionIds = Object.create(null);
    var items = [];
    var itemIds = Object.create(null);
    var unread = 0;

    function addSection(sec) {
      if (!sec) return null;
      if (!Object.prototype.hasOwnProperty.call(sectionIds, sec.id)) {
        sectionIds[sec.id] = 1;
        sections.push(sec);
      }
      return sec.id;
    }
    function uniqueItemId(name) {
      var base = slug(name) || 'item';
      var id = base;
      var n = 2;
      while (Object.prototype.hasOwnProperty.call(itemIds, id)) { id = base + '-' + n; n++; }
      itemIds[id] = 1;
      return id;
    }

    // Which heading level names a section. A guide with any level-2 heading
    // uses those; one with only level-1 headings uses those; a guide with no
    // headings at all gets one honest catch-all rather than eight invented
    // section names.
    var seenLevels = [];
    var levelCount = Object.create(null);
    var levelNamed = Object.create(null);
    lines.forEach(function (l) {
      var h = HEADING_RE.exec(l);
      if (!h) return;
      var lv = h[1].length;
      if (!Object.prototype.hasOwnProperty.call(levelCount, lv)) {
        levelCount[lv] = 0; levelNamed[lv] = 0; seenLevels.push(lv);
      }
      levelCount[lv]++;
      var norm = mdNormalize(h[2]);
      for (var q = 0; q < MD_SECTIONS.length; q++) {
        if (mdMatchesAny(norm, MD_SECTIONS[q].words)) { levelNamed[lv]++; break; }
      }
    });
    seenLevels.sort(function (a, b) { return a - b; });
    var sectionLevel = 0;
    var bestNamed = 0;
    seenLevels.forEach(function (lv) {
      if (levelNamed[lv] > bestNamed) { bestNamed = levelNamed[lv]; sectionLevel = lv; }
    });
    if (!sectionLevel) {
      for (var r = 0; r < seenLevels.length; r++) {
        if (levelCount[seenLevels[r]] > 1) { sectionLevel = seenLevels[r]; break; }
      }
    }
    if (!sectionLevel && seenLevels.length) sectionLevel = seenLevels[0];

    // The stay, when the caller knows it, is the only fence around a date.
    function dayInRange(iso) {
      if (!header.from || !header.to) return true;
      return iso >= String(header.from) && iso <= String(header.to);
    }

    var fenced = Object.create(null);
    (function () {
      var marks = [];
      lines.forEach(function (l, n) { if (/^\s*```/.test(l)) marks.push(n); });
      for (var p = 0; p + 1 < marks.length; p += 2) {
        for (var q = marks[p]; q <= marks[p + 1]; q++) fenced[q] = 1;
      }
      if (marks.length % 2 === 1) fenced[marks[marks.length - 1]] = 1;
    })();

    var currentSection = null;
    var currentStatus = 'plan';
    var current = null;         // the item still collecting note lines
    var headerLines = [];

    function flush() {
      if (!current) return;
      var noteParts = current.notes.filter(function (s) { return !!s; });
      var note = noteParts.join(' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      var scanText = current.scan.join(' ');
      var it = {
        id: current.id,
        section: current.section,
        status: current.status,
        name: current.name,
        links: current.links,
        place_id: null,
        verified: null
      };
      var day = ISO_RE.exec(scanText);
      if (day && dayInRange(day[1])) it.day = day[1];
      var price = mdPrice(scanText);
      if (price) it.price = price;
      var hours = mdHours(scanText);
      if (hours) it.hours = hours;
      var rating = mdRating(scanText);
      if (rating) it.rating = rating;
      if (note) it.note = note;
      items.push(it);
      current = null;
    }

    function startItem(name, restText, rawLine) {
      flush();
      if (!currentSection) {
        currentSection = addSection({ id: 'notes', label: 'From your notes', icon: '📍' });
      }
      var id = uniqueItemId(name);
      current = {
        id: id, section: currentSection, status: currentStatus, name: name,
        links: mdLinks(rawLine), notes: [mdStripLinks(restText).replace(/^\s+|\s+$/g, '')],
        scan: [mdStripLinks(rawLine)]
      };
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (Object.prototype.hasOwnProperty.call(fenced, i)) continue;
      if (!/\S/.test(line)) continue;
      if (/^\s*(\||[-:| ]{4,})\s*$/.test(line)) continue;   // a table rule, not content

      var h = HEADING_RE.exec(line);
      if (h) {
        var level = h[1].length;
        var htext = h[2].replace(/[*_`]/g, '').replace(/\s*#+\s*$/, '').replace(/^\s+|\s+$/g, '');
        if (level < sectionLevel || sectionLevel === 0) { headerLines.push(htext); continue; }
        if (level === sectionLevel) {
          flush();
          var sec = mdSectionFor(htext);
          if (sec) { currentSection = addSection(sec); currentStatus = 'plan'; }
          continue;
        }
        // A deeper heading: either a plan/backup label, or a place in its own
        // right. A label switches the status of what follows and adds nothing.
        var hn = mdNormalize(htext);
        if (mdMatchesAny(hn, MD_BACKUP_WORDS)) { flush(); currentStatus = 'backup'; continue; }
        if (mdMatchesAny(hn, MD_PLAN_WORDS)) { flush(); currentStatus = 'plan'; continue; }
        var named = mdItemName(htext);
        if (named) { startItem(named.name, named.rest, line); }
        else { unread++; }
        continue;
      }

      var bl = BOLD_LINE_RE.exec(line);
      if (bl) {
        var bn2 = mdNormalize(bl[1]);
        if (mdMatchesAny(bn2, MD_BACKUP_WORDS)) { flush(); currentStatus = 'backup'; continue; }
        if (mdMatchesAny(bn2, MD_PLAN_WORDS)) { flush(); currentStatus = 'plan'; continue; }
        // A trailing colon makes it a label over the prose beneath it, not the
        // name of a place. The prose keeps flowing into whatever item is open.
        if (bl[2] || bl[3]) { continue; }
        var namedB = mdItemName(bl[1]);
        if (namedB) { startItem(namedB.name, '', line); }
        else { unread++; }
        continue;
      }

      var b = BULLET_RE.exec(line);
      if (b) {
        var indent = b[1].replace(/\t/g, '  ').length;
        var body = b[2];
        // A nested bullet is detail about the item above it, never a new one.
        if (indent >= 2 && current) {
          current.notes.push(mdStripLinks(body).replace(/^\s+|\s+$/g, ''));
          current.scan.push(mdStripLinks(body));
          mdLinks(line).forEach(function (lk) { current.links.push(lk); });
          continue;
        }
        var nb = mdNormalize(body);
        if (mdMatchesAny(nb, MD_BACKUP_WORDS) && body.replace(/[*_`:]/g, '').replace(/^\s+|\s+$/g, '').length <= 24) {
          flush(); currentStatus = 'backup'; continue;
        }
        var named2 = mdItemName(body);
        if (named2) { startItem(named2.name, named2.rest, line); continue; }
        // Could not name it confidently: it becomes note text on the item
        // above rather than a guessed field or a silently dropped line.
        if (current) {
          current.notes.push(mdStripLinks(body).replace(/^\s+|\s+$/g, ''));
          current.scan.push(mdStripLinks(body));
        } else { unread++; }
        continue;
      }

      // A plain paragraph line: note text for the item being collected, and
      // header material before any section has opened.
      if (current) {
        current.notes.push(mdStripLinks(line).replace(/^\s+|\s+$/g, ''));
        current.scan.push(mdStripLinks(line));
        mdLinks(line).forEach(function (lk) { current.links.push(lk); });
      } else if (!currentSection) {
        headerLines.push(line);
      } else {
        unread++;
      }
    }
    flush();

    // The city header: what the caller knows wins, because a form field the
    // traveler filled in is a fact and a line in a chat reply is a guess.
    var headText = headerLines.join('\n');
    var name = (header.name && String(header.name).replace(/^\s+|\s+$/g, '')) || '';
    if (!name) {
      for (var k = 0; k < headerLines.length; k++) {
        if (/["{}[\]]/.test(headerLines[k])) continue;   // JSON wreckage, not a city name
        var cand = headerLines[k].replace(/[*_`#]/g, '').split(/[,(]/)[0].replace(/^\s+|\s+$/g, '');
        cand = cand.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').replace(/^\s+|\s+$/g, '');
        if (cand && cand.length <= 60) { name = cand; break; }
      }
    }
    var from = header.from || '';
    var to = header.to || '';
    if (!from || !to) {
      var dates = headText.match(/\d{4}-\d{2}-\d{2}/g) || [];
      if (dates.length >= 2) { from = from || dates[0]; to = to || dates[1]; }
    }
    var city = { name: name, dates: { from: from, to: to } };
    if (header.country) city.country = String(header.country);

    var missing = [];
    if (!name) missing.push('the city name');
    if (!from || !to) missing.push('the trip dates');
    return {
      data: { schema: 1, city: city, sections: sections, items: items },
      stats: { items: items.length, sections: sections.length, unread: unread },
      sawHeader: !missing.length, missing: missing
    };
  }

  // The delta shape, from the same extractor. Only NEW sections are declared
  // (renaming a section is the traveler's business and a re-run must not undo
  // it), and an extracted place whose name already matches one in the guide is
  // dropped HERE rather than relying on mergeDelta's id check, because a chat
  // re-listing the same restaurant under a slightly different slug would
  // otherwise arrive as a second copy of it. Dropping is the only thing this
  // does about an existing item: it never edits one, which is mergeDelta's
  // guarantee and stays mergeDelta's guarantee.
  function markdownToDelta(text, existing, opts) {
    var built = markdownToCity(text, opts || {});
    var have = existing && typeof existing === 'object' ? existing : { sections: [], items: [] };
    var haveSections = Object.create(null);
    (Array.isArray(have.sections) ? have.sections : []).forEach(function (s) {
      if (s && s.id) haveSections[s.id] = 1;
    });
    var haveNames = Object.create(null);
    var haveIds = Object.create(null);
    (Array.isArray(have.items) ? have.items : []).forEach(function (it) {
      if (!it) return;
      if (it.id) haveIds[it.id] = 1;
      if (it.name) haveNames[mdNormalize(it.name)] = 1;
    });
    var duplicates = 0;
    var items = [];
    var used = Object.create(null);
    built.data.items.forEach(function (it) {
      var norm = mdNormalize(it.name);
      if (norm && Object.prototype.hasOwnProperty.call(haveNames, norm)) { duplicates++; return; }
      // A fresh id, because the extractor numbered its ids against its own
      // list and the guide it is merging into has ids of its own.
      var base = slug(it.name) || 'item';
      var id = base;
      var n = 2;
      while (Object.prototype.hasOwnProperty.call(haveIds, id) ||
             Object.prototype.hasOwnProperty.call(used, id)) { id = base + '-' + n; n++; }
      used[id] = 1;
      var copy = {};
      Object.keys(it).forEach(function (k) { copy[k] = it[k]; });
      copy.id = id;
      if (copy.status !== 'plan' && copy.status !== 'backup') copy.status = 'plan';
      items.push(copy);
    });
    var sections = built.data.sections.filter(function (s) {
      return !Object.prototype.hasOwnProperty.call(haveSections, s.id);
    });
    var delta = { schema: 1, delta: true, items: items };
    if (sections.length) delta.sections = sections;
    return {
      data: delta,
      stats: { items: items.length, sections: sections.length, unread: built.stats.unread,
        duplicates: duplicates }
    };
  }

  // ---- the one door ----

  // Names the ACTION, not a button. The city app draws Convert with Claude plus
  // Copy conversion prompt beside this sentence; the engine, which also ships
  // inside offline guide files, draws only the copy one. A sentence naming a
  // control that is not on screen is the failure mode this wording avoids.
  var INTAKE_NEXT_STEP = 'Try the conversion buttons below, or paste the JSON block from your chat.';

  // Does this text look like markdown a person wrote, as opposed to a failed
  // JSON paste? Headings or bullets are the tell. Used only to pick the FAILURE
  // wording, never to decide whether to run the extractor.
  function looksMarkdown(text) {
    return /^\s{0,3}#{1,6}\s+\S/m.test(text) ||
      new RegExp('^\\s{0,4}(?:[-*+' + CH_BULLET + ']|\\d+[.)])\\s+\\S', 'm').test(text) ||
      /\*\*[^*]+\*\*/.test(text);
  }
  function looksJson(text) {
    var t = String(text).replace(/^\s+|\s+$/g, '');
    return t.charAt(0) === '{' || t.charAt(0) === '[' || /```/.test(t) || /"\s*:/.test(t);
  }

  // Is this payload TRYING to be schema v1? A JSON object that names schema,
  // items, sections, city or delta gets its schema errors reported, because
  // those errors are the useful answer. Anything else falls through to the
  // markdown layer instead of being reported against a contract it was never
  // aiming at.
  function aimsAtSchema(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return ['schema', 'items', 'sections', 'city', 'delta'].some(function (k) {
      return Object.prototype.hasOwnProperty.call(data, k);
    });
  }

  function intakeSummary(data, mode) {
    if (mode === 'raw') return 'imported data';
    var items = Array.isArray(data.items) ? data.items.length : 0;
    var secs = Array.isArray(data.sections) ? data.sections.length : 0;
    var what = items + (items === 1 ? ' place' : ' places');
    if (secs) what += ' across ' + secs + (secs === 1 ? ' section' : ' sections');
    if (mode === 'city' && data.city && data.city.name) return data.city.name + ': ' + what;
    return what;
  }

  // Whatever comes out of a layer is checked by the SAME validator the merge
  // door uses, and by nothing weaker. mergeDelta is called here in dry-run
  // spirit only: its result is thrown away and the caller calls it again for
  // real, so there is still exactly one place that writes a merged city.
  function checkPayload(data, mode, opts) {
    if (mode === 'raw') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, errors: ['Imported data is not a valid object.'] };
      }
      return { ok: true, errors: [] };
    }
    if (mode === 'delta') {
      var have = opts && opts.existing;
      if (have) {
        var res = mergeDelta(have, data);
        return { ok: !res.errors.length, errors: res.errors };
      }
      var errs = [];
      if (!data || typeof data !== 'object' || Array.isArray(data)) errs.push('Delta is not an object');
      else {
        if (data.schema !== 1) errs.push('schema must be 1');
        if (data.delta !== true) errs.push('delta must be true: this is a partial payload, not a whole guide');
      }
      return { ok: !errs.length, errors: errs };
    }
    var e = validate(data);
    return { ok: !e.length, errors: e };
  }

  // read(text, opts) is what every paste box in the product calls.
  //   opts.mode     'city' (a whole guide), 'delta' (an Enrich payload), or
  //                 'raw' (the trip surface's own export shape, which is not
  //                 schema v1 and gets layer 1 only).
  //   opts.header   {name, country, from, to} the caller already knows.
  //   opts.existing the city a delta merges into, so the check here is the
  //                 real mergeDelta and not a weaker stand-in.
  // On success `tolerant` says whether anything beyond a clean JSON.parse was
  // needed; the shells preview before committing when it is true, so the
  // path that has always worked keeps behaving exactly as it did.
  function intakeRead(text, opts) {
    opts = opts || {};
    var mode = opts.mode === 'delta' ? 'delta' : opts.mode === 'raw' ? 'raw' : 'city';
    var raw = String(text === null || text === undefined ? '' : text);
    if (!/\S/.test(raw)) {
      return { ok: false, data: null, route: null, repairs: [], tolerant: false,
        found: 'empty', errors: [], convertible: false,
        message: 'There is nothing here yet. Paste what your chat replied with: markdown or JSON, either works.' };
    }

    var structuredErrors = null;
    var s = readStructured(raw);
    if (s) {
      var chk = checkPayload(s.data, mode, opts);
      if (chk.ok) {
        return { ok: true, data: s.data, route: s.route, repairs: s.repairs,
          tolerant: s.route !== 'json' || s.repairs.length > 0,
          found: 'json', errors: [], stats: null,
          message: intakeSummary(s.data, mode) + '.' };
      }
      // A payload that was clearly aiming at the schema gets its own errors
      // reported. Running the markdown extractor over a near-miss guide would
      // replace a precise answer with a vague one.
      if (aimsAtSchema(s.data) || mode === 'raw') {
        return { ok: false, data: null, route: s.route, repairs: s.repairs, tolerant: true,
          found: 'json', errors: chk.errors, convertible: false,
          message: 'That parsed as JSON, but it is not a valid ' +
            (mode === 'delta' ? 'delta payload' : 'city guide') + ':\n- ' + chk.errors.join('\n- ') };
      }
      structuredErrors = chk.errors;
    }

    if (mode !== 'raw') {
      var built = mode === 'delta'
        ? markdownToDelta(raw, opts.existing, opts)
        : markdownToCity(raw, opts);
      if (built.stats.items > 0) {
        var chk2 = checkPayload(built.data, mode, opts);
        if (chk2.ok) {
          return { ok: true, data: built.data, route: 'markdown', repairs: [], tolerant: true,
            found: 'markdown', errors: [], stats: built.stats,
            message: intakeSummary(built.data, mode) + ', read from markdown.' };
        }
        // The one markdown failure worth its own sentence, because it is the
        // one the traveler can fix in two seconds without touching the paste.
        if (mode === 'city' && !built.sawHeader) {
          return { ok: false, data: null, route: 'markdown', repairs: [], tolerant: true,
            found: 'markdown', errors: chk2.errors, stats: built.stats, missing: built.missing,
            convertible: false,
            message: 'Read ' + built.stats.items + ' ' +
              (built.stats.items === 1 ? 'place' : 'places') +
              ' from that markdown, but not ' + built.missing.join(' or ') +
              '. Fill the fields above, then press Apply again.' };
        }
        return { ok: false, data: null, route: 'markdown', repairs: [], tolerant: true,
          found: 'markdown', errors: chk2.errors, stats: built.stats, convertible: true,
          message: 'Read ' + built.stats.items + ' ' +
            (built.stats.items === 1 ? 'place' : 'places') +
            ' from that markdown, but the result is not valid:\n- ' + chk2.errors.join('\n- ') };
      }
      if (looksMarkdown(raw)) {
        return { ok: false, data: null, route: null, repairs: [], tolerant: false,
          found: 'markdown', errors: structuredErrors || [], stats: built.stats, convertible: true,
          message: 'This looks like markdown but no places could be read from it. ' + INTAKE_NEXT_STEP };
      }
    }

    if (looksJson(raw)) {
      return { ok: false, data: null, route: null, repairs: [], tolerant: false,
        found: 'json', errors: structuredErrors || [], convertible: mode !== 'raw',
        message: 'This looks like JSON but no complete block in it would parse, ' +
          'even after repairing trailing commas and curly quotes. ' +
          (mode === 'raw' ? 'Copy the file again, whole, and paste it here.' : INTAKE_NEXT_STEP) };
    }
    if (mode === 'raw') {
      return { ok: false, data: null, route: null, repairs: [], tolerant: false,
        found: 'unknown', errors: structuredErrors || [], convertible: false,
        message: 'No JSON was found in that. Copy the whole exported file, or the whole ' +
          'reply your chat gave you, and paste it here.' };
    }
    return { ok: false, data: null, route: null, repairs: [], tolerant: false,
      found: 'unknown', errors: structuredErrors || [], convertible: true,
      message: 'Nothing here reads as a city guide: no JSON, and no headings or ' +
        'lists with places under them. ' + INTAKE_NEXT_STEP };
  }

  // ---- layer 3: the conversion prompt ----
  // Built here rather than in either shell so the one-tap path and the
  // copy-it-into-your-own-chat path are the same words, and so the words are
  // testable. It carries the contract the app enforces anyway, which is the
  // only reason the reply comes back mergeable: an instruction that leaves
  // status or ids to the model produces a payload validate() then refuses.
  function intakeKit_conversionPrompt(text, opts) { return conversionPrompt(text, opts); }
  function conversionPrompt(text, opts) {
    opts = opts || {};
    var mode = opts.mode === 'delta' ? 'delta' : 'city';
    var header = opts.header || {};
    var lines = [];
    if (mode === 'delta') {
      lines.push('Convert the notes at the end of this message into a Nomadding schema v1 DELTA payload.');
      lines.push('');
      lines.push('Reply with a single ```json fenced code block and nothing else: no prose before it, no explanation after it.');
      lines.push('');
      lines.push('The object has exactly these top level keys: "schema": 1, "delta": true, an optional "sections" array, and an "items" array.');
      lines.push('Each item has "id" (a short lowercase slug, unique within your reply), "section" (one of the section ids listed below, or one you declare in "sections"), "status" ("plan" or "backup" and nothing else), "name", and "links" (an array, empty if the notes carry no URL).');
      lines.push('Optional per item: "day" (YYYY-MM-DD, only when the notes state an actual date), "when", "note", "price" as {"text": "..."}, "hours" as {"text": "..."}, "rating" as {"stars": 4.6, "count": 1203}, "tags", "intel".');
      if (opts.existing && Array.isArray(opts.existing.sections) && opts.existing.sections.length) {
        lines.push('');
        lines.push('Section ids already in this guide: ' +
          opts.existing.sections.map(function (s) { return s && s.id; }).filter(Boolean).join(', ') + '.');
      }
      if (opts.existing && Array.isArray(opts.existing.items) && opts.existing.items.length) {
        var names = opts.existing.items.map(function (it) { return it && it.name; }).filter(Boolean);
        if (names.length) {
          lines.push('Places already in this guide, which you must NOT repeat: ' + names.join('; ') + '.');
        }
      }
    } else {
      lines.push('Convert the city guide at the end of this message into a Nomadding schema v1 JSON guide.');
      lines.push('');
      lines.push('Reply with a single ```json fenced code block and nothing else: no prose before it, no explanation after it.');
      lines.push('');
      lines.push('The object has exactly these top level keys: "schema": 1, "city", "sections", "items".');
      lines.push('"city" has "name", optional "country" (2 or 3 letters), and "dates": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}.');
      if (header.name) lines.push('The city name is ' + header.name + '.');
      if (header.country) lines.push('The country code is ' + header.country + '.');
      if (header.from && header.to) lines.push('The trip dates are ' + header.from + ' to ' + header.to + '.');
      lines.push('"sections" is an array of {"id", "label", "icon"}; prefer these ids where they fit: dinner, breakfast, lunch, coffee, cowork, activities, services, practical, interests.');
      lines.push('Each item has "id" (a short lowercase slug, unique across the whole reply), "section" (matching a declared section id), "status" ("plan" or "backup" and nothing else), "name", and "links" (an array, empty if the notes carry no URL).');
      lines.push('Optional per item: "day" (YYYY-MM-DD inside the trip dates, only when the notes state an actual date), "when", "note", "price" as {"text": "..."}, "hours" as {"text": "..."}, "rating" as {"stars": 4.6, "count": 1203}, "tags", "intel".');
    }
    lines.push('');
    lines.push('Rules that matter more than completeness:');
    lines.push('- Use only what the notes below actually say. Do not add places, ratings, prices, hours or dates that are not there.');
    lines.push('- Never emit "done" or "archived" as a status. Those are states the traveler sets later.');
    lines.push('- Omit "day" entirely rather than guess one.');
    lines.push('- Omit "rating" entirely for a place whose stars the notes do not state.');
    lines.push('');
    lines.push('The notes to convert:');
    lines.push('');
    lines.push(String(text === null || text === undefined ? '' : text));
    return lines.join('\n');
  }

  // ---- sync helpers (pure) ----
  // Every network call, session store and piece of sync UI lives in the app
  // shell (src/app-shell.html). Only decision logic lives here, so it is unit
  // testable in Node and so standalone guide files carry no sync code at all.

  // Timestamps arrive in two dialects: the device writes
  // "2026-08-11T09:00:00.000Z", PostgREST returns "2026-08-11T09:00:00+00:00".
  // Those two are the same instant but do NOT compare equal as strings, so
  // every comparison goes through epoch milliseconds. Unparseable or missing
  // values are treated as "no timestamp" rather than as year 0.
  function isoMs(v) {
    if (typeof v !== 'string' || !v) return null;
    var t = Date.parse(v);
    return (typeof t !== 'number' || isNaN(t)) ? null : t;
  }

  // Newer wins, ties keep local (spec M2). 'push' = local should go up,
  // 'pull' = remote should come down, 'noop' = leave both alone.
  function decideSync(localIso, remoteIso) {
    var l = isoMs(localIso);
    var r = isoMs(remoteIso);
    if (l === null && r === null) return 'noop';
    if (r === null) return 'push';
    if (l === null) return 'pull';
    if (l > r) return 'push';
    if (l < r) return 'pull';
    return 'noop';
  }

  // Whole-side plan: maps of id -> iso on each side (a missing key means the
  // row does not exist on that side). skipIds names cities removed on this
  // device in this session; they are never pulled back (removal does not
  // propagate in v1, but a removal must not be undone by our own next pull).
  function planSync(localMap, remoteMap, skipIds) {
    var local = localMap || {};
    var remote = remoteMap || {};
    var skip = skipIds || {};
    var ids = [];
    var seen = {};
    function collect(m) {
      Object.keys(m).forEach(function (id) {
        if (!Object.prototype.hasOwnProperty.call(seen, id)) { seen[id] = 1; ids.push(id); }
      });
    }
    collect(local);
    collect(remote);
    ids.sort();
    var out = { push: [], pull: [], noop: [] };
    ids.forEach(function (id) {
      var hasLocal = Object.prototype.hasOwnProperty.call(local, id);
      var d = decideSync(hasLocal ? local[id] : null,
        Object.prototype.hasOwnProperty.call(remote, id) ? remote[id] : null);
      if (d === 'pull' && !hasLocal && Object.prototype.hasOwnProperty.call(skip, id)) {
        out.noop.push(id);
        return;
      }
      out[d].push(id);
    });
    return out;
  }

  // Accepted limitation: updated_at is client-driven (the device stamps it,
  // not the server), so a device with a fast clock wins every reconcile for
  // as long as its clock stays skewed. Bounded by real device skew, which for
  // NTP-synced phones and laptops is sub-second in practice. v2 fix: a
  // server-side `now()` default on the column plus the client adopting the
  // stamp Postgres actually wrote via `Prefer: return=representation` instead
  // of trusting its own clock.
  //
  // Rows for a PostgREST upsert. user_id is never sent: it defaults to
  // auth.uid() server side, and RLS rejects anything else.
  //
  // ---- the profile row and its sidecars ----
  // The profile is ONE row per user and a PostgREST upsert replaces its whole
  // `data` object, so everything that lives in that row has to be written in a
  // single payload. Two sidecars ride beside the profile's own fields, each
  // carrying its OWN stamp so it reconciles independently of the profile:
  //   apiKey  {value, updated}  the traveler's Claude API key
  //   genmeta {value, updated}  the Add/Edit form fields that are not schema v1
  // The row's updated_at stays the PROFILE's stamp, never a sidecar's: a
  // sidecar edit must not let an otherwise stale profile win a reconcile.
  //
  // normalizeProfile() rebuilds a profile from a fixed field list, so neither
  // sidecar can ever survive a round trip into store.profile: the key cannot
  // reach the prompt builders, an exported guide or a city row by accident.
  // The unit tests pin that.
  var KEY_VALUE_CAP = 4000;      // a Claude key is ~108 chars; this is a sanity bound
  var GENMETA_FIELD_CAP = 2000;  // one free-text form field
  var GENMETA_CITY_CAP = 100;    // cities carried in the map
  var TOMB_CAP = 300;            // removed-city tombstones carried in the map

  function stampedBlock(raw, valueFn) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var u = (typeof raw.updated === 'string' && raw.updated) ? raw.updated : null;
    // No stamp means nothing can be reconciled against it, so it is not a
    // usable block: treated as absent rather than as an empty value.
    if (!u) return null;
    return { value: valueFn(raw.value), updated: u };
  }

  function normalizeKeyBlock(raw) {
    return stampedBlock(raw, function (v) {
      return (typeof v === 'string') ? v.slice(0, KEY_VALUE_CAP) : '';
    });
  }

  function normalizeGenMetaValue(v) {
    var src = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    var out = {};
    var n = 0;
    Object.keys(src).forEach(function (cityId) {
      if (n >= GENMETA_CITY_CAP) return;
      var m = src[cityId];
      if (!cityId || !m || typeof m !== 'object' || Array.isArray(m)) return;
      var entry = {};
      var kept = false;
      Object.keys(m).forEach(function (f) {
        if (typeof m[f] !== 'string') return;
        entry[f] = m[f].slice(0, GENMETA_FIELD_CAP);
        kept = true;
      });
      if (!kept) return;
      out[cityId] = entry;
      n++;
    });
    return out;
  }

  function normalizeGenMetaBlock(raw) {
    return stampedBlock(raw, normalizeGenMetaValue);
  }

  // ---- removal tombstones (the `removed` sidecar) ----
  // Removing a city used to be a LOCAL erasure: the device dropped its copy
  // and refused to pull it back for the rest of the session, but the account's
  // cities/city_state rows lived on, so the next device to open the app pushed
  // its own copy straight back and the removal undid itself on refresh. Owner
  // report 2026-08-27: "I'm repeatedly removing a city but it keeps adding back
  // when I refresh."
  //
  // A removal is now a FACT about the account, carried the same way every other
  // cross-device fact is: `removed` is a map of cityId -> the ISO instant that
  // city was removed, riding the profile row beside apiKey/github/genmeta.
  // Unlike those three it does NOT reconcile as a whole block, because two
  // devices can remove two different cities and a whole-block newest-wins
  // would silently throw one of the removals away. It merges per ENTRY.
  //
  // The map is built on a null prototype and every read goes through
  // hasOwnProperty, so a city genuinely named "constructor" is an ordinary key
  // rather than a function that answers true to every lookup.
  function normalizeTombValue(v) {
    var src = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    var out = Object.create(null);
    var n = 0;
    Object.keys(src).forEach(function (cityId) {
      if (n >= TOMB_CAP) return;
      if (!cityId) return;
      var at = src[cityId];
      // A tombstone with no readable stamp cannot be reconciled against a row,
      // so it is not a usable tombstone: dropped rather than kept as "removed
      // at the beginning of time", which would delete a live city.
      if (typeof at !== 'string' || isoMs(at) === null) return;
      out[cityId] = at;
      n++;
    });
    return out;
  }

  function normalizeTombBlock(raw) {
    return stampedBlock(raw, normalizeTombValue);
  }

  // The stamp on one entry, or null when this map has never heard of the city.
  function tombstoneAt(tombs, cityId) {
    if (!tombs || typeof tombs !== 'object' || !cityId) return null;
    if (!Object.prototype.hasOwnProperty.call(tombs, cityId)) return null;
    var at = tombs[cityId];
    return (typeof at === 'string' && isoMs(at) !== null) ? at : null;
  }

  // Per-entry newest-wins UNION of two tombstone maps. Both sides are plain
  // maps (not stamped blocks): the caller unwraps. Never loses an entry that
  // only one side knows about, which is the whole reason this is not
  // newerBlock().
  function mergeTombValues(mine, theirs) {
    var a = normalizeTombValue(mine);
    var b = normalizeTombValue(theirs);
    var out = Object.create(null);
    [a, b].forEach(function (m) {
      Object.keys(m).forEach(function (id) {
        var cur = tombstoneAt(out, id);
        if (cur === null || isoMs(m[id]) > isoMs(cur)) out[id] = m[id];
      });
    });
    return out;
  }

  // True when the union says something this device's map does not already say,
  // i.e. when adopting the account's copy would actually change anything here.
  // Used in both directions: to decide whether to write the merge locally, and
  // to decide whether a push has anything to carry up.
  function tombValuesDiffer(base, merged) {
    var a = normalizeTombValue(base);
    var b = normalizeTombValue(merged);
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return true;
    for (var i = 0; i < kb.length; i++) {
      if (a[kb[i]] !== b[kb[i]]) return true;
    }
    return false;
  }

  // The whole tombstone reconcile, as one pure decision.
  //
  //   tombs         cityId -> removal ISO (this device's map, already merged
  //                 with the account's)
  //   localStamps   cityId -> data stamp, for every city this device HOLDS
  //   remoteStamps  cityId -> updated_at, for every row the cities table
  //                 actually returned
  //
  // Returns four lists, and the one rule that produces them: a row or a local
  // copy that is NEWER than the tombstone is a genuine re-add (someone added
  // the city again after removing it), and a re-add wins over the removal, so
  // the tombstone is cleared and nothing is deleted. Otherwise the removal
  // wins and the stale copies go, server side and locally.
  //
  // A tie goes to the REMOVAL. The alternative (tie resurrects) is the exact
  // bug this exists to fix: a device that pushed a city and removed it in the
  // same millisecond would resurrect it forever.
  //
  //   dropRemote   ids whose cities/city_state rows must be DELETEd
  //   dropLocal    ids this device still holds and must forget
  //   clearTombs   ids whose tombstone must be dropped (re-added since)
  //   skipPush     {id:1} for every id this device must not push
  function planTombstones(tombs, localStamps, remoteStamps) {
    var t = normalizeTombValue(tombs);
    var local = localStamps || {};
    var remote = remoteStamps || {};
    var out = { dropRemote: [], dropLocal: [], clearTombs: [], skipPush: Object.create(null) };
    Object.keys(t).sort().forEach(function (id) {
      var T = isoMs(t[id]);
      var hasLocal = Object.prototype.hasOwnProperty.call(local, id);
      var hasRemote = Object.prototype.hasOwnProperty.call(remote, id);
      var L = hasLocal ? isoMs(local[id]) : null;
      var R = hasRemote ? isoMs(remote[id]) : null;
      // A copy stamped after the removal is a re-add, wherever it lives.
      if ((R !== null && R > T) || (L !== null && L > T)) {
        out.clearTombs.push(id);
        return;
      }
      out.skipPush[id] = 1;
      if (hasRemote) out.dropRemote.push(id);
      if (hasLocal) out.dropLocal.push(id);
    });
    return out;
  }

  // sidecars: {apiKey, genmeta, removed}, each {value, updated} or absent.
  //
  // There used to be a third, `github`: the personal access token the trip
  // surface published the family page with. Phase B replaced that publish with
  // public.shares, so the token is not written here any more and readSidecars
  // still reads it only so a device can notice a legacy row and clean it.
  function buildProfileRow(profile, sidecars) {
    var p = normalizeProfile(profile);
    var data = {};
    Object.keys(p).forEach(function (k) { data[k] = p[k]; });
    var s = (sidecars && typeof sidecars === 'object') ? sidecars : {};
    var key = normalizeKeyBlock(s.apiKey);
    if (key) data.apiKey = key;
    // No `github` block, deliberately, and this omission is the migration. The
    // GitHub PAT publish is gone (2026-08-28, replaced by public.shares), so
    // the token has no reader left anywhere in the product. Every row this
    // function writes from now on is a row with the token removed.
    var gm = normalizeGenMetaBlock(s.genmeta);
    if (gm) data.genmeta = gm;
    // The removal tombstones. Written even when the map is empty is pointless,
    // so an empty one is left out entirely: a device that has never removed a
    // city says nothing about removals rather than asserting "none".
    var rm = normalizeTombBlock(s.removed);
    if (rm && Object.keys(rm.value).length) data.removed = rm;
    return { data: data, updated_at: p.updated || EPOCH_ISO };
  }

  // The sidecars carried by a pulled profile row, each null when the row does
  // not carry a usable one (an older row, or one written by a build from
  // before sidecars existed).
  function readSidecars(rowData) {
    var src = (rowData && typeof rowData === 'object') ? rowData : {};
    return {
      apiKey: normalizeKeyBlock(src.apiKey),
      github: normalizeKeyBlock(src.github),
      genmeta: normalizeGenMetaBlock(src.genmeta),
      removed: normalizeTombBlock(src.removed)
    };
  }

  // Newest-wins per sidecar. `mine` and `theirs` are each {value, updated} or
  // null; a null side never wins, and a tie keeps the account's copy (the same
  // "ties keep what is already there" rule decideSync uses).
  // The tombstone twin of newerBlock: a UNION of the two maps, stamped with
  // the newest entry it holds so the block still carries a comparable stamp.
  // Returns null only when neither side has a single usable tombstone.
  function mergeTombBlocks(mine, theirs) {
    var value = mergeTombValues(mine && mine.value, theirs && theirs.value);
    var ids = Object.keys(value);
    if (!ids.length) return null;
    var newest = null;
    ids.forEach(function (id) {
      if (newest === null || isoMs(value[id]) > isoMs(newest)) newest = value[id];
    });
    return { value: value, updated: newest };
  }

  function newerBlock(mine, theirs) {
    if (!mine) return theirs || null;
    if (!theirs) return mine;
    return (decideSync(mine.updated, theirs.updated) === 'push') ? mine : theirs;
  }

  // Builds the profile-row payload for a device that owns only the CREDENTIALS,
  // not the interest profile: the trip surface, which has no Profile UI but
  // must be able to push a key or a token it was just given.
  //
  // A PostgREST upsert replaces the whole row, so pushing a row built from an
  // empty profile would blank the account's interests. This keeps the account's
  // profile half (and its stamp) exactly as read, and only reconciles the
  // sidecars. `row` is the pulled row ({data, updated_at}) or null; `mine` is
  // this device's blocks, {apiKey, github, genmeta}, each optional.
  function mergeProfileRow(row, mine) {
    var theirs = readSidecars(row && row.data);
    var m = (mine && typeof mine === 'object') ? mine : {};
    var merged = {
      apiKey: newerBlock(normalizeKeyBlock(m.apiKey), theirs.apiKey),
      // No github: whatever the account's row still carries is dropped on the
      // way through, which is what makes any push a cleanup push.
      genmeta: newerBlock(normalizeGenMetaBlock(m.genmeta), theirs.genmeta),
      // Union, not newest-wins: see mergeTombValues. Two devices removing two
      // different cities must end up with BOTH removals, not the later one.
      removed: mergeTombBlocks(normalizeTombBlock(m.removed), theirs.removed)
    };
    var profile = normalizeProfile(row && row.data);
    // Keep the ACCOUNT's profile stamp. This device did not edit the profile,
    // and stamping it now would make a credential change look like a profile
    // edit and beat the device that actually owns the profile.
    if (row && typeof row.updated_at === 'string' && row.updated_at) {
      profile.updated = row.updated_at;
    }
    return buildProfileRow(profile, merged);
  }

  // True when at least one of this device's sidecars beats the account's, so a
  // credential push has something to say. Nothing to send is never sent: an
  // upsert that changes nothing still costs a round trip and a row rewrite.
  function sidecarsWorthPushing(row, mine) {
    var theirs = readSidecars(row && row.data);
    var m = (mine && typeof mine === 'object') ? mine : {};
    // A row that still carries the retired `github` sidecar is a row that owes
    // a rewrite, whether or not this device has anything newer to say. This is
    // the whole migration trigger: one push, and the token is off the account.
    if (legacyGithubSidecar(row && row.data)) return true;
    var pairs = [
      [normalizeKeyBlock(m.apiKey), theirs.apiKey],
      [normalizeGenMetaBlock(m.genmeta), theirs.genmeta]
    ];
    for (var i = 0; i < pairs.length; i++) {
      var mineBlock = pairs[i][0], theirBlock = pairs[i][1];
      if (mineBlock && decideSync(mineBlock.updated, theirBlock ? theirBlock.updated : null) === 'push') return true;
    }
    // Tombstones do not reconcile on a block stamp, so neither does the
    // question "is a push worth making": a push is worth making exactly when
    // this device knows about a removal the account's row does not.
    var mineT = normalizeTombBlock(m.removed);
    var mergedT = mergeTombBlocks(mineT, theirs.removed);
    if (tombValuesDiffer(theirs.removed && theirs.removed.value, mergedT && mergedT.value)) return true;
    return false;
  }

  // A profile row written before 2026-08-28 carries a `github` sidecar: the
  // personal access token the trip surface used to publish the family page
  // with. That publish path is gone, so the token has no reader left and must
  // not keep riding the account. buildProfileRow no longer writes the field, so
  // the next push drops it; this is how a device KNOWS a push is owed even when
  // nothing else on it changed.
  function legacyGithubSidecar(rowData) {
    var src = (rowData && typeof rowData === 'object') ? rowData : {};
    return !!src.github;
  }

  // ---- presence days: the compliance counters ----
  //
  // Rob makes visa and tax decisions on these two numbers, so the arithmetic
  // lives here, pure and unit tested, instead of inside a renderer where it sat
  // wrong for months. Three things were wrong on 2026-09-01 and are fixed here.
  //
  // 1. A BORDER COUNTS DAYS, NOT NIGHTS. Any part of a day inside the territory
  //    is a whole day to an immigration officer and to the IRS, so the arrival
  //    day and the departure day BOTH count. Presence for a stay is every date
  //    from checkIn through checkOut INCLUSIVE. The old code counted nights
  //    ([checkIn, checkOut - 1]), which under-reported every stop by one day.
  //    That is the wrong direction to be wrong in on a 90/180 limit: it told
  //    the traveler he had room he did not have.
  //
  // 2. OVERLAPPING STAYS ARE ONE DAY, NOT TWO. Two stops that share a date are
  //    one day of presence. The old code summed each stay's overlap separately,
  //    so an itinerary with a one-day handover between two cities in the same
  //    zone counted that day twice. Presence is collected into a SET of dates
  //    and then counted, never summed per stay.
  //
  // 3. MEMBERSHIP WAS EXACT STRING EQUALITY. Country arrives from a free-text
  //    field and from imported JSON, so " France", "france" and "Czechia" each
  //    scored zero Schengen days in silence. The 29-name array stays the
  //    authority; only the MATCH is normalized.

  var SCHENGEN_MEMBERS = [
    'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Czech Republic', 'Denmark', 'Estonia', 'Finland',
    'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Italy', 'Latvia', 'Liechtenstein',
    'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Norway', 'Poland', 'Portugal', 'Romania',
    'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland'
  ];

  // Same country, other name. Only entries that are genuinely the SAME state go
  // here: an alias that is merely close is a near miss (below), which the app
  // reports rather than silently resolves.
  var COUNTRY_ALIASES = {
    'czechia': 'czech republic',
    'holland': 'netherlands',
    'slovak republic': 'slovakia',
    'hellas': 'greece',
    'deutschland': 'germany',
    'espana': 'spain',
    'italia': 'italy',
    'osterreich': 'austria',
    'suomi': 'finland',
    'sverige': 'sweden',
    'norge': 'norway',
    'danmark': 'denmark',
    'polska': 'poland',
    'magyarorszag': 'hungary',
    'schweiz': 'switzerland',
    'suisse': 'switzerland',
    'svizzera': 'switzerland',
    'nederland': 'netherlands',
    'eesti': 'estonia',
    'latvija': 'latvia',
    'lietuva': 'lithuania',
    'island': 'iceland',
    'hrvatska': 'croatia'
  };

  // Case, padding, punctuation and accents are noise on a country name. A
  // leading "the" is too: "The Netherlands" is Netherlands.
  function normCountry(name) {
    var s = String(name == null ? '' : name);
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (s.indexOf('the ') === 0) s = s.slice(4);
    return COUNTRY_ALIASES[s] || s;
  }

  var SCHENGEN_NORM = (function () {
    var m = {};
    for (var i = 0; i < SCHENGEN_MEMBERS.length; i++) m[normCountry(SCHENGEN_MEMBERS[i])] = SCHENGEN_MEMBERS[i];
    return m;
  })();

  function schengenMember(country) {
    return Object.prototype.hasOwnProperty.call(SCHENGEN_NORM, normCountry(country));
  }

  var US_NORM = { 'united states': 1, 'united states of america': 1, 'usa': 1, 'us': 1, 'u s a': 1, 'u s': 1, 'america': 1 };

  function usMember(country) {
    return Object.prototype.hasOwnProperty.call(US_NORM, normCountry(country));
  }

  // Every other country the app's own picker offers. These are real places that
  // are definitively NOT in the Schengen area, so they must never be reported
  // as a typo of one. Without this list the two most consequential pairs on the
  // list, Ireland/Iceland and Australia/Austria, both raise a false alarm, and a
  // counter that cries wolf on ordinary destinations is one the traveler learns
  // to scroll past.
  var KNOWN_NON_MEMBERS = [
    'Albania', 'Argentina', 'Armenia', 'Australia', 'Bahamas', 'Bali',
    'Bolivia', 'Bosnia and Herzegovina', 'Brazil', 'Cambodia', 'Canada',
    'Cape Verde', 'Chile', 'China', 'Colombia', 'Costa Rica', 'Cyprus',
    'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Georgia',
    'Ghana', 'Guatemala', 'Honduras', 'India', 'Indonesia', 'Ireland',
    'Israel', 'Jamaica', 'Japan', 'Jordan', 'Kenya', 'Laos', 'Lebanon',
    'Malaysia', 'Mauritius', 'Mexico', 'Moldova', 'Monaco', 'Mongolia',
    'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Nepal', 'New Zealand',
    'Nicaragua', 'Nigeria', 'North Macedonia', 'Pakistan', 'Panama',
    'Paraguay', 'Peru', 'Philippines', 'Qatar', 'Russia', 'Rwanda',
    'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Singapore',
    'South Africa', 'South Korea', 'Sri Lanka', 'Taiwan', 'Tanzania',
    'Thailand', 'Turkey', 'Türkiye', 'UAE', 'Uganda', 'Ukraine',
    'United Kingdom', 'United States', 'Uruguay', 'Vatican City',
    'Venezuela', 'Vietnam'
  ];

  var NON_MEMBER_NORM = (function () {
    var m = {};
    for (var i = 0; i < KNOWN_NON_MEMBERS.length; i++) m[normCountry(KNOWN_NON_MEMBERS[i])] = 1;
    for (var k in US_NORM) if (Object.prototype.hasOwnProperty.call(US_NORM, k)) m[k] = 1;
    return m;
  })();

  function editDistance(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  // The dangerous name is the one that is NOT a member and is one small typo
  // away from one: "Portgual" contributes zero Schengen days in silence and the
  // counter reads compliant when it is not. Return the member it probably meant
  // so the UI can name it, or null. Deliberately narrow: short names and a
  // distance over 2 are not reported, because a false alarm on every ordinary
  // non-member country would train the traveler to ignore the line.
  function schengenNearMiss(country) {
    var n = normCountry(country);
    if (!n || n.length < 5) return null;
    if (Object.prototype.hasOwnProperty.call(SCHENGEN_NORM, n)) return null;
    if (Object.prototype.hasOwnProperty.call(NON_MEMBER_NORM, n)) return null;
    var best = null, bestD = 3;
    for (var k in SCHENGEN_NORM) {
      if (!Object.prototype.hasOwnProperty.call(SCHENGEN_NORM, k)) continue;
      if (Math.abs(k.length - n.length) > 2) continue;
      var d = editDistance(n, k);
      if (d < bestD) { bestD = d; best = SCHENGEN_NORM[k]; }
    }
    return best;
  }

  // Every country name in the itinerary that is a near miss, once each, with
  // the member it probably meant. This is what the UI reports.
  function schengenSuspects(stays) {
    var seen = {}, out = [];
    (stays || []).forEach(function (s) {
      var raw = s && s.country;
      if (!raw || seen[raw]) return;
      seen[raw] = 1;
      var guess = schengenNearMiss(raw);
      if (guess) out.push({ name: String(raw), meant: guess });
    });
    return out;
  }

  // A stay is countable when it has both ends and has not been eliminated.
  function countableStay(s) {
    return !!(s && s.status !== 'eliminated' && s.checkIn && s.checkOut && s.checkIn <= s.checkOut);
  }

  // The set of ISO dates on which `stays` put the traveler inside the window
  // [fromISO, toISO], both inclusive, counting checkOut as a day present.
  // `pred` selects which stays count. The return is a plain object used as a
  // set, which is how the rest of this file spells "no duplicates" without a
  // Set dependency. `tag` (optional) is called per counted date so a caller can
  // attribute the day to a state or a country without walking the dates twice;
  // the FIRST stay to claim a date owns it, which is what makes an overlap one
  // day rather than two.
  function presenceDates(stays, pred, fromISO, toISO, tag) {
    var seen = {};
    (stays || []).forEach(function (s) {
      if (!countableStay(s) || !pred(s)) return;
      var start = s.checkIn > fromISO ? s.checkIn : fromISO;
      var end = s.checkOut < toISO ? s.checkOut : toISO;   // checkOut counts
      if (end < start) return;
      var d = start;
      // Guard: a corrupt row with a wild checkOut must not spin forever.
      for (var n = 0; d <= end && n < 4000; n++) {
        if (!Object.prototype.hasOwnProperty.call(seen, d)) {
          seen[d] = 1;
          if (tag) tag(d, s);
        }
        d = addDaysIso(d, 1);
      }
    });
    return seen;
  }

  function countKeys(o) {
    var n = 0;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
    return n;
  }

  // Schengen 90/180 at a reference date: days of presence in the 180-day window
  // ending on refISO, that day included. 180 days means refISO minus 179.
  var SCHENGEN_WINDOW_DAYS = 180;
  var SCHENGEN_LIMIT = 90;

  function schengenUsedAt(stays, refISO) {
    if (!refISO) return 0;
    var from = addDaysIso(refISO, -(SCHENGEN_WINDOW_DAYS - 1));
    return countKeys(presenceDates(stays, function (s) { return schengenMember(s.country); }, from, refISO));
  }

  // The worst point ahead. Every stay's LAST day is a candidate peak, because
  // the count only ever rises while you are inside the zone; checking the last
  // day of each stay finds the maximum without walking every date in the plan.
  function schengenPeak(stays) {
    var members = (stays || []).filter(function (s) { return countableStay(s) && schengenMember(s.country); });
    var peak = { days: 0, date: null };
    members.forEach(function (s) {
      var d = schengenUsedAt(stays, s.checkOut);
      if (d > peak.days) peak = { days: d, date: s.checkOut };
    });
    return peak;
  }

  // FEIE physical presence: US DAYS in a true rolling 12 months, which is
  // todayISO minus 364 through todayISO, both included, so the window is
  // exactly 365 days long. This used to be whatever the MAP FILTER happened to
  // be set to, which meant the number moved when the traveler changed a view.
  // It does not any more: a rolling window is a fact about the calendar, not a
  // view of the itinerary, so this counter ignores the filter entirely.
  var US_WINDOW_DAYS = 365;
  var FEIE_US_DAY_LIMIT = 35;
  var NO_STATE_LABEL = 'State not set';

  function usDaysRolling(stays, todayISO) {
    if (!todayISO) return { total: 0, byState: {} };
    var from = addDaysIso(todayISO, -(US_WINDOW_DAYS - 1));
    var byState = {};
    // A US stop with no state chosen used to be SKIPPED, so those days simply
    // vanished from a number the traveler files taxes against. They are counted
    // now and attributed to a named bucket, so the gap is visible rather than
    // silent.
    var seen = presenceDates(stays, function (s) { return usMember(s.country); }, from, todayISO, function (d, s) {
      var key = (s.state && String(s.state).replace(/^\s+|\s+$/g, '')) || NO_STATE_LABEL;
      byState[key] = (byState[key] || 0) + 1;
    });
    return { total: countKeys(seen), byState: byState };
  }

  // Days by country, over whatever window the caller passes. This one IS a view
  // of the itinerary rather than a legal fact, so the map filter still scopes
  // it; the caller supplies the range.
  function countryDays(stays, fromISO, toISO) {
    var byCountry = {};
    presenceDates(stays, function () { return true; }, fromISO, toISO, function (d, s) {
      var key = String(s.country || '').replace(/^\s+|\s+$/g, '') || 'Unknown';
      byCountry[key] = (byCountry[key] || 0) + 1;
    });
    return byCountry;
  }

  // Budget variance against a monthly target, as three real branches. The old
  // code had two that were exact complements ("over by more than 5%" and "at or
  // under 5% over"), so the amber middle could never fire and anything from
  // dead-on to 5% OVER target printed "Under target", by a negative amount.
  var BUDGET_BAND = 0.05;

  function budgetVariance(avgPerMonth, target) {
    if (!(target > 0)) return null;
    var delta = avgPerMonth - target;
    var band = target * BUDGET_BAND;
    var pct = delta / target * 100;
    if (delta > band) return { kind: 'over', delta: delta, pct: pct };
    if (delta < -band) return { kind: 'under', delta: delta, pct: pct };
    return { kind: 'on', delta: delta, pct: pct };
  }

  // ---- the public share ----
  //
  // Replaces the GitHub-PAT publish. A share is one row in public.shares keyed
  // by an unguessable token; anonymous readers reach it through exactly one
  // door, the get_share(token) function, and never the table.
  //
  // Everything here is PURE. The token comes from crypto in the shell (injected
  // as a byte source so the test can pin the hex encoding), the network lives in
  // the shell, and what a snapshot may contain lives here, where it can be
  // tested without a browser.
  //
  // The snapshot is a SNAPSHOT: what was true when Publish was pressed. It does
  // not follow the trip. That is a product decision (a link that silently starts
  // showing tomorrow's plans is a link nobody can reason about) and the share
  // page says so in as many words.
  var SHARE_SCHEMA = 1;
  var SHARE_TOKEN_BYTES = 16;    // 32 hex characters
  var SHARE_NAME_CAP = 24;       // the cosmetic half of a token, at most
  var SHARE_GUIDE_CAP = 40;
  var SHARE_ITEM_CAP = 500;
  var SHARE_TEXT_CAP = 2000;

  function shareText(v) {
    return (typeof v === 'string') ? v.slice(0, SHARE_TEXT_CAP) : '';
  }

  // The cosmetic half of a share token: the traveler's own display name, made
  // safe for a URL. Same rules as slug() above (lowercase, every run of
  // non-alphanumerics collapsed to one hyphen, hyphens trimmed off both ends),
  // with one addition: accented letters are decomposed first so their base
  // letter survives. slug() cannot do that, because it names city ids and
  // changing it would rename every id already stored; a share name half has no
  // such history and "ana-munoz" reads better in a link than "ana-mu-oz".
  //
  // Capped at SHARE_NAME_CAP characters, and trimmed AGAIN after the cap so a
  // cut that lands mid-hyphen cannot leave a trailing one. Anything that
  // slugifies to nothing (empty, emoji only, punctuation only) returns '', and
  // the caller falls back to the random half alone rather than shipping a bare
  // hyphen or an empty prefix.
  function shareNameSlug(name) {
    var s = (typeof name === 'string') ? name : '';
    if (typeof s.normalize === 'function') {
      try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep s */ }
    }
    return slug(s).slice(0, SHARE_NAME_CAP).replace(/^-+|-+$/g, '');
  }

  // A share token: <name-slug>-<32 hex>, or just <32 hex> when there is no
  // usable name.
  //
  // ENTROPY. All of it lives in the hex half and none of it in the name.
  // SHARE_TOKEN_BYTES = 16 bytes out of crypto.getRandomValues is 128 bits,
  // rendered as 32 lowercase hex characters. Adding a readable prefix does not
  // spend one bit of that: the prefix is public information (it is the name
  // already printed on the share page) and an attacker who knows it still faces
  // the same 2^128 search. Two shares by the same person differ in the hex half
  // and only there. Never shorten the hex half to make room for a longer name.
  //
  // `bytes` is whatever crypto.getRandomValues filled: an array-like of
  // numbers. Anything that is not a byte source is refused rather than quietly
  // producing a weak token, because a predictable token is the whole security
  // model gone. `name` is optional and never affects that refusal.
  function shareToken(bytes, name) {
    if (!bytes || typeof bytes === 'string' || typeof bytes.length !== 'number' ||
        bytes.length < SHARE_TOKEN_BYTES) {
      throw new Error('shareToken needs at least ' + SHARE_TOKEN_BYTES + ' random bytes');
    }
    var out = '';
    for (var i = 0; i < SHARE_TOKEN_BYTES; i++) {
      // Anything that is not a number is not entropy, and treating it as zero
      // would silently shorten the token's real length. Refuse instead.
      if (typeof bytes[i] !== 'number' || !isFinite(bytes[i])) {
        throw new Error('shareToken was given something that is not a byte source');
      }
      var b = bytes[i] & 255;
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    var prefix = shareNameSlug(name);
    return prefix ? prefix + '-' + out : out;
  }

  // One token string, validated. Shared by both spellings below so the hash and
  // the query can never disagree about what a token looks like.
  //
  // Deliberately NOT one regular expression. The shape is "an optional slug, a
  // hyphen, then the hex", and the natural regex for that nests a quantifier
  // inside a quantifier, which backtracks catastrophically on a long
  // hyphen-only fragment. Splitting on the LAST hyphen is linear and needs no
  // backtracking at all: the hex half never contains one, so that hyphen is
  // always the seam.
  //
  // Old links keep working untouched. A token issued before this existed is 32
  // bare hex characters, has no hyphen, and takes the no-prefix path.
  function shareTokenValue(raw) {
    var s = trimStr(raw).toLowerCase();
    if (!s || s.length > SHARE_NAME_CAP + 1 + 64) return '';
    if (!/^[a-z0-9-]+$/.test(s)) return '';
    var at = s.lastIndexOf('-');
    var rand = (at === -1) ? s : s.slice(at + 1);
    if (!/^[0-9a-f]{32,64}$/.test(rand)) return '';
    if (at !== -1) {
      var prefix = s.slice(0, at);
      // A prefix that is empty, edged with a hyphen, or carrying a doubled one
      // is not something shareNameSlug can produce, so it is not a token.
      if (!prefix || prefix.charAt(0) === '-' ||
          prefix.charAt(prefix.length - 1) === '-' || prefix.indexOf('--') !== -1) return '';
    }
    return s;
  }

  // The token a share URL carries. Two spellings are accepted because both get
  // typed by hand and pasted by people: /share/#<token> and /share/?t=<token>.
  // The hash is the one the app generates: a fragment is never sent to the
  // server, never lands in a Pages access log, and never leaks through a
  // Referer header to a link the reader clicks from the page.
  function shareTokenFromUrl(hash, search) {
    var h = shareTokenValue(trimStr(hash).replace(/^#/, ''));
    if (h) return h;
    var q = trimStr(search).replace(/^\?/, '');
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv[0] !== 't' && kv[0] !== 'token') continue;
      var v = '';
      try { v = decodeURIComponent(kv.slice(1).join('=') || ''); } catch (e) { v = ''; }
      var got = shareTokenValue(v);
      if (got) return got;
    }
    return '';
  }

  function shareUrl(origin, token) {
    return trimStr(origin).replace(/\/+$/, '') + '/share/#' + trimStr(token);
  }

  // The origin a share link may be built on, or the fallback.
  //
  // A share link is read by FAMILY, on their phone, days after it was sent. So
  // the only origin worth putting in one is an origin that resolves for
  // somebody who is not us: https, and not a loopback name. http, file://,
  // localhost and 127.0.0.1 all fall back, because a link that only opens on
  // the machine that made it is worse than no link at all. That was the whole
  // argument for hardcoding this, and it is preserved here rather than lost.
  //
  // What deriving buys, and it is not hypothetical: the app moved host once
  // already (2026-09-01) and every link built before the move died with it,
  // because the host was a constant in a shipped file. Derived, the next move
  // costs nothing and no already-published token has to be rotated to follow
  // it. The retired address is deliberately not written out anywhere here: a
  // test asserts no shipped byte still names it.
  //
  // Takes the origin as an argument rather than reading location itself so it
  // stays pure and testable; the caller passes location.origin.
  function publicOrigin(origin, fallback) {
    var o = trimStr(origin);
    var m = o.match(/^https:\/\/(\[[^\]]+\]|[^:\/?#]+)(?::\d+)?$/);
    if (!m) return fallback;
    var host = m[1].toLowerCase();
    if (host === 'localhost' || /\.localhost$/.test(host) ||
        host === '127.0.0.1' || host === '[::1]') return fallback;
    return o;
  }

  // One stop on the trip, as family sees it.
  //
  // What is DROPPED here is the point of the function. Cost, the nightly rate,
  // the estimated total, the booking confirmation number, admin notes, and the
  // `paid` flag on a stay all stay behind. `paid` in particular: a public page
  // that says which nights are still owed for is a page that tells a stranger
  // when the traveler is carrying cash. That decision was made for the family
  // page in batch 3 and it is unchanged here.
  //
  // `hideLodging` is the per-share "Hide where I am staying" option. A trip
  // shared with family may name the flat; a trip shared with a business contact
  // may not, because the property somebody sleeps in is not a business fact.
  //
  // It is enforced HERE, in the builder, and never in the share page's
  // rendering. The snapshot is what gets written to the shares row and handed
  // to anyone with the link, so a reader who opens the payload rather than the
  // page has to find nothing. A render-time filter would still have shipped the
  // address.
  //
  // What a hidden stay keeps is the CITY and the DATES, which is what makes the
  // route legible: family and colleagues both still see which town, which
  // nights. What it loses is the name, the neighbourhood, the booking link and
  // the status.
  //
  // Status goes too, and that is a deliberate call rather than an oversight.
  // "booked" on a nameless stay tells a reader nothing they can act on, while
  // it still leaks the one bit that matters: whether the traveler has committed
  // to a place yet, which is exactly the negotiating detail a business contact
  // should not be reading. Dropping it also collapses the booked-versus-
  // shortlisted split in the page, which is what lets identical hidden stays
  // dedupe below.
  //
  // Hidden stays are deduped on city plus dates, and one with neither is
  // dropped outright. Three shortlisted flats for the same week would otherwise
  // draw three identical anonymous rows, which both looks broken and counts out
  // loud how many places are still under consideration.
  function shareStay(a, hideLodging) {
    if (!hideLodging) {
      return {
        name: shareText(a.name),
        city: shareText(a.city),
        neighborhood: shareText(a.neighborhood),
        link: safeHref(a.link) || '',
        status: shareText(a.status),
        checkIn: shareText(a.checkIn),
        checkOut: shareText(a.checkOut)
      };
    }
    return {
      hidden: true,
      city: shareText(a.city),
      checkIn: shareText(a.checkIn),
      checkOut: shareText(a.checkOut)
    };
  }

  function shareStop(c, hideLodging) {
    var stays = ((c && c.accommodations) || [])
      .filter(function (a) { return a && (a.status === 'booked' || a.status === 'shortlisted'); })
      .map(function (a) { return shareStay(a, hideLodging); });
    if (hideLodging) {
      var seen = Object.create(null);
      stays = stays.filter(function (s) {
        if (!s.city && !s.checkIn && !s.checkOut) return false;
        var key = s.city + '|' + s.checkIn + '|' + s.checkOut;
        if (seen[key]) return false;
        seen[key] = 1;
        return true;
      });
    }
    return {
      id: shareText(c && c.id),
      name: shareText(c && c.name),
      country: shareText(c && c.country),
      state: shareText(c && c.state),
      status: shareText(c && c.status) || 'tentative',
      checkIn: shareText(c && c.checkIn),
      checkOut: shareText(c && c.checkOut),
      lat: (c && typeof c.lat === 'number' && isFinite(c.lat)) ? c.lat : undefined,
      lng: (c && typeof c.lng === 'number' && isFinite(c.lng)) ? c.lng : undefined,
      accommodations: stays
    };
  }

  // One travel leg. Cost, confirmation number and the admin-only notes field
  // are dropped; the carrier and flight number are kept, because "which flight
  // are they on" is the question the page exists to answer.
  function shareLeg(t, stops) {
    var src = null;
    for (var i = 0; i < stops.length; i++) {
      if (stops[i] && stops[i].id === (t && t.cityId)) { src = stops[i]; break; }
    }
    return {
      fromCityId: shareText(t && t.cityId),
      mode: shareText(t && t.mode) || 'other',
      status: shareText(t && t.status) || 'tentative',
      fromCity: shareText(t && t.fromCity) || (src ? src.name : ''),
      toCity: shareText(t && t.toCity),
      departureDate: shareText(t && t.departureDate),
      departureTime: shareText(t && t.departureTime),
      arrivalDate: shareText(t && t.arrivalDate),
      arrivalTime: shareText(t && t.arrivalTime),
      carrier: shareText(t && t.carrier),
      number: shareText(t && t.number)
    };
  }

  // One city guide, in the Share-view idiom the app itself already uses: intel
  // VERDICTS only (no tips, no source, no checked date) and a rating as stars
  // only (no count, no provenance). See intelShareStrip and ratingBadge.
  //
  // Dropped outright, and each for its own reason:
  //   city.accommodation   the lodging name and its coordinates. The trip half
  //                        decides what lodging is public and at what grain;
  //                        two sources could contradict each other.
  //   city.notes           free-text personal notes about the stay.
  //   city.currency        no reader on a read-only page.
  //   item.place_id        provenance, meaningless outside the app.
  //   item.verified        the same.
  //   per-city STATE       done/pinned/dates overrides live in city_state,
  //                        which the snapshot builder never reads at all.
  //   genmeta              the Add/Edit form fields (accommodation address,
  //                        arrival and departure transport, and the trip notes
  //                        that say diet, mobility, budget and who is along).
  //                        Never read here, on purpose: see the report.
  function shareGuide(row) {
    var data = (row && row.data && typeof row.data === 'object') ? row.data : {};
    var city = (data.city && typeof data.city === 'object') ? data.city : {};
    var dates = (city.dates && typeof city.dates === 'object') ? city.dates : {};
    var sections = (Array.isArray(data.sections) ? data.sections : []).map(function (s) {
      return { id: shareText(s && s.id), label: shareText(s && s.label), icon: shareText(s && s.icon) };
    }).filter(function (s) { return s.id; });
    var items = (Array.isArray(data.items) ? data.items : []).slice(0, SHARE_ITEM_CAP).map(function (it) {
      var o = {
        id: shareText(it && it.id),
        section: shareText(it && it.section),
        status: shareText(it && it.status) || 'plan',
        day: shareText(it && it.day),
        when: shareText(it && it.when),
        name: shareText(it && it.name),
        note: shareText(it && it.note),
        price: shareText(it && it.price && it.price.text),
        hours: shareText(it && it.hours && it.hours.text),
        tags: (Array.isArray(it && it.tags) ? it.tags : []).map(shareText).filter(Boolean),
        links: (Array.isArray(it && it.links) ? it.links : []).map(function (l) {
          return { kind: shareText(l && l.kind) || 'web', label: shareText(l && l.label), href: safeHref(l && l.href) || '' };
        }).filter(function (l) { return l.href; })
      };
      var stars = it && it.rating && it.rating.stars;
      if (typeof stars === 'number' && isFinite(stars)) o.stars = stars;
      var verdicts = it && it.intel && it.intel.verdicts;
      if (Array.isArray(verdicts) && verdicts.length) {
        // A verdict carries `tier` (must|good|skip), which is the whole point of
        // it: Must / Good / Skip is the judgement, the text is the reason. This
        // used to copy `v.label`, a field no verdict has ever had, so every
        // published share rendered the reason with no verdict attached to it.
        // Carry the tier, and fall back to the middle tier rather than dropping
        // a verdict whose tier a hand-edited guide left off.
        o.verdicts = verdicts.map(function (v) {
          var t = v && v.tier;
          return {
            tier: (t === 'must' || t === 'skip' || t === 'good') ? t : 'good',
            text: shareText(v && v.text)
          };
        });
      }
      return o;
    }).filter(function (it) { return it.id && it.name; });
    return {
      id: shareText(row && row.city_id),
      name: shareText(city.name),
      country: shareText(city.country),
      from: shareText(dates.from),
      to: shareText(dates.to),
      sections: sections,
      items: items
    };
  }

  // The whole snapshot, from the trip state and (optionally) the guide rows the
  // traveler picked. `input.guides` is the raw rows as PostgREST returned them,
  // {city_id, data}; `input.includeGuides` is the id list the picker produced.
  // An empty list means "trip only", which is the default.
  function buildShareSnapshot(input) {
    var i = input || {};
    var hideLodging = !!i.hideLodging;
    var stops = (Array.isArray(i.cities) ? i.cities : [])
      .map(function (c) { return shareStop(c, hideLodging); })
      .filter(function (c) { return c.name; });
    var legs = (Array.isArray(i.transitions) ? i.transitions : [])
      .filter(function (t) { return t && (t.toCity || t.departureDate); })
      .map(function (t) { return shareLeg(t, stops); });
    var want = Object.create(null);
    (Array.isArray(i.includeGuides) ? i.includeGuides : []).forEach(function (id) {
      if (typeof id === 'string' && id) want[id] = 1;
    });
    var guides = (Array.isArray(i.guides) ? i.guides : [])
      .filter(function (r) { return r && Object.prototype.hasOwnProperty.call(want, r.city_id); })
      .slice(0, SHARE_GUIDE_CAP)
      .map(shareGuide)
      .filter(function (g) { return g.id && g.name; });
    return {
      schema: SHARE_SCHEMA,
      travelerName: shareText(i.travelerName) || 'Your traveler',
      generatedAt: shareText(i.generatedAt) || EPOCH_ISO,
      cities: stops,
      transitions: legs,
      guideIds: (Array.isArray(i.guideIds) ? i.guideIds : []).map(shareText).filter(Boolean),
      guides: guides
    };
  }

  // ---- many links, one account ----
  //
  // A share used to be a singular: one token per person, so rotating the link
  // family holds also killed the link a colleague was sent. It is a LIST now,
  // and every entry carries its own audience: its own label, its own scope, its
  // own guide picks, its own "hide where I am staying". A family link that
  // names the flat and a work link that does not can be alive at the same time.
  //
  // The list rides the trip blob, which is what makes it sync. The label in
  // particular lives HERE and not in the database row: the table gained a label
  // column in the same migration that lifted the one-per-user constraint, but
  // the app deliberately never writes it, so publishing works identically
  // whether or not that column exists yet. See shareWriteFailure below for the
  // one thing that genuinely does need the migration.
  var SHARE_LIST_CAP = 5;
  var SHARE_LABEL_CAP = 32;
  // Suggestions, in order, for what a new link is for. Rob's two are the first
  // two on purpose: family sees the bed, work does not.
  var SHARE_LABEL_SUGGESTIONS = ['Family', 'Work', 'Friends', 'Guests', 'Spare'];

  function shareLabel(v) {
    return trimStr(v).slice(0, SHARE_LABEL_CAP);
  }

  // A row id names that row's controls and its DOM nodes, and nothing else. It
  // is never a secret and never goes in a URL. Restricted to characters that
  // are safe in an element id and as an object key, so a blob arriving from
  // anywhere cannot reach past the row it labels.
  function shareIdOf(v) {
    return trimStr(v).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  }

  // One row of the list, normalized. A row with no token is a DRAFT: it has
  // been created in the UI and given settings, but nothing has been published
  // yet, so no link exists. That is a real state and it is kept, because the
  // alternative is a New-share-link button that publishes before the user has
  // said what the link should contain.
  //
  // A token that does not survive shareTokenValue is dropped rather than
  // carried: a malformed one names no row the RPC could ever find, so keeping
  // it would show a link that opens nothing.
  function shareEntry(raw, fallbackId) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var seen = Object.create(null);
    var guideIds = (Array.isArray(r.guideIds) ? r.guideIds : []).filter(function (id) {
      if (typeof id !== 'string' || !id || seen[id]) return false;
      seen[id] = 1;
      return true;
    }).slice(0, SHARE_GUIDE_CAP);
    return {
      id: shareIdOf(r.id) || shareIdOf(fallbackId),
      token: shareTokenValue(r.token),
      label: shareLabel(r.label),
      scope: (r.scope === 'guides') ? 'guides' : 'trip',
      guideIds: guideIds,
      hideLodging: !!r.hideLodging,
      updated: shareText(r.updated)
    };
  }

  // The whole list, normalized, deduped by token and capped.
  //
  // Deduping by token matters because two rows pointing at one database row
  // would let a rotate on one silently change the other's link, which is the
  // exact cross-talk this feature exists to end. Drafts (no token) never
  // collide with each other.
  //
  // `idFor(entry, index)` supplies an id to a row that arrived without one.
  // The default is derived from the token so it is stable across devices and
  // deterministic in a test; the shell passes a random one for rows it creates.
  function shareList(raw, idFor) {
    var make = (typeof idFor === 'function') ? idFor : function (e, i) {
      return e.token ? 's-' + e.token.slice(-8) : 'draft-' + (i + 1);
    };
    var out = [];
    var seen = Object.create(null);
    var ids = Object.create(null);
    (Array.isArray(raw) ? raw : []).forEach(function (r, i) {
      if (out.length >= SHARE_LIST_CAP) return;
      var e = shareEntry(r, '');
      if (e.token) {
        if (seen[e.token]) return;
        seen[e.token] = 1;
      }
      if (!e.id) e.id = shareIdOf(make(e, i));
      // Two rows answering to one id would make every per-row control ambiguous.
      if (!e.id || ids[e.id]) e.id = 'share-' + (i + 1) + '-' + out.length;
      ids[e.id] = 1;
      out.push(e);
    });
    return out;
  }

  // Folds a trip blob into the list, whichever shape it is in.
  //
  // A blob written by this build carries `shares` and that is the answer, even
  // when it is empty: an empty list means the user deleted their links, and
  // resurrecting one from the legacy fields would bring back a link they took
  // down. Only a blob with NO list at all is read the old way, and then the
  // single share it describes becomes entry one with its token preserved
  // exactly, because that token is a link somebody is already holding.
  //
  // A blob with neither (a device that never shared) yields an empty list.
  function migrateShares(blob, idFor) {
    var b = (blob && typeof blob === 'object') ? blob : {};
    if (Array.isArray(b.shares)) return shareList(b.shares, idFor);
    var token = shareTokenValue(b.shareToken);
    if (!token) return [];
    return shareList([{
      token: token,
      label: shareLabel(b.shareLabel) || SHARE_LABEL_SUGGESTIONS[0],
      scope: b.shareScope,
      guideIds: b.shareGuideIds,
      hideLodging: b.shareHideLodging,
      updated: b.lastPublishedAt
    }], idFor);
  }

  // The reverse fold: what the legacy fields must say so a device still running
  // the previous build keeps working for one release.
  //
  // It mirrors the first PUBLISHED row, not simply the first row, because a
  // draft has no token and an old device reading a blank one would decide the
  // share had been taken down and hide its Copy control over a link that is
  // still live.
  function shareLegacyFields(list) {
    var first = null;
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (!first && e && e.token) first = e;
    });
    if (!first) {
      return { shareToken: '', shareScope: 'trip', shareGuideIds: [], shareHideLodging: false };
    }
    return {
      shareToken: first.token,
      shareScope: (first.scope === 'guides') ? 'guides' : 'trip',
      shareGuideIds: (first.guideIds || []).slice(),
      shareHideLodging: !!first.hideLodging
    };
  }

  // The name to put in a new row's box: the first suggestion not already taken,
  // then a numbered fallback. Case-insensitive, so a second "family" is not
  // offered to somebody who already has "Family".
  function shareLabelSuggestion(list) {
    var taken = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (e && e.label) taken[e.label.toLowerCase()] = 1;
    });
    for (var i = 0; i < SHARE_LABEL_SUGGESTIONS.length; i++) {
      if (!taken[SHARE_LABEL_SUGGESTIONS[i].toLowerCase()]) return SHARE_LABEL_SUGGESTIONS[i];
    }
    var n = (Array.isArray(list) ? list.length : 0) + 1;
    while (taken[('link ' + n).toLowerCase()]) n++;
    return 'Link ' + n;
  }

  // Why another link cannot be made, or '' when it can. A reason, not a
  // boolean, because the button that goes quiet has to be able to say why:
  // a disabled control with no explanation is the dead end house rules forbid.
  function shareAddBlocked(list) {
    var n = (Array.isArray(list) ? list : []).length;
    if (n >= SHARE_LIST_CAP) {
      return 'You have ' + SHARE_LIST_CAP + ' share links, which is the limit. ' +
        'Delete one you no longer send to make room for another.';
    }
    return '';
  }

  // What a failed share write MEANS, from the status and the body PostgREST
  // sent. Same shape of decision as refreshFailure above: the status alone
  // cannot tell a setup step from a fault, and only the body says which.
  //
  //   'no-table'         the shares table has not been created at all.
  //   'one-share-limit'  the table still carries unique(user_id) from before
  //                      multiple links existed, so the INSERT of a second row
  //                      hit it. The migration has not been run yet.
  //   'other'            anything else; the caller shows the raw failure.
  //
  // The one-share shape, as PostgREST returns a 23505 (checked against the
  // documented error mapping; the body is passed through from Postgres):
  //   409 {"code":"23505","details":"Key (user_id)=(...) already exists.",
  //        "hint":null,
  //        "message":"duplicate key value violates unique constraint \"shares_user_id_key\""}
  // The constraint's real name is whatever the original create table produced,
  // so it is not matched on: the code, the standard message text, and the fact
  // that user_id is the column named in the details are what identify it. The
  // token half cannot be the colliding one, since it is 128 fresh random bits.
  var SHARE_DUP_CODE_RE = /"code"\s*:\s*"?23505"?/;
  var SHARE_DUP_TEXT_RE = /duplicate key value violates unique constraint/i;
  var SHARE_DUP_USER_RE = /user_id/i;

  function shareWriteFailure(status, bodyText) {
    var s = Number(status);
    var b = String(bodyText === null || bodyText === undefined ? '' : bodyText);
    if (s === 404 || /PGRST205/.test(b)) return 'no-table';
    var dup = SHARE_DUP_CODE_RE.test(b) || SHARE_DUP_TEXT_RE.test(b);
    if (!dup) return 'other';
    // Named the user_id column: unambiguous. Or a 409 duplicate on an insert
    // carrying a fresh token, which by elimination is the same constraint.
    if (SHARE_DUP_USER_RE.test(b) || s === 409) return 'one-share-limit';
    return 'other';
  }

  // A last line of defence, not the mechanism. The mechanism is that the
  // builders above copy a fixed field list and nothing else. This is what the
  // test asserts on, and what a future field addition trips over.
  //
  // `accommodation` (singular) is the CITY-GUIDE field: the lodging address and
  // its coordinates on a city row. shareGuide has never copied it, and this
  // pins that. It is not the trip side's `accommodations` (plural), which is a
  // legitimate part of a snapshot and which the hideLodging option above is
  // what strips. The two names differ by one letter and the sweep matches keys
  // exactly, so they do not collide.
  var SHARE_FORBIDDEN = ['apiKey', 'apikey', 'github', 'githubToken', 'githubUser',
    'githubRepo', 'githubFile', 'token', 'access_token', 'refresh_token',
    'genmeta', 'paid', 'cost', 'confirmation', 'notes', 'accommodation'];

  function shareLeaks(snapshot) {
    var found = [];
    (function walk(v) {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(walk); return; }
      Object.keys(v).forEach(function (k) {
        if (SHARE_FORBIDDEN.indexOf(k) !== -1 && found.indexOf(k) === -1) found.push(k);
        walk(v[k]);
      });
    })(snapshot);
    return found;
  }

  // What a failed token refresh means. A refresh that fails because the token
  // is genuinely gone must sign the device out and SAY so; anything else
  // (offline, rate limited, a 5xx, a paused project, a misconfigured key) must
  // keep the session, because dropping it there throws away the only refresh
  // token the device has over a problem that fixes itself. The status alone
  // does not tell the two apart: GoTrue answers both with a 400 or a 403, and
  // only the body says which.
  //
  // The patterns below are the shapes the live project actually returns
  // (checked 2026-08-25 against ggscdbbvqmqiyguiccrf), not a guess:
  //   {"code":400,"error_code":"validation_failed","msg":"Refresh token is not valid"}
  //   {"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}
  //   {"code":400,"error_code":"refresh_token_already_used","msg":"Invalid Refresh Token: Already Used"}
  //   {"error":"invalid_grant","error_description":"Invalid Refresh Token: ..."}   (older GoTrue)
  // So: an explicit invalid_grant, or a body that names the refresh token AND
  // says something is wrong with it. Anything vaguer is treated as transient,
  // which errs toward keeping a session rather than silently ending one.
  var DEAD_GRANT_RE = /invalid[_ -]?grant/i;
  var TOKEN_NAMED_RE = /refresh[_ -]?token/i;
  var TOKEN_BAD_RE = /not[_ -]?valid|invalid|expired|revoked|already[_ -]?used|not[_ -]?found/i;

  function refreshFailure(status, bodyText) {
    var s = Number(status);
    // Anything that is not a 4xx (unreadable, rate limited, a server error) is
    // transient by definition: it says nothing about the grant.
    if (!isFinite(s) || s < 400 || s >= 500 || s === 429) return 'transient';
    var b = String(bodyText || '');
    if (DEAD_GRANT_RE.test(b)) return 'dead';
    return (TOKEN_NAMED_RE.test(b) && TOKEN_BAD_RE.test(b)) ? 'dead' : 'transient';
  }

  function buildRows(field, entries) {
    var rows = [];
    (entries || []).forEach(function (e) {
      if (!e || !e.cityId || !e.payload || typeof e.payload !== 'object') return;
      var row = { city_id: e.cityId, updated_at: (typeof e.updatedAt === 'string' && e.updatedAt) ? e.updatedAt : EPOCH_ISO };
      row[field] = e.payload;
      rows.push(row);
    });
    return rows;
  }

  // GoTrue returns the magic-link session in the URL fragment. Both tokens are
  // required: an access token with no refresh token would die silently in an
  // hour with no way back, so that case is treated as no session at all.
  // When the fragment carries no expiry at all we mark it already expired,
  // which forces a refresh on first use rather than trusting an unknown TTL.
  function parseAuthHash(hash, nowMs) {
    var s = String(hash === null || hash === undefined ? '' : hash);
    if (s.charAt(0) === '#') s = s.slice(1);
    if (!s || s.indexOf('=') === -1) return null;
    var out = {};
    s.split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      if (i === -1) return;
      var k = pair.slice(0, i);
      var v = pair.slice(i + 1);
      try { k = decodeURIComponent(k); } catch (e) {}
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e2) {}
      if (k) out[k] = v;
    });
    if (!out.access_token || !out.refresh_token) return null;
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    var expSec;
    if (out.expires_at && /^\d+$/.test(out.expires_at)) expSec = parseInt(out.expires_at, 10);
    else if (out.expires_in && /^\d+$/.test(out.expires_in)) expSec = Math.floor(now / 1000) + parseInt(out.expires_in, 10);
    else expSec = Math.floor(now / 1000);
    return {
      access_token: out.access_token,
      refresh_token: out.refresh_token,
      token_type: out.token_type || 'bearer',
      expires_at: expSec,
      email: out.email || ''
    };
  }

  // True whenever the access token is missing, unreadable, or within 60s of
  // expiry. Accepts expires_at in seconds (GoTrue's own unit) or milliseconds.
  function sessionExpiringSoon(session, nowMs) {
    if (!session || !session.access_token) return true;
    var exp = session.expires_at;
    if (typeof exp === 'string' && /^\d+$/.test(exp)) exp = parseInt(exp, 10);
    if (typeof exp !== 'number' || !isFinite(exp)) return true;
    var ms = exp > 1e12 ? exp : exp * 1000;
    var now = (typeof nowMs === 'number') ? nowMs : Date.now();
    return (ms - now) < 60000;
  }

  // ---- entitlement: who may write, and what a lapsed account keeps ----
  //
  // The DATABASE is the enforcer. public.has_active_entitlement(uid) is checked
  // in the WITH CHECK of every write policy on cities, city_state, planahead and
  // shares, so a client that lied about any of this would simply have its writes
  // refused by Postgres. What lives here is the SAME decision in pure JS, for one
  // purpose only: saying so in words before the traveler walks into a wall.
  //
  // The two copies have to agree, which is why every number below is a named
  // constant that reads the same on the SQL side, and why the boundary cases
  // (trial expiry, the far edge of the grace window, a complimentary row, no row
  // at all) are unit tested here rather than discovered in production.
  //
  // Reads are never gated. A lapsed account keeps every city, every plan and
  // every export it ever made; what pauses is write-sync, one-tap AI and
  // publishing a link. That asymmetry is the product promise, not a detail.
  var ENT_TRIAL_DAYS = 14;
  var ENT_GRACE_DAYS = 7;
  var ENT_DAY_MS = 86400000;
  var ENT_TIERS = ['byok', 'managed', 'complimentary'];
  // What the paid tiers cost, in one place, so the gate copy and the plan block
  // cannot quote different numbers at the same person.
  var ENT_PRICE = {
    byok: '15 USD a month',
    managed: '29 USD a month'
  };
  var ENT_FROM = 'from ' + ENT_PRICE.byok;

  // Milliseconds, or null when there is nothing parseable. Date.parse returns
  // NaN for junk, and NaN is the one value that is not equal to itself.
  function entMs(v) {
    if (v === null || v === undefined || v === '') return null;
    var t = (v instanceof Date) ? v.getTime() : Date.parse(String(v));
    return t === t ? t : null;
  }

  // Whole days still to run, rounded UP, floored at zero: with six hours left
  // the honest thing to show a person is "1 day", not "0 days". Exactly at the
  // boundary it is 0, and the boundary is also where `entitled` goes false.
  function entDaysLeft(now, end) {
    if (end === null) return null;
    var d = Math.ceil((end - now) / ENT_DAY_MS);
    return d > 0 ? d : 0;
  }

  function entIso(ms) {
    return ms === null ? null : new Date(ms).toISOString();
  }

  // row: the subscriptions row for this user, or null when there is none.
  //      {tier, status, current_period_end, trial_ends_at, updated_at}
  // ctx: {now, accountCreated, signedIn}
  //
  // Returns a view model, never throws, and treats every unknown shape as
  // "not entitled" rather than guessing generously: the database would refuse
  // the write anyway, and promising otherwise is how a person loses work.
  function evaluateEntitlement(row, ctx) {
    var c = ctx || {};
    var now = entMs(c.now);
    if (now === null) now = Date.now();
    var out = {
      entitled: false,
      state: 'free',        // signed-out | trial | active | complimentary | grace | lapsed | free
      tier: '',             // '' | byok | managed | complimentary
      status: '',
      endsAt: null,         // when this state runs out; null when nothing runs out
      daysLeft: null,
      trialDays: ENT_TRIAL_DAYS,
      graceDays: ENT_GRACE_DAYS
    };
    if (c.signedIn === false) { out.state = 'signed-out'; return out; }

    if (!row || typeof row !== 'object') {
      // No row is not an error and not a refusal: it is the trial. The window
      // is measured from when the ACCOUNT was created, which is a fact only
      // auth.users holds, so there is nothing here for a client to forge.
      var made = entMs(c.accountCreated);
      if (made === null) return out;
      var trialEnds = made + ENT_TRIAL_DAYS * ENT_DAY_MS;
      if (now < trialEnds) {
        out.entitled = true;
        out.state = 'trial';
        out.status = 'trialing';
        out.endsAt = entIso(trialEnds);
        out.daysLeft = entDaysLeft(now, trialEnds);
      }
      return out;
    }

    out.tier = ENT_TIERS.indexOf(row.tier) === -1 ? '' : row.tier;
    out.status = typeof row.status === 'string' ? row.status : '';
    var periodEnd = entMs(row.current_period_end);
    var trialEnd = entMs(row.trial_ends_at);

    // Complimentary outranks status entirely. It is the row a person gets for
    // having been here before there was anything to pay for, and no Stripe
    // event can age it out, because no Stripe event ever touches it.
    if (out.tier === 'complimentary') {
      out.entitled = true;
      out.state = 'complimentary';
      return out;
    }
    if (out.status === 'active') {
      out.entitled = true;
      out.state = 'active';
      out.endsAt = entIso(periodEnd);
      out.daysLeft = entDaysLeft(now, periodEnd);
      return out;
    }
    if (out.status === 'trialing') {
      // A trial Stripe itself is running. trial_ends_at is respected whenever it
      // is present, because a webhook can arrive late and a trial that has ended
      // is over whatever the last stored status still says.
      if (trialEnd === null || now < trialEnd) {
        out.entitled = true;
        out.state = 'trial';
        out.endsAt = entIso(trialEnd);
        out.daysLeft = entDaysLeft(now, trialEnd);
        return out;
      }
      out.state = 'lapsed';
      return out;
    }
    if (out.status === 'past_due') {
      // A card that failed is usually a card that expired, not a person who
      // left. The grace window runs from the end of the period they already
      // paid for; with no period end stored, from when the row was last
      // written, so the window can never slide forward on every read.
      var base = periodEnd === null ? entMs(row.updated_at) : periodEnd;
      if (base === null) { out.state = 'lapsed'; return out; }
      var graceEnd = base + ENT_GRACE_DAYS * ENT_DAY_MS;
      if (now < graceEnd) {
        out.entitled = true;
        out.state = 'grace';
        out.endsAt = entIso(graceEnd);
        out.daysLeft = entDaysLeft(now, graceEnd);
        return out;
      }
      out.state = 'lapsed';
      return out;
    }
    // canceled, unpaid, incomplete, incomplete_expired, paused, or a status
    // Stripe has not invented yet. All of them mean the same thing here.
    out.state = 'lapsed';
    return out;
  }

  // What the Profile plan block says. Plain words, no countdown, no urgency:
  // a trial reports how many days are left because that is a fact the person
  // needs, and then stops talking about it.
  function entitlementSummary(ev) {
    var e = ev || {};
    var days = e.daysLeft;
    var tierName = e.tier === 'byok' ? 'Bring your own key'
      : e.tier === 'managed' ? 'Everything included'
      : e.tier === 'complimentary' ? 'Complimentary' : '';
    switch (e.state) {
      case 'signed-out':
        return {
          headline: 'Not signed in',
          detail: 'Everything you do is saved in this browser. Sign in above to see your plan.',
          cta: ''
        };
      case 'trial':
        return {
          headline: 'Free trial, ' + days + ' day' + (days === 1 ? '' : 's') + ' left',
          detail: 'You have all of it: your cities and plans on every device, one-tap AI, and share ' +
            'links. When the trial ends this account keeps working on this device, and everything ' +
            'you made stays yours to export.',
          cta: 'See the plans'
        };
      case 'active':
        return {
          headline: tierName || 'Subscribed',
          detail: (e.tier === 'byok' ? ENT_PRICE.byok
            : e.tier === 'managed' ? ENT_PRICE.managed
            : 'Your subscription is active') +
            (e.endsAt ? ', renews ' + entitlementDate(e.endsAt) + '.' : '.') +
            ' Everything is switched on: your work on every device, one-tap AI, and share links.',
          cta: 'Manage billing'
        };
      case 'complimentary':
        return {
          headline: 'Complimentary',
          detail: 'Full access, no charge and no renewal date. Nothing to do here.',
          cta: ''
        };
      case 'grace':
        return {
          headline: 'Your last payment did not go through',
          detail: 'Sync, one-tap AI and share links keep working until ' + entitlementDate(e.endsAt) +
            ' while you sort the card out. Nothing is deleted either way.',
          cta: 'Manage billing'
        };
      case 'lapsed':
        return {
          headline: 'Subscription ended',
          detail: 'You keep every city, every plan and every export you made. Sync across devices, ' +
            'one-tap AI and share links are paused until you subscribe again.',
          cta: 'See the plans'
        };
      default:
        return {
          headline: 'Free',
          detail: 'The whole app on this device, the copy-a-prompt AI path, and every export, at no ' +
            'charge and with no time limit. Carrying your work to another device, running AI in one ' +
            'tap, and share links are what a plan adds.',
          cta: 'See the plans'
        };
    }
  }

  // A date a person reads, not a timestamp. Deliberately no time of day: the
  // hour a subscription renews is not something anyone needs to plan around.
  var ENT_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  function entitlementDate(iso) {
    var ms = entMs(iso);
    if (ms === null) return 'its renewal date';
    var d = new Date(ms);
    return ENT_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }

  // The three moments the plan names: opening on a second device, tapping a
  // one-tap AI action, and tapping Publish. Every one of them names the free
  // thing that still works, in the same breath as the paid thing that does not.
  // A gate with no alternative is a dead end, and this app does not ship those.
  var ENT_GATE_ACTIONS = ['sync', 'ai', 'publish'];

  function entitlementGate(action, ev) {
    var e = ev || {};
    var lapsed = e.state === 'lapsed';
    var out = { title: '', body: '', keeps: '', cta: 'See the plans' };
    if (ENT_GATE_ACTIONS.indexOf(action) === -1) return out;

    if (action === 'sync') {
      out.title = lapsed ? 'Sync is paused' : 'Sync across devices needs a plan';
      out.body = lapsed
        ? 'Your subscription ended, so this device is on its own again. Everything you made is ' +
          'still here. Subscribe again and your devices catch up from where they left off.'
        : 'This device has everything you made and will keep it. Carrying it to your phone or ' +
          'your laptop is what a plan adds, ' + ENT_FROM + ' if you bring your own Claude key.';
      out.keeps = 'Either way you can export any guide or plan right now, as a file that needs ' +
        'no account and no internet to open.';
      return out;
    }
    if (action === 'ai') {
      out.title = lapsed ? 'One-tap AI is paused' : 'One-tap AI needs a plan';
      out.body = 'Copy the prompt, paste it into Claude or ChatGPT, and paste the answer back: ' +
        'that path is free, it is right here, and it is staying free. Running the same prompt in ' +
        'one tap with your own key is what a plan adds, ' + ENT_FROM + '.';
      out.keeps = 'The prompt is the same prompt. You are paying for the tap, not for the answer.';
      return out;
    }
    out.title = lapsed ? 'Publishing a link is paused' : 'Publishing a link needs a plan';
    out.body = 'Download the plan as an HTML file instead: it opens on anyone\'s phone, needs no ' +
      'account at the other end, and costs nothing. A link you can refresh from here, and switch ' +
      'off later, is what a plan adds, ' + ENT_FROM + '.';
    out.keeps = lapsed
      ? 'Links you already published keep working, and you can still delete any of them.'
      : 'Nothing you have already published is affected.';
    return out;
  }

  // The two paid tiers as the app describes them. `managed` is DECLARED here and
  // deliberately not SOLD yet: the server-side proxy that would run AI on our
  // key does not exist, and a tier that takes 29 USD for a capability that is
  // not built is a lie with a price on it. The shells read `sellable` and show
  // only what is true today; the day the proxy ships, this flag flips and the
  // schema, the webhook and the copy are already waiting for it.
  function entitlementPlans() {
    return [
      {
        tier: 'byok',
        name: 'Bring your own key',
        price: ENT_PRICE.byok,
        sellable: true,
        blurb: 'Your cities and plans on every device, one-tap AI using your own Anthropic key, ' +
          'and share links you can refresh or switch off.'
      },
      {
        tier: 'managed',
        name: 'Everything included',
        price: ENT_PRICE.managed,
        sellable: false,
        blurb: 'Everything above, with the AI running on our key so you never need one of your own.'
      }
    ];
  }

  // ---- the five states, on a laptop, with no Stripe account ----
  //
  // Free, trialing, active, past-due-in-grace and lapsed all have to be looked
  // at, at two widths, before they are shown to a stranger. Reaching them for
  // real would mean five Stripe subscriptions and five rows written against a
  // live account, so this builds the row instead, from the URL, ON LOCALHOST
  // ONLY.
  //
  // The hostname check is the whole safety property and it is checked here
  // rather than at the call site, because there is exactly one of these and
  // there would have been two of those. On the real origin it returns null for
  // every input, which is what the shipped-bytes test pins.
  function entitlementMock(href, hostname) {
    var host = String(hostname || '');
    if (host !== 'localhost' && host !== '127.0.0.1') return null;
    var m = /[?&#]plan=([a-z_-]+)/.exec(String(href || ''));
    if (!m) return null;
    var now = Date.now();
    var iso = function (ms) { return new Date(ms).toISOString(); };
    switch (m[1]) {
      case 'free':
        return { signed_in: true, entitled: false, account_created: iso(now - 60 * ENT_DAY_MS), row: null };
      case 'trial':
      case 'trialing':
        return { signed_in: true, entitled: true, account_created: iso(now - 3 * ENT_DAY_MS), row: null };
      case 'active':
        return { signed_in: true, entitled: true, account_created: iso(now - 90 * ENT_DAY_MS),
          row: { tier: 'byok', status: 'active', current_period_end: iso(now + 12 * ENT_DAY_MS),
            trial_ends_at: null, updated_at: iso(now), has_customer: true } };
      case 'grace':
      case 'past_due':
        return { signed_in: true, entitled: true, account_created: iso(now - 90 * ENT_DAY_MS),
          row: { tier: 'byok', status: 'past_due', current_period_end: iso(now - 2 * ENT_DAY_MS),
            trial_ends_at: null, updated_at: iso(now), has_customer: true } };
      case 'lapsed':
        return { signed_in: true, entitled: false, account_created: iso(now - 90 * ENT_DAY_MS),
          row: { tier: 'byok', status: 'canceled', current_period_end: iso(now - 30 * ENT_DAY_MS),
            trial_ends_at: null, updated_at: iso(now - 30 * ENT_DAY_MS), has_customer: true } };
      // The managed tier, which is the only one that ever draws an AI meter.
      // Its usage row comes from aiProxyKit.mock, keyed off the same fragment.
      case 'managed':
        return { signed_in: true, entitled: true, account_created: iso(now - 90 * ENT_DAY_MS),
          row: { tier: 'managed', status: 'active', current_period_end: iso(now + 12 * ENT_DAY_MS),
            trial_ends_at: null, updated_at: iso(now), has_customer: true } };
      case 'managed_capped':
        return { signed_in: true, entitled: true, account_created: iso(now - 90 * ENT_DAY_MS),
          row: { tier: 'managed', status: 'active', current_period_end: iso(now + 12 * ENT_DAY_MS),
            trial_ends_at: null, updated_at: iso(now), has_customer: true } };
      case 'comp':
      case 'complimentary':
        return { signed_in: true, entitled: true, account_created: iso(now - 200 * ENT_DAY_MS),
          row: { tier: 'complimentary', status: 'complimentary', current_period_end: null,
            trial_ends_at: null, updated_at: iso(now), has_customer: false } };
      default:
        return null;
    }
  }

  // What the free tier is, said once, so no two places in the app describe it
  // differently. This is a promise, not marketing: the copy-a-prompt path stays
  // free forever, and so does every export.
  function entitlementFree() {
    return {
      name: 'Free',
      price: 'no charge, no time limit',
      keeps: [
        'The whole app on one device, with as many cities and plans as you like',
        'The copy-a-prompt AI path, into Claude or ChatGPT or anything else',
        'Every export: standalone city guides, and the downloadable plan page'
      ],
      pauses: [
        'Your work following you to a second device',
        'Running an AI prompt in one tap from inside the app',
        'Share links you can refresh from here'
      ]
    };
  }

  // ---- managed AI: which transport, and what the meter says ----
  //
  // The 29 USD tier runs AI on OUR Anthropic key, through the ai-proxy edge
  // function. Nothing here talks to anything: it decides WHICH transport a
  // given device should use, and says in plain words how much of the month is
  // left. The proxy enforces every number below on its own, in the database,
  // under a lock; these copies exist so the app can say what is happening
  // before a refusal rather than after one.
  //
  // The three transports:
  //   direct  the traveler's OWN key, straight to api.anthropic.com, exactly as
  //           it has always worked. No cap of ours applies to it, ever. Their
  //           key, their bill, their business.
  //   proxy   our key, through the function, metered.
  //   none    neither is available, so the modal offers the free copy-a-prompt
  //           path instead and says why. Never a dead end.
  //
  // A saved key WINS over the proxy on purpose. Somebody who typed a key in is
  // telling us which bill they want this on, and quietly moving them onto ours
  // would be deciding their spend for them in the other direction.
  var AI_MONTHLY_OUTPUT_TOKENS = 350000;
  // What a whole city guide costs in output tokens, near enough to divide by.
  // It is a unit for the sentence a person reads, not an accounting figure: the
  // meter's real number is tokens, and it is shown right next to this.
  var AI_GUIDE_OUTPUT_TOKENS = 29000;
  var AI_MAX_TOKENS = 32000;
  var AI_LARGE_CALL_MIN_TOKENS = 8000;
  var AI_LARGE_CALLS_PER_HOUR = 5;
  // The tiers whose AI runs on our key. `managed` is the tier that is sold;
  // `complimentary` is a row only the owner writes, and the proxy decides for
  // itself whether to honour it (see AI_PROXY_TIERS). The app offering the
  // transport and the server allowing it are two different questions, and the
  // server's answer is the one that counts.
  var AI_MANAGED_TIERS = ['managed', 'complimentary'];

  // ctx: {hasKey, tier, entitled, signedIn}
  //
  // `entitled` is asked FIRST and for both transports, because one-tap AI is
  // what a plan buys whichever key it runs on: that is what the gate copy has
  // promised since Phase C. Note that the shells' entAllows() fails OPEN when
  // signed out or before the migration has run, so a free local device with a
  // key of its own keeps working exactly as it always did.
  function aiTransport(c) {
    var o = c || {};
    if (!o.entitled) return 'none';
    if (o.hasKey) return 'direct';
    if (!o.signedIn) return 'none';
    return AI_MANAGED_TIERS.indexOf(o.tier) === -1 ? 'none' : 'proxy';
  }

  // The function's URL, derived from the project URL the app already holds, so
  // there is no fourth place to keep a hostname in step.
  function aiProxyUrl(supaUrl) {
    var u = String(supaUrl || '');
    if (!u) return '';
    return u.replace(/\/+$/, '').replace('.supabase.co', '.functions.supabase.co') + '/ai-proxy';
  }

  function aiGuides(tokens) {
    return Math.round((tokens || 0) / AI_GUIDE_OUTPUT_TOKENS);
  }

  // usage: what my_ai_usage() returned, or null.
  // Returns {show, headline, detail, used, cap, pct, atCap}. `show` is false for
  // everyone whose AI is not on our key, which includes every bring-your-own-key
  // subscriber: their spend is theirs, and metering it back at them would be
  // reporting on money we do not touch.
  function aiMeter(usage) {
    var u = usage || {};
    var out = { show: false, headline: '', detail: '', used: 0, cap: AI_MONTHLY_OUTPUT_TOKENS,
      pct: 0, atCap: false, guidesUsed: 0, guidesCap: 0 };
    if (!u.signed_in || AI_MANAGED_TIERS.indexOf(u.tier) === -1) return out;
    var used = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
    var cap = AI_MONTHLY_OUTPUT_TOKENS;
    var guidesCap = Math.floor(cap / AI_GUIDE_OUTPUT_TOKENS);
    var guidesUsed = Math.min(aiGuides(used), guidesCap);
    out.show = true;
    out.used = used;
    out.cap = cap;
    out.pct = Math.min(100, Math.round((used / cap) * 100));
    out.atCap = used >= cap;
    out.guidesUsed = guidesUsed;
    out.guidesCap = guidesCap;
    // Plain words first, because "212,480 of 350,000 tokens" is not a sentence
    // anybody plans a week around. The number is still there, second, for the
    // person who wants it.
    out.headline = out.atCap
      ? 'You have used this month\'s included AI'
      : 'About ' + guidesUsed + ' of your ' + guidesCap + ' cities of research used this month';
    // "tokens", not "words". A token is roughly three quarters of a word, and
    // the friendly-sounding version would be wrong by a quarter to the one
    // person reading this line because they want the actual number.
    out.detail = used.toLocaleString ? used.toLocaleString() + ' of ' + cap.toLocaleString() +
      ' tokens of AI output, and it resets ' + aiResetPhrase(u.resets_at) + '.'
      : used + ' of ' + cap + ' tokens.';
    return out;
  }

  // The meter's own localhost-only mock, the twin of entitlementMock and gated
  // the same way and for the same reason: the two states worth LOOKING at (a
  // meter part way through a month, and a meter at the cap) cannot be reached
  // without a paying subscriber and a month of real spend. On the real origin
  // it returns null for every input, and that is what the shipped-bytes test
  // pins. Shape matches my_ai_usage() exactly.
  function aiUsageMock(href, hostname) {
    var host = String(hostname || '');
    if (host !== 'localhost' && host !== '127.0.0.1') return null;
    var m = /[?&#]plan=([a-z_-]+)/.exec(String(href || ''));
    if (!m) return null;
    var resets = new Date(Date.UTC(new Date().getUTCFullYear(),
      new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    if (m[1] === 'managed') {
      return { signed_in: true, tier: 'managed', resets_at: resets,
        output_tokens: 4 * AI_GUIDE_OUTPUT_TOKENS, held_tokens: 0,
        input_tokens: 51200, calls: 9 };
    }
    if (m[1] === 'managed_capped') {
      return { signed_in: true, tier: 'managed', resets_at: resets,
        output_tokens: AI_MONTHLY_OUTPUT_TOKENS, held_tokens: 0,
        input_tokens: 140000, calls: 26 };
    }
    return null;
  }

  function aiResetPhrase(iso) {
    var ms = entMs(iso);
    if (ms === null) return 'at the start of next month';
    return 'on ' + entitlementDate(new Date(ms).toISOString());
  }

  // What the app says when the proxy refuses. Never an error, never a dead end:
  // every one of these names the free copy-a-prompt path in the same breath,
  // because that path is right there in the same modal and always has been.
  // `reason` is what ai_reserve returned; anything unrecognised falls through to
  // a sentence that is still true.
  function aiPauseMessage(reason, info) {
    var i = info || {};
    var free = ' Copy the prompt and run it in your own Claude or ChatGPT: that path is free, ' +
      'it is right here, and the prompt is the same prompt.';
    switch (reason) {
      case 'over_monthly_cap':
        // The server distinguishes "all of it is gone" from "not enough left
        // for a run this size", and its sentence is the truer one when it is
        // there. The date and the free path are added either way.
        return (typeof i.message === 'string' && i.message
          ? i.message
          : 'You have used this month\'s included AI.') +
          ' It comes back ' + aiResetPhrase(i.resets_at) + '.' + free;
      case 'rate_limited':
        return 'That is as many AI runs as this plan does in an hour. The next one is available ' +
          'in a little while.' + free;
      case 'busy':
        return 'One AI run at a time. Let the one already going finish, or cancel it, then try ' +
          'again.' + free;
      case 'wrong_tier':
        return 'Your plan runs AI on your own Anthropic key. Add one in Profile, or switch to ' +
          'the plan that includes AI.' + free;
      case 'not_entitled':
        return 'AI on our key needs an active subscription.' + free;
      case 'paused':
        return 'AI on our key is paused right now.' + free;
      default:
        return 'That AI run could not start.' + free;
    }
  }

  // ---- DOM rendering (browser only) ----
  var ctx = null; // { base, store }; replaced wholesale when the app boots another city
  var drag = null; // { card, grip, startY, list, cards, sec } while a pointer drag is in progress
  var listenersBound = false; // window drag listeners bind once per page, not per boot

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function tierLabel(tier) {
    return tier === 'must' ? 'Must' : (tier === 'skip' ? 'Skip' : 'Good');
  }

  function verdictRow(v) {
    var p = el('p', 'verdict');
    p.appendChild(el('span', 'tier tier-' + v.tier, tierLabel(v.tier)));
    p.appendChild(document.createTextNode(v.text));
    return p;
  }

  function intelBody(intel, verdictsOnly) {
    var frag = document.createDocumentFragment();
    (intel.verdicts || []).forEach(function (v) { frag.appendChild(verdictRow(v)); });
    if (!verdictsOnly) {
      if (intel.tips && intel.tips.length) {
        var ul = el('ul', 'tips');
        intel.tips.forEach(function (t) { ul.appendChild(el('li', null, t)); });
        frag.appendChild(ul);
      }
      if (intel.source) frag.appendChild(el('p', 'intel-src', intel.source));
    }
    return frag;
  }

  // Full render (planner/calendar): inline when small, collapsed behind a
  // <details> toggle once there is enough content to be worth hiding.
  function intelStrip(intel) {
    var verdicts = intel.verdicts || [];
    var tips = intel.tips || [];
    var total = verdicts.length + tips.length;
    if (!total) return null;
    if (total <= 2) {
      var div = el('div', 'intel');
      div.appendChild(intelBody(intel, false));
      return div;
    }
    var det = el('details', 'intel');
    det.appendChild(el('summary', null, 'Intel: ' + verdicts.length + ' verdicts, ' + tips.length + ' tips'));
    det.appendChild(intelBody(intel, false));
    return det;
  }

  // Share view: verdicts only, always inline, no tips/source/details.
  function intelShareStrip(intel) {
    if (!intel.verdicts || !intel.verdicts.length) return null;
    var div = el('div', 'intel');
    div.appendChild(intelBody(intel, true));
    return div;
  }

  function linkIcon(kind) {
    return kind === 'map' ? '📍' : (kind === 'web' ? '🌐' : '📞');
  }

  function linkClass(kind) {
    return kind === 'map' ? 'maplink' : (kind === 'web' ? 'weblink' : 'phonelink');
  }

  // Guide JSON is untrusted input: it is pasted from an AI, imported from a
  // file someone sent, or pulled from a sync row. Its hrefs go straight into
  // the DOM, so a `javascript:` (or `data:`) URL would run on tap. Allowlist
  // the schemes a travel link can legitimately use and refuse everything else.
  // Returns the href to use, or null when the link must not go live.
  var LINK_SCHEMES = { 'http:': 1, 'https:': 1, 'tel:': 1, 'mailto:': 1, 'geo:': 1 };

  function safeHref(h) {
    var s = trimStr(h);
    if (!s) return null;
    // Browsers ignore control characters and whitespace while parsing a
    // scheme, so "java\tscript:alert(1)" is a live javascript: URL. Strip them
    // for the DECISION only; the href itself is returned unchanged.
    var probe = s.replace(/[\u0000-\u0020]/g, '').toLowerCase();
    var colon = probe.indexOf(':');
    // No colon at all: a relative URL, which can only resolve against this
    // page's own origin. A leading "//host" is scheme-relative, so it inherits
    // http(s) here, and is covered by the same reasoning.
    if (colon === -1) return s;
    // A colon that comes after the first /, ? or # belongs to a path or query,
    // not to a scheme ("place/x:1" is relative).
    var sep = probe.search(/[\/?#]/);
    if (sep !== -1 && sep < colon) return s;
    return LINK_SCHEMES[probe.slice(0, colon + 1)] ? s : null;
  }

  // A link whose scheme is not allowed still shows its label (the traveler
  // should see that the guide claimed a link and what it said), but as inert
  // text: no href, no target, nothing to tap.
  function deadLink(cls, text, label) {
    var span = el('span', cls + ' deadlink', text);
    span.title = 'Link removed: unsupported address' + (label ? ' for ' + label : '');
    return span;
  }

  function linkPill(l) {
    var href = safeHref(l.href);
    if (!href) return deadLink(linkClass(l.kind), linkIcon(l.kind) + ' ' + l.label, l.label);
    var a = document.createElement('a');
    a.href = href;
    a.className = linkClass(l.kind);
    if (l.kind !== 'tel') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.textContent = linkIcon(l.kind) + ' ' + l.label;
    return a;
  }

  // The same link, sized to sit in the control row beside the status icons
  // (density pass): icon only, control height, pill colouring kept so it
  // still reads as a thing that NAVIGATES rather than a thing that changes
  // the plan. The label the pill used to show becomes the tooltip and the
  // accessible name, exactly like every other icon control here.
  function linkCtl(l) {
    var href = safeHref(l.href);
    if (!href) return deadLink('ctl-link ' + linkClass(l.kind), linkIcon(l.kind), l.label);
    var a = document.createElement('a');
    a.href = href;
    a.className = 'ctl-link ' + linkClass(l.kind);
    if (l.kind !== 'tel') { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.textContent = linkIcon(l.kind);
    a.setAttribute('aria-label', l.label);
    a.title = l.label;
    return a;
  }

  // A rating as one compact badge: "4.8★" plus a muted "(442)" when the
  // count is there. Information, not action, so it wears neutral/muted
  // tokens and never the accent: nothing on this badge is tappable.
  // Provenance (source, checked date) rides in the tooltip rather than on
  // the card, since it is what you check when the number surprises you and
  // noise the rest of the time. `starsOnly` is the Share view.
  function fmtCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function ratingBadge(rating, starsOnly) {
    if (!rating || typeof rating.stars !== 'number' || !isFinite(rating.stars)) return null;
    var span = el('span', 'rating');
    span.appendChild(document.createTextNode(rating.stars.toFixed(1) + '★'));
    if (!starsOnly && typeof rating.count === 'number' && isFinite(rating.count)) {
      span.appendChild(el('span', 'rcount', '(' + fmtCount(rating.count) + ')'));
    }
    if (!starsOnly) {
      var t = [];
      if (rating.source) t.push(rating.source);
      if (rating.checked) t.push('checked ' + rating.checked);
      if (t.length) span.title = t.join(' · ');
    }
    return span;
  }

  function onStatus(id, to) {
    var st = ctx.store.load();
    setStatus(st, id, to);
    ctx.store.save(st);
    rerender();
  }

  var curState = null;       // state snapshot for the current render pass
  var pendingPromote = null; // item id whose promote day-picker is open (session-only UI state)
  var pendingMove = null;    // item id whose move day-picker is open
  var pendingEdit = null;    // item id whose title editor is open
  // Phase 4: explicit expand/collapse OVERRIDES the traveler has made this
  // session (id -> true/false). Session-only (like the three pending* vars
  // above), reset on every boot(). Absent means "use the default": a
  // not-done item renders expanded, a done one collapsed (item 5 of the
  // Phase 4 spec: a tab's item count is small enough that default-open reads
  // fine, and sunk done items collapsing keeps the tab from re-growing into
  // the old wall). An explicit tap always wins over that default, for the
  // rest of the session. Deliberately NOT part of the persisted state
  // object; expanding a card to read it is not a planning decision worth
  // remembering across visits.
  var itemExpandOverride = {};
  // Item id to reveal and flash once after the next render. A day move in the
  // Plan tab relocates the card to a different day heading, which on a phone
  // is routinely thousands of pixels away from where the traveler was
  // looking: measured on the real Tirana guide at 390px, moving Sat 22's
  // arrival note to Fri 28 left the card 5,558px below the viewport with the
  // scroll position untouched. The move worked and persisted, but every
  // visible trace of it was off screen, so the tap read as "nothing
  // happened" or, worse, "I just deleted that". This is what makes the
  // result of the tap visible.
  var justMoved = null;
  // Set only by revealItem (a highlight chip's jump), and only so the jump
  // can NEVER be a silent no-op. A handful of items render on no tab at all
  // today (an undated, non-task item in a section that maps to Plan, which
  // groups by date), and for those the scroll finds nothing. Rather than let
  // the tap do nothing, the next render says in words where the card lives.
  var revealMiss = null;
  // Item id whose drag grip should hold focus after the next render. A
  // keyboard reorder rebuilds every node, so without this the second arrow
  // press would land on the page instead of on the item being moved.
  var focusGripItem = null;

  function defaultExpanded(status) { return status !== 'done'; }

  function promoteTo(it, iso) {
    var st = ctx.store.load();
    // Resolve the slot BEFORE flipping status: once the item counts as active,
    // its own stale day from a prior plan stint could contaminate the lookup.
    var key = (iso === null) ? null : keyForDisplayedDate(effectiveData(ctx.base, st), st, it.section, iso);
    setStatus(st, it.id, 'plan');
    setDay(st, it.id, key);
    ctx.store.save(st);
    pendingPromote = null;
    justMoved = it.id;
    rerender();
  }

  function moveTo(it, iso) {
    var st = ctx.store.load();
    var key = (iso === null) ? null : keyForDisplayedDate(effectiveData(ctx.base, st), st, it.section, iso);
    setDay(st, it.id, key);
    ctx.store.save(st);
    pendingMove = null;
    justMoved = it.id;
    rerender();
  }

  // Scrolls the just-moved card back under the traveler's eyes and flashes it
  // once, so a day move has a visible result instead of the card vanishing
  // upward or downward out of the viewport. Deliberately looks the card up by
  // walking the rendered cards rather than building a CSS selector from the
  // id: item ids come from guide data, and a quote or a bracket in one would
  // turn a selector into a thrown exception mid-render.
  function revealJustMoved() {
    if (!justMoved) { revealMiss = null; return; }
    var id = justMoved;
    var miss = revealMiss;
    justMoved = null;
    revealMiss = null;
    var main = document.getElementById('main');
    if (!main) return;
    var cards = main.querySelectorAll('[data-item-id]');
    var card = null;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-item-id') === id) { card = cards[i]; break; }
    }
    if (!card) {
      // Only revealItem sets `miss`; a day move always lands on a rendered
      // card, so this stays silent for every other caller.
      if (miss) {
        var n = document.getElementById('notice');
        if (n) {
          n.textContent = miss.name + ' has no card on this tab. It sits in ' +
            (miss.section ? miss.section.label : miss.tab) + ', which the ' +
            (TABS.filter(function (t) { return t.id === miss.tab; })[0] || { label: miss.tab }).label +
            ' tab only shows once it has a day.';
        }
      }
      return;
    }
    if (miss && miss.okText) {
      var okn = document.getElementById('notice');
      // rerender() has just written the private-mode warning here on a device
      // that cannot persist anything. That line matters more than a
      // confirmation, so it keeps its place and the confirmation follows it
      // rather than replacing it.
      if (okn) {
        var standing = okn.textContent;
        okn.textContent = standing ? (standing + ' ' + miss.okText) : miss.okText;
      }
    }
    // An archived card lives inside a closed <details>, and scrolling to a
    // node in a closed subtree lands on the summary with nothing under it.
    var p = card.parentNode;
    while (p && p !== main) {
      if (p.tagName === 'DETAILS') p.open = true;
      p = p.parentNode;
    }
    // Deliberately an instant scroll, not a smooth one. A move commonly spans
    // thousands of pixels, and animating that on a phone is a long ride that
    // ends somewhere the traveler did not ask to be. The jump plus the ring
    // below reads as "here it is" instead. It is also the behavior that can
    // actually be verified: smooth scrolling is silently ignored in several
    // automation and reduced-motion contexts, so relying on it would mean
    // shipping a result nobody watched work.
    if (card.scrollIntoView) {
      try { card.scrollIntoView({ block: 'center' }); }
      catch (e) { card.scrollIntoView(); }
    }
    card.classList.add('just-moved');
    setTimeout(function () { card.classList.remove('just-moved'); }, 1800);
  }

  // The shared day picker, used by both "move to another day" and "promote a
  // backup onto a day". `mode` is 'move' or 'promote':
  //   - move: the item's current day is shown but not tappable (see
  //     dayMoveOptions), and "No day" only appears when there is an
  //     assignment to clear. Neither of those taps can change anything, and
  //     a control that cannot succeed should not be offered.
  //   - promote: every day stays live, because picking the current day still
  //     does real work there (it flips the status out of backup), and "No
  //     day" is always a valid promote target.
  function dayPickerRow(it, hint, onPick, onCancel, mode) {
    var frag = document.createDocumentFragment();
    var pst = ctx.store.load();
    var model = dayMoveOptions(effectiveData(ctx.base, pst), pst, it);
    var isMove = mode !== 'promote';
    // Naming the current day turns the picker into its own explanation: the
    // traveler sees where the item is now and where it can go, in one line.
    frag.appendChild(el('p', 'when-line',
      hint + (isMove && model.currentLabel ? ' Now on ' + model.currentLabel + '.' : '')));
    var pick = el('div', 'ctl-row');
    model.options.forEach(function (o) {
      var isCurrent = o.current && isMove;
      var db = el('button', 'ctl' + (isCurrent ? ' is-current' : ''), o.label);
      db.type = 'button';
      if (isCurrent) {
        db.disabled = true;
        db.setAttribute('aria-current', 'true');
        db.title = 'Already on ' + o.label;
      } else {
        db.onclick = function () { onPick(o.iso); };
      }
      pick.appendChild(db);
    });
    if (!isMove || model.hasDay) {
      var nd = el('button', 'ctl', 'No day');
      nd.type = 'button';
      nd.onclick = function () { onPick(null); };
      pick.appendChild(nd);
    }
    var cancel = el('button', 'ctl to-archived', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = onCancel;
    pick.appendChild(cancel);
    frag.appendChild(pick);
    return frag;
  }

  // Phase 3, feature 1: the collapsed card header. Always just the name (with
  // the done checkmark) and the tags row, per the spec: everything else lives
  // in the expanded detail panel. It is a <button> (not a div with a click
  // handler) so it is keyboard-reachable and gets a native aria-expanded.
  // `dayChip` (Phase 4) is a rendered date label shown when this card is
  // rendered flat outside its own day grouping (every tab but Plan): it is
  // what lets "Add to a day" have a visible result on the card it was set
  // from, per the Phase 4 spec's populate-Plan-from-other-tabs feature.
  // Density pass: the title row now carries what used to be three separate
  // lines. `sec` (Plan tab only, where cards from every section sit mixed in
  // one day) prefixes the title with the section's icon INSTEAD of the old
  // standalone .sec-meta line above the card; the label it used to spell out
  // survives as the icon's tooltip and accessible name. The rating badge and
  // the `when` hint follow the title on the same line, wrapping to their own
  // line only when they genuinely do not fit.
  function cardHeaderBtn(it, status, expanded, dayChip, sec, showWhen) {
    var btn = el('button', 'card-hd');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(expanded));
    if (sec && sec.icon) {
      var ic = el('span', 'sec-ic', sec.icon);
      ic.setAttribute('role', 'img');
      ic.setAttribute('aria-label', sec.label || '');
      ic.title = sec.label || '';
      btn.appendChild(ic);
    } else if (sec && sec.label) {
      // Not every guide has section icons: the real Tirana guide's fifteen
      // sections carry none at all, and with no fallback the section would
      // simply vanish from its cards when .sec-meta went away. The label
      // itself becomes the prefix instead, set small and inline, so the
      // information survives without costing back the line it just saved.
      var lb = el('span', 'sec-lab', sec.label);
      lb.title = sec.label;
      btn.appendChild(lb);
    }
    var tname = el('span', 'tname');
    if (status === 'done') tname.appendChild(el('span', 'donemark', '✓'));
    tname.appendChild(document.createTextNode(effectiveName(it, curState)));
    btn.appendChild(tname);
    var badge = ratingBadge(it.rating, false);
    if (badge) btn.appendChild(badge);
    if (showWhen && it.when) {
      var wh = el('span', 'when-hint', it.when);
      wh.title = it.when;
      btn.appendChild(wh);
    }
    if (dayChip) btn.appendChild(el('span', 'daychip', dayChip));
    if (it.tags && it.tags.length) {
      var tp = el('span', 'card-hd-tags');
      it.tags.forEach(function (t) { tp.appendChild(el('span', 'tag', t)); });
      btn.appendChild(tp);
    }
    btn.appendChild(el('span', 'card-hd-chev', expanded ? '▾' : '▸'));
    return btn;
  }

  // True exactly when itemDetailBody below takes the panel over with an
  // editor or a day picker instead of rendering the normal detail. The
  // control row is suppressed in that case (the picker carries its own
  // Cancel), so appendCard has to be able to ask the same question without
  // duplicating the conditions.
  function itemPanelTakenOver(it, status, withDayPicker) {
    if (pendingEdit === it.id) return true;
    if (status === 'backup' && withDayPicker && pendingPromote === it.id) return true;
    return pendingMove === it.id;
  }

  // What the expander hides: price, note, intel and hours. Shown ONLY when
  // the card is expanded. The `when` hint and the links moved up to the
  // title row and the control row respectively in the density pass, and the
  // control row itself is no longer built here (see itemControlRow), so a
  // collapsed card is still a card you can act on. Renaming and the day
  // pickers are the exceptions carried over unchanged: each replaces this
  // whole panel while it names this item.
  function itemDetailBody(it, status, withDayPicker) {
    var frag = document.createDocumentFragment();
    if (pendingEdit === it.id) {
      frag.appendChild(el('p', 'when-line', 'Rename this item'));
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'title-edit';
      inp.value = effectiveName(it, curState);
      frag.appendChild(inp);
      var erow = el('div', 'ctl-row');
      var save = el('button', 'ctl to-done', 'Save');
      save.type = 'button';
      save.onclick = function () {
        var st = ctx.store.load();
        setTitle(st, it.id, inp.value);
        ctx.store.save(st);
        pendingEdit = null;
        rerender();
      };
      var orig = el('button', 'ctl', 'Original name');
      orig.type = 'button';
      orig.onclick = function () {
        var st = ctx.store.load();
        setTitle(st, it.id, null);
        ctx.store.save(st);
        pendingEdit = null;
        rerender();
      };
      var ecancel = el('button', 'ctl to-archived', 'Cancel');
      ecancel.type = 'button';
      ecancel.onclick = function () { pendingEdit = null; rerender(); };
      erow.appendChild(save); erow.appendChild(orig); erow.appendChild(ecancel);
      frag.appendChild(erow);
      var focusLater = inp;
      setTimeout(function () { try { focusLater.focus(); focusLater.select(); } catch (e) {} }, 0);
      return frag;
    }
    if (it.price) frag.appendChild(el('p', 'price-line', it.price.text));
    if (it.note) frag.appendChild(el('p', null, it.note));
    if (it.intel) {
      var strip = intelStrip(it.intel);
      if (strip) frag.appendChild(strip);
    }
    var row = el('div', 'row');
    if (it.hours) row.appendChild(el('span', 'hours' + (it.hours.class ? ' ' + it.hours.class : ''), it.hours.text));
    if (row.children.length) frag.appendChild(row);
    if (status === 'backup' && withDayPicker && pendingPromote === it.id) {
      frag.appendChild(dayPickerRow(it, 'Promote to which day?',
        function (iso) { promoteTo(it, iso); },
        function () { pendingPromote = null; rerender(); }, 'promote'));
      return frag;
    }
    if (pendingMove === it.id) {
      frag.appendChild(dayPickerRow(it, 'Move to which day?',
        function (iso) { moveTo(it, iso); },
        function () { pendingMove = null; rerender(); }, 'move'));
      return frag;
    }
    return frag;
  }

  // The card's one row of controls, which the density pass moved OUT of the
  // collapsed-away detail panel: on a phone the whole point of a Plan-tab
  // card is to open the map or tick it done, and having to expand the card
  // first cost a tap and a screenful on every single item.
  //
  // Order is the owner's: the links that NAVIGATE come first, left of Done,
  // because they are what a card is for while you are standing in the
  // street; the controls that MUTATE the plan follow. The two groups stay
  // visually distinct (pill colouring vs outlined buttons) so a thumb never
  // confuses "open in maps" with "archive".
  //
  // Two of them, Archive and Rename, carry .ctl-more and are hidden by CSS
  // while the card is collapsed. Measured at 390px: the full six controls
  // plus one map link need ~348px against 290px of card width, so with all
  // six always visible EVERY card's control row wrapped to a second line,
  // which is the opposite of what this pass is for. Archive and Rename are
  // the two to hide because they are housekeeping (mid-trip you open a map
  // and tick things off; you archive and rename sitting down) and because
  // Archive's text label, which stays, is most of the width. display:none
  // also takes them out of the tab order on a collapsed card, the same rule
  // the collapsed detail panel has always followed.
  // The pin control, and the ONLY door to pinning or unpinning: the highlight
  // chip itself just navigates. Wordless icon with a tooltip, like every
  // other non-destructive control here.
  //
  // At the cap the control on an UNpinned card is disabled and its tooltip
  // says why and what to do about it, rather than being hidden (a control
  // that vanishes teaches nothing) or left live to fail on tap.
  function pinBtn(it) {
    var st = curState || (ctx && ctx.store ? ctx.store.load() : emptyState());
    var on = isPinned(st, it.id);
    var can = canTogglePin(st, it.id);
    // 📌 in BOTH states, filled accent when on (see .pin-btn.pinned) plus
    // aria-pressed, the same toggle idiom the rest of the app uses. NOT 📍 for
    // the off state, however tempting the contrast: 📍 is already the map
    // link's icon and sits in this very row, so the two would read as two
    // map buttons at 390px (caught in browser QA, not in a test).
    var b = el('button', 'ctl icon-btn pin-btn' + (on ? ' pinned' : ''), '📌');
    b.type = 'button';
    var aria = on ? 'Unpin from highlights'
      : (can ? 'Pin to highlights' : 'Highlights are full (' + PIN_CAP + ')');
    b.setAttribute('aria-label', aria);
    b.setAttribute('aria-pressed', String(on));
    b.title = can ? aria
      : 'Highlights hold ' + PIN_CAP + ' items. Unpin one from its own card to make room.';
    if (!can) {
      b.disabled = true;
    } else {
      b.onclick = function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var s = ctx.store.load();
        togglePin(s, it.id);
        ctx.store.save(s);
        rerender();
      };
    }
    return b;
  }

  // "Ask Claude about this one place." Offered only where it can actually
  // succeed, which is two conditions at once:
  //   - the app shell is present and exposes askPlace. A standalone exported
  //     guide carries no copy of PROMPT.md and no key, so there is nothing
  //     behind the button there and it is simply not drawn.
  //   - the item has neither a rating nor any intel, i.e. nobody has looked
  //     it up yet. Every hand-added place qualifies by construction, and so
  //     does anything the generation pass could not verify; a card that
  //     already carries a verdict and a star count does not need a button
  //     offering to go and find one.
  //   - and the item is a PLACE. This one was caught in browser QA on the
  //     real Tirana guide: without it the button lands on "Fares", "Arrival"
  //     and "Walking distances", where "look up its Google rating and rank it
  //     against the section" is not a question with an answer. A section that
  //     maps to the Info tab is reference material, and a task section is a
  //     to-do list. Anything the traveler added by hand is exempt: they chose
  //     to put it there, and they are the ones who would ask.
  function placeNeedsResearch(it, sec) {
    if (!it) return false;
    var rated = it.rating && typeof it.rating.stars === 'number';
    var intel = it.intel && ((it.intel.verdicts || []).length || (it.intel.tips || []).length);
    if (rated || intel) return false;
    if (it.added_by === 'traveler') return true;
    var tab = tabForSection(sec);
    return tab === 'eat' || tab === 'do' || tab === 'services';
  }

  function askPlaceHook() {
    if (typeof window === 'undefined' || !window) return null;
    return (window.CityOpsApp && window.CityOpsApp.askPlace) ? window.CityOpsApp.askPlace : null;
  }

  // Section lookup for a card that only knows its section ID. Rebuilt once per
  // render (see rerender) rather than scanned per card.
  var secById = null;
  function sectionFor(secId) {
    if (!secById) {
      secById = Object.create(null);
      var st = curState || (ctx && ctx.store ? ctx.store.load() : emptyState());
      var data = ctx ? effectiveData(ctx.base, st) : null;
      ((data && data.sections) || []).forEach(function (s) { if (s && s.id) secById[s.id] = s; });
    }
    return Object.prototype.hasOwnProperty.call(secById, secId) ? secById[secId] : null;
  }

  function askBtn(it) {
    var hook = askPlaceHook();
    if (!hook || !placeNeedsResearch(it, sectionFor(it.section))) return null;
    // .ctl-more, so it joins Archive and Rename behind the card's expand.
    // Measured on the real Ksamil guide the day it shipped: with ✨ always
    // visible, 26 of 26 Eat & Drink control rows wrapped to a second line
    // (baseline was 0 of 26). It is exactly the case the .ctl-more comment
    // above describes: one more always-on pill is more than the row's slack,
    // and asking Claude to research a place is a sitting-down action, not a
    // standing-in-the-street one.
    var b = el('button', 'ctl icon-btn ask-btn ctl-more', '✨');
    b.type = 'button';
    b.setAttribute('aria-label', 'Ask Claude about this place');
    b.title = 'Ask Claude to check this place and rank it against the rest of this section';
    b.onclick = function () { hook(it.id); };
    return b;
  }

  function itemControlRow(it, status, withDayPicker) {
    var ctl = el('div', 'ctl-row');
    (it.links || []).forEach(function (l) { ctl.appendChild(linkCtl(l)); });
    // Icon buttons (feature 5): the icon is the whole visible label except on
    // Archive, which also keeps a text label because it is destructive.
    // aria-label and title both carry the same wording so screen readers and
    // mouse-hover tooltips agree. Archiving is the one transition that waits
    // for the card to be expanded; every other transition (including
    // RESTORING from archived, which is a recovery, not a destruction) is
    // there on the collapsed card.
    (TRANSITIONS[status] || []).forEach(function (t) {
      var b = el('button', 'ctl icon-btn to-' + t.to + (t.to === 'archived' ? ' ctl-more' : ''),
        t.label ? (t.icon + ' ' + t.label) : t.icon);
      b.type = 'button';
      b.setAttribute('aria-label', t.aria);
      b.title = t.aria;
      if (t.to === 'plan' && status === 'backup' && withDayPicker) {
        b.onclick = function () { pendingPromote = it.id; rerender(); };
      } else {
        b.onclick = function () { onStatus(it.id, t.to); };
      }
      ctl.appendChild(b);
    });
    if (withDayPicker && (status === 'plan' || status === 'done')) {
      // Phase 4: this is the "Add to a day" control from any Eat & Drink, Do
      // or Services card (populate-Plan-from-other-tabs). Same picker either
      // way; only the label changes so a traveler with nothing set yet does
      // not read "change" for an action they have never taken.
      //
      // In the Plan tab (withDayPicker === 'labeled') the icon also carries
      // its text. The house default is wordless icon controls with a hover
      // tooltip, and that default holds everywhere else here. It fails in
      // exactly this spot: the Plan tab is used on a phone, a phone has no
      // hover, so the tooltip that carries the entire meaning of an
      // otherwise decorative calendar glyph is unreachable on the one
      // surface where moving an item between days is the point. The row
      // already carries a text label on Archive, so this costs one word of
      // density and no new visual language.
      var hasDay = !!effectiveDay(it, curState);
      var mvLabel = hasDay ? 'Change day' : 'Add to a day';
      var mv = el('button', 'ctl icon-btn' + (withDayPicker === 'labeled' ? ' has-label' : ''),
        withDayPicker === 'labeled' ? ('📅 ' + mvLabel) : '📅');
      mv.type = 'button';
      mv.setAttribute('aria-label', mvLabel);
      mv.title = mvLabel;
      mv.onclick = function () { pendingMove = it.id; rerender(); };
      ctl.appendChild(mv);
    }
    // The pin sits OUTSIDE the not-archived guard, unlike Ask and Rename.
    // Archiving does not unpin (that would be a surprise: the traveler put
    // the item away, they did not touch the header), so the archived card has
    // to keep the only control that can unpin it. Without this, pinning then
    // archiving left a chip holding one of the four slots forever, while
    // every other card's disabled tooltip pointed at a control that no longer
    // existed. Shown only when it would do something: on an UNpinned archived
    // card there is nothing worth offering.
    if (status !== 'archived' || isPinned(curState || emptyState(), it.id)) {
      ctl.appendChild(pinBtn(it));
    }
    if (status !== 'archived') {
      var ask = askBtn(it);
      if (ask) ctl.appendChild(ask);
      var ed = el('button', 'ctl icon-btn ctl-more', '✎');
      ed.type = 'button';
      ed.setAttribute('aria-label', 'Rename');
      ed.title = 'Rename';
      ed.onclick = function () { pendingEdit = it.id; rerender(); };
      ctl.appendChild(ed);
    }
    return ctl.children.length ? ctl : null;
  }

  // Flips the EFFECTIVE expand state (default included) and stores the
  // result explicitly, except when the new value matches the computed
  // default again, in which case the override is dropped: the same
  // tri-state pattern toggleSection uses for collapsedSections, so a card
  // tapped back to its own default does not grow session state forever.
  function toggleExpand(id, status) {
    var def = defaultExpanded(status);
    var current = Object.prototype.hasOwnProperty.call(itemExpandOverride, id) ? itemExpandOverride[id] : def;
    var next = !current;
    if (next === def) delete itemExpandOverride[id];
    else itemExpandOverride[id] = next;
    rerender();
  }

  // Appends the header button plus the detail panel into an existing
  // card/bd container. Shared by every place a card renders (planner cards,
  // day-card bodies, calendar entries), so the tap-to-expand behavior and the
  // "only the expanded card shows controls" rule apply everywhere uniformly.
  //
  // The detail panel is always BUILT, but only visible (CSS: .collapsed >
  // .card-detail{display:none}) when the container carries the collapsed
  // class. Two reasons, both deliberate: a display:none subtree is out of the
  // tab order and the accessibility tree, so a collapsed card's status
  // buttons are genuinely unreachable (not just visually hidden) exactly as
  // the spec asks; and the print stylesheet can force every detail open with
  // one rule, so a printed guide still shows everything even though the
  // on-screen app defaults every card to collapsed.
  //
  // Phase 4, item 5: the default is no longer "always collapsed". A NOT-done
  // item defaults expanded (a tab's item count is small enough for that to
  // read fine); a done item defaults collapsed (it has sunk out of the way
  // on purpose). An explicit tap during this session always overrides that
  // default, in either direction, via itemExpandOverride above.
  function appendCard(container, it, status, showWhen, withDayPicker, dayChip, sec) {
    var expanded;
    // Renaming and both day pickers replace the detail panel, and that panel
    // is display:none while the card is collapsed. Since the density pass the
    // control row is suppressed at the same moment (itemPanelTakenOver), so a
    // collapsed card in that state would render a title and nothing else: no
    // picker, no Cancel, no way back except tapping the title. Forcing the
    // card open is what keeps every one of those three states reachable from
    // the collapsed card the control row now lives on.
    if (itemPanelTakenOver(it, status, withDayPicker)) expanded = true;
    else if (Object.prototype.hasOwnProperty.call(itemExpandOverride, it.id)) expanded = itemExpandOverride[it.id];
    else expanded = defaultExpanded(status);
    container.classList.add(expanded ? 'expanded' : 'collapsed');
    // Stamped on every card everywhere, so revealJustMoved() can find a card
    // again after a re-render relocated it, in any tab.
    container.setAttribute('data-item-id', it.id);
    var hd = cardHeaderBtn(it, status, expanded, dayChip, sec, showWhen);
    hd.onclick = function () { toggleExpand(it.id, status); };
    container.appendChild(hd);
    var detail = el('div', 'card-detail');
    detail.appendChild(itemDetailBody(it, status, withDayPicker));
    container.appendChild(detail);
    // Last, so a card reads title, then what it is, then what you can do
    // about it, and so the collapsed card is exactly two rows: the title row
    // and this one.
    if (!itemPanelTakenOver(it, status, withDayPicker)) {
      var ctl = itemControlRow(it, status, withDayPicker);
      if (ctl) container.appendChild(ctl);
    }
  }

  function renderCard(it, status, withDayPicker, dayChip) {
    var card = el('div', 'card' + (status === 'done' ? ' item-done' : ''));
    appendCard(card, it, status, true, withDayPicker, dayChip);
    return card;
  }

  // ---- The header highlights row ----
  // Owner ask, Aug 2026: "in addition to our pills/filters, add a few
  // highlights to the header (not more than one single row). example: sunset
  // time, or items of interest from my profile build".
  //
  // ONE row, hard capped, scrolling sideways if it overflows and never
  // wrapping to a second line, because a two-line highlights block is just
  // the .facts chip row again with a different name. Two kinds of chip go in
  // it, in this order:
  //   - the sunset, computed locally from the city's coordinates (see
  //     sunsetUtcMinutes). Automatic, never pinned, and simply absent when
  //     the city carries no coordinates at all.
  //   - up to PIN_CAP pinned items, in pin order, each a button that jumps
  //     to the full card.
  //
  // Rendered by the ENGINE, so a standalone exported guide gets the identical
  // row: the sunset needs only the data the guide already carries, and pins
  // live in the same per-device state a standalone guide already keeps.
  //
  // What is NOT here: a profile-interests chip. The honest signal for one
  // would be item tags intersecting the traveler's stated interests, and the
  // real guides in this repo carry tags like "Book ahead" and "Cash only" --
  // operational notes, not interest categories -- so that intersection is
  // empty on every city we have. Shipping it would mean inventing a mapping
  // and calling the output a highlight. Deferred until interest tagging is a
  // thing the generation pass actually does.

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Sunset for the header, as {text, iso, isToday, cityClock} or null. The
  // date is today when today falls inside the stay, and the arrival day
  // otherwise, so a guide opened three weeks early answers "what are the
  // evenings like there" rather than showing today's sunset for a city
  // nobody is in.
  //
  // Two clocks, and the chip's tooltip always says which one it used. When
  // the city states its own offset (see cityUtcOffsetMinutes) the answer is
  // the city's local time no matter where it is read, which is what makes
  // opening next week's Ksamil guide from Tiranë give Ksamil's evening. With
  // no offset it falls back to the reader's device clock, which is right
  // standing in the city and wrong from home, so it never claims otherwise.
  // nowIso is an injection point for tests; real callers omit it and get the
  // device's actual clock, the same convention effectiveViewMode and
  // todayModel already use.
  function sunsetChip(data, state, nowIso) {
    var loc = cityLatLng(data);
    if (!loc) return null;
    var range = effectiveDates(data, state || emptyState());
    var today = nowIso || todayIso();
    var iso = (today >= range.from && today <= range.to) ? today : range.from;
    if (!isIso(iso)) return null;
    var mins = sunsetUtcMinutes(iso, loc.lat, loc.lng);
    if (mins === null) return null;
    var off = cityUtcOffsetMinutes(data);
    if (off !== null) {
      // Pure arithmetic, no Date: minutes past midnight in the city.
      //
      // FLOOR, not round, and it matters: a clock reads the minute you are
      // in, so 17:29:48 is 17:29 for the same reason a watch says so, and
      // published sunset tables (met.no included) truncate the same way.
      // Rounding would put Tiranë's arrival evening a minute later than every
      // source the number was checked against.
      //
      // The wrap carries the DATE with it. mins is measured from midnight UTC
      // on `iso`, so adding an offset can land on the day before or the day
      // after: a Pacific city at UTC+14 has a sunset that is already the next
      // UTC day before the offset is applied at all. Labelling that time with
      // the UTC day would make the chip say "sunset 18:35 today" about
      // tomorrow evening. shiftDays is how many calendar days the wrap
      // crossed, and the label follows it. No repo city crosses today; the
      // first Pacific one would.
      var local = Math.floor(mins) + off;
      var shiftDays = Math.floor(local / 1440);
      local = local - shiftDays * 1440;
      var localIso = shiftDays === 0 ? iso : addDaysIso(iso, shiftDays);
      return { text: pad2(Math.floor(local / 60)) + ':' + pad2(local % 60),
        iso: localIso, isToday: localIso === today, cityClock: true };
    }
    // The device-clock fallback gets the same treatment for free: the Date
    // knows its own calendar day in the reader's zone, so read the day off it
    // rather than off the UTC iso that went in.
    var base = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 0, 0, 0);
    var d = new Date(base + Math.round(mins * 60000));
    var devIso = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return { text: pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
      iso: devIso, isToday: devIso === today, cityClock: false };
  }

  function renderHighlights(data, state) {
    var row = el('div', 'hl');
    row.setAttribute('aria-label', 'Highlights');
    var sun = sunsetChip(data, state);
    if (sun) {
      var s = el('span', 'hl-chip hl-auto');
      s.appendChild(el('span', 'hl-ic', '🌇'));
      s.appendChild(document.createTextNode(sun.text));
      s.title = 'Sunset ' + sun.text + (sun.isToday ? ' today' : ' on ' + dayLabel(sun.iso)) +
        (sun.cityClock ? ', local time in ' + data.city.name : ', on this device\'s clock');
      row.appendChild(s);
    }
    // Share view is a clean read-only page for sending or printing, and a pin
    // chip is a navigation control for the person who made the pins. The
    // sunset stays: it is a fact about the city, not a control.
    (shareOn ? [] : pinnedItems(data, state)).forEach(function (it) {
      var text = pinChipText(effectiveName(it, state), it.note);
      if (!text) return;
      var b = el('button', 'hl-chip hl-pin');
      b.type = 'button';
      b.appendChild(el('span', 'hl-ic', '📌'));
      b.appendChild(document.createTextNode(text));
      b.setAttribute('aria-label', 'Go to ' + effectiveName(it, state));
      b.title = 'Go to ' + effectiveName(it, state) + ' (unpin from its card)';
      b.onclick = function () { revealItem(it.id); };
      row.appendChild(b);
    });
    return row.children.length ? row : null;
  }

  // Jump from a highlight chip to the item's own card: switch to the tab that
  // renders it, open its section if the traveler had it collapsed, leave
  // Share view if that is what is on screen, then hand off to the SAME
  // scroll-and-ring reveal a day move uses. One door for "put this card in
  // front of me", not two.
  // `okText`, when given, is the #notice line to show once the card is
  // actually on screen. It goes through revealJustMoved rather than being
  // written here because rerender() rewrites #notice, and because a reveal
  // that FAILED to find the card must say that instead: a confirmation
  // sitting above a page where nothing visibly changed is the exact failure
  // this whole scroll-and-ring mechanism exists to prevent.
  function revealItem(id, okText) {
    var st = ctx.store.load();
    var data = effectiveData(ctx.base, st);
    var it = null, sec = null;
    (data.items || []).forEach(function (x) { if (x && x.id === id) it = x; });
    if (!it) {
      // Only reachable if the guide changed under a pin between the render
      // that drew the chip and the tap on it. Say so rather than absorb the
      // tap: a chip that does nothing twice reads as a broken app.
      var gone = document.getElementById('notice');
      if (gone) gone.textContent = 'That item is no longer in this guide, so its highlight has gone with it.';
      return;
    }
    (data.sections || []).forEach(function (s) { if (s && s.id === it.section) sec = s; });
    var totalItems = Array.isArray(data.items) ? data.items.length : 0;
    var tab = tabForSection(sec);
    var changed = false;
    if (effectiveTab(st) !== tab) { setTab(st, tab); changed = true; }
    if (isSectionCollapsed(st, it.section, totalItems)) {
      toggleSection(st, it.section, totalItems);
      changed = true;
    }
    // The Plan tab hides a collapsed DAY's cards entirely (see renderPlanTab),
    // and a day is a different collapse map from a section. Without this, a
    // pinned itinerary stop on a day the traveler had folded away jumped to a
    // page with no card on it, and the miss line then said the item needed a
    // day, which it had. Reachable on the real Tirana guide.
    var itDay = effectiveDay(it, st);
    if (tab === 'plan' && itDay) {
      var itAuto = planDayAutoFor(data, st, itDay);
      if (isPlanDayCollapsed(st, itDay, itAuto)) {
        expandPlanDay(st, itDay, itAuto);
        changed = true;
      }
    }
    if (shareOn) { shareOn = false; document.body.classList.remove('share'); }
    if (changed) ctx.store.save(st);
    justMoved = id;
    revealMiss = { id: id, name: effectiveName(it, st), tab: tab, section: sec,
      okText: okText || null };
    rerender();
  }

  function renderHeader(data, state) {
    var c = data.city;
    var dates = effectiveDates(data, state);
    // The app surfaces carry the SHARED header (src/header.html), whose band,
    // surface switch and app-level doors must survive this render: the engine
    // owns only the middle. A standalone exported guide has no shared header
    // and no second surface to switch to, so there #hdr is the whole thing and
    // the engine keeps owning it outright.
    var h = document.getElementById('hdr-mid') || document.getElementById('hdr');
    h.innerHTML = '';
    h.appendChild(el('h1', null, c.name));
    var sub = fmtRange(dates) + (c.accommodation && c.accommodation.name ? ' · ' + c.accommodation.name : '');
    if (state.stayOverride) sub += ' · dates adjusted';
    h.appendChild(el('div', 'sub', sub));
    var hl = renderHighlights(data, state);
    if (hl) h.appendChild(hl);
    var facts = el('div', 'facts');
    if (c.currency && c.currency.code !== 'USD') {
      facts.appendChild(el('span', 'chip', c.currency.code + ' = $' + c.currency.usd));
    }
    (c.notes || []).forEach(function (n) { facts.appendChild(el('span', 'chip', n)); });
    h.appendChild(facts);
    document.title = c.name + ' Guide · ' + fmtRange(dates);
  }

  // Phase 3, feature 2: total item count plus a done/open split, "if cheap"
  // meaning: derived from the lists renderSection already has in hand, no
  // extra pass over the whole guide. total counts every item in the section
  // regardless of status (matches what the collapsed count used to show);
  // open/done only cover the active (dayed + undated) items, since backups
  // and archived items are neither.
  function sectionCounts(sv, state) {
    var active = sv.undated.length;
    var done = 0;
    function tally(it) { if (effectiveStatus(it, state) === 'done') done++; }
    sv.days.forEach(function (d) { active += d.items.length; d.items.forEach(tally); });
    sv.undated.forEach(tally);
    var total = active + sv.backups.length + sv.archived.length;
    return { total: total, done: done, open: active - done };
  }

  function sectionCountText(counts) {
    var s = String(counts.total) + (counts.total === 1 ? ' item' : ' items');
    // Only worth a second number when the split is actually informative: all
    // open (nothing done yet) or all done both collapse to noise.
    if (counts.done > 0 && counts.open > 0) s += ' · ' + counts.open + ' open';
    return '(' + s + ')';
  }

  // Phase 4: the section header shared by every tab (Eat & Drink, Do,
  // Services, Info). Unchanged from the old renderSection's h2: same
  // collapse toggle, same anchor id for the sticky section-nav chips, same
  // item counts. What sits below it is what changed (see renderTabSectionBlock
  // and renderInfoTab): flat item cards instead of day-grouped columns, since
  // the Plan tab is now the one place days are grouped.
  function renderSectionHeader(sv, state, totalItems) {
    var collapsed = isSectionCollapsed(state, sv.section.id, totalItems);
    var h2 = el('h2', collapsed ? 'collapsed' : null);
    h2.id = 'sec-' + sv.section.id;
    var tbtn = el('button', 'sec-toggle');
    tbtn.type = 'button';
    tbtn.setAttribute('aria-expanded', String(!collapsed));
    tbtn.appendChild(el('span', 'chev', collapsed ? '▸' : '▾'));
    if (sv.section.icon) tbtn.appendChild(el('span', 'ic', sv.section.icon));
    tbtn.appendChild(document.createTextNode(' ' + sv.section.label + ' '));
    tbtn.appendChild(el('span', 'sec-count', sectionCountText(sectionCounts(sv, state))));
    tbtn.onclick = function () {
      var st = ctx.store.load();
      toggleSection(st, sv.section.id, totalItems);
      ctx.store.save(st);
      rerender();
    };
    h2.appendChild(tbtn);
    // The primary way in for "someone just told me about a place": it sits on
    // the header of the section the place belongs to, so the section arrives
    // filled in and the traveler is already looking at what it has to beat.
    //
    // The guard is belt and braces rather than load-bearing: a Plan-tab
    // section never reaches this function at all (renderPlanTab draws its own
    // day headings), and openAddPlaceModal drops those sections from its
    // picker anyway. It stays so the two rules cannot drift apart if the Plan
    // tab ever grows a section header.
    if (tabForSection(sv.section) !== 'plan') {
      var addb = el('button', 'sec-add icon-btn', '+');
      addb.type = 'button';
      var aria = 'Add a place to ' + sv.section.label;
      addb.setAttribute('aria-label', aria);
      addb.title = aria;
      addb.onclick = function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        openAddPlaceModal(sv.section.id);
      };
      h2.appendChild(addb);
    }
    return { h2: h2, collapsed: collapsed };
  }

  // Every active item in a section (day-assigned or not), paired with the date
  // label to show as that card's day chip (null for undated) and the status
  // the ordering needs. viewModel() already grouped the dayed ones into
  // per-date slots; this flattens that back into one list and hands it to
  // orderSectionItems, which owns the three rules a section tab now shares
  // with the Plan tab: chronological by default, the traveler's own drag
  // order on top, done items at the bottom.
  function tabItemsFlat(sv, state) {
    var out = [];
    sv.days.forEach(function (d) {
      d.items.forEach(function (it) {
        out.push({ it: it, dayIso: d.iso, status: effectiveStatus(it, state) });
      });
    });
    sv.undated.forEach(function (it) {
      out.push({ it: it, dayIso: null, status: effectiveStatus(it, state) });
    });
    return orderSectionItems(out, sectionItemOrderFor(state, sv.section.id));
  }

  // Eat & Drink / Do / Services: one section block per mapped section, items
  // as flat cards (day chip if assigned, "Add to a day" control either way),
  // then backups and archived exactly as before.
  //
  // The cards sit in a .seclist, the section-tab twin of the Plan tab's
  // .planlist: same grip, same drag, same keyboard arrows, one saved order per
  // section instead of per date. A section with a single card gets no grip at
  // all, since there is nothing it could reorder.
  function renderTabSectionBlock(sv, state, totalItems) {
    var frag = document.createDocumentFragment();
    var hdr = renderSectionHeader(sv, state, totalItems);
    frag.appendChild(hdr.h2);
    if (hdr.collapsed) return frag;
    var entries = tabItemsFlat(sv, state);
    if (entries.length) {
      var list = el('div', 'seclist');
      list.setAttribute('data-sec-id', sv.section.id);
      entries.forEach(function (entry) {
        var chip = entry.dayIso ? dayLabel(entry.dayIso) : null;
        var draggable = entries.length > 1;
        var card = el('div', 'card' + (draggable ? ' dragrow' : '') +
          (entry.status === 'done' ? ' item-done' : ''));
        if (draggable) card.appendChild(sectionGrip(entry.it, sv.section));
        appendCard(card, entry.it, entry.status, true, true, chip);
        list.appendChild(card);
      });
      frag.appendChild(list);
    }
    if (sv.backups.length) {
      var bk = el('div', 'backup');
      bk.appendChild(el('div', 'bt', '↩ Backups: if Plan A is full, closed, or you want a change'));
      sv.backups.forEach(function (it) { bk.appendChild(renderCard(it, 'backup', true)); });
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

  // "Expand all · Collapse all", once per tab (owner ask 2026-08-26, the
  // other half of "default to all accordions be expanded").
  //
  // Text links, not buttons, and deliberately so: the page already carries a
  // pill control row on every card and a chip row above them, and two more
  // pills at the top of every tab would read as a third bar of actions rather
  // than a footnote. They are muted, small, and right where the first section
  // heading starts, so they are findable when the wall is the problem and
  // invisible when it is not.
  //
  // `apply(collapsed)` is handed in by the caller because the two callers
  // write different maps (sections by id, Plan days by date) through the two
  // pure writers above. Nothing here decides anything: the whole decision is
  // in setSectionsCollapsed / setPlanDaysCollapsed, which are unit tested.
  function renderExpandAll(anyCollapsible, apply) {
    if (!anyCollapsible) return null;
    var row = el('div', 'xall-row');
    function link(label, collapsed, aria) {
      var b = el('button', 'xall', label);
      b.type = 'button';
      b.setAttribute('aria-label', aria);
      b.title = aria;
      b.onclick = function () {
        var st = ctx.store.load();
        apply(st, collapsed);
        ctx.store.save(st);
        rerender();
      };
      return b;
    }
    row.appendChild(link('Expand all', false, 'Expand every section in this tab'));
    row.appendChild(el('span', 'xall-sep', '·'));
    row.appendChild(link('Collapse all', true, 'Collapse every section in this tab'));
    return row;
  }

  function sectionExpandAllRow(vms, totalItems) {
    var ids = vms.map(function (sv) { return sv.section.id; }).filter(Boolean);
    return renderExpandAll(ids.length > 1, function (st, collapsed) {
      setSectionsCollapsed(st, ids, collapsed, totalItems);
    });
  }

  function renderTabSections(vms, state, totalItems) {
    var main = document.getElementById('main');
    main.innerHTML = '';
    if (!vms.length) {
      main.appendChild(el('p', 'when-line', 'Nothing in this tab yet.'));
      return;
    }
    var xall = sectionExpandAllRow(vms, totalItems);
    if (xall) main.appendChild(xall);
    vms.forEach(function (sv) { main.appendChild(renderTabSectionBlock(sv, state, totalItems)); });
  }

  // Info tab (item 6 of the Phase 4 spec): a section's UNDATED items merge
  // into one reference card, name-as-lead-in plus note, no per-item
  // accordion and no status controls, since these are facts, not todos. Any
  // item that DOES carry a day (Tirana's real "logistics" section has
  // arrival/departure dates right alongside pure reference notes) keeps
  // behaving like a normal item card: it still needs its status controls and
  // it still needs to surface in Plan.
  function infoBlockCard(sv, items, state) {
    var card = el('div', 'card info-card');
    card.appendChild(el('h3', null, (sv.section.icon ? sv.section.icon + ' ' : '') + sv.section.label));
    items.forEach(function (it) {
      var p = el('p', 'info-item');
      // The Info tab is where the owner asked for this ("bump up specific
      // info ... from the info tab"), and it is also the one tab whose items
      // are paragraphs in a shared block rather than cards with a control
      // row. So the pin control is appended to the paragraph itself, and the
      // paragraph carries data-item-id so a highlight chip's jump can find
      // it exactly like it finds a card.
      p.setAttribute('data-item-id', it.id);
      p.appendChild(pinBtn(it));
      p.appendChild(el('strong', null, effectiveName(it, state)));
      if (it.note) {
        // No <br> here, deliberately. The headline is display:block in CSS, so
        // the note already starts on its own line; the <br> this used to carry
        // added a whole empty line UNDER every headline, which is what made a
        // bold name read as the end of the block above it instead of the start
        // of its own note (owner feedback 2026-08-25). The gap under a
        // headline is now the headline's own 1px margin, against 22px above
        // it, so the pairing is unambiguous.
        p.appendChild(document.createTextNode(it.note));
      }
      card.appendChild(p);
      if (it.links && it.links.length) {
        var row = el('div', 'row');
        it.links.forEach(function (l) { row.appendChild(linkPill(l)); });
        card.appendChild(row);
      }
    });
    return card;
  }

  function renderInfoTab(vms, state, totalItems) {
    var main = document.getElementById('main');
    main.innerHTML = '';
    if (!vms.length) {
      main.appendChild(el('p', 'when-line', 'Nothing in this tab yet.'));
      return;
    }
    var xall = sectionExpandAllRow(vms, totalItems);
    if (xall) main.appendChild(xall);
    vms.forEach(function (sv) {
      var hdr = renderSectionHeader(sv, state, totalItems);
      main.appendChild(hdr.h2);
      if (hdr.collapsed) return;
      var dayed = [];
      sv.days.forEach(function (d) { d.items.forEach(function (it) { dayed.push({ it: it, dayIso: d.iso }); }); });
      dayed.forEach(function (entry) {
        main.appendChild(renderCard(entry.it, effectiveStatus(entry.it, state), true, dayLabel(entry.dayIso)));
      });
      if (sv.undated.length) main.appendChild(infoBlockCard(sv, sv.undated, state));
      if (sv.backups.length) {
        var bk = el('div', 'backup');
        bk.appendChild(el('div', 'bt', '↩ Backups'));
        sv.backups.forEach(function (it) { bk.appendChild(renderCard(it, 'backup', true)); });
        main.appendChild(bk);
      }
      if (sv.archived.length) {
        var det = el('details', 'arch-details');
        det.appendChild(el('summary', null, 'Archived (' + sv.archived.length + ')'));
        sv.archived.forEach(function (it) { det.appendChild(renderCard(it, 'archived')); });
        main.appendChild(det);
      }
    });
  }

  // Phase 4: the sticky "jump to section" chip row, now scoped to whichever
  // tab is active (Calendar's cross-section date grouping and Plan's
  // day/tasks layout never had a use for it; hidden for both, same as share).
  // Reads the SAME tab-filtered viewModel array rerender() already built, so
  // this never disagrees with what is actually on the page. Hidden entirely
  // (rather than left empty) when a tab has only one section: an empty
  // sticky bar is still visual clutter.
  function renderSectionNav(vms, state, totalItems, mode) {
    var nav = document.getElementById('secnav');
    if (!nav) return; // standalone/older shells without the marker: no-op
    nav.innerHTML = '';
    if (mode !== 'tab' || vms.length < 2) { nav.hidden = true; return; }
    nav.hidden = false;
    vms.forEach(function (sv) {
      var chip = el('button', 'secnav-chip',
        (sv.section.icon ? sv.section.icon + ' ' : '') + sv.section.label);
      chip.type = 'button';
      chip.onclick = function () {
        var st = ctx.store.load();
        if (isSectionCollapsed(st, sv.section.id, totalItems)) {
          toggleSection(st, sv.section.id, totalItems);
          ctx.store.save(st);
        }
        rerender();
        var target = document.getElementById('sec-' + sv.section.id);
        if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      nav.appendChild(chip);
    });
  }

  // ---- Plan tab: drag an item to reorder it, or to move it to another day ----
  // Replaces Phase 3's per-section day-SLOT reorder, which the tabbed rework
  // left with nothing to attach to (the Plan tab groups by date across
  // sections, so there is no per-section day grid anymore). The grip visual,
  // the once-bound window listeners and the lift-and-cross mechanics are
  // carried over from it; what is dragged is now one item, not a whole day.
  //
  // Everything lives in the module-scope `drag` context, so the window
  // listeners bind exactly once in boot() and a rerender mid-drag simply
  // drops the context instead of leaving a half-finished drag behind.

  // How close to the viewport edge the finger has to get before the page
  // starts scrolling under it, and the fastest it ever scrolls (px per frame,
  // so roughly 60x that per second). The Plan tab on the real Tirana guide is
  // over 15,000px tall at 390px wide: without this, dragging Monday's barber
  // appointment to Wednesday is not slow, it is impossible, because the
  // finger is already holding the card and cannot also scroll the page.
  var PLAN_DRAG_EDGE = 96;
  var PLAN_DRAG_MAX_SPEED = 26;

  // Which kind of reorderable list a card sits in, or null for "not one".
  // 'day' is the Plan tab's .planlist (reorder within a day, and drop onto a
  // different day); 'section' is a section tab's .seclist (reorder only). One
  // reader so the pointer path and the keyboard path can never disagree about
  // what is draggable.
  function dragListMode(list) {
    if (!list || !list.classList) return null;
    if (list.classList.contains('planlist')) return 'day';
    if (list.classList.contains('seclist')) return 'section';
    return null;
  }

  function planListCards(list) {
    if (!list) return [];
    return Array.prototype.filter.call(list.children, function (n) {
      return n.classList && n.classList.contains('card');
    });
  }

  function planCardIds(list) {
    return planListCards(list).map(function (c) { return c.getAttribute('data-item-id'); });
  }

  // The day group under the pointer. Distance-based rather than a strict
  // rect hit test on purpose: the gaps between day groups are real (h2
  // margins live outside every rect), and a finger in one of them is
  // unambiguously heading for the nearest group, not for nothing at all.
  function planGroupAt(groups, y) {
    var best = null, bestD = Infinity;
    groups.forEach(function (g) {
      var r = g.getBoundingClientRect();
      var d = (y < r.top) ? (r.top - y) : (y > r.bottom ? y - r.bottom : 0);
      if (d < bestD) { bestD = d; best = g; }
    });
    return best;
  }

  function markPlanDropTarget(groups, group) {
    groups.forEach(function (g) {
      if (g === group) g.classList.add('drop-into');
      else g.classList.remove('drop-into');
    });
  }

  function planInsertAt(list, card, y) {
    var others = planListCards(list).filter(function (c) { return c !== card; });
    var before = null;
    for (var i = 0; i < others.length; i++) {
      var r = others[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = others[i]; break; }
    }
    if (before) list.insertBefore(card, before);
    else list.appendChild(card);
    // An empty day renders a "Nothing planned yet" line; it must not sit
    // under the card that is visibly being dropped onto it.
    list.classList.add('has-drop');
  }

  // Crossing a sibling inside ONE list: the half-height rule, extracted so the
  // Plan tab's same-day case and the section tab's only case share it rather
  // than keeping two copies of the arithmetic that decides what a drag means.
  function planCrossSiblings(list, card, y) {
    var others = planListCards(list).filter(function (c) { return c !== card; });
    for (var i = 0; i < others.length; i++) {
      var r = others[i].getBoundingClientRect();
      var mid = r.top + r.height / 2;
      var after = card.compareDocumentPosition(others[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
      if ((after && y > mid) || (!after && y < mid)) {
        card.style.transform = '';
        if (after) list.insertBefore(others[i], card);
        else list.insertBefore(card, others[i]);
        drag.startY = y;
        card.style.transform = 'scale(1.02)';
        return true;
      }
    }
    return false;
  }

  // One frame of the drag: keep the card under the finger, and either cross a
  // sibling inside the current day or hand the card to a different day.
  function planDragUpdate(y) {
    if (!drag) return;
    var card = drag.card;
    // Section tabs are reorder-only: there is no second container to cross
    // into, so the whole day-group hunt below is skipped rather than run and
    // discarded.
    if (drag.mode === 'section') {
      card.style.transform = 'translateY(' + (y - drag.startY) + 'px) scale(1.02)';
      planCrossSiblings(drag.list, card, y);
      return;
    }
    var group = planGroupAt(drag.groups, y);
    if (!group) return;
    var list = group.querySelector('.planlist');
    var iso = group.getAttribute('data-day-iso');
    if (!list) {
      // A COLLAPSED day. There is no list to preview the card inside, so the
      // header itself becomes the drop target and the whole group lights up;
      // dropping appends the item to that day (see commitPlanDrag).
      drag.collapsedIso = iso;
      markPlanDropTarget(drag.groups, group);
      card.style.transform = 'translateY(' + (y - drag.startY) + 'px) scale(1.02)';
      return;
    }
    drag.collapsedIso = null;
    if (list !== drag.list) {
      markPlanDropTarget(drag.groups, iso === drag.fromIso ? null : group);
      drag.list.classList.remove('has-drop');
      planInsertAt(list, card, y);
      drag.list = list;
      // The card just changed its layout position; re-zero the offset so it
      // stays exactly under the finger instead of jumping by the difference.
      drag.startY = y;
      card.style.transform = 'scale(1.02)';
      return;
    }
    markPlanDropTarget(drag.groups, iso === drag.fromIso ? null : group);
    card.style.transform = 'translateY(' + (y - drag.startY) + 'px) scale(1.02)';
    planCrossSiblings(list, card, y);
  }

  // Runs every frame for the whole life of a drag. When the finger is not in
  // an edge zone it costs one comparison and schedules the next frame.
  function planDragScrollTick() {
    if (!drag) return;
    drag.raf = window.requestAnimationFrame(planDragScrollTick);
    var h = window.innerHeight || 0;
    if (!h) return;
    var zone = Math.min(PLAN_DRAG_EDGE, h / 4);
    var y = drag.lastY;
    var v = 0;
    if (y < zone) v = -PLAN_DRAG_MAX_SPEED * ((zone - y) / zone);
    else if (y > h - zone) v = PLAN_DRAG_MAX_SPEED * ((y - (h - zone)) / zone);
    if (!v) return;
    var before = window.pageYOffset;
    window.scrollBy(0, v);
    var dy = window.pageYOffset - before;
    if (!dy) return; // already at the top or the bottom of the page
    // The page moved under a stationary finger, so the card's layout position
    // moved with it. Shifting the origin by the same amount keeps the card
    // pinned to the finger instead of sliding away as the page scrolls.
    drag.startY -= dy;
    planDragUpdate(y);
  }

  function planItemById(data, id) {
    var out = null;
    data.items.forEach(function (i) { if (i.id === id) out = i; });
    return out;
  }

  function cardInViewport(card) {
    var r = card.getBoundingClientRect();
    var h = window.innerHeight || 0;
    return r.bottom > 0 && r.top < h;
  }

  // Turns where the card ended up into saved state: the day it now belongs to
  // (setDay, through the same displayed-date indirection the day picker uses)
  // and the arrangement of every day the drag touched.
  function commitPlanDrag(d) {
    var st = ctx.store.load();
    // Section tabs write one thing and touch nothing else: the order of the
    // list the card is in. No day changes hands here (the card never left its
    // section, and a section is not a date), so setDay is deliberately not
    // called, and the item's day chip reads exactly what it read before.
    if (d.mode === 'section') {
      var secId = d.list.getAttribute('data-sec-id');
      if (!secId) { rerender(); return; }
      setSectionItemOrder(st, secId, planCardIds(d.list));
      ctx.store.save(st);
      if (!cardInViewport(d.card)) justMoved = d.itemId;
      rerender();
      return;
    }
    var data = effectiveData(ctx.base, st);
    var it = planItemById(data, d.itemId);
    var toIso, ids, fromIds = null, offscreen = false;
    if (d.collapsedIso) {
      toIso = d.collapsedIso;
      var pm = planModel(data, st);
      var day = null;
      if (pm.todayIso === toIso) day = { items: pm.today };
      pm.days.forEach(function (x) { if (x.iso === toIso) day = x; });
      ids = (day ? day.items.map(function (e) { return e.it.id; }) : [])
        .filter(function (id) { return id !== d.itemId; })
        .concat([d.itemId]);
      fromIds = planCardIds(d.fromList).filter(function (id) { return id !== d.itemId; });
      // A collapsed day renders no card at all, so on its own this drop would
      // show the traveler nothing but a count going up in a heading. Open the
      // day (their collapse choice is one tap to restore, and they just chose
      // this day deliberately) and reveal the card, so the drop has the same
      // visible result every other drop has.
      if (isPlanDayCollapsed(st, toIso, day && day.auto)) expandPlanDay(st, toIso, day && day.auto);
      offscreen = true;
    } else {
      toIso = d.list.getAttribute('data-day-iso');
      ids = planCardIds(d.list);
      if (d.list !== d.fromList) fromIds = planCardIds(d.fromList);
      offscreen = !cardInViewport(d.card);
    }
    if (!isIso(toIso)) { rerender(); return; }
    if (toIso !== d.fromIso && it) {
      setDay(st, d.itemId, keyForDisplayedDate(data, st, it.section, toIso));
    }
    setDayItemOrder(st, toIso, ids);
    if (fromIds) setDayItemOrder(st, d.fromIso, fromIds);
    ctx.store.save(st);
    if (offscreen) justMoved = d.itemId;
    rerender();
  }

  // Drops an in-flight drag without committing it (a rerender under the
  // finger, a city switch, a modal opening). Safe to call with no drag.
  function cancelPlanDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.raf && window.cancelAnimationFrame) window.cancelAnimationFrame(d.raf);
    try { d.grip.releasePointerCapture(d.pointerId); } catch (e) {}
    if (d.card) { d.card.classList.remove('dragging'); d.card.style.transform = ''; }
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('plan-dragging');
  }

  function onPlanDragStart(e) {
    // A context still standing at pointerdown means the previous drag never
    // got its pointerup (a lost pointer capture, a pointer that left the
    // window). Dropping it here rather than returning early is what stops one
    // lost event from wedging the grip for the rest of the session.
    if (drag) cancelPlanDrag();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var grip = (e.target && e.target.closest) ? e.target.closest('.plangrip') : null;
    if (!grip) return;
    var card = grip.closest('.card');
    var list = card ? card.parentNode : null;
    var mode = dragListMode(list);
    if (!card || !mode) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    var main = document.getElementById('main');
    drag = {
      mode: mode,
      card: card, grip: grip, pointerId: e.pointerId,
      itemId: card.getAttribute('data-item-id'),
      list: list, fromList: list, fromIso: list.getAttribute('data-day-iso'),
      groups: (mode === 'day' && main) ? Array.prototype.slice.call(main.querySelectorAll('.planday')) : [],
      startY: e.clientY, lastY: e.clientY, collapsedIso: null, raf: null, moved: false
    };
    card.classList.add('dragging');
    document.body.classList.add('plan-dragging');
    if (window.requestAnimationFrame) drag.raf = window.requestAnimationFrame(planDragScrollTick);
  }

  function onPlanDragMove(e) {
    if (!drag) return;
    if (!drag.card.parentNode) { cancelPlanDrag(); return; }
    e.preventDefault();
    drag.lastY = e.clientY;
    drag.moved = true;
    planDragUpdate(e.clientY);
  }

  function onPlanDragEnd(e) {
    if (!drag) return;
    var d = drag;
    var moved = d.moved;
    var groups = d.groups;
    var lists = d.list;
    cancelPlanDrag();
    groups.forEach(function (g) { g.classList.remove('drop-into'); });
    if (lists && lists.classList) lists.classList.remove('has-drop');
    if (d.fromList && d.fromList.classList) d.fromList.classList.remove('has-drop');
    // A tap on the grip that never moved is not a reorder; it must not write
    // state or rebuild the page under the traveler's finger.
    if (!moved || !d.itemId) return;
    commitPlanDrag(d);
  }

  // Keyboard equivalent of the drag, on the grip itself: up and down reorder
  // the item inside its day and persist immediately. Cross-day moves stay
  // with the card's own "Change day" control (which is a list of dates, and
  // is what the grip's aria-label points at), rather than inventing a
  // keyboard gesture for crossing a day boundary.
  function onPlanGripKey(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    var grip = (e.target && e.target.closest) ? e.target.closest('.plangrip') : null;
    if (!grip) return;
    var card = grip.closest('.card');
    var list = card ? card.parentNode : null;
    var mode = dragListMode(list);
    if (!card || !mode) return;
    var cards = planListCards(list);
    var i = cards.indexOf(card);
    var j = (e.key === 'ArrowUp') ? i - 1 : i + 1;
    if (i === -1 || j < 0 || j >= cards.length) return;
    e.preventDefault();
    cards.splice(i, 1);
    cards.splice(j, 0, card);
    var ids = cards.map(function (c) { return c.getAttribute('data-item-id'); });
    var st = ctx.store.load();
    if (mode === 'section') {
      var secId = list.getAttribute('data-sec-id');
      if (!secId) return;
      setSectionItemOrder(st, secId, ids);
    } else {
      var iso = list.getAttribute('data-day-iso');
      if (!isIso(iso)) return;
      setDayItemOrder(st, iso, ids);
    }
    ctx.store.save(st);
    // The rerender rebuilds every node, so the grip that had focus is gone by
    // the time the new one exists; restoreGripFocus() puts it back after the
    // render, which is what makes a second arrow press land on the same item.
    focusGripItem = card.getAttribute('data-item-id');
    rerender();
  }

  function restoreGripFocus() {
    if (!focusGripItem) return;
    var id = focusGripItem;
    focusGripItem = null;
    var main = document.getElementById('main');
    if (!main) return;
    var cards = main.querySelectorAll('[data-item-id]');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-item-id') !== id) continue;
      var g = cards[i].querySelector('.plangrip');
      if (g && g.focus) { try { g.focus({ preventScroll: false }); } catch (e) { g.focus(); } }
      return;
    }
  }

  // The grip itself: same six-dot handle Phase 3 used for day cards, sized up
  // to a 40x44 target here (a coarse pointer needs at least 36px, and this one
  // sits beside real controls it must never be mistaken for).
  function dragGrip(aria) {
    var g = el('div', 'plangrip');
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    g.setAttribute('aria-label', aria);
    g.innerHTML = '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
      '<circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>' +
      '<circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>' +
      '<circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>';
    return g;
  }

  function planGrip(it) {
    return dragGrip('Reorder ' + effectiveName(it, curState) +
      ' within this day: drag it, or use the up and down arrow keys. ' +
      'To put it on a different day, drag it onto that day, or use the Change day button on this card.');
  }

  // The same handle on a section tab. It says "within this list" rather than
  // "within this day" because a section spans the whole trip, and it does not
  // offer the cross-container drop the Plan grip does: a card here cannot be
  // dragged into another SECTION (an item belongs to the section the guide
  // put it in), only up and down its own. Changing the DAY is still one tap
  // away on the card's own Change day control, which is what the label points
  // at rather than inventing a gesture that would look like it should work.
  function sectionGrip(it, sec) {
    return dragGrip('Reorder ' + effectiveName(it, curState) + ' within ' +
      ((sec && sec.label) || 'this list') +
      ': drag it, or use the up and down arrow keys. ' +
      'To put it on a day, use the day button on this card.');
  }

  var shareOn = false;

  function renderShare() {
    var state = ctx.store.load();
    curState = state;
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
        var tname = el('span', 'tname');
        if (e.status === 'done') tname.appendChild(el('span', 'donemark', '✓'));
        tname.appendChild(document.createTextNode(effectiveName(e.it, state)));
        h3.appendChild(tname);
        var shareBadge = ratingBadge(e.it.rating, true);
        if (shareBadge) h3.appendChild(shareBadge);
        if (e.it.price) h3.appendChild(el('span', 'price', e.it.price.text));
        bd.appendChild(h3);
        var meta = (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label + (e.it.when ? ' · ' + e.it.when : '');
        bd.appendChild(el('p', 'when-line', meta));
        if (e.it.hours) {
          var row = el('div', 'row');
          row.appendChild(el('span', 'hours' + (e.it.hours.class ? ' ' + e.it.hours.class : ''), e.it.hours.text));
          bd.appendChild(row);
        }
        if (e.it.intel) {
          var shareStrip = intelShareStrip(e.it.intel);
          if (shareStrip) bd.appendChild(shareStrip);
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
        var tname = el('span', 'tname');
        if (e.status === 'done') tname.appendChild(el('span', 'donemark', '✓'));
        tname.appendChild(document.createTextNode(effectiveName(e.it, state)));
        h3.appendChild(tname);
        var undatedBadge = ratingBadge(e.it.rating, true);
        if (undatedBadge) h3.appendChild(undatedBadge);
        if (e.it.price) h3.appendChild(el('span', 'price', e.it.price.text));
        card.appendChild(h3);
        card.appendChild(el('p', 'when-line', (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label));
        if (e.it.intel) {
          var undatedStrip = intelShareStrip(e.it.intel);
          if (undatedStrip) card.appendChild(undatedStrip);
        }
        main.appendChild(card);
      });
    }
  }

  // Phase 4: an "Open tasks" row. Its whole job is the checkbox: checked
  // means done, using the exact same setStatus/effectiveStatus semantics as
  // every other status control, so a task is a first-class item (undo-able,
  // exportable) and not a second state shape. Ticking a completed task again
  // unticks it, back to plan.
  //
  // A task has three outcomes, not two: done, still open, and declined ("we
  // are not doing that"). Declining writes the EXISTING archived status, so
  // a declined task is the same first-class item as any other and needs no
  // new state shape. The controls follow the status, and every one of the
  // three is reachable from every other:
  //   open      -> tick the box (done), or tap ✕ (declined)
  //   done      -> untick the box (open)
  //   declined  -> tap ↩ (open); there is no checkbox, because ticking a
  //                task you already said no to is not an action with a
  //                meaning, and a control that cannot succeed does not ship.
  // House default for action controls: icon plus hover tooltip plus
  // aria-label, no visible text. Decline keeps no text label even though it
  // is the destructive-looking one, because unlike Archive on a card it is
  // one tap from undone and the row sits in a list of checkboxes where a word
  // would read as part of the task.
  function taskIconBtn(icon, aria, cls, onclick) {
    var b = el('button', 'ctl icon-btn task-ctl' + (cls ? ' ' + cls : ''), icon);
    b.type = 'button';
    b.setAttribute('aria-label', aria);
    b.title = aria;
    b.onclick = onclick;
    return b;
  }

  function renderTaskRow(it, status) {
    var declined = status === 'archived';
    var row = el('div', 'task-row' +
      (status === 'done' ? ' item-done' : '') + (declined ? ' task-declined' : ''));
    // Stamped for the same reason every card is: so revealJustMoved can find
    // this row again after a re-render moved it. A task carries no pin
    // control today, so nothing routinely reveals one, but a state synced
    // from elsewhere can name a task id and the reveal should land rather
    // than fall through to the "no card on this tab" line.
    row.setAttribute('data-item-id', it.id);
    var line = el('div', 'task-line');
    var name = effectiveName(it, curState);
    if (declined) {
      line.appendChild(el('span', 'task-check task-check-off', name));
    } else {
      var label = el('label', 'task-check');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = status === 'done';
      cb.setAttribute('aria-label', (status === 'done' ? 'Mark not done: ' : 'Mark done: ') + name);
      cb.onchange = function () { onStatus(it.id, cb.checked ? 'done' : 'plan'); };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + name));
      line.appendChild(label);
    }
    if (declined) {
      line.appendChild(taskIconBtn('↩', 'Restore to open tasks: ' + name, 'to-plan',
        function () { onStatus(it.id, 'plan'); }));
    } else if (status === 'plan') {
      line.appendChild(taskIconBtn('✕', 'Won\'t do: ' + name, 'to-archived',
        function () { onStatus(it.id, 'archived'); }));
    }
    row.appendChild(line);
    if (it.note) row.appendChild(el('p', 'task-note', it.note));
    return row;
  }

  // Every day on the Plan tab is one .planday group holding its heading and
  // (unless collapsed) one .planlist of cards. That structure is what the
  // drag code reads: the group is the drop target, the list is what gets
  // reordered, and data-day-iso on both is the date a drop writes.
  function planDayGroup(iso) {
    var group = el('div', 'planday');
    group.setAttribute('data-day-iso', iso);
    return group;
  }

  function planDayList(iso, entries) {
    var list = el('div', 'planlist');
    list.setAttribute('data-day-iso', iso);
    if (!entries.length) {
      list.appendChild(el('p', 'when-line empty-note', 'Nothing planned yet.'));
      return list;
    }
    entries.forEach(function (e) {
      var card = el('div', 'card dragrow' + (e.status === 'done' ? ' item-done' : ''));
      card.appendChild(planGrip(e.it));
      // The section used to be a whole line of its own above the title
      // (.sec-meta). It is now the icon in front of the title, with the
      // label kept as that icon's tooltip and accessible name: on a phone
      // that line was 20-odd pixels per card spent restating something the
      // icon already says.
      appendCard(card, e.it, e.status, true, 'labeled', null, e.sec);
      list.appendChild(card);
    });
    return list;
  }

  // Phase 4: the Plan tab, the new default landing tab and the home of every
  // date. Reads planModel() (pure, tested on its own): today first, then
  // every other day of the stay in order (expanded by default so the whole
  // stay reads top to bottom on page load; a day with nothing assigned says
  // so instead of rendering an empty card), then open tasks with done ones
  // sunk below, collapsed.
  function renderPlanTab(data, state) {
    var pm = planModel(data, state);
    var main = document.getElementById('main');
    main.innerHTML = '';
    if (!pm.inRange) {
      main.appendChild(el('p', 'when-line',
        'Today (' + dayLabel(pm.todayIso) + ') is outside this trip\'s dates (' +
        fmtRange(effectiveDates(data, state)) + '). Showing anything dated today anyway.'));
    }
    // Over the REMAINING days only: today's group has no toggle (you are
    // never collapsing the day you are standing in), so a link that claimed
    // to act on "all" of them would be lying about one.
    var dayIsos = pm.days.map(function (d) { return d.iso; }).filter(Boolean);
    var dayAutos = {};
    pm.days.forEach(function (d) { if (d.iso) dayAutos[d.iso] = !!d.auto; });
    var xall = renderExpandAll(dayIsos.length > 1, function (st, collapsed) {
      setPlanDaysCollapsed(st, dayIsos, collapsed, dayAutos);
    });
    if (xall) main.appendChild(xall);
    // Today wears the same visual language as the wheres tracker's
    // you-are-here banner: accent frame, corner badge, elevated. Without it
    // the pinned group reads as a day sorted out of order rather than a
    // deliberate "you are here". The badge carries the word TODAY, so the
    // heading only needs the date.
    var todayGroup = planDayGroup(pm.todayIso);
    todayGroup.className += ' planday-today';
    todayGroup.appendChild(el('h2', null, dayLabel(pm.todayIso)));
    todayGroup.appendChild(planDayList(pm.todayIso, pm.today));
    main.appendChild(todayGroup);
    pm.days.forEach(function (d) {
      var group = planDayGroup(d.iso);
      var collapsed = isPlanDayCollapsed(state, d.iso, d.auto);
      // A finished past day says so in three words and gets out of the way.
      // Any other collapsed day keeps the plain item count it always had: "n
      // done" on a day with anything still open would be a lie of omission.
      var settled = d.auto && collapsed;
      var h2 = el('h2', 'planday-hd' + (collapsed ? ' collapsed' : '') + (settled ? ' planday-settled' : ''));
      var tbtn = el('button', 'sec-toggle');
      tbtn.type = 'button';
      tbtn.setAttribute('aria-expanded', String(!collapsed));
      tbtn.appendChild(el('span', 'chev', collapsed ? '▸' : '▾'));
      tbtn.appendChild(document.createTextNode(' ' + d.label + ' '));
      tbtn.appendChild(el('span', 'sec-count',
        settled ? '(' + d.done + ' done ✓)'
                : '(' + d.items.length + (d.items.length === 1 ? ' item' : ' items') + ')'));
      tbtn.onclick = function () {
        var st = ctx.store.load();
        togglePlanDay(st, d.iso, d.auto);
        ctx.store.save(st);
        rerender();
      };
      h2.appendChild(tbtn);
      group.appendChild(h2);
      // A collapsed day deliberately gets NO list: the group is still a drop
      // target (its header is what the dragged card lands on), and having no
      // list is exactly how the drag code recognizes the collapsed case.
      if (!collapsed) group.appendChild(planDayList(d.iso, d.items));
      main.appendChild(group);
    });
    if (pm.openTasks.length || pm.doneTasks.length || pm.declinedTasks.length) {
      main.appendChild(el('h2', null, 'Open tasks'));
      pm.openTasks.forEach(function (e) { main.appendChild(renderTaskRow(e.it, e.status)); });
      // Two settled-outcome disclosures, both collapsed, both in the same
      // visual language (.arch-details uppercases its summary, so these read
      // as DONE (n) and WON'T DO (n)). Done first because it is the outcome
      // the traveler wants to see they earned; declined below it because it
      // is the one they are done thinking about.
      if (pm.doneTasks.length) {
        var det = el('details', 'arch-details');
        det.appendChild(el('summary', null, 'Done (' + pm.doneTasks.length + ')'));
        pm.doneTasks.forEach(function (e) { det.appendChild(renderTaskRow(e.it, e.status)); });
        main.appendChild(det);
      }
      if (pm.declinedTasks.length) {
        var wdet = el('details', 'arch-details');
        wdet.appendChild(el('summary', null, 'Won\'t do (' + pm.declinedTasks.length + ')'));
        pm.declinedTasks.forEach(function (e) { wdet.appendChild(renderTaskRow(e.it, e.status)); });
        main.appendChild(wdet);
      }
    }
  }

  function rerender() {
    // Any in-flight drag references nodes from the previous render's #main;
    // drop it so a stray window pointerup after a rerender is a no-op.
    cancelPlanDrag();
    var state = ctx.store.load();
    curState = state;
    secById = null;   // the data may have changed under it (see sectionFor)
    var data = effectiveData(ctx.base, state);
    var totalItems = Array.isArray(data.items) ? data.items.length : 0;
    var tab = effectiveTab(state);
    renderHeader(data, state);
    renderToolbar(data, state);
    renderTabBar(data, state, tab);
    var vms = viewModel(data, state);
    if (shareOn) {
      renderSectionNav([], state, totalItems, 'hide');
      renderShare();
    } else if (tab === 'plan') {
      // Plan is not section-organized (it groups by date, then tasks), so
      // the sticky "jump to section" nav never applies here, same as Share.
      renderSectionNav([], state, totalItems, 'hide');
      renderPlanTab(data, state);
    } else {
      var tabVms = vms.filter(function (sv) { return tabForSection(sv.section) === tab; });
      renderSectionNav(tabVms, state, totalItems, 'tab');
      if (tab === 'info') renderInfoTab(tabVms, state, totalItems);
      else renderTabSections(tabVms, state, totalItems);
    }
    var foot = document.getElementById('foot');
    // The data-locality clause this line used to carry went in the
    // 2026-08-26 privacy sweep. It was accurate for a standalone guide file
    // and wrong for the hosted app, which also keeps rows in a synced
    // account and sends prompts to an AI provider, and this one line is
    // rendered by BOTH. A footer is not the place to describe where data
    // lives; a footer that describes it wrongly is worse than one that stays
    // quiet. See docs/ for the removed strings.
    foot.textContent = 'cityops · schema v1';
    var notice = document.getElementById('notice');
    notice.textContent = ctx.store.persistent ? '' :
      'Private mode: changes hold for this session only and are not saved.';
    // Both run after #main is fully rebuilt: the card and the grip they look
    // for only exist now.
    revealJustMoved();
    restoreGripFocus();
    // Additive hook: the app shell sets this to re-render its citybar (name/dates)
    // whenever engine state changes, without the shell re-implementing rerender.
    if (CityOps.onStateChange) CityOps.onStateChange();
  }

  // Live in-memory state for the currently booted city, bypassing a fresh
  // makeStore() read. In private/incognito mode makeStore() falls back to a
  // per-instance memory cache that a NEW store instance would not see, so
  // exportStandalone must read the live ctx.store rather than re-deriving one.
  function liveState() {
    return ctx ? ctx.store.load() : null;
  }

  // Deliberately does NOT bake state.dayItemOrder (the Plan tab's within-day
  // item order) into the exported item positions. The export's item array is
  // SECTION-major: rank is handed out section by section, then day by day
  // inside each section, so two items on the same date but in different
  // sections are never adjacent in the array. A Plan-tab day order routinely
  // interleaves sections (cowork, nails, barber, dinner), and array position
  // simply cannot express it: baking would encode a partial, per-section
  // shadow of the arrangement and quietly lose the rest, which is worse than
  // not encoding it at all. It would also put a second, disagreeing source of
  // truth next to dayItemOrder itself.
  //
  // Nothing is lost by leaving it out: dayItemOrder lives in the state object,
  // which is what syncs between the traveler's devices (syncKit pushes the
  // whole state as one payload), so a day arranged on the phone reads the same
  // on the laptop. What an exported guide.json carries is the guide, plus
  // status/day/title decisions that belong to the data; how one day's cards
  // are stacked is a device-side view preference, like a collapsed section.
  //
  // state.sectionItemOrder (the section tabs' within-section order) is left out
  // for the second of those reasons, not the first. A section-major array COULD
  // express it, since that order never crosses a section boundary. It stays out
  // anyway: baking it would make the array a second place the arrangement is
  // written down, and the two would disagree the moment a guide exported on one
  // device is opened on another that has its own sectionItemOrder. One source
  // of truth, and it syncs with the rest of the state.
  function buildExport(data, state) {
    var out = JSON.parse(JSON.stringify(data));
    out.city.dates = JSON.parse(JSON.stringify(effectiveDates(data, state)));
    out.items.forEach(function (it) {
      it.status = effectiveStatus(it, state);
      it.name = effectiveName(it, state);
      var d = effectiveDay(it, state);
      if (d) { it.day = d; } else { delete it.day; }
    });
    var vm = viewModel(out, { itemStatus: {}, itemDay: {}, dayOrder: state.dayOrder || {}, dataOverride: null, stayOverride: null });
    var rank = {};
    var r = 0;
    var byId = {};
    out.items.forEach(function (it) { byId[it.id] = it; });
    vm.forEach(function (sv) {
      sv.days.forEach(function (d) {
        d.items.forEach(function (it) {
          byId[it.id].day = d.iso; // bake the slot date the planner displays
          rank[it.id] = r++;
        });
      });
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

  // ---- Add a place by hand ----
  // Owner scenario: heard about a restaurant over dinner, wants it in the
  // system tonight, next to the options it has to beat.
  //
  // Two entry points, on purpose, because they answer two different moments:
  //   - the + on a section header, which is where the traveler already IS
  //     when the thought occurs ("we should try that instead of one of
  //     these") and which fills the section in for free;
  //   - a row in the More sheet's "Add and update" cluster, which works from
  //     the Plan tab and from Share view, where no section header is on
  //     screen at all.
  // Both open this one modal and take the same road out of it.
  //
  // The road out is mergeDelta, exactly as if an AI pass had returned the
  // item, so there is no second way into the items array (see newPlaceDelta).
  // Where the merged guide is WRITTEN depends on what is around it:
  //   - in the app (window.CityOpsApp.notePlaceAdded present) it goes to the
  //     city's canonical record and syncs to the traveler's other devices,
  //     signed in or not.
  //   - in a standalone exported guide there is no canonical record to write,
  //     so it goes to state.dataOverride, the same per-device override the
  //     engine's own "Update data" has always used. The place is real, it
  //     persists, and Export JSON bakes it in permanently.
  function openAddPlaceModal(defaultSecId) {
    var host = document.getElementById('modal');
    host.innerHTML = '';
    var st0 = ctx.store.load();
    var data0 = effectiveData(ctx.base, st0);
    // Every section EXCEPT the ones the Plan tab owns. That is one rule where
    // it used to be a to-do-list exclusion, and it covers the case that was
    // wrong: Tirana's "Daily plan" is not a task section, but the Plan tab
    // renders only items that carry a day, so a place added there with the
    // default "No day yet" was written and then appeared nowhere at all. A
    // picker should not offer a destination the result is invisible in, and
    // this is called Add a PLACE, not Add an itinerary stop.
    var sections = (Array.isArray(data0.sections) ? data0.sections : []).filter(function (s) {
      return s && s.id && tabForSection(s) !== 'plan';
    });
    var wrap = el('div', 'modal-wrap');
    var box = el('div', 'modal');
    box.appendChild(el('h3', null, 'Add a place'));
    box.appendChild(el('p', 'diff', 'Somewhere you heard about and want to weigh against ' +
      'what is already here. It joins this city like any other item, and nothing ' +
      'you have already planned moves.'));

    function field(labelText, control, hint) {
      var w = el('div', 'field');
      var lab = el('label', 'field-label', labelText);
      var id = 'ap-' + slug(labelText);
      control.id = id;
      lab.setAttribute('for', id);
      w.appendChild(lab);
      w.appendChild(control);
      if (hint) w.appendChild(el('div', 'field-hint', hint));
      return w;
    }
    function select(options, value) {
      var s = document.createElement('select');
      s.className = 'date-field';
      options.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o.value;
        op.textContent = o.label;
        if (o.value === value) op.selected = true;
        s.appendChild(op);
      });
      return s;
    }

    var nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'date-field';
    nameIn.placeholder = 'Name of the place';
    box.appendChild(field('Name', nameIn));

    // Opened from a section header, the section is known and prefilled.
    // Opened from the More sheet there is no section on screen to infer one
    // from, and defaulting to whichever section happens to be listed first
    // (Tirana's is "Base", its apartment notes) would file a restaurant there
    // for anyone who did not read the picker. So that case ASKS, and Add
    // refuses until it is answered.
    var known = defaultSecId && sections.filter(function (s) { return s.id === defaultSecId; }).length;
    var secOpts = sections.map(function (s) {
      return { value: s.id, label: (s.icon ? s.icon + ' ' : '') + s.label };
    });
    if (!known) secOpts.unshift({ value: '', label: 'Pick a section' });
    var secSel = select(secOpts, known ? defaultSecId : '');
    box.appendChild(field('Section', secSel));

    var statusSel = select([
      { value: 'plan', label: 'In the plan' },
      { value: 'backup', label: 'Backup, if it earns it' }
    ], 'plan');
    box.appendChild(field('Status', statusSel));

    var dayOpts = [{ value: '', label: 'No day yet' }];
    stayDates(effectiveDates(data0, st0)).forEach(function (iso) {
      dayOpts.push({ value: iso, label: dayLabel(iso) });
    });
    var daySel = select(dayOpts, '');
    box.appendChild(field('Day', daySel, 'Optional. You can drop it on a day later.'));

    // The research link. Optional, and the single highest-value optional
    // field on this form: a small independent place is often unfindable by
    // name (Pizzarté, Tirana, 2026-08-27), and one Google Maps pin turns a
    // failed research pass into a good one. It is stored as a real links[]
    // entry, so the card shows it whether or not Claude is ever asked.
    var linkIn = document.createElement('input');
    linkIn.type = 'url';
    linkIn.className = 'date-field';
    linkIn.placeholder = 'https://maps.app.goo.gl/...';
    box.appendChild(field('Map or website link', linkIn,
      'Optional, and it helps Claude find it. Paste the Google Maps pin or the place\'s own site.'));

    var noteIn = document.createElement('textarea');
    noteIn.className = 'note-field';
    noteIn.placeholder = 'Recommended by a couple at dinner';
    box.appendChild(field('Note', noteIn, 'Who told you, and what they said. Claude reads this when you ask it to check the place.'));

    var msg = el('div', 'diff', '');
    box.appendChild(msg);

    var row = el('div', 'mrow');
    var add = el('button', 'ctl to-done', 'Add');
    add.type = 'button';
    // A guide whose only sections are to-do lists has nowhere to put a place.
    // Vanishingly rare, but Add would then fail on every tap with "Pick a
    // section" and no section to pick, which is the one thing a control is
    // never allowed to do.
    if (!sections.length) {
      add.disabled = true;
      add.title = 'This guide has no section a place could go in.';
      msg.textContent = 'This guide has no place sections yet. Add one with ' +
        'Update data or an Enrich pass first.';
    }
    add.onclick = function () {
      var st = ctx.store.load();
      var data = effectiveData(ctx.base, st);
      var built = newPlaceDelta(data, {
        name: nameIn.value, section: secSel.value, status: statusSel.value,
        note: noteIn.value, day: daySel.value, link: linkIn.value
      });
      if (built.errors.length) { msg.textContent = built.errors.join(' '); return; }
      var res = mergeDelta(data, built.delta);
      if (!res.data) { msg.textContent = 'Not added:\n' + res.errors.join('\n'); return; }
      // mergeDelta reports an id it already holds as SKIPPED, with no errors
      // and unchanged data. Checking only res.data would close the modal, run
      // the write and say "Added", having added nothing. Nothing should be
      // able to reach this now (freePlaceId hands out a free id and the
      // lookup behind it is prototype-safe), which is exactly why it is worth
      // catching loudly rather than trusting.
      if (res.summary.added !== 1) {
        msg.textContent = 'Not added: this city already has an item with the id "' +
          built.id + '". Try a slightly different name.';
        return;
      }
      var secLabel = (sections.filter(function (s) { return s.id === secSel.value; })[0] || {}).label ||
        secSel.value;
      var placeName = trimStr(nameIn.value);
      wrap.remove();
      var hook = (typeof window !== 'undefined' && window && window.CityOpsApp &&
        window.CityOpsApp.notePlaceAdded) ? window.CityOpsApp.notePlaceAdded : null;
      if (hook) {
        hook(res.data, built.id);
      } else {
        st.dataOverride = res.data;
        ctx.store.save(st);
      }
      // Not a bare rerender: the new place's section is very often COLLAPSED
      // (a real guide's 11-item Restaurants block defaults that way), so a
      // plain rerender would leave the traveler looking at an unchanged
      // screen with a confirmation over it. revealItem opens the section,
      // switches to its tab, scrolls the card into view and rings it, and
      // says something different if it somehow could not.
      revealItem(built.id, 'Added ' + placeName + ' to ' + secLabel +
        (askPlaceHook() ? '. Tap ✨ on its card to have Claude check it against the rest.' : '.'));
    };
    var cancel = el('button', 'ctl', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = function () { wrap.remove(); };
    row.appendChild(add);
    row.appendChild(cancel);
    box.appendChild(row);
    wrap.appendChild(box);
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    host.appendChild(wrap);
    try { nameIn.focus(); } catch (e) {}
  }

  function openDatesModal() {
    var host = document.getElementById('modal');
    host.innerHTML = '';
    var st0 = ctx.store.load();
    var cur = effectiveDates(effectiveData(ctx.base, st0), st0);
    var wrap = el('div', 'modal-wrap');
    var box = el('div', 'modal');
    box.appendChild(el('h3', null, 'Edit stay dates'));
    box.appendChild(el('p', 'diff', 'Adjusts the stay on this device and adds empty day cards for the new range. The file is not changed; Export bakes the new dates in.'));
    function dateInput(iso) {
      var inp = document.createElement('input');
      inp.type = 'date';
      inp.className = 'date-field';
      inp.value = iso;
      return inp;
    }
    var fromIn = dateInput(cur.from);
    var toIn = dateInput(cur.to);
    var row1 = el('div', 'mrow');
    row1.appendChild(el('span', 'diff', 'From'));
    row1.appendChild(fromIn);
    row1.appendChild(el('span', 'diff', 'To'));
    row1.appendChild(toIn);
    box.appendChild(row1);
    var msg = el('div', 'diff', '');
    box.appendChild(msg);
    var row = el('div', 'mrow');
    var apply = el('button', 'ctl', 'Apply');
    apply.type = 'button';
    apply.onclick = function () {
      var st = ctx.store.load();
      try { setStayDates(st, fromIn.value, toIn.value); }
      catch (e) { msg.textContent = 'Invalid: ' + e.message; return; }
      ctx.store.save(st);
      wrap.remove();
      rerender();
    };
    var revert = el('button', 'ctl', 'Reset to file dates');
    revert.type = 'button';
    if (st0.stayOverride) {
      revert.onclick = function () {
        var st = ctx.store.load();
        st.stayOverride = null;
        ctx.store.save(st);
        wrap.remove();
        rerender();
      };
    } else {
      revert.disabled = true;
      revert.title = 'No date adjustment is active';
    }
    var cancel = el('button', 'ctl', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = function () { wrap.remove(); };
    row.appendChild(apply); row.appendChild(revert); row.appendChild(cancel);
    box.appendChild(row);
    wrap.appendChild(box);
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    host.appendChild(wrap);
    fromIn.focus();
  }

  function openUpdateModal() {
    var host = document.getElementById('modal');
    host.innerHTML = '';
    var wrap = el('div', 'modal-wrap');
    var box = el('div', 'modal');
    box.appendChild(el('h3', null, 'Update city data'));
    box.appendChild(el('p', 'diff', 'Paste this city\'s research again: schema v1 JSON, or the guide as markdown. ' +
      'It is stored on this device as an override; the file itself is not changed. Export and paste into the file to make it permanent.'));
    var ta = document.createElement('textarea');
    box.appendChild(ta);
    var msg = el('div', 'diff', '');
    box.appendChild(msg);
    var row = el('div', 'mrow');
    var apply = el('button', 'ctl', 'Apply');
    apply.type = 'button';
    // This door replaces a city WHOLESALE, so what the traveler already knows
    // about it (its name and its dates) is what intake reads a headerless
    // markdown paste against. A guide pasted as headings and bullets needs no
    // header line of its own here, because the city is already open.
    function updateIntakeOpts() {
      var cur = effectiveData(ctx.base, ctx.store.load());
      var d = (cur && cur.city && cur.city.dates) || {};
      return { mode: 'city', header: {
        name: cur && cur.city ? cur.city.name : '', country: cur && cur.city ? cur.city.country : '',
        from: d.from, to: d.to } };
    }
    // The engine ships inside standalone guide files with no network at all,
    // so the one-tap conversion the app shell offers cannot live here. The
    // free path can, and does: the prompt goes to the clipboard, or into a
    // selected box when the clipboard is out of reach.
    var convertRow = null, convertTa = null;
    function copyConversionPrompt(text) {
      var wrote = null;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) wrote = navigator.clipboard.writeText(text);
      } catch (e) { wrote = null; }
      function fallback() {
        if (!convertTa) {
          convertTa = document.createElement('textarea');
          convertTa.readOnly = true;
          convertTa.setAttribute('aria-label', 'Conversion prompt');
          box.insertBefore(convertTa, msg);
        }
        convertTa.value = text;
        msg.textContent = 'Could not reach the clipboard. The prompt is selected above: copy it, ' +
          'paste it into Claude or ChatGPT, then paste the JSON it returns below.';
        try { convertTa.focus(); convertTa.select(); } catch (e2) {}
      }
      if (wrote && typeof wrote.then === 'function') {
        wrote.then(function () {
          msg.textContent = 'Copied. Paste it into Claude or ChatGPT, then paste the JSON it returns below.';
        }, fallback);
      } else { fallback(); }
    }
    function dropConvertRow() {
      if (convertRow && convertRow.parentNode) convertRow.parentNode.removeChild(convertRow);
      convertRow = null;
    }
    function offerConvert(text) {
      if (convertRow) return;
      convertRow = el('div', 'mrow');
      var copy = el('button', 'ctl', 'Copy conversion prompt');
      copy.type = 'button';
      copy.onclick = function () {
        copyConversionPrompt(intakeKit_conversionPrompt(text, updateIntakeOpts()));
      };
      convertRow.appendChild(copy);
      box.insertBefore(convertRow, row);
    }
    // Two presses when tolerance was used, one when it was not: the same rule
    // the app shell's paste doors follow, so the two halves of the product
    // behave identically on the same paste.
    var pending = null;
    ta.addEventListener('input', function () {
      if (pending) { pending = null; apply.textContent = 'Apply'; }
      dropConvertRow();
    });
    apply.onclick = function () {
      var data = pending;
      if (!data) {
        var read = intakeRead(ta.value, updateIntakeOpts());
        if (!read.ok) {
          msg.textContent = read.message;
          if (read.convertible) offerConvert(ta.value); else dropConvertRow();
          return;
        }
        dropConvertRow();
        if (read.tolerant) {
          pending = read.data;
          apply.textContent = 'Confirm';
          msg.textContent = read.message + ' Press Confirm to replace this city with it.';
          return;
        }
        data = read.data;
      }
      pending = null;
      apply.textContent = 'Apply';
      dropConvertRow();
      var st = ctx.store.load();
      var current = effectiveData(ctx.base, st);
      var summary = diffSummary(current, data);
      st.dataOverride = data;
      ctx.store.save(st);
      pendingPromote = pendingMove = pendingEdit = justMoved = null; // item ids may change under an override
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
        pendingPromote = pendingMove = pendingEdit = justMoved = null;
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
    host.appendChild(wrap);
    ta.focus();
  }

  // Phase 4, item 7 (nav cleanup): every utility action that used to live in
  // the toolbar (Share view, Export JSON, Update data, Edit dates, plus the
  // app-only Enrich, Edit city, Export guide, Remove city) now lives in ONE
  // "More" action sheet, opened from the overflow chip at the end of the tab
  // bar. doExportJson is pulled out to its own function so both this sheet
  // and (if ever needed again) another entry point can call it identically.
  function doExportJson() {
    var st = ctx.store.load();
    var out = buildExport(effectiveData(ctx.base, st), st);
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = cityId(out) + '.cityops.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    var freeUrl = a.href;
    setTimeout(function () { URL.revokeObjectURL(freeUrl); }, 4000);
  }

  // The sheet's three clusters, top to bottom. Owner ask, Aug 2026: "better
  // layout our nav to be better ux, more clear without having to study each
  // line item. prioritize functions that are more likely to be used, group
  // related items". So: the things a traveler touches during a trip first,
  // the things that send the trip somewhere else second, and the two that own
  // the city record itself last, where the destructive one is furthest from a
  // thumb reaching for Enrich.
  // `last: true` marks the cluster that gets fenced off above (a rule and extra
  // space), which is where the destructive row lives. It used to be decided in
  // the renderer by comparing the group id to the literal 'city', which only
  // worked because there was one surface with one set of clusters. The trip
  // surface has its own three, and its destructive row is Reset everything.
  var MORE_GROUPS = [
    { id: 'work', label: 'Add and update' },
    { id: 'share', label: 'Share and export' },
    { id: 'city', label: 'This city', last: true }
  ];

  // Pure: turns a flat row list into [{id, label, last, rows}], each group's
  // rows sorted by their own `order` and empty groups dropped (a standalone
  // guide has no app rows at all, so its `city` group never renders). A row
  // whose group is not one of the clusters is NOT dropped: it joins the first
  // group at the end, because a row that silently vanishes from a menu is a
  // worse bug than a row in the wrong cluster.
  //
  // `groups` is a parameter rather than a closed-over constant since 2026-09-01:
  // the trip surface clusters its own actions (everyday / share and export /
  // this device or account) and reuses this exact function to do it, so the two
  // menus share their grouping rules instead of each having their own.
  function moreSheetGroups(rows, groups) {
    var list = Array.isArray(rows) ? rows : [];
    var defs = (Array.isArray(groups) && groups.length) ? groups : MORE_GROUPS;
    var known = {};
    defs.forEach(function (g) { known[g.id] = 1; });
    var out = [];
    defs.forEach(function (g, gi) {
      var inG = list.filter(function (r) {
        return r && (r.group === g.id || (gi === 0 && !known[r.group]));
      }).map(function (r, i) {
        return { r: r, i: i, order: (typeof r.order === 'number' ? r.order : 999) };
      });
      inG.sort(function (a, b) { return (a.order - b.order) || (a.i - b.i); });
      if (inG.length) {
        out.push({ id: g.id, label: g.label, last: !!g.last,
          rows: inG.map(function (x) { return x.r; }) });
      }
    });
    return out;
  }

  // The sheet's DOM, built into a container the caller owns. BOTH surfaces call
  // this: the guide side's openMoreSheet below, and the trip side's own two
  // sheets (its More menu and its stop switcher). Before this the trip surface
  // had no grouped menu at all, and building one would have meant a second
  // hand-written copy of these five elements and eight class names. The styling
  // moved to src/header.css for the same reason, so the markup and the rules
  // that dress it are now one source each.
  //
  // Every row is icon + label + one muted line saying what it does, because a
  // flat list of bare labels makes the reader rank them from scratch every
  // time. A row is a <button> unless it carries an `href`, in which case it is
  // an <a>: a door to another page should be middle-clickable and should show
  // its target in the status bar, and faking that with a button never does.
  // `onDone` fires after any row is activated, which is how the caller closes
  // itself without every row having to remember to.
  function renderSheetInto(box, rows, groups, onDone) {
    moreSheetGroups(rows, groups).forEach(function (g) {
      var group = el('div', 'sheet-group' + (g.last ? ' sheet-group-last' : ''));
      group.appendChild(el('div', 'sheet-grouplabel', g.label));
      var list = el('div', 'sheet-list');
      // The cluster label is a plain div, so name the list with it too: a
      // screen reader otherwise hears eight buttons with no grouping at all.
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', g.label);
      g.rows.forEach(function (r) {
        var b = el(r.href ? 'a' : 'button', 'sheet-row' + (r.cls ? ' ' + r.cls : ''));
        if (r.href) { b.href = r.href; } else { b.type = 'button'; }
        if (r.title) b.title = r.title;
        var ic = el('span', 'sheet-ic', r.icon || '·');
        ic.setAttribute('aria-hidden', 'true');
        b.appendChild(ic);
        var txt = el('span', 'sheet-txt');
        txt.appendChild(el('span', 'sheet-label', r.label));
        if (r.desc) txt.appendChild(el('span', 'sheet-desc', r.desc));
        b.appendChild(txt);
        b.onclick = function () {
          if (onDone) onDone();
          if (r.onClick) r.onClick();
        };
        list.appendChild(b);
      });
      group.appendChild(list);
      box.appendChild(group);
    });
    return box;
  }

  // App-only rows (Enrich, Edit city, Export guide, Remove city) are supplied
  // by the shell via window.CityOpsApp.moreActions(), returning
  // [{label, desc, icon, group, order, onClick, cls}]. Standalone guide files
  // have no CityOpsApp, so the sheet there only ever shows the four base rows:
  // no trace of an app-only action ships inside them, and they land in the
  // same clusters they would in the app rather than drifting into a second
  // layout.
  //
  // The rows are this function's business; the DOM they turn into is
  // renderSheetInto's, shared with the trip surface's two sheets.
  function openMoreSheet() {
    var host = document.getElementById('modal');
    host.innerHTML = '';
    var wrap = el('div', 'modal-wrap');
    var box = el('div', 'modal');
    box.appendChild(el('h3', null, 'More'));
    var rows = [
      { label: shareOn ? 'Back to planner' : 'Share view',
        desc: shareOn ? 'Return to the planner and its controls'
          : 'Clean read-only page for sending or printing',
        icon: '👁', group: 'share', order: 10,
        onClick: function () {
          shareOn = !shareOn;
          document.body.classList.toggle('share', shareOn);
          rerender();
        } },
      { label: 'Export JSON', desc: 'Your data, portable',
        icon: '💾', group: 'share', order: 30, onClick: doExportJson },
      // The section-header + is the everyday door to this; the row exists so
      // the Plan tab and Share view, which show no section header at all,
      // are not dead ends for the same thought. Order 15 puts it directly
      // under Enrich, the other "get more into this city" row.
      { label: 'Add a place', desc: 'One you heard about, by hand',
        icon: '➕', group: 'work', order: 15,
        onClick: function () { openAddPlaceModal(null); } },
      { label: 'Update data', desc: 'Replace this city\'s research wholesale',
        icon: '🔄', group: 'work', order: 20, onClick: openUpdateModal },
      { label: 'Edit dates', desc: 'Move the arrival and departure days',
        icon: '📅', group: 'work', order: 30, onClick: openDatesModal }
    ];
    if (typeof window !== 'undefined' && window && window.CityOpsApp && window.CityOpsApp.moreActions) {
      rows = rows.concat(window.CityOpsApp.moreActions());
    }
    renderSheetInto(box, rows, MORE_GROUPS, function () { wrap.remove(); });
    wrap.appendChild(box);
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    host.appendChild(wrap);
  }

  // QA fix (Phase 4): #secnav is ALSO position:sticky top:0, so on a tab with
  // 2+ mapped sections (Eat & Drink and Services both hit this on the real
  // Tirana data) it would scroll up underneath #tabbar and disappear (both
  // pinned to the same top:0, #tabbar's z-index winning). #secnav's CSS reads
  // its offset from the --tabbar-h custom property instead of a bare 0; this
  // keeps that property in sync with the tab bar's actual rendered height, so
  // the two bars stack instead of overlapping. Recomputed on every tab-bar
  // render (font-size/padding changes at the narrow-phone breakpoint change
  // the height) and on window resize (a rotation or a browser chrome change
  // can cross that breakpoint without a rerender happening on its own).
  function updateTabbarHeightVar() {
    var bar = document.getElementById('tabbar');
    var root = (typeof document !== 'undefined' && document) ? document.documentElement : null;
    if (!bar || !root || !root.style || typeof root.style.setProperty !== 'function') return;
    var h = (typeof bar.offsetHeight === 'number') ? bar.offsetHeight : 0;
    root.style.setProperty('--tabbar-h', h + 'px');
  }

  // Phase 4: the sticky tab bar (Plan, Eat & Drink, Do, Services, Info) plus
  // the More overflow chip, replacing the old Today/Guide/Calendar segmented
  // control. Hidden while Share is on: share is a clean, printable read-only
  // layout, and the tab chrome (like every other control) has no place in
  // it; the sole way out is the Back-to-planner button renderToolbar shows
  // instead.
  function renderTabBar(data, state, tab) {
    var bar = document.getElementById('tabbar');
    if (!bar) return; // standalone/older shells without the marker: no-op
    bar.innerHTML = '';
    if (shareOn) {
      bar.hidden = true;
      updateTabbarHeightVar(); // hidden collapses to 0 height: #secnav's offset must follow
      return;
    }
    bar.hidden = false;
    bar.setAttribute('role', 'tablist');
    TABS.forEach(function (t) {
      var active = t.id === tab;
      var b = el('button', 'tabchip' + (active ? ' active' : ''), t.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(active));
      b.onclick = function () {
        var st = ctx.store.load();
        setTab(st, t.id);
        ctx.store.save(st);
        rerender();
      };
      bar.appendChild(b);
    });
    var more = el('button', 'tabchip tab-more', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', 'More actions');
    more.title = 'More actions';
    more.onclick = openMoreSheet;
    bar.appendChild(more);
    updateTabbarHeightVar();
  }

  // What is left of the old toolbar once every action moved into More: the
  // Back-to-planner exit while Share is on, and the "data updated in-app"
  // flag. Both are non-navigational, so they stay put rather than joining
  // the tab bar.
  function renderToolbar(data, state) {
    var tb = document.getElementById('toolbar');
    if (!tb) return;
    tb.innerHTML = '';
    if (shareOn) {
      var back = el('button', null, 'Back to planner');
      back.type = 'button';
      back.id = 'btn-share';
      back.onclick = function () {
        shareOn = false;
        document.body.classList.remove('share');
        rerender();
      };
      tb.appendChild(back);
    }
    if (state.dataOverride) {
      var flagText = 'Data updated in-app: export and paste into the file to make permanent';
      if (typeof window !== 'undefined' && window && window.CityOpsApp) {
        flagText = 'Data updated in-app: this override wins until you Replace the city or revert it';
      }
      tb.appendChild(el('span', 'flag', flagText));
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

  // boot(data) renders a parsed city. The app shell calls it again on every city
  // switch, so every piece of per-city session state is reset here; only the
  // window-level drag listeners survive, and they bind exactly once.
  function boot(data) {
    var storageRef = null;
    try { storageRef = (typeof localStorage !== 'undefined') ? localStorage : null; }
    catch (e) { storageRef = null; }
    ctx = { base: data, store: makeStore(cityId(data), storageRef) };
    curState = null;
    shareOn = false;
    pendingPromote = null;
    pendingMove = null;
    pendingEdit = null;
    itemExpandOverride = {};
    justMoved = null;
    focusGripItem = null;
    cancelPlanDrag();
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('share');
    if (!listenersBound && typeof window !== 'undefined' && window && window.addEventListener) {
      // Bound exactly once, for the life of the page: per-render binding would
      // stack a duplicate set on every rerender. They all read the shared
      // module-scope `drag` context and no-op while it is null.
      window.addEventListener('pointerdown', onPlanDragStart, { passive: false });
      window.addEventListener('pointermove', onPlanDragMove, { passive: false });
      window.addEventListener('pointerup', onPlanDragEnd);
      window.addEventListener('pointercancel', onPlanDragEnd);
      window.addEventListener('keydown', onPlanGripKey);
      // QA fix: a rotation or a browser-chrome change can cross the
      // narrow-phone breakpoint (which changes #tabbar's padding/height)
      // without any rerender happening on its own; keep --tabbar-h honest.
      window.addEventListener('resize', updateTabbarHeightVar);
      listenersBound = true;
    }
    rerender();
  }

  function init() {
    var elData = document.getElementById('city-data');
    if (!elData) return; // Node test harness path, and the app shell (no data block)
    var res = parse(elData.textContent);
    if (!res.data) { renderError(res.errors); return; }
    boot(res.data);
  }

  return {
    STATUSES: STATUSES, slug: slug, cityId: cityId, dayLabel: dayLabel,
    validate: validate, parse: parse, init: init, boot: boot,
    mergeDelta: mergeDelta,
    appStore: {
      normalize: normalizeAppStore, add: appAddCity,
      remove: appRemoveCity, keepBothName: keepBothName,
      resolveStartCity: resolveStartCity, blankCity: blankCity,
      exampleVisible: exampleCityVisible, pickCurrentCity: pickCurrentCity
    },
    profile: {
      normalize: normalizeProfile, isEmpty: profileIsEmpty,
      FACTOR_LEVELS: FACTOR_LEVELS, defaultFactors: defaultFactors,
      normalizeFactors: normalizeFactors
    },
    promptKit: {
      buildCityPrompt: buildCityPrompt, INTERESTS_SECTION: INTERESTS_SECTION,
      COPY_LINE: PROMPT_COPY_LINE,
      buildInterestsDeltaPrompt: buildInterestsDeltaPrompt,
      buildResearchAllPrompt: buildResearchAllPrompt,
      buildIntelPassPrompt: buildIntelPassPrompt,
      buildRatingsPassPrompt: buildRatingsPassPrompt,
      // The single-place pass: one item, plus the rest of its section as the
      // list it has to be ranked against.
      buildPlacePassPrompt: buildPlacePassPrompt, rosterLines: rosterLines
    },
    // The trip surface's door back to the guides: which guide a stop should
    // open, skipping the ones that are archived or no longer there. Pure, and
    // shared so both halves of the app answer it identically.
    guideDoorKit: {
      idFor: guideIdFor, liveIdForStop: liveGuideIdForStop, resolve: resolveGuideDoor
    },
    extractJsonBlock: extractJsonBlock, RETRY_INSTRUCTION: RETRY_INSTRUCTION,
    isJsonSyntaxError: isJsonSyntaxError, fetchTextToCity: fetchTextToCity,
    // The ONE door every paste box in the product goes through. Tolerance
    // lives here and only here: what comes out still faces validate(),
    // validateItem() and mergeDelta() exactly as a hand-typed payload does.
    intakeKit: {
      read: intakeRead, structured: readStructured, repair: repairCandidate,
      markdownToCity: markdownToCity, markdownToDelta: markdownToDelta,
      conversionPrompt: conversionPrompt, NEXT_STEP: INTAKE_NEXT_STEP,
      SECTIONS: MD_SECTIONS
    },
    // Who may write, and what a lapsed account keeps. The DATABASE enforces
    // this (public.has_active_entitlement, checked in the WITH CHECK of every
    // write policy); the kit is the same decision in pure JS so the app can
    // say WHY before a refusal happens, and never after.
    entitlementKit: {
      TRIAL_DAYS: ENT_TRIAL_DAYS, GRACE_DAYS: ENT_GRACE_DAYS, PRICE: ENT_PRICE,
      GATE_ACTIONS: ENT_GATE_ACTIONS,
      evaluate: evaluateEntitlement, summary: entitlementSummary, gate: entitlementGate,
      date: entitlementDate, plans: entitlementPlans, free: entitlementFree,
      // Localhost only, and that is checked inside the function rather than at
      // its call sites, because there is one of these and there would have
      // been two of those.
      mock: entitlementMock
    },
    // Managed AI: which transport a device should use, what the meter says, and
    // what the app says when the allowance runs out. Pure; the shells own the
    // fetch, the token and the DOM, exactly as they do for entitlementKit.
    aiProxyKit: {
      MONTHLY_OUTPUT_TOKENS: AI_MONTHLY_OUTPUT_TOKENS,
      GUIDE_OUTPUT_TOKENS: AI_GUIDE_OUTPUT_TOKENS,
      MAX_TOKENS: AI_MAX_TOKENS,
      LARGE_CALL_MIN_TOKENS: AI_LARGE_CALL_MIN_TOKENS,
      LARGE_CALLS_PER_HOUR: AI_LARGE_CALLS_PER_HOUR,
      MANAGED_TIERS: AI_MANAGED_TIERS,
      transport: aiTransport, url: aiProxyUrl,
      meter: aiMeter, pauseMessage: aiPauseMessage, guides: aiGuides,
      // Localhost only, checked inside the function, exactly as entitlementKit
      // does it and for exactly the same reason.
      mock: aiUsageMock
    },
    syncKit: {
      EPOCH: EPOCH_ISO, decide: decideSync, plan: planSync, buildRows: buildRows,
      parseAuthHash: parseAuthHash, sessionExpiringSoon: sessionExpiringSoon,
      // Profile-row payload and its stamped sidecars (Claude key, form
      // metadata), plus the refresh-failure classifier: all pure, all unit
      // tested, so the app shell keeps only transport, storage and UI.
      buildProfileRow: buildProfileRow, readSidecars: readSidecars,
      // The trip surface's push path: it owns credentials but not the interest
      // profile, so it merges rather than replaces.
      mergeProfileRow: mergeProfileRow, sidecarsWorthPushing: sidecarsWorthPushing,
      // The retired GitHub PAT sidecar: how a device notices a row still
      // carrying one, so it can push the cleaned row.
      legacyGithubSidecar: legacyGithubSidecar,
      refreshFailure: refreshFailure,
      // Removal tombstones: a removed city stays removed, on every device.
      // All pure, all unit tested; the shell owns the DELETE calls and the
      // localStorage key, exactly as it owns every other piece of transport.
      tombKit: {
        normalize: normalizeTombValue, block: normalizeTombBlock,
        at: tombstoneAt, merge: mergeTombValues, mergeBlocks: mergeTombBlocks,
        differ: tombValuesDiffer, plan: planTombstones, CAP: TOMB_CAP
      }
    },
    // The public share: the token, the URL it lives at, and what a snapshot is
    // allowed to contain. All pure; the shell owns crypto, the RPC and the UI.
    shareKit: {
      SCHEMA: SHARE_SCHEMA, TOKEN_BYTES: SHARE_TOKEN_BYTES, GUIDE_CAP: SHARE_GUIDE_CAP,
      NAME_CAP: SHARE_NAME_CAP,
      token: shareToken, nameSlug: shareNameSlug, tokenValue: shareTokenValue,
      tokenFromUrl: shareTokenFromUrl, url: shareUrl,
      publicOrigin: publicOrigin,
      build: buildShareSnapshot, stop: shareStop, stay: shareStay, leg: shareLeg, guide: shareGuide,
      FORBIDDEN: SHARE_FORBIDDEN, leaks: shareLeaks,
      // Many links per account, each with its own audience. All pure: the list
      // lives in the trip blob, the shell owns the rows and the network.
      LIST_CAP: SHARE_LIST_CAP, LABEL_CAP: SHARE_LABEL_CAP,
      SUGGESTIONS: SHARE_LABEL_SUGGESTIONS,
      entry: shareEntry, list: shareList, migrate: migrateShares,
      legacyFields: shareLegacyFields, suggest: shareLabelSuggestion,
      addBlocked: shareAddBlocked, writeFailure: shareWriteFailure
    },
    // The compliance counters. Rob makes visa and tax decisions on these, so
    // the math is pure and tested here and the trip surface is transport, the
    // same split shareKit uses. presenceDates is the one rule underneath all of
    // them: a day inside the territory is a whole day, and a date is counted
    // once no matter how many stays claim it.
    dayKit: {
      SCHENGEN_MEMBERS: SCHENGEN_MEMBERS, SCHENGEN_LIMIT: SCHENGEN_LIMIT,
      SCHENGEN_WINDOW_DAYS: SCHENGEN_WINDOW_DAYS,
      US_WINDOW_DAYS: US_WINDOW_DAYS, FEIE_US_DAY_LIMIT: FEIE_US_DAY_LIMIT,
      NO_STATE_LABEL: NO_STATE_LABEL, BUDGET_BAND: BUDGET_BAND,
      normCountry: normCountry, isSchengen: schengenMember, isUS: usMember,
      nearMiss: schengenNearMiss, suspects: schengenSuspects,
      presenceDates: presenceDates, countDates: countKeys,
      schengenUsedAt: schengenUsedAt, schengenPeak: schengenPeak,
      usDaysRolling: usDaysRolling, countryDays: countryDays,
      budgetVariance: budgetVariance
    },
    safeHref: safeHref,
    onStateChange: null, liveState: liveState,
    emptyState: emptyState, makeStore: makeStore, setStatus: setStatus,
    effectiveStatus: effectiveStatus, effectiveData: effectiveData, viewModel: viewModel,
    TRANSITIONS: TRANSITIONS, fmtRange: fmtRange, buildExport: buildExport,
    diffSummary: diffSummary, shareModel: shareModel,
    effectiveDay: effectiveDay, setDay: setDay, stayDates: stayDates,
    normalizeState: normalizeState, effectiveDates: effectiveDates,
    setStayDates: setStayDates, toggleSection: toggleSection,
    // Expand all / Collapse all: the two pure writers behind the per-tab
    // links, over sections and over Plan-tab days respectively.
    setSectionsCollapsed: setSectionsCollapsed, setPlanDaysCollapsed: setPlanDaysCollapsed,
    // Past cities. Pure, and read by the app shell's city switcher; the flag
    // itself rides state.archived, which is what syncs between devices.
    archiveKit: {
      mode: cityArchiveMode, set: setCityArchived,
      isPast: cityIsPast, nextValue: nextArchiveValue
    },
    effectiveName: effectiveName, setTitle: setTitle, setViewMode: setViewMode,
    keyForDisplayedDate: keyForDisplayedDate, calendarModel: calendarModel,
    // Phase 3 additions, all pure and unit-tested on their own.
    todayModel: todayModel, effectiveViewMode: effectiveViewMode,
    todayIso: todayIso, isSectionCollapsed: isSectionCollapsed,
    defaultSectionCollapsed: defaultSectionCollapsed, isTaskSection: isTaskSection,
    // Phase 4 additions: tabs (replaces the Today/Guide/Calendar view switch)
    // and the Plan tab's own model, all pure and unit-tested on their own.
    TABS: TABS, tabForSection: tabForSection, setTab: setTab, effectiveTab: effectiveTab,
    planModel: planModel, isPlanDayCollapsed: isPlanDayCollapsed, togglePlanDay: togglePlanDay,
    // A past day everything on which is settled folds itself away, and says
    // "n done ✓" instead of an item count. Pure, so the rule is one function
    // and one set of tests rather than a condition buried in the renderer.
    planDayAutoCollapsed: planDayAutoCollapsed, planDayDoneCount: planDayDoneCount,
    expandPlanDay: expandPlanDay, planDayAutoFor: planDayAutoFor,
    // Plan-tab within-day item order (drag to reorder), pure and unit-tested.
    orderDayItems: orderDayItems, setDayItemOrder: setDayItemOrder, whenClock: whenClock,
    dayItemOrderFor: dayItemOrderFor,
    // Section-tab item order (chronological default, done sunk, drag to
    // override), the section-tab twin of the three above.
    orderSectionItems: orderSectionItems, setSectionItemOrder: setSectionItemOrder,
    sectionItemOrderFor: sectionItemOrderFor,
    // Plan-tab per-item day moves: the picker's own pure model.
    dayMoveOptions: dayMoveOptions,
    // The More sheet's clustering, pure so the grouping and the within-group
    // order are testable without a DOM. renderSheetInto is the DOM half, shared
    // with the trip surface so its More menu and its stop switcher cannot drift
    // from this one into a second-looking menu.
    MORE_GROUPS: MORE_GROUPS, moreSheetGroups: moreSheetGroups,
    renderSheetInto: renderSheetInto,
    // Add a place by hand: the delta builder only. The write itself still
    // goes through mergeDelta, which is exported right above.
    newPlaceDelta: newPlaceDelta,
    // The header highlights row. sunKit is pure astronomy plus the "where is
    // this city" resolver; pinKit is the per-city pinned-item state.
    sunKit: {
      ZENITH: SUNSET_ZENITH, sunsetUtcMinutes: sunsetUtcMinutes,
      cityLatLng: cityLatLng, cityUtcOffsetMinutes: cityUtcOffsetMinutes,
      // The chip's whole model: which date, which clock, and the wrap that
      // carries the date across a day boundary with the time.
      chip: sunsetChip,
      julianDayUtc: julianDayUtc,
      equationOfTime: equationOfTime, sunDeclination: sunDeclination
    },
    pinKit: {
      CAP: PIN_CAP, CHIP_MAX: PIN_CHIP_MAX,
      ids: pinnedIds, isPinned: isPinned, canToggle: canTogglePin,
      toggle: togglePin, items: pinnedItems, chipText: pinChipText
    }
  };
})();
CityOps.init();
