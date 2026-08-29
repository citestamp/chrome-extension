// CiteStamp — Overleaf (CodeMirror 6).
//
// ISOLATED WORLD. This file used to be declared "world": "MAIN", for exactly one
// reason: it injected the hosted cores as remote <script src="https://citestamp.com/...">
// tags under Overleaf's strict-dynamic CSP. That is remotely-hosted code, which
// MV3 forbids and the Chrome Web Store rejects. The cores are now vendored into
// the package and loaded by the manifest, so the MAIN world buys nothing.
//
// Probed before the move, in a real Chromium with a real unpacked extension and a
// real CodeMirror 6 — none of this is assumed:
//   - execCommand("insertText") from the ISOLATED world updates CM6's state.doc,
//     not merely the DOM. The document model syncs.
//   - A capture-phase keydown listener here fires BEFORE CM6's own handler, and
//     stopPropagation() suppresses CM6's default (the cursor does not move).
//   - Cross-origin fetch to OpenAlex / Crossref / DataCite works from here with
//     no host_permissions (all three send Access-Control-Allow-Origin: *).
//   - A trusted paste event is observable here, and clipboardData carries the
//     COMPLETE pasted text — the only virtualization-immune way to read text the
//     user did not type.
//   - The synthetic InputEvent("beforeinput") fallback that used to live in
//     replace() never worked: CM6 sees isTrusted:false and ignores it. Removed.
//   - execCommand("copy") returns false from an ISOLATED content script without
//     the "clipboardWrite" permission. That permission is now declared, and it is
//     declared for this line alone.
//
// Two consequences worth stating. The Pro token now stays in this world and never
// touches the page — there is no page-world script left to leak it to, so the
// data-citestamp-plan attribute and its bridge are gone. And Overleaf's own
// scripts can no longer read our globals or forge our entitlement.
//
// Privacy: https://citestamp.com/privacy

