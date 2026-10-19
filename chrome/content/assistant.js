// CiteStamp — references in an AI assistant's answer (claude.ai, Gemini).
//
// ON DEMAND ONLY. This file is not a declared content script: the popup
// injects it, after vendor/check-v1.js, with chrome.scripting.executeScript
// when the user clicks "Check references on this page". That click is what
// grants access to the tab (activeTab), so the extension asks for no new
// permission and no new host. Nothing runs on these sites until the user asks.
//
// What it does, in order:
//   1. Reads the page in this browser and finds the lines that ARE references:
//      a DOI, an arXiv id, or a title the engine can isolate
//      (CiteStampCheck.referenceFromText), plus doi.org / arxiv.org links
//      (referenceFromLink). Prose is never sent to a search: a line with none
//      of those is not a reference.
//   2. Checks each one with the vendored engine in REGISTRY MODE: Crossref,
//      DataCite and doi.org, never OpenAlex. That first, user-asked check also
//      looks a resolving DOI up in CiteStamp's public graph, for recorded
//      refutations and replication outcomes: the DOI alone, never the text.
//   3. Keeps watching the tab. When a new answer finishes, the references in
//      it are checked the same way with noGraph:true, so the automatic path
//      never reaches a CiteStamp server. The observer is bounded: its callback
//      only arms a timer, a scan runs after the page has been quiet for a
//      while, a reference is checked only once its line reads the same in two
//      scans in a row (so a line still streaming is not looked up; one scan
//      after the marker clears where the page marks its streaming answer, as
//      claude.ai does), and a session checks at most AUTO_MAX references
//      before it pauses.
//
// Verdicts are the engine's, in check_reference's four words: found, confirm,
// not found, couldn't check. A hard negative needs a DOI that doi.org says no
// agency registered; a title-only miss is "couldn't check".
//
// ISOLATED WORLD. Every node is built with createElement/textContent inside a
// closed shadow root: page text is untrusted, and the page's own CSS cannot
// reach the panel.
//
// Privacy: https://citestamp.com/privacy

