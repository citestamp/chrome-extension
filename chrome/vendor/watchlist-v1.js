/* CiteStamp bibliography watchlist v1.0.0 — runs in your browser.
   Docs + live tool: https://citestamp.com/check
   Your watchlist stays in this browser: CiteStamp never receives your reference
   list. Re-checks go client-direct to Crossref, DataCite and OpenAlex. */
(function () {
"use strict";
if (window.CiteStampWatchlist) { return; }

var VERSION = "1.0.0";
var KEY = "citestamp.watchlist.v1";
var WINDOW_DAYS = 90;
var DELTA_PATH = "/api/v1/updates/delta";
var SITE = "https://citestamp.com";
var MAILTO = "info@citestamp.com";

// Publisher retraction-class events that mean the paper is marked retracted.
var MARKED = { retraction: 1, withdrawal: 1, removal: 1, partial_retraction: 1, retration: 1 };
// The full severe vocabulary the watchlist surfaces (adds the softer
// expression_of_concern). correction/erratum/new_version are deliberately
// excluded: benign churn that would triple the blob.
var SEVERE = {
  retraction: 1, withdrawal: 1, removal: 1, partial_retraction: 1,
  retration: 1, expression_of_concern: 1
};

// ---- tiny helpers (no regex, no backslash) --------------------------------

function lower(s) { return String(s == null ? "" : s).toLowerCase(); }
function trimStr(s) { return String(s == null ? "" : s).trim(); }
function nowIso() { return new Date().toISOString(); }
function todayStr() { return nowIso().slice(0, 10); }

// FNV-1a 32-bit, hex. Math.imul keeps the multiply in 32-bit lanes.
function fnv1a(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h = h ^ str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  var u = h >>> 0;
  var hex = u.toString(16);
  while (hex.length < 8) { hex = "0" + hex; }
  return hex;
}

// The stable monitor verdict hash over THIRD-PARTY-ONLY salient fields:
// resolved, retracted, publisherEvent.type, titleMismatch. It deliberately
// EXCLUDES has-refutations so the unattended monitor can compute it without
// touching our server. Refutation changes are only detected in an interactive
// check.
function hashVerdict(v) {
  v = v || {};
  var pe = (v.publisherEvent && v.publisherEvent.type) ? lower(v.publisherEvent.type) : "";
  var parts = [
    v.resolved ? "r1" : "r0",
    "x" + lower(v.retracted || "unknown"),
    "p" + pe,
    v.titleMismatch ? "m1" : "m0"
  ];
  return fnv1a(parts.join("|"));
}

// Map a publisher-event type to a monitor status string. Publisher events are
// stated AS publisher events (accountable), never as a judgement of the work.
function eventStatus(type) {
  var t = lower(type);
  if (t === "expression_of_concern") { return "expression-of-concern"; }
  if (t === "withdrawal") { return "withdrawn"; }
  if (t === "removal") { return "removed"; }
  if (t === "partial_retraction") { return "partially-retracted"; }
  return "marked-retracted";
}

// Derive the monitor status from a checker verdict WITHOUT has-refutations
// (which needs our graph and is off the timer).
function monitorStatus(v) {
  v = v || {};
  if (!v.resolved) {
    if (v.unchecked) { return "unchecked"; }
    if (v.noMatch) { return "no-match"; }
    return "does-not-resolve";
  }
  if (v.retracted === "marked") { return "marked-retracted"; }
  if (v.publisherEvent && v.publisherEvent.type) { return eventStatus(v.publisherEvent.type); }
  if (v.titleMismatch) { return "doi-title-mismatch"; }
  return "ok";
}

// ---- storage adapter (injectable) -----------------------------------------
// Default: localStorage on the web. The extension injects chrome.storage.local
// via configure({ storage: { get: fn, set: fn } }); get/set may return either a
// value or a Promise, so every read/write is wrapped in Promise.resolve.

var STORAGE = null;

function defaultStorage() {
  return {
    get: function (k) {
      try { return window.localStorage.getItem(k); }
      catch (e) { return null; }
    },
    set: function (k, val) {
      try { window.localStorage.setItem(k, val); }
      catch (e) { return null; }
      return null;
    }
  };
}

function storage() {
  if (!STORAGE) { STORAGE = defaultStorage(); }
  return STORAGE;
}

function sget(k) { return Promise.resolve(storage().get(k)); }
function sset(k, val) { return Promise.resolve(storage().set(k, val)); }

function emptyState() { return { version: 1, lastDeltaSync: null, items: {} }; }

function load() {
  return sget(KEY).then(function (raw) {
    var st = null;
    if (raw) { try { st = JSON.parse(raw); } catch (e) { st = null; } }
    if (!st || typeof st !== "object") { st = emptyState(); }
    if (!st.items || typeof st.items !== "object") { st.items = {}; }
    if (typeof st.version !== "number") { st.version = 1; }
    if (typeof st.lastDeltaSync === "undefined") { st.lastDeltaSync = null; }
    return st;
  });
}

function save(state) {
  return sset(KEY, JSON.stringify(state)).then(function () { return state; });
}

// ---- keying ---------------------------------------------------------------
// The match key is the lowercased RESOLVED canonical DOI (v.work.doi) when the
// ref resolved, else the cited DOI. Bare + lowercased so it intersects the blob
// exactly. Never normalizeIdentifier (that yields an https URI + keeps case).

function keyFor(v) {
  if (!v) { return null; }
  if (typeof v === "string") { var s = lower(trimStr(v)); return s || null; }
  var work = (v.work && v.work.doi) ? v.work.doi : null;
  var cited = (v.ref && v.ref.doi) ? v.ref.doi : (v.doi || v.citedDoi || null);
  var d = work || cited;
  return d ? lower(d) : null;
}

function citedFor(v) {
  if (!v || typeof v === "string") { return typeof v === "string" ? v : null; }
  var cited = (v.ref && v.ref.doi) ? v.ref.doi : (v.doi || v.citedDoi || null);
  if (cited) { return cited; }
  return (v.work && v.work.doi) ? v.work.doi : null;
}

function titleFor(v) {
  if (!v || typeof v === "string") { return null; }
  if (v.work && v.work.title) { return v.work.title; }
  if (v.ref && v.ref.title) { return v.ref.title; }
  return v.title || null;
}

// ---- add / remove / list (in-memory on a state, no persistence) -----------

function addTo(state, verdict) {
  var key = keyFor(verdict);
  if (!key) { return { state: state, item: null, added: false }; }
  var existing = state.items[key];
  var now = nowIso();
  var item = {
    citedDoi: citedFor(verdict) || key,
    title: titleFor(verdict),
    addedAt: (existing && existing.addedAt) ? existing.addedAt : now,
    lastCheckedAt: now,
    lastStatus: (verdict && verdict.status) || monitorStatus(verdict),
    resolved: !!(verdict && verdict.resolved),
    retracted: (verdict && verdict.retracted) || "unknown",
    titleMismatch: !!(verdict && verdict.titleMismatch),
    publisherEvent: (verdict && verdict.publisherEvent) || (existing && existing.publisherEvent) || null,
    engineFixed: true,
    verdictHash: ""
  };
  item.verdictHash = hashVerdict(item);
  state.items[key] = item;
  return { state: state, item: item, added: !existing };
}

// ---- pure delta intersection ----------------------------------------------
// The blob event shape is { doi, notice, type, updated, indexed } where doi
// is ALREADY the retracted paper (the cron did the update-to / updated-by
// extraction). We intersect it against the watchlist and surface hits DIRECTLY
// from the blob — we do NOT gate on a re-check confirming a verdictHash change.

function applyDelta(blob, state) {
  state = state || emptyState();
  if (!state.items) { state.items = {}; }
  var changed = [];
  var events = (blob && blob.events) || [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i] || {};
    if (!ev.doi) { continue; }
    var type = lower(ev.type || "");
    if (!SEVERE[type]) { continue; }
    var doi = lower(ev.doi);
    var item = state.items[doi];
    if (!item) { continue; }
    var prevType = (item.publisherEvent && item.publisherEvent.type) ? lower(item.publisherEvent.type) : "";
    var prevHash = item.verdictHash;
    item.publisherEvent = { type: ev.type, notice: ev.notice || null, source: ev.source || null };
    if (MARKED[type]) { item.retracted = "marked"; }
    item.lastStatus = MARKED[type] ? "marked-retracted" : eventStatus(type);
    item.deltaEvent = {
      doi: doi, notice: ev.notice || null, type: ev.type,
      updated: ev.updated || null, indexed: ev.indexed || null
    };
    var newHash = hashVerdict(item);
    item.verdictHash = newHash;
    if (prevType !== type || prevHash !== newHash) {
      changed.push({ doi: doi, item: item, event: item.deltaEvent });
    }
  }
  if (blob && (blob.built || blob.index_through)) { state.lastDeltaSync = todayStr(); }
  return { state: state, changed: changed };
}

// ---- per-item re-check (client-direct, no graph) --------------------------

function needsRecheck(item, opts) {
  opts = opts || {};
  var maxMs = (opts.maxAgeHours || 24) * 3600 * 1000;
  var now = opts.now || Date.now();
  if (!item) { return true; }
  if (!item.engineFixed) { return true; }
  if (!item.verdictHash) { return true; }
  if (!item.lastCheckedAt) { return true; }
  var t = Date.parse(item.lastCheckedAt);
  if (isNaN(t)) { return true; }
  return (now - t) >= maxMs;
}

function recheck(item, opts) {
  opts = opts || {};
  var checker = opts.checker || (typeof window !== "undefined" ? window.CiteStampCheck : null);
  if (!checker || !checker.checkOne) {
    return Promise.resolve({ item: item, changed: false, verdict: null });
  }
  var ref = { doi: item.citedDoi || null, title: item.title || null };
  // Unattended monitor path: no graph, no our-origin per-DOI call. has-
  // refutations is deliberately outside the monitor verdict.
  var copts = { noGraph: true, site: opts.site || SITE, mailto: opts.mailto || MAILTO };
  return checker.checkOne(ref, copts).then(function (v) {
    v = v || {};
    var prevHash = item.verdictHash;
    // A publisher retraction event, once observed, is STICKY. A single re-check
    // that fails to see it does not clear it: a transient Crossref index gap (or
    // an OpenAlex is_retracted flag momentarily false) is far likelier than a
    // genuine reinstatement, and the delta path only ever escalates. Adopt the
    // fresh flag when there IS one; otherwise keep what we had. resolved and
    // titleMismatch always reflect the latest look.
    var hadEvent = !!(item.publisherEvent || item.retracted === "marked");
    var freshEvent = !!(v.publisherEvent || v.retracted === "marked");
    item.resolved = !!v.resolved;
    item.titleMismatch = !!v.titleMismatch;
    if (freshEvent || !hadEvent) {
      item.retracted = v.retracted || "unknown";
      item.publisherEvent = v.publisherEvent || null;
      item.lastStatus = monitorStatus(v);
    }
    item.lastCheckedAt = nowIso();
    item.engineFixed = true;
    var newHash = hashVerdict(item);
    item.verdictHash = newHash;
    return { item: item, changed: newHash !== prevHash, verdict: v };
  }).catch(function () {
    return { item: item, changed: false, verdict: null };
  });
}

function pool(items, limit, worker) {
  return new Promise(function (resolve) {
    var results = [];
    var idx = 0;
    var done = 0;
    var active = 0;
    if (items.length === 0) { resolve([]); return; }
    function pump() {
      while (active < limit && idx < items.length) {
        (function (i) {
          active++;
          worker(items[i], i).then(function (r) {
            results[i] = r;
          }).catch(function () {
            results[i] = null;
          }).then(function () {
            active--; done++;
            if (done === items.length) { resolve(results); } else { pump(); }
          });
        })(idx);
        idx++;
      }
    }
    pump();
  });
}

// ---- network: the Pro delta blob ------------------------------------------
// Fetches ONE global PII-free blob. No request body, no DOI parameter. Web
// callers rely on the httpOnly account-session cookie (credentials:include);
// cross-origin callers (the extension) pass their Pro API token.

// Resolves to the parsed blob on success (NO __status field), or to a bare
// { __status } marker on any failure (403 for a free caller, 503 before the
// first build, network error). Callers treat a truthy __status as "no blob".
function getDeltaJson(url, init) {
  return fetch(url, init).then(function (r) {
    if (!r || !r.ok) { return { __status: r ? r.status : 0 }; }
    return r.json().then(function (j) {
      return (j && typeof j === "object") ? j : { __status: 0 };
    }).catch(function () { return { __status: 0 }; });
  }).catch(function () { return { __status: 0 }; });
}

function fetchDelta(opts) {
  opts = opts || {};
  var site = opts.site || SITE;
  var url = site + DELTA_PATH;
  if (opts.since) { url += "?since=" + encodeURIComponent(opts.since); }
  var headers = { "Accept": "application/json" };
  if (opts.token) { headers.Authorization = "Bearer " + opts.token; }
  var init = { headers: headers };
  // Same-origin web path leans on the httpOnly account cookie. Cross-origin
  // callers opt out (credentials:false) and authenticate with the token.
  if (opts.credentials !== false) { init.credentials = "include"; }
  return getDeltaJson(url, init);
}

// ---- high-level, self-persisting flows ------------------------------------

function add(verdict) {
  return load().then(function (state) {
    var r = addTo(state, verdict);
    return save(state).then(function () { return r; });
  });
}

function addMany(verdicts) {
  verdicts = verdicts || [];
  return load().then(function (state) {
    var added = [];
    for (var i = 0; i < verdicts.length; i++) {
      var r = addTo(state, verdicts[i]);
      if (r.item) { added.push(r); }
    }
    return save(state).then(function () { return { state: state, added: added }; });
  });
}

function remove(doiKey) {
  var k = lower(doiKey);
  return load().then(function (state) {
    if (state.items[k]) { delete state.items[k]; }
    return save(state).then(function () { return state; });
  });
}

function clear() { return save(emptyState()); }

function list() {
  return load().then(function (state) {
    var out = [];
    for (var k in state.items) {
      if (!state.items.hasOwnProperty(k)) { continue; }
      var it = state.items[k];
      out.push({
        doi: k, citedDoi: it.citedDoi, title: it.title, addedAt: it.addedAt,
        lastCheckedAt: it.lastCheckedAt, lastStatus: it.lastStatus,
        publisherEvent: it.publisherEvent || null, verdictHash: it.verdictHash
      });
    }
    return out;
  });
}

function count() {
  return load().then(function (state) {
    var n = 0;
    for (var k in state.items) { if (state.items.hasOwnProperty(k)) { n++; } }
    return n;
  });
}

// Free flow (and Pro fallback): throttled client-direct re-check of every stale
// item, changed = verdictHash moved. Skips items checked under maxAgeHours.
function recheckAll(opts) {
  opts = opts || {};
  return load().then(function (state) {
    var entries = [];
    for (var k in state.items) {
      if (!state.items.hasOwnProperty(k)) { continue; }
      var it = state.items[k];
      if (opts.force || needsRecheck(it, opts)) { entries.push({ doi: k, item: it }); }
    }
    var limit = opts.concurrency || 3;
    return pool(entries, limit, function (entry) {
      return recheck(entry.item, opts).then(function (r) {
        // Persist as we go. recheck() mutates state.items[k] in place, so saving
        // the shared state after each item lands its lastCheckedAt/verdictHash
        // durably. An MV3 worker can be torn down mid-run (the alarm handler does
        // not extend its lifetime past ~30s); without this a long list makes zero
        // forward progress and the next wake re-checks everything. save() is one
        // keyed write that only moves lastCheckedAt forward, so overlapping saves
        // stay safe — each captures a superset of completed work.
        return save(state).then(function () {
          return r.changed ? { doi: entry.doi, item: entry.item, verdict: r.verdict } : null;
        });
      });
    }).then(function (results) {
      var changed = [];
      for (var i = 0; i < results.length; i++) { if (results[i]) { changed.push(results[i]); } }
      state.lastCheckedAll = nowIso();
      return save(state).then(function () { return { state: state, changed: changed, mode: "full" }; });
    });
  });
}

// The blob is insufficient (staleness contract): never synced, older than the
// window, or holds items stored before the soft-class engine fix. Then a full
// per-DOI re-check is required — and is genuinely complete.
function deltaInsufficient(state, opts) {
  if (!state.lastDeltaSync) { return true; }
  var last = Date.parse(state.lastDeltaSync + "T00:00:00Z");
  if (isNaN(last)) { return true; }
  var now = (opts && opts.now) || Date.now();
  if ((now - last) > WINDOW_DAYS * 24 * 3600 * 1000) { return true; }
  for (var k in state.items) {
    if (!state.items.hasOwnProperty(k)) { continue; }
    if (!state.items[k].engineFixed) { return true; }
  }
  return false;
}

// Pro flow: fetch the delta once, intersect locally, surface hits from the
// blob. Falls back to a full per-DOI re-check when the window is insufficient
// or the endpoint is unavailable (403 for a free caller, 503 before first
// build). The blob is an optimization, never the system of record.
function syncPro(opts) {
  opts = opts || {};
  return load().then(function (state) {
    if (deltaInsufficient(state, opts)) {
      return recheckAll(opts).then(function (r) {
        r.state.lastDeltaSync = todayStr();
        return save(r.state).then(function () {
          return { state: r.state, changed: r.changed, mode: "full" };
        });
      });
    }
    return fetchDelta({
      since: state.lastDeltaSync, token: opts.token,
      site: opts.site, credentials: opts.credentials
    }).then(function (blob) {
      if (!blob || typeof blob.__status !== "undefined") {
        return recheckAll(opts);
      }
      var applied = applyDelta(blob, state);
      return save(applied.state).then(function () {
        return { state: applied.state, changed: applied.changed, mode: "delta" };
      });
    });
  });
}

function configure(opts) {
  opts = opts || {};
  if (opts.storage) { STORAGE = opts.storage; }
  if (opts.site) { SITE = opts.site; }
  if (opts.mailto) { MAILTO = opts.mailto; }
  return API;
}

var API = {
  version: VERSION,
  KEY: KEY,
  windowDays: WINDOW_DAYS,
  configure: configure,
  load: load,
  save: save,
  keyFor: keyFor,
  hashVerdict: hashVerdict,
  monitorStatus: monitorStatus,
  needsRecheck: needsRecheck,
  add: add,
  addMany: addMany,
  addTo: addTo,
  remove: remove,
  clear: clear,
  list: list,
  count: count,
  applyDelta: applyDelta,
  recheck: recheck,
  recheckAll: recheckAll,
  fetchDelta: fetchDelta,
  syncPro: syncPro
};

window.CiteStampWatchlist = API;
})();
