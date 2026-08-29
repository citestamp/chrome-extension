/* CiteStamp picker v1.2.0 — citation search at the cursor.
   Docs + live demo: https://citestamp.com/write
   Search is client-direct to OpenAlex; staged claims stay in this browser. */
(function () {
"use strict";
if (window.CiteStampPicker) { return; }

var VERSION = "1.2.0";
var NL = String.fromCharCode(10);
var OPENALEX = "https://api.openalex.org";
var CROSSREF = "https://api.crossref.org";
var SITE = "https://citestamp.com";
var MAILTO = "info@citestamp.com";
var STORE_PREFIX = "cs_staged:";
var PREDICATES = ["cites", "supports", "extends", "refutes"];

var INK = "#16140f";
var SURFACE = "#211d15";
var LINE = "#3a3326";
var VELLUM = "#ece2cf";
var VELLUM_DIM = "#a89c83";
var SEAL = "#d6a23f";

// ---- works + formatting ---------------------------------------------------

function authorships(work) { return work.authorships || []; }

function firstAuthorFamily(work) {
  var a = authorships(work);
  if (a.length === 0 || !a[0].author || !a[0].author.display_name) { return "Unknown"; }
  var parts = a[0].author.display_name.split(" ");
  return parts[parts.length - 1];
}

function authorLabel(work) {
  var fam = firstAuthorFamily(work);
  return authorships(work).length > 1 ? fam + " et al." : fam;
}

function allAuthors(work) {
  var names = [];
  var a = authorships(work);
  for (var i = 0; i < a.length && i < 20; i++) {
    if (a[i].author && a[i].author.display_name) { names.push(a[i].author.display_name); }
  }
  return names.length ? names.join(" and ") : "Unknown";
}

function doiOf(work) {
  if (!work.doi) { return null; }
  return work.doi.replace("https://doi.org/", "");
}

function urlOf(work) {
  var doi = doiOf(work);
  return doi ? "https://doi.org/" + doi : (work.id || "");
}

function titleOf(work) { return work.title || work.display_name || "(untitled)"; }

function yearOf(work) { return work.publication_year ? String(work.publication_year) : "n.d."; }

function bibKey(work) {
  var fam = firstAuthorFamily(work).toLowerCase();
  var clean = "";
  for (var i = 0; i < fam.length; i++) {
    var ch = fam.charAt(i);
    if (ch >= "a" && ch <= "z") { clean += ch; }
  }
  return (clean || "work") + (work.publication_year || "nd");
}

// suffix (optional) disambiguates two works by the same author in the same year
// in author-date styles: "a"/"b"/"c". It rides on the year ("1898b") and the
// bib key ("curie1898b") so the in-text mark, the reference, and the LaTeX
// key all agree. The hosts (Word/Docs) decide WHEN to assign letters; the core
// just renders the one it is handed.
// Neutralize a value before it goes inside a BibTeX {...} field. Remote
// titles/authors carry braces and TeX specials; an unbalanced "}" closes the
// field early and a bare "%" comments out the rest, producing un-parseable
// .bib — and .bib export is the paid Write product's primary output. Strip
// braces (they regroup rather than print), escape the specials. Backslash is
// built via fromCharCode per the file-level no-backslash rule.
function bibtexField(s) {
  var bs = String.fromCharCode(92);
  var str = String(s == null ? "" : s);
  var out = "";
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (ch === "{" || ch === "}") { continue; }
    else if (ch === "%" || ch === "&" || ch === "_" || ch === "#" || ch === "$") { out += bs + ch; }
    else if (ch === "~" || ch === "^") { out += bs + ch + "{}"; }
    else if (ch === bs) { out += bs + "textbackslash{}"; }
    else { out += ch; }
  }
  return out;
}

// The url field has the same .bib-corruption surface (a "}" ends the entry, a
// "%" comments out the rest) — remote DOIs/ids can carry both. Escape the
// parse-breakers but leave URL-structural chars (~ : / . - _) intact so the
// link stays usable.
//
// "_" is deliberately NOT escaped. It is legal and common in DOIs
// (10.1007/978-3-319-24574-4_28), an escaped underscore is not a valid URL
// character, and the url/doi packages handle a raw "_" themselves. Escaping it
// broke the export/re-import round trip: parseBib read the DOI back with the
// escape still attached.
function bibtexUrl(s) {
  var bs = String.fromCharCode(92);
  var str = String(s == null ? "" : s);
  var out = "";
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (ch === "{" || ch === "}") { continue; }
    else if (ch === "%" || ch === "&" || ch === "#" || ch === "$") { out += bs + ch; }
    else { out += ch; }
  }
  return out;
}

