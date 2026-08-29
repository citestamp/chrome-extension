// CiteStamp MV3 service worker — per-tab state + toolbar badge.
//
// Receives {type:"cs-doi"} from the detection content script, fetches the
// identifier's public record from api.citestamp.com (CORS-open, KV-cached,
// unauthenticated — the same endpoint the /graph page uses), and badges
// the tab with the edge count. Gold badge = the paper has recorded claims;
// steel "0" = detected but not in the graph yet.
//
// State lives in chrome.storage.session (trusted contexts only — the
// popup reads it, content scripts cannot): tab:<id> for detection state,
// graph:<doi> as a short-lived count cache.
//
// This worker is the ONLY writer of the bibliography watchlist. It is one JSON
// blob under one key, so every mutation is a read-modify-write and two of them
// interleaving loses an item. The popup and the Overleaf content script ask this
// worker to write (cs-wl-add / cs-wl-remove / cs-wl-clear); they never write it
// themselves. A service worker has exactly one instance, so one queue is enough.

var API_BASE = "https://api.citestamp.com/api/v1/graph/";
var CACHE_TTL_MS = 10 * 60 * 1000;

// ---- bibliography watchlist monitor (daily unattended re-check) ------------
//
// The watchlist core (window.CiteStampWatchlist) and the checker engine
// (window.CiteStampCheck) are the SAME vanilla-JS cores the /check page serves,
// vendored byte-identical into vendor/ (MV3 forbids remotely-hosted code). They
// register on `window`; a service worker's global is `self`, so we alias it
// before importing. defaultStorage()'s window.localStorage path is never taken
// because we inject a chrome.storage.local adapter via configure().
//
// Privacy contract (docs/monitoring-design.md): this UNATTENDED path talks ONLY
// to Crossref/DataCite/OpenAlex and MUST NOT hit our /api/v1/graph endpoint.
// recheck() already passes noGraph:true; has-refutations is excluded from the
// monitor verdict. Nothing about the watchlist is ever sent to a CiteStamp
// server — it lives only in chrome.storage.local on this machine.
self.window = self;
try {
  importScripts("vendor/check-v1.js", "vendor/watchlist-v1.js");
} catch (e) {
  // If a vendored core is missing the monitor stays inert; the graph badge
  // (below) is unaffected.
}

var WL_SITE = "https://citestamp.com";
var WL_MAILTO = "info@citestamp.com";
var WL_ALARM = "cs-watchlist-daily";
var WL_PERIOD_MIN = 1440; // once a day (latency is >=24h; Crossref index lag, no live push)
var WL_TOKEN_KEY = "citestamp.delta.token"; // optional Pro API token; batches the daily re-check into one blob fetch
var WL_CHANGED_KEY = "citestamp.watchlist.changed.v1"; // unseen changes for the badge

// Ceiling on AUTO-enrolled papers. The monitor's fallback path (delta window too
// old, or the blob fetch failed) re-checks every stale item client-direct, one
// OpenAlex lookup each, and OpenAlex meters per IP at roughly 1000/day. Without a
// ceiling, a watchlist grown from a manuscript could spend the whole allowance in
// one fallback run.
//
// What this bounds, precisely: the number of papers auto-enrolment can add, hence
// at most 200 OpenAlex lookups in a fallback run. It is NOT a bound on the day's
// total spend. The in-editor checker has its own separate allowance (150/day, see
// continuous-js.ts), and papers the user adds BY HAND from the popup are never
// refused, because that spend was asked for. Worst realistic case for one Pro user
// whose delta fetch fails: ~200 + ~150 = ~350 against ~1000.
//
// Known and accepted: the list is retained if the user later cancels Pro, and the
// tokenless monitor path re-checks it per-DOI. That is the same cost any user
// carrying 200 hand-added papers already pays, on their own address.
var WL_AUTO_MAX = 200;

