
/* CiteStamp - continuous citation-health checking.
   https://citestamp.com/privacy

   Pure functions first, then createEngine(). Every dependency is injected --
   checker, storage, clock, timers -- so the whole engine is testable without a
   browser. Nothing in here reads a global except window, at the very bottom. */
(function () {
"use strict";
if (window.CiteStampContinuous) { return; }

var VERSION = "1.0.0";

/* The LaTeX command prefix. Written this way because the served script may not
   contain the character literally. */
var BS = String.fromCharCode(92);
var TAB = String.fromCharCode(9);
var LF = String.fromCharCode(10);
var CR = String.fromCharCode(13);

/* Storage keys. The bibliography cache is per project; verdicts are shared
   across projects, because a reference is a reference wherever it is cited. */
var BIB_KEY = "citestamp.cont.bib.v1";
var VERDICT_KEY = "citestamp.cont.verdicts.v1";
var BUDGET_KEY = "citestamp.cont.budget.v1";

/* Defaults. dailyBudget counts checkOne calls, which is very close to counting
   OpenAlex requests. 150 leaves most of a shared per-IP budget for the free
   checker and anything else behind the same address. */
var DEBOUNCE_MS = 900;
var MAX_IN_FLIGHT = 3;
var TTL_MS = 24 * 3600 * 1000;
var DAILY_BUDGET = 150;
var RATE_PER_MIN = 20;
var MAX_BIB = 500;
var MAX_VERDICTS = 500;
/* A paste of more entries than this is a whole bibliography, not a reference.
   We learn all of it (free, local, no network) and check none of it: spending
   the day's whole allowance on one paste would leave nothing for the writing
   that follows, and the free check-bibliography panel already does exactly this
   job, on demand, with the user present. Automatic spending is capped; spending
   the user asked for is not. */
var MAX_PASTE_CHECKS = 25;
var BACKOFF_MIN_MS = 15 * 60 * 1000;
var BACKOFF_MAX_MS = 4 * 3600 * 1000;
var UNCHECKED_BEFORE_BACKOFF = 3;

/* A verdict this engine can reach with zero network: the cite key names no entry
   in any bibliography we have been shown for this project. It is NOT the same as
   does-not-resolve, and must never be rendered as though it were. */
var KEY_MISSING = "key-not-in-bibliography";

/* Statuses worth interrupting someone for. */
var SEVERE = {
  "marked-retracted": 1,
  "does-not-resolve": 1,
  "doi-title-mismatch": 1
};

/* ---- tiny helpers (no regex, no backslash) ------------------------------- */

function isSpaceCh(ch) { return ch === " " || ch === TAB || ch === LF || ch === CR; }

function trimStr(s) {
  s = String(s === null || s === undefined ? "" : s);
  var a = 0, b = s.length;
  while (a < b && isSpaceCh(s.charAt(a))) { a++; }
  while (b > a && isSpaceCh(s.charAt(b - 1))) { b--; }
  return s.slice(a, b);
}

function isAlpha(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function lower(s) { return String(s === null || s === undefined ? "" : s).toLowerCase(); }

function keysOf(o) {
  var out = [];
  for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { out.push(k); } }
  return out;
}

/* ---- cite-command scanning ----------------------------------------------- */

/* natbib + biblatex + plain LaTeX. Starred and capitalized variants are folded. */
var CITE_CMDS = {
  cite: 1, citep: 1, citet: 1, citealp: 1, citealt: 1, citeauthor: 1,
  citeyear: 1, citeyearpar: 1, citenum: 1, fullcite: 1, nocite: 1,
  parencite: 1, textcite: 1, autocite: 1, smartcite: 1, footcite: 1,
  supercite: 1, citeasnoun: 1
};

function isCiteCmd(name) {
  var n = name;
  if (n.length > 0 && n.charAt(n.length - 1) === "*") { n = n.slice(0, n.length - 1); }
  if (n.length === 0) { return false; }
  var folded = n.charAt(0).toLowerCase() + n.slice(1);
  return Object.prototype.hasOwnProperty.call(CITE_CMDS, folded);
}

/* Extract the cite keys from a chunk of LaTeX. Handles optional bracket
   arguments, comma-separated key lists, and starred forms. An unterminated brace
   yields nothing, which is what makes this safe to run on every keystroke: a key
   is only seen once the user closes the brace. */
function extractCiteKeys(text) {
  var out = [], seen = {};
  if (!text) { return out; }
  var s = String(text), n = s.length, i = 0;
  while (i < n) {
    if (s.charAt(i) !== BS) { i++; continue; }
    /* A doubled prefix is a LaTeX line break, and what follows it is literal
       text, not a command. Skip both characters. Reading a key out of it would
       be inventing a citation the document does not make. */
    if (s.charAt(i + 1) === BS) { i += 2; continue; }
    var j = i + 1;
    while (j < n && (isAlpha(s.charAt(j)) || s.charAt(j) === "*")) { j++; }
    var name = s.slice(i + 1, j);
    if (!isCiteCmd(name)) { i = (j > i + 1) ? j : i + 1; continue; }
    /* Optional bracket arguments. An unterminated one means this command has no
       key list here -- skip the command, but keep scanning the rest of the line
       so one typo does not blind us to every citation after it. */
    var k = j, truncated = false;
    while (k < n && s.charAt(k) === "[") {
      var close = s.indexOf("]", k + 1);
      if (close < 0) { truncated = true; break; }
      k = close + 1;
    }
    if (!truncated && k < n && s.charAt(k) === "{") {
      var end = s.indexOf("}", k + 1);
      if (end > k) {
        var parts = s.slice(k + 1, end).split(",");
        for (var p = 0; p < parts.length; p++) {
          var key = trimStr(parts[p]);
          /* A cite key cannot contain a brace. Anything that does is a parse
             artifact of a nested group, not a key. Drop it; never look it up. */
          if (!key || key.indexOf("{") >= 0 || key.indexOf("}") >= 0) { continue; }
          if (!Object.prototype.hasOwnProperty.call(seen, key)) {
            seen[key] = 1;
            out.push(key);
          }
        }
        i = end + 1;
        continue;
      }
    }
    i = j;
  }
  return out;
}

/* ---- identity + dedupe ---------------------------------------------------- */

/* Fold a title to a comparison key. Never used as a graph identifier -- only to
   decide whether we have already looked this reference up. */
function normTitle(t) {
  var s = lower(t), out = [], prevSpace = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out.push(ch);
      prevSpace = false;
    } else if (!prevSpace) {
      out.push(" ");
      prevSpace = true;
    }
  }
  return trimStr(out.join(""));
}