function formatCitation(work, format, suffix) {
  suffix = suffix || "";
  var url = urlOf(work);
  var year = yearOf(work) + suffix;
  var key = bibKey(work) + suffix;
  if (format === "text") {
    return authorLabel(work) + " (" + year + "). " + titleOf(work) + ". " + url;
  }
  if (format === "bibtex") {
    return "@misc{" + key + "," + NL +
      "  title = {" + bibtexField(titleOf(work)) + "}," + NL +
      "  author = {" + bibtexField(allAuthors(work)) + "}," + NL +
      "  year = {" + yearOf(work) + "}," + NL +
      "  url = {" + bibtexUrl(url) + "}" + NL +
      "}";
  }
  if (format === "latex") {
    // backslash kept out of this template literal per the file-level rule
    return String.fromCharCode(92) + "cite{" + key + "}";
  }
  if (format === "intext") {
    // author-date in-text citation, e.g. (Curie et al., 1898) — used by the
    // Word/Docs hosts, where the full reference goes in a References list.
    return "(" + authorLabel(work) + ", " + year + ")";
  }
  return "[" + authorLabel(work) + ", " + year + "](" + url + ")";
}

// ---- search (client-direct to OpenAlex) -----------------------------------
// Exposed as CiteStampPicker.search so hosts that drive their own input box
// and insert through a host API (Word task pane, Google Docs add-on) reuse the
// one OpenAlex query + work shape instead of forking it. attach() calls this
// too, layering its own seq/open-state guards on top.

// Map a Crossref work-list item into the OpenAlex-shaped work the formatter and
// the picker UI expect (authorships[].author.display_name, title, year, doi).
// Crossref keeps the date in any of several fields; take the first that has one.
function crossrefYear(it) {
  var fields = ["issued", "published", "published-print", "published-online"];
  for (var k = 0; k < fields.length; k++) {
    var f = it[fields[k]];
    if (f && f["date-parts"] && f["date-parts"][0] && f["date-parts"][0][0]) {
      return f["date-parts"][0][0];
    }
  }
  return null;
}

function mapCrossref(items) {
  var complete = [];
  var partial = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var doi = it.DOI ? ("https://doi.org/" + it.DOI) : null;
    var authors = [];
    var src = it.author || [];
    for (var j = 0; j < src.length; j++) {
      var nm = "";
      if (src[j].given) { nm += src[j].given + " "; }
      if (src[j].family) { nm += src[j].family; }
      nm = nm.replace(/^[ ]+/, "").replace(/[ ]+$/, "");
      if (nm) { authors.push({ author: { display_name: nm } }); }
    }
    var year = crossrefYear(it);
    var title = (it.title && it.title[0]) ? it.title[0] : null;
    var work = {
      id: doi || ("crossref:" + i),
      doi: doi,
      title: title,
      display_name: title,
      publication_year: year,
      authorships: authors
    };
    // A citation you cannot attribute is useless, so float records that have
    // both an author and a year above bare stubs, keeping relevance order
    // within each group.
    if (authors.length > 0 && year) { complete.push(work); } else { partial.push(work); }
  }
  return complete.concat(partial);
}

// Free, unmetered fallback when OpenAlex is budget-limited (it went per-IP paid
// in 2026-06, and the free daily allotment can be $0). Crossref is CORS-open and
// runs the same client-direct way — the query goes from the user browser, never
// a CiteStamp server.
function searchCrossref(query, mailto, perPage) {
  var url = CROSSREF + "/works?query=" + encodeURIComponent(query) +
    "&rows=" + perPage + "&select=DOI,title,author,issued,published,published-print,published-online&mailto=" + encodeURIComponent(mailto);
  return fetch(url).then(function (r) {
    if (!r.ok) { return []; }
    return r.json().then(function (data) {
      return data && data.message && data.message.items ? mapCrossref(data.message.items) : [];
    });
  }).catch(function () { return []; });
}