// chrome.storage.local adapter — the extension's canonical store, shared with
// the popup. get() resolves to the stored string (or null); set() resolves when
// written. Both return Promises, which the core wraps in Promise.resolve().
var WL_STORAGE = {
  get: function (k) {
    return chrome.storage.local.get(k).then(function (o) {
      return o && o[k] != null ? o[k] : null;
    });
  },
  set: function (k, val) {
    var o = {};
    o[k] = val;
    return chrome.storage.local.set(o);
  },
};

// Re-configure on every worker load (MV3 workers are ephemeral; no persistent
// globals survive between alarms).
function watchlistApi() {
  if (!self.CiteStampWatchlist) return null;
  return self.CiteStampWatchlist.configure({
    storage: WL_STORAGE,
    site: WL_SITE,
    mailto: WL_MAILTO,
  });
}
watchlistApi();

// One writer, one queue. The watchlist is a single JSON blob under one key, so
// load()->mutate->save() is a read-modify-write and two of them interleaving loses
// an item. Everything that writes it goes through here, and everything that writes
// it lives in THIS service worker (there is one instance; content scripts and the
// popup ask it to write). Serialising here is therefore sufficient, and it is why
// the Overleaf content script sends a message instead of writing directly.
var wlQueue = Promise.resolve();
function wlSerial(fn) {
  var run = wlQueue.then(fn, fn);
  wlQueue = run.then(function () {}, function () {});
  return run;
}

function setMonitorBadge(count) {
  if (!count) return clearMonitorBadge();
  // Global (tab-less) badge. Per-tab graph badges set via setBadgeText({tabId})
  // override it on DOI pages; on every other tab this alerts to changes.
  chrome.action.setBadgeBackgroundColor({ color: "#a3352b" });
  chrome.action.setBadgeText({ text: count > 9 ? "9+" : String(count) });
  chrome.action.setTitle({
    title: "CiteStamp — " + count + " watched paper" + (count === 1 ? "" : "s") + " changed since you added " + (count === 1 ? "it" : "them"),
  });
}

function clearMonitorBadge() {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "CiteStamp — citation record for this page" });
}

// Merge a re-check's changed[] into the persisted unseen-changes marker, deduped
// by DOI, and reflect the total on the badge. Kept entirely in chrome.storage.
function recordChanged(changed) {
  return chrome.storage.local.get(WL_CHANGED_KEY).then(function (o) {
    var prev = (o && o[WL_CHANGED_KEY] && o[WL_CHANGED_KEY].items) || [];
    var byDoi = {};
    var merged = [];
    var i, e, entry;
    for (i = 0; i < prev.length; i++) {
      if (prev[i] && prev[i].doi && !byDoi[prev[i].doi]) {
        byDoi[prev[i].doi] = 1;
        merged.push(prev[i]);
      }
    }
    for (i = 0; i < (changed || []).length; i++) {
      e = changed[i] || {};
      var doi = e.doi || (e.item && e.item.citedDoi);
      if (!doi) continue;
      entry = {
        doi: doi,
        citedDoi: (e.item && e.item.citedDoi) || doi,
        title: (e.item && e.item.title) || null,
        status: (e.item && e.item.lastStatus) || "changed",
        at: new Date().toISOString(),
      };
      if (byDoi[doi]) {
        for (var j = 0; j < merged.length; j++) {
          if (merged[j].doi === doi) merged[j] = entry;
        }
      } else {
        byDoi[doi] = 1;
        merged.push(entry);
      }
    }
    var rec = {};
    rec[WL_CHANGED_KEY] = { items: merged, updatedAt: new Date().toISOString() };
    return chrome.storage.local.set(rec).then(function () {
      setMonitorBadge(merged.length);
      return merged;
    });
  });
}

