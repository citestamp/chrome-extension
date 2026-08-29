/* CiteStamp entitlement v1.0.0 — the shared Pro check.
   Reads GET /api/v1/me. Degrades to free on any error; a cached Pro survives
   an outage. Client-side, like every desktop app — not a cryptographic gate.
   https://citestamp.com/pricing */
(function () {
"use strict";
if (window.CiteStampEntitlement) { return; }

var VERSION = "1.0.0";
var FREE = "free";
var PRO = "pro";

// A paying user must not lose a workflow action to a flaky network. A cached
// PRO keeps working this long without a successful re-check. Only an
// authoritative answer from the server can end it early.
var GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// How long a fresh answer is trusted before a background re-check is worth it.
var FRESH_MS = 6 * 60 * 60 * 1000;

// A hung request must not hang a button. The race resolves null, the caller
// falls back to whatever it already knew.
var TIMEOUT_MS = 6000;

function now() { return Date.now(); }

function normalizePlan(v) { return v === PRO ? PRO : FREE; }

// Only "pro" and "free" are authoritative. Anything else is a non-answer.
function readPlan(v) {
  if (v === PRO) { return PRO; }
  if (v === FREE) { return FREE; }
  return null;
}

function readEntry(raw) {
  if (!raw || typeof raw !== "object") { return null; }
  var plan = readPlan(raw.plan);
  var at = typeof raw.checkedAt === "number" ? raw.checkedAt : 0;
  if (!plan || !at) { return null; }
  return { plan: plan, checkedAt: at };
}

// A cached FREE is never load-bearing — free is the default anyway. Only a
// cached PRO is worth honouring, and only inside the grace window. A clock
// that has moved backwards reads as "in the future" and is honoured, not
// punished.
function usable(entry) {
  if (!entry || entry.plan !== PRO) { return false; }
  return (now() - entry.checkedAt) < GRACE_MS;
}

function fresh(entry) {
  if (!entry) { return false; }
  var age = now() - entry.checkedAt;
  return age >= 0 && age < FRESH_MS;
}

// Never let an adapter throw, synchronously or otherwise. A broken adapter
// means "unknown", which means free.
function call(fn, arg) {
  if (typeof fn !== "function") { return Promise.resolve(null); }
  try {
    return Promise.resolve(fn(arg)).then(function (v) { return v; }, function () { return null; });
  } catch (e) {
    return Promise.resolve(null);
  }
}

function race(p, ms) {
  return new Promise(function (resolve) {
    var settled = false;
    var t = setTimeout(function () {
      if (!settled) { settled = true; resolve(null); }
    }, ms);
    p.then(function (v) {
      if (!settled) { settled = true; clearTimeout(t); resolve(v); }
    }, function () {
      if (!settled) { settled = true; clearTimeout(t); resolve(null); }
    });
  });
}

// ---- the standard transport -------------------------------------------------
// GET <base>/api/v1/me. A token, when present, goes as a bearer. Without one, a
// same-origin caller may authenticate with the httpOnly account-session cookie
// (opts.credentials). Resolves {plan} on an authoritative answer, else null.
//
// Note the server answers 200 {"plan":"free","via":"token"} for a token it does
// not recognise — it does not 401. A caller validating a pasted key must look
// at the plan, never at the status code.
function httpFetchMe(opts) {
  var o = opts || {};
  var f = typeof o.fetchImpl === "function" ? o.fetchImpl
        : (typeof fetch === "function" ? fetch : null);
  if (!f) { return Promise.resolve(null); }

  var init = { method: "GET", headers: { Accept: "application/json" } };
  if (o.token) { init.headers.Authorization = "Bearer " + o.token; }
  else if (o.credentials) { init.credentials = "include"; }

  var req;
  try { req = f((o.base || "") + "/api/v1/me", init); }
  catch (e) { return Promise.resolve(null); }

  var parsed = Promise.resolve(req).then(function (r) {
    if (!r || !r.ok) { return null; }
    return Promise.resolve(r.json()).then(function (j) {
      var plan = j ? readPlan(j.plan) : null;
      return plan ? { plan: plan } : null;
    }, function () { return null; });
  }, function () { return null; });

  return race(parsed, typeof o.timeoutMs === "number" ? o.timeoutMs : TIMEOUT_MS);
}

// ---- a cache adapter for panels with nowhere to persist ---------------------
function memoryStore() {
  var held = null;
  return {
    get: function () { return held; },
    set: function (v) { held = v; }
  };
}

// ---- the core ---------------------------------------------------------------
// adapter = {
//   fetchMe():        Promise<{plan}|null>   an authoritative answer, or null
//   cacheGet():       Promise<object|null>   the last stored entry
//   cacheSet(entry):  Promise<any>           persist {plan, checkedAt}
//   cacheClear():     Promise<any>           optional; used on disconnect
// }
// opts = { timeoutMs }  how long to wait on fetchMe before calling it a
//                       non-answer. Defaults to TIMEOUT_MS. A transport with a
//                       slower round trip (Apps Script) may want more.
function create(adapter, opts) {
  var a = adapter || {};
  var o = opts || {};
  var timeoutMs = typeof o.timeoutMs === "number" ? o.timeoutMs : TIMEOUT_MS;
  var mem = null;        // last known entry, in this process
  var loaded = false;
  var inflight = null;

  function load() {
    if (loaded) { return Promise.resolve(mem); }
    return call(a.cacheGet).then(function (raw) {
      loaded = true;
      mem = readEntry(raw);
      return mem;
    });
  }

  function store(plan) {
    var entry = { plan: normalizePlan(plan), checkedAt: now() };
    mem = entry;
    loaded = true;
    return call(a.cacheSet, { plan: entry.plan, checkedAt: entry.checkedAt })
      .then(function () { return entry.plan; });
  }

  // Whatever we can honour without the network.
  function offline() {
    return load().then(function (e) { return usable(e) ? PRO : FREE; });
  }

  // Force a network read. Never rejects. An authoritative answer is stored and
  // returned — including an authoritative FREE, which downgrades a cached PRO
  // immediately. A non-answer leaves the cache alone.
  //
  // The adapter's fetchMe is RACED here, not only inside httpFetchMe: an adapter
  // may be a transport we do not control (Apps Script's google.script.run can
  // invoke neither its success nor its failure handler), and an fetchMe that
  // never settles would wedge every gated action for the life of the panel.
  // A timeout is a non-answer, so a usable cached PRO still wins.
  function refresh() {
    if (inflight) { return inflight; }
    var p = race(call(a.fetchMe), timeoutMs).then(function (res) {
      var plan = res ? readPlan(res.plan) : null;
      if (!plan) { return offline(); }
      return store(plan);
    });
    inflight = p.then(
      function (plan) { inflight = null; return normalizePlan(plan); },
      function () { inflight = null; return FREE; }
    );
    return inflight;
  }

  // The one call a workflow action should make. A usable cached PRO answers
  // immediately and re-checks in the background, so the button never waits on
  // the network for a user who has already paid.
  function plan() {
    return load().then(function (e) {
      if (usable(e)) {
        if (!fresh(e)) { refresh(); }
        return PRO;
      }
      return refresh();
    });
  }

  function isPro() { return plan().then(function (p) { return p === PRO; }); }

  // Synchronous, for painting a panel before the first resolve lands. Defaults
  // to free and is never the basis for allowing an action.
  function cached() { return usable(mem) ? PRO : FREE; }

  function forget() {
    mem = null;
    loaded = true;
    return call(a.cacheClear).then(function () { return FREE; });
  }

  return {
    plan: plan,
    isPro: isPro,
    refresh: refresh,
    cached: cached,
    forget: forget
  };
}

// ---- validating a pasted key ------------------------------------------------
// Returns "pro", "free", or null when the server could not be reached. A null
// is NOT a rejection: the key is saved and re-checked later. Only an
// authoritative "free" means the pasted key is not a Pro key.
function probe(opts) {
  return httpFetchMe(opts).then(function (res) {
    return res ? readPlan(res.plan) : null;
  });
}

window.CiteStampEntitlement = {
  VERSION: VERSION,
  FREE: FREE,
  PRO: PRO,
  GRACE_MS: GRACE_MS,
  FRESH_MS: FRESH_MS,
  TIMEOUT_MS: TIMEOUT_MS,
  create: create,
  probe: probe,
  httpFetchMe: httpFetchMe,
  memoryStore: memoryStore
};
})();