(function () {
  "use strict";
  if (window.__csAssistant) {
    window.__csAssistant.checkAll();
    return "rechecked";
  }

  var C = window.CiteStampCheck;
  if (!C || !C.referenceFromText) { return "engine-missing"; }

  var SITE = "https://citestamp.com";
  var MAILTO = "info@citestamp.com";
  var MAX_REFS = 40;          // one user-asked check
  var AUTO_MAX = 100;         // automatic checks per tab session
  var QUIET_MS = 2500;        // the page must be this still before a scan
  var MIN_GAP_MS = 4000;      // and scans are at least this far apart
  var CONCURRENCY = 2;       // Crossref allows 3 at once; the engine gates its searches
  var MAX_BLOCKS = 3000;      // elements read per scan
  var MAX_BLOCK_TEXT = 6000;

  var GREEN = "#7fa86b";
  var SEAL = "#d6a23f";
  var RED = "#c4604b";
  var DIM = "#a89c83";

  // ---- finding references ----------------------------------------------------

  var BLOCKS = "li, p, td, dd, blockquote";
  var SKIP = "[contenteditable=''], [contenteditable='true'], textarea, input, pre, code, nav, header, footer, form, [role='textbox'], [role='navigation']";

  function normT(t) {
    return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function keyOf(ref) {
    if (ref.doi) { return "doi:" + ref.doi.toLowerCase(); }
    return "t:" + normT(ref.title);
  }

  function visible(el) {
    return el.getClientRects().length > 0;
  }

  // Every reference on the page, in document order, deduplicated.
  function findReferences() {
    var root = document.querySelector("main") || document.body;
    var out = [];
    var byKey = {};
    function add(ref, el) {
      var k = keyOf(ref);
      if (k === "t:" || k === "doi:") { return; }
      var had = byKey[k];
      if (had) {
        // the same DOI seen again: a bare link adds nothing, a cited title
        // fills in a bare one, and a DIFFERENT cited title on the same DOI is
        // its own reference (the DOI-title cross-check must read each)
        if (!ref.title) { return; }
        if (!had.ref.title) { had.ref = ref; return; }
        if (normT(had.ref.title) === normT(ref.title)) { return; }
        k = k + "|t:" + normT(ref.title);
        if (byKey[k]) { return; }
      }
      byKey[k] = { key: k, ref: ref, el: el };
      out.push(byKey[k]);
    }
    var blocks = root.querySelectorAll(BLOCKS);
    var n = Math.min(blocks.length, MAX_BLOCKS);
    for (var i = 0; i < n; i++) {
      var el = blocks[i];
      if (el.closest(SKIP) || !visible(el)) { continue; }
      // a list item holding its own paragraphs is read through them
      if (el.tagName === "LI" && el.querySelector("p, li")) { continue; }
      var text = (el.innerText || "").slice(0, MAX_BLOCK_TEXT);
      var lines = text.split("\n");
      var fromText = [];
      for (var j = 0; j < lines.length; j++) {
        var r = C.referenceFromText(lines[j]);
        if (r) { fromText.push(r); }
      }
      var links = el.querySelectorAll("a[href]");
      var fromLinks = [];
      for (var m = 0; m < links.length; m++) {
        var lr = C.referenceFromLink(links[m].getAttribute("href"), links[m].innerText || "");
        if (lr) { fromLinks.push(lr); }
      }
      // "Vaswani et al. (2017). Attention is all you need." with the arXiv
      // link on the title: one reference, the link supplying its identifier
      if (fromText.length === 1 && !fromText[0].doi && fromLinks.length === 1) {
        fromText[0].doi = fromLinks[0].doi;
        fromLinks = [];
      }
      for (var a = 0; a < fromText.length; a++) { add(fromText[a], el); }
      for (var b = 0; b < fromLinks.length; b++) { add(fromLinks[b], el); }
    }
    return out;
  }

  // Claude marks the answer it is still writing; elsewhere the quiet timer and
  // the two-scan rule stand in for it.
  function streaming() {
    return !!document.querySelector("[data-is-streaming='true']");
  }
  function hasStreamingMarker() {
    return !!document.querySelector("[data-is-streaming]");
  }

  // ---- the panel ---------------------------------------------------------------

  var host = document.createElement("div");
  host.setAttribute("data-citestamp", "assistant");
  var shadow = host.attachShadow({ mode: "closed" });
  var css = document.createElement("style");
  css.textContent = [
    ":host{all:initial}",
    ".box{position:fixed;z-index:2147483600;top:72px;right:16px;width:380px;max-width:calc(100vw - 32px);",
    "max-height:calc(100vh - 110px);overflow:auto;background:#211d15;color:#ece2cf;border:1px solid #3a3326;",
    "border-radius:10px;padding:12px 14px;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;",
    "box-shadow:0 8px 28px rgba(0,0,0,.45);overflow-wrap:anywhere;box-sizing:border-box}",
    ".box.min{width:auto;max-height:none;overflow:visible;padding:6px 10px;cursor:pointer}",
    ".box.min .body{display:none}",
    ".top{display:flex;align-items:center;gap:8px}",
    ".brand{color:" + SEAL + ";font-weight:600;flex:1}",
    ".ic{background:none;border:1px solid #3a3326;color:" + DIM + ";border-radius:6px;cursor:pointer;",
    "font:inherit;line-height:1;padding:3px 7px}",
    ".ic:hover{color:#ece2cf;border-color:" + DIM + "}",
    ".fine{color:" + DIM + ";font-size:11px;margin:6px 0}",
    ".sum{margin:8px 0 4px;font-size:12px}",
    ".row{padding:8px 0;border-top:1px solid #2c271d}",
    ".chip{display:inline-block;font-size:11px;font-weight:600;border-radius:4px;padding:1px 6px;margin-right:6px}",
    ".found{color:#16140f;background:" + GREEN + "}",
    ".confirm{color:#16140f;background:" + SEAL + "}",
    ".notfound{color:#16140f;background:" + RED + "}",
    ".cant{color:#ece2cf;background:#3a3326}",
    ".wait{color:" + DIM + ";background:#2c271d}",
    ".cited{font-size:12px}",
    ".why{font-size:11px;color:" + DIM + ";margin-top:3px}",
    ".work{font-size:11px;margin-top:3px}",
    ".flag{font-size:11px;color:" + RED + ";margin-top:3px}",
    "a{color:" + SEAL + "}",
    ".bar{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}",
    ".btn{background:none;border:1px solid " + SEAL + ";color:" + SEAL + ";border-radius:6px;cursor:pointer;",
    "font:inherit;font-size:12px;padding:4px 9px}",
    ".btn.quiet{border-color:#3a3326;color:" + DIM + "}"
  ].join("");
  shadow.appendChild(css);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }

  function link(href, text) {
    var a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  var box = el("div", "box");
  var top = el("div", "top");
  top.appendChild(el("span", "brand", "CiteStamp · references on this page"));
  var minBtn = el("button", "ic", "–");
  minBtn.type = "button";
  minBtn.title = "Minimise";
  var closeBtn = el("button", "ic", "×");
  closeBtn.type = "button";
  closeBtn.title = "Close and stop watching this tab";
  top.appendChild(minBtn);
  top.appendChild(closeBtn);
  box.appendChild(top);

  var body = el("div", "body");
  body.appendChild(el("div", "fine",
    "Checked from your browser against Crossref, DataCite and doi.org. Only each " +
    "reference's DOI or title leaves this page. When you ask for the check, a DOI " +
    "that resolves is also looked up in CiteStamp's public graph, for recorded " +
    "refutations. Nothing is stored."));
  var sum = el("div", "sum");
  body.appendChild(sum);
  var list = el("div");
  body.appendChild(list);
  var watchLine = el("div", "fine");
  body.appendChild(watchLine);
  var bar = el("div", "bar");
  var againBtn = el("button", "btn", "Check again");
  againBtn.type = "button";
  var watchBtn = el("button", "btn quiet", "Stop watching");
  watchBtn.type = "button";
  bar.appendChild(againBtn);
  bar.appendChild(watchBtn);
  body.appendChild(bar);
  var foot = el("div", "fine");
  foot.appendChild(link(SITE + "/check", "how the check works"));
  foot.appendChild(document.createTextNode(" · "));
  foot.appendChild(link(SITE + "/privacy", "privacy"));
  body.appendChild(foot);
  box.appendChild(body);
  shadow.appendChild(box);
  (document.body || document.documentElement).appendChild(host);

  // ---- verdicts, in check_reference's words --------------------------------------

  function verdictOf(v) {
    if (!v) { return "cant"; }
    if (!v.resolved) {
      return (v.status === "does-not-resolve") ? "notfound" : "cant";
    }
    return (v.weakMatch || v.titleMismatch) ? "confirm" : "found";
  }

  var CHIP = { found: "found", confirm: "confirm", notfound: "not found", cant: "couldn't check", wait: "checking" };

  var VIA = {
    "crossref-doi": "Crossref", "datacite-doi": "DataCite", "crossref-title": "Crossref",
    "datacite-title": "DataCite", "doi-registration": "doi.org"
  };

  function reasonOf(v, kind) {
    var notes = (v && v.notes) || [];
    if (kind === "found") {
      return "resolves to a real work" + (VIA[v.resolvedVia] ? " (" + VIA[v.resolvedVia] + ")" : "");
    }
    if (kind === "confirm") {
      if (v.titleMismatch) {
        return "the DOI resolves, but to a different title than the one cited; check which one is meant";
      }
      return notes.length ? notes.join("; ") : "weak match: confirm this is the work meant";
    }
    if (kind === "notfound") {
      return (notes.length ? notes.join("; ") : "not in the sources checked") +
        ". Not proof the work was never published.";
    }
    return notes.length ? notes.join("; ") : "a lookup source did not answer; try again";
  }

  function renderRow(item) {
    var row = item.row || el("div", "row");
    while (row.firstChild) { row.removeChild(row.firstChild); }
    var v = item.verdict;
    var kind = item.pending ? "wait" : verdictOf(v);
    var head = el("div", "cited");
    head.appendChild(el("span", "chip " + kind, CHIP[kind]));
    var cited = item.ref.raw || item.ref.title || item.ref.doi || "";
    head.appendChild(document.createTextNode(cited.length > 220 ? cited.slice(0, 217) + "..." : cited));
    row.appendChild(head);
    if (!item.pending) {
      row.appendChild(el("div", "why", reasonOf(v, kind)));
      var w = v && v.work;
      if (w && w.doi && kind !== "notfound") {
        var wl = el("div", "work");
        if (w.title) { wl.appendChild(document.createTextNode(w.title + (w.year ? " (" + w.year + ") " : " "))); }
        wl.appendChild(link("https://doi.org/" + w.doi, "doi.org/" + w.doi));
        row.appendChild(wl);
      }
      if (v && v.retracted === "marked") {
        row.appendChild(el("div", "flag", "marked retracted by the publisher (best-effort)"));
      } else if (v && v.publisherEvent && v.publisherEvent.type === "expression_of_concern") {
        row.appendChild(el("div", "flag", "expression of concern on the publisher's record (best-effort)"));
      }
      var prov = (v && C.provenanceLine) ? C.provenanceLine(v.publisherEvent) : "";
      if (prov) { row.appendChild(el("div", "why", prov)); }
      if (v && v.refutations > 0) {
        row.appendChild(el("div", "flag", v.refutations + (v.refutations === 1 ? " recorded refutation" : " recorded refutations") +
          " in CiteStamp's graph (signed)"));
      }
      if (v && v.fredFailed > 0) {
        row.appendChild(el("div", "flag", v.fredFailed + " failed replication" + (v.fredFailed === 1 ? "" : "s") +
          " recorded (FORRT Replication Database)"));
      }
      if (v && v.fredSuccessful > 0) {
        row.appendChild(el("div", "why", v.fredSuccessful + " successful replication" + (v.fredSuccessful === 1 ? "" : "s") +
          " recorded (FORRT Replication Database)"));
      }
      if (v && v.suggestion && v.suggestion.title && kind !== "found") {
        row.appendChild(el("div", "why", "closest match: " + v.suggestion.title +
          (v.suggestion.year ? " (" + v.suggestion.year + ")" : "") +
          (v.suggestion.doi ? ", doi.org/" + v.suggestion.doi : "")));
      }
    }
    item.row = row;
    return row;
  }

  function renderSummary() {
    var c = { found: 0, confirm: 0, notfound: 0, cant: 0 };
    var waiting = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].pending) { waiting++; continue; }
      c[verdictOf(items[i].verdict)]++;
    }
    if (!items.length) {
      sum.textContent = scanned
        ? "No references found on this page yet: a reference here is a line with a DOI, an arXiv id, or an author-year-title citation."
        : "Reading the page...";
      return;
    }
    sum.textContent = items.length + " reference" + (items.length === 1 ? "" : "s") + " · " +
      c.found + " found · " + c.confirm + " confirm · " + c.notfound + " not found · " +
      c.cant + " couldn't check" + (waiting ? " · checking " + waiting : "") +
      (lastChecked ? " · " + lastChecked : "");
  }

  function renderWatch() {
    if (!watching) {
      watchLine.textContent = "Not watching this tab. \"Check again\" re-reads the page.";
      watchBtn.textContent = "Watch new answers";
    } else if (autoCount >= AUTO_MAX) {
      watchLine.textContent = "Automatic checks paused after " + AUTO_MAX +
        " references this session. \"Check again\" checks the page now.";
      watchBtn.textContent = "Stop watching";
    } else {
      watchLine.textContent = "Watching this tab: references in new answers are checked when each " +
        "answer finishes, against the registries only (nothing goes to CiteStamp).";
      watchBtn.textContent = "Stop watching";
    }
  }

  // ---- checking ------------------------------------------------------------------

  var items = [];          // shown rows, page order
  var checkedKeys = {};    // key -> item, this conversation
  var seenOnce = {};       // auto path: key -> line text from the previous scan
  var scanned = false;
  var watching = true;
  var autoCount = 0;
  var lastChecked = "";
  var path = location.pathname;
  var queue = [];
  var active = 0;

  function stamp() {
    var d = new Date();
    lastChecked = "checked " + d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      (function (job) {
        active++;
        C.checkOne(job.item.ref, { registries: true, noGraph: job.auto, site: SITE, mailto: MAILTO })
          .then(function (v) { job.item.verdict = v; }, function () { job.item.verdict = null; })
          .then(function () {
            active--;
            job.item.pending = false;
            stamp();
            renderRow(job.item);
            renderSummary();
            pump();
          });
      })(queue.shift());
    }
  }

  function enqueue(found, auto) {
    var item = { key: found.key, ref: found.ref, pending: true, verdict: null, row: null };
    checkedKeys[found.key] = item;
    items.push(item);
    list.appendChild(renderRow(item));
    queue.push({ item: item, auto: auto });
    // a row from a new answer lands at the bottom: bring it into view inside
    // the panel (the panel scrolls, the page does not)
    if (auto) { box.scrollTop = box.scrollHeight; }
  }

  function resetIfNewConversation() {
    if (location.pathname === path) { return; }
    path = location.pathname;
    items = [];
    checkedKeys = {};
    seenOnce = {};
    queue = [];
    while (list.firstChild) { list.removeChild(list.firstChild); }
  }

  // The user asked: every reference on the page, with the graph lookup. An
  // answer still being written is waited for (up to a minute), so a half-
  // written line is not looked up.
  var waitedFor = 0;
  function checkAll() {
    box.className = "box";
    if (streaming() && waitedFor < 60) {
      waitedFor++;
      sum.textContent = "Waiting for the answer to finish...";
      setTimeout(checkAll, 1000);
      return;
    }
    waitedFor = 0;
    path = location.pathname;
    items = [];
    checkedKeys = {};
    seenOnce = {};
    queue = [];
    while (list.firstChild) { list.removeChild(list.firstChild); }
    var found = findReferences();
    scanned = true;
    for (var i = 0; i < found.length && i < MAX_REFS; i++) { enqueue(found[i], false); }
    if (found.length > MAX_REFS) {
      list.appendChild(el("div", "fine", (found.length - MAX_REFS) + " more references on this page were not checked (" +
        MAX_REFS + " per check)."));
    }
    renderSummary();
    renderWatch();
    pump();
    if (watching) { arm(); }
  }

  // The automatic path: only references not checked yet, never the graph, and
  // only once their line reads the same in two scans in a row. A page that
  // marks its streaming answer (arm() never scans while the marker says
  // streaming) needs one scan, not two.
  var lastScan = 0;
  function autoScan() {
    lastScan = Date.now();
    resetIfNewConversation();
    if (autoCount >= AUTO_MAX) { renderWatch(); return; }
    var found = findReferences();
    var marked = hasStreamingMarker();
    var next = {};
    var waitingForSecond = false;
    for (var i = 0; i < found.length; i++) {
      var f = found[i];
      if (checkedKeys[f.key]) { continue; }
      var line = f.ref.raw || "";
      if (marked || seenOnce[f.key] === line) {
        if (autoCount >= AUTO_MAX) { break; }
        autoCount++;
        enqueue(f, true);
      } else {
        next[f.key] = line;
        waitingForSecond = true;
      }
    }
    seenOnce = next;
    renderSummary();
    renderWatch();
    pump();
    // a reference seen once is confirmed by one more scan, even if the page
    // has gone quiet and no mutation will arrive to schedule it
    if (waitingForSecond) { arm(); }
  }

  // A page that never goes fully quiet (a ticking clock, an animation) would
  // starve the quiet timer, so a scan also runs once MAX_WAIT_MS has passed
  // since the first unscanned change. The two-scan rule still guards a line
  // that is mid-stream.
  var MAX_WAIT_MS = 15000;
  var timer = null;
  var dirtySince = 0;
  function arm() {
    if (!watching) { return; }
    if (!dirtySince) { dirtySince = Date.now(); }
    if (timer) { clearTimeout(timer); }
    var overdue = Date.now() - dirtySince >= MAX_WAIT_MS;
    timer = setTimeout(function () {
      timer = null;
      if (!watching) { return; }
      if (streaming()) { arm(); return; }
      var wait = MIN_GAP_MS - (Date.now() - lastScan);
      if (wait > 0) { timer = setTimeout(function () { timer = null; arm(); }, wait); return; }
      dirtySince = 0;
      autoScan();
    }, overdue ? 0 : QUIET_MS);
  }

  // The callback does no work beyond re-arming the quiet timer. body, not
  // main: a single-page app can replace its main element between chats.
  var observer = new MutationObserver(function () { if (watching) { arm(); } });
  function observe() {
    observer.disconnect();
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  againBtn.addEventListener("click", function () { checkAll(); });
  watchBtn.addEventListener("click", function () {
    watching = !watching;
    if (watching) { observe(); arm(); } else { observer.disconnect(); if (timer) { clearTimeout(timer); timer = null; } }
    renderWatch();
  });
  minBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    box.className = "box min";
  });
  box.addEventListener("click", function () {
    if (box.className === "box min") { box.className = "box"; }
  });
  closeBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    watching = false;
    observer.disconnect();
    if (timer) { clearTimeout(timer); timer = null; }
    queue = [];
    if (host.parentNode) { host.parentNode.removeChild(host); }
    window.__csAssistant = null;
  });

  window.__csAssistant = {
    checkAll: function () {
      if (!host.parentNode) { (document.body || document.documentElement).appendChild(host); }
      watching = true;
      observe();
      checkAll();
    }
  };

  observe();
  checkAll();
  return "started";
})();
