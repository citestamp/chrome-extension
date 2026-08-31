// CiteStamp popup — renders the current paper's public citation record,
// tier-split: signed (human, named) and inferred (machine sweep) are never
// blended, same firewall as the site.
//
// All DOM is built with createElement/textContent — titles and ids come
// from a public API and are treated as untrusted text, never markup.

var SITE = "https://citestamp.com";
var API_BASE = "https://api.citestamp.com/api/v1/graph/";
var DOI_PREFIX = "https://doi.org/";
var MAILTO = "info@citestamp.com";
var MAX_ROWS_PER_TIER = 10;
var WL_TOKEN_KEY = "citestamp.delta.token";
var PLAN_KEY = "citestamp.plan.v1";           // the bridge's entitlement cache
var API_ORIGIN = "https://api.citestamp.com"; // entitlement base for probe()

// The DOI/title of the paper this popup is looking at, for "Watch this paper".
var currentDoi = null;
var currentTitle = null;

// Statuses that stand as a publisher-event flag on a watched item (never "ok"
// or "unchecked"). Copy stays inside the shipped taxonomy — publisher events
// stated AS publisher events.
var FLAGGED = {
  "marked-retracted": "marked retracted by the publisher (best-effort)",
  "withdrawn": "withdrawn",
  "removed": "removed",
  "partially-retracted": "partially retracted",
  "expression-of-concern": "expression of concern",
  "doi-title-mismatch": "DOI / title mismatch",
  "does-not-resolve": "no longer resolves",
};

var WL_AUTO_KEY = "citestamp.watch.auto.v1"; // enrol papers cited in Overleaf

function $(id) { return document.getElementById(id); }

function graphUrl(doi) {
  return API_BASE + doi.split("/").map(encodeURIComponent).join("/");
}

// Mirrors the site's paperPath(): DOIs keep their slashes path-style,
// anything else is one encoded segment.
function paperPath(id) {
  if (id.indexOf(DOI_PREFIX) === 0) {
    return "/paper/" + id.slice(DOI_PREFIX.length).split("/").map(encodeURIComponent).join("/");
  }
  return "/paper/" + encodeURIComponent(id);
}