(function () {
  "use strict";
  if (window.__csOverleaf) { return; }
  window.__csOverleaf = true;

  var SEAL = "#d6a23f";
  var DIM = "#a89c83";
  var RED = "#c4604b";
  var GREEN = "#7fa86b";
  var API_BASE = "https://api.citestamp.com";
  var TOKEN_KEY = "citestamp.delta.token"; // the one token, shared with the popup
  var PLAN_KEY = "citestamp.plan.v1";
  var AUTO_KEY = "citestamp.watch.auto.v1";      // enrol cited papers in the watchlist
  var WATCHLIST_KEY = "citestamp.watchlist.v1";  // read-only here; the worker owns writes

  var E = window.CiteStampEntitlement;
  var C = window.CiteStampContinuous;

  // ---- project id (manuscript key — local-only, never an identity) ---------
  function projectId() {
    var m = /\/project\/([a-zA-Z0-9]+)/.exec(location.pathname);
    return m ? m[1] : "overleaf";
  }

  // ---- chrome.storage.local, promise-shaped --------------------------------
  function storageGet(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (o) {
          void chrome.runtime.lastError;
          resolve(o && o[key] != null ? o[key] : null);
        });
      } catch (e) { resolve(null); }
    });
  }
  function storageSet(key, val) {
    return new Promise(function (resolve) {
      try {
        var o = {}; o[key] = val;
        chrome.storage.local.set(o, function () { void chrome.runtime.lastError; resolve(); });
      } catch (e) { resolve(); }
    });
  }
  function storageRemove(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.remove(key, function () { void chrome.runtime.lastError; resolve(); });
      } catch (e) { resolve(); }
    });
  }

  // ---- entitlement ---------------------------------------------------------
  // A client-side read, and nothing more. The page cannot forge it any more, but
  // a determined user can still edit their own extension storage — that is fine
  // and expected. Pro is server-enforced where it must be: the delta blob and the
  // API rate limit. Nothing here defends a byte. Default is free; we upgrade only
  // on an authoritative answer, and degrade to free on anything unexpected.
  var isPro = false;

  function coreFor(tok) {
    return E.create({
      fetchMe: function () { return E.httpFetchMe({ base: API_BASE, token: tok }); },
      cacheGet: function () { return storageGet(PLAN_KEY); },
      cacheSet: function (entry) { return storageSet(PLAN_KEY, entry); },
      cacheClear: function () { return storageRemove(PLAN_KEY); }
    });
  }

  // Default ON. A missing key means the user has never touched it.
  function loadAutoWatch() {
    return storageGet(AUTO_KEY).then(function (v) {
      autoWatch = (v === null || v === undefined) ? true : !!v;
      return autoWatch;
    }, function () { autoWatch = true; return true; });
  }

  function resolvePlan() {
    if (!E) { return Promise.resolve(false); }
    return storageGet(TOKEN_KEY).then(function (tok) {
      if (!tok) { return storageRemove(PLAN_KEY).then(function () { return false; }); }
      return coreFor(tok).plan().then(function (p) { return p === E.PRO; });
    }).catch(function () { return false; });
  }

  // Only the newest resolution may apply. Two resolvePlan() calls can be in
  // flight (boot, plus a storage change), and the slower one finishing last must
  // not overwrite the newer answer.
  var planSeq = 0;
  function refreshPlan() {
    var mine = ++planSeq;
    return resolvePlan().then(
      function (pro) { if (mine === planSeq) { applyPlan(pro); } },
      function () { if (mine === planSeq) { applyPlan(false); } }
    );
  }

  function applyPlan(pro) {
    var changed = (pro !== isPro);
    isPro = !!pro;
    if (engine) { engine.setEnabled(isPro); }
    if (changed) { scan(); }
    updateProNote();
    renderStrip();
  }

  // ---- CodeMirror 6 editor adapter ----------------------------------------
  function lineOf(node) {
    var n = node;
    while (n && n !== document.body) {
      if (n.nodeType === 1 && n.classList && n.classList.contains("cm-line")) { return n; }
      n = n.parentNode;
    }
    return null;
  }

  function domPointAt(line, idx) {
    var walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, null);
    var acc = 0, last = null, node = walker.nextNode();
    while (node) {
      last = node;
      var len = node.nodeValue.length;
      if (acc + len >= idx) { return { node: node, offset: idx - acc }; }
      acc += len;
      node = walker.nextNode();
    }
    if (last) { return { node: last, offset: last.nodeValue.length }; }
    return { node: line, offset: 0 };
  }

  function cm6Adapter(content) {
    return {
      node: content,
      // Beat CM6's own bubble-phase keydown handler so ArrowUp/Down/Enter drive
      // the picker, not the editor, while the panel is open. Verified: a capture
      // listener in this world runs first, and stopPropagation() stops CM6.
      capture: true,

      before: function () {
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) { return ""; }
        var r = sel.getRangeAt(0);
        if (!content.contains(r.endContainer)) { return ""; }
        var line = lineOf(r.endContainer);
        if (!line) { return ""; }
        var pre = document.createRange();
        pre.setStart(line, 0);
        pre.setEnd(r.endContainer, r.endOffset);
        return pre.toString();
      },

      replace: function (from, str) {
        var sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) { return; }
        var r = sel.getRangeAt(0);
        var line = lineOf(r.endContainer);
        if (!line) { return; }
        var startPt = domPointAt(line, from);
        var range = document.createRange();
        range.setStart(startPt.node, startPt.offset);
        range.setEnd(r.endContainer, r.endOffset);
        sel.removeAllRanges();
        sel.addRange(range);
        // execCommand("insertText") dispatches a TRUSTED beforeinput, which is the
        // only kind CM6 acts on, and the editor's document model syncs. A synthetic
        // InputEvent is ignored (isTrusted:false) — do not add one back as a
        // "fallback"; it would look like a safety net and catch nothing.
        var ok = false;
        try { ok = document.execCommand("insertText", false, str); } catch (e) { ok = false; }
        if (!ok) { toast("Could not insert into the editor — the citation was not written"); }
      },

      rect: function () {
        var sel = window.getSelection();
        if (sel && sel.rangeCount) {
          var rr = sel.getRangeAt(0).getBoundingClientRect();
          if (rr && (rr.top || rr.left || rr.width || rr.height)) { return rr; }
        }
        return content.getBoundingClientRect();
      },

      focus: function () { content.focus(); }
    };
  }

  // ---- BibTeX handoff ------------------------------------------------------
  // Direct .bib write needs Overleaf's internal file API and is a follow-up to
  // probe once a real session is available (Rule 14: probe before fix).
  function handBibtex(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("BibTeX entry copied — paste it into your .bib"); },
        function () { legacyCopy(text); }
      );
    } else {
      legacyCopy(text);
    }
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy"); // needs the clipboardWrite permission
      document.body.removeChild(ta);
      toast(ok ? "BibTeX entry copied — paste it into your .bib"
               : "Could not copy BibTeX automatically — open the picker to export");
    } catch (e) {
      toast("Could not copy BibTeX automatically — open the picker to export");
    }
  }

  // ---- toast ---------------------------------------------------------------
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      var s = toastEl.style;
      s.position = "fixed";
      s.zIndex = "2147483600";
      s.bottom = "18px";
      s.right = "18px";
      s.maxWidth = "320px";
      s.background = "#211d15";
      s.color = "#ece2cf";
      s.border = "1px solid " + SEAL;
      s.borderRadius = "8px";
      s.padding = "10px 14px";
      s.font = "13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      s.boxShadow = "0 8px 28px rgba(0,0,0,0.45)";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = "block";
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { if (toastEl) { toastEl.style.display = "none"; } }, 3200);
  }

  // ---- the @cite picker (Pro) ---------------------------------------------
  var attached = new Map(); // .cm-content -> detach()

  function onInsert(e) {
    var work = e.detail && e.detail.work;
    if (!work) { return; }
    handBibtex(window.CiteStampPicker.formatCitation(work, "bibtex"));
  }

  function wire(content) {
    if (attached.has(content)) { return; }
    var detach = window.CiteStampPicker.attach(null, {
      adapter: cm6Adapter(content),
      manuscript: projectId(),
      format: "latex",
      trigger: "@cite "
    });
    content.addEventListener("citestamp:insert", onInsert);
    attached.set(content, detach);
  }

  function prune() {
    attached.forEach(function (detach, content) {
      if (!document.contains(content)) {
        try { detach(); } catch (e) {}
        content.removeEventListener("citestamp:insert", onInsert);
        attached.delete(content);
      }
    });
  }

  function detachAll() {
    attached.forEach(function (detach, content) {
      try { detach(); } catch (e) {}
      content.removeEventListener("citestamp:insert", onInsert);
    });
    attached.clear();
  }

  // GATE: the picker writes citation text straight into the manuscript, so it is
  // a Pro action. The bibliography check below stays free and is wired separately.
  function scan() {
    if (!window.CiteStampPicker) { return; }
    if (!isPro) { detachAll(); return; }
    var nodes = document.querySelectorAll(".cm-editor .cm-content");
    for (var i = 0; i < nodes.length; i++) { wire(nodes[i]); }
    prune();
  }

  // ---- continuous checking (Pro) -------------------------------------------
  // The engine holds all the policy — debounce, dedupe, verdict cache, per-day
  // lookup budget, backoff. This file only feeds it the two things a content
  // script can honestly see: the line you just edited, and the text you pasted.
  var engine = null;
  var seenSevere = {};
  var autoWatch = true;   // default on; the popup can turn it off
  var watchTotal = 0;
  var watchCapped = false;

  // Enrol a reference the user cited in the bibliography watchlist, which is
  // re-checked daily against publisher retraction notices.
  //
  // THE WATCHLIST IS NOT A PRO FEATURE. Any user can add any paper by hand from
  // the popup and gets the same daily monitoring. What Pro buys is that citing a
  // paper enrols it, without being asked. Automation, not sight.
  //
  // The service worker performs the write. The watchlist is one JSON blob under
  // one key, so load->mutate->save is a read-modify-write; the worker is a single
  // instance and serialises every writer through one queue. Two Overleaf tabs
  // writing it directly would lose items.
  //
  // We send a PROJECTION of the verdict, never the verdict itself: ref.raw holds
  // up to 240 characters of the user's own BibTeX source, and the watchlist has no
  // use for it. `status` is omitted deliberately so addTo() derives monitorStatus()
  // -- the monitor's own vocabulary, which is what recheck() writes too.
  function watchProjection(v) {
    return {
      work: v.work ? { doi: v.work.doi, title: v.work.title || null } : null,
      ref: { doi: (v.ref && v.ref.doi) || null, title: (v.ref && v.ref.title) || null },
      resolved: !!v.resolved,
      retracted: v.retracted || "unknown",
      titleMismatch: !!v.titleMismatch,
      publisherEvent: v.publisherEvent || null
    };
  }

  // How many papers are on the watchlist. Read straight from storage rather than
  // taken from the worker's reply: an MV3 service worker can be torn down between
  // doing the write and answering, so the reply is lost often enough to matter --
  // measured. The write still lands. Reading also means the strip follows a
  // removal made in the popup, with no message at all. Reads need no
  // serialisation; only writes do, and only the worker writes.
  function refreshWatchCount() {
    return storageGet(WATCHLIST_KEY).then(function (raw) {
      var n = 0;
      try {
        var st = raw ? JSON.parse(raw) : null;
        if (st && st.items) { n = Object.keys(st.items).length; }
      } catch (e) { n = 0; }
      watchTotal = n;
      renderStrip();
    }, function () {});
  }

  function sendWatch(v) {
    if (!autoWatch) { return; }
    try {
      chrome.runtime.sendMessage({ type: "cs-wl-add", verdict: watchProjection(v) }, function (r) {
        void chrome.runtime.lastError;
        // The reply is advisory. It is the only way to learn we hit the cap, but
        // the count comes from storage, which cannot be lost.
        if (r && r.ok) { watchCapped = !!r.capped; }
        renderStrip();
      });
    } catch (e) {}
  }

  function makeEngine() {
    if (!C || !window.CiteStampCheck) { return null; }
    return C.createEngine({
      checker: window.CiteStampCheck,
      project: projectId(),
      storage: { get: storageGet, set: storageSet },
      onChange: onEngineChange,
      onWatch: sendWatch
    });
  }

  function onEngineChange(sum) {
    renderStrip(sum);
    for (var i = 0; i < sum.severe.length; i++) {
      var p = sum.severe[i];
      // Keyed on id AND status: the same reference going from "does not resolve"
      // to "marked retracted" is a new thing to interrupt someone for.
      var seenKey = p.id + ":" + p.status;
      if (seenSevere[seenKey]) { continue; }
      seenSevere[seenKey] = 1;
      // Something new is wrong: un-hide the strip the user dismissed earlier.
      stripDismissed = false;
      if (stripEl) { stripEl.style.display = "block"; }
      toast(shortLabel(p) + " — " + problemText(p));
    }
  }

  function shortLabel(p) {
    if (p.key) { return "[" + p.key + "]"; }
    var t = p.title || p.doi || "reference";
    return t.length > 40 ? t.slice(0, 39) + "…" : t;
  }

  // The edited line, read from the caret. CM6 virtualizes lines, so this is the
  // only text we can see reliably — and it is precisely the text the user just
  // touched, which is all a continuous checker should react to anyway.
  function currentLineText() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return null; }
    var line = lineOf(sel.getRangeAt(0).endContainer);
    return line ? line.textContent : null;
  }

  function inEditor(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    return !!(el && el.closest && el.closest(".cm-editor .cm-content"));
  }

  function wireContinuous() {
    // input bubbles from the contenteditable; capture so Overleaf cannot stop us.
    document.addEventListener("input", function (e) {
      if (!isPro || !engine || !inEditor(e.target)) { return; }
      var t = currentLineText();
      if (t) { engine.noteEdit(t); }
    }, true);

    // A trusted paste carries the complete payload, whatever CM6 has rendered.
    document.addEventListener("paste", function (e) {
      if (!isPro || !engine || !inEditor(e.target)) { return; }
      var text = null;
      try { text = e.clipboardData.getData("text/plain"); } catch (err) { text = null; }
      if (text) { engine.notePaste(text); }
    }, true);
  }

  // ---- the status strip (Pro) ----------------------------------------------
  var stripEl = null, stripText = null, stripList = null, stripFoot = null;
  var stripCaret = null, stripOpen = false, stripDismissed = false;

  function setStripOpen(open) {
    stripOpen = !!open;
    stripCaret.textContent = stripOpen ? "\u25be" : "\u25b8"; // down / right
    stripList.style.display = stripOpen ? "block" : "none";
    stripFoot.style.display = (stripOpen && autoWatch) ? "block" : "none";
  }

  function ensureStrip() {
    if (stripEl) { return; }
    stripEl = document.createElement("div");
    stripEl.id = "cs-status-strip";
    var s = stripEl.style;
    s.position = "fixed";
    s.zIndex = "2147483500";
    s.bottom = "56px";
    s.left = "18px";
    s.width = "360px";           // matches the panel; the old 320 wrapped the header
    s.background = "#211d15";
    s.color = "#ece2cf";
    s.border = "1px solid #3a3326";
    s.borderRadius = "10px";
    s.padding = "8px 12px";
    s.font = "12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    s.boxShadow = "0 8px 28px rgba(0,0,0,0.45)";
    s.display = "none";

    // A header that looks like what it is: a disclosure control.
    var head = document.createElement("div");
    head.style.display = "flex";
    head.style.alignItems = "baseline";
    head.style.gap = "8px";
    head.style.cursor = "pointer";

    stripCaret = document.createElement("span");
    stripCaret.textContent = "\u25b8";
    stripCaret.style.color = DIM;
    stripCaret.style.flex = "0 0 auto";
    head.appendChild(stripCaret);

    stripText = document.createElement("div");
    stripText.style.flex = "1 1 auto";
    head.appendChild(stripText);

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "\u00d7";
    dismiss.title = "Hide (returns when something new needs attention)";
    dismiss.setAttribute("aria-label", "Hide the CiteStamp status strip");
    dismiss.style.background = "transparent";
    dismiss.style.border = "none";
    dismiss.style.color = DIM;
    dismiss.style.cursor = "pointer";
    dismiss.style.font = "14px/1 ui-monospace, monospace";
    dismiss.style.padding = "0 2px";
    dismiss.style.flex = "0 0 auto";
    dismiss.addEventListener("click", function (e) {
      e.stopPropagation();
      stripDismissed = true;
      stripEl.style.display = "none";
    });
    head.appendChild(dismiss);

    head.addEventListener("click", function () { setStripOpen(!stripOpen); });
    stripEl.appendChild(head);

    // The findings scroll. The explanation does not — it used to live inside the
    // scroller and got cut off mid-sentence under the fold.
    stripList = document.createElement("div");
    stripList.style.display = "none";
    stripList.style.marginTop = "6px";
    stripList.style.maxHeight = "170px";
    stripList.style.overflowY = "auto";
    stripEl.appendChild(stripList);

    stripFoot = document.createElement("div");
    stripFoot.style.display = "none";
    stripFoot.style.marginTop = "8px";
    stripFoot.style.paddingTop = "6px";
    stripFoot.style.borderTop = "1px solid #2c271d";
    stripFoot.style.fontSize = "11px";
    stripFoot.style.color = DIM;
    stripFoot.textContent = "References you cite by DOI join your watchlist and are " +
      "re-checked daily; a later retraction reaches the toolbar icon. A title-only " +
      "match is checked, never watched. Manage the list in the CiteStamp popup.";
    stripEl.appendChild(stripFoot);

    document.body.appendChild(stripEl);
  }

  function renderStrip(sum) {
    if (!isPro || !engine) { if (stripEl) { stripEl.style.display = "none"; } return; }
    sum = sum || engine.summary();
    ensureStrip();
    stripEl.style.display = stripDismissed ? "none" : "block";

    while (stripList.firstChild) { stripList.removeChild(stripList.firstChild); }
    setStripOpen(stripOpen);

    if (sum.paused === "budget") {
      stripText.textContent = "CiteStamp: today's lookup allowance is used up. Checking resumes after 00:00 UTC.";
      stripText.style.color = SEAL;
      return;
    }
    if (sum.paused === "lookup") {
      stripText.textContent = "CiteStamp: a lookup source is not answering. Retrying shortly.";
      stripText.style.color = SEAL;
      return;
    }

    if (sum.notice && sum.notice.kind === "bulk-paste") {
      stripText.textContent = "CiteStamp: learned " + sum.notice.learned + " entries. " +
        "That is a whole bibliography — use \u201ccheck bibliography\u201d to check them all at once.";
      stripText.style.color = SEAL;
      return;
    }

    if (watchCapped) {
      stripText.textContent = "CiteStamp: your watchlist is full (200 papers). " +
        "Clear some in the CiteStamp popup to keep enrolling what you cite.";
      stripText.style.color = SEAL;
      return;
    }

    // No brand prefix here: the "CiteStamp: check bibliography" pill sits directly
    // below, and the prefix pushed this line onto a second row at 360px.
    var n = sum.problems.length;
    stripText.style.color = n ? SEAL : GREEN;
    var line = sum.checked + " checked · " +
      (n ? n + " need" + (n === 1 ? "s" : "") + " attention" : "nothing to flag");
    if (autoWatch && watchTotal) {
      line += " · " + watchTotal + " watched";
    }
    stripText.textContent = line;

    for (var i = 0; i < n; i++) {
      var p = sum.problems[i];
      var row = document.createElement("div");
      row.style.padding = "5px 0";
      row.style.borderTop = "1px solid #2c271d";
      var lab = document.createElement("div");
      lab.textContent = shortLabel(p);
      lab.style.color = "#ece2cf";
      row.appendChild(lab);
      var msg = document.createElement("div");
      msg.textContent = problemText(p);
      msg.style.fontSize = "11px";
      msg.style.color = (p.status === "does-not-resolve" || p.status === "marked-retracted") ? RED : DIM;
      row.appendChild(msg);
      stripList.appendChild(row);
    }

  }

  // ---- "Check bibliography" panel — FREE, and it always will be ------------
  // Overleaf virtualizes CM6 lines and keeps the .bib in a separate file, so
  // per-line inline flags are not reliable from a content script. Instead: paste
  // the .bib, run citation-health in the browser, list what needs attention.
  var panelEl = null;
  var proNoteEl = null;

  function updateProNote() {
    if (!proNoteEl) { return; }
    proNoteEl.style.display = isPro ? "none" : "block";
  }

  function styleBtn(b) {
    var s = b.style;
    s.background = "transparent";
    s.border = "1px solid " + SEAL;
    s.color = SEAL;
    s.borderRadius = "99px";
    s.padding = "4px 12px";
    s.font = "12px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    s.cursor = "pointer";
  }

  function toggleCheckBtn(show) {
    var b = document.getElementById("cs-check-btn");
    if (b) { b.style.display = show ? "block" : "none"; }
  }

  function openPanel() {
    // The panel occupies the button's exact corner, so the button is
    // unclickable underneath it. Take it away while the panel is up.
    toggleCheckBtn(false);
    if (panelEl) { panelEl.style.display = "block"; return; }
    panelEl = document.createElement("div");
    var s = panelEl.style;
    s.position = "fixed";
    s.zIndex = "2147483600";
    s.bottom = "18px";
    s.left = "18px";
    s.width = "360px";
    s.maxHeight = "70vh";
    s.overflowY = "auto";
    s.background = "#211d15";
    s.color = "#ece2cf";
    s.border = "1px solid #3a3326";
    s.borderRadius = "10px";
    s.padding = "12px 14px";
    s.font = "13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    s.boxShadow = "0 8px 28px rgba(0,0,0,0.45)";

    var title = document.createElement("div");
    title.textContent = "CiteStamp — check bibliography";
    title.style.color = SEAL;
    title.style.marginBottom = "8px";
    panelEl.appendChild(title);

    // This used to read "It is checked in this browser; nothing is uploaded."
    // That was false. checkBibliography() runs with no opts, so noGraph is unset,
    // and checkOne calls graphFor() for every reference that resolves — sending
    // each DOI to api.citestamp.com to fetch its refutation edges. The same
    // sentence was corrected on the Word pane and the Docs sidebar in Task 2 and
    // was missed here. Refutations are worth the call when the user is present
    // and asked for it; the automatic checker passes noGraph:true and does not
    // make it. Either way, the copy has to say which one is happening.
    var hint = document.createElement("div");
    hint.textContent = "Paste your .bib here. It is parsed and checked in this browser — " +
      "your draft never touches CiteStamp servers. References that resolve are then " +
      "looked up in the public citation graph.";
    hint.style.color = DIM;
    hint.style.fontSize = "11px";
    hint.style.marginBottom = "8px";
    panelEl.appendChild(hint);

    // One honest line about what Pro adds — shown only to a free user, hidden
    // when Pro. Not a modal or a nag; the check itself is fully free, and it
    // finds everything the automatic one finds. Pro buys automation, not sight.
    proNoteEl = document.createElement("div");
    proNoteEl.style.color = DIM;
    proNoteEl.style.fontSize = "11px";
    proNoteEl.style.margin = "0 0 8px";
    proNoteEl.appendChild(document.createTextNode(
      "Pro ($35/yr) runs this check as you write, adds the @cite picker, and puts " +
      "every reference you cite by DOI on your watchlist — so a later retraction " +
      "reaches the CiteStamp toolbar icon."));
    var pn2 = document.createElement("div");
    pn2.style.marginTop = "4px";
    pn2.appendChild(document.createTextNode(
      "This panel is free and finds the same things. So is the watchlist. Pro fills " +
      "it in for you. "));
    var pricing = document.createElement("a");
    pricing.href = "https://citestamp.com/pricing";
    pricing.target = "_blank";
    pricing.rel = "noopener";
    pricing.textContent = "pricing";
    pricing.style.color = SEAL;
    pn2.appendChild(pricing);
    proNoteEl.appendChild(pn2);
    proNoteEl.style.borderTop = "1px solid #2c271d";
    proNoteEl.style.paddingTop = "8px";
    panelEl.appendChild(proNoteEl);
    updateProNote();

    var ta = document.createElement("textarea");
    ta.style.width = "100%";
    ta.style.minHeight = "120px";
    ta.style.background = "#16140f";
    ta.style.color = "#ece2cf";
    ta.style.border = "1px solid #3a3326";
    ta.style.borderRadius = "8px";
    ta.style.padding = "8px";
    ta.style.font = "12px/1.4 ui-monospace, monospace";
    ta.style.resize = "vertical";
    panelEl.appendChild(ta);

    var bar = document.createElement("div");
    bar.style.display = "flex";
    bar.style.gap = "8px";
    bar.style.margin = "8px 0";
    var run = document.createElement("button");
    run.type = "button";
    run.textContent = "run check";
    styleBtn(run);
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "close";
    styleBtn(close);
    close.style.borderColor = "#3a3326";
    close.style.color = DIM;
    close.addEventListener("click", function () {
      panelEl.style.display = "none";
      toggleCheckBtn(true);
    });
    bar.appendChild(run);
    bar.appendChild(close);
    panelEl.appendChild(bar);

    var out = document.createElement("div");
    out.style.fontSize = "12px";
    panelEl.appendChild(out);

    run.addEventListener("click", function () {
      var text = ta.value;
      if (!text || text.replace(/^\s+/, "") === "") { out.textContent = "paste a .bib above"; return; }
      run.disabled = true;
      out.textContent = "checking in your browser...";
      // Remember the cite keys, so a Pro user's \cite{key} resolves to a real
      // reference later. Local only; nothing is sent anywhere.
      if (engine) { try { engine.noteBib(text); } catch (e) {} }
      window.CiteStampCheck.checkBibliography(text).then(function (report) {
        run.disabled = false;
        renderReport(out, report);
      }).catch(function () {
        run.disabled = false;
        out.textContent = "check failed to run";
      });
    });

    document.body.appendChild(panelEl);
  }

  function renderReport(out, report) {
    while (out.firstChild) { out.removeChild(out.firstChild); }
    var c = report.counts;
    var head = document.createElement("div");
    head.textContent = report.total + " refs · " + c.resolved + " resolve · " +
      c.uncertain + " uncertain · " + c.unresolved + " do not · " +
      (c.noMatch || 0) + " not verified · " +
      (c.unchecked || 0) + " couldn't check · " +
      c.withRefutations + " with refutations · " + c.retracted + " retracted";
    head.style.color = DIM;
    head.style.marginBottom = "8px";
    out.appendChild(head);

    var problems = report.verdicts.filter(function (v) { return v && v.status !== "ok"; });
    if (problems.length === 0) {
      var ok = document.createElement("div");
      ok.textContent = "every reference resolves, with no recorded refutations or retraction notices.";
      ok.style.color = GREEN;
      out.appendChild(ok);
      return;
    }
    for (var i = 0; i < problems.length; i++) {
      var v = problems[i];
      var row = document.createElement("div");
      row.style.padding = "6px 0";
      row.style.borderTop = "1px solid #2c271d";
      var label = document.createElement("div");
      label.textContent = (v.ref.key ? "[" + v.ref.key + "] " : "") +
        ((v.work && v.work.title) || v.ref.title || v.ref.doi || "(reference)");
      label.style.color = "#ece2cf";
      row.appendChild(label);
      var msg = document.createElement("div");
      msg.textContent = problemText(v);
      msg.style.fontSize = "11px";
      msg.style.color = v.status === "does-not-resolve" || v.status === "marked-retracted" ? RED : SEAL;
      row.appendChild(msg);
      // C here is CiteStampContinuous, NOT the check engine — the wording lives
      // on window.CiteStampCheck, which this content script also loads.
      var CC = window.CiteStampCheck;
      var prov = (CC && CC.provenanceLine) ? CC.provenanceLine(v.publisherEvent) : "";
      if (prov) {
        var pv = document.createElement("div");
        pv.textContent = prov;
        pv.style.fontSize = "11px";
        pv.style.color = DIM;
        row.appendChild(pv);
      }
      if (v.suggestion && v.suggestion.title) {
        var sug = document.createElement("div");
        sug.textContent = "closest match: " + v.suggestion.title +
          (v.suggestion.year ? " (" + v.suggestion.year + ")" : "") +
          (v.suggestion.doi ? " — doi.org/" + v.suggestion.doi : "");
        sug.style.fontSize = "11px";
        sug.style.color = DIM;
        row.appendChild(sug);
      }
      out.appendChild(row);
    }
  }

  function problemText(v) {
    if (v.status === "does-not-resolve") { return "does not resolve to a known work"; }
    if (v.status === "unchecked") { return "couldn't check — lookup source unavailable, try again"; }
    if (v.status === "no-match") { return "no confident match in the title search — not verified"; }
    if (v.status === "doi-title-mismatch") { return "this DOI resolves, but to a different work than the cited title — check which one you meant"; }
    if (v.status === "marked-retracted") { return "marked retracted by the publisher (best-effort)"; }
    if (v.status === "has-refutations") {
      return v.refutations + (v.refutations === 1 ? " recorded refutation" : " recorded refutations");
    }
    if (v.status === "needs-attention") { return "weak match — confirm this is the work you meant"; }
    if (C && v.status === C.KEY_MISSING) {
      return "no entry for this key in the bibliography CiteStamp has seen for this project — open the check panel and paste your .bib once";
    }
    return v.status;
  }

  function mountButton() {
    if (document.getElementById("cs-check-btn")) { return; }
    var b = document.createElement("button");
    b.id = "cs-check-btn";
    b.type = "button";
    b.textContent = "CiteStamp: check bibliography";
    styleBtn(b);
    b.style.position = "fixed";
    b.style.zIndex = "2147483500";
    b.style.bottom = "18px";
    b.style.left = "18px";
    b.style.background = "#211d15";
    b.style.boxShadow = "0 4px 16px rgba(0,0,0,0.4)";
    b.addEventListener("click", openPanel);
    document.body.appendChild(b);
  }

  // ---- boot ----------------------------------------------------------------
  var pending = null;
  function schedule() {
    if (pending) { return; }
    pending = setTimeout(function () { pending = null; scan(); }, 300);
  }

  mountButton();
  wireContinuous();

  engine = makeEngine();

  // Saving or clearing the key in the popup re-resolves here, so an already-open
  // Overleaf tab unlocks (or locks) without a reload.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes) { return; }
      if (changes[TOKEN_KEY]) { refreshPlan(); }
      if (changes[AUTO_KEY]) {
        loadAutoWatch().then(function () { watchCapped = false; renderStrip(); });
      }
      // The worker wrote the list, or the popup removed something. Re-count.
      if (changes[WATCHLIST_KEY]) { refreshWatchCount(); }
    });
  } catch (e) {}

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true
  });

  var boot = engine ? engine.ready() : Promise.resolve();
  boot.then(loadAutoWatch).then(refreshWatchCount).then(refreshPlan, function () { applyPlan(false); });
})();
