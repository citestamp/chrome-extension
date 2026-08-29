// CiteStamp — DOI detection. Runs entirely locally: the page is read in
// this browser, and the only thing that ever leaves it is the detected
// identifier, sent to the extension's own service worker.
// Privacy: https://citestamp.com/privacy
//
// Dual-use by design: this file is both a declared content script on
// scholarly hosts and an on-demand injection from the popup ("Scan this
// page" via chrome.scripting.executeScript). The completion value of the
// file is the detected DOI or null, so executeScript callers get the
// answer directly; the self-guard keeps double injection harmless.

if (!window.__csDetect) {
  window.__csDetect = function () {
    var DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>]+/;

    function clean(raw) {
      if (!raw) return null;
      var s = String(raw).trim();
      s = s.replace(/^doi:\s*/i, "");
      s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
      try { s = decodeURIComponent(s); } catch (e) {}
      var m = DOI_RE.exec(s);
      if (!m) return null;
      // trailing punctuation rides along in prose and href fragments
      return m[0].replace(/[).,;:'"]+$/, "");
    }

    // 1. publisher meta tags — the reliable path on journal pages
    var metaNames = [
      "citation_doi",
      "dc.identifier",
      "prism.doi",
      "bepress_citation_doi",
    ];
    for (var i = 0; i < metaNames.length; i++) {
      var el = document.querySelector('meta[name="' + metaNames[i] + '" i]');
      if (el) {
        var d1 = clean(el.getAttribute("content"));
        if (d1) return d1;
      }
    }

    // 2. the URL itself: doi.org resolvers, arXiv ids, Zenodo records
    var href = location.href;
    if (/^https?:\/\/(dx\.)?doi\.org\//i.test(href)) {
      var d2 = clean(href);
      if (d2) return d2;
    }
    var ax = /arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/i.exec(href);
    if (ax) return "10.48550/arXiv." + ax[2];
    var zen = /zenodo\.org\/records?\/(\d+)/i.exec(href);
    if (zen) return "10.5281/zenodo." + zen[1];
    var d3 = clean(href);
    if (d3) return d3;

    // 3. anchors pointing at doi.org (abstract pages, reference headers)
    var links = document.querySelectorAll('a[href*="doi.org/"]');
    for (var j = 0; j < links.length && j < 50; j++) {
      var d4 = clean(links[j].getAttribute("href"));
      if (d4) return d4;
    }

    // 4. last resort: a "doi:" mention near the top of the visible text
    var text = ((document.body && document.body.innerText) || "").slice(0, 20000);
    var prose = /\bdoi:?\s*(10\.\d{4,9}\/[^\s"'<>]+)/i.exec(text);
    if (prose) return clean(prose[1]);

    return null;
  };
}

(function () {
  var doi = window.__csDetect();
  try {
    chrome.runtime.sendMessage({ type: "cs-doi", doi: doi });
  } catch (e) {}
  return doi;
})();