/* A DOI is lowercased HERE, for cache identity only. Registries resolve DOIs
   case-insensitively, but the registry's own casing is passed through unchanged
   to checkOne -- we never rewrite what we send. */
function cacheKey(ref) {
  if (!ref) { return null; }
  if (ref.doi) { return "d:" + lower(ref.doi); }
  if (ref.title) {
    var t = normTitle(ref.title);
    return t ? "t:" + t : null;
  }
  return null;
}

/* Did the AUTHOR supply the identity, or did we guess it?
   "openalex-doi" / "crossref-doi" / "datacite-doi" mean the reference carried a
   DOI and a registry resolved it. "openalex-title" / "crossref-title" mean we
   matched a title, and a clean title match is not an exact one. */
function doiAnchored(via) {
  var s = String(via === null || via === undefined ? "" : via);
  return s.length > 4 && s.slice(-4) === "-doi";
}

/* May this verdict be enrolled in the watchlist?
   It must be a DOI the author wrote, that resolved, with no weak match and no
   DOI/title disagreement. Note that a title-only reference can NEVER carry
   titleMismatch -- check-js only runs that cross-check when the ref has both a
   DOI and a title -- so weakMatch and titleMismatch alone do not keep a fuzzy
   title hit out. doiAnchored does. */
function watchable(v) {
  if (!v) { return false; }
  if (!v.resolved) { return false; }
  if (v.weakMatch) { return false; }
  if (v.titleMismatch) { return false; }
  if (!doiAnchored(v.resolvedVia)) { return false; }
  return !!(v.work && v.work.doi);
}