// The daily unattended re-check. Pro token present -> one delta-blob fetch +
// local intersection (syncPro; credentials:false so the request carries no
// cookies). The token here is the FULL Pro API token -- a leak grants the whole
// Pro surface, not just the blob; it lives in extension storage, which page
// script on citestamp.com cannot read. No token -> throttled client-direct
// per-DOI re-check (recheckAll), skipping items checked under 24h.
// Both paths surface the same events: the blob is a batching shortcut, never a
// capability free users lack.
function runMonitor() {
  return wlSerial(doRunMonitor);
}

function doRunMonitor() {
  var wl = watchlistApi();
  if (!wl) return Promise.resolve({ ran: false });
  return wl.count().then(function (n) {
    if (!n) {
      clearMonitorBadge();
      return { ran: false, empty: true };
    }
    return chrome.storage.local.get(WL_TOKEN_KEY).then(function (o) {
      var token = (o && o[WL_TOKEN_KEY]) || null;
      var opts = {
        checker: self.CiteStampCheck || null,
        site: WL_SITE,
        mailto: WL_MAILTO,
        concurrency: 3,
        maxAgeHours: 24,
      };
      var run;
      if (token) {
        opts.token = token;
        opts.credentials = false;
        run = wl.syncPro(opts);
      } else {
        run = wl.recheckAll(opts);
      }
      return run
        .then(function (res) {
          var changed = (res && res.changed) || [];
          return recordChanged(changed).then(function () {
            return { ran: true, mode: res && res.mode, changed: changed.length };
          });
        })
        .catch(function () {
          return { ran: false, error: true };
        });
    });
  });
}

// Auto-enrol a reference the user cited, from the Overleaf continuous checker.
// The content script sends a PROJECTION of the checker verdict -- never the raw
// reference, which carries the user's own BibTeX source text.
//
// A key already on the watchlist is left ALONE, deliberately. addTo() upserts and
// recomputes lastStatus from the incoming verdict while preserving the previous
// publisherEvent. So re-adding a paper whose Crossref record momentarily lacks its
// retraction relation would leave publisherEvent set but reset lastStatus to "ok"
// -- silently clearing a retraction flag in the popup. The daily monitor owns
// freshness; enrolment only ever adds.
function addWatched(verdict, manual) {
  var wl = watchlistApi();
  if (!wl) return Promise.resolve({ ok: false, reason: "no-core" });
  return wlSerial(function () {
    return wl
      .load()
      .then(function (state) {
        var key = wl.keyFor(verdict);
        if (!key) return { ok: false, reason: "no-doi" };
        var total = 0;
        for (var k in state.items) {
          if (Object.prototype.hasOwnProperty.call(state.items, k)) total++;
        }
        if (state.items[key]) return { ok: true, added: false, known: true, total: total };
        // The cap bounds AUTOMATIC enrolment only. A paper the user asked for by
        // hand is never refused.
        if (!manual && total >= WL_AUTO_MAX) {
          return { ok: true, added: false, capped: true, total: total };
        }
        var r = wl.addTo(state, verdict);
        if (!r.item) return { ok: false, reason: "no-doi" };
        return wl.save(state).then(function () {
          return { ok: true, added: true, total: total + 1 };
        });
      })
      .catch(function () {
        return { ok: false, reason: "error" };
      });
  });
}

function removeWatched(doi) {
  var wl = watchlistApi();
  if (!wl || !doi) return Promise.resolve({ ok: false });
  return wlSerial(function () {
    return wl.remove(doi).then(
      function () { return { ok: true }; },
      function () { return { ok: false }; }
    );
  });
}

function clearWatched() {
  var wl = watchlistApi();
  if (!wl) return Promise.resolve({ ok: false });
  return wlSerial(function () {
    return wl.clear().then(
      function () {
        return chrome.storage.local.remove(WL_CHANGED_KEY).then(function () {
          clearMonitorBadge();
          return { ok: true };
        });
      },
      function () { return { ok: false }; }
    );
  });
}