function shortId(id) {
  return id.indexOf(DOI_PREFIX) === 0 ? id.slice(DOI_PREFIX.length) : id;
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function link(href, text) {
  var a = el("a", null, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function renderEdges(container, data, edges, cls, label) {
  var titles = {};
  for (var i = 0; i < data.nodes.length; i++) {
    titles[data.nodes[i].id] = data.nodes[i].title;
  }
  if (!edges.length) return;

  container.appendChild(el("div", "tierhead " + cls, label + " · " + edges.length));

  var shown = edges.slice(0, MAX_ROWS_PER_TIER);
  for (var j = 0; j < shown.length; j++) {
    var e = shown[j];
    var outgoing = e.subject === data.id;
    var otherId = outgoing ? e.object : e.subject;
    var row = el("div", "edge " + cls);

    var pred = el("span", "pred");
    if (cls === "typed") {
      // FORRT rows read as replication outcomes, not raw predicates.
      var outcome = e.predicate === "refutes" ? "failed" : "successful";
      if (outgoing) {
        pred.appendChild(el("span", "dir", "this paper reports a "));
        pred.appendChild(document.createTextNode(outcome + " replication"));
        pred.appendChild(el("span", "dir", " of"));
      } else {
        pred.appendChild(document.createTextNode(outcome + " replication"));
        pred.appendChild(el("span", "dir", " of this paper, reported by"));
      }
    } else {
      pred.appendChild(el("span", "dir", outgoing ? "this paper " : "is the target of "));
      pred.appendChild(document.createTextNode(e.predicate.replace(/_/g, " ")));
      if (!outgoing) pred.appendChild(el("span", "dir", " from"));
    }
    row.appendChild(pred);

    row.appendChild(el("span", "other", titles[otherId] || shortId(otherId)));
    if (cls === "signed" && e.attribution) {
      row.appendChild(el("span", "attr", "signed: " + e.attribution));
    }
    if (cls === "typed") {
      row.appendChild(el("span", "attr", "coded by: forrt-fred (FORRT Replication Database) · inferred tier"));
    }
    container.appendChild(row);
  }
  if (edges.length > shown.length) {
    container.appendChild(el("div", "more", "+ " + (edges.length - shown.length) + " more on the paper page"));
  }
}

// canonicalId is the API's resolved data.id (not the page-detected DOI), so
// the paper/graph/claim links follow redirects/aliases — a claim link to the
// wrong identifier is the worst failure here.
function renderLinks(canonicalId, found) {
  var plinks = $("plinks");
  plinks.textContent = "";
  if (found) {
    plinks.appendChild(link(SITE + paperPath(canonicalId), "paper page"));
    plinks.appendChild(link(SITE + "/graph?paper=" + encodeURIComponent(canonicalId), "graph view"));
    plinks.appendChild(link(SITE + "/claim?paper=" + encodeURIComponent(canonicalId), "claim with ORCID"));
  } else {
    plinks.appendChild(link(SITE + "/", "ask the graph"));
    plinks.appendChild(link(SITE + "/for-researchers", "get your work on the record"));
  }
}

async function render(doi) {
  $("nodoi").hidden = true;
  $("result").hidden = false;
  $("status").textContent = "fetching the public record…";
  setCurrentPaper(doi, null);

  var r = null;
  try {
    r = await fetch(graphUrl(doi));
  } catch (e) {
    $("status").textContent = "could not reach api.citestamp.com";
    return;
  }

  $("pid").textContent = doi;
  var chips = $("chips");
  chips.textContent = "";
  var edgesBox = $("edges");
  edgesBox.textContent = "";

  if (r.status === 404) {
    $("status").textContent = "";
    $("ptitle").textContent = "Not in the graph yet";
    chips.appendChild(el("span", "chip", "no recorded claims for this identifier"));
    renderLinks(DOI_PREFIX + doi, false);
    return;
  }
  if (!r.ok) {
    $("status").textContent = "service answered " + r.status + " — try again shortly";
    return;
  }

  var data = await r.json();
  setCurrentPaper(doi, data.title || null);
  var signed = data.edges.filter(function (e) { return e.tier === "asserted"; }).length;
  var inferred = data.edges.length - signed;

  $("status").textContent = "";
  var heading = data.title || shortId(data.id);
  $("ptitle").textContent = heading;
  // when the title falls back to the identifier, showing it twice reads broken
  $("pid").textContent = heading === shortId(data.id) ? "" : shortId(data.id);

  var signedEdges = data.edges.filter(function (e) { return e.tier === "asserted"; });
  var typedEdges = data.edges.filter(function (e) { return e.tier === "inferred" && e.attribution === "forrt-fred"; });
  var plainInferred = data.edges.filter(function (e) { return e.tier === "inferred" && e.attribution !== "forrt-fred"; });

  chips.appendChild(el("span", "chip signed", signed + " signed"));
  chips.appendChild(el("span", "chip inferred", inferred + " machine-inferred"));
  var fredFailed = typedEdges.filter(function (e) { return e.predicate === "refutes"; }).length;
  var fredOk = typedEdges.filter(function (e) { return e.predicate === "supports"; }).length;
  if (fredFailed) chips.appendChild(el("span", "chip typed", fredFailed + " failed replication" + (fredFailed === 1 ? "" : "s") + " (FORRT)"));
  if (fredOk) chips.appendChild(el("span", "chip typed", fredOk + " successful replication" + (fredOk === 1 ? "" : "s") + " (FORRT)"));
  if (data.truncated) chips.appendChild(el("span", "chip", "showing first 100"));

  renderEdges(edgesBox, data, signedEdges, "signed", "signed — a named researcher stands behind these");
  renderEdges(edgesBox, data, typedEdges, "typed", "replication outcomes — coded by the forrt replication database, inferred tier");
  renderEdges(edgesBox, data, plainInferred, "inferred", "inferred — machine sweeps, labelled as such");
  renderLinks(data.id || (DOI_PREFIX + doi), true);
}

async function scanActiveTab(tab) {
  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/detect.js"],
    });
    return (results && results[0] && results[0].result) || null;
  } catch (e) {
    return null;
  }
}

async function main() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs[0];
  if (!tab) {
    $("status").textContent = "no active tab";
    return;
  }

  var key = "tab:" + tab.id;
  var got = await chrome.storage.session.get(key);
  var state = got[key];

  if (state && state.doi) {
    render(state.doi);
    return;
  }

  $("status").textContent = "";
  $("nodoi").hidden = false;
  $("scan").addEventListener("click", async function () {
    $("status").textContent = "scanning…";
    var doi = await scanActiveTab(tab);
    if (doi) {
      render(doi);
    } else {
      $("status").textContent = "no DOI found on this page";
    }
  });

  // On match-list hosts the content script may still be mid-run on a slow
  // page; one delayed re-check covers it without polling.
  setTimeout(async function () {
    var again = await chrome.storage.session.get(key);
    if (again[key] && again[key].doi && $("result").hidden) {
      render(again[key].doi);
    }
  }, 600);
}