function ymdOf(ms) { return new Date(ms).toISOString().slice(0, 10); }

/* Drop the oldest entries once a cache passes its cap. Tolerates a corrupted
   value (storage is not ours to trust): a non-object sorts as oldest and is
   evicted first, rather than throwing inside the comparator. */
function stampOf(v, stamp) {
  return (v && typeof v === "object" && v[stamp]) || 0;
}

function trimCache(map, cap, stamp) {
  var ks = keysOf(map);
  if (ks.length <= cap) { return map; }
  ks.sort(function (a, b) { return stampOf(map[a], stamp) - stampOf(map[b], stamp); });
  for (var i = 0; i < ks.length - cap; i++) { delete map[ks[i]]; }
  return map;
}

/* ---- the engine ----------------------------------------------------------- */

function createEngine(opts) {
  opts = opts || {};
  var checker = opts.checker;
  var storage = opts.storage;
  var project = opts.project || "overleaf";
  var now = opts.now || function () { return Date.now(); };
  var schedule = opts.schedule || function (fn, ms) { return setTimeout(fn, ms); };
  var cancel = opts.cancel || function (h) { clearTimeout(h); };
  var onChange = opts.onChange || function () {};
  /* Hand a clean verdict to the watchlist. Injected, so the engine stays free of
     chrome.* and stays testable. Never called for a verdict that fails
     watchable(), never called while the gate is closed, and never called from a
     cache hit -- only from a lookup that actually settled. */
  var onWatch = opts.onWatch || null;

  var L = opts.limits || {};
  var debounceMs = L.debounceMs || DEBOUNCE_MS;
  var maxInFlight = L.maxInFlight || MAX_IN_FLIGHT;
  var ttlMs = L.ttlMs || TTL_MS;
  var dailyBudget = L.dailyBudget || DAILY_BUDGET;
  var ratePerMin = L.ratePerMin || RATE_PER_MIN;
  var maxBib = L.maxBib || MAX_BIB;
  var maxVerdicts = L.maxVerdicts || MAX_VERDICTS;
  var maxPasteChecks = L.maxPasteChecks || MAX_PASTE_CHECKS;

  var enabled = false;
  var bib = {};
  var verdicts = {};
  var budget = { ymd: "", used: 0 };
  var results = {};
  var pending = {};
  var inFlightKeys = {};
  var inFlight = 0;
  var timer = null;
  var lookupTimes = [];
  var pausedUntil = 0;
  var pausedReason = null;
  var notice = null;
  var watched = 0;
  var unchecked = 0;
  var readyP = null;
  var draining = false;
  var redrain = false;

  var bibKey = BIB_KEY + "." + project;

  function get(k) { return Promise.resolve(storage.get(k)); }
  function set(k, v) { return Promise.resolve(storage.set(k, v)); }

  function ready() {
    if (readyP) { return readyP; }
    readyP = Promise.all([get(bibKey), get(VERDICT_KEY), get(BUDGET_KEY)]).then(function (r) {
      bib = r[0] || {};
      verdicts = r[1] || {};
      budget = r[2] || { ymd: "", used: 0 };
    }, function () {
      bib = {}; verdicts = {}; budget = { ymd: "", used: 0 };
    });
    return readyP;
  }

  function saveBib() { trimCache(bib, maxBib, "seenAt"); return set(bibKey, bib); }
  function saveVerdicts() { trimCache(verdicts, maxVerdicts, "checkedAt"); return set(VERDICT_KEY, verdicts); }

  /* ---- budget + rate ------------------------------------------------------ */

  /* Reserve one lookup against the daily allowance.
     The counter is read-modify-WRITTEN against storage on every reservation
     rather than held in memory, because every open Overleaf tab is a separate
     content-script instance over one shared chrome.storage.local. An in-memory
     counter let K tabs each spend the full allowance -- K times the intended
     per-IP spend, and OpenAlex meters per IP.
     This is NOT atomic; chrome.storage has no compare-and-swap. Two tabs whose
     read-modify-writes interleave can overshoot by at most the number of tabs
     racing in one round trip. That is a bounded overshoot of a few requests,
     not a multiple of the allowance. We do not claim more than that.
     Reserved BEFORE the request, so a crash cannot under-count. */
  function reserveBudget() {
    return get(BUDGET_KEY).then(function (stored) {
      var b = (stored && typeof stored === "object") ? stored : { ymd: "", used: 0 };
      var d = ymdOf(now());
      if (b.ymd !== d) { b = { ymd: d, used: 0 }; }
      if (b.used >= dailyBudget) { budget = b; return false; }
      b.used++;
      budget = b;
      return set(BUDGET_KEY, b).then(function () { return true; }, function () { return true; });
    }, function () { return false; });
  }

  function nextUtcMidnight() {
    return Date.parse(ymdOf(now()) + "T23:59:59Z") + 1000;
  }

  function rateOk() {
    var cutoff = now() - 60000, keep = [];
    for (var i = 0; i < lookupTimes.length; i++) {
      if (lookupTimes[i] > cutoff) { keep.push(lookupTimes[i]); }
    }
    lookupTimes = keep;
    return lookupTimes.length < ratePerMin;
  }

  function backoffMs() {
    var over = unchecked - UNCHECKED_BEFORE_BACKOFF;
    var ms = BACKOFF_MIN_MS * Math.pow(2, over < 0 ? 0 : over);
    return ms > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : ms;
  }

  /* ---- results ------------------------------------------------------------ */

  function emit() { onChange(summary()); }

  function record(id, rec) {
    var prev = results[id];
    results[id] = rec;
    trimCache(results, maxVerdicts, "checkedAt");
    /* Re-render when anything the strip actually shows has changed -- not only
       the status. A re-record with an identical status and a new suggestion or
       resolved title would otherwise leave stale detail on screen. */
    if (!prev || prev.status !== rec.status || prev.doi !== rec.doi || prev.title !== rec.title) {
      emit();
    }
  }

  function summary() {
    var ids = keysOf(results), problems = [], checked = 0;
    for (var i = 0; i < ids.length; i++) {
      var r = results[ids[i]];
      if (r.status !== KEY_MISSING && r.status !== "unchecked") { checked++; }
      if (r.status !== "ok") { problems.push(r); }
    }
    return {
      enabled: enabled,
      checked: checked,
      problems: problems,
      severe: problems.filter(function (p) {
        return Object.prototype.hasOwnProperty.call(SEVERE, p.status);
      }),
      paused: now() < pausedUntil ? pausedReason : null,
      notice: notice,
      watched: watched,
      bibCount: keysOf(bib).length,
      budgetUsed: budget.used,
      budgetLimit: dailyBudget
    };
  }

  /* ---- lookup queue ------------------------------------------------------- */

  function enqueue(ref) {
    if (!enabled) { return; }
    var k = cacheKey(ref);
    if (!k) { return; }
    var cached = verdicts[k];
    if (cached && (now() - cached.checkedAt) < ttlMs) {
      record(k, mergeRef(cached, ref, k));
      return;
    }
    /* Three dedupe guards, and all three are needed. pending: queued, not yet
       dispatched. inFlightKeys: dispatched, not yet settled -- without this, a
       keystroke landing while the network is slow buys a second lookup of the
       same identifier, on the user's own metered budget. verdicts: settled. */
    if (Object.prototype.hasOwnProperty.call(pending, k)) { return; }
    if (Object.prototype.hasOwnProperty.call(inFlightKeys, k)) { return; }
    pending[k] = ref;
    bump();
  }

  function bump() {
    if (timer !== null) { cancel(timer); }
    timer = schedule(function () { timer = null; drain(); }, debounceMs);
  }

  function mergeRef(rec, ref, id) {
    return {
      id: id,
      key: (ref && ref.key) || null,
      status: rec.status,
      title: rec.title || (ref && ref.title) || null,
      doi: rec.doi || (ref && ref.doi) || null,
      suggestion: rec.suggestion || null,
      checkedAt: rec.checkedAt
    };
  }

  /* drain() reserves budget asynchronously, so it can re-enter. One drain runs
     at a time; anything that arrives mid-drain sets redrain and is picked up on
     the way out. */
  function drain() {
    if (draining) { redrain = true; return Promise.resolve(); }
    draining = true;
    return step().then(finishDrain, finishDrain);
  }

  function finishDrain() {
    draining = false;
    if (redrain) { redrain = false; return drain(); }
  }

  function step() {
    if (!enabled) { return Promise.resolve(); }
    if (now() < pausedUntil) { return Promise.resolve(); }
    pausedReason = null;
    if (inFlight >= maxInFlight) { return Promise.resolve(); }
    var ks = keysOf(pending);
    if (!ks.length) { return Promise.resolve(); }
    if (!rateOk()) { bump(); return Promise.resolve(); }

    var k = ks[0];
    var ref = pending[k];
    delete pending[k];

    return reserveBudget().then(function (ok) {
      if (!ok) {
        pending[k] = ref; // still owed a check when the allowance resets
        pausedUntil = nextUtcMidnight();
        pausedReason = "budget";
        emit();
        return;
      }
      if (!enabled) { return; }
      startLookup(k, ref);
      return step();
    });
  }

  function startLookup(k, ref) {
    inFlight++;
    inFlightKeys[k] = 1;
    lookupTimes.push(now());

    var settled = function (v) {
      inFlight--;
      delete inFlightKeys[k];
      /* The gate may have closed while this was in flight. Drop the answer. */
      if (!enabled) { return; }
      if (!v || v.status === "unchecked") {
        /* A lookup source did not answer. Say so -- never render silence as a
           clean bill of health -- but do NOT cache it, so it is retried. */
        unchecked++;
        record(k, {
          id: k, key: (ref && ref.key) || null, status: "unchecked",
          title: ref.title || null, doi: ref.doi || null,
          suggestion: null, checkedAt: now()
        });
        if (unchecked >= UNCHECKED_BEFORE_BACKOFF) {
          pausedUntil = now() + backoffMs();
          pausedReason = "lookup";
          emit();
        }
      } else {
        unchecked = 0;
        var rec = {
          status: v.status,
          title: (v.work && v.work.title) || ref.title || null,
          doi: (v.work && v.work.doi) || ref.doi || null,
          suggestion: v.suggestion || null,
          checkedAt: now()
        };
        verdicts[k] = rec;
        saveVerdicts();
        record(k, mergeRef(rec, ref, k));
        if (onWatch && watchable(v)) {
          watched++;
          try { onWatch(v); } catch (e) {}
        }
      }
      drain();
    };

    var p;
    try { p = checker.checkOne(ref, { noGraph: true }); } catch (e) { p = null; }
    if (!p || typeof p.then !== "function") { settled(null); return; }
    p.then(settled, function () { settled(null); });
  }

  /* ---- bibliography ------------------------------------------------------- */

  /* Merge parsed entries into this project's key -> reference map. Only entries
     that carry a cite key can resolve a cite command; entries without one are
     still checked, they just cannot be named. */
  function learn(refs) {
    var t = now(), learned = 0;
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      if (!r || !r.key) { continue; }
      if (!r.doi && !r.title) { continue; }
      bib[r.key] = { key: r.key, doi: r.doi || null, title: r.title || null, seenAt: t };
      learned++;
    }
    if (learned) { saveBib(); }
    return learned;
  }

  /* ---- public surface ----------------------------------------------------- */

  /* The gate. Not cryptographic, and nothing here pretends otherwise: it is a
     client-side entitlement read, like every desktop application does. Disabled
     means no queue, no lookup, no results -- not a degraded check. */
  function setEnabled(on) {
    var was = enabled;
    enabled = !!on;
    if (!enabled) {
      if (timer !== null) { cancel(timer); timer = null; }
      pending = {};
      results = {};
      notice = null;
      watched = 0;
    }
    if (was !== enabled) { emit(); }
  }

  /* Every entry point funnels through ready(), so a keystroke that lands before
     the caches finish loading cannot be answered from an empty map -- and cannot
     have its writes clobbered by the load that follows it. ready() resolves once
     and is then a microtask. */
  function doNoteEdit(text) {
    if (!enabled || !text) { return; }
    var keys = extractCiteKeys(text);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var ref = bib[key];
      if (ref) {
        enqueue(ref);
      } else {
        record("k:" + key, {
          id: "k:" + key, key: key, status: KEY_MISSING,
          title: null, doi: null, suggestion: null, checkedAt: now()
        });
      }
    }
  }

  /* The clipboard payload of a paste. Complete, and immune to line
     virtualization -- this is the only way to see text the user did not type. */
  function doNotePaste(text) {
    if (!enabled || !text) { return; }
    var s = String(text);
    if (s.indexOf(BS) >= 0) { doNoteEdit(s); }
    var refs = [];
    try { refs = checker.parseInput(s) || []; } catch (e) { refs = []; }
    if (!refs.length) { return; }
    var learned = learn(refs);

    var checkable = [];
    for (var i = 0; i < refs.length; i++) {
      if (refs[i] && (refs[i].doi || refs[i].title)) { checkable.push(refs[i]); }
    }

    /* A whole bibliography, not a reference. Keep the entries -- that is free
       and local, and it is what makes a cite key resolve later -- but do not
       spend the day allowance on a single paste. Say so, and point at the free
       panel, which does this on demand with the user present. */
    if (checkable.length > maxPasteChecks) {
      notice = { kind: "bulk-paste", learned: learned, refs: checkable.length };
      emit();
      return;
    }
    notice = null;
    for (var j = 0; j < checkable.length; j++) { enqueue(checkable[j]); }
  }

  /* Bibliography text from somewhere other than a paste -- today, whatever the
     user typed into the free check panel. Learns the entries without checking
     them; the panel is about to check them itself. Learning is local-only and
     costs nothing, so it is not gated: it is what makes a cite key resolve to a
     real reference the moment someone turns Pro on. */
  function doNoteBib(text) {
    if (!text) { return 0; }
    var refs = [];
    try { refs = checker.parseBib(String(text)) || []; } catch (e) { refs = []; }
    return learn(refs);
  }

  function noteEdit(text) { return ready().then(function () { doNoteEdit(text); }); }
  function notePaste(text) { return ready().then(function () { doNotePaste(text); }); }
  function noteBib(text) { return ready().then(function () { return doNoteBib(text); }); }

  /* Run the queue now instead of waiting out the debounce. */
  function flush() {
    if (timer !== null) { cancel(timer); timer = null; }
    return ready().then(drain);
  }

  function bibCount() { return keysOf(bib).length; }

  return {
    ready: ready,
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    noteEdit: noteEdit,
    notePaste: notePaste,
    noteBib: noteBib,
    flush: flush,
    summary: summary,
    bibCount: bibCount
  };
}

window.CiteStampContinuous = {
  version: VERSION,
  KEY_MISSING: KEY_MISSING,
  SEVERE: SEVERE,
  extractCiteKeys: extractCiteKeys,
  watchable: watchable,
  doiAnchored: doiAnchored,
  normTitle: normTitle,
  cacheKey: cacheKey,
  trimCache: trimCache,
  createEngine: createEngine
};
})();