function ensureAlarm() {
  chrome.alarms.get(WL_ALARM, function (a) {
    if (!a) {
      chrome.alarms.create(WL_ALARM, { delayInMinutes: 1, periodInMinutes: WL_PERIOD_MIN });
    }
  });
}

function graphUrl(doi) {
  return API_BASE + doi.split("/").map(encodeURIComponent).join("/");
}

async function fetchCounts(doi) {
  var key = "graph:" + doi;
  var got = await chrome.storage.session.get(key);
  var hit = got[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit;

  var entry = { ts: Date.now(), found: false, signed: 0, inferred: 0, truncated: false, title: null };
  try {
    var r = await fetch(graphUrl(doi));
    if (r.ok) {
      var g = await r.json();
      entry.found = true;
      entry.title = g.title || null;
      entry.truncated = !!g.truncated;
      for (var i = 0; i < g.edges.length; i++) {
        if (g.edges[i].tier === "asserted") entry.signed++;
        else entry.inferred++;
      }
    }
  } catch (e) {
    // network failure: leave entry as not-found, cache briefly anyway
  }
  var put = {};
  put[key] = entry;
  await chrome.storage.session.set(put);
  return entry;
}

async function onDoi(doi, tabId) {
  var put = {};
  put["tab:" + tabId] = { doi: doi };
  await chrome.storage.session.set(put);

  if (!doi) {
    chrome.action.setBadgeText({ tabId: tabId, text: "" });
    return;
  }
  var c = await fetchCounts(doi);
  var total = c.signed + c.inferred;
  var text = !c.found ? "0" : total > 99 || c.truncated ? "99+" : String(total);
  chrome.action.setBadgeBackgroundColor({
    tabId: tabId,
    color: c.found && total > 0 ? "#9c6e1f" : "#5d6675",
  });
  chrome.action.setBadgeText({ tabId: tabId, text: text });
  chrome.action.setTitle({
    tabId: tabId,
    title: c.found
      ? "CiteStamp — " + total + " recorded claims (" + c.signed + " signed)"
      : "CiteStamp — detected " + doi + ", not in the graph yet",
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (msg && msg.type === "cs-doi" && sender.tab && sender.tab.id >= 0) {
    onDoi(msg.doi || null, sender.tab.id);
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.storage.session.remove("tab:" + tabId);
});

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === "loading") {
    chrome.storage.session.remove("tab:" + tabId);
    chrome.action.setBadgeText({ tabId: tabId, text: "" });
  }
});

// ---- watchlist monitor wiring ---------------------------------------------

// Register the daily alarm on install/startup. onStartup also kicks one
// re-check; recheckAll's 24h skip keeps it cheap (a no-op if just checked).
chrome.runtime.onInstalled.addListener(function () {
  ensureAlarm();
  runMonitor();
});
chrome.runtime.onStartup.addListener(function () {
  ensureAlarm();
  runMonitor();
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === WL_ALARM) {
    runMonitor();
  }
});

// Popup-driven controls. Separate listener from the cs-doi one; returns true to
// keep the message channel open for the async sendResponse.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === "cs-wl-recheck") {
    ensureAlarm();
    runMonitor().then(function (r) {
      sendResponse({ ok: true, result: r });
    });
    return true;
  }
  if (msg.type === "cs-wl-add") {
    addWatched(msg.verdict, !!msg.manual).then(function (r) {
      sendResponse(r);
    });
    return true;
  }
  if (msg.type === "cs-wl-remove") {
    removeWatched(msg.doi).then(function (r) { sendResponse(r); });
    return true;
  }
  if (msg.type === "cs-wl-clear") {
    clearWatched().then(function (r) { sendResponse(r); });
    return true;
  }
  if (msg.type === "cs-wl-seen") {
    // User viewed the changes in the popup — clear the unseen marker + badge.
    chrome.storage.local.remove(WL_CHANGED_KEY).then(function () {
      clearMonitorBadge();
      sendResponse({ ok: true });
    });
    return true;
  }
});
