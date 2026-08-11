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
      var secIds = {};
      (data.sections || []).forEach(function (s) { secIds[s.id] = 1; });
      var seen = {};
      data.items.forEach(function (it, i) {
        var ref = 'items[' + i + ']' + (it && it.id ? ' (' + it.id + ')' : '');
        if (!it.id) errors.push(ref + ' needs id');
        else if (seen[it.id]) errors.push('duplicate item id "' + it.id + '"');
        else seen[it.id] = 1;
        if (!it.name) errors.push(ref + ' needs name');
        if (!secIds[it.section]) errors.push(ref + ' unknown section "' + it.section + '"');
        if (STATUSES.indexOf(it.status) === -1) errors.push(ref + ' bad status "' + it.status + '"');
        if (it.day && !/^\d{4}-\d{2}-\d{2}$/.test(it.day)) errors.push(ref + ' day must be YYYY-MM-DD');
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

  var TRANSITIONS = {
    plan:     [{ to: 'done', label: '✓ Done' }, { to: 'backup', label: '↓ Backup' }, { to: 'archived', label: '✕ Archive' }],
    backup:   [{ to: 'plan', label: '↑ Promote' }, { to: 'archived', label: '✕ Archive' }],
    done:     [{ to: 'plan', label: '↩ Undo' }],
    archived: [{ to: 'backup', label: '↩ Restore' }]
  };

  function emptyState() {
    return { itemStatus: {}, itemDay: {}, itemTitle: {}, dayOrder: {}, collapsedSections: {}, viewMode: 'type', dataOverride: null, stayOverride: null, updated: null };
  }

  function normalizeState(st) {
    if (!st || typeof st !== 'object') return emptyState();
    st.itemStatus = st.itemStatus || {};
    st.itemDay = st.itemDay || {};
    st.dayOrder = st.dayOrder || {};
    st.collapsedSections = st.collapsedSections || {};
    st.itemTitle = st.itemTitle || {};
    if (st.viewMode !== 'type' && st.viewMode !== 'day') st.viewMode = 'type';
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
    if (mode !== 'type' && mode !== 'day') throw new Error('bad view mode "' + mode + '"');
    state.viewMode = mode;
    return state;
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

  function toggleSection(state, secId) {
    state.collapsedSections = state.collapsedSections || {};
    if (state.collapsedSections[secId]) delete state.collapsedSections[secId];
    else state.collapsedSections[secId] = true;
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
  // Shape: { cities: {cityId: cityJson}, order: [cityId], active: cityId|null }.
  // Pure helpers only: reading and writing localStorage stays in the app shell.
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
    return { cities: cities, order: order, active: active };
  }

  function appAddCity(store, data) {
    var s = normalizeAppStore(store);
    var id = cityId(data);
    var replaced = Object.prototype.hasOwnProperty.call(s.cities, id);
    s.cities[id] = data;
    if (s.order.indexOf(id) === -1) s.order.push(id);
    return { store: s, cityId: id, replaced: replaced };
  }

  function appRemoveCity(store, id) {
    var s = normalizeAppStore(store);
    delete s.cities[id];
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
        country: (country || '').toUpperCase().slice(0, 2),
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

  function dayPickerRow(hint, onPick, onCancel) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('p', 'when-line', hint));
    var pick = el('div', 'ctl-row');
    var pst = ctx.store.load();
    stayDates(effectiveDates(effectiveData(ctx.base, pst), pst)).forEach(function (iso) {
      var db = el('button', 'ctl', dayLabel(iso));
      db.type = 'button';
      db.onclick = function () { onPick(iso); };
      pick.appendChild(db);
    });
    var nd = el('button', 'ctl', 'No day');
    nd.type = 'button';
    nd.onclick = function () { onPick(null); };
    pick.appendChild(nd);
    var cancel = el('button', 'ctl to-archived', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = onCancel;
    pick.appendChild(cancel);
    frag.appendChild(pick);
    return frag;
  }

  function itemBody(it, status, showWhen, withDayPicker) {
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
    var h3 = el('h3');
    var tname = el('span', 'tname');
    if (status === 'done') tname.appendChild(el('span', 'donemark', '✓'));
    tname.appendChild(document.createTextNode(effectiveName(it, curState)));
    h3.appendChild(tname);
    if (it.price) h3.appendChild(el('span', 'price', it.price.text));
    frag.appendChild(h3);
    if (showWhen && it.when) frag.appendChild(el('p', 'when-line', it.when));
    if (it.tags && it.tags.length) {
      var tp = el('p');
      it.tags.forEach(function (t) { tp.appendChild(el('span', 'tag', t)); });
      frag.appendChild(tp);
    }
    if (it.note) frag.appendChild(el('p', null, it.note));
    var row = el('div', 'row');
    if (it.hours) row.appendChild(el('span', 'hours' + (it.hours.class ? ' ' + it.hours.class : ''), it.hours.text));
    (it.links || []).forEach(function (l) { row.appendChild(linkPill(l)); });
    if (row.children.length) frag.appendChild(row);
    if (status === 'backup' && withDayPicker && pendingPromote === it.id) {
      frag.appendChild(dayPickerRow('Promote to which day?',
        function (iso) { promoteTo(it, iso); },
        function () { pendingPromote = null; rerender(); }));
      return frag;
    }
    if (pendingMove === it.id) {
      frag.appendChild(dayPickerRow('Move to which day?',
        function (iso) { moveTo(it, iso); },
        function () { pendingMove = null; rerender(); }));
      return frag;
    }
    var ctl = el('div', 'ctl-row');
    (TRANSITIONS[status] || []).forEach(function (t) {
      var b = el('button', 'ctl to-' + t.to, t.label);
      b.type = 'button';
      if (t.to === 'plan' && status === 'backup' && withDayPicker) {
        b.onclick = function () { pendingPromote = it.id; rerender(); };
      } else {
        b.onclick = function () { onStatus(it.id, t.to); };
      }
      ctl.appendChild(b);
    });
    if (withDayPicker && (status === 'plan' || status === 'done')) {
      var mv = el('button', 'ctl', '⇄ Day');
      mv.type = 'button';
      mv.onclick = function () { pendingMove = it.id; rerender(); };
      ctl.appendChild(mv);
    }
    if (status !== 'archived') {
      var ed = el('button', 'ctl', '✎');
      ed.type = 'button';
      ed.setAttribute('aria-label', 'Rename');
      ed.onclick = function () { pendingEdit = it.id; rerender(); };
      ctl.appendChild(ed);
    }
    if (ctl.children.length) frag.appendChild(ctl);
    return frag;
  }

  function renderCard(it, status, withDayPicker) {
    var card = el('div', 'card' + (status === 'done' ? ' item-done' : ''));
    card.appendChild(itemBody(it, status, true, withDayPicker));
    return card;
  }

  function renderDayCard(day, state) {
    var dc = el('div', 'daycard');
    dc.dataset.day = day.key; // stable group identity; the rendered date is the slot
    var hd = el('div', 'hd');
    hd.appendChild(el('span', 'd', day.label));
    if (day.outside) hd.appendChild(el('span', 'tag', 'Outside stay'));
    if (day.items.length === 1 && day.items[0].when) hd.appendChild(el('span', 't', day.items[0].when));
    dc.appendChild(hd);
    if (!day.items.length) {
      dc.className += ' empty-day';
      dc.appendChild(el('div', 'bd free-day', 'free'));
      return dc;
    }
    day.items.forEach(function (it) {
      var status = effectiveStatus(it, state);
      var bd = el('div', 'bd' + (status === 'done' ? ' item-done' : ''));
      bd.appendChild(itemBody(it, status, day.items.length > 1, true));
      dc.appendChild(bd);
    });
    return dc;
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

  function renderSection(sv, state) {
    var frag = document.createDocumentFragment();
    var collapsed = !!(state.collapsedSections && state.collapsedSections[sv.section.id]);
    var h2 = el('h2', collapsed ? 'collapsed' : null);
    var tbtn = el('button', 'sec-toggle');
    tbtn.type = 'button';
    tbtn.setAttribute('aria-expanded', String(!collapsed));
    tbtn.appendChild(el('span', 'chev', collapsed ? '▸' : '▾'));
    if (sv.section.icon) tbtn.appendChild(el('span', 'ic', sv.section.icon));
    tbtn.appendChild(document.createTextNode(' ' + sv.section.label));
    if (collapsed) {
      var n = sv.undated.length + sv.backups.length + sv.archived.length;
      sv.days.forEach(function (d) { n += d.items.length; });
      tbtn.appendChild(el('span', 'sec-count', n + (n === 1 ? ' item' : ' items')));
    }
    tbtn.onclick = function () {
      var st = ctx.store.load();
      toggleSection(st, sv.section.id);
      ctx.store.save(st);
      rerender();
    };
    h2.appendChild(tbtn);
    frag.appendChild(h2);
    if (collapsed) return frag;
    if (sv.days.length) {
      var days = el('div', 'days');
      days.dataset.sec = sv.section.id;
      sv.days.forEach(function (d) { days.appendChild(renderDayCard(d, state)); });
      frag.appendChild(days);
    }
    sv.undated.forEach(function (it) { frag.appendChild(renderCard(it, effectiveStatus(it, state), sv.days.length > 0)); });
    if (sv.backups.length) {
      var withPicker = sv.days.length > 0;
      var bk = el('div', 'backup');
      bk.appendChild(el('div', 'bt', '↩ Backups: if Plan A is full, closed, or you want a change'));
      sv.backups.forEach(function (it) { bk.appendChild(renderCard(it, 'backup', withPicker)); });
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
        main.appendChild(card);
      });
    }
  }

  function renderCalendar(data, state) {
    var cm = calendarModel(data, state);
    var main = document.getElementById('main');
    main.innerHTML = '';
    cm.days.forEach(function (d) {
      var dc = el('div', 'daycard' + (d.entries.length ? '' : ' empty-day'));
      var hd = el('div', 'hd');
      hd.appendChild(el('span', 'd', d.label));
      dc.appendChild(hd);
      if (!d.entries.length) {
        dc.appendChild(el('div', 'bd free-day', 'free'));
      }
      d.entries.forEach(function (e) {
        var bd = el('div', 'bd' + (e.status === 'done' ? ' item-done' : ''));
        bd.appendChild(el('p', 'sec-meta', (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label));
        bd.appendChild(itemBody(e.it, e.status, true, true));
        dc.appendChild(bd);
      });
      main.appendChild(dc);
    });
    if (cm.undated.length) {
      main.appendChild(el('h2', null, 'Anytime'));
      cm.undated.forEach(function (e) {
        var card = el('div', 'card' + (e.status === 'done' ? ' item-done' : ''));
        card.appendChild(el('p', 'sec-meta', (e.sec.icon ? e.sec.icon + ' ' : '') + e.sec.label));
        card.appendChild(itemBody(e.it, e.status, true, true));
        main.appendChild(card);
      });
    }
    cm.sections.forEach(function (sv) {
      if (sv.backups.length) {
        var bk = el('div', 'backup');
        bk.appendChild(el('div', 'bt', '↩ ' + sv.section.label + ' backups'));
        sv.backups.forEach(function (it) { bk.appendChild(renderCard(it, 'backup', true)); });
        main.appendChild(bk);
      }
      if (sv.archived.length) {
        var det = el('details', 'arch-details');
        det.appendChild(el('summary', null, sv.section.label + ': archived (' + sv.archived.length + ')'));
        sv.archived.forEach(function (it) { det.appendChild(renderCard(it, 'archived')); });
        main.appendChild(det);
      }
    });
  }

  function rerender() {
    // Any in-flight drag references nodes from the previous render's #main;
    // drop it so a stray window pointerup after a rerender is a no-op.
    drag = null;
    var state = ctx.store.load();
    curState = state;
    var data = effectiveData(ctx.base, state);
    renderHeader(data, state);
    renderToolbar(data, state);
    if (shareOn) {
      renderShare();
    } else if (state.viewMode === 'day') {
      renderCalendar(data, state);
    } else {
      var main = document.getElementById('main');
      main.innerHTML = '';
      viewModel(data, state).forEach(function (sv) { main.appendChild(renderSection(sv, state)); });
      attachReorder();
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

  function renderToolbar(data, state) {
    var tb = document.getElementById('toolbar');
    tb.innerHTML = '';
    var share = el('button', null, shareOn ? 'Back to planner' : 'Share view');
    share.type = 'button';
    share.id = 'btn-share';
    share.onclick = function () {
      shareOn = !shareOn;
      document.body.classList.toggle('share', shareOn);
      rerender();
    };
    tb.appendChild(share);
    if (!shareOn) {
      var vw = el('button', null, state.viewMode === 'day' ? 'By type' : 'Calendar');
      vw.type = 'button';
      vw.onclick = function () {
        var st = ctx.store.load();
        setViewMode(st, st.viewMode === 'day' ? 'type' : 'day');
        ctx.store.save(st);
        rerender();
      };
      tb.appendChild(vw);
      var exp = el('button', null, 'Export JSON');
      exp.type = 'button';
      exp.id = 'btn-export';
      exp.onclick = function () {
        var st = ctx.store.load();
        var out = buildExport(effectiveData(ctx.base, st), st);
        var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = cityId(out) + '.cityops.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      };
      tb.appendChild(exp);
      var upd = el('button', null, 'Update data');
      upd.type = 'button';
      upd.onclick = openUpdateModal;
      tb.appendChild(upd);
      var dts = el('button', null, 'Edit dates');
      dts.type = 'button';
      dts.onclick = openDatesModal;
      tb.appendChild(dts);
      // App context only: standalone guide files have no CityOpsApp, so this
      // button never appears in them.
      if (typeof window !== 'undefined' && window && window.CityOpsApp && window.CityOpsApp.exportStandalone) {
        var expg = el('button', null, 'Export guide');
        expg.type = 'button';
        expg.id = 'btn-export-guide';
        expg.onclick = function () { window.CityOpsApp.exportStandalone(); };
        tb.appendChild(expg);
      }
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
    drag = null;
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('share');
    if (!listenersBound && typeof window !== 'undefined' && window && window.addEventListener) {
      window.addEventListener('pointermove', onDragPointerMove, { passive: false });
      window.addEventListener('pointerup', onDragPointerEnd);
      window.addEventListener('pointercancel', onDragPointerEnd);
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
    appStore: {
      normalize: normalizeAppStore, add: appAddCity,
      remove: appRemoveCity, keepBothName: keepBothName,
      resolveStartCity: resolveStartCity, blankCity: blankCity
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
    keyForDisplayedDate: keyForDisplayedDate, calendarModel: calendarModel
  };
})();
CityOps.init();