function searchWorks(query, opts) {
  opts = opts || {};
  var mailto = opts.mailto || MAILTO;
  var perPage = opts.perPage || 8;
  var url = OPENALEX + "/works?search=" + encodeURIComponent(query) +
    "&per_page=" + perPage + "&select=id,doi,title,display_name,publication_year,authorships" +
    "&mailto=" + encodeURIComponent(mailto);
  return fetch(url).then(function (r) {
    if (!r.ok) { return null; }
    return r.json();
  }).then(function (data) {
    // OpenAlex returns an error body (no results) when out of budget; on any
    // miss or empty hit, fall through to Crossref so search keeps working.
    if (data && data.results && data.results.length) { return data.results; }
    return searchCrossref(query, mailto, perPage);
  }).catch(function () {
    return searchCrossref(query, mailto, perPage);
  });
}

// ---- staged claims (local-only, keyed per manuscript name) ----------------

function storeKey(manuscript) { return STORE_PREFIX + manuscript; }

function staged(manuscript) {
  try {
    var raw = localStorage.getItem(storeKey(manuscript));
    var list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function saveStaged(manuscript, list) {
  try { localStorage.setItem(storeKey(manuscript), JSON.stringify(list)); } catch (e) {}
}

function stageClaim(manuscript, predicate, work) {
  var list = staged(manuscript);
  var object = urlOf(work);
  for (var i = 0; i < list.length; i++) {
    if (list[i].predicate === predicate && list[i].object === object) { return list; }
  }
  list.push({
    predicate: predicate,
    object: object,
    title: titleOf(work),
    year: work.publication_year || null,
    staged_at: new Date().toISOString()
  });
  saveStaged(manuscript, list);
  return list;
}

function clearStaged(manuscript) {
  try { localStorage.removeItem(storeKey(manuscript)); } catch (e) {}
}

function exportStaged(manuscript) {
  return {
    format: "citestamp-staged-claims/v1",
    manuscript: manuscript,
    subject: "pending:" + manuscript,
    exported_at: new Date().toISOString(),
    note: "These claims have no subject DOI yet. When the manuscript is published, replace the pending subject with its DOI and sign each claim at " + SITE + "/ under your ORCID iD. Until then they exist only in the browser that staged them.",
    claims: staged(manuscript)
  };
}

// ---- panel UI --------------------------------------------------------------

function styleBox(node) {
  var s = node.style;
  s.position = "absolute";
  s.zIndex = "2147483000";
  s.background = SURFACE;
  s.color = VELLUM;
  s.border = "1px solid " + LINE;
  s.borderRadius = "10px";
  s.boxShadow = "0 8px 28px rgba(0,0,0,0.45)";
  s.font = "13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  s.padding = "6px";
  s.maxHeight = "320px";
  s.overflowY = "auto";
  s.boxSizing = "border-box";
}

function brandLine(panel) {
  var b = document.createElement("div");
  b.textContent = "CiteStamp picker";
  var s = b.style;
  s.fontSize = "10px";
  s.color = VELLUM_DIM;
  s.textAlign = "right";
  s.padding = "4px 6px 2px";
  panel.appendChild(b);
}

function placePanel(panel, r) {
  panel.style.left = Math.round(r.left + window.scrollX) + "px";
  panel.style.top = Math.round(r.bottom + window.scrollY + 4) + "px";
  panel.style.width = Math.round(Math.max(300, Math.min(620, r.width))) + "px";
}

// ---- editor adapters -------------------------------------------------------
// attach() never touches the editor directly; it goes through an adapter so
// the same search/panel/staging core drives a plain textarea (the default,
// used by the /write page and the Chrome popup), a CodeMirror 6 contenteditable
// (Overleaf), or any future surface. Contract:
//   node           DOM element to bind input/keydown/blur on and dispatch on
//   capture        true if keydown must be captured ahead of the editor
//   before()       text from the start of the editable context to the caret
//   replace(from)  replace [from, caret] with a string, leaving caret after it
//   rect()         a client rect to anchor the panel under
//   focus()        return focus to the editor

function textareaAdapter(el) {
  return {
    node: el,
    capture: false,
    before: function () { return el.value.slice(0, el.selectionStart); },
    replace: function (from, str) {
      var pos = el.selectionStart;
      var head = el.value.slice(0, from);
      var tail = el.value.slice(pos);
      el.value = head + str + tail;
      var at = (head + str).length;
      el.selectionStart = at;
      el.selectionEnd = at;
    },
    rect: function () { return el.getBoundingClientRect(); },
    focus: function () { el.focus(); }
  };
}

// ---- attach ----------------------------------------------------------------

function attach(el, opts) {
  opts = opts || {};
  var manuscript = opts.manuscript || "untitled";
  var format = opts.format || "markdown";
  var trigger = opts.trigger || "@cite ";
  var mailto = opts.mailto || MAILTO;

  var adapter = opts.adapter || textareaAdapter(el);
  var node = adapter.node;
  var capture = !!adapter.capture;

  var panel = null;
  var isOpen = false;
  var results = [];
  var active = 0;
  var rowEls = [];
  var titleEls = [];
  var timer = null;
  var seq = 0;
  var triggerStart = -1;
  var hideTimer = null;
  var inserting = false;

  function ensurePanel() {
    if (!panel) {
      panel = document.createElement("div");
      panel.setAttribute("data-citestamp-picker", "1");
      styleBox(panel);
      panel.addEventListener("mousedown", function (e) { e.preventDefault(); });
      document.body.appendChild(panel);
    }
    placePanel(panel, adapter.rect());
    panel.style.display = "block";
    isOpen = true;
  }

  function close() {
    isOpen = false;
    results = [];
    if (timer) { clearTimeout(timer); timer = null; }
    if (panel) { panel.style.display = "none"; }
  }

  function clearPanel() {
    if (!panel) { return; }
    while (panel.firstChild) { panel.removeChild(panel.firstChild); }
  }

  function showHint(text) {
    ensurePanel();
    clearPanel();
    var d = document.createElement("div");
    d.textContent = text;
    d.style.padding = "8px 10px";
    d.style.color = VELLUM_DIM;
    panel.appendChild(d);
    brandLine(panel);
  }

  function fire(name, detail) {
    try { node.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true })); } catch (e) {}
  }

  // Highlight moves by restyling rows in place — never rebuilding them.
  // A rebuild mid-hover detaches the row the pointer is about to click.
  function setActive(idx) {
    if (rowEls[active]) {
      rowEls[active].style.background = "transparent";
      titleEls[active].style.color = VELLUM;
    }
    active = idx;
    if (rowEls[active]) {
      rowEls[active].style.background = INK;
      titleEls[active].style.color = SEAL;
    }
  }

  function renderResults() {
    ensurePanel();
    clearPanel();
    rowEls = [];
    titleEls = [];
    if (results.length === 0) {
      showHint("no works matched — try different words");
      return;
    }
    for (var i = 0; i < results.length; i++) {
      (function (idx) {
        var work = results[idx];
        var row = document.createElement("div");
        row.style.padding = "7px 10px";
        row.style.borderRadius = "7px";
        row.style.cursor = "pointer";
        var t = document.createElement("div");
        t.textContent = titleOf(work);
        t.style.color = VELLUM;
        t.style.overflow = "hidden";
        t.style.textOverflow = "ellipsis";
        t.style.whiteSpace = "nowrap";
        row.appendChild(t);
        var m = document.createElement("div");
        var doi = doiOf(work);
        m.textContent = authorLabel(work) + " · " + yearOf(work) + " · " + (doi ? doi : "no DOI");
        m.style.color = VELLUM_DIM;
        m.style.fontSize = "11px";
        row.appendChild(m);
        row.addEventListener("click", function () { pick(idx); });
        row.addEventListener("mousemove", function () {
          if (active !== idx) { setActive(idx); }
        });
        panel.appendChild(row);
        rowEls.push(row);
        titleEls.push(t);
      })(i);
    }
    setActive(active < results.length ? active : 0);
    brandLine(panel);
  }

  function search(q) {
    var mine = ++seq;
    searchWorks(q, { mailto: mailto }).then(function (works) {
      if (mine !== seq || !isOpen) { return; }
      results = works;
      active = 0;
      renderResults();
    }).catch(function () {
      if (mine !== seq || !isOpen) { return; }
      showHint("search unavailable — check your connection");
    });
  }

  function onInput() {
    if (inserting) { return; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    var text = adapter.before();
    var idx = text.lastIndexOf(trigger);
    if (idx < 0) { close(); return; }
    var q = text.slice(idx + trigger.length);
    if (q.indexOf(NL) >= 0 || q.length > 120) { close(); return; }
    triggerStart = idx;
    if (q.length < 2) { showHint("keep typing to search open scholarly metadata"); return; }
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(function () { search(q); }, 250);
  }

  function move(delta) {
    if (results.length === 0) { return; }
    setActive((active + delta + results.length) % results.length);
  }

  function pick(idx) {
    var work = results[idx];
    if (!work) { return; }
    var citation = formatCitation(work, format);
    inserting = true;
    adapter.replace(triggerStart, citation);
    inserting = false;
    adapter.focus();
    fire("citestamp:insert", { work: work, citation: citation, manuscript: manuscript });
    showStageBar(work);
  }

  function showStageBar(work) {
    results = [];
    ensurePanel();
    clearPanel();
    var label = document.createElement("div");
    label.textContent = "Stage a claim — what does this source do for your draft?";
    label.style.padding = "6px 8px 8px";
    label.style.color = VELLUM_DIM;
    panel.appendChild(label);
    var bar = document.createElement("div");
    bar.style.display = "flex";
    bar.style.flexWrap = "wrap";
    bar.style.gap = "6px";
    bar.style.padding = "0 8px 8px";
    for (var i = 0; i < PREDICATES.length; i++) {
      (function (pred) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = pred;
        var s = btn.style;
        s.background = "transparent";
        s.border = "1px solid " + LINE;
        s.color = SEAL;
        s.borderRadius = "99px";
        s.padding = "3px 12px";
        s.cursor = "pointer";
        s.font = "inherit";
        btn.addEventListener("click", function () {
          var list = stageClaim(manuscript, pred, work);
          fire("citestamp:stage", { manuscript: manuscript, predicate: pred, work: work, staged: list });
          confirmStage(list.length);
        });
        bar.appendChild(btn);
      })(PREDICATES[i]);
    }
    var skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = "skip";
    var ss = skip.style;
    ss.background = "transparent";
    ss.border = "1px solid " + LINE;
    ss.color = VELLUM_DIM;
    ss.borderRadius = "99px";
    ss.padding = "3px 12px";
    ss.cursor = "pointer";
    ss.font = "inherit";
    skip.addEventListener("click", close);
    bar.appendChild(skip);
    panel.appendChild(bar);
    var doi = doiOf(work);
    if (doi) {
      var link = document.createElement("a");
      link.href = SITE + "/paper/" + doi;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "view this work on CiteStamp";
      link.style.display = "block";
      link.style.padding = "0 8px 8px";
      link.style.color = VELLUM_DIM;
      panel.appendChild(link);
    }
    brandLine(panel);
  }

  function confirmStage(count) {
    ensurePanel();
    clearPanel();
    var d = document.createElement("div");
    d.textContent = "staged — " + count + " claim" + (count === 1 ? "" : "s") + " held in this browser for this manuscript";
    d.style.padding = "8px 10px";
    d.style.color = SEAL;
    panel.appendChild(d);
    brandLine(panel);
    hideTimer = setTimeout(close, 2200);
  }

  function onKey(e) {
    if (!isOpen) { return; }
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); move(-1); }
    else if (e.key === "Enter") {
      if (results.length > 0) { e.preventDefault(); e.stopPropagation(); pick(active); }
    }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  }

  function onBlur() {
    hideTimer = setTimeout(close, 180);
  }

  node.addEventListener("input", onInput);
  node.addEventListener("keydown", onKey, capture);
  node.addEventListener("blur", onBlur);

  return function detach() {
    node.removeEventListener("input", onInput);
    node.removeEventListener("keydown", onKey, capture);
    node.removeEventListener("blur", onBlur);
    if (panel && panel.parentNode) { panel.parentNode.removeChild(panel); }
    panel = null;
  };
}

window.CiteStampPicker = {
  version: VERSION,
  attach: attach,
  search: searchWorks,
  formatCitation: formatCitation,
  staged: staged,
  stage: stageClaim,
  clearStaged: clearStaged,
  exportStaged: exportStaged
};
})();