// ---- watchlist ------------------------------------------------------------
// Reuses the vendored core (window.CiteStampWatchlist) with a chrome.storage
// .local adapter, so the popup and the background service worker share exactly
// one watchlist under the same key. Nothing here ever leaves this browser.

var wlStorage = {
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

function wlApi() {
  if (!window.CiteStampWatchlist) return null;
  return window.CiteStampWatchlist.configure({
    storage: wlStorage,
    site: SITE,
    mailto: MAILTO,
  });
}

function setCurrentPaper(doi, title) {
  currentDoi = doi || null;
  if (title) currentTitle = title;
  refreshWatchButton();
}

function refreshWatchButton() {
  var btn = $("wl-add");
  if (!btn) return;
  btn.hidden = !(currentDoi && window.CiteStampWatchlist);
}

function statusLabel(status) {
  return FLAGGED[status] || status || "changed";
}

async function renderWatchlist() {
  var wl = wlApi();
  var section = $("watchlist");
  if (!wl || !section) return;
  section.hidden = false;

  var items = await wl.list();
  var flaggedCount = items.filter(function (it) { return FLAGGED[it.lastStatus]; }).length;
  $("wl-count").textContent = items.length
    ? "watching " + items.length + " paper" + (items.length === 1 ? "" : "s") +
      (flaggedCount ? " · " + flaggedCount + " flagged" : "")
    : "";
  $("wl-empty").hidden = items.length > 0;

  // ONE list. There used to be a separate "changed since you added it" box above
  // this one, which meant every flagged paper rendered twice, adjacently. Flagged
  // papers sort to the top instead; each row already carries its own status.
  items.sort(function (a, b) {
    var fa = FLAGGED[a.lastStatus] ? 0 : 1;
    var fb = FLAGGED[b.lastStatus] ? 0 : 1;
    if (fa !== fb) { return fa - fb; }
    return String(b.addedAt || "").localeCompare(String(a.addedAt || ""));
  });

  var all = $("wl-all");
  all.textContent = "";
  for (var a = 0; a < items.length; a++) {
    all.appendChild(watchRow(items[a]));
  }
  $("wl-clear").hidden = items.length === 0;

  // The "mark seen" affordance only matters while an unseen badge is pending.
  var changedMarker = await wlStorage.get("citestamp.watchlist.changed.v1");
  var hasUnseen = false;
  if (changedMarker) {
    try {
      var parsed = JSON.parse(changedMarker);
      hasUnseen = !!(parsed && parsed.items && parsed.items.length);
    } catch (e) { hasUnseen = false; }
  }
  $("wl-seen").hidden = !hasUnseen;
}

function watchRow(it) {
  var flagged = !!FLAGGED[it.lastStatus];
  var row = el("div", "wl-item " + (flagged ? "is-flagged" : "is-ok"));
  var body = el("div", "wl-item-body");
  body.appendChild(el("div", "wl-item-title", it.title || it.citedDoi || it.doi));
  var meta = el("div", "wl-item-meta");
  // A non-flagged item is simply being watched. Never invent a verdict for it.
  meta.appendChild(el("span", flagged ? "wl-status" : "wl-status-ok", flagged ? statusLabel(it.lastStatus) : "watching"));
  meta.appendChild(document.createTextNode(" · " + (it.citedDoi || it.doi)));
  body.appendChild(meta);
  // Who the retraction record came from, when Crossref told us. Wording comes
  // from the vendored engine so it matches every other surface exactly.
  var prov = (window.CiteStampCheck && window.CiteStampCheck.provenanceLine)
    ? window.CiteStampCheck.provenanceLine(it.publisherEvent) : "";
  if (prov) { body.appendChild(el("div", "wl-item-prov", prov)); }
  row.appendChild(body);

  var rm = el("button", "wl-remove", "\u00d7");
  rm.type = "button";
  rm.title = "Remove from watchlist";
  rm.setAttribute("aria-label", "Remove " + (it.title || it.doi) + " from watchlist");
  rm.addEventListener("click", async function () {
    rm.disabled = true;
    await bgMessage({ type: "cs-wl-remove", doi: it.doi });
    await renderWatchlist();
  });
  row.appendChild(rm);
  return row;
}

async function watchCurrentPaper() {
  var wl = wlApi();
  if (!wl || !currentDoi) return;
  var btn = $("wl-add");
  btn.disabled = true;
  btn.textContent = "checking…";
  var ref = { doi: currentDoi, title: currentTitle || null };
  var verdict = null;
  try {
    if (window.CiteStampCheck && window.CiteStampCheck.checkOne) {
      verdict = await window.CiteStampCheck.checkOne(ref, {
        noGraph: true, site: SITE, mailto: MAILTO,
      });
    }
  } catch (e) {
    verdict = null;
  }
  // Fall back to a minimal verdict so the DOI is still watched; keyFor reads
  // ref.doi when work is null.
  if (!verdict) verdict = { ref: ref, doi: currentDoi, title: currentTitle || null, resolved: false, retracted: "unknown" };
  // The service worker is the only writer of the watchlist: a direct wl.add()
  // here would race the daily alarm's read-modify-write and lose an item.
  // manual:true so a paper the user asked for is never refused by the auto cap.
  await bgMessage({ type: "cs-wl-add", verdict: verdict, manual: true });
  btn.textContent = "Watching";
  await renderWatchlist();
  setTimeout(function () {
    btn.disabled = false;
    btn.textContent = "Watch this paper";
  }, 1200);
}

function bgMessage(msg) {
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
}

function setKeyStatus(msg) {
  var s = $("wl-token-status");
  if (s) s.textContent = msg || "";
}

function initWatchlist() {
  if (!wlApi()) return; // vendored core missing — leave the section hidden
  refreshWatchButton();

  $("wl-add").addEventListener("click", watchCurrentPaper);

  $("wl-recheck").addEventListener("click", async function () {
    var b = $("wl-recheck");
    b.textContent = "re-checking…";
    b.disabled = true;
    await bgMessage({ type: "cs-wl-recheck" });
    await renderWatchlist();
    b.textContent = "Re-check now";
    b.disabled = false;
  });

  $("wl-seen").addEventListener("click", async function () {
    await bgMessage({ type: "cs-wl-seen" });
    await renderWatchlist();
  });

  $("wl-clear").addEventListener("click", async function () {
    var n = await wl.count();
    if (!confirm("Remove all " + n + " papers from your watchlist? This cannot be undone.")) return;
    await bgMessage({ type: "cs-wl-clear" });
    await renderWatchlist();
  });

  // Default ON: a missing key means the user has never touched it. The Overleaf
  // content script reads this key itself and reacts to the change.
  wlStorage.get(WL_AUTO_KEY).then(function (v) {
    $("wl-auto").checked = (v === null || v === undefined) ? true : !!v;
  });
  $("wl-auto").addEventListener("change", function () {
    wlStorage.set(WL_AUTO_KEY, $("wl-auto").checked);
  });

  $("wl-optstoggle").addEventListener("click", function () {
    var box = $("wl-optbox");
    box.hidden = !box.hidden;
    if (!box.hidden) {
      setKeyStatus("");
      wlStorage.get(WL_TOKEN_KEY).then(function (t) {
        if (t) $("wl-token").value = t;
      });
    }
  });

  // Validate a pasted key on its PLAN, never on the HTTP status: the server 200s
  // with plan:"free" for a token it does not recognise, it does not 401. probe()
  // returns "pro" | "free" | null (null = it could not be reached, NOT a bad key).
  // The token is stored under the SAME key the Overleaf content script and the
  // daily monitor read — this is the one token affordance in the extension.
  $("wl-token-save").addEventListener("click", async function () {
    var val = $("wl-token").value.trim();
    if (!val) {
      await chrome.storage.local.remove(WL_TOKEN_KEY);
      await chrome.storage.local.remove(PLAN_KEY); // drop the cached plan too
      setKeyStatus("Key removed.");
      return;
    }
    setKeyStatus("checking…");
    var plan = null;
    try {
      if (window.CiteStampEntitlement) {
        plan = await window.CiteStampEntitlement.probe({ base: API_ORIGIN, token: val });
      }
    } catch (e) { plan = null; }
    if (plan === "free") {
      setKeyStatus("That key is not a Pro key.");
      return; // do not save a key the server does not answer as Pro
    }
    await wlStorage.set(WL_TOKEN_KEY, val);
    setKeyStatus(plan === "pro"
      ? "Pro key active."
      : "Saved — could not reach CiteStamp to check it just now.");
  });

  renderWatchlist();
}

main();
initWatchlist();
