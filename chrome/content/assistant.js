// CiteStamp's reference check for a page: an AI assistant's answer (claude.ai,
// Gemini) or any other web page (1.0.13).
//
// ON DEMAND ONLY. This file is not a declared content script: the popup
// injects it, after vendor/check-v1.js, with chrome.scripting.executeScript
// when the user clicks "Check references on this page". That click is what
// grants access to the tab (activeTab), so the extension asks for no new
// permission and no new host. Nothing runs on a page until the user asks.
//
// What it does, in order:
//   1. Reads the page in this browser and finds the lines that ARE references.
//      On an AI chat: a DOI, an arXiv id, or a title the engine can isolate
//      (CiteStampCheck.referenceFromText), plus doi.org / arxiv.org / PubMed
//      links (referenceFromLink). A PubMed ID with no DOI counts (engine 1.7.0). A line with none of those is not a reference and
//      is never sent to a search. A quoted title counts when it has three or
//      more content words, or two beside a cited year.
//      On any other page only a reference with an identifier counts: a DOI or
//      an arXiv id in the text, a doi.org or arxiv.org link, or a link to a
//      journal page whose address holds the DOI (journalLinkDoi). A quoted
//      sentence in a news story is not a title to search for, so nothing
//      without an identifier leaves the page there.
//   2. Checks each one with the vendored engine in REGISTRY MODE: Crossref,
//      DataCite and doi.org, never OpenAlex. That first, user-asked check also
//      looks a resolving DOI up in CiteStamp's public graph, for recorded
//      refutations and replication outcomes: the DOI alone, never the text.
//   3. On an AI chat only, keeps watching the tab. When a new answer
//      finishes, the references in
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

  // An AI chat, where answers keep arriving and cite in prose: the hosts
  // popup.js lists in ASSISTANT_HOSTS. Every other page is read when asked,
  // for references that carry an identifier, and is not watched.
  var CHAT = location.hostname === "claude.ai" || location.hostname === "gemini.google.com";

  var SITE = "https://citestamp.com";
  var MAILTO = "info@citestamp.com";
  var MAX_REFS = 40;          // one user-asked check; "Check the next" takes the rest
  var AUTO_MAX = 100;         // automatic checks per tab session (chat)
  var QUIET_MS = 2500;        // the page must be this still before a scan
  var MIN_GAP_MS = 4000;      // and scans are at least this far apart
  var CONCURRENCY = 2;       // Crossref allows 3 at once; the engine gates its searches
  var MAX_BLOCKS = CHAT ? 3000 : 10000; // elements read per scan (a chat rescans often)
  var MAX_BLOCK_TEXT = 6000;
  var MAX_LINE = 600;         // referenceFromText reads lines up to this long

  var GREEN = "#7fa86b";
  var SEAL = "#d6a23f";
  var RED = "#c4604b";
  var DIM = "#a89c83";

  // ---- finding references ----------------------------------------------------

  var BLOCKS = "li, p, td, dd, blockquote";
  // Editable text is never read, on any page. Off a chat, sidebars too: a
  // "related articles" box is not the page's references.
  var SKIP = "[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], textarea, input, pre, code, nav, header, footer, form, [role='textbox'], [role='navigation']" +
    (CHAT ? "" : ", aside, [role='complementary']");

  // ---- journal links (any page but a chat) ------------------------------------
  // Writers mostly link the journal's own page, not doi.org. These rules read a
  // DOI only from an address shape that carries it whole; anything else on a
  // paper host is counted on screen as not read (paperHostOf). A DOI read this
  // way that doi.org says no agency registered is shown as "couldn't check",
  // never "not found": the address may hold more than the DOI.

  var DOI_TAILS = { full: 1, abstract: 1, abs: 1, pdf: 1, epdf: 1, epub: 1, pdfdirect: 1, pdfplus: 1,
    reader: 1, figures: 1, tables: 1, references: 1, citedby: 1, suppl: 1, suppinfo: 1, "full-text": 1, html: 1 };

  function hostOf(u) {
    return u.hostname.toLowerCase().replace(/^www\./, "");
  }

  // "10.<4-9 digits>/<suffix>" at the start of s, or null; the suffix stops at
  // the first DOI_TAILS segment, and trailing punctuation is dropped.
  function doiAt(s) {
    var m = /^10\.\d{4,9}\/[^?#\s]+/.exec(s);
    if (!m) { return null; }
    var parts = m[0].split("/");
    var keep = [parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (i > 1 && DOI_TAILS[parts[i].toLowerCase()]) { break; }
      if (parts[i] === "") { break; }
      keep.push(parts[i]);
    }
    if (keep.length < 2) { return null; }
    return keep.join("/").replace(/[).,;:'"]+$/, "");
  }

  function journalLinkDoi(href) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") { return null; }
    var h = hostOf(u);
    var p = u.pathname;
    try { p = decodeURIComponent(p); } catch (e) {}
    var m;
    // Atypon and alike: /doi/10.x/y, /doi/full/10.x/y, /doi/pdf/10.x/y ...
    // (science.org, pnas.org, Wiley, Taylor & Francis, SAGE, ACS, ACM, NEJM)
    m = /\/doi\/(?:[a-z]+\/)?(10\.\d{4,9}\/.+)$/i.exec(p);
    if (m) { return doiAt(m[1]); }
    // bioRxiv, medRxiv: /content/10.1101/2020.04.14.20062463v2.full -> no version
    if (h === "biorxiv.org" || h === "medrxiv.org") {
      m = /^\/content\/(10\.\d{4,9}\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{6,8})(?:v\d+)?(?:[./]|$)/.exec(p);
      return m ? m[1] : null;
    }
    // Springer: /article/10.1007/..., /chapter/..., /content/pdf/10.1007/x.pdf
    if (h === "link.springer.com" || h === "rd.springer.com") {
      m = /^\/(?:article|chapter|book|referenceworkentry|protocol|content\/pdf)\/(10\.\d{4,9}\/.+?)(?:\.pdf)?$/.exec(p);
      return m ? doiAt(m[1]) : null;
    }
    // Frontiers: /articles/10.3389/fpsyg.2020.01234/full
    if (h === "frontiersin.org" || /\.frontiersin\.org$/.test(h)) {
      m = /\/articles\/(10\.\d{4,9}\/.+)$/.exec(p);
      return m ? doiAt(m[1]) : null;
    }
    // Nature: /articles/<suffix> is the suffix of 10.1038/<suffix> (10.1057
    // for the Palgrave journals nature.com also hosts)
    if (h === "nature.com") {
      m = /^\/articles\/([a-z][a-z0-9.-]*\d[a-z0-9.-]*?)(?:\.pdf)?\/?$/i.exec(p);
      return m ? (/^(s41599|palcomms)/i.test(m[1]) ? "10.1057/" : "10.1038/") + m[1] : null;
    }
    // PLOS and the AEA name the DOI in the query: article?id=10.1371/...
    if (h === "journals.plos.org" || h === "aeaweb.org") {
      var id = u.searchParams.get("id");
      return id ? doiAt(id) : null;
    }
    if (h === "elifesciences.org") {
      m = /^\/articles\/(\d{4,6})\/?$/.exec(p);
      return m ? "10.7554/eLife." + m[1] : null;
    }
    if (h === "papers.ssrn.com") {
      var ab = u.searchParams.get("abstract_id");
      return (ab && /^\d+$/.test(ab)) ? "10.2139/ssrn." + ab : null;
    }
    if (h === "zenodo.org") {
      m = /^\/records?\/(\d+)\/?$/.exec(p);
      return m ? "10.5281/zenodo." + m[1] : null;
    }
    return null;
  }

  // Article pages on hosts whose addresses carry no DOI (a PII, a PubMed or
  // article number): not read, and said so on screen.
  var PAPER_PAGES = [
    ["cell.com", /\/(fulltext|retrieve\/pii|abstract)\//],
    ["thelancet.com", /\/article\//],
    ["sciencedirect.com", /^\/science\/article\//],
    ["jamanetwork.com", /\/fullarticle\//],
    ["pubmed.ncbi.nlm.nih.gov", /^\/\d+\/?$/],
    ["pmc.ncbi.nlm.nih.gov", /^\/articles\/PMC\d+/],
    ["ncbi.nlm.nih.gov", /^\/(pubmed\/\d+|pmc\/articles\/PMC\d+)/],
    ["academic.oup.com", /\/article\//],
    ["bmj.com", /^\/content\/\d+/],
    ["ieeexplore.ieee.org", /^\/(abstract\/)?document\/\d+/],
    ["mdpi.com", /^\/\d{4}-\d{3}[\dX]\/\d+\/\d+\/\d+/],
    ["journals.lww.com", /\/(fulltext|abstract)\//],
    ["cambridge.org", /^\/core\/journals\/.+\/article\//],
    ["researchgate.net", /^\/publication\/\d+/],
    ["semanticscholar.org", /^\/paper\//],
    ["osf.io", /^\/(preprints\/[a-z]+\/)?[a-z0-9]{5}\/?$/],
    ["arxiv.org", /^\/(abs|pdf|html)\//]
  ];

  function paperHostOf(href) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { return null; }
    var h = hostOf(u);
    for (var i = 0; i < PAPER_PAGES.length; i++) {
      var ph = PAPER_PAGES[i][0];
      if ((h === ph || h.slice(-ph.length - 1) === "." + ph) && PAPER_PAGES[i][1].test(u.pathname)) { return ph; }
    }
    return null;
  }

  // An entry of the page's own reference list (Wikipedia, a publisher), so an
  // entry with no identifier anywhere on the page can be counted on screen,
  // and a PubMed link beside an entry's DOI is not counted as a link not read.
  var REF_LISTS = "[role='doc-bibliography'], [role='doc-endnotes'], [class*='references' i], [id*='references' i], " +
    "[class*='bibliography' i], [id*='bibliography' i], .reflist";
  function refEntryOf(el) {
    var li = el.tagName === "LI" ? el : el.closest("li");
    return (li && li.closest(REF_LISTS)) ? li : null;
  }

  // The page's own paper (a publisher's citation_doi tag, an arXiv abstract):
  // not one of its references.
  function ownDoi() {
    var names = ["citation_doi", "dc.identifier", "prism.doi", "bepress_citation_doi"];
    for (var i = 0; i < names.length; i++) {
      var meta = document.querySelector('meta[name="' + names[i] + '" i]');
      var d = meta && doiAt(String(meta.getAttribute("content") || "").replace(/^(doi:\s*|https?:\/\/(dx\.)?doi\.org\/)/i, ""));
      if (d) { return d.toLowerCase(); }
    }
    var ax = /arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})/i.exec(location.href);
    return ax ? ("10.48550/arxiv." + ax[2]).toLowerCase() : null;
  }

  function normT(t) {
    return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function keyOf(ref) {
    if (ref.doi) { return "doi:" + ref.doi.toLowerCase(); }
    if (ref.pmid) { return "pmid:" + ref.pmid; }
    return "t:" + normT(ref.title);
  }

  function visible(el) {
    return el.getClientRects().length > 0;
  }

  // Off a chat, a line too long for referenceFromText (a paragraph of prose)
  // is read for identifiers only, a sentence at a time: a quote in the same
  // sentence is not taken for the cited title.
  function identifiersIn(line) {
    var out = [];
    var parts = line.split(". ");
    for (var i = 0; i < parts.length; i++) {
      var r = parts[i].length <= MAX_LINE ? C.referenceFromText(parts[i]) : null;
      if (r && r.doi) { r.title = null; r.year = null; out.push(r); }
    }
    return out;
  }

  // What a scan left out, for the panel to say (off a chat).
  var skipped = { own: null, paperHosts: {}, paperLinks: 0, blocksCut: 0, bareEntries: 0 };

  // A link off a chat: doi.org / arxiv.org (the engine), else a journal page
  // whose address holds the DOI. Returns the reference, or the paper host it
  // could not read (a string), or null.
  // A link's words count as the cited title only in a reference-list entry:
  // in prose they are the writer's phrase ("a new study", the journal's name),
  // and a DOI-title cross-check on them reads as a mismatch.
  function readLink(a, inEntry) {
    var lr = C.referenceFromLink(a.href, a.innerText || "");
    // off a chat a PubMed link stays a page this does not read (engine 1.7.0
    // reads its PubMed ID; in a reference-list entry it is the same work as the DOI)
    if (lr && !lr.doi) { lr = null; }
    if (!lr) {
      var jd = journalLinkDoi(a.href);
      if (!jd) { return paperHostOf(a.href); }
      lr = C.referenceFromLink("https://doi.org/" + jd, a.innerText || "");
      if (lr) { lr.via = "link"; lr.href = a.href; }
    }
    if (lr) {
      lr.fromLink = true;
      if (!inEntry) { lr.title = null; }
    }
    return lr;
  }

  function countUnread(a, host, unread) {
    if (unread[a.href]) { return; }
    unread[a.href] = 1;
    skipped.paperLinks++;
    skipped.paperHosts[host] = 1;
  }

  // Off a chat, the page and any same-site frame it shows: an editor's preview
  // (Substack draws its draft preview in one) is a rendered page, not
  // editable text. Frames from other sites (ads, embeds) cannot be read and
  // are not tried.
  function roots() {
    if (CHAT) { return [document.querySelector("main") || document.body]; }
    var out = [document.body];
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (!visible(f) || f.closest("[contenteditable='true'], [contenteditable=''], textarea")) { continue; }
      var d = null;
      try { d = f.contentDocument; } catch (e) { d = null; }
      if (d && d.body) { out.push(d.body); }
    }
    return out;
  }

  // Every reference on the page, in document order, deduplicated.
  function findReferences() {
    var rootList = roots();
    var own = CHAT ? null : ownDoi();
    var out = [];
    var byKey = {};
    var unread = {};
    skipped = { own: null, paperHosts: {}, paperLinks: 0, blocksCut: 0, bareEntries: 0 };
    var entries = [];        // reference-list entries seen, and whether any held an identifier
    var entryHad = [];
    function add(ref, el) {
      var k = keyOf(ref);
      if (k === "t:" || k === "doi:") { return; }
      if (own && ref.doi && ref.doi.toLowerCase() === own) { skipped.own = own; return; }
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
    var budget = MAX_BLOCKS;
    for (var ri = 0; ri < rootList.length; ri++) {
      var root = rootList[ri];
      var blocks = root.querySelectorAll(BLOCKS);
      var n = Math.min(blocks.length, budget);
      budget -= n;
      skipped.blocksCut += blocks.length - n;
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
          // off a chat, a title read from the text stands only beside a cited
          // year, "(2015)": a quote in a news story has none
          if (r && !CHAT && !r.year) { r.title = null; }
          // a PubMed ID with no DOI is an identifier on a chat (engine 1.7.0); off a
          // chat only a DOI or an arXiv id counts, as before
          if (r && (r.doi || r.title || (CHAT && r.pmid))) { fromText.push(r); }
          else if (!r && !CHAT && lines[j].length > MAX_LINE) { fromText = fromText.concat(identifiersIn(lines[j])); }
        }
        var links = el.querySelectorAll("a[href]");
        var fromLinks = [];
        var notRead = [];
        var entry = CHAT ? null : refEntryOf(el);
        for (var m = 0; m < links.length; m++) {
          var lr;
          if (CHAT) {
            lr = C.referenceFromLink(links[m].getAttribute("href"), links[m].innerText || "");
          } else {
            lr = readLink(links[m], !!entry);
            if (typeof lr === "string") { notRead.push([links[m], lr]); lr = null; }
          }
          if (lr) { fromLinks.push(lr); }
        }
        // "Vaswani et al. (2017). Attention is all you need." with the arXiv
        // link on the title: one reference, the link supplying its identifier
        // (off a chat, only in a reference-list entry: in prose the sentence is
        // not that work's title)
        if (fromText.length === 1 && !fromText[0].doi && fromLinks.length === 1 && (CHAT || entry)) {
          fromText[0].doi = fromLinks[0].doi;
          if (!fromText[0].doi && fromLinks[0].pmid && !fromText[0].pmid) { fromText[0].pmid = fromLinks[0].pmid; }
          fromText[0].via = fromLinks[0].via;
          fromText[0].href = fromLinks[0].href;
          fromLinks = [];
        }
        // a reference whose text carries its DOI, with a PubMed link beside it, is one
        // work: the link adds no second row, and PubMed is never asked (engine 1.7.0)
        if (fromText.length === 1 && fromText[0].doi) {
          var keepLinks = [];
          for (var kl = 0; kl < fromLinks.length; kl++) { if (fromLinks[kl].doi) { keepLinks.push(fromLinks[kl]); } }
          fromLinks = keepLinks;
        }
        var hasId = fromLinks.length > 0;
        for (var a = 0; a < fromText.length; a++) {
          // off a chat, a line without an identifier is not a reference
          if (CHAT || fromText[a].doi) { add(fromText[a], el); }
          if (fromText[a].doi) { hasId = true; }
        }
        for (var b = 0; b < fromLinks.length; b++) { add(fromLinks[b], el); }
        if (CHAT) { continue; }
        if (entry) {
          var at = entries.indexOf(entry);
          if (at < 0) { entries.push(entry); entryHad.push(hasId); } else if (hasId) { entryHad[at] = true; }
        }
        // in a reference-list entry with a DOI, a PubMed link is the same work
        if (!(entry && hasId)) {
          for (var q = 0; q < notRead.length; q++) { countUnread(notRead[q][0], notRead[q][1], unread); }
        }
      }
      if (!CHAT) {
        // links outside any paragraph or list item (a podcast's show notes)
        var loose = root.querySelectorAll("a[href]");
        for (var z = 0; z < loose.length && z < MAX_BLOCKS; z++) {
          var la = loose[z];
          if (la.closest(BLOCKS) || la.closest(SKIP) || !visible(la)) { continue; }
          var lz = readLink(la, false);
          if (typeof lz === "string") { countUnread(la, lz, unread); }
          else if (lz) { add(lz, la); }
        }
      }
    }
    for (var e = 0; e < entryHad.length; e++) { if (!entryHad[e]) { skipped.bareEntries++; } }
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
  closeBtn.title = CHAT ? "Close and stop watching this tab" : "Close";
  top.appendChild(minBtn);
  top.appendChild(closeBtn);
  box.appendChild(top);

  var body = el("div", "body");
  body.appendChild(el("div", "fine",
    "Checked from your browser against Crossref, DataCite and doi.org. Only each " +
    "reference's DOI or title leaves this page (and, when a title matches a work from " +
    "another year, the rest of that line, so Crossref can search the cited year). " +
    "When you ask for the check, a DOI " +
    "that resolves is also looked up in CiteStamp's public graph, for recorded " +
    "refutations."));
  var sum = el("div", "sum");
  body.appendChild(sum);
  var notes = el("div");       // what the scan left out, said out loud
  body.appendChild(notes);
  var list = el("div");
  body.appendChild(list);
  var restLine = el("div", "fine");
  restLine.style.display = "none";
  body.appendChild(restLine);
  var watchLine = el("div", "fine");
  body.appendChild(watchLine);
  var bar = el("div", "bar");
  var nextBtn = el("button", "btn", "Check the next " + MAX_REFS);
  nextBtn.type = "button";
  nextBtn.style.display = "none";
  var againBtn = el("button", "btn", "Check again");
  againBtn.type = "button";
  var watchBtn = el("button", "btn quiet", "Stop watching");
  watchBtn.type = "button";
  bar.appendChild(nextBtn);
  bar.appendChild(againBtn);
  bar.appendChild(watchBtn);
  body.appendChild(bar);
  if (!CHAT) {
    watchLine.style.display = "none";
    watchBtn.style.display = "none";
  }
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
      // a cited PubMed ID that PubMed holds no record under (or holds another
      // paper under), with no title match: confirm, as check_reference says it
      if (v.pubmedNowhere) { return "confirm"; }
      return (v.status === "does-not-resolve") ? "notfound" : "cant";
    }
    return (v.weakMatch || v.titleMismatch) ? "confirm" : "found";
  }

  // A DOI read out of a journal page's address that doi.org says no agency
  // registered: the address may hold more than the DOI, so it is a check that
  // could not be made, never "not found".
  function kindOf(item) {
    var k = verdictOf(item.verdict);
    return (k === "notfound" && item.ref.via === "link") ? "cant" : k;
  }

  var CHIP = { found: "found", confirm: "confirm", notfound: "not found", cant: "couldn't check", wait: "checking" };

  var VIA = {
    "crossref-doi": "Crossref", "datacite-doi": "DataCite", "crossref-title": "Crossref",
    "datacite-title": "DataCite", "doi-registration": "doi.org", "pubmed": "PubMed"
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
    var kind = item.pending ? "wait" : kindOf(item);
    var head = el("div", "cited");
    head.appendChild(el("span", "chip " + kind, CHIP[kind]));
    var cited = item.ref.raw || item.ref.title || item.ref.doi || "";
    if (cited.length > 220) { cited = cited.slice(0, 217) + "..."; }
    // off a chat, a row read from a link shows the link's words as a link's
    if (!CHAT && item.ref.fromLink) { cited = "\u201c" + cited + "\u201d (link)"; }
    head.appendChild(document.createTextNode(cited));
    row.appendChild(head);
    if (!item.pending) {
      if (item.ref.via === "link" && verdictOf(v) === "notfound") {
        row.appendChild(el("div", "why", "doi.org has no record of the DOI read from this link's address (" +
          item.ref.doi + "); the address may hold more than the DOI. Open the link to confirm."));
      } else {
        row.appendChild(el("div", "why", reasonOf(v, kind)));
      }
      if (item.ref.via === "link" && item.ref.href) {
        var from = el("div", "why", "DOI read from the link to ");
        from.appendChild(link(item.ref.href, hostOf(new URL(item.ref.href))));
        row.appendChild(from);
      }
      var w = v && v.work;
      if (w && w.doi && kind !== "notfound") {
        var wl = el("div", "work");
        if (w.title) { wl.appendChild(document.createTextNode(w.title + (w.year ? " (" + w.year + ") " : " "))); }
        wl.appendChild(link("https://doi.org/" + w.doi, "doi.org/" + w.doi));
        row.appendChild(wl);
      } else if (w && w.pmid && kind !== "notfound") {
        var pl = el("div", "work");
        if (w.title) { pl.appendChild(document.createTextNode(w.title + (w.year ? " (" + w.year + ") " : " "))); }
        pl.appendChild(link("https://pubmed.ncbi.nlm.nih.gov/" + w.pmid + "/", "pubmed.ncbi.nlm.nih.gov/" + w.pmid));
        row.appendChild(pl);
      }
      if (v && v.retracted === "marked") {
        row.appendChild(el("div", "flag", C.markedLabel ? C.markedLabel(v) : "marked retracted (best-effort)"));
      } else if (v && v.publisherEvent && v.publisherEvent.type === "expression_of_concern") {
        row.appendChild(el("div", "flag", C.markingLabel ? C.markingLabel("expression_of_concern", v.publisherEvent.source) : "flagged with an expression of concern (best-effort)"));
      }
      var prov = (v && C.provenanceLine) ? C.provenanceLine(v.publisherEvent) : "";
      if (!prov && v && C.markingOrigin) { prov = C.markingOrigin(v); }
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
      c[kindOf(items[i])]++;
    }
    renderNotes();
    renderRest();
    if (pdf) {
      sum.textContent = "This tab shows a PDF. The check reads references on web pages and can't read inside Chrome's PDF viewer.";
      return;
    }
    if (!items.length) {
      sum.textContent = !scanned ? "Reading the page..." : CHAT
        ? "No references found on this page yet: a reference here is a line with a DOI, an arXiv id, or an author-year-title citation."
        : "No references with a DOI or an arXiv id on this page. Here a reference needs one: printed on the page, " +
          "or in a link to doi.org, arxiv.org or a journal page whose address holds the DOI. Text in forms and editors isn't read." +
          (editorShown() ? " If you're writing in an editor, open its preview and check again." : "");
      return;
    }
    var total = items.length + rest.length;
    sum.textContent = (rest.length
      ? items.length + " of " + total + " references checked"
      : items.length + " reference" + (items.length === 1 ? "" : "s")) + " · " +
      c.found + " found · " + c.confirm + " confirm · " + c.notfound + " not found · " +
      c.cant + " couldn't check" + (waiting ? " · checking " + waiting : "") +
      (lastChecked ? " · " + lastChecked : "");
  }

  // A rich-text editor on screen (a draft being written), not a comment box.
  function editorShown() {
    var eds = document.querySelectorAll("[contenteditable='true']");
    for (var i = 0; i < eds.length; i++) {
      if (visible(eds[i]) && eds[i].getBoundingClientRect().height > 150) { return true; }
    }
    return false;
  }

  // Everything a scan saw and did not check is said on screen.
  function renderNotes() {
    while (notes.firstChild) { notes.removeChild(notes.firstChild); }
    if (skipped.own) {
      notes.appendChild(el("div", "fine", "Left out: this page's own paper (" + skipped.own +
        "). Its citation record is in the CiteStamp popup."));
    }
    if (skipped.bareEntries) {
      notes.appendChild(el("div", "fine", "Not checked: " + skipped.bareEntries + " entr" +
        (skipped.bareEntries === 1 ? "y" : "ies") + " in this page's reference list " +
        (skipped.bareEntries === 1 ? "has" : "have") + " no DOI or arXiv id on the page."));
    }
    if (skipped.paperLinks) {
      notes.appendChild(el("div", "fine", "Not read: " + skipped.paperLinks + " link" +
        (skipped.paperLinks === 1 ? "" : "s") + " to paper pages whose address holds no DOI (" +
        Object.keys(skipped.paperHosts).join(", ") + "). A DOI printed on the page, or a doi.org link, is read."));
    }
    if (skipped.blocksCut > 0) {
      notes.appendChild(el("div", "fine", "This page is long: only its first " + MAX_BLOCKS.toLocaleString("en-US") +
        " text blocks were read, and " + skipped.blocksCut.toLocaleString("en-US") + " were not."));
    }
  }

  function renderRest() {
    // on a chat the watcher may have checked some of them since
    var left = [];
    for (var i = 0; i < rest.length; i++) { if (!checkedKeys[rest[i].key]) { left.push(rest[i]); } }
    rest = left;
    if (rest.length) {
      var next = Math.min(MAX_REFS, rest.length);
      restLine.textContent = rest.length + " more reference" + (rest.length === 1 ? " on this page isn't" : "s on this page aren't") +
        " checked yet. \"Check the next " + next + "\" checks " + (next === rest.length ? "them" : "the next " + next) + ".";
      restLine.style.display = "";
      nextBtn.textContent = "Check the next " + next;
      nextBtn.style.display = "";
    } else {
      restLine.style.display = "none";
      nextBtn.style.display = "none";
    }
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
  var rest = [];           // found on the page, not checked yet (over MAX_REFS)
  var checkedKeys = {};    // key -> item, this page or conversation
  var seenOnce = {};       // auto path: key -> line text from the previous scan
  var scanned = false;
  var pdf = !CHAT && document.contentType === "application/pdf";
  var watching = CHAT;
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
    rest = [];
    while (list.firstChild) { list.removeChild(list.firstChild); }
  }

  // The user asked: every reference on the page, with the graph lookup. An
  // answer still being written is waited for (up to a minute), so a half-
  // written line is not looked up.
  var waitedFor = 0;
  function checkAll() {
    box.className = "box";
    if (CHAT && streaming() && waitedFor < 60) {
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
    rest = [];
    while (list.firstChild) { list.removeChild(list.firstChild); }
    if (pdf) { scanned = true; renderSummary(); return; }
    var found = findReferences();
    scanned = true;
    for (var i = 0; i < found.length && i < MAX_REFS; i++) { enqueue(found[i], false); }
    rest = found.slice(MAX_REFS);
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
  // The rest of a long page, MAX_REFS at a time, each a click of the user's.
  nextBtn.addEventListener("click", function () {
    var take = [];
    while (rest.length && take.length < MAX_REFS) {
      var f = rest.shift();
      if (!checkedKeys[f.key]) { take.push(f); }
    }
    for (var i = 0; i < take.length; i++) { enqueue(take[i], false); }
    renderSummary();
    pump();
  });
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
      watching = CHAT;
      if (CHAT) { observe(); }
      checkAll();
    }
  };

  if (CHAT) { observe(); }
  checkAll();
  return "started";
})();
