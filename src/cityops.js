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
  // - city, city.dates and every other field of every existing item are never
  //   touched. intel is the ONE field an existing item can gain here.
  var DELTA_STATUSES = ['plan', 'backup'];
  var DELTA_STATUS_HINT = ' (a delta may only add plan or backup items)';

  function emptyDeltaSummary() {
    return { added: 0, skipped: 0, sectionsAdded: 0, intelApplied: 0, intelSkipped: 0 };
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

    var existingIds = {};
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
          if (existingIds[it.id]) { skipped++; return; }
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

    if (errors.length) return { data: null, summary: emptyDeltaSummary(), errors: errors };

    var summary = emptyDeltaSummary();
    summary.skipped = skipped;
    var out = deepClone(cityData);
    if (!Array.isArray(out.sections)) out.sections = [];
    if (!Array.isArray(out.items)) out.items = [];

    var haveSec = {};
    out.sections.forEach(function (s) { if (s && s.id) haveSec[s.id] = 1; });
    newSections.forEach(function (s) {
      if (haveSec[s.id]) return;
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

    if (intelMap) {
      var byId = Object.create(null);
      out.items.forEach(function (it) { if (it && it.id) byId[it.id] = it; });
      Object.keys(intelMap).forEach(function (id) {
        if (!Object.prototype.hasOwnProperty.call(byId, id)) { summary.intelSkipped++; return; }
        byId[id].intel = deepClone(intelMap[id]);
        summary.intelApplied++;
      });
    }

    return { data: out, summary: summary, errors: [] };
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
    return { itemStatus: {}, itemDay: {}, itemTitle: {}, dayOrder: {}, collapsedSections: {},
      collapsedPlanDays: {}, viewMode: null, tab: null, dataOverride: null, stayOverride: null, updated: null };
  }

  function normalizeState(st) {
    if (!st || typeof st !== 'object') return emptyState();
    st.itemStatus = st.itemStatus || {};
    st.itemDay = st.itemDay || {};
    st.dayOrder = st.dayOrder || {};
    st.collapsedSections = st.collapsedSections || {};
    // Phase 4: per-day collapse state for the Plan tab's "remaining days" list,
    // the same tri-state pattern as collapsedSections (explicit true/false
    // wins, absent falls back to a computed default). A separate map because
    // Plan groups by DATE across every section, not by section id.
    st.collapsedPlanDays = st.collapsedPlanDays || {};
    st.itemTitle = st.itemTitle || {};
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

  function effectiveStatus(it, state) {
    return state.itemStatus[it.id] || it.status;
  }

  function effectiveDay(it, state) {
    if (state.itemDay && Object.prototype.hasOwnProperty.call(state.itemDay, it.id)) {
      return state.itemDay[it.id] || null;
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
    return (state.itemTitle && state.itemTitle[it.id]) || it.name;
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

  var EAT_SECTION_IDS = ['dinner', 'breakfast', 'lunch', 'coffee', 'restaurants', 'bars', 'cowork'];
  var DO_SECTION_IDS = ['activities', 'interests'];
  var SERVICE_SECTION_IDS = ['services', 'laundry'];
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

  // Per-day collapse in the Plan tab's "remaining days" list. Same tri-state
  // read as isSectionCollapsed (explicit override wins, otherwise a computed
  // default). Owner feedback 2026-08-25: every day now defaults to EXPANDED
  // on page load (was collapsed); the traveler's own explicit choice, once
  // made, still sticks (that's what collapsedPlanDays persists).
  function isPlanDayCollapsed(state, iso) {
    var explicit = state.collapsedPlanDays ? state.collapsedPlanDays[iso] : undefined;
    if (explicit === true || explicit === false) return explicit;
    return false;
  }

  function togglePlanDay(state, iso) {
    state.collapsedPlanDays = state.collapsedPlanDays || {};
    var next = !isPlanDayCollapsed(state, iso);
    if (next === false) delete state.collapsedPlanDays[iso]; // back to the default (expanded)
    else state.collapsedPlanDays[iso] = next;
    return state;
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
      return { iso: iso, label: dayLabel(iso), items: byIso[iso] || [] };
    });
    var openTasks = [], doneTasks = [];
    vms.forEach(function (sv) {
      if (!isTaskSection(sv.section)) return;
      sv.undated.forEach(function (it) {
        var s = effectiveStatus(it, state);
        if (s === 'plan') openTasks.push({ sec: sv.section, it: it, status: s });
        else if (s === 'done') doneTasks.push({ sec: sv.section, it: it, status: s });
      });
    });
    return {
      todayIso: today,
      inRange: today >= range.from && today <= range.to,
      today: byIso[today] || [],
      days: otherDays,
      openTasks: openTasks,
      doneTasks: doneTasks
    };
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
  var SECTION_AUTOCOLLAPSE_THRESHOLD = 30;

  function defaultSectionCollapsed(secId, totalItems) {
    if (secId === 'base') return false;
    return (typeof totalItems === 'number') && totalItems > SECTION_AUTOCOLLAPSE_THRESHOLD;
  }

  // Tri-state read: an explicit true/false in collapsedSections always wins
  // (the traveler's own choice, remembered); absent falls back to the
  // computed default above.
  function isSectionCollapsed(state, secId, totalItems) {
    var explicit = state.collapsedSections ? state.collapsedSections[secId] : undefined;
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
      (state.dayOrder[sec.id] || []).forEach(function (k) {
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

  // Pure start-city resolution: hash (if it names a known city) wins, else the
  // stored active city (if still present), else the first city in order, else
  // null when the store is empty. Extracted so the app shell's boot-target
  // logic is unit-testable without a DOM.
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

  function resolveStartCity(store, hashId) {
    if (hashId && Object.prototype.hasOwnProperty.call(store.cities, hashId)) return hashId;
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
    var out = ['You are extending an existing CityOps city guide.', ''];
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
    var out = ['You are adding review-verified intel to an existing CityOps city guide.', ''];
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

  function linkPill(l) {
    var a = document.createElement('a');
    a.href = l.href;
    if (l.kind === 'map') { a.className = 'maplink'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '📍 ' + l.label; }
    else if (l.kind === 'web') { a.className = 'weblink'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '🌐 ' + l.label; }
    else { a.className = 'phonelink'; a.textContent = '📞 ' + l.label; }
    return a;
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
    rerender();
  }

  function moveTo(it, iso) {
    var st = ctx.store.load();
    var key = (iso === null) ? null : keyForDisplayedDate(effectiveData(ctx.base, st), st, it.section, iso);
    setDay(st, it.id, key);
    ctx.store.save(st);
    pendingMove = null;
    rerender();
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
  function cardHeaderBtn(it, status, expanded, dayChip) {
    var btn = el('button', 'card-hd');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(expanded));
    var tname = el('span', 'tname');
    if (status === 'done') tname.appendChild(el('span', 'donemark', '✓'));
    tname.appendChild(document.createTextNode(effectiveName(it, curState)));
    btn.appendChild(tname);
    if (dayChip) btn.appendChild(el('span', 'daychip', dayChip));
    if (it.tags && it.tags.length) {
      var tp = el('span', 'card-hd-tags');
      it.tags.forEach(function (t) { tp.appendChild(el('span', 'tag', t)); });
      btn.appendChild(tp);
    }
    btn.appendChild(el('span', 'card-hd-chev', expanded ? '▾' : '▸'));
    return btn;
  }

  // Everything that used to live in the card unconditionally now lives here,
  // shown ONLY when the card is expanded: price, note, intel, links/hours,
  // and the status controls. Renaming is the one exception carried over
  // unchanged: it replaces this whole panel while pendingEdit names this item.
  function itemDetailBody(it, status, showWhen, withDayPicker) {
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
    if (showWhen && it.when) frag.appendChild(el('p', 'when-line', it.when));
    if (it.note) frag.appendChild(el('p', null, it.note));
    if (it.intel) {
      var strip = intelStrip(it.intel);
      if (strip) frag.appendChild(strip);
    }
    var row = el('div', 'row');
    if (it.hours) row.appendChild(el('span', 'hours' + (it.hours.class ? ' ' + it.hours.class : ''), it.hours.text));
    (it.links || []).forEach(function (l) { row.appendChild(linkPill(l)); });
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
    var ctl = el('div', 'ctl-row');
    // Icon buttons (feature 5): the icon is the whole visible label except on
    // Archive, which also keeps a text label because it is destructive.
    // aria-label and title both carry the same wording so screen readers and
    // mouse-hover tooltips agree.
    (TRANSITIONS[status] || []).forEach(function (t) {
      var b = el('button', 'ctl icon-btn to-' + t.to, t.label ? (t.icon + ' ' + t.label) : t.icon);
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
      // way (it already offers "No day" to clear an assignment); only the
      // label changes so a traveler with nothing set yet does not read
      // "change" for an action they have never taken.
      var hasDay = !!effectiveDay(it, curState);
      var mvLabel = hasDay ? 'Change day' : 'Add to a day';
      var mv = el('button', 'ctl icon-btn', '📅');
      mv.type = 'button';
      mv.setAttribute('aria-label', mvLabel);
      mv.title = mvLabel;
      mv.onclick = function () { pendingMove = it.id; rerender(); };
      ctl.appendChild(mv);
    }
    if (status !== 'archived') {
      var ed = el('button', 'ctl icon-btn', '✎');
      ed.type = 'button';
      ed.setAttribute('aria-label', 'Rename');
      ed.title = 'Rename';
      ed.onclick = function () { pendingEdit = it.id; rerender(); };
      ctl.appendChild(ed);
    }
    if (ctl.children.length) frag.appendChild(ctl);
    return frag;
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
  function appendCard(container, it, status, showWhen, withDayPicker, dayChip) {
    var expanded;
    if (pendingEdit === it.id) expanded = true; // renaming must show the editor
    else if (Object.prototype.hasOwnProperty.call(itemExpandOverride, it.id)) expanded = itemExpandOverride[it.id];
    else expanded = defaultExpanded(status);
    container.classList.add(expanded ? 'expanded' : 'collapsed');
    var hd = cardHeaderBtn(it, status, expanded, dayChip);
    hd.onclick = function () { toggleExpand(it.id, status); };
    container.appendChild(hd);
    var detail = el('div', 'card-detail');
    detail.appendChild(itemDetailBody(it, status, showWhen, withDayPicker));
    container.appendChild(detail);
  }

  function renderCard(it, status, withDayPicker, dayChip) {
    var card = el('div', 'card' + (status === 'done' ? ' item-done' : ''));
    appendCard(card, it, status, true, withDayPicker, dayChip);
    return card;
  }

  function renderHeader(data, state) {
    var c = data.city;
    var dates = effectiveDates(data, state);
    var h = document.getElementById('hdr');
    h.innerHTML = '';
    h.appendChild(el('h1', null, c.name));
    var sub = fmtRange(dates) + (c.accommodation && c.accommodation.name ? ' · ' + c.accommodation.name : '');
    if (state.stayOverride) sub += ' · dates adjusted';
    h.appendChild(el('div', 'sub', sub));
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
    return { h2: h2, collapsed: collapsed };
  }

  // Every active item in a section (day-assigned or not), in chronological
  // order with the undated ones last, paired with the date label to show as
  // that card's day chip (null for undated). viewModel() already grouped the
  // dayed ones into per-date slots; this just flattens that back into one
  // ordered list, since a tab section is a flat card list, not a day-card
  // grid (Plan owns day grouping now).
  function tabItemsFlat(sv) {
    var out = [];
    sv.days.forEach(function (d) {
      d.items.forEach(function (it) { out.push({ it: it, dayIso: d.iso }); });
    });
    sv.undated.forEach(function (it) { out.push({ it: it, dayIso: null }); });
    return out;
  }

  // Eat & Drink / Do / Services: one section block per mapped section, items
  // as flat cards (day chip if assigned, "Add to a day" control either way),
  // then backups and archived exactly as before.
  function renderTabSectionBlock(sv, state, totalItems) {
    var frag = document.createDocumentFragment();
    var hdr = renderSectionHeader(sv, state, totalItems);
    frag.appendChild(hdr.h2);
    if (hdr.collapsed) return frag;
    tabItemsFlat(sv).forEach(function (entry) {
      var status = effectiveStatus(entry.it, state);
      var chip = entry.dayIso ? dayLabel(entry.dayIso) : null;
      frag.appendChild(renderCard(entry.it, status, true, chip));
    });
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

  function renderTabSections(vms, state, totalItems) {
    var main = document.getElementById('main');
    main.innerHTML = '';
    if (!vms.length) {
      main.appendChild(el('p', 'when-line', 'Nothing in this tab yet.'));
      return;
    }
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
      p.appendChild(el('strong', null, effectiveName(it, state)));
      if (it.note) {
        p.appendChild(document.createElement('br'));
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

  function saveDayOrder(sec, keys, focusKey) {
    var st = ctx.store.load();
    st.dayOrder[sec] = keys;
    ctx.store.save(st);
    // Dates are slots: after a reorder the cards must re-label to their new
    // chronological slots, so a full rerender is required (not just a DOM move).
    rerender();
    if (focusKey) {
      var g = document.querySelector('.days[data-sec="' + sec + '"] .daycard[data-day="' + focusKey + '"] .grip');
      if (g) g.focus();
    }
  }

  // Window-level pointermove/pointerup/pointercancel are bound once in init()
  // (not per rerender, which would stack duplicate listeners). They read the
  // shared module-scope `drag` context and no-op when it is null.
  function onDragPointerMove(e) {
    if (!drag) return;
    var list = drag.list, cards = drag.cards;
    if (!list.contains(drag.card)) { drag = null; return; }
    e.preventDefault();
    var y = e.clientY;
    drag.card.style.transform = 'translateY(' + (y - drag.startY) + 'px) scale(1.015)';
    var others = cards().filter(function (c) { return c !== drag.card; });
    for (var i = 0; i < others.length; i++) {
      var r = others[i].getBoundingClientRect();
      var mid = r.top + r.height / 2;
      var after = drag.card.compareDocumentPosition(others[i]) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (after && y > mid) {
        drag.card.style.transform = '';
        list.insertBefore(others[i], drag.card);
        drag.startY = y;
        drag.card.style.transform = 'scale(1.015)';
        return;
      }
      if (!after && y < mid) {
        drag.card.style.transform = '';
        list.insertBefore(drag.card, others[i]);
        drag.startY = y;
        drag.card.style.transform = 'scale(1.015)';
        return;
      }
    }
  }

  function onDragPointerEnd(e) {
    if (!drag) return;
    var d = drag;
    if (!d.list.contains(d.card)) { drag = null; return; }
    d.card.classList.remove('dragging');
    d.card.style.transform = '';
    try { d.grip.releasePointerCapture(e.pointerId); } catch (err) {}
    drag = null;
    saveDayOrder(d.sec, d.cards().map(function (c) { return c.dataset.day; }));
  }

  // Phase 3's per-section day-slot drag-to-reorder. Dormant as of Phase 4: it
  // only ever wired up a section's own `.days` grid, and the tab redesign has
  // no such grid anymore (Plan groups by date ACROSS sections and lists days
  // chronologically only; a per-section reorder no longer has a coherent
  // meaning). No render path calls this now; left defined rather than
  // deleted outright so the drag mechanics are still here if a future Plan
  // feature wants to resurrect them, but it is a good candidate for a
  // follow-up cleanup pass. The window pointermove/up/cancel listeners bound
  // in boot() below are harmless no-ops with `drag` always null.
  function attachReorder() {
    var lists = document.querySelectorAll('.days');
    Array.prototype.forEach.call(lists, function (list) {
      var sec = list.dataset.sec;
      var cards = function () { return Array.prototype.slice.call(list.querySelectorAll('.daycard')); };
      if (cards().length < 2) return;

      var bar = el('div', 'reorderbar');
      var status = el('span', null, 'Drag the ⠿ handle to reorder days. Saved on this device.');
      var reset = el('button', null, 'Reset to date order');
      reset.type = 'button';
      reset.onclick = function () {
        var st = ctx.store.load();
        delete st.dayOrder[sec];
        ctx.store.save(st);
        rerender();
      };
      bar.appendChild(status);
      bar.appendChild(reset);
      list.parentNode.insertBefore(bar, list);

      cards().forEach(function (card) {
        var g = el('div', 'grip');
        g.setAttribute('role', 'button');
        g.setAttribute('tabindex', '0');
        g.setAttribute('aria-label', 'Reorder this day. Use arrow up and arrow down keys.');
        g.innerHTML = '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
          '<circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/>' +
          '<circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/>' +
          '<circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>';
        card.appendChild(g);
      });

      list.addEventListener('pointerdown', function (e) {
        var grip = e.target.closest('.grip');
        if (!grip) return;
        var card = grip.closest('.daycard');
        if (!card) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        drag = { card: card, grip: grip, startY: e.clientY, list: list, cards: cards, sec: sec };
        card.classList.add('dragging');
      });

      list.addEventListener('keydown', function (e) {
        var grip = e.target.closest('.grip');
        if (!grip) return;
        var card = grip.closest('.daycard');
        if (e.key === 'ArrowUp' && card.previousElementSibling) {
          e.preventDefault();
          list.insertBefore(card, card.previousElementSibling);
          saveDayOrder(sec, cards().map(function (c) { return c.dataset.day; }), card.dataset.day);
        } else if (e.key === 'ArrowDown' && card.nextElementSibling) {
          e.preventDefault();
          list.insertBefore(card.nextElementSibling, card);
          saveDayOrder(sec, cards().map(function (c) { return c.dataset.day; }), card.dataset.day);
        }
      });
    });
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
  function renderTaskRow(it, status) {
    var row = el('div', 'task-row' + (status === 'done' ? ' item-done' : ''));
    var label = el('label', 'task-check');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = status === 'done';
    cb.setAttribute('aria-label', (status === 'done' ? 'Mark not done: ' : 'Mark done: ') + effectiveName(it, curState));
    cb.onchange = function () { onStatus(it.id, cb.checked ? 'done' : 'plan'); };
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + effectiveName(it, curState)));
    row.appendChild(label);
    if (it.note) row.appendChild(el('p', 'task-note', it.note));
    return row;
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
    main.appendChild(el('h2', null, 'Today · ' + dayLabel(pm.todayIso)));
    if (!pm.today.length) {
      main.appendChild(el('p', 'when-line', 'Nothing planned yet.'));
    } else {
      pm.today.forEach(function (e) {
        var card = el('div', 'card' + (e.status === 'done' ? ' item-done' : ''));
        card.appendChild(el('p', 'sec-meta', (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label));
        appendCard(card, e.it, e.status, true, true);
        main.appendChild(card);
      });
    }
    pm.days.forEach(function (d) {
      var collapsed = isPlanDayCollapsed(state, d.iso);
      var h2 = el('h2', collapsed ? 'collapsed' : null);
      var tbtn = el('button', 'sec-toggle');
      tbtn.type = 'button';
      tbtn.setAttribute('aria-expanded', String(!collapsed));
      tbtn.appendChild(el('span', 'chev', collapsed ? '▸' : '▾'));
      tbtn.appendChild(document.createTextNode(' ' + d.label + ' '));
      tbtn.appendChild(el('span', 'sec-count', '(' + d.items.length + (d.items.length === 1 ? ' item' : ' items') + ')'));
      tbtn.onclick = function () {
        var st = ctx.store.load();
        togglePlanDay(st, d.iso);
        ctx.store.save(st);
        rerender();
      };
      h2.appendChild(tbtn);
      main.appendChild(h2);
      if (collapsed) return;
      if (!d.items.length) {
        main.appendChild(el('p', 'when-line', 'Nothing planned yet.'));
        return;
      }
      d.items.forEach(function (e) {
        var card = el('div', 'card' + (e.status === 'done' ? ' item-done' : ''));
        card.appendChild(el('p', 'sec-meta', (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label));
        appendCard(card, e.it, e.status, true, true);
        main.appendChild(card);
      });
    });
    if (pm.openTasks.length || pm.doneTasks.length) {
      main.appendChild(el('h2', null, 'Open tasks'));
      pm.openTasks.forEach(function (e) { main.appendChild(renderTaskRow(e.it, e.status)); });
      if (pm.doneTasks.length) {
        var det = el('details', 'arch-details');
        det.appendChild(el('summary', null, 'Done (' + pm.doneTasks.length + ')'));
        pm.doneTasks.forEach(function (e) { det.appendChild(renderTaskRow(e.it, e.status)); });
        main.appendChild(det);
      }
    }
  }

  function rerender() {
    // Any in-flight drag references nodes from the previous render's #main;
    // drop it so a stray window pointerup after a rerender is a no-op.
    drag = null;
    var state = ctx.store.load();
    curState = state;
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
    foot.textContent = 'cityops · schema v1 · state saved on this device';
    var notice = document.getElementById('notice');
    notice.textContent = ctx.store.persistent ? '' :
      'Private mode: changes hold for this session only and are not saved.';
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
    box.appendChild(el('p', 'diff', 'Paste schema v1 JSON. It is stored on this device as an override; the file itself is not changed. Export and paste into the file to make it permanent.'));
    var ta = document.createElement('textarea');
    box.appendChild(ta);
    var msg = el('div', 'diff', '');
    box.appendChild(msg);
    var row = el('div', 'mrow');
    var apply = el('button', 'ctl', 'Apply');
    apply.type = 'button';
    apply.onclick = function () {
      var res = parse(ta.value);
      if (!res.data) { msg.textContent = 'Invalid:\n' + res.errors.join('\n'); return; }
      var st = ctx.store.load();
      var current = effectiveData(ctx.base, st);
      var summary = diffSummary(current, res.data);
      st.dataOverride = res.data;
      ctx.store.save(st);
      pendingPromote = pendingMove = pendingEdit = null; // item ids may change under an override
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
        pendingPromote = pendingMove = pendingEdit = null;
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

  // App-only rows (Enrich, Edit city, Export guide, Remove city) are supplied
  // by the shell via window.CityOpsApp.moreActions(), returning
  // [{label, onClick, cls}]. Standalone guide files have no CityOpsApp, so
  // the sheet there only ever shows the four base rows: no trace of an
  // app-only action ships inside them.
  function openMoreSheet() {
    var host = document.getElementById('modal');
    host.innerHTML = '';
    var wrap = el('div', 'modal-wrap');
    var box = el('div', 'modal');
    box.appendChild(el('h3', null, 'More'));
    var list = el('div', 'sheet-list');
    function addRow(label, onClick, cls) {
      var b = el('button', 'sheet-row' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.onclick = function () { wrap.remove(); onClick(); };
      list.appendChild(b);
    }
    addRow(shareOn ? 'Back to planner' : 'Share view', function () {
      shareOn = !shareOn;
      document.body.classList.toggle('share', shareOn);
      rerender();
    });
    addRow('Export JSON', doExportJson);
    addRow('Update data', openUpdateModal);
    addRow('Edit dates', openDatesModal);
    if (typeof window !== 'undefined' && window && window.CityOpsApp && window.CityOpsApp.moreActions) {
      window.CityOpsApp.moreActions().forEach(function (a) { addRow(a.label, a.onClick, a.cls); });
    }
    box.appendChild(list);
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
    drag = null;
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('share');
    if (!listenersBound && typeof window !== 'undefined' && window && window.addEventListener) {
      window.addEventListener('pointermove', onDragPointerMove, { passive: false });
      window.addEventListener('pointerup', onDragPointerEnd);
      window.addEventListener('pointercancel', onDragPointerEnd);
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
      exampleVisible: exampleCityVisible
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
      buildIntelPassPrompt: buildIntelPassPrompt
    },
    extractJsonBlock: extractJsonBlock, RETRY_INSTRUCTION: RETRY_INSTRUCTION,
    isJsonSyntaxError: isJsonSyntaxError, fetchTextToCity: fetchTextToCity,
    syncKit: {
      EPOCH: EPOCH_ISO, decide: decideSync, plan: planSync, buildRows: buildRows,
      parseAuthHash: parseAuthHash, sessionExpiringSoon: sessionExpiringSoon
    },
    onStateChange: null, liveState: liveState,
    emptyState: emptyState, makeStore: makeStore, setStatus: setStatus,
    effectiveStatus: effectiveStatus, effectiveData: effectiveData, viewModel: viewModel,
    TRANSITIONS: TRANSITIONS, fmtRange: fmtRange, buildExport: buildExport,
    diffSummary: diffSummary, shareModel: shareModel,
    effectiveDay: effectiveDay, setDay: setDay, stayDates: stayDates,
    normalizeState: normalizeState, effectiveDates: effectiveDates,
    setStayDates: setStayDates, toggleSection: toggleSection,
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
    // Plan-tab per-item day moves: the picker's own pure model.
    dayMoveOptions: dayMoveOptions
  };
})();
CityOps.init